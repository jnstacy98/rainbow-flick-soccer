// App glue: menus, lobby, hosting/joining, game loop, HUD.
import { Sim, TEAMS, MAX_PER_TEAM, integratePlayerMovement, fieldForTeamSize, C, ownBox, inBox, pickPassTarget, shootoutKeeperBox } from './sim.js';
import { Renderer } from './render.js';
import { Input, CAM_LABELS } from './input.js';
import { HostNet, ClientNet, normalizeCode } from './net.js';
import { sfx, unlockAudio, toggleMute, isMuted } from './audio.js';

const $ = (id) => document.getElementById(id);
const BOT_NAMES = ['Rio', 'Kai', 'Nova', 'Zed', 'Pip', 'Juno', 'Ace', 'Milo', 'Sky', 'Bea', 'Remy', 'Tex', 'Ivy', 'Oz', 'Lux', 'Fin', 'Dot', 'Max'];
const SNAP_EVERY = 3; // sim steps per snapshot (60Hz / 3 = 20Hz)
const INTERP_MS = 110;

const app = {
  role: null, // 'host' | 'client' | 'local'
  screen: 'menu', // menu | lobby | game
  myId: null,
  code: null,
  settings: { duration: 300, fill: 0, skill: [1, 1], tiebreak: true },
  roster: [],
  inGame: false,
  paused: false,
  ended: false,
  sim: null,
  net: null,
  botCounter: 0,
  // Client-side state
  snaps: [],
  latest: null,
  clockOffset: null,
  pred: null,
  rtt: 120,
  matchPhase: 'lobby',
  lastPhase: null,
  displayBall: null,
  field: fieldForTeamSize(4),
};

// ---------- Setup ----------
const canvas = $('game');
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  $('loading').textContent = 'Your browser could not start WebGL, which this game needs.';
  throw e;
}
renderer.setField(app.field);
const input = new Input(canvas);
if (input.isTouch) document.body.classList.add('touch');
$('loading').hidden = true;

try { $('nameInput').value = localStorage.getItem('rfs-name') || ''; } catch (e) { /* ignore */ }
const query = new URLSearchParams(location.search);
const invited = normalizeCode(query.get('join') || location.hash.replace('#', ''));
if (invited.length === 6) {
  $('codeInput').value = invited;
  $('inviteCodeText').textContent = invited;
  $('inviteBanner').hidden = false;
  if (!$('nameInput').value) $('nameInput').focus();
  else $('joinBtn').focus();
}

function playerName() {
  const n = $('nameInput').value.trim().replace(/\s+/g, ' ').slice(0, 14);
  try { localStorage.setItem('rfs-name', n); } catch (e) { /* ignore */ }
  return n || 'Player' + Math.floor(Math.random() * 90 + 10);
}

function setMsg(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function showScreen(name) {
  app.screen = name;
  $('menu').hidden = name !== 'menu';
  $('lobby').hidden = name !== 'lobby';
  $('hud').hidden = name !== 'game';
  $('touch').hidden = !(name === 'game' && input.isTouch);
  if (name !== 'game') {
    $('pause').hidden = true;
    $('end').hidden = true;
    app.paused = false;
    app.ended = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
  updateInputEnabled();
}

function updateInputEnabled() {
  input.enabled = app.screen === 'game' && !app.paused && !app.ended;
  if (!input.enabled) input.charging = false;
}

// ---------- Menu actions ----------
$('createBtn').onclick = async () => {
  unlockAudio(); sfx.click();
  const name = playerName();
  setMsg('menuMsg', 'Creating game…');
  setMenuBusy(true);
  const net = new HostNet();
  try {
    const code = await net.open();
    startHosting('host', name, net, code);
  } catch (e) {
    setMsg('menuMsg', e.message, true);
  } finally {
    setMenuBusy(false);
  }
};

$('practiceBtn').onclick = () => {
  unlockAudio(); sfx.click();
  startHosting('local', playerName(), null, null);
};

$('joinBtn').onclick = () => joinGame();
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
$('codeInput').addEventListener('input', (e) => { e.target.value = normalizeCode(e.target.value); });
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('codeInput').value.length === 6 ? joinGame() : $('createBtn').click());
});

function setMenuBusy(b) {
  for (const id of ['createBtn', 'joinBtn', 'practiceBtn']) $(id).disabled = b;
}

async function joinGame() {
  unlockAudio(); sfx.click();
  const code = normalizeCode($('codeInput').value);
  if (code.length !== 6) { setMsg('menuMsg', 'Enter the 6-character invite code.', true); return; }
  const name = playerName();
  setMsg('menuMsg', `Joining ${code}…`);
  setMenuBusy(true);
  const net = new ClientNet();
  try {
    const welcome = await net.connect(code, { t: 'hello', name });
    app.role = 'client';
    app.net = net;
    app.myId = welcome.you;
    app.code = code;
    app.snaps = [];
    app.latest = null;
    app.pred = null;
    app.clockOffset = null;
    net.onMessage = onClientMessage;
    net.onClose = (reason) => backToMenu(reason);
    setMsg('menuMsg', '');
    setLobbyChrome();
    showScreen('lobby');
    startPinging();
  } catch (e) {
    setMsg('menuMsg', e.message, true);
  } finally {
    setMenuBusy(false);
  }
}

function backToMenu(reason) {
  if (app.net) { try { app.net.close(); } catch (e) { /* ignore */ } }
  app.net = null;
  app.sim = null;
  app.role = null;
  app.inGame = false;
  renderer.clearPlayers();
  showScreen('menu');
  setMsg('menuMsg', reason || '', !!reason);
  if (location.search.includes('join=')) {
    const q = new URLSearchParams(location.search);
    q.delete('join');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }
  $('inviteBanner').hidden = true;
}

// ---------- Hosting ----------
function startHosting(role, name, net, code) {
  app.role = role;
  app.net = net;
  app.code = code;
  app.myId = 'host';
  app.sim = new Sim();
  app.settings = { duration: 300, fill: role === 'local' ? 3 : 0, skill: [1, 1], tiebreak: true };
  app.sim.addPlayer('host', name, 0, false);
  app.inGame = false;
  if (net) {
    net.onJoin = hostOnJoin;
    net.onMessage = hostOnMessage;
    net.onLeave = hostOnLeave;
  }
  rebalanceBots();
  setMsg('menuMsg', '');
  setLobbyChrome();
  showScreen('lobby');
  refreshLobby();
}

