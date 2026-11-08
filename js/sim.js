// Authoritative soccer simulation. Pure JS (no DOM, no three.js) so it can
// run on the host's browser and be tested in Node.
//
// Coordinates: x runs along the length of the pitch (goals at x = ±L/2),
// z runs across the width, y is up. Team 0 defends -x and attacks +x,
// team 1 defends +x and attacks -x.

export const TEAMS = [
  { name: 'Sunset', color: 0xff5a36, accent: 0xffd23f, css: '#ff5a36' },
  { name: 'Ocean', color: 0x2f7bff, accent: 0x3ff2e0, css: '#2f7bff' },
];

export const MAX_PER_TEAM = 9;

export const C = {
  playerRadius: 0.5,
  ballRadius: 0.36,
  walkSpeed: 7.2,
  sprintSpeed: 10.2,
  accel: 38,
  gravity: 18,
  controlRange: 1.35,
  kickRange: 1.9,
  postRadius: 0.12,
  staminaDrain: 0.22,
  staminaRegen: 0.14,
  tackleSpeed: 14,
  tackleTime: 0.32,
  tackleCooldown: 1.4,
  stunTime: 0.7,
  actionBuffer: 0.22,
  countdown: 3,
  goalPause: 3.5,
  diveSpeed: 11.5,
  diveTime: 0.45,
  diveCooldown: 1.1,
  catchReach: 1.3,
  diveReach: 2.2,
  maxHold: 6,
};

// Bot skill levels: movement speed, reaction time, shot accuracy and aggression.
export const BOT_SKILLS = [
  { name: 'Easy', speed: 0.78, think: 0.32, aimErr: 0.32, shootRange: 16, shootChance: 0.35, tackle: 0.08, passCall: 0.5, gkReach: 6 },
  { name: 'Normal', speed: 0.9, think: 0.16, aimErr: 0.16, shootRange: 22, shootChance: 0.55, tackle: 0.22, passCall: 0.8, gkReach: 9 },
  { name: 'Hard', speed: 0.98, think: 0.09, aimErr: 0.07, shootRange: 26, shootChance: 0.7, tackle: 0.4, passCall: 0.95, gkReach: 11 },
  { name: 'Pro', speed: 1.04, think: 0.05, aimErr: 0.03, shootRange: 30, shootChance: 0.85, tackle: 0.6, passCall: 1, gkReach: 13 },
];

// Field dimensions scale with the larger team so 1v1 isn't lost on a huge pitch.
export function fieldForTeamSize(n) {
  let f;
  if (n <= 2) f = { L: 56, W: 36, goalW: 6.4, goalH: 2.5, goalD: 2.0 };
  else if (n <= 4) f = { L: 70, W: 44, goalW: 7.0, goalH: 2.6, goalD: 2.2 };
  else if (n <= 6) f = { L: 86, W: 54, goalW: 7.32, goalH: 2.6, goalD: 2.4 };
  else f = { L: 100, W: 64, goalW: 7.32, goalH: 2.6, goalD: 2.4 };
  f.boxD = Math.min(16.5, f.L * 0.16); // penalty area depth
  f.boxW = Math.min(40.3, f.W * 0.62); // penalty area width
  return f;
}

// Penalty area bounds for the team defending it (where the keeper can use hands).
export function ownBox(f, team) {
  const boxD = f.boxD ?? Math.min(16.5, f.L * 0.16);
  const boxW = f.boxW ?? Math.min(40.3, f.W * 0.62);
  return team === 0
    ? { x0: -f.L / 2, x1: -f.L / 2 + boxD, z0: -boxW / 2, z1: boxW / 2 }
    : { x0: f.L / 2 - boxD, x1: f.L / 2, z0: -boxW / 2, z1: boxW / 2 };
}

// Where the keeper may move during a free-kick shootout (always the +x goal).
export function shootoutKeeperBox(f) {
  return { x0: f.L / 2 - 2.5, x1: f.L / 2 - 0.4, z0: -(f.goalW / 2 + 1.5), z1: f.goalW / 2 + 1.5 };
}

export function shootoutSpotX(f) {
  return f.L / 2 - Math.max(8, Math.min(11, f.L * 0.14));
}

export function inBox(box, x, z) {
  return x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
}

