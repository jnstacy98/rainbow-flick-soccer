// Three.js scene: stadium, pitch, goals, players, ball, camera and effects.
import * as THREE from 'three';
import { TEAMS, C } from './sim.js';

const KEEPER_KIT = [0x9be564, 0xf15bb5]; // goalkeeper shirts per team
const RAINBOW = [0xff3b3b, 0xff8c1a, 0xffe02e, 0x3fdc4a, 0x2fa8ff, 0x5b4bff, 0xc04bff];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(0xbfe3ff, 90, 260);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);
    this.camera.position.set(0, 20, -30);

    const hemi = new THREE.HemisphereLight(0xdff2ff, 0x3b6b2a, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3dd, 2.2);
    sun.position.set(30, 60, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 50; sc.bottom = -50; sc.near = 1; sc.far = 160;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    this.sun = sun;

    this.fieldGroup = null;
    this.fieldKey = '';
    this.players = new Map(); // num -> mesh bundle
    this.ball = this.makeBall();
    this.scene.add(this.ball);
    this.ballMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false })
    );
    this.ballMarker.rotation.x = -Math.PI / 2;
    this.scene.add(this.ballMarker);

    this.aimArrow = makeAimArrow();
    this.aimArrow.visible = false;
    this.scene.add(this.aimArrow);
    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthWrite: false })
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);

    this.particles = [];
    this.trailTimer = 0;
    this.trailUntil = 0;
    this.now = 0;

    this.camYaw = 0;
    this.camPitch = 0.32;
    this.camPos = new THREE.Vector3(0, 10, -20);
    this.camLook = new THREE.Vector3();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setField(f) {
    const key = `${f.L}x${f.W}`;
    if (key === this.fieldKey) return;
    this.fieldKey = key;
    if (this.fieldGroup) {
      this.scene.remove(this.fieldGroup);
      this.fieldGroup.traverse((o) => { o.geometry?.dispose(); });
    }
    this.field = f;
    this.fieldGroup = buildStadium(f);
    this.scene.add(this.fieldGroup);
  }

  makeBall() {
    const tex = makeBallTexture();
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(C.ballRadius, 32, 24),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.05 })
    );
    m.castShadow = true;
    return m;
  }

  // A jointed humanoid: hips -> thighs -> knees -> shins, torso -> shoulders ->
  // upper arms -> elbows -> forearms -> hands. Limbs pivot at joints that sit
  // inside the body, so arms and legs stay attached while animating.
  makePlayer(team, name, isMe, gk = false, num = 0) {
    const t = TEAMS[team];
    const look = playerLook(num);
    const g = new THREE.Group();
    g.rotation.order = 'YXZ';
    const shirtColor = gk ? KEEPER_KIT[team] : t.color;
    const mat = (color, rough = 0.7) => new THREE.MeshStandardMaterial({ color, roughness: rough });
    const shirtTex = makeShirtTexture(shirtColor, t.accent, num, gk);
    const shirt = new THREE.MeshStandardMaterial({ map: shirtTex, roughness: 0.65 });
    const sleeve = mat(shirtColor, 0.65);
    const skin = mat(look.skin, 0.75);
    const shortsMat = mat(gk ? 0x222222 : 0x1d1f2b);
    const sockMat = mat(gk ? 0x222222 : t.accent);
    const bootMat = mat(look.boot, 0.45);
    const hairMat = mat(look.hair, 0.9);
    const dark = mat(0x1a1a1a, 0.4);
    const shadowed = (m) => { m.castShadow = true; return m; };
    const add = (parent, geo, material, x = 0, y = 0, z = 0) => {
      const m = shadowed(new THREE.Mesh(geo, material));
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // Root sits at the hips so the whole body can bob and lean.
    const hips = new THREE.Group();
    hips.position.y = 0.95;
    g.add(hips);
    add(hips, new THREE.CylinderGeometry(0.2, 0.19, 0.24, 14), shortsMat, 0, 0.02, 0);

    // Upper body pivots at the waist (lean, twist).
    const upper = new THREE.Group();
    upper.position.y = 0.1;
    hips.add(upper);
    const torso = add(upper, new THREE.CylinderGeometry(0.27, 0.205, 0.58, 18, 1), shirt, 0, 0.3, 0);
    torso.scale.z = 0.72;
    add(upper, new THREE.SphereGeometry(0.27, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), sleeve, 0, 0.59, 0).scale.set(1, 0.32, 0.72);
    add(upper, new THREE.CylinderGeometry(0.065, 0.075, 0.14, 10), skin, 0, 0.66, 0); // neck

    // Head.
    const head = new THREE.Group();
    head.position.y = 0.83;
    upper.add(head);
    add(head, new THREE.SphereGeometry(0.135, 18, 14), skin).scale.set(0.95, 1.1, 1);
    for (const ex of [-0.05, 0.05]) {
      add(head, new THREE.SphereGeometry(0.018, 8, 6), dark, ex, 0.02, 0.122);
      add(head, new THREE.SphereGeometry(0.03, 8, 6), skin, ex * 2.6, 0, 0).scale.set(0.5, 1, 0.8); // ears
    }
    add(head, new THREE.ConeGeometry(0.022, 0.05, 6), skin, 0, -0.01, 0.135).rotation.x = Math.PI / 2; // nose
    const hairCap = add(head, new THREE.SphereGeometry(0.145, 18, 10, 0, Math.PI * 2, 0, Math.PI * look.hairCover), hairMat, 0, 0.012, -0.008);
    hairCap.scale.set(1, look.hairHeight, 1.05);
    if (look.bun) add(head, new THREE.SphereGeometry(0.06, 10, 8), hairMat, 0, 0.1, -0.12);

    // Arms: shoulder joint tucked into the top corner of the torso.
    const mkArm = (side) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.27, 0.53, 0);
      upper.add(shoulder);
      add(shoulder, new THREE.SphereGeometry(0.085, 12, 10), sleeve); // deltoid fills the joint
      add(shoulder, new THREE.CapsuleGeometry(0.068, 0.2, 4, 10), sleeve, 0, -0.14, 0); // sleeve
      add(shoulder, new THREE.CapsuleGeometry(0.056, 0.12, 4, 10), skin, 0, -0.24, 0); // upper arm
      const elbow = new THREE.Group();
      elbow.position.y = -0.31;
      shoulder.add(elbow);
      add(elbow, new THREE.SphereGeometry(0.052, 10, 8), skin);
      add(elbow, new THREE.CapsuleGeometry(0.048, 0.2, 4, 10), skin, 0, -0.13, 0);
      add(elbow, new THREE.SphereGeometry(gk ? 0.085 : 0.055, 10, 8), gk ? mat(0xffffff, 0.5) : skin, 0, -0.28, 0.01);
      return { shoulder, elbow };
    };
    const armL = mkArm(-1), armR = mkArm(1);

    // Legs: hip joints inside the shorts.
    const mkLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.105, -0.04, 0);
      hips.add(hip);
      add(hip, new THREE.CylinderGeometry(0.105, 0.095, 0.24, 12), shortsMat, 0, -0.08, 0); // shorts leg
      add(hip, new THREE.CapsuleGeometry(0.082, 0.26, 4, 10), skin, 0, -0.26, 0); // thigh
      const knee = new THREE.Group();
      knee.position.y = -0.44;
      hip.add(knee);
      add(knee, new THREE.SphereGeometry(0.075, 10, 8), skin);
      add(knee, new THREE.CapsuleGeometry(0.07, 0.24, 4, 10), sockMat, 0, -0.2, 0); // sock / shin
      const boot = add(knee, new THREE.BoxGeometry(0.11, 0.08, 0.26), bootMat, 0, -0.42, 0.05);
      boot.geometry.translate(0, 0, 0);
      return { hip, knee };
    };
    const legL = mkLeg(-1), legR = mkLeg(1);

    // Name tag.
    const label = makeLabel(gk ? `🧤 ${name}` : name, t.css, isMe);
    label.position.y = 2.3;
    g.add(label);

    // "PASS!" bubble shown while calling for the ball.
    const bubble = makeCallBubble(t.css);
    bubble.position.y = 2.95;
    bubble.visible = false;
    g.add(bubble);

    // Ring under the local player.
    let ring = null;
    if (isMe) {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.8, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      g.add(ring);
    }

    this.scene.add(g);
    return {
      g, hips, upper, head, armL, armR, legL, legR, label, ring, bubble,
      phase: Math.random() * 6, team, name, isMe, gk, num, idle: Math.random() * 6,
    };
  }

  // Running / idle / kick / slide / keeper poses.
  animatePlayer(m, p, dt) {
    const sp = Math.hypot(p.vx, p.vz);
    const run = Math.min(1, sp / 9);
    m.phase += dt * (sp > 0.3 ? 5 + sp * 0.95 : 0);
    m.idle += dt;
    const ph = m.phase;
    const s = Math.sin(ph);
    const tackling = p.flags & 1, kicking = p.flags & 4, diving = p.flags & 16, holding = p.flags & 32;
    const ease = (obj, key, target, k = 16) => { obj[key] += (target - obj[key]) * Math.min(1, dt * k); };

    // Legs: thigh swing + knee bend on the recovery stroke.
    let thighL = -s * 0.85 * run, thighR = s * 0.85 * run;
    let kneeL = run * (0.2 + 1.25 * Math.max(0, Math.sin(ph + 1.3)));
    let kneeR = run * (0.2 + 1.25 * Math.max(0, Math.sin(ph + 1.3 + Math.PI)));
    // Arms swing opposite to the legs with bent elbows.
    let armLx = s * 0.75 * run, armRx = -s * 0.75 * run;
    let elbow = -(0.25 + 1.0 * run);
    let armOut = 0.1 + 0.05 * run;
    let lean = 0.06 + run * 0.22, twist = s * 0.18 * run;
    let hipY = 0.95 + Math.abs(Math.cos(ph)) * 0.05 * run;

    if (sp < 0.3) {
      // Idle: weight shift and breathing.
      const b = Math.sin(m.idle * 2);
      thighL = 0.04; thighR = -0.04; kneeL = 0.08; kneeR = 0.08;
      armLx = 0.05 + b * 0.02; armRx = 0.05 - b * 0.02; elbow = -0.25;
      lean = 0.04; twist = 0; hipY = 0.95 + b * 0.008;
    }
    if (kicking) { thighR = -1.25; kneeR = 0.15; thighL = 0.25; kneeL = 0.35; armLx = -0.6; armRx = 0.5; lean = -0.1; }
    if (tackling) { thighL = -1.35; thighR = -1.15; kneeL = 0.1; kneeR = 0.5; lean = -0.55; hipY = 0.45; armLx = 0.6; armRx = -0.9; }
    if (holding) { armLx = -1.35; armRx = -1.35; elbow = -0.5; armOut = -0.05; }
    if (diving) { armLx = -2.9; armRx = -2.9; elbow = -0.1; armOut = 0.3; thighL = -0.4; thighR = 0.2; hipY = 0.7; }

    ease(m.legL.hip.rotation, 'x', thighL);
    ease(m.legR.hip.rotation, 'x', thighR);
    ease(m.legL.knee.rotation, 'x', kneeL);
    ease(m.legR.knee.rotation, 'x', kneeR);
    ease(m.armL.shoulder.rotation, 'x', armLx);
    ease(m.armR.shoulder.rotation, 'x', armRx);
    ease(m.armL.shoulder.rotation, 'z', -armOut);
    ease(m.armR.shoulder.rotation, 'z', armOut);
    ease(m.armL.elbow.rotation, 'x', elbow);
    ease(m.armR.elbow.rotation, 'x', elbow);
    ease(m.upper.rotation, 'x', lean, 10);
    ease(m.upper.rotation, 'y', twist, 10);
    ease(m.head.rotation, 'x', -lean * 0.6, 10); // keep eyes up
    ease(m.hips.position, 'y', hipY, 20);
    ease(m.hips.rotation, 'y', -twist * 0.5, 10);

    // Dive: lean the whole body sideways toward the dive direction.
    if (diving) {
      const side = Math.sin(Math.atan2(p.vx, p.vz) - p.yaw);
      m.g.rotation.z += ((side >= 0 ? -1.25 : 1.25) - m.g.rotation.z) * Math.min(1, dt * 14);
    } else {
      m.g.rotation.z *= Math.max(0, 1 - dt * 10);
    }
  }

  syncPlayers(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.num);
      let m = this.players.get(p.num);
      const gk = !!(p.flags & 64);
      if (m && (m.team !== p.team || m.name !== p.name || m.isMe !== p.isMe || m.gk !== gk || m.num !== p.num)) {
        this.disposePlayer(p.num);
        m = null;
      }
      if (!m) {
        m = this.makePlayer(p.team, p.name, p.isMe, gk, p.num);
        this.players.set(p.num, m);
      }
    }
    for (const num of [...this.players.keys()]) if (!seen.has(num)) this.disposePlayer(num);
  }

  disposePlayer(num) {
    const m = this.players.get(num);
    if (!m) return;
    this.scene.remove(m.g);
    m.g.traverse((o) => { o.geometry?.dispose(); if (o.material?.map) o.material.map.dispose(); });
    this.players.delete(num);
  }

  // state: { players: [{num,x,z,vx,vz,yaw,team,name,isMe,flags}], ball: {x,y,z,vx,vy,vz}, me: num }
  frame(state, dt, camOpts) {
    this.now += dt;
    this.syncPlayers(state.players);
    let me = null;
    for (const p of state.players) {
      const m = this.players.get(p.num);
      m.g.position.set(p.x, 0, p.z);
      m.g.rotation.y = p.yaw;
      this.animatePlayer(m, p, dt);
      m.label.material.opacity = (p.flags & 2) ? 0.4 : 1;
      m.bubble.visible = !!(p.flags & 8);
      if (m.bubble.visible) m.bubble.scale.set(1.6 + Math.sin(this.now * 10) * 0.12, 0.8 + Math.sin(this.now * 10) * 0.06, 1);
      if (m.ring) m.ring.material.opacity = 0.6 + Math.sin(this.now * 5) * 0.25;
      if (p.isMe) me = p;
    }

    // Ball.
    const b = state.ball;
    this.ball.position.set(b.x, b.y, b.z);
    const bs = Math.hypot(b.vx, b.vz);
    if (bs > 0.01) {
      const axis = new THREE.Vector3(b.vz, 0, -b.vx).normalize();
      this.ball.rotateOnWorldAxis(axis, (bs * dt) / C.ballRadius);
    }
    this.ballMarker.position.set(b.x, 0.02, b.z);
    this.ballMarker.visible = b.y > 0.9;
    this.ballMarker.scale.setScalar(1 + b.y * 0.15);

    // Rainbow trail behind fast or flicked balls.
    this.trailTimer -= dt;
    const speed3 = Math.hypot(b.vx, b.vy, b.vz);
    if ((this.now < this.trailUntil || speed3 > 22) && this.trailTimer <= 0) {
      this.trailTimer = 0.016;
      this.spawnTrail(b);
    }
    this.updateParticles(dt);
    this.updateCamera(me, b, dt, camOpts);
    this.renderer.render(this.scene, this.camera);
  }

  updateCamera(me, ball, dt, opts) {
    const target = me ? new THREE.Vector3(me.x, 0, me.z) : new THREE.Vector3(ball.x, 0, ball.z);
    const yaw = opts.yaw, pitch = opts.pitch;
    const dist = opts.dist || 9;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let hd = Math.cos(pitch) * dist;
    // Pull the camera in so it never ends up inside the stands (e.g. a keeper
    // standing on the goal line with their back to the crowd).
    if (this.field) {
      const bx = this.field.L / 2 + 4, bz = this.field.W / 2 + 4;
      let k = 1;
      const cx = target.x - fx * hd, cz = target.z - fz * hd;
      if (Math.abs(cx) > bx && Math.abs(fx) > 1e-3) k = Math.min(k, (Math.sign(-fx) * bx - target.x) / (-fx * hd));
      if (Math.abs(cz) > bz && Math.abs(fz) > 1e-3) k = Math.min(k, (Math.sign(-fz) * bz - target.z) / (-fz * hd));
      k = Math.max(0.3, Math.min(1, k));
      hd *= k;
    }
    const desired = new THREE.Vector3(target.x - fx * hd, 1.6 + Math.sin(pitch) * dist + (dist * Math.cos(pitch) - hd) * 0.5, target.z - fz * hd);
    const look = new THREE.Vector3(target.x + fx * 4, 1.4, target.z + fz * 4);
    if (opts.orbit !== undefined) {
      const t = opts.orbit;
      desired.set(Math.sin(t) * 52, 20 + Math.sin(t * 0.7) * 4, Math.cos(t) * 40);
      look.set(0, 0, 0);
    }
    if (opts.spectate) {
      desired.set(ball.x, 32, ball.z - 34);
      look.set(ball.x, 0, ball.z);
    }
    const k = 1 - Math.exp(-dt * 12);
    this.camPos.lerp(desired, k);
    this.camLook.lerp(look, k);
    if (this.camPos.y < 0.6) this.camPos.y = 0.6;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // Keep the shadow camera centred near the action.
    this.sun.position.set(target.x + 30, 60, target.z + 20);
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.target.updateMatrixWorld();
  }

  // Aim arrow on the ground plus a ring under the teammate a pass would reach.
  setAim(info, players) {
    if (!info) { this.aimArrow.visible = false; this.targetRing.visible = false; return; }
    this.aimArrow.visible = true;
    this.aimArrow.position.set(info.x, 0.04, info.z);
    this.aimArrow.rotation.y = info.aim;
    const t = info.target != null ? players.find((p) => p.num === info.target) : null;
    this.targetRing.visible = !!t;
    if (t) {
      this.targetRing.position.set(t.x, 0.05, t.z);
      const pulse = 1 + Math.sin(this.now * 8) * 0.08;
      this.targetRing.scale.set(pulse, pulse, pulse);
    }
  }

  rainbowBurst(x = null) {
    this.trailUntil = this.now + (x ?? 1.4);
  }

  spawnTrail(b) {
    const color = RAINBOW[Math.floor(this.now * 20) % RAINBOW.length];
    const m = new THREE.Mesh(sharedTrailGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    m.position.set(b.x, b.y, b.z);
    this.scene.add(m);
    this.particles.push({ m, life: 0.6, max: 0.6, vx: 0, vy: 0, vz: 0, g: 0, shrink: true });
  }

  confetti(x, z, teamIdx) {
    const colors = [...RAINBOW, TEAMS[teamIdx].color];
    for (let i = 0; i < 220; i++) {
      const m = new THREE.Mesh(sharedConfettiGeo, new THREE.MeshBasicMaterial({
        color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true,
      }));
      m.position.set(x + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, z + (Math.random() - 0.5) * 8);
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.scene.add(m);
      this.particles.push({
        m, life: 3 + Math.random(), max: 4,
        vx: (Math.random() - 0.5) * 14, vy: 6 + Math.random() * 10, vz: (Math.random() - 0.5) * 14,
        g: 9, spin: (Math.random() - 0.5) * 12,
      });
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.m);
        p.m.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= p.g * dt;
      if (p.g) { p.vx *= 1 - 1.5 * dt; p.vz *= 1 - 1.5 * dt; p.vy = Math.max(p.vy, -2.5); }
      p.m.position.x += p.vx * dt;
      p.m.position.y = Math.max(0.02, p.m.position.y + p.vy * dt);
      p.m.position.z += p.vz * dt;
      if (p.spin) { p.m.rotation.x += p.spin * dt; p.m.rotation.y += p.spin * 0.7 * dt; }
      const f = p.life / p.max;
      p.m.material.opacity = Math.min(1, f * 1.5);
      if (p.shrink) p.m.scale.setScalar(0.3 + f);
    }
  }

  clearPlayers() {
    for (const num of [...this.players.keys()]) this.disposePlayer(num);
  }
}

