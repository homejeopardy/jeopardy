// Shared by every screen: the live connection, sending actions, timers,
// money formatting, and forwarding USB buzzer presses.
//
// Two ways to play:
//   • Website (default): the control panel runs the game engine itself and
//     the other screens connect to it peer-to-peer with a room code (PeerJS).
//   • Local server (node server.js): every page talks to the server, which
//     sets window.JEOPARDY_LOCAL via /mode.js.

const Q = new URLSearchParams(location.search);
const PEER_PREFIX = 'hj-jeopardy-';
const ROOM_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O — easy to read aloud

const J = {
  offset: 0,
  state: null,
  role: null,
  p: null,
  local: !!window.JEOPARDY_LOCAL,
  room: (Q.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),

  connect(role, p, onState) {
    this.role = role;
    this.p = p;
    this.onState = onState;
    if (this.local) this._connectServer();
    else if (role === 'control') this._host();
    else this._join();
  },

  send(type, data = {}) {
    if (this.local) {
      return fetch('/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: this.role, p: this.p, type, ...data }),
      }).then(r => r.json()).catch(() => ({ ok: false, error: 'Lost connection to the game computer' }));
    }
    if (this.role === 'control') {
      try { return Promise.resolve({ ok: true, ...this.engine.handle({ type, ...data }, { role: 'control' }) }); }
      catch (e) {
        if (!this.engine.isUserError(e)) console.error(e);
        return Promise.resolve({ ok: false, error: e.message });
      }
    }
    if (!this.conn || !this.conn.open) return Promise.resolve({ ok: false, error: 'Not connected to the host yet' });
    const id = (this._nextId = (this._nextId || 0) + 1);
    return new Promise(resolve => {
      this._pending[id] = resolve;
      this.conn.send({ id, type, ...data });
      setTimeout(() => { if (this._pending[id]) { delete this._pending[id]; resolve({ ok: false, error: 'The host didn’t answer' }); } }, 5000);
    });
  },

  _receive(m) {
    this.offset = m.now - Date.now();
    this._lastHeard = Date.now();
    if (m.state) {
      const prev = this.state;
      this.state = m.state;
      this.onState(m.state, prev);
    }
  },

  status(text) {
    if (text) document.body.dataset.offline = text;
    else delete document.body.dataset.offline;
  },

  // ---------------------------------------------------------- local server
  _connectServer() {
    const es = new EventSource('/events?role=' + this.role + (this.p != null ? '&p=' + this.p : ''));
    es.onopen = () => this.status(null);
    es.onerror = () => this.status('Reconnecting to the game computer…');
    es.onmessage = e => this._receive(JSON.parse(e.data));
  },

  // ---------------------------------------------------------- website: host
  // The control panel IS the game server. It keeps the game in this browser
  // (localStorage), so reloading the page doesn't lose anything.
  _host() {
    this.room = this.hostRoom();
    const self = { role: 'control' };
    const push = cl => {
      const msg = { now: Date.now(), state: this.engine.viewFor(cl) };
      if (cl === self) this._receive(JSON.parse(JSON.stringify(msg)));
      else if (cl.conn.open) cl.conn.send(msg);
    };
    let queued = false;
    const broadcast = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; for (const cl of this.engine.clients) push(cl); }, 0);
    };
    this.engine = createEngine({
      load: () => JSON.parse(localStorage.getItem('jeopardy-game') || 'null'),
      persist: s => { try { localStorage.setItem('jeopardy-game', JSON.stringify(s)); } catch {} },
      onChange: broadcast,
      saveDelay: 0, // localStorage is fast; don't lose the last change to a reload
    });
    this.engine.clients.add(self);
    fetch('sample-game.csv').then(r => r.text()).then(t => this.engine.ensureGame(t, 'sample-game.csv')).catch(() => {});
    broadcast();

    if (!window.Peer) { this.status('Couldn’t load the connection library — check the internet connection, then reload.'); return; }
    let tries = 0;
    const open = () => {
      this.status(`Opening room ${this.room}…`);
      const peer = (this.peer = new Peer(PEER_PREFIX + this.room, { debug: 1 }));
      peer.on('open', () => { tries = 0; this.hostOnline = true; this.status(null); broadcast(); });
      peer.on('connection', conn => {
        const md = conn.metadata || {};
        const role = ['board', 'contestant', 'podium'].includes(md.role) ? md.role : 'board';
        const pi = parseInt(md.p, 10);
        const cl = { role, p: pi >= 0 && pi < this.engine.NUM_PLAYERS ? pi : null, conn };
        conn.on('open', () => { this.engine.clients.add(cl); push(cl); broadcast(); });
        conn.on('data', msg => {
          if (!msg || typeof msg !== 'object') return;
          let r;
          try { r = { ok: true, ...this.engine.handle(msg, { role: cl.role, p: cl.p }) }; }
          catch (e) { if (!this.engine.isUserError(e)) console.error(e); r = { ok: false, error: e.message }; }
          if (msg.id != null && conn.open) conn.send({ reply: msg.id, ...r });
        });
        const gone = () => { if (this.engine.clients.delete(cl)) broadcast(); };
        conn.on('close', gone);
        conn.on('error', gone);
      });
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      peer.on('error', e => {
        this.hostOnline = false;
        broadcast();
        if (e.type === 'unavailable-id') {
          // Usually this room is still closing from a reload. Retry a few times.
          peer.destroy();
          if (++tries <= 6) { this.status(`Room ${this.room} is still closing from last time — retrying…`); setTimeout(open, 3000); }
          else this.status(`Room ${this.room} is in use — is the control panel open in another tab? If not, choose “New room code” in Setup.`);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
          this.status('Can’t reach the connection server — check the internet. Retrying…');
          peer.destroy(); setTimeout(open, 3000);
        } else console.warn('peer error', e.type, e);
      });
    };
    open();
    // keep clocks in sync and let screens notice if the host goes away
    setInterval(() => {
      for (const cl of this.engine.clients) if (cl.conn && cl.conn.open) cl.conn.send({ now: Date.now() });
    }, 4000);
  },

  hostRoom() {
    let r = null;
    try { r = localStorage.getItem('jeopardy-room'); } catch {}
    if (!r) { r = this.newRoomCode(); try { localStorage.setItem('jeopardy-room', r); } catch {} }
    return r;
  },
  newRoomCode() {
    return Array.from({ length: 4 }, () => ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]).join('');
  },

  // ---------------------------------------------------------- website: other screens
  _join() {
    this._pending = {};
    if (!window.Peer) { this.status('Couldn’t load the connection library — check the internet connection, then reload.'); return; }
    this.status(`Connecting to room ${this.room}…`);
    const peer = new Peer({ debug: 1 });
    let retry = null;
    const later = (ms, why) => {
      if (why) this.status(why);
      clearTimeout(retry);
      retry = setTimeout(connect, ms);
    };
    const connect = () => {
      clearTimeout(retry);
      if (this.conn) { try { this.conn.close(); } catch {} }
      if (peer.disconnected) { peer.reconnect(); return later(2000); }
      const conn = (this.conn = peer.connect(PEER_PREFIX + this.room, { metadata: { role: this.role, p: this.p }, serialization: 'json', reliable: true }));
      conn.on('open', () => { this._lastHeard = Date.now(); this.status(null); });
      conn.on('data', m => {
        if (m && m.reply != null) { const f = this._pending[m.reply]; delete this._pending[m.reply]; if (f) f(m); return; }
        if (m && m.now) this._receive(m);
      });
      conn.on('close', () => { if (this.conn === conn) later(1500, `Lost the host — reconnecting to room ${this.room}…`); });
      // if the host never answers, try again
      setTimeout(() => { if (this.conn === conn && !conn.open) later(0, `Waiting for room ${this.room} — is the control panel open?`); }, 6000);
    };
    peer.on('open', connect);
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') later(3000, `Waiting for room ${this.room} — is the control panel open? Check the room code.`);
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) later(3000, 'Can’t reach the connection server — check the internet. Retrying…');
      else console.warn('peer error', e.type, e);
    });
    // Host went quiet (closed or reloaded) without a clean goodbye
    setInterval(() => {
      if (this.conn && this.conn.open && Date.now() - this._lastHeard > 12000) later(0, `Lost the host — reconnecting to room ${this.room}…`);
    }, 3000);
  },

  // Pages other than the control panel need a room code on the website.
  // Returns true (and shows a form) when it's missing.
  needRoom(title) {
    if (this.local || this.room) return false;
    document.body.innerHTML = `<form class="picker" id="roomForm">
        <h1 class="logo">${this.esc(title)}</h1>
        <p>Enter the room code shown on the host’s control panel.</p>
        <input id="roomIn" maxlength="6" autocomplete="off" autocapitalize="characters" placeholder="ABCD"
          style="font-size:40px;text-align:center;letter-spacing:.3em;padding:12px;border-radius:10px;border:0;width:260px;text-transform:uppercase;margin:0 auto">
        <button class="joinbtn">Join</button></form>`;
    document.getElementById('roomIn').focus();
    document.getElementById('roomForm').onsubmit = e => {
      e.preventDefault();
      const code = document.getElementById('roomIn').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!code) return;
      const q = new URLSearchParams(location.search);
      q.set('room', code);
      location.search = q.toString();
    };
    return true;
  },

  // Link to another screen, keeping the room code
  link(page, extra = {}, base) {
    const q = new URLSearchParams();
    if (!this.local && this.room) q.set('room', this.room);
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    const qs = q.toString();
    const path = page + '.html' + (qs ? '?' + qs : '');
    return base ? base.replace(/\/$/, '') + '/' + path : path;
  },

  now() { return Date.now() + this.offset; },
  remaining(t) { return t ? Math.max(0, t.start + t.dur - this.now()) : 0; },
  fraction(t) { return t ? this.remaining(t) / t.dur : 0; },

  money(n) {
    n = Number(n) || 0;
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  // Re-render a container without losing what's being typed in it.
  keepFocus(fn) {
    const a = document.activeElement;
    const id = a && a.id;
    const val = a && 'value' in a ? a.value : null;
    let sel = null;
    try { sel = [a.selectionStart, a.selectionEnd]; } catch {}
    fn();
    if (id) {
      const n = document.getElementById(id);
      if (n && n !== a) {
        if (val != null) n.value = val;
        n.focus();
        try { if (sel) n.setSelectionRange(sel[0], sel[1]); } catch {}
      }
    }
  },

  // USB buzzers show up as a keyboard or a game controller. Forward every
  // press to the game, which decides whose buzzer it is.
  forwardBuzzers() {
    addEventListener('keydown', e => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'Tab' || e.key === 'Escape') return;
      e.preventDefault(); // stop Space/Enter from clicking a focused button
      this.send('key', { code: e.code || e.key });
    });
    const prev = {};
    setInterval(() => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        gp.buttons.forEach((b, i) => {
          const id = `Pad${gp.index}-Button${i}`;
          if (b.pressed && !prev[id]) this.send('key', { code: id });
          prev[id] = b.pressed;
        });
      }
    }, 8);
  },
};

// Anything with data-timer / data-timerbar shows a live countdown.
// Set el._timer = {start, dur} when rendering.
setInterval(() => {
  document.querySelectorAll('[data-timer]').forEach(el => {
    el.textContent = el._timer ? Math.ceil(J.remaining(el._timer) / 1000) : '';
  });
  document.querySelectorAll('[data-timerbar]').forEach(el => {
    el.style.transform = `scaleX(${el._timer ? J.fraction(el._timer) : 0})`;
  });
}, 50);