function humans(team) {
  return [...app.sim.players.values()].filter((p) => !p.bot && (team === undefined || p.team === team));
}

function hostOnJoin(peerId, msg) {
  const sim = app.sim;
  if (sim.players.has(peerId)) return;
  if (humans().length >= MAX_PER_TEAM * 2) {
    app.net.kick(peerId, { t: 'reject', reason: 'That game is full (9v9).' });
    return;
  }
  const name = String(msg.name || 'Player').replace(/[<>]/g, '').trim().slice(0, 14) || 'Player';
  const h0 = humans(0).length, h1 = humans(1).length;
  let team = h0 < h1 ? 0 : h1 < h0 ? 1 : (sim.teamList(0).length <= sim.teamList(1).length ? 0 : 1);
  if (humans(team).length >= MAX_PER_TEAM) team = 1 - team;
  sim.addPlayer(peerId, name, team, false);
  rebalanceBots();
  app.net.send(peerId, { t: 'welcome', you: peerId, code: app.code });
  refreshLobby();
  toast(`${name} joined ${TEAMS[team].name}`);
}

function hostOnLeave(peerId) {
  const p = app.sim && app.sim.players.get(peerId);
  if (!p) return;
  app.sim.removePlayer(peerId);
  rebalanceBots();
  refreshLobby();
  toast(`${p.name} left`);
}

function hostOnMessage(peerId, msg) {
  const sim = app.sim;
  if (!sim || !sim.players.has(peerId)) return;
  switch (msg.t) {
    case 'in': sim.setInput(peerId, { mx: msg.mx, mz: msg.mz, sprint: msg.sp, aim: msg.aim }); break;
    case 'act': sim.queueAction(peerId, msg.k, msg.p, typeof msg.aim === 'number' ? msg.aim : undefined, typeof msg.tg === 'string' ? msg.tg : null); break;
    case 'gk': setKeeper(peerId, !!msg.on); break;
    case 'team': switchTeam(peerId, msg.team); break;
    case 'pause': setMatchPaused(!!msg.on, sim.players.get(peerId).name); break;
    case 'ping': app.net.send(peerId, { t: 'pong', ts: msg.ts }); break;
  }
}

function switchTeam(id, team) {
  const sim = app.sim;
  const p = sim.players.get(id);
  if (!p || (team !== 0 && team !== 1) || p.team === team) return;
  if (humans(team).length >= MAX_PER_TEAM) return;
  p.gk = false;
  p.team = team;
  rebalanceBots();
  if (app.inGame) sim.placeAtSpot(p);
  refreshLobby();
}

function setKeeper(id, on) {
  const sim = app.sim;
  const p = sim && sim.players.get(id);
  if (!p) return;
  if (!sim.setKeeper(id, on)) {
    const msg = 'Your team already has a goalkeeper.';
    if (id === app.myId) toastOrLobby(msg); else app.net.send(id, { t: 'note', text: msg });
    return;
  }
  refreshLobby();
  if (app.inGame) toast(on ? `🧤 ${p.name} is now in goal` : `${p.name} left the goal`);
}

function toastOrLobby(msg) {
  if (app.screen === 'lobby') setMsg('lobbyMsg', msg, true); else toast(msg);
}

function requestKeeper(on) {
  if (app.role === 'client') app.net.send({ t: 'gk', on });
  else setKeeper(app.myId, on);
}

function amKeeper() {
  const me = app.roster.find((p) => p.id === app.myId);
  return !!(me && me.gk);
}

function rebalanceBots() {
  const sim = app.sim;
  for (const team of [0, 1]) {
    const h = humans(team).length;
    const bots = sim.teamList(team).filter((p) => p.bot);
    const target = Math.min(MAX_PER_TEAM, app.settings.fill > 0 ? Math.max(app.settings.fill, h) : h);
    const want = Math.max(0, target - h);
    while (bots.length > want) sim.removePlayer(bots.pop().id);
    while (bots.length < want) {
      const id = 'bot-' + (++app.botCounter);
      const used = new Set([...sim.players.values()].map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has('Bot ' + n)) || String(app.botCounter);
      bots.push(sim.addPlayer(id, 'Bot ' + name, team, true));
    }
  }
}

function lobbyMessage() {
  const sim = app.sim;
  return {
    t: 'lobby',
    code: app.code,
    phase: app.inGame ? 'game' : 'lobby',
    settings: app.settings,
    players: [...sim.players.values()].map((p) => ({ id: p.id, num: p.num, name: p.name, team: p.team, bot: p.bot, goals: p.goals, gk: p.gk })),
  };
}

function refreshLobby() {
  if (!app.sim) return;
  const msg = lobbyMessage();
  app.roster = msg.players;
  if (app.net) app.net.broadcast(msg);
  renderLobby();
}

function canStart() {
  const sim = app.sim;
  return sim && sim.teamList(0).length >= 1 && sim.teamList(1).length >= 1;
}

function startMatch() {
  if (!canStart()) return;
  rebalanceBots();
  app.sim.botSkill = app.settings.skill;
  app.sim.tiebreak = app.settings.tiebreak !== false;
  app.sim.start(app.settings.duration);
  app.inGame = true;
  refreshLobby();
  enterGame();
}

function setMatchPaused(on, byName) {
  if (!app.sim || !app.inGame) return;
  if (on) app.sim.pause(byName); else app.sim.resume(byName);
}

// Anyone can pause/resume; clients ask the host.
function requestPause(on) {
  if (app.role === 'client') app.net.send({ t: 'pause', on });
  else setMatchPaused(on, nameOf(app.myId));
}

function endMatchNow() {
  if (!app.sim || !app.inGame || app.sim.phase === 'ended') return;
  app.sim.endMatch();
}

function setSkill(team, level) {
  app.settings.skill = [...(app.settings.skill || [1, 1])];
  app.settings.skill[team] = level;
  if (app.sim) app.sim.botSkill = app.settings.skill;
  refreshLobby();
}

function returnToLobby() {
  if (!app.sim) return;
  app.inGame = false;
  app.sim.phase = 'lobby';
  refreshLobby();
  showScreen('lobby');
}