const sharedTrailGeo = new THREE.SphereGeometry(0.22, 8, 6);
const sharedConfettiGeo = new THREE.PlaneGeometry(0.18, 0.1);

// ---------- Stadium construction ----------

function buildStadium(f) {
  const g = new THREE.Group();
  const { L, W } = f;

  // Surrounding ground.
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 60, W + 60),
    new THREE.MeshStandardMaterial({ color: 0x2f7a35, roughness: 1 })
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.01;
  outer.receiveShadow = true;
  g.add(outer);

  // Pitch with mowing stripes and markings drawn on a canvas.
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(L + 6, W + 6),
    new THREE.MeshStandardMaterial({ map: makePitchTexture(f), roughness: 0.95 })
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  g.add(pitch);

  // Boards around the pitch (with a gap at each goal mouth).
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const rainbowMat = new THREE.MeshStandardMaterial({ map: makeRainbowStripTexture(), roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.12, roughness: 0.1, depthWrite: false });
  const bh = 0.9, bt = 0.25;
  const addBoard = (w, x, z, rotY) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, bh, bt), [boardMat, boardMat, boardMat, boardMat, rainbowMat, rainbowMat]);
    m.position.set(x, bh / 2, z);
    m.rotation.y = rotY;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.2), glassMat);
    glass.position.set(x, bh + 1.1, z);
    glass.rotation.y = rotY;
    g.add(glass);
  };
  addBoard(L + bt * 2, 0, W / 2 + bt / 2, 0);
  addBoard(L + bt * 2, 0, -W / 2 - bt / 2, 0);
  const seg = (W - f.goalW) / 2;
  for (const sx of [1, -1]) {
    addBoard(seg, sx * (L / 2 + bt / 2), W / 2 - seg / 2, Math.PI / 2);
    addBoard(seg, sx * (L / 2 + bt / 2), -W / 2 + seg / 2, Math.PI / 2);
  }

  for (const side of [1, -1]) g.add(buildGoal(f, side));

  // Stands with a crowd.
  g.add(buildStands(f));

  // Corner flags.
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6), boardMat);
    pole.position.set(sx * (L / 2 - 0.3), 0.8, sz * (W / 2 - 0.3));
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.35), new THREE.MeshStandardMaterial({ color: RAINBOW[(sx + 1 + sz + 1) % 7], side: THREE.DoubleSide }));
    flag.position.set(sx * (L / 2 - 0.3) + 0.25, 1.4, sz * (W / 2 - 0.3));
    g.add(flag);
  }

  // A giant rainbow arching over the stadium.
  const arc = new THREE.Group();
  const radius = Math.max(L, W) * 0.95;
  RAINBOW.forEach((c, i) => {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(radius - i * 2.2, 1.1, 8, 96, Math.PI),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, fog: false })
    );
    arc.add(t);
  });
  arc.position.set(0, -6, W / 2 + 70);
  g.add(arc);

  return g;
}

