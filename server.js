// Jeopardy! local server — no dependencies, just Node.
//   Run:  node server.js        (or double-click "Start Jeopardy.command")
//
// Use this to host on your own Wi-Fi without the internet. (The website
// version does the same thing peer-to-peer from the control panel.)
//   /control     host control panel (only works on this computer)
//   /board       the big game board
//   /contestant  a contestant's device  (?p=1, ?p=2, ?p=3)
//   /podium      a podium display       (?p=1, ?p=2, ?p=3)
//
// Pages get live state over Server-Sent Events (/events) and send actions
// with POST /action. All the game rules live in docs/engine.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createEngine } = require('./docs/engine.js');

const PORT = Number(process.env.PORT) || 3300;
const PUB = path.join(__dirname, 'docs');
const SAVE_FILE = path.join(__dirname, 'saved-game.json');
const SAMPLE_FILE = path.join(PUB, 'sample-game.csv');

const engine = createEngine({
  load: () => JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')),
  persist: s => fs.writeFile(SAVE_FILE, JSON.stringify(s), () => {}),
  onChange: () => broadcast(),
  urls: () => lanUrls(),
});
engine.ensureGame(fs.readFileSync(SAMPLE_FILE, 'utf8'), 'sample-game.csv');
const clients = engine.clients;
const NUM_PLAYERS = engine.NUM_PLAYERS;

function send(cl) {
  cl.res.write(`data: ${JSON.stringify({ now: Date.now(), state: engine.viewFor(cl) })}\n\n`);
}

let bcastQueued = false;
function broadcast() {
  if (bcastQueued) return;
  bcastQueued = true;
  setImmediate(() => { bcastQueued = false; for (const cl of clients) send(cl); });
}

setInterval(() => {
  for (const cl of clients) cl.res.write(`data: ${JSON.stringify({ now: Date.now() })}\n\n`);
}, 10000);

// ---------------------------------------------------------------- http

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
function lanUrls() { return lanAddresses().map(a => `http://${a}:${PORT}`); }

function isLocal(req) {
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || lanAddresses().includes(a);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PAGES = { '/': 'index.html', '/control': 'control.html', '/board': 'board.html', '/contestant': 'contestant.html', '/podium': 'podium.html', '/control.html': 'control.html' };

function serveFile(res, file, extraHeaders = {}) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/events') {
    const role = ['control', 'board', 'contestant', 'podium'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : 'board';
    if (role === 'control' && !isLocal(req)) { res.writeHead(403); res.end(); return; }
    const pi = parseInt(url.searchParams.get('p'), 10);
    const cl = { res, role, p: Number.isInteger(pi) && pi >= 0 && pi < NUM_PLAYERS ? pi : null };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    clients.add(cl);
    send(cl);
    broadcast(); // so the control panel sees who's connected
    req.on('close', () => { clients.delete(cl); broadcast(); });
    return;
  }

  if (p === '/action' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end('{"ok":false,"error":"bad json"}'); return; }
      const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let from;
      if (msg.type === 'key' || msg.role === 'control') {
        if (!isLocal(req)) return reply(403, { ok: false, error: 'Only the host computer can do that' });
        from = { role: 'control' };
      } else from = { role: msg.role, p: msg.p };
      try {
        reply(200, { ok: true, ...engine.handle(msg, from) });
      } catch (e) {
        if (!engine.isUserError(e)) console.error(e);
        reply(200, { ok: false, error: e.message });
      }
    });
    return;
  }

  // pages ask this whether they're talking to this server or playing peer-to-peer
  if (p === '/mode.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end('window.JEOPARDY_LOCAL = true;'); return; }

  if (PAGES[p]) {
    if (PAGES[p] === 'control.html' && !isLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('The control panel only opens on the host computer.'); return; }
    return serveFile(res, path.join(PUB, PAGES[p]));
  }
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); res.end(); return; }
  serveFile(res, file);
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = lanUrls();
  const base = urls[0] || `http://localhost:${PORT}`;
  console.log('\n  JEOPARDY! server is running.\n');
  console.log(`  Control panel (this Mac):  http://localhost:${PORT}/control`);
  console.log(`  Game board:                ${base}/board`);
  for (let i = 1; i <= NUM_PLAYERS; i++) console.log(`  Player ${i}:  contestant ${base}/contestant?p=${i}    podium ${base}/podium?p=${i}`);
  console.log('\n  Keep this window open during the game. Press Ctrl+C to stop.\n');
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use — is the game already running? (Or run with PORT=3400 node server.js)\n`);
  else console.error(e);
  process.exit(1);
});