// ---------- Lobby UI ----------
function setLobbyChrome() {
  const online = app.role !== 'local';
  $('invitePanel').hidden = !online;
  $('lobbyTitle').textContent = app.role === 'local' ? 'Practice vs bots' : app.role === 'host' ? 'Your game' : 'Game lobby';
  if (online) {
    $('roomCode').textContent = app.code;
    $('inviteLink').value = inviteLink();
  }
  $('shareBtn').hidden = !navigator.share;
  const isHost = app.role !== 'client';
  $('durationSel').disabled = !isHost;
  $('fillSel').disabled = !isHost;
  $('startBtn').hidden = !isHost;
  $('pauseInvite').hidden = !online;
  $('pauseCode').textContent = app.code || '';
  $('toLobbyBtn').hidden = !isHost;
  $('endNowBtn').hidden = !isHost;
  $('pauseSkills').hidden = !isHost;
  document.querySelectorAll('.skill-sel').forEach((el) => { el.disabled = !isHost; });
  $('tiebreakSel').disabled = !isHost;
}

function inviteLink() {
  const q = new URLSearchParams();
  // Keep self-hosted signalling server settings in the link, if any.
  for (const [k, v] of new URLSearchParams(location.search)) if (k.startsWith('peer')) q.set(k, v);
  q.set('join', app.code);
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

function renderLobby() {
  const isHost = app.role !== 'client';
  const me = app.roster.find((p) => p.id === app.myId);
  for (const team of [0, 1]) {
    const el = document.querySelector(`.team[data-team="${team}"]`);
    const list = app.roster.filter((p) => p.team === team).sort((a, b) => (a.bot - b.bot) || (a.num - b.num));
    const ul = el.querySelector('.plist');
    ul.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      if (p.id === app.myId) li.classList.add('me');
      if (p.bot) li.classList.add('bot');
      li.textContent = (p.bot ? '🤖 ' : '⚽ ') + p.name;
      const badges = [];
      if (p.gk) badges.push('🧤 GK');
      if (p.id === 'host') badges.push('host');
      if (p.id === app.myId) badges.push('you');
      if (p.bot) badges.push('bot');
      for (const b of badges) {
        const s = document.createElement('span');
        s.className = 'badge';
        s.textContent = b;
        li.appendChild(s);
      }
      ul.appendChild(li);
    }
    el.querySelector('.count').textContent = `${list.length}/${MAX_PER_TEAM}`;
    const gkBtn = el.querySelector('.gk-btn');
    gkBtn.hidden = !me || me.team !== team;
    if (me) gkBtn.textContent = me.gk ? 'Play outfield instead' : '🧤 Play goalkeeper';
    const btn = el.querySelector('.join-team');
    const humansOnTeam = list.filter((p) => !p.bot).length;
    btn.hidden = !me || me.team === team;
    btn.disabled = humansOnTeam >= MAX_PER_TEAM;
  }
  $('durationSel').value = String(app.settings.duration);
  $('fillSel').value = String(app.settings.fill);
  syncSkillSelects();

  const totalHumans = app.roster.filter((p) => !p.bot).length;
  if (isHost) {
    $('startBtn').disabled = !canStart();
    $('startBtn').textContent = app.inGame ? 'Match in progress' : 'Start match';
    if (!canStart()) {
      setMsg('lobbyMsg', app.role === 'local'
        ? 'Pick how many bots per team to play against.'
        : 'Waiting for a friend to join… send them the invite link, or add bots.');
    } else {
      setMsg('lobbyMsg', `${totalHumans} player${totalHumans === 1 ? '' : 's'} ready. Press start when everyone is in.`);
    }
  } else {
    setMsg('lobbyMsg', 'Waiting for the host to start the match…');
  }
}

document.querySelectorAll('.gk-btn').forEach((btn) => {
  btn.onclick = () => { sfx.click(); requestKeeper(!amKeeper()); };
});
document.querySelectorAll('.join-team').forEach((btn) => {
  btn.onclick = () => {
    sfx.click();
    const team = +btn.dataset.team;
    if (app.role === 'client') app.net.send({ t: 'team', team });
    else switchTeam(app.myId, team);
  };
});
$('durationSel').onchange = (e) => { app.settings.duration = +e.target.value; refreshLobby(); };
$('fillSel').onchange = (e) => { app.settings.fill = +e.target.value; rebalanceBots(); refreshLobby(); };
document.querySelectorAll('.skill-sel').forEach((el) => {
  el.onchange = () => { setSkill(+el.dataset.team, +el.value); toast(`${TEAMS[+el.dataset.team].name} bots: ${el.selectedOptions[0].text}`); };
});
$('tiebreakSel').onchange = (e) => {
  app.settings.tiebreak = e.target.value === '1';
  if (app.sim) app.sim.tiebreak = app.settings.tiebreak;
  refreshLobby();
};
function syncSkillSelects() {
  $('tiebreakSel').value = app.settings.tiebreak === false ? '0' : '1';
  const sk = app.settings.skill || [1, 1];
  document.querySelectorAll('.skill-sel').forEach((el) => { el.value = String(sk[+el.dataset.team]); });
}
$('startBtn').onclick = () => { unlockAudio(); startMatch(); };
$('leaveLobbyBtn').onclick = () => leave();
$('copyLinkBtn').onclick = () => copy(inviteLink(), 'Invite link copied! Send it to a friend.');
$('copyCodeBtn').onclick = () => copy(app.code, 'Code copied!');
$('pauseCopyBtn').onclick = () => copy(inviteLink(), 'Invite link copied!');
$('shareBtn').onclick = () => {
  navigator.share({ title: 'Rainbow Flick Soccer', text: `Join my soccer game! Code: ${app.code}`, url: inviteLink() }).catch(() => {});
};

async function copy(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* ignore */ }
    ta.remove();
  }
  if (app.screen === 'lobby') setMsg('lobbyMsg', okMsg);
  else toast(okMsg);
}

function leave() {
  if (app.role === 'host' && app.net) app.net.close();
  else if (app.net) app.net.close();
  app.net = null;
  backToMenu('');
}