function buildGoal(f, side) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 });
  const pr = C.postRadius;
  const x = side * f.L / 2;
  for (const pz of [f.goalW / 2, -f.goalW / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, f.goalH, 12), white);
    post.position.set(x, f.goalH / 2, pz);
    post.castShadow = true;
    g.add(post);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(pr * 0.6, pr * 0.6, f.goalH, 8), white);
    back.position.set(x + side * f.goalD, f.goalH / 2, pz);
    g.add(back);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(pr * 0.6, pr * 0.6, f.goalD, 8), white);
    top.rotation.z = Math.PI / 2;
    top.position.set(x + side * f.goalD / 2, f.goalH, pz);
    g.add(top);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr, f.goalW + pr * 2, 12), white);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(x, f.goalH, 0);
  bar.castShadow = true;
  g.add(bar);

  const netTex = makeNetTexture();
  const mkNet = (w, h, rep) => {
    const t = netTex.clone();
    t.needsUpdate = true;
    t.repeat.set(w * rep, h * rep);
    return new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1 });
  };
  const backNet = new THREE.Mesh(new THREE.PlaneGeometry(f.goalW, f.goalH), mkNet(f.goalW, f.goalH, 2.5));
  backNet.rotation.y = Math.PI / 2;
  backNet.position.set(x + side * f.goalD, f.goalH / 2, 0);
  g.add(backNet);
  for (const pz of [f.goalW / 2, -f.goalW / 2]) {
    const sn = new THREE.Mesh(new THREE.PlaneGeometry(f.goalD, f.goalH), mkNet(f.goalD, f.goalH, 2.5));
    sn.position.set(x + side * f.goalD / 2, f.goalH / 2, pz);
    g.add(sn);
  }
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(f.goalD, f.goalW), mkNet(f.goalD, f.goalW, 2.5));
  roof.rotation.x = -Math.PI / 2;
  roof.position.set(x + side * f.goalD / 2, f.goalH, 0);
  g.add(roof);
  return g;
}

