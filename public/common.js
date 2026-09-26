// Shared by every screen: live connection to the server, sending actions,
// timers, money formatting, and forwarding USB buzzer presses.

const Q = new URLSearchParams(location.search);

const J = {
  offset: 0,
  state: null,
  role: null,
  p: null,

  connect(role, p, onState) {
    this.role = role;
    this.p = p;
    const es = new EventSource('/events?role=' + role + (p != null ? '&p=' + p : ''));
    es.onopen = () => document.body.classList.remove('offline');
    es.onerror = () => document.body.classList.add('offline');
    es.onmessage = e => {
      const m = JSON.parse(e.data);
      this.offset = m.now - Date.now();
      if (m.state) {
        const prev = this.state;
        this.state = m.state;
        onState(m.state, prev);
      }
    };
  },

  send(type, data = {}) {
    return fetch('/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: this.role, p: this.p, type, ...data }),
    }).then(r => r.json()).catch(e => ({ ok: false, error: 'Lost connection to the game computer' }));
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
  // press to the server, which decides whose buzzer it is.
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