// ---------- Client messages ----------
function onClientMessage(msg) {
  switch (msg.t) {
    case 'lobby': {
      app.roster = msg.players;
      app.settings = msg.settings;
      app.code = msg.code;
      app.inGame = msg.phase === 'game';
      renderLobby();
      if (app.inGame && app.screen !== 'game') enterGame();
      if (!app.inGame && app.screen === 'game') showScreen('lobby');
      break;
    }
    case 's': onSnapshot(msg); break;
    case 'ev': handleEvents(msg.list); break;
    case 'pong': {
      const r = performance.now() - msg.ts;
      app.rtt = app.rtt * 0.8 + r * 0.2;
      break;
    }
    case 'bye': backToMenu(msg.reason || 'The host ended the game.'); break;
    case 'note': toastOrLobby(String(msg.text || '')); break;
  }
}

let pingTimer = null;
function startPinging() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (app.role !== 'client' || !app.net) { clearInterval(pingTimer); return; }
    app.net.send({ t: 'ping', ts: performance.now() });
  }, 2000);
}

// Current free-kick shootout summary (same shape for host and clients).
function soInfo() {
  if (app.role === 'client') return app.latest && app.latest.so ? app.latest.so : null;
  const sim = app.sim;
  if (!sim || !sim.so) return null;
  const so = sim.so;
  return {
    k: so.kicks, g: so.goals, tu: so.turn, st: so.stage, r: so.result,
    ki: sim.players.get(so.kicker)?.num || 0, ke: sim.players.get(so.keeper)?.num || 0,
  };
}

function myTeam() {
  const me = app.roster.find((p) => p.id === app.myId);
  return me ? me.team : 0;
}

function myNum() {
  const me = app.roster.find((p) => p.id === app.myId);
  return me ? me.num : -1;
}

function onSnapshot(s) {
  const now = performance.now();
  const off = now - s.ht;
  if (app.clockOffset === null || off < app.clockOffset) app.clockOffset = off;
  else app.clockOffset += (off - app.clockOffset) * 0.01;
  app.snaps.push(s);
  while (app.snaps.length > 30) app.snaps.shift();
  app.latest = s;
  app.field = s.f;
  app.matchPhase = s.ph;
  if ((s.ph === 'paused') !== !!app.matchPaused && s.ph !== 'ended') {
    app.matchPaused = s.ph === 'paused';
    syncPausedUI(s.pb || '');
  }

  // Reconcile the locally predicted player.
  const num = myNum();
  const me = s.p.find((p) => p[0] === num);
  if (!me) { app.pred = null; return; }
  const phaseChanged = app.lastPhase !== s.ph;
  app.lastPhase = s.ph;
  if (!app.pred || (phaseChanged && s.ph === 'countdown')) {
    app.pred = { x: me[1], z: me[2], vx: me[3], vz: me[4], yaw: me[5], stamina: me[6] / 100, tackleT: 0, tackleCd: 0, stunT: 0 };
    return;
  }
  const pr = app.pred;
  const lead = Math.min(0.25, app.rtt / 2000 + 0.02);
  const tx = me[1] + me[3] * lead, tz = me[2] + me[4] * lead;
  const ex = tx - pr.x, ez = tz - pr.z;
  if (Math.hypot(ex, ez) > 3.5) { pr.x = me[1]; pr.z = me[2]; pr.vx = me[3]; pr.vz = me[4]; }
  else { pr.x += ex * 0.18; pr.z += ez * 0.18; }
  pr.stamina = me[6] / 100;
  if (me[7] & 2) pr.stunT = Math.max(pr.stunT, 0.15);
  if ((me[7] & 1) && pr.tackleT <= 0) { pr.vx = me[3]; pr.vz = me[4]; }
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function clientState(dt) {
  const snaps = app.snaps;
  const rosterByNum = new Map(app.roster.map((p) => [p.num, p]));
  const num = myNum();
  const empty = { players: [], ball: { x: 0, y: C.ballRadius, z: 0, vx: 0, vy: 0, vz: 0 } };
  if (!snaps.length) return empty;
  const renderT = performance.now() - app.clockOffset - INTERP_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].ht <= renderT) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
  }
  const t = b.ht > a.ht ? Math.min(1, Math.max(0, (renderT - a.ht) / (b.ht - a.ht))) : 1;
  const aMap = new Map(a.p.map((p) => [p[0], p]));
  const players = [];
  for (const pb of b.p) {
    const info = rosterByNum.get(pb[0]);
    if (!info) continue;
    const pa = aMap.get(pb[0]) || pb;
    players.push({
      num: pb[0], team: info.team, name: info.name, isMe: pb[0] === num,
      x: pa[1] + (pb[1] - pa[1]) * t, z: pa[2] + (pb[2] - pa[2]) * t,
      vx: pa[3] + (pb[3] - pa[3]) * t, vz: pa[4] + (pb[4] - pa[4]) * t,
      yaw: lerpAngle(pa[5], pb[5], t), flags: pb[7], stamina: pb[6] / 100,
    });
  }
  const ba = a.b, bb = b.b;
  let ball = {
    x: ba[0] + (bb[0] - ba[0]) * t, y: ba[1] + (bb[1] - ba[1]) * t, z: ba[2] + (bb[2] - ba[2]) * t,
    vx: bb[3], vy: bb[4], vz: bb[5],
  };

  // Local prediction for my own player.
  const pr = app.pred;
  if (pr) {
    const so = app.matchPhase === 'shootout' ? soInfo() : null;
    const soKeeper = so && so.ke === num && (so.st === 'aim' || so.st === 'flight');
    const frozen = app.matchPhase === 'countdown' || app.matchPhase === 'ended' || app.matchPhase === 'paused'
      || (app.matchPhase === 'shootout' && !soKeeper);
    if (so && !soKeeper) {
      // Everyone else stands still: follow the host's position exactly.
      const meL = app.latest.p.find((p) => p[0] === num);
      if (meL) { pr.x = meL[1]; pr.z = meL[2]; pr.yaw = meL[5]; pr.vx = 0; pr.vz = 0; }
    }
    pr.tackleT = Math.max(0, pr.tackleT - dt);
    pr.tackleCd = Math.max(0, pr.tackleCd - dt);
    pr.stunT = Math.max(0, pr.stunT - dt);
    pr.diveT = Math.max(0, (pr.diveT || 0) - dt);
    pr.diveCd = Math.max(0, (pr.diveCd || 0) - dt);
    const L0 = app.latest && app.latest.p.find((p) => p[0] === num);
    const holding = L0 && (L0[7] & 32);
    integratePlayerMovement(pr, input.movement(), dt, {
      frozen, field: app.field,
      box: soKeeper ? shootoutKeeperBox(app.field) : holding ? ownBox(app.field, myTeam()) : null,
    });
    const mine = players.find((p) => p.isMe);
    if (mine) Object.assign(mine, { x: pr.x, z: pr.z, vx: pr.vx, vz: pr.vz, yaw: pr.yaw });
    // When I'm dribbling, draw the ball relative to my predicted position.
    const L = app.latest;
    if (L && L.o === num) {
      const meL = L.p.find((p) => p[0] === num);
      if (meL) ball = { x: pr.x + (L.b[0] - meL[1]), y: L.b[1], z: pr.z + (L.b[2] - meL[2]), vx: L.b[3], vy: L.b[4], vz: L.b[5] };
    }
  }
  // Smooth transitions between interpolated and predicted ball.
  if (!app.displayBall) app.displayBall = { ...ball };
  const db = app.displayBall;
  const jump = Math.hypot(ball.x - db.x, ball.y - db.y, ball.z - db.z);
  const k = jump > 6 ? 1 : 1 - Math.exp(-dt * 30);
  db.x += (ball.x - db.x) * k; db.y += (ball.y - db.y) * k; db.z += (ball.z - db.z) * k;
  db.vx = ball.vx; db.vy = ball.vy; db.vz = ball.vz;
  return { players, ball: db };
}