// Choose the teammate a pass aimed in direction `aim` should go to.
// The direction matters far more than distance, so you get the player you
// point at, not just the closest one. `players` items need {id,team,x,z}.
export function pickPassTarget(players, from, aim) {
  let best = null, bestScore = -Infinity;
  for (const q of players) {
    if (q.id === from.id || q.team !== from.team) continue;
    const dx = q.x - from.x, dz = q.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.5 || d > 50) continue;
    const ang = Math.abs(wrapAngle(Math.atan2(dx, dz) - aim));
    if (ang > 0.7) continue; // ~40 degrees either side
    const score = -ang * 60 - d * 0.05;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

// Shared by host simulation and client-side prediction of the local player.
export function integratePlayerMovement(p, input, dt, opts = {}) {
  const frozen = opts.frozen;
  let mx = input.mx || 0;
  let mz = input.mz || 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  if (frozen) { mx = 0; mz = 0; }

  if (p.tackleT > 0 || p.diveT > 0) {
    // Committed lunge / dive: keep velocity, slow slightly.
    p.vx *= 1 - 1.5 * dt;
    p.vz *= 1 - 1.5 * dt;
  } else {
    const sprinting = input.sprint && p.stamina > 0.05 && len > 0.1;
    const speedMul = opts.speedMul || 1;
    const max = (sprinting ? C.sprintSpeed : C.walkSpeed) * speedMul * (p.stunT > 0 ? 0.55 : 1);
    const tx = mx * max;
    const tz = mz * max;
    const dx = tx - p.vx;
    const dz = tz - p.vz;
    const dl = Math.hypot(dx, dz);
    const step = C.accel * dt;
    if (dl <= step) { p.vx = tx; p.vz = tz; }
    else { p.vx += (dx / dl) * step; p.vz += (dz / dl) * step; }
    if (sprinting) p.stamina = Math.max(0, p.stamina - C.staminaDrain * dt);
    else p.stamina = Math.min(1, p.stamina + C.staminaRegen * dt);
  }
  p.x += p.vx * dt;
  p.z += p.vz * dt;

  const sp = Math.hypot(p.vx, p.vz);
  if (sp > 0.6) {
    const target = Math.atan2(p.vx, p.vz);
    p.yaw += wrapAngle(target - p.yaw) * Math.min(1, 14 * dt);
  }

  if (opts.field) {
    const f = opts.field;
    const lim = C.playerRadius;
    p.x = clamp(p.x, -f.L / 2 + lim, f.L / 2 - lim);
    p.z = clamp(p.z, -f.W / 2 + lim, f.W / 2 - lim);
  }
  if (opts.box) {
    // A keeper holding the ball must stay in their area.
    p.x = clamp(p.x, opts.box.x0, opts.box.x1);
    p.z = clamp(p.z, opts.box.z0, opts.box.z1);
  }
}

function emptyInput() {
  return { mx: 0, mz: 0, sprint: false, aim: 0 };
}

export class Sim {
  constructor() {
    this.players = new Map(); // id -> player
    this.nextNum = 1;
    this.field = fieldForTeamSize(1);
    this.ball = { x: 0, y: C.ballRadius, z: 0, vx: 0, vy: 0, vz: 0 };
    this.score = [0, 0];
    this.phase = 'lobby'; // lobby | countdown | play | goal | ended
    this.phaseT = 0;
    this.timeLeft = 300;
    this.duration = 300;
    this.kickoffTeam = 0;
    this.owner = null;
    this.lastTouch = null;
    this.events = [];
    this.botSkill = [1, 1]; // index into BOT_SKILLS per team
    this.pausedFrom = null;
    this.pausedBy = '';
    this.tiebreak = true; // free-kick shootout when a match ends level
    this.so = null; // shootout state
  }

  skillOf(team) {
    return BOT_SKILLS[clamp(this.botSkill[team] | 0, 0, BOT_SKILLS.length - 1)];
  }

  addPlayer(id, name, team, bot = false) {
    const p = {
      id, num: this.nextNum++, name, team, bot,
      x: 0, z: 0, vx: 0, vz: 0, yaw: team === 0 ? Math.PI / 2 : -Math.PI / 2,
      stamina: 1, kickCd: 0, tackleT: 0, tackleCd: 0, stunT: 0,
      input: emptyInput(), actions: [], goals: 0,
      ai: bot ? { t: Math.random() * 0.2, tx: 0, tz: 0 } : null,
      callT: 0, callCd: 0,
      gk: false, isGK: false, holding: false, holdT: 0, diveT: 0, diveCd: 0,
    };
    this.players.set(id, p);
    if (this.phase !== 'lobby') this.placeAtSpot(p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.owner === id) this.owner = null;
    if (this.holder === id) this.holder = null;
  }

  // Human goalkeeper role (one per team). Returns false if the slot is taken.
  setKeeper(id, on) {
    const p = this.players.get(id);
    if (!p) return false;
    if (on) {
      const other = this.teamList(p.team).find((q) => q.gk && q !== p && !q.bot);
      if (other) return false;
      p.gk = true;
    } else {
      p.gk = false;
      if (this.holder === id) this.dropBall(p);
    }
    this.refreshKeepers();
    if (this.phase !== 'lobby' && on) this.placeAtSpot(p);
    return true;
  }

  refreshKeepers() {
    for (const team of [0, 1]) {
      const spots = this.formation(team);
      for (const q of this.teamList(team)) q.isGK = !!spots.get(q.id)?.gk;
    }
    const h = this.holder && this.players.get(this.holder);
    if (this.holder && (!h || !h.isGK)) { if (h) h.holding = false; this.holder = null; }
  }

  teamList(team) {
    return [...this.players.values()].filter((p) => p.team === team).sort((a, b) => a.num - b.num);
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.mx = clamp(+input.mx || 0, -1, 1);
    p.input.mz = clamp(+input.mz || 0, -1, 1);
    p.input.sprint = !!input.sprint;
    p.input.aim = +input.aim || 0;
  }

  // kind: shoot | pass | chip | flick | tackle ; power 0..1
  queueAction(id, kind, power = 0.5, aim, target = null) {
    const p = this.players.get(id);
    if (!p) return;
    if (kind === 'call') { this.callForPass(p); return; }
    if (!['shoot', 'pass', 'chip', 'flick', 'tackle'].includes(kind)) return;
    if (typeof target !== 'string') target = null;
    p.actions = p.actions.filter((a) => a.kind !== kind);
    p.actions.push({ kind, power: clamp(+power || 0, 0, 1), aim: aim ?? p.input.aim, t: C.actionBuffer, target });
  }

  // A player asks for the ball. Bot teammates on the ball respond by passing.
  callForPass(p) {
    if (this.phase !== 'play' || p.callCd > 0) return;
    p.callT = 2.2;
    p.callCd = 1.2;
    this.events.push({ k: 'call', id: p.id, team: p.team });
  }

  pause(byName = '') {
    if (this.phase === 'paused' || this.phase === 'lobby' || this.phase === 'ended') return false;
    this.pausedFrom = { phase: this.phase, t: this.phaseT };
    this.pausedBy = byName;
    this.phase = 'paused';
    for (const p of this.players.values()) { p.vx = 0; p.vz = 0; p.actions = []; }
    this.events.push({ k: 'paused', by: byName });
    return true;
  }

  resume(byName = '') {
    if (this.phase !== 'paused') return false;
    const from = this.pausedFrom || { phase: 'play', t: 0 };
    if (from.phase === 'goal') { this.phase = 'goal'; this.phaseT = from.t; }
    else if (from.phase === 'shootout') { this.phase = 'shootout'; }
    else { this.phase = 'countdown'; this.phaseT = from.phase === 'countdown' ? Math.max(from.t, 1) : C.countdown; }
    this.pausedFrom = null;
    this.events.push({ k: 'resumed', by: byName });
    return true;
  }

  start(durationSec) {
    const maxTeam = Math.max(this.teamList(0).length, this.teamList(1).length, 1);
    this.field = fieldForTeamSize(maxTeam);
    this.duration = durationSec;
    this.timeLeft = durationSec;
    this.score = [0, 0];
    this.so = null;
    for (const p of this.players.values()) p.goals = 0;
    this.kickoffTeam = Math.random() < 0.5 ? 0 : 1;
    this.resetKickoff();
    this.events.push({ k: 'start' });
  }

  resetKickoff() {
    this.ball = { x: 0, y: C.ballRadius, z: 0, vx: 0, vy: 0, vz: 0 };
    this.owner = null;
    this.holder = null;
    this.refreshKeepers();
    for (const p of this.players.values()) this.placeAtSpot(p);
    this.phase = 'countdown';
    this.phaseT = C.countdown;
  }

  // Formation spot for a player (in their own half). Bots take goalkeeper
  // duty when a team has 3+ players.
  formation(team) {
    const list = this.teamList(team);
    const n = list.length;
    const f = this.field;
    const dir = team === 0 ? -1 : 1; // own half sign
    const spots = new Map();
    let outfield = list;
    // A human who picked goalkeeper always gets the spot; otherwise a bot
    // keeps goal once the team has 3+ players.
    const humanGK = list.find((p) => p.gk && !p.bot) || null;
    if (humanGK || n >= 3) {
      const gk = humanGK || list.find((p) => p.bot) || null;
      if (gk) {
        spots.set(gk.id, { x: dir * (f.L / 2 - 1.6), z: 0, gk: true });
        outfield = list.filter((p) => p !== gk);
      }
    }
    const m = outfield.length;
    // Rows from defence to attack.
    const rows = m <= 2 ? 1 : m <= 4 ? 2 : 3;
    const perRow = [];
    let left = m;
    for (let r = 0; r < rows; r++) {
      const k = Math.ceil(left / (rows - r));
      perRow.push(k);
      left -= k;
    }
    let i = 0;
    for (let r = 0; r < rows; r++) {
      const depth = rows === 1 ? 0.32 : 0.62 - (r / (rows - 1)) * 0.5; // fraction of half length
      const k = perRow[r];
      for (let j = 0; j < k; j++) {
        const p = outfield[i++];
        const zFrac = k === 1 ? 0 : (j / (k - 1) - 0.5) * (k === 2 ? 0.4 : 0.7);
        spots.set(p.id, { x: dir * depth * (f.L / 2), z: zFrac * f.W, gk: false, row: r, rows });
      }
    }
    return spots;
  }

  placeAtSpot(p) {
    const s = this.formation(p.team).get(p.id) || { x: 0, z: 0 };
    p.x = s.x; p.z = s.z; p.vx = 0; p.vz = 0;
    // Kickoff team: nearest attacker steps up to the ball.
    p.yaw = p.team === 0 ? Math.PI / 2 : -Math.PI / 2;
    p.actions = [];
    p.tackleT = 0; p.stunT = 0; p.diveT = 0;
    if (p.holding) { p.holding = false; if (this.holder === p.id) this.holder = null; }
  }

  frozen() {
    return this.phase === 'countdown' || this.phase === 'ended' || this.phase === 'lobby' || this.phase === 'paused';
  }

  step(dt) {
    if (this.phase === 'lobby' || this.phase === 'ended' || this.phase === 'paused') return;
    if (this.phase === 'shootout') { this.stepShootout(dt); return; }

    if (this.phase === 'countdown') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'play'; this.events.push({ k: 'whistle' }); }
    } else if (this.phase === 'goal') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        if (this.timeLeft <= 0) this.endMatch();
        else this.resetKickoff();
        return;
      }
    } else if (this.phase === 'play') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this.timeLeft = 0; this.endMatch(); return; }
    }

    const frozen = this.frozen();
    this.refreshKeepers();
    if (this.phase !== 'play' && this.holder) this.dropBall(this.players.get(this.holder));

    for (const p of this.players.values()) {
      p.callT = Math.max(0, p.callT - dt);
      p.callCd = Math.max(0, p.callCd - dt);
      if (p.bot && !frozen) {
        p.ai.t -= dt;
        const think = p.ai.t <= 0;
        if (think) p.ai.t = this.skillOf(p.team).think * (0.8 + Math.random() * 0.4);
        this.botThink(p, dt, think);
      }
      p.kickCd = Math.max(0, p.kickCd - dt);
      p.tackleCd = Math.max(0, p.tackleCd - dt);
      p.tackleT = Math.max(0, p.tackleT - dt);
      p.stunT = Math.max(0, p.stunT - dt);
      p.diveT = Math.max(0, p.diveT - dt);
      p.diveCd = Math.max(0, p.diveCd - dt);
      if (p.holding) {
        p.holdT += dt;
        if (p.holdT > C.maxHold) this.release(p, { kind: 'flick', aim: p.yaw, power: 0 });
      }
      integratePlayerMovement(p, p.input, dt, {
        frozen, field: this.field,
        speedMul: p.bot ? this.skillOf(p.team).speed : 1,
        box: p.holding ? ownBox(this.field, p.team) : null,
      });
    }

    this.collidePlayers();
    if (this.phase === 'play') this.handleBallControl(dt);
    else this.owner = null;
    this.stepBall(dt);
  }

  collidePlayers() {
    const arr = [...this.players.values()];
    const minD = C.playerRadius * 2;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < minD && d > 1e-4) {
          const push = (minD - d) / 2;
          const nx = dx / d, nz = dz / d;
          a.x -= nx * push; a.z -= nz * push;
          b.x += nx * push; b.z += nz * push;
          // Tackles stun opponents on contact.
          if (a.tackleT > 0 && b.team !== a.team && b.stunT <= 0) { b.stunT = C.stunTime; this.events.push({ k: 'tackle', id: a.id }); }
          if (b.tackleT > 0 && a.team !== b.team && a.stunT <= 0) { a.stunT = C.stunTime; this.events.push({ k: 'tackle', id: b.id }); }
        }
      }
    }
  }

  handleBallControl(dt) {
    const b = this.ball;
    const holder = this.holder && this.players.get(this.holder);
    // Find closest eligible player for dribble control.
    let best = null, bestD = Infinity;
    for (const p of this.players.values()) {
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      p._bd = d;
      if (d < bestD && p.stunT <= 0 && p.kickCd <= 0) { best = p; bestD = d; }
    }

    // Actions (buffered so a slightly early press still works).
    for (const p of this.players.values()) {
      for (const a of p.actions) a.t -= dt;
      p.actions = p.actions.filter((a) => a.t > 0);
      if (!p.actions.length) continue;

      // Keeper holding the ball: any kick button releases it.
      if (p.holding) {
        const a = p.actions.find((x) => x.kind !== 'tackle');
        p.actions = [];
        if (a) this.release(p, a);
        continue;
      }

      const ti = p.actions.findIndex((a) => a.kind === 'tackle');
      // Keepers dive instead of tackling when in their own area.
      if (ti >= 0 && p.isGK && p.diveCd <= 0 && p.stunT <= 0 && inBox(ownBox(this.field, p.team), p.x, p.z)) {
        const a = p.actions[ti];
        p.actions.splice(ti, 1);
        let dx = p.input.mx, dz = p.input.mz;
        if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(a.aim); dz = Math.cos(a.aim); }
        const l = Math.hypot(dx, dz) || 1;
        p.vx = (dx / l) * C.diveSpeed; p.vz = (dz / l) * C.diveSpeed;
        p.diveT = C.diveTime; p.diveCd = C.diveCooldown;
        this.events.push({ k: 'dive', id: p.id });
      } else if (ti >= 0 && p.tackleCd <= 0 && p.stunT <= 0) {
        const a = p.actions[ti];
        p.actions.splice(ti, 1);
        let dx = p.input.mx, dz = p.input.mz;
        if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(a.aim); dz = Math.cos(a.aim); }
        const l = Math.hypot(dx, dz);
        p.vx = (dx / l) * C.tackleSpeed; p.vz = (dz / l) * C.tackleSpeed;
        p.tackleT = C.tackleTime; p.tackleCd = C.tackleCooldown;
        this.events.push({ k: 'lunge', id: p.id });
      }

      if (p.kickCd > 0 || p.stunT > 0 || holder) continue;
      if (p._bd > C.kickRange || b.y > 1.7) continue;
      const a = p.actions.find((x) => x.kind !== 'tackle');
      if (!a) continue;
      p.actions = p.actions.filter((x) => x !== a);
      this.kick(p, a);
    }

    if (holder) { this.owner = holder.id; return; }

    // Goalkeepers catch the ball in their own area.
    for (const p of this.players.values()) {
      if (!p.isGK || p.kickCd > 0 || p.stunT > 0) continue;
      if (!inBox(ownBox(this.field, p.team), p.x, p.z)) continue;
      const reach = p.diveT > 0 ? C.diveReach : C.catchReach;
      if (p._bd < reach && b.y < (p.diveT > 0 ? 2.5 : 2.6)) {
        this.catchBall(p);
        return;
      }
    }

    // Tackle knocks the ball.
    for (const p of this.players.values()) {
      if (p.tackleT > 0 && p._bd < C.playerRadius + C.ballRadius + 0.35 && b.y < 1) {
        const sp = Math.hypot(p.vx, p.vz) || 1;
        b.vx = (p.vx / sp) * 11; b.vz = (p.vz / sp) * 11; b.vy = 1.5;
        this.touch(p);
        p.tackleT = 0;
      }
    }

    // Dribble control (not by someone who just kicked it this frame).
    this.owner = null;
    if (best && best.kickCd <= 0 && bestD < C.controlRange && b.y < 0.9 && best.tackleT <= 0) {
      const p = best;
      const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
      const rel = Math.hypot(rvx, rvz);
      if (rel < 16) {
        this.owner = p.id;
        const sp = Math.hypot(p.vx, p.vz);
        let fx, fz;
        if (sp > 0.8) { fx = p.vx / sp; fz = p.vz / sp; }
        else { fx = Math.sin(p.yaw); fz = Math.cos(p.yaw); }
        const lead = 0.85 + Math.min(sp, 10) * 0.035;
        const tx = p.x + fx * lead, tz = p.z + fz * lead;
        const k = 14;
        const wantVx = p.vx + (tx - b.x) * k * 0.6;
        const wantVz = p.vz + (tz - b.z) * k * 0.6;
        const blend = Math.min(1, k * dt);
        b.vx += (wantVx - b.vx) * blend;
        b.vz += (wantVz - b.vz) * blend;
        if (b.vy > 0) b.vy *= 0.5;
        this.touch(p, true);
      }
    }
  }

  catchBall(p) {
    p.holding = true;
    p.holdT = 0;
    p.diveT = 0;
    p.actions = [];
    this.holder = p.id;
    this.owner = p.id;
    const speed = Math.hypot(this.ball.vx, this.ball.vy, this.ball.vz);
    this.touch(p);
    this.pinBall();
    this.events.push({ k: 'save', id: p.id, team: p.team, big: speed > 14 });
  }

  pinBall() {
    const p = this.players.get(this.holder);
    if (!p) { this.holder = null; return; }
    const b = this.ball;
    b.x = p.x + Math.sin(p.yaw) * 0.45;
    b.z = p.z + Math.cos(p.yaw) * 0.45;
    b.y = 1.15;
    b.vx = p.vx; b.vz = p.vz; b.vy = 0;
  }

  dropBall(p) {
    if (!p) { this.holder = null; return; }
    p.holding = false;
    if (this.holder === p.id) this.holder = null;
    this.ball.y = Math.max(this.ball.y, C.ballRadius);
  }

  // Keeper throws, punts or rolls the ball out.
  release(p, a) {
    const b = this.ball;
    let aim = a.aim;
    let vx, vy, vz, kind;
    if (a.kind === 'pass') {
      kind = 'throw';
      const tgt = a.target && this.players.get(a.target);
      const mate = tgt && tgt.team === p.team && tgt !== p ? tgt : pickPassTarget(this.players.values(), p, aim);
      if (mate) aim = Math.atan2(mate.x + mate.vx * 0.4 - p.x, mate.z + mate.vz * 0.4 - p.z);
      const d = mate ? Math.hypot(mate.x - p.x, mate.z - p.z) : 16;
      const sp = clamp(8 + d * 0.5, 10, 22);
      vx = Math.sin(aim) * sp; vz = Math.cos(aim) * sp; vy = d > 18 ? 4.5 : 1.8;
    } else if (a.kind === 'shoot') {
      kind = 'punt';
      const sp = 17 + 13 * a.power;
      vx = Math.sin(aim) * sp; vz = Math.cos(aim) * sp; vy = 8 + 4 * a.power;
    } else if (a.kind === 'chip') {
      kind = 'lob';
      const sp = 13 + 5 * a.power;
      vx = Math.sin(aim) * sp; vz = Math.cos(aim) * sp; vy = 10;
    } else {
      kind = 'roll';
      vx = Math.sin(aim) * 5; vz = Math.cos(aim) * 5; vy = 0;
    }
    p.holding = false;
    this.holder = null;
    b.x = p.x + Math.sin(aim) * 0.8;
    b.z = p.z + Math.cos(aim) * 0.8;
    b.y = kind === 'roll' ? C.ballRadius : 1.2;
    b.vx = vx; b.vy = vy; b.vz = vz;
    p.kickCd = 0.5;
    this.lastKicker = p.id;
    this.owner = null;
    this.touch(p);
    this.events.push({ k: 'kick', id: p.id, kind, power: a.power || 0.5 });
  }

  touch(p, quiet = false) {
    if (!quiet || this.lastTouch !== p.id) this.lastTouch = p.id;
  }

  kick(p, a) {
    const b = this.ball;
    const ax = Math.sin(a.aim), az = Math.cos(a.aim);
    let vx, vy, vz;
    switch (a.kind) {
      case 'shoot': {
        const pw = a.power;
        const sp = 13 + 21 * pw;
        const aim = this.phase === 'shootout' ? a.aim : this.assistShotAim(p, a.aim);
        const ax = Math.sin(aim), az = Math.cos(aim);
        vx = ax * sp; vz = az * sp; vy = 1.2 + 3.2 * pw;
        break;
      }
      case 'chip': {
        const sp = 11 + 9 * a.power;
        vx = ax * sp; vz = az * sp; vy = 7.5 + 3 * a.power;
        break;
      }
      case 'pass': {
        const tgt = a.target && this.players.get(a.target);
        const mate = tgt && tgt.team === p.team && tgt !== p ? tgt : pickPassTarget(this.players.values(), p, a.aim);
        if (mate) {
          const tx = mate.x + mate.vx * 0.45, tz = mate.z + mate.vz * 0.45;
          const dx = tx - b.x, dz = tz - b.z;
          const d = Math.hypot(dx, dz) || 1;
          const sp = clamp(7 + d * 0.62, 10, 26);
          vx = (dx / d) * sp; vz = (dz / d) * sp; vy = d > 22 ? 4 : 0.6;
        } else {
          vx = ax * 15; vz = az * 15; vy = 0.6;
        }
        break;
      }
      case 'flick': {
        // Rainbow flick: ball rolls up the back of the leg and arcs over the head.
        const sp = Math.hypot(p.vx, p.vz);
        let fx = sp > 0.5 ? p.vx / sp : Math.sin(p.yaw);
        let fz = sp > 0.5 ? p.vz / sp : Math.cos(p.yaw);
        b.x = p.x - fx * 0.4; b.z = p.z - fz * 0.4; b.y = 0.6;
        vx = fx * (6.5 + sp * 0.6); vz = fz * (6.5 + sp * 0.6); vy = 9.5;
        break;
      }
      default: return;
    }
    b.vx = vx; b.vy = vy; b.vz = vz;
    p.kickCd = a.kind === 'flick' ? 0.55 : 0.32;
    this.lastKicker = p.id;
    this.owner = null;
    this.touch(p);
    this.events.push({ k: 'kick', id: p.id, kind: a.kind, power: a.power });
  }

  // Gentle aim assist: shots roughly at the opponent goal are pulled inside the posts.
  assistShotAim(p, aim) {
    const f = this.field;
    const gx = p.team === 0 ? f.L / 2 : -f.L / 2;
    const dx = gx - this.ball.x;
    if (Math.abs(dx) > 40 || Math.sign(dx) !== Math.sign(Math.sin(aim)) || Math.abs(Math.sin(aim)) < 0.2) return aim;
    // Where would the shot cross the goal line?
    const zAt = this.ball.z + (dx / Math.sin(aim)) * Math.cos(aim);
    const lim = f.goalW / 2 - 0.5;
    const miss = Math.abs(zAt) - lim;
    if (miss <= 0 || miss > 6) return aim; // on target already, or clearly aimed elsewhere
    const tz = Math.sign(zAt) * (lim - 0.2);
    const fixed = Math.atan2(dx, tz - this.ball.z);
    const t = 1 - miss / 6; // stronger assist the closer the aim was
    return aim + wrapAngle(fixed - aim) * t;
  }

  findPassTarget(p, aim) {
    return pickPassTarget(this.players.values(), p, aim);
  }

  stepBall(dt) {
    const b = this.ball;
    const f = this.field;
    const r = C.ballRadius;
    if (this.holder) { this.pinBall(); if (this.holder) return; }
    const sub = 4;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      b.vy -= C.gravity * h;
      b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;

      // Ground.
      if (b.y < r) {
        b.y = r;
        if (b.vy < -2) b.vy = -b.vy * 0.55; else b.vy = 0;
      }
      const onGround = b.y <= r + 0.01;
      const fr = onGround ? 0.75 : 0.06;
      const damp = Math.max(0, 1 - fr * h);
      b.vx *= damp; b.vz *= damp;
      if (onGround && Math.hypot(b.vx, b.vz) < 0.05) { b.vx = 0; b.vz = 0; }

      // Side boards.
      if (b.z > f.W / 2 - r) { b.z = f.W / 2 - r; b.vz = -Math.abs(b.vz) * 0.7; }
      if (b.z < -f.W / 2 + r) { b.z = -f.W / 2 + r; b.vz = Math.abs(b.vz) * 0.7; }

      for (const side of [1, -1]) this.goalCollide(b, side);

      // Player bodies.
      for (const p of this.players.values()) {
        if (b.y > 1.9) continue;
        if (p.id === this.lastKicker && p.kickCd > 0) continue;
        const dx = b.x - p.x, dz = b.z - p.z;
        const d = Math.hypot(dx, dz);
        const minD = C.playerRadius + r;
        if (d < minD && d > 1e-4) {
          const nx = dx / d, nz = dz / d;
          b.x = p.x + nx * minD; b.z = p.z + nz * minD;
          const rvx = b.vx - p.vx, rvz = b.vz - p.vz;
          const vn = rvx * nx + rvz * nz;
          if (vn < 0) {
            const bounce = this.owner === p.id ? 0.0 : 0.45;
            b.vx -= (1 + bounce) * vn * nx;
            b.vz -= (1 + bounce) * vn * nz;
            if (this.owner !== p.id) this.touch(p);
          }
        }
      }

      if (this.phase === 'play') this.checkGoal();
    }
  }

  goalCollide(b, side) {
    const f = this.field;
    const r = C.ballRadius;
    const lineX = side * f.L / 2;
    const inMouthZ = Math.abs(b.z) < f.goalW / 2;
    const beyond = side * b.x > f.L / 2 - r;
    const inGoalBox = side * b.x > f.L / 2 && Math.abs(b.z) < f.goalW / 2 + 0.2 && b.y < f.goalH + 0.2;

    if (beyond && !(inMouthZ && b.y < f.goalH - r) && !inGoalBox) {
      // End boards (outside the goal mouth, or above the crossbar).
      b.x = lineX - side * r;
      b.vx = -side * Math.abs(b.vx) * 0.7;
    }
    if (inGoalBox || (side * b.x > f.L / 2 - r && inMouthZ && b.y < f.goalH)) {
      // Net: back, sides, roof.
      const back = f.L / 2 + f.goalD - r;
      if (side * b.x > back) { b.x = side * back; b.vx *= -0.15; b.vz *= 0.5; }
      if (side * b.x > f.L / 2) {
        const sideLim = f.goalW / 2 - r;
        if (b.z > sideLim) { b.z = sideLim; b.vz = -Math.abs(b.vz) * 0.2; }
        if (b.z < -sideLim) { b.z = -sideLim; b.vz = Math.abs(b.vz) * 0.2; }
        if (b.y > f.goalH - r) { b.y = f.goalH - r; b.vy = -Math.abs(b.vy) * 0.2; }
      }
    }

    // Posts.
    for (const pz of [f.goalW / 2, -f.goalW / 2]) {
      if (b.y > f.goalH + r) continue;
      const dx = b.x - lineX, dz = b.z - pz;
      const d = Math.hypot(dx, dz);
      const minD = r + C.postRadius;
      if (d < minD && d > 1e-4) {
        const nx = dx / d, nz = dz / d;
        b.x = lineX + nx * minD; b.z = pz + nz * minD;
        const vn = b.vx * nx + b.vz * nz;
        if (vn < 0) { b.vx -= 1.75 * vn * nx; b.vz -= 1.75 * vn * nz; this.events.push({ k: 'post' }); }
      }
    }
    // Crossbar.
    if (Math.abs(b.z) < f.goalW / 2) {
      const dx = b.x - lineX, dy = b.y - f.goalH;
      const d = Math.hypot(dx, dy);
      const minD = r + C.postRadius;
      if (d < minD && d > 1e-4) {
        const nx = dx / d, ny = dy / d;
        b.x = lineX + nx * minD; b.y = f.goalH + ny * minD;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= 1.75 * vn * nx; b.vy -= 1.75 * vn * ny; this.events.push({ k: 'post' }); }
      }
    }
  }

  checkGoal() {
    const b = this.ball, f = this.field;
    for (const side of [1, -1]) {
      if (side * b.x > f.L / 2 + C.ballRadius && Math.abs(b.z) < f.goalW / 2 && b.y < f.goalH) {
        const scoringTeam = side === 1 ? 0 : 1;
        this.score[scoringTeam]++;
        const scorer = this.players.get(this.lastTouch);
        let own = false;
        if (scorer) {
          if (scorer.team === scoringTeam) scorer.goals++;
          else own = true;
        }
        this.events.push({ k: 'goal', team: scoringTeam, scorer: scorer ? scorer.name : '', own, score: [...this.score] });
        this.phase = 'goal';
        this.phaseT = C.goalPause;
        this.kickoffTeam = 1 - scoringTeam;
        return;
      }
    }
  }

  endMatch() {
    // Level at full time: settle it with free kicks.
    if (this.tiebreak && !this.so && this.score[0] === this.score[1]
        && this.teamList(0).length && this.teamList(1).length) {
      this.startShootout();
      return;
    }
    this.phase = 'ended';
    const scorers = [...this.players.values()].filter((p) => p.goals > 0)
      .sort((a, b) => b.goals - a.goals).map((p) => ({ name: p.name, goals: p.goals, team: p.team }));
    this.events.push({ k: 'end', score: [...this.score], scorers, so: this.so ? [...this.so.goals] : null });
  }

  // ---------- Free-kick shootout (tie breaker) ----------
  // Teams alternate free kicks from a spot in front of the +x goal; five each,
  // then sudden death. The other team's keeper defends.
  startShootout() {
    this.phase = 'shootout';
    this.holder = null;
    this.owner = null;
    for (const p of this.players.values()) p.holding = false;
    const first = Math.random() < 0.5 ? 0 : 1;
    this.so = { kicks: [[], []], goals: [0, 0], turn: first, order: [0, 0], stage: 'ready', t: 0, kicker: null, keeper: null, result: null };
    this.events.push({ k: 'shootout', first });
    this.setupKick();
  }

  shootoutKickers(team) {
    const list = this.teamList(team);
    const keeper = this.shootoutKeeper(team);
    const field = list.length > 1 ? list.filter((p) => p !== keeper) : list;
    return [...field.filter((p) => !p.bot), ...field.filter((p) => p.bot)];
  }

  shootoutKeeper(team) {
    const list = this.teamList(team);
    return list.find((p) => p.gk && !p.bot) || list.find((p) => p.isGK) || list.find((p) => p.bot) || list[0];
  }

  setupKick() {
    const so = this.so, f = this.field;
    const kt = so.turn;
    const kickers = this.shootoutKickers(kt);
    const kicker = kickers[so.order[kt] % kickers.length];
    const keeper = this.shootoutKeeper(1 - kt);
    if (!kicker || !keeper) { this.finishShootout(); return; }
    so.kicker = kicker.id;
    so.keeper = keeper.id;
    so.stage = 'ready';
    so.t = 2.2;
    so.result = null;
    const spotX = shootoutSpotX(f);
    this.ball = { x: spotX, y: C.ballRadius, z: 0, vx: 0, vy: 0, vz: 0 };
    const others = [...this.players.values()].filter((p) => p !== kicker && p !== keeper);
    const idx = [0, 0];
    for (const p of this.players.values()) {
      p.vx = 0; p.vz = 0; p.actions = []; p.diveT = 0; p.tackleT = 0; p.stunT = 0; p.kickCd = 0; p.holding = false;
      if (p.ai) p.ai.diveAt = null;
    }
    kicker.x = spotX - 1.3; kicker.z = 0; kicker.yaw = Math.PI / 2;
    keeper.x = f.L / 2 - 0.6; keeper.z = 0; keeper.yaw = -Math.PI / 2;
    for (const p of others) {
      const i = idx[p.team]++;
      p.x = -4 + (i % 5) * 1.6;
      p.z = (p.team === 0 ? -1 : 1) * (5 + Math.floor(i / 5) * 1.6);
      p.yaw = Math.PI / 2;
    }
    this.events.push({ k: 'so_setup', kicker: kicker.id, keeper: keeper.id, team: kt });
  }

  stepShootout(dt) {
    const so = this.so, f = this.field, b = this.ball;
    so.t -= dt;
    const kicker = this.players.get(so.kicker);
    const keeper = this.players.get(so.keeper);
    if (!kicker || !keeper) { this.setupKick(); return; }

    for (const p of this.players.values()) {
      p.kickCd = Math.max(0, p.kickCd - dt);
      p.diveT = Math.max(0, p.diveT - dt);
      p.diveCd = Math.max(0, p.diveCd - dt);
      p.callT = 0;
      if (p !== keeper) { p.vx = 0; p.vz = 0; }
    }
    // Kicker turns to face where they're aiming.
    if (so.stage === 'aim' && !kicker.bot) kicker.yaw = kicker.input.aim || Math.PI / 2;

    // Keeper moves along the line (once the kicker is ready) and can dive.
    const canMove = so.stage === 'aim' || so.stage === 'flight';
    if (keeper.bot && canMove) this.botKeeperShootout(keeper, dt);
    integratePlayerMovement(keeper, keeper.input, dt, {
      frozen: !canMove, field: f, box: shootoutKeeperBox(f),
    });
    if (canMove) {
      const di = keeper.actions.findIndex((a) => a.kind === 'tackle');
      if (di >= 0 && keeper.diveCd <= 0) this.doDive(keeper, keeper.actions[di].aim);
    }
    for (const p of this.players.values()) if (p !== kicker || so.stage !== 'aim') p.actions = [];

    if (so.stage === 'ready') {
      if (so.t <= 0) { so.stage = 'aim'; so.t = 10; this.events.push({ k: 'whistle' }); }
      return;
    }

    if (so.stage === 'aim') {
      let a = null;
      if (kicker.bot) {
        if (so.t < 8.6 - Math.random() * 0.8) {
          const sk = this.skillOf(kicker.team);
          const r = Math.random();
          const tz = r < 0.15 ? 0 : (Math.random() < 0.5 ? -1 : 1) * (f.goalW / 2 - 0.55 - Math.random() * 0.6);
          const aim = Math.atan2(f.L / 2 - b.x, tz - b.z) + (Math.random() - 0.5) * 2 * sk.aimErr * 0.6;
          a = { kind: 'shoot', power: 0.6 + Math.random() * 0.35, aim };
        }
      } else {
        for (const x of kicker.actions) x.t -= dt;
        a = kicker.actions.find((x) => x.kind === 'shoot' || x.kind === 'chip' || x.kind === 'pass');
        if (a && a.kind === 'pass') a = { ...a, kind: 'shoot', power: 0.45 };
        kicker.actions = [];
      }
      if (a) {
        kicker.x = b.x - Math.sin(a.aim) * 0.8;
        kicker.z = b.z - Math.cos(a.aim) * 0.8;
        this.kick(kicker, a);
        so.stage = 'flight';
        so.t = 3.5;
        if (keeper.bot) this.planBotDive(keeper);
      } else if (so.t <= 0) {
        this.shootoutResult('miss');
      }
      return;
    }

    if (so.stage === 'flight') {
      const vxBefore = b.vx;
      this.stepBall(dt);
      // Ball blocked by the keeper's body (bounced back off them) = save.
      if (vxBefore > 0 && b.vx <= 0 && Math.hypot(b.x - keeper.x, b.z - keeper.z) < 1.6) {
        this.events.push({ k: 'save', id: keeper.id, team: keeper.team, big: true });
        this.shootoutResult('save');
        return;
      }
      // Keeper save.
      // Smaller reach than in open play so well-placed kicks beat the keeper.
      const reach = keeper.diveT > 0 ? 1.15 : 0.9;
      if (Math.hypot(b.x - keeper.x, b.z - keeper.z) < reach && b.y < 2.3 && keeper.kickCd <= 0) {
        b.vx = -Math.abs(b.vx) * 0.25 - 2; b.vz *= 0.3; b.vy = Math.abs(b.vy) * 0.3 + 1;
        this.events.push({ k: 'save', id: keeper.id, team: keeper.team, big: true });
        this.shootoutResult('save');
        return;
      }
      if (b.x > f.L / 2 + C.ballRadius && Math.abs(b.z) < f.goalW / 2 && b.y < f.goalH) { this.shootoutResult('goal'); return; }
      const slow = Math.hypot(b.vx, b.vz) < 0.8 && b.y < C.ballRadius + 0.05;
      if (so.t <= 0 || slow || b.x < shootoutSpotX(f) - 3 || (b.x > f.L / 2 - 0.5 && Math.abs(b.z) >= f.goalW / 2 + 0.3)) {
        this.shootoutResult('miss');
      }
      return;
    }

    if (so.stage === 'result') {
      this.stepBall(dt);
      if (so.t <= 0) this.nextKick();
    }
  }

  doDive(p, aim) {
    let dx = p.input.mx, dz = p.input.mz;
    if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(aim); dz = Math.cos(aim); }
    const l = Math.hypot(dx, dz) || 1;
    p.vx = (dx / l) * C.diveSpeed; p.vz = (dz / l) * C.diveSpeed;
    p.diveT = C.diveTime; p.diveCd = C.diveCooldown;
    this.events.push({ k: 'dive', id: p.id });
  }

  planBotDive(keeper) {
    const b = this.ball, f = this.field;
    const sk = this.skillOf(keeper.team);
    const level = this.botSkill[keeper.team] | 0;
    const tLine = b.vx > 0.1 ? (f.L / 2 - 0.6 - b.x) / b.vx : 1;
    const zAt = b.z + b.vz * tLine;
    const guess = Math.random() < 0.25 + level * 0.1;
    let dir = guess ? Math.sign(zAt - keeper.z) : (Math.random() < 0.5 ? -1 : 1);
    if (guess && Math.abs(zAt) < 1.1) dir = 0;
    keeper.ai.diveAt = this.so.t - (0.18 + sk.think * 1.5);
    keeper.ai.diveDir = dir;
  }

  botKeeperShootout(keeper) {
    const ai = keeper.ai;
    keeper.input.sprint = false;
    keeper.input.mx = 0; keeper.input.mz = 0;
    if (this.so.stage === 'flight' && ai.diveAt != null && this.so.t <= ai.diveAt) {
      if (ai.diveDir) {
        keeper.input.mz = ai.diveDir;
        this.doDive(keeper, 0);
        keeper.input.mz = 0;
      }
      ai.diveAt = null;
    }
  }

  shootoutResult(result) {
    const so = this.so;
    so.result = result;
    so.stage = 'result';
    so.t = 2;
    const scored = result === 'goal';
    so.kicks[so.turn].push(scored ? 1 : 0);
    if (scored) so.goals[so.turn]++;
    const kicker = this.players.get(so.kicker);
    this.events.push({ k: 'so_kick', team: so.turn, result, kicker: kicker ? kicker.name : '', goals: [...so.goals] });
  }

  shootoutDecided() {
    const so = this.so;
    const [n0, n1] = [so.kicks[0].length, so.kicks[1].length];
    const [g0, g1] = so.goals;
    if (n0 <= 5 && n1 <= 5) {
      if (g0 + (5 - n0) < g1 || g1 + (5 - n1) < g0) return true;
      if (n0 === 5 && n1 === 5) return g0 !== g1;
      return false;
    }
    return n0 === n1 && g0 !== g1; // sudden death
  }

  nextKick() {
    const so = this.so;
    so.order[so.turn]++;
    if (this.shootoutDecided() || so.kicks[0].length >= 30) { this.finishShootout(); return; }
    so.turn = 1 - so.turn;
    this.setupKick();
  }

  finishShootout() {
    const so = this.so;
    if (so.goals[0] === so.goals[1]) so.goals[Math.random() < 0.5 ? 0 : 1]++; // safety: never a draw
    this.events.push({ k: 'so_end', goals: [...so.goals] });
    this.endMatch();
  }

  // ---------- Bots ----------
  botThink(p, dt, think) {
    const ai = p.ai;
    const b = this.ball, f = this.field;
    const attackX = p.team === 0 ? f.L / 2 : -f.L / 2;
    const ownX = -attackX;
    const dirX = Math.sign(attackX);

    if (think) {
      const sk = this.skillOf(p.team);
      const spots = this.formation(p.team);
      const spot = spots.get(p.id) || { x: 0, z: 0 };
      const mates = this.teamList(p.team);
      // Chaser: closest outfield player on the team to the ball.
      let chaser = null, cd = Infinity;
      for (const q of mates) {
        if (spots.get(q.id)?.gk) continue;
        const d = Math.hypot(b.x - q.x, b.z - q.z);
        if (d < cd) { cd = d; chaser = q; }
      }
      const myD = Math.hypot(b.x - p.x, b.z - p.z);
      ai.sprint = false;
      ai.action = null;

      if (spot.gk && p.holding) {
        // Hold briefly, then throw to a teammate (or a caller) or punt upfield.
        ai.tx = p.x; ai.tz = p.z;
        if (p.holdT > 0.9 + Math.random() * 0.6) {
          const caller = this.passCaller(p);
          const upfield = Math.atan2(dirX, (Math.random() - 0.5) * 1.2);
          const mate = caller || pickPassTarget(this.players.values(), p, upfield);
          if (mate && Math.random() < 0.75) {
            ai.action = { kind: 'pass', power: 0.5, aim: Math.atan2(mate.x - p.x, mate.z - p.z), target: mate.id };
          } else {
            ai.action = { kind: 'shoot', power: 0.7 + Math.random() * 0.3, aim: upfield };
          }
        }
      } else if (spot.gk) {
        const ballNearGoal = Math.abs(b.x - ownX) < 13 && Math.abs(b.z) < f.goalW + 6;
        if (ballNearGoal && myD < sk.gkReach) {
          ai.tx = b.x; ai.tz = b.z; ai.sprint = true;
        } else {
          ai.tx = ownX + dirX * 1.4;
          ai.tz = clamp(b.z * 0.35, -f.goalW / 2 + 0.6, f.goalW / 2 - 0.6);
        }
        if (myD < C.kickRange && b.y < 1.5 && !inBox(ownBox(f, p.team), p.x, p.z)) {
          const caller = this.passCaller(p);
          ai.action = caller && Math.random() < sk.passCall
            ? { kind: 'pass', power: 0.5, aim: Math.atan2(caller.x - p.x, caller.z - p.z), target: caller.id }
            : { kind: 'chip', power: 0.9, aim: Math.atan2(dirX, (Math.random() - 0.5) * 0.8) };
        }
      } else if (chaser === p) {
        const hasBall = this.owner === p.id || myD < C.controlRange;
        if (hasBall) {
          const gz = (Math.random() - 0.5) * f.goalW * 0.7;
          const gx = attackX;
          const toGoal = Math.hypot(gx - p.x, gz - p.z);
          const aim = Math.atan2(gx - p.x, gz - p.z) + (Math.random() - 0.5) * 2 * sk.aimErr;
          // Is an opponent blocking straight ahead?
          let pressured = false;
          for (const q of this.players.values()) {
            if (q.team === p.team) continue;
            const dx = q.x - p.x, dz = q.z - p.z;
            const d = Math.hypot(dx, dz);
            if (d < 3.2 && Math.abs(wrapAngle(Math.atan2(dx, dz) - aim)) < 0.9) pressured = true;
          }
          const caller = this.passCaller(p);
          if (caller && Math.random() < sk.passCall) {
            ai.action = { kind: 'pass', power: 0.5, aim: Math.atan2(caller.x - p.x, caller.z - p.z), target: caller.id };
            caller.callT = 0;
          } else if (toGoal < sk.shootRange && Math.random() < sk.shootChance) {
            ai.action = { kind: 'shoot', power: clamp(0.45 + toGoal / 40, 0.5, 1), aim };
          } else if (pressured && Math.random() < 0.5) {
            const fwdAim = Math.atan2(dirX, 0);
            if (this.findPassTarget(p, fwdAim)) ai.action = { kind: 'pass', power: 0.5, aim: fwdAim };
            else if (Math.random() < 0.15) ai.action = { kind: 'flick', power: 0.5, aim };
          }
          ai.tx = gx; ai.tz = p.z * 0.7; ai.sprint = toGoal > 15 && p.stamina > 0.4;
        } else {
          // Approach from behind the ball relative to the attacking goal.
          const gdx = attackX - b.x, gdz = -b.z;
          const gl = Math.hypot(gdx, gdz) || 1;
          const behind = myD > 2.5 ? 0.9 : 0.2;
          ai.tx = b.x + b.vx * 0.25 - (gdx / gl) * behind;
          ai.tz = b.z + b.vz * 0.25 - (gdz / gl) * behind;
          ai.sprint = myD > 6 && p.stamina > 0.3;
          // Tackle an opponent dribbler.
          const own = this.owner && this.players.get(this.owner);
          if (own && own.team !== p.team && myD < 2.4 && p.tackleCd <= 0 && Math.random() < sk.tackle) {
            ai.action = { kind: 'tackle', power: 0, aim: Math.atan2(b.x - p.x, b.z - p.z) };
          }
        }
      } else {
        // Hold shape, sliding with the ball.
        const push = clamp(b.x * 0.55, -f.L * 0.3, f.L * 0.3);
        ai.tx = clamp(spot.x + push, -f.L / 2 + 3, f.L / 2 - 3);
        ai.tz = clamp(spot.z + b.z * 0.3, -f.W / 2 + 2, f.W / 2 - 2);
        // Stay goal-side when defending.
        if (spot.row === 0 && dirX * (ai.tx - b.x) > 0 && dirX * b.x < 0) ai.tx = b.x - dirX * 4;
      }
      if (ai.action) this.queueAction(p.id, ai.action.kind, ai.action.power, ai.action.aim, ai.action.target);
    }

    const dx = ai.tx - p.x, dz = ai.tz - p.z;
    const d = Math.hypot(dx, dz);
    const slow = d < 1.2 ? d / 1.2 : 1;
    p.input.mx = d > 0.15 ? (dx / d) * slow : 0;
    p.input.mz = d > 0.15 ? (dz / d) * slow : 0;
    p.input.sprint = !!ai.sprint;
    p.input.aim = Math.atan2(attackX - p.x, -p.z);
  }

  // Nearest teammate currently calling for the ball (within passing range).
  passCaller(p) {
    let best = null, bd = 45;
    for (const q of this.players.values()) {
      if (q === p || q.team !== p.team || q.callT <= 0) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // ---------- Networking snapshot ----------
  snapshot() {
    const r2 = (v) => Math.round(v * 100) / 100;
    const b = this.ball;
    const owner = this.owner ? this.players.get(this.owner) : null;
    return {
      t: 's',
      ph: this.phase,
      pt: r2(this.phaseT),
      tl: r2(this.timeLeft),
      sc: this.score,
      o: owner ? owner.num : 0,
      b: [r2(b.x), r2(b.y), r2(b.z), r2(b.vx), r2(b.vy), r2(b.vz)],
      p: [...this.players.values()].map((p) => [
        p.num, r2(p.x), r2(p.z), r2(p.vx), r2(p.vz), r2(p.yaw),
        Math.round(p.stamina * 100), (p.tackleT > 0 ? 1 : 0) | (p.stunT > 0 ? 2 : 0) | (p.kickCd > 0.2 ? 4 : 0) | (p.callT > 0 ? 8 : 0)
          | (p.diveT > 0 ? 16 : 0) | (p.holding ? 32 : 0) | (p.isGK ? 64 : 0),
      ]),
      f: this.field,
      pb: this.phase === 'paused' ? this.pausedBy : undefined,
      so: this.so ? {
        k: this.so.kicks, g: this.so.goals, tu: this.so.turn, st: this.so.stage, r: this.so.result,
        ki: this.players.get(this.so.kicker)?.num || 0, ke: this.players.get(this.so.keeper)?.num || 0,
      } : undefined,
    };
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}
