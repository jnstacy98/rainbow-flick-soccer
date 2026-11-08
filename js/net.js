// Peer-to-peer networking via PeerJS (WebRTC). The host's browser runs the
// authoritative simulation; everyone else connects to the host's peer ID,
// which is derived from the 6-character invite code. No game server needed.

const PREFIX = 'rainbowflick-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeCode() {
  let s = '';
  const arr = new Uint32Array(6);
  crypto.getRandomValues(arr);
  for (const v of arr) s += ALPHABET[v % ALPHABET.length];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// Optional overrides for self-hosted PeerJS servers:
//   ?peerhost=my.server.com&peerport=443&peerpath=/myapp&peersecure=1
function peerOptions() {
  const q = new URLSearchParams(location.search);
  const opts = { debug: 1 };
  if (q.get('peerhost')) {
    opts.host = q.get('peerhost');
    opts.port = +(q.get('peerport') || 443);
    opts.path = q.get('peerpath') || '/';
    opts.secure = q.get('peersecure') ? q.get('peersecure') === '1' : opts.port === 443;
  }
  return opts;
}

function ensurePeerLib() {
  if (!window.Peer) throw new Error('Networking library failed to load. Check your connection and reload.');
}

export class HostNet {
  constructor() {
    this.peer = null;
    this.conns = new Map(); // peerId -> DataConnection
    this.onMessage = () => {};
    this.onJoin = () => {};
    this.onLeave = () => {};
    this.onError = () => {};
    this.code = null;
  }

  open(attempt = 0) {
    ensurePeerLib();
    return new Promise((resolve, reject) => {
      const code = makeCode();
      const peer = new window.Peer(PREFIX + code, peerOptions());
      let opened = false;
      peer.on('open', () => {
        opened = true;
        this.peer = peer;
        this.code = code;
        resolve(code);
      });
      peer.on('error', (err) => {
        if (!opened) {
          peer.destroy();
          if (err.type === 'unavailable-id' && attempt < 5) {
            this.open(attempt + 1).then(resolve, reject);
          } else reject(new Error(describeError(err)));
          return;
        }
        this.onError(err);
      });
      peer.on('disconnected', () => {
        // Lost the signalling server; existing peer links keep working, but
        // reconnect so new friends can still join.
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
      });
      peer.on('connection', (conn) => this._accept(conn));
    });
  }

  _accept(conn) {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
    });
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') this.onJoin(conn.peer, msg);
      else this.onMessage(conn.peer, msg);
    });
    const gone = () => {
      if (!this.conns.has(conn.peer)) return;
      this.conns.delete(conn.peer);
      this.onLeave(conn.peer);
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  send(peerId, msg) {
    const c = this.conns.get(peerId);
    if (c && c.open) {
      try { c.send(msg); } catch (e) { /* ignore */ }
    }
  }

  broadcast(msg) {
    for (const c of this.conns.values()) {
      if (c.open) {
        try { c.send(msg); } catch (e) { /* ignore */ }
      }
    }
  }

  kick(peerId, msg) {
    const c = this.conns.get(peerId);
    if (!c) return;
    if (msg) this.send(peerId, msg);
    setTimeout(() => c.close(), 300);
  }

  close() {
    this.broadcast({ t: 'bye', reason: 'The host closed the game.' });
    setTimeout(() => this.peer && this.peer.destroy(), 200);
  }
}

export class ClientNet {
  constructor() {
    this.peer = null;
    this.conn = null;
    this._onMessage = null;
    this._pending = [];
    this.onClose = () => {};
    this.id = null;
  }

  // Messages that arrive before a handler is attached are queued.
  set onMessage(fn) {
    this._onMessage = fn;
    const q = this._pending;
    this._pending = [];
    for (const m of q) fn(m);
  }

  _deliver(msg) {
    if (this._onMessage) this._onMessage(msg);
    else this._pending.push(msg);
  }

  connect(code, hello) {
    ensurePeerLib();
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (msg) => {
        if (done) return;
        done = true;
        if (this.peer) this.peer.destroy();
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail('Could not reach that game. Check the code and make sure the host is still in the lobby.'), 15000);
      const peer = new window.Peer(undefined, peerOptions());
      this.peer = peer;
      peer.on('open', (id) => {
        this.id = id;
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          conn.send(hello);
        });
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (!done) {
            if (msg.t === 'welcome') {
              done = true;
              clearTimeout(timer);
              resolve(msg);
            } else if (msg.t === 'reject' || msg.t === 'bye') {
              clearTimeout(timer);
              fail(msg.reason || 'The host refused the connection.');
            }
            return;
          }
          this._deliver(msg);
        });
        conn.on('close', () => {
          if (done) this.onClose('Disconnected from the host.');
          else fail('Connection closed.');
        });
      });
      peer.on('error', (err) => {
        if (!done) { clearTimeout(timer); fail(describeError(err)); }
        else if (err.type !== 'peer-unavailable') this.onClose(describeError(err));
      });
    });
  }

  send(msg) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch (e) { /* ignore */ }
    }
  }

  close() {
    if (this.peer) this.peer.destroy();
  }
}

function describeError(err) {
  switch (err && err.type) {
    case 'peer-unavailable': return 'No game found with that code. It may have ended, or the code is mistyped.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Could not reach the matchmaking server. Check your internet connection.';
    case 'browser-incompatible': return 'Your browser does not support WebRTC, which this game needs.';
    case 'unavailable-id': return 'Could not reserve a room code. Please try again.';
    default: return (err && err.message) || 'Network error.';
  }
}