function buildStands(f) {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, roughness: 0.9 });
  const rows = 8;
  const crowdGeo = new THREE.BoxGeometry(0.5, 0.9, 0.4);
  const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const seats = [];
  const addStand = (len, cx, cz, rotY) => {
    const stand = new THREE.Group();
    for (let r = 0; r < rows; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(len, 0.6, 1.2), concrete);
      step.position.set(0, 0.3 + r * 0.6, r * 1.2);
      step.receiveShadow = true;
      stand.add(step);
      for (let s = -len / 2 + 0.6; s < len / 2 - 0.4; s += 0.9) {
        if (Math.random() < 0.25) continue;
        seats.push({ stand, x: s + (Math.random() - 0.5) * 0.2, y: 0.6 + r * 0.6 + 0.45, z: r * 1.2 });
      }
    }
    stand.position.set(cx, 0, cz);
    stand.rotation.y = rotY;
    g.add(stand);
    stand.updateMatrixWorld(true);
  };
  addStand(f.L + 10, 0, f.W / 2 + 6, 0);
  addStand(f.L + 10, 0, -f.W / 2 - 6, Math.PI);
  addStand(f.W + 4, f.L / 2 + 7, 0, Math.PI / 2);
  addStand(f.W + 4, -f.L / 2 - 7, 0, -Math.PI / 2);

  const inst = new THREE.InstancedMesh(crowdGeo, crowdMat, seats.length);
  const mtx = new THREE.Matrix4();
  const col = new THREE.Color();
  const palette = [...RAINBOW, TEAMS[0].color, TEAMS[1].color, TEAMS[0].color, TEAMS[1].color, 0xffffff];
  g.updateMatrixWorld(true);
  seats.forEach((s, i) => {
    const v = new THREE.Vector3(s.x, s.y, s.z).applyMatrix4(s.stand.matrixWorld);
    mtx.makeTranslation(v.x, v.y, v.z);
    inst.setMatrixAt(i, mtx);
    inst.setColorAt(i, col.setHex(palette[(Math.random() * palette.length) | 0]));
  });
  inst.instanceMatrix.needsUpdate = true;
  g.add(inst);
  return g;
}

