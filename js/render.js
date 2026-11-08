// Three.js scene: stadium, pitch, goals, players, ball, camera and effects.
import * as THREE from 'three';
import { TEAMS, C } from './sim.js';

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

  makePlayer(team, name, isMe) {
    const t = TEAMS[team];
    const g = new THREE.Group();
    const shirt = new THREE.MeshStandardMaterial({ color: t.color, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: t.accent, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xf1c09a, roughness: 0.7 });
    const shorts = new THREE.MeshStandardMaterial({ color: 0x1d1f2b, roughness: 0.7 });
    const boot = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 6, 12), shirt);
    torso.position.y = 1.25;
    torso.castShadow = true;
    g.add(torso);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.335, 0.335, 0.12, 16), accent);
    stripe.position.y = 1.32;
    g.add(stripe);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), skin);
    head.position.y = 1.95;
    head.castShadow = true;
    g.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.2), accent);
    hair.position.y = 1.98;
    g.add(hair);

    const mkLimb = (len, rad, mat) => {
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 4, 8), mat);
      mesh.position.y = -len / 2 - rad;
      mesh.castShadow = true;
      pivot.add(mesh);
      return pivot;
    };
    const legL = mkLimb(0.55, 0.11, shorts);
    const legR = mkLimb(0.55, 0.11, shorts);
    legL.position.set(-0.15, 0.88, 0);
    legR.position.set(0.15, 0.88, 0);
    for (const leg of [legL, legR]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.3), boot);
      b.position.set(0, -0.84, 0.06);
      b.castShadow = true;
      leg.add(b);
      g.add(leg);
    }
    const armL = mkLimb(0.45, 0.085, shirt);
    const armR = mkLimb(0.45, 0.085, shirt);
    armL.position.set(-0.42, 1.55, 0);
    armR.position.set(0.42, 1.55, 0);
    g.add(armL, armR);

    // Name tag.
    const label = makeLabel(name, t.css, isMe);
    label.position.y = 2.65;
    g.add(label);

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
    return { g, legL, legR, armL, armR, torso, label, ring, phase: 0, team, name, isMe };
  }

  syncPlayers(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.num);
      let m = this.players.get(p.num);
      if (m && (m.team !== p.team || m.name !== p.name || m.isMe !== p.isMe)) {
        this.disposePlayer(p.num);
        m = null;
      }
      if (!m) {
        m = this.makePlayer(p.team, p.name, p.isMe);
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
      const sp = Math.hypot(p.vx, p.vz);
      m.phase += dt * (4 + sp * 1.4);
      const amp = Math.min(1, sp / 8) * 0.8;
      const tackling = p.flags & 1;
      const kicking = p.flags & 4;
      const s = Math.sin(m.phase) * amp;
      m.legL.rotation.x = tackling ? -1.2 : s;
      m.legR.rotation.x = tackling ? -1.2 : kicking ? -1.1 : -s;
      m.armL.rotation.x = -s * 0.9;
      m.armR.rotation.x = s * 0.9;
      m.torso.rotation.x = tackling ? 0.6 : Math.min(0.25, sp * 0.02);
      m.g.position.y = tackling ? -0.35 : Math.abs(Math.sin(m.phase)) * amp * 0.06;
      m.label.material.opacity = (p.flags & 2) ? 0.4 : 1;
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
    const hd = Math.cos(pitch) * dist;
    const desired = new THREE.Vector3(target.x - fx * hd, 1.6 + Math.sin(pitch) * dist, target.z - fz * hd);
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
  addStand(f.W + 4, f.L / 2 + 7, 0, -Math.PI / 2);
  addStand(f.W + 4, -f.L / 2 - 7, 0, Math.PI / 2);

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