function hostState() {
  const sim = app.sim;
  const players = [...sim.players.values()].map((p) => ({
    num: p.num, team: p.team, name: p.name, isMe: p.id === app.myId,
    x: p.x, z: p.z, vx: p.vx, vz: p.vz, yaw: p.yaw, stamina: p.stamina,
    flags: (p.tackleT > 0 ? 1 : 0) | (p.stunT > 0 ? 2 : 0) | (p.kickCd > 0.2 ? 4 : 0) | (p.callT > 0 ? 8 : 0)
      | (p.diveT > 0 ? 16 : 0) | (p.holding ? 32 : 0) | (p.isGK ? 64 : 0),
  }));
  return { players, ball: sim.ball };
}

// ---------- Game flow ----------
function enterGame() {
  app.ended = false;
  app.matchPaused = false;
  syncPausedUI('');
  app.paused = false;
  app.displayBall = null;
  showScreen('game');
  $('end').hidden = true;
  $('pause').hidden = true;
  const field = app.sim ? app.sim.field : app.field;
  renderer.setField(field);
  // Face the attacking goal.
  faceAttack();
  input.pitch = 0.38;
  $('lockHint').hidden = input.isTouch;
}

function faceAttack() {
  input.setYaw(myTeam() === 1 ? -Math.PI / 2 : Math.PI / 2);
}

// Kicks go where you're steering (WASD / joystick). Standing still, they go
// where the camera looks (mouse players) or the way you're facing (touch).
function actionAim() {
  const so = app.matchPhase === 'shootout' || (app.sim && app.sim.phase === 'shootout') ? soInfo() : null;
  if (so && app.meState && so.ki === app.meState.num) {
    // Free kick: camera direction, nudged left/right with the stick / A-D.
    const { s } = input.localMove();
    return input.yaw - Math.max(-1, Math.min(1, s)) * 0.3; // full push = just inside the post
  }
  const m = input.movement();
  if (Math.hypot(m.mx, m.mz) > 0.3) return Math.atan2(m.mx, m.mz);
  if (!input.locked && app.meState) return app.meState.yaw;
  return input.yaw;
}

// The teammate a pass would go to right now (shown with a ring), as both the
// render num and the player id the host understands.
function currentPassTarget(state, aim) {
  const me = state.players.find((p) => p.isMe);
  if (!me) return null;
  const list = state.players.map((p) => ({ id: p.num, team: p.team, x: p.x, z: p.z }));
  const t = pickPassTarget(list, { id: me.num, team: me.team, x: me.x, z: me.z }, aim);
  if (!t) return null;
  const info = app.roster.find((p) => p.num === t.id);
  return info ? { num: t.id, id: info.id } : null;
}

input.onAction = (kind, power) => {
  if (app.screen !== 'game') return;
  const aim = actionAim();
  const target = kind === 'pass' && app.lastState ? currentPassTarget(app.lastState, aim) : null;
  const tg = target ? target.id : null;
  if (app.role === 'client') {
    app.net.send({ t: 'act', k: kind, p: Math.round(power * 100) / 100, aim: Math.round(aim * 1000) / 1000, tg });
    const pr = app.pred;
    const meS = app.meState;
    const soNow = soInfo();
    const keeperDive = meS && (((meS.flags & 64) && inBox(ownBox(app.field, myTeam()), pr ? pr.x : 0, pr ? pr.z : 0))
      || (app.matchPhase === 'shootout' && soNow && soNow.ke === meS.num));
    if (kind === 'tackle' && keeperDive && pr && !(pr.diveCd > 0) && app.matchPhase === 'play') {
      const mv = input.movement();
      let dx = mv.mx, dz = mv.mz;
      if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(aim); dz = Math.cos(aim); }
      const l = Math.hypot(dx, dz);
      pr.vx = (dx / l) * C.diveSpeed; pr.vz = (dz / l) * C.diveSpeed;
      pr.diveT = C.diveTime; pr.diveCd = C.diveCooldown;
    } else if (kind === 'tackle' && pr && pr.tackleCd <= 0 && pr.stunT <= 0 && app.matchPhase === 'play') {
      const mv = input.movement();
      let dx = mv.mx, dz = mv.mz;
      if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(aim); dz = Math.cos(aim); }
      const l = Math.hypot(dx, dz);
      pr.vx = (dx / l) * C.tackleSpeed; pr.vz = (dz / l) * C.tackleSpeed;
      pr.tackleT = C.tackleTime; pr.tackleCd = C.tackleCooldown;
    }
  } else if (app.sim) {
    app.sim.queueAction(app.myId, kind, power, aim, tg);
  }
};

