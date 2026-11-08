// Keyboard, mouse (pointer lock) and touch controls.
// Produces a camera-relative movement vector and discrete actions.
//
// Camera modes:
//   pitch  - looks straight down the pitch, leaning a little toward the ball
//            (default). It faces the goal you attack, and turns round to face
//            the other way only when the ball gets well behind you, so you can
//            always see it; "up" means toward whichever goal the camera faces
//   follow - the camera swings round behind the direction you run
//   ball   - the camera keeps the ball in view
//   manual - only the mouse / right thumb / arrow keys turn the camera
//
// While a direction is held, movement stays relative to the camera angle at
// the moment you pressed it, so the follow camera can swing round behind you
// without changing where you're running.

export const CAM_MODES = ['pitch', 'follow', 'ball', 'manual'];
export const CAM_LABELS = { pitch: 'Pitch view', follow: 'Follow player', ball: 'Ball cam', manual: 'Manual' };
const wrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0.3;
    this.camMode = 'pitch';
    this.attackYaw = Math.PI / 2; // direction of the goal we attack (set by the game)
    this.pitchFacing = 1; // 1 = facing the goal we attack, -1 = turned round toward our own
    this.refYaw = 0; // camera angle movement is measured against
    this.held = false;
    this.heldAng = 0;
    this.lastManual = 0;
    this.sensitivity = 0.0026;
    this.chargeStart = 0;
    this.charging = false;
    this.onAction = () => {};
    this.onToggle = () => {}; // (name)
    this.touch = { active: false, jx: 0, jz: 0, sprint: false };
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    try { if (CAM_MODES.includes(localStorage.getItem('rfs-cam2'))) this.camMode = localStorage.getItem('rfs-cam2'); } catch (e) { /* ignore */ }

    window.addEventListener('keydown', (e) => this.keydown(e));
    window.addEventListener('keyup', (e) => this.keyup(e));
    window.addEventListener('blur', () => { this.keys.clear(); this.charging = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement !== canvas && !this.isTouch) {
        canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.beginCharge();
      if (e.button === 2) this.onAction('pass', 0.5);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0 && this.charging) this.releaseCharge();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== canvas) return;
      this.rotate(-e.movementX * this.sensitivity);
      this.pitch = Math.max(0.05, Math.min(1.1, this.pitch + e.movementY * this.sensitivity * 0.7));
    });

    if (this.isTouch) this.setupTouch();
  }

  get locked() { return document.pointerLockElement === this.canvas; }

  keydown(e) {
    if (!this.enabled) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const k = e.code;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(k);
    switch (k) {
      case 'Space': this.beginCharge(); break;
      case 'KeyE': this.onAction('pass', 0.5); break;
      case 'KeyQ': this.onAction('chip', 0.7); break;
      case 'KeyF': this.onAction('flick', 0.5); break;
      case 'KeyC': case 'ControlLeft': this.onAction('tackle', 0); break;
      case 'KeyR': this.onAction('call', 0); break;
      case 'KeyP': this.onToggle('pause'); break;
      case 'KeyV': this.cycleCam(); break;
      case 'KeyH': this.onToggle('help'); break;
      case 'KeyM': this.onToggle('mute'); break;
      case 'Tab': this.onToggle('scores', true); break;
    }
  }

  keyup(e) {
    this.keys.delete(e.code);
    if (e.code === 'Space' && this.charging) this.releaseCharge();
    if (e.code === 'Tab') this.onToggle('scores', false);
  }

  cycleCam() {
    this.camMode = CAM_MODES[(CAM_MODES.indexOf(this.camMode) + 1) % CAM_MODES.length];
    try { localStorage.setItem('rfs-cam2', this.camMode); } catch (e) { /* ignore */ }
    this.onToggle('cam', this.camMode);
  }

  // Manual camera turn: also turns the movement reference so steering with
  // the mouse / thumb works while running.
  rotate(d) {
    this.yaw += d;
    this.refYaw += d;
    this.lastManual = performance.now();
  }

  // Snap the camera (and movement reference) to an angle, e.g. at kickoff.
  setYaw(y) {
    this.pitchFacing = 1;
    this.yaw = y;
    this.refYaw = y;
    this.held = false;
  }

  beginCharge() {
    if (this.charging) return;
    this.charging = true;
    this.chargeStart = performance.now();
  }

  chargeLevel() {
    if (!this.charging) return 0;
    return Math.min(1, (performance.now() - this.chargeStart) / 900);
  }

  releaseCharge() {
    const p = this.chargeLevel();
    this.charging = false;
    this.onAction('shoot', Math.max(0.15, p));
  }

  // Raw stick / WASD: f = forward, s = right.
  localMove() {
    let f = 0, s = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW')) f += 1;
      if (this.keys.has('KeyS')) f -= 1;
      if (this.keys.has('KeyD')) s += 1;
      if (this.keys.has('KeyA')) s -= 1;
      if (this.touch.active) { f += this.touch.jz; s += this.touch.jx; }
    }
    return { f, s };
  }

  // Called every frame; turns the camera.
  update(dt, me, ball) {
    if (!this.enabled) { this.held = false; this.refYaw = this.yaw; return; }
    const turn = (this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0);
    if (turn) this.rotate(turn * 2.4 * dt);
    if (this.keys.has('ArrowUp')) this.pitch = Math.max(0.05, this.pitch - dt);
    if (this.keys.has('ArrowDown')) this.pitch = Math.min(1.1, this.pitch + dt);

    // Movement reference: lock while a direction is held.
    const { f, s } = this.localMove();
    if (this.camMode === 'manual') {
      this.refYaw = this.yaw;
      this.held = Math.hypot(f, s) > 0.2;
    } else if (Math.hypot(f, s) > 0.2) {
      const ang = Math.atan2(s, f);
      if (!this.held) { this.held = true; this.refYaw = this.yaw; this.heldAng = ang; }
      else if (Math.abs(wrap(ang - this.heldAng)) > 1.9) { this.refYaw = this.yaw; this.heldAng = ang; } // new direction
    } else {
      this.held = false;
      this.refYaw = this.yaw;
    }

    const manualRecently = performance.now() - this.lastManual < (this.camMode === 'pitch' ? 2500 : 1200) || this.touch.dragging;
    if (!me || manualRecently || this.noAutoCam) return;
    if (this.camMode === 'pitch') {
      // Two steady directions along the pitch, plus a small lean toward the ball.
      let base = this.attackYaw;
      if (ball) {
        const ax = Math.sin(this.attackYaw), az = Math.cos(this.attackYaw);
        const along = (ball.x - me.x) * ax + (ball.z - me.z) * az; // + = ball ahead toward their goal
        // Hysteresis so the view doesn't flip back and forth.
        if (this.pitchFacing === 1 && along < -5) this.pitchFacing = -1;
        else if (this.pitchFacing === -1 && along > 2) this.pitchFacing = 1;
        if (this.pitchFacing === -1) base = this.attackYaw + Math.PI;
      }
      let target = base;
      if (ball) {
        const dx = ball.x - me.x, dz = ball.z - me.z;
        if (Math.hypot(dx, dz) > 3) target += Math.max(-0.4, Math.min(0.4, wrap(Math.atan2(dx, dz) - base) * 0.3));
      }
      const diff = wrap(target - this.yaw);
      this.yaw += diff * Math.min(1, dt * (Math.abs(diff) > 1 ? 4 : 2.5)); // turn round quickly
    } else if (this.camMode === 'follow') {
      // Swing round behind the way the player is running.
      const sp = Math.hypot(me.vx, me.vz);
      if (sp > 1.5) {
        const target = Math.atan2(me.vx, me.vz);
        const rate = 3.2 * Math.min(1, sp / 7);
        this.yaw += wrap(target - this.yaw) * Math.min(1, dt * rate);
      }
    } else if (this.camMode === 'ball' && ball) {
      const dx = ball.x - me.x, dz = ball.z - me.z;
      if (Math.hypot(dx, dz) > 2.5) {
        this.yaw += wrap(Math.atan2(dx, dz) - this.yaw) * Math.min(1, dt * 3);
      }
    }
  }

  // World-space movement vector from WASD / stick relative to the camera.
  movement() {
    const { f, s } = this.localMove();
    const ry = this.held || this.camMode === 'manual' ? this.refYaw : this.yaw;
    const fx = Math.sin(ry), fz = Math.cos(ry);
    const rx = -Math.cos(ry), rz = Math.sin(ry);
    let mx = fx * f + rx * s;
    let mz = fz * f + rz * s;
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    const sprint = this.enabled && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touch.sprint);
    return { mx, mz, sprint, aim: this.yaw };
  }

  // ---------- Touch ----------
  setupTouch() {
    const root = document.getElementById('touch');
    root.hidden = false;
    const stick = document.getElementById('stick');
    const knob = document.getElementById('knob');
    let stickId = null, sx = 0, sy = 0;
    let lookId = null, lx = 0, ly = 0;
    const R = 55;

    const zone = document.getElementById('stickZone');
    zone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      stickId = t.identifier; sx = t.clientX; sy = t.clientY;
      stick.style.left = sx + 'px'; stick.style.top = sy + 'px';
      stick.classList.add('on');
      this.touch.active = true;
      e.preventDefault();
    }, { passive: false });
    const lookZone = document.getElementById('lookZone');
    lookZone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      lookId = t.identifier; lx = t.clientX; ly = t.clientY;
      this.touch.dragging = true;
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          let dx = t.clientX - sx, dy = t.clientY - sy;
          const l = Math.hypot(dx, dy);
          if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
          knob.style.transform = `translate(${dx}px, ${dy}px)`;
          this.touch.jx = dx / R; this.touch.jz = -dy / R;
        } else if (t.identifier === lookId) {
          this.rotate(-(t.clientX - lx) * 0.006);
          this.pitch = Math.max(0.05, Math.min(1.1, this.pitch + (t.clientY - ly) * 0.004));
          lx = t.clientX; ly = t.clientY;
        }
      }
    }, { passive: true });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          stickId = null;
          this.touch.active = false; this.touch.jx = 0; this.touch.jz = 0;
          knob.style.transform = '';
          stick.classList.remove('on');
        } else if (t.identifier === lookId) {
          lookId = null; this.touch.dragging = false;
        }
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);

    const btn = (id, down, up) => {
      const el = document.getElementById(id);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); down(); }, { passive: false });
      el.addEventListener('touchend', (e) => { e.preventDefault(); el.classList.remove('down'); up && up(); }, { passive: false });
    };
    btn('tShoot', () => this.beginCharge(), () => this.charging && this.releaseCharge());
    btn('tPass', () => this.onAction('pass', 0.5));
    btn('tChip', () => this.onAction('chip', 0.7));
    btn('tFlick', () => this.onAction('flick', 0.5));
    btn('tTackle', () => this.onAction('tackle', 0));
    btn('tCall', () => this.onAction('call', 0));
    btn('tMenu', () => this.onToggle('menu'));
    btn('tSprint', () => { this.touch.sprint = true; }, () => { this.touch.sprint = false; });
  }
}
