// Tiny synthesized sound effects (no audio files needed).
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('rfs-muted') === '1'; } catch (e) { /* ignore */ }

function ac() {
  if (!ctx) {
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return null;
    ctx = new A();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() { ac(); }
export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('rfs-muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
  return muted;
}

function tone(freq, dur, type = 'sine', vol = 0.2, slide = 0) {
  const a = ac();
  if (!a || muted) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, a.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g).connect(a.destination);
  o.start();
  o.stop(a.currentTime + dur + 0.02);
}

function noise(dur, vol = 0.2, filterFreq = 1200) {
  const a = ac();
  if (!a || muted) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 0.6;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = filterFreq;
  f.Q.value = 0.6;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  kick(power = 0.5) { tone(140 + power * 60, 0.12, 'triangle', 0.25 + power * 0.2, -80); noise(0.05, 0.15, 900); },
  pass() { tone(220, 0.08, 'triangle', 0.18, -100); },
  flick() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'sine', 0.12), i * 55)); },
  whistle() { tone(2100, 0.35, 'square', 0.05); setTimeout(() => tone(2300, 0.25, 'square', 0.04), 120); },
  post() { tone(880, 0.4, 'sine', 0.15); tone(1320, 0.3, 'sine', 0.08); },
  tackle() { noise(0.12, 0.25, 400); },
  goal() { noise(2.2, 0.35, 700); [392, 494, 587, 784].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.14), i * 120)); },
  call() { tone(520, 0.09, 'triangle', 0.16, 160); setTimeout(() => tone(700, 0.12, 'triangle', 0.14, 120), 90); },
  pause() { tone(440, 0.15, 'sine', 0.12, -120); },
  click() { tone(660, 0.05, 'sine', 0.08); },
  end() { tone(2000, 0.3, 'square', 0.05); setTimeout(() => tone(2000, 0.3, 'square', 0.05), 400); setTimeout(() => tone(1600, 0.8, 'square', 0.05), 800); },
};