input.onToggle = (name, val) => {
  if (name === 'pause') requestPause(!matchIsPaused());
  if (name === 'menu') openPause();
  if (name === 'help') $('help').hidden = !$('help').hidden;
  if (name === 'mute') { const m = toggleMute(); toast(m ? 'Sound off' : 'Sound on'); syncPauseButtons(); }
  if (name === 'cam') { toast(`Camera: ${CAM_LABELS[val]}`); syncPauseButtons(); }
  if (name === 'scores') showScoreTable(val);
};

function nameOf(id) {
  const p = app.roster.find((q) => q.id === id);
  return p ? p.name : '';
}

let centerTimer = null;
function centerMsg(html, cls = '', ms = 0) {
  const el = $('center');
  el.className = 'center-msg ' + cls;
  el.innerHTML = html;
  clearTimeout(centerTimer);
  if (ms) centerTimer = setTimeout(() => { el.innerHTML = ''; el.className = 'center-msg'; }, ms);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function handleEvents(list) {
  for (const e of list) {
    switch (e.k) {
      case 'start':
        if (app.screen !== 'game') enterGame();
        app.ended = false; $('end').hidden = true; updateInputEnabled();
        app.matchPaused = false; syncPausedUI('');
        break;
      case 'whistle': sfx.whistle(); centerMsg('GO!', '', 800); break;
      case 'kick':
        if (e.kind === 'shoot') { sfx.kick(e.power); if (e.power > 0.75) renderer.rainbowBurst(0.7); }
        else if (e.kind === 'pass') sfx.pass();
        else if (e.kind === 'chip' || e.kind === 'lob') sfx.kick(0.5);
        else if (e.kind === 'punt') sfx.kick(0.9);
        else if (e.kind === 'throw' || e.kind === 'roll') sfx.pass();
        else if (e.kind === 'flick') {
          sfx.flick(); renderer.rainbowBurst(1.6);
          const n = nameOf(e.id);
          if (n) toast(`🌈 ${n} pulled off a rainbow flick!`);
        }
        break;
      case 'tackle': sfx.tackle(); break;
      case 'dive': sfx.tackle(); break;
      case 'save': {
        sfx.save();
        if (e.big) toast(`🧤 Great save by ${nameOf(e.id)}!`);
        break;
      }
      case 'post': sfx.post(); toast('Off the woodwork!'); break;
      case 'call': {
        const me = app.roster.find((p) => p.id === app.myId);
        if (e.id === app.myId) { sfx.call(); toast('You called for the ball!'); }
        else if (me && me.team === e.team) { sfx.call(); toast(`📣 ${nameOf(e.id)} is calling for the ball!`); }
        break;
      }
      case 'paused':
        sfx.pause();
        app.matchPaused = true;
        syncPausedUI(e.by);
        if (document.pointerLockElement) document.exitPointerLock(); // opens the menu
        break;
      case 'resumed':
        sfx.pause();
        app.matchPaused = false;
        syncPausedUI();
        if (e.by) toast(`${e.by} resumed the match`);
        if (app.paused) closePause();
        break;
      case 'goal': {
        sfx.goal();
        const f = app.sim ? app.sim.field : app.field;
        renderer.confetti(e.team === 0 ? f.L / 2 : -f.L / 2, 0, e.team);
        const who = e.scorer ? (e.own ? `Own goal by ${escapeHtml(e.scorer)}` : escapeHtml(e.scorer)) : TEAMS[e.team].name;
        centerMsg(`GOAL!<small>${who}</small>`, 'goal', 3200);
        if (app.role !== 'client') refreshLobby(); // update goal tallies
        break;
      }
      case 'end': showEnd(e); break;
      case 'shootout':
        sfx.whistle();
        centerMsg(`FREE KICKS!<small>Tie breaker · ${TEAMS[e.first].name} kick first</small>`, 'goal', 2600);
        app.soStartAt = performance.now();
        break;
      case 'so_setup': {
        const meId = app.myId;
        if (e.kicker === meId) { input.setYaw(Math.PI / 2); toast('⚽ Your free kick! Aim with the stick / A-D, then shoot.'); }
        else if (e.keeper === meId) { input.setYaw(-Math.PI / 2); toast('🧤 You are in goal! Move along the line and Dive.'); }
        else input.setYaw(Math.PI / 2);
        input.pitch = 0.3;
        const wait = Math.max(300, 2700 - (performance.now() - (app.soStartAt || 0)));
        setTimeout(() => centerMsg(`${escapeHtml(nameOf(e.kicker))}<small>${TEAMS[e.team].name} · vs ${escapeHtml(nameOf(e.keeper))}</small>`, '', 1600), wait);
        break;
      }
      case 'so_kick':
        if (e.result === 'goal') { sfx.goal(); centerMsg('GOAL!', 'goal', 1800); }
        else if (e.result === 'save') centerMsg('SAVED!', '', 1800);
        else { sfx.post(); centerMsg('MISSED!', '', 1800); }
        break;
    }
  }
}

function showEnd(e) {
  sfx.end();
  app.ended = true;
  app.matchPaused = false;
  syncPausedUI('');
  updateInputEnabled();
  if (document.pointerLockElement) document.exitPointerLock();
  $('pause').hidden = true;
  $('end').hidden = false;
  $('endScore').innerHTML = `<span class="s0">${e.score[0]}</span> – <span class="s1">${e.score[1]}</span>`;
  const me = app.roster.find((p) => p.id === app.myId);
  let text;
  const so = e.so;
  if (so) $('endScore').innerHTML += `<div class="end-so">Free kicks <span class="s0">${so[0]}</span> – <span class="s1">${so[1]}</span></div>`;
  const decided = so ? so[0] !== so[1] : e.score[0] !== e.score[1];
  if (!decided) text = "It's a draw!";
  else {
    const w = so ? (so[0] > so[1] ? 0 : 1) : (e.score[0] > e.score[1] ? 0 : 1);
    text = `${TEAMS[w].name} win${so ? ' on free kicks' : ''}!` + (me ? (me.team === w ? ' 🎉' : ' Better luck next time.') : '');
  }
  $('endWinner').textContent = text;
  $('endScorers').textContent = e.scorers && e.scorers.length
    ? 'Scorers: ' + e.scorers.map((s) => `${s.name} (${s.goals})`).join(', ')
    : '';
  const isHost = app.role !== 'client';
  $('rematchBtn').hidden = !isHost;
  $('endLobbyBtn').hidden = !isHost;
  $('endWait').hidden = isHost;
}

$('rematchBtn').onclick = () => startMatch();
$('endLobbyBtn').onclick = () => returnToLobby();
$('endLeaveBtn').onclick = () => leave();

// Pause menu.
function openPause() {
  if (app.screen !== 'game' || app.ended) return;
  app.paused = true;
  updateInputEnabled();
  syncPauseButtons();
  $('pause').hidden = false;
}
function closePause() {
  app.paused = false;
  $('pause').hidden = true;
  updateInputEnabled();
  if (!input.isTouch) {
    try { const r = canvas.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* needs a click */ }
  }
}
function matchIsPaused() {
  return !!app.matchPaused;
}
function syncPausedUI(by) {
  const paused = matchIsPaused();
  $('pausedBanner').hidden = !paused || app.screen !== 'game' || app.ended;
  if (by !== undefined) $('pausedText').textContent = by ? `Match paused by ${by}` : 'Match paused';
  $('pauseMatchBtn').textContent = paused ? 'Resume match for everyone' : 'Pause match for everyone';
}
function syncPauseButtons() {
  syncPausedUI();
  syncSkillSelects();
  $('ballCamBtn').textContent = `Camera: ${CAM_LABELS[input.camMode]} (V)`;
  $('keeperBtn').textContent = amKeeper() ? 'Play outfield instead' : '🧤 Play goalkeeper';
  $('muteBtn').textContent = `Sound: ${isMuted() ? 'off' : 'on'} (M)`;
}
$('menuBtn').onclick = () => openPause();
$('resumeBtn').onclick = () => closePause();
$('pauseMatchBtn').onclick = () => {
  const paused = matchIsPaused();
  requestPause(!paused);
  if (paused) closePause();
};
$('bannerResumeBtn').onclick = () => { requestPause(false); };
$('endNowBtn').onclick = () => endMatchNow();
$('toLobbyBtn').onclick = () => returnToLobby();
$('leaveGameBtn').onclick = () => leave();
$('ballCamBtn').onclick = () => { input.cycleCam(); syncPauseButtons(); };
$('keeperBtn').onclick = () => { requestKeeper(!amKeeper()); setTimeout(syncPauseButtons, 300); };
$('muteBtn').onclick = () => { toggleMute(); syncPauseButtons(); };
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  $('lockHint').hidden = locked || input.isTouch;
  if (!locked && app.screen === 'game' && !app.paused && !app.ended) openPause();
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || app.screen !== 'game') return;
  if (app.paused) closePause(); else openPause();
});

