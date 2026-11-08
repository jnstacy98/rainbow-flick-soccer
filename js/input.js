// Keyboard, mouse (pointer lock) and touch controls.
// Produces a camera-relative movement vector and discrete actions.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.enabled = false;
    this.yaw = 0;
    this.pitch = 0.3;
    this.ballCam = false;
    this.sensitivity = 0.0026;
    this.chargeStart = 0;
    this.charging = false;
    this.onAction = () => {};
    this.onToggle = () => {}; // (name)
    this.touch = { active: false, jx: 0, jz: 0, sprint: false };
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (this.isTouch) this.ballCam = true;

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
      this.yaw -= e.movementX * this.sensitivity;
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
      case 'KeyV': this.ballCam = !this.ballCam; this.onToggle('ballcam', this.ballCam); break;
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

  // Called every frame; turns camera with arrow keys / ball cam.
  update(dt, me, ball) {
    if (!this.enabled) return;
    const turn = (this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0);
    this.yaw += turn * 2.4 * dt;
    if (this.keys.has('ArrowUp')) this.pitch = Math.max(0.05, this.pitch - dt);
    if (this.keys.has('ArrowDown')) this.pitch = Math.min(1.1, this.pitch + dt);
    if (this.ballCam && me && ball && turn === 0 && !this.touch.dragging) {
      const dx = ball.x - me.x, dz = ball.z - me.z;
      if (Math.hypot(dx, dz) > 2.5) {
        const target = Math.atan2(dx, dz);
        let d = target - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += d * Math.min(1, dt * 3);
      }
    }
  }

  // World-space movement vector from WASD relative to the camera.
  movement() {
    let f = 0, s = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW')) f += 1;
      if (this.keys.has('KeyS')) f -= 1;
      if (this.keys.has('KeyD')) s += 1;
      if (this.keys.has('KeyA')) s -= 1;
      if (this.touch.active) { f += this.touch.jz; s += this.touch.jx; }
    }
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw);
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
          this.yaw -= (t.clientX - lx) * 0.006;
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