// ---------- Procedural textures ----------

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeSkyTexture() {
  return canvasTex(4, 256, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#3d8bff');
    g.addColorStop(0.55, '#9fd2ff');
    g.addColorStop(1, '#ffe7c4');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function makePitchTexture(f) {
  const ppm = 12; // pixels per metre
  const L = f.L + 6, W = f.W + 6;
  return canvasTex(Math.round(L * ppm), Math.round(W * ppm), (ctx, w, h) => {
    const stripes = 14;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#3fa34a' : '#48b354';
      ctx.fillRect((i * w) / stripes, 0, w / stripes + 1, h);
    }
    // Subtle noise.
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    const X = (x) => (x + L / 2) * ppm;
    const Z = (z) => (z + W / 2) * ppm;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 0.14 * ppm;
    ctx.strokeRect(X(-f.L / 2), Z(-f.W / 2), f.L * ppm, f.W * ppm);
    ctx.beginPath(); ctx.moveTo(X(0), Z(-f.W / 2)); ctx.lineTo(X(0), Z(f.W / 2)); ctx.stroke();
    const cr = Math.min(9.15, f.W * 0.17);
    ctx.beginPath(); ctx.arc(X(0), Z(0), cr * ppm, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(X(0), Z(0), 0.25 * ppm, 0, Math.PI * 2); ctx.fill();
    const boxD = Math.min(16.5, f.L * 0.16), boxW = Math.min(40.3, f.W * 0.62);
    const sixD = Math.min(5.5, f.L * 0.055), sixW = f.goalW + 6;
    for (const s of [1, -1]) {
      const x0 = s * f.L / 2;
      ctx.strokeRect(Math.min(X(x0), X(x0 - s * boxD)), Z(-boxW / 2), boxD * ppm, boxW * ppm);
      ctx.strokeRect(Math.min(X(x0), X(x0 - s * sixD)), Z(-sixW / 2), sixD * ppm, sixW * ppm);
      const spot = x0 - s * boxD * 0.67;
      ctx.beginPath(); ctx.arc(X(spot), Z(0), 0.2 * ppm, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      const a0 = s === 1 ? Math.PI * 0.7 : -Math.PI * 0.3;
      ctx.arc(X(spot), Z(0), cr * ppm, a0, a0 + Math.PI * 0.6);
      ctx.stroke();
    }
    // Rainbow centre-circle fill.
    const grad = ctx.createRadialGradient(X(0), Z(0), cr * ppm * 0.2, X(0), Z(0), cr * ppm);
    const cols = ['#ff3b3b', '#ff8c1a', '#ffe02e', '#3fdc4a', '#2fa8ff', '#5b4bff', '#c04bff'];
    cols.forEach((c, i) => grad.addColorStop(i / (cols.length - 1), c));
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(X(0), Z(0), cr * ppm - ctx.lineWidth, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  });
}

function makeBallTexture() {
  return canvasTex(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const cols = ['#ff3b3b', '#ff8c1a', '#ffe02e', '#3fdc4a', '#2fa8ff', '#5b4bff', '#c04bff'];
    // Hexagon-ish rainbow panels.
    let i = 0;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 7; x++) {
        const cx = (x + (y % 2) * 0.5) * (w / 7);
        const cy = (y + 0.5) * (h / 4);
        ctx.fillStyle = cols[i++ % cols.length];
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const px = cx + Math.cos(a) * 22, py = cy + Math.sin(a) * 20;
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
  });
}

function makeNetTexture() {
  const t = canvasTex(32, 32, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, w, h);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeRainbowStripTexture() {
  return canvasTex(256, 16, (ctx, w, h) => {
    const cols = ['#ff3b3b', '#ff8c1a', '#ffe02e', '#3fdc4a', '#2fa8ff', '#5b4bff', '#c04bff'];
    const g = ctx.createLinearGradient(0, 0, w, 0);
    cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

// Per-player appearance (skin tone, hair, boots) derived from their number.
const SKIN_TONES = [0xffdbac, 0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a21, 0xf3d0b5, 0xa86b3c];
const HAIR_COLORS = [0x1b1b1b, 0x3b2314, 0x6b4423, 0xb5884f, 0xe6c15a, 0x8c2f1b, 0x2b2b2b, 0xd9d9d9];
const BOOT_COLORS = [0xffffff, 0x111111, 0xff3b7a, 0x3fdc4a, 0xffe02e, 0x2fa8ff];
function playerLook(num) {
  let h = (num * 2654435761) >>> 0;
  const pick = (arr) => { h = (h * 1103515245 + 12345) >>> 0; return arr[(h >>> 8) % arr.length]; };
  return {
    skin: pick(SKIN_TONES),
    hair: pick(HAIR_COLORS),
    boot: pick(BOOT_COLORS),
    hairCover: pick([0.42, 0.5, 0.58, 0.36]), // how far down the head the hair reaches
    hairHeight: pick([0.85, 1, 1.15, 1.3]),
    bun: pick([false, false, false, true]),
  };
}

// Shirt with a chest stripe and a big number on the back.
function makeShirtTexture(color, accent, num, gk) {
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  return canvasTex(256, 128, (ctx, w, h) => {
    ctx.fillStyle = hex(color);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = hex(accent);
    ctx.globalAlpha = gk ? 0.5 : 0.9;
    ctx.fillRect(0, h * 0.18, w * 0.18, h * 0.1); // front stripe (left of seam)
    ctx.fillRect(w * 0.82, h * 0.18, w * 0.18, h * 0.1); // front stripe (right of seam)
    ctx.globalAlpha = 1;
    const n = String(num % 100 || 1);
    ctx.font = 'bold 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(n, w * 0.5, h * 0.52);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(n, w * 0.5, h * 0.52); // u = 0.5 is the back of the cylinder
  });
}

function makeAimArrow() {
  // Flat arrow pointing along +z, starting just in front of the player.
  const shape = new THREE.Shape();
  const w = 0.2, head = 0.6, len = 6, start = 1.1;
  shape.moveTo(-w, start);
  shape.lineTo(w, start);
  shape.lineTo(w, len - head);
  shape.lineTo(head, len - head);
  shape.lineTo(0, len);
  shape.lineTo(-head, len - head);
  shape.lineTo(-w, len - head);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(Math.PI / 2); // lie flat, pointing toward +z
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0xffd23f, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
  }));
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

function makeCallBubble(color) {
  const t = canvasTex(128, 64, (ctx, w, h) => {
    ctx.fillStyle = '#ffd23f';
    roundRect(ctx, 4, 4, w - 8, h - 18, 14);
    ctx.fill();
    ctx.beginPath(); ctx.moveTo(w / 2 - 10, h - 15); ctx.lineTo(w / 2 + 10, h - 15); ctx.lineTo(w / 2, h - 2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    roundRect(ctx, 4, 4, w - 8, h - 18, 14);
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 28px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('PASS!', w / 2, (h - 14) / 2 + 2);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
  s.scale.set(1.6, 0.8, 1);
  s.renderOrder = 10;
  return s;
}

function makeLabel(text, color, isMe) {
  const t = canvasTex(256, 64, (ctx, w, h) => {
    ctx.font = 'bold 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = Math.min(w - 8, ctx.measureText(text).width + 28);
    ctx.fillStyle = isMe ? 'rgba(255,255,255,0.92)' : 'rgba(10,14,30,0.6)';
    roundRect(ctx, (w - tw) / 2, 10, tw, 44, 14);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect((w - tw) / 2 + 10, 28, 8, 8);
    ctx.fillStyle = isMe ? '#111' : '#fff';
    ctx.fillText(text.slice(0, 14), w / 2 + 6, 33);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(2.2, 0.55, 1);
  return s;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