function showScoreTable(show) {
  const el = $('scoreTable');
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = [0, 1].map((t) => {
    const rows = app.roster.filter((p) => p.team === t)
      .map((p) => `<div><span>${p.bot ? '🤖' : '⚽'} ${escapeHtml(p.name)}</span><span>${'●'.repeat(p.goals || 0)}</span></div>`).join('');
    return `<div><h4 style="color:${TEAMS[t].css}">${TEAMS[t].name}</h4>${rows}</div>`;
  }).join('');
}

// Touch buttons change meaning for a goalkeeper.
let touchLabelKey = '';
function updateTouchLabels(me) {
  if (!input.isTouch) return;
  const so = soInfo();
  const gk = me && ((me.flags & 64) || (so && so.ke === me.num));
  const holding = me && (me.flags & 32);
  const key = `${gk ? 1 : 0}${holding ? 1 : 0}`;
  if (key === touchLabelKey) return;
  touchLabelKey = key;
  $('tShoot').textContent = holding ? 'Punt' : 'Shoot';
  $('tPass').textContent = holding ? 'Throw' : 'Pass';
  $('tChip').textContent = holding ? 'Lob' : 'Chip';
  $('tFlick').textContent = holding ? 'Roll' : 'Flick';
  $('tTackle').textContent = gk ? 'Dive' : 'Tackle';
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 3500);
}

// ---------- HUD ----------
const mm = $('minimap');
const mctx = mm.getContext('2d');
function drawShootout(so) {
  const el = $('soTracker');
  el.hidden = !so;
  if (!so) return;
  const key = JSON.stringify([so.k, so.tu, so.st]);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const rounds = Math.max(5, so.k[0].length, so.k[1].length);
  el.innerHTML = [0, 1].map((t) => {
    let dots = '';
    for (let i = 0; i < rounds; i++) {
      const v = so.k[t][i];
      const next = so.tu === t && i === so.k[t].length && so.st !== 'result';
      dots += `<i class="${v === 1 ? 'hit' : v === 0 ? 'miss' : next ? 'next' : ''}"></i>`;
    }
    return `<div class="so-row"><span style="color:${TEAMS[t].css}">${TEAMS[t].name}</span><b>${so.g[t]}</b>${dots}</div>`;
  }).join('');
}

function drawHud(state, phase, phaseT, timeLeft, score, field) {
  $('score0').textContent = score[0];
  $('score1').textContent = score[1];
  const tl = Math.max(0, Math.ceil(timeLeft));
  $('clock').textContent = phase === 'shootout' ? 'FK' : `${Math.floor(tl / 60)}:${String(tl % 60).padStart(2, '0')}`;
  $('powerBar').style.width = `${input.chargeLevel() * 100}%`;
  const me = state.players.find((p) => p.isMe);
  const stamina = app.pred ? app.pred.stamina : me ? me.stamina : 1;
  $('staminaBar').style.width = `${(stamina ?? 1) * 100}%`;
  if (phase === 'countdown') {
    const n = Math.ceil(phaseT);
    if ($('center').dataset.n !== String(n)) {
      $('center').dataset.n = String(n);
      centerMsg(n > 0 ? String(n) : '', '');
    }
  } else if ($('center').dataset.n) {
    delete $('center').dataset.n;
    if (!$('center').classList.contains('goal') && $('center').textContent !== 'GO!') centerMsg('');
  }

  // Minimap.
  const W = mm.width, H = mm.height, pad = 8;
  const sx = (W - pad * 2) / field.L, sz = (H - pad * 2) / field.W;
  const X = (x) => pad + (x + field.L / 2) * sx;
  const Z = (z) => pad + (z + field.W / 2) * sz;
  mctx.clearRect(0, 0, W, H);
  mctx.strokeStyle = 'rgba(255,255,255,0.7)';
  mctx.lineWidth = 1.5;
  mctx.strokeRect(X(-field.L / 2), Z(-field.W / 2), field.L * sx, field.W * sz);
  mctx.beginPath(); mctx.moveTo(X(0), Z(-field.W / 2)); mctx.lineTo(X(0), Z(field.W / 2)); mctx.stroke();
  mctx.beginPath(); mctx.arc(X(0), Z(0), 6, 0, Math.PI * 2); mctx.stroke();
  mctx.fillStyle = '#fff';
  for (const s of [1, -1]) mctx.fillRect(X(s * field.L / 2) - (s > 0 ? 0 : 3), Z(-field.goalW / 2), 3, field.goalW * sz);
  for (const p of state.players) {
    mctx.fillStyle = TEAMS[p.team].css;
    mctx.beginPath();
    mctx.arc(X(p.x), Z(p.z), p.isMe ? 5 : 3.5, 0, Math.PI * 2);
    mctx.fill();
    if (p.isMe) { mctx.strokeStyle = '#fff'; mctx.lineWidth = 2; mctx.stroke(); }
  }
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.arc(X(state.ball.x), Z(state.ball.z), 3, 0, Math.PI * 2);
  mctx.fill();
}

// ---------- Loops ----------
// A worker-driven ticker keeps the host's simulation running even when its
// tab is in the background (where timers and rAF get throttled).
function makeTicker(fn, ms) {
  try {
    const src = `setInterval(() => postMessage(0), ${ms});`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    return w;
  } catch (e) {
    return setInterval(fn, ms);
  }
}

let simAcc = 0, simLast = performance.now(), simSteps = 0, inputAcc = 0;
let lastSent = '';
makeTicker(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - simLast) / 1000);
  simLast = now;

  if ((app.role === 'host' || app.role === 'local') && app.sim && app.inGame) {
    simAcc += dt;
    const step = 1 / 60;
    while (simAcc >= step) {
      simAcc -= step;
      app.sim.setInput(app.myId, input.movement());
      app.sim.step(step);
      simSteps++;
      if (app.role === 'host' && simSteps % SNAP_EVERY === 0) {
        const snap = app.sim.snapshot();
        snap.ht = Math.round(performance.now());
        app.net.broadcast(snap);
      }
      const evs = app.sim.drainEvents();
      if (evs.length) {
        if (app.role === 'host') app.net.broadcast({ t: 'ev', list: evs });
        handleEvents(evs);
      }
    }
  } else {
    simAcc = 0;
  }

  if (app.role === 'client' && app.net && app.screen === 'game') {
    inputAcc += dt;
    if (inputAcc >= 1 / 30) {
      inputAcc = 0;
      const m = input.movement();
      const msg = { t: 'in', mx: +m.mx.toFixed(3), mz: +m.mz.toFixed(3), sp: m.sprint ? 1 : 0, aim: +m.aim.toFixed(3) };
      const key = `${msg.mx},${msg.mz},${msg.sp},${msg.aim}`;
      if (key !== lastSent || Math.random() < 0.1) { app.net.send(msg); lastSent = key; }
    }
  }
}, 1000 / 60);

let last = performance.now();
let orbitT = 0;
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (app.screen === 'game') {
    let state, phase, phaseT, timeLeft, score, field;
    if (app.role === 'client') {
      state = clientState(dt);
      const L = app.latest;
      phase = L ? L.ph : 'countdown';
      phaseT = L ? L.pt : 3;
      timeLeft = L ? L.tl : app.settings.duration;
      score = L ? L.sc : [0, 0];
      field = app.field;
    } else {
      const sim = app.sim;
      state = hostState();
      phase = sim.phase; phaseT = sim.phaseT; timeLeft = sim.timeLeft; score = sim.score; field = sim.field;
    }
    renderer.setField(field);
    const me = state.players.find((p) => p.isMe);
    app.meState = me || null;
    app.lastState = state;
    // New kickoff: point the camera at the goal we attack.
    if (phase === 'countdown' && app.lastFramePhase !== 'countdown' && app.lastFramePhase !== 'paused') faceAttack();
    app.lastFramePhase = phase;
    input.noAutoCam = phase === 'shootout'; // fixed views during free kicks
    input.attackYaw = myTeam() === 1 ? -Math.PI / 2 : Math.PI / 2;
    input.update(dt, me, state.ball);

    // Aim arrow + highlighted pass target whenever I'm on (or holding) the ball.
    let aimInfo = null;
    const soNow = phase === 'shootout' ? soInfo() : null;
    if (me && input.enabled && soNow && soNow.ki === me.num && soNow.st === 'aim') {
      const b = state.ball;
      renderer.setAim({ x: b.x, z: b.z, aim: actionAim(), target: null }, state.players);
    } else if (me && input.enabled && phase === 'play') {
      const b = state.ball;
      const near = Math.hypot(b.x - me.x, b.z - me.z) < 2.4 && b.y < 2;
      if (near || (me.flags & 32) || input.charging) {
        const aim = actionAim();
        const tgt = currentPassTarget(state, aim);
        aimInfo = { x: me.x, z: me.z, aim, target: tgt ? tgt.num : null };
      }
    }
    if (!(soNow && me && soNow.ki === me.num && soNow.st === 'aim')) renderer.setAim(aimInfo, state.players);
    drawShootout(soNow);
    renderer.frame(state, dt, { yaw: input.yaw, pitch: input.pitch, dist: 9, spectate: !me });
    drawHud(state, phase, phaseT, timeLeft, score, field);
    updateTouchLabels(me);
  } else {
    orbitT += dt * 0.06;
    renderer.frame({ players: [], ball: { x: 0, y: C.ballRadius, z: 0, vx: 0, vy: 0, vz: 0 } }, dt, { orbit: orbitT });
  }
}
requestAnimationFrame(frame);

window.addEventListener('beforeunload', () => {
  if (app.role === 'host' && app.net) app.net.close();
});

// Exposed for debugging in the console.
window.rfs = { app, renderer, input };
