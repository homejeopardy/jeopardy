// Jeopardy! game server — no dependencies, just Node.
//   Run:  node server.js        (or double-click "Start Jeopardy.command")
//
// This Mac runs the server. Every screen is a web page:
//   /control     host control panel (only works on this Mac)
//   /board       the big game board (projector / TV)
//   /contestant  a contestant's own device  (?p=1, ?p=2, ?p=3)
//   /podium      a podium display           (?p=1, ?p=2, ?p=3)
//
// Pages receive live state over Server-Sent Events (/events) and send
// actions with POST /action. USB buzzers act as keyboards / game
// controllers, so the control panel and board pages forward their key
// presses here as "key" actions.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3300;
const PUB = path.join(__dirname, 'public');
const SAVE_FILE = path.join(__dirname, 'saved-game.json');
const SAMPLE_FILE = path.join(__dirname, 'sample-game.csv');
const NUM_PLAYERS = 3;
const EARLY_BUZZ_PENALTY_MS = 250; // like the real show: buzz too early, you're locked out briefly

// ---------------------------------------------------------------- state

function freshState() {
  return {
    game: null,
    gameName: '',
    warnings: [],
    players: Array.from({ length: NUM_PLAYERS }, (_, i) => ({ name: `Player ${i + 1}`, score: 0 })),
    keys: {}, // buzzer input code -> player index
    settings: {
      buzzWindow: 5,    // seconds contestants have to buzz in (0 = no limit)
      answerTime: 5,    // seconds a contestant has to answer after buzzing (podium lights)
      finalTime: 30,    // Final Jeopardy think time
      autoReopen: true, // reopen buzzers for the others after a wrong answer
      phoneBuzz: false, // show a buzz button on contestant devices (for testing without USB buzzers)
      boardScores: false, // show a score strip along the bottom of the game board
    },
    view: 'title', // title | board | clue | final | end
    round: 0,      // 0 = Jeopardy, 1 = Double Jeopardy, 2 = Final
    control: 0,    // player who picks next
    used: {},      // "round-c-r" -> true
    filledRound: -1,
    fillSeq: 0,
    clue: null,
    final: null,
    sfx: { id: null, seq: 0 },
  };
}

// Transient (not saved, not undone)
let learning = null;         // player index waiting for a buzzer press
let lastInput = null;        // { code, player, at } — for the buzzer test readout
let ping = { p: null, at: 0, seq: 0 }; // flash a podium when its buzzer is pressed outside a clue
const penalty = {};          // player -> time their early-buzz lockout ends
const lastKeyAt = {};        // de-dupe the same key arriving from two pages
const timers = { buzz: null, ans: null, final: null };
const history = [];

function loadState() {
  let s;
  try {
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    const f = freshState();
    s = { ...f, ...saved, settings: { ...f.settings, ...saved.settings } };
  } catch {
    s = freshState();
  }
  // timers don't survive a restart
  if (s.clue) {
    if (s.clue.buzz === 'open') s.clue.buzz = 'closed';
    s.clue.buzzTimer = null;
    s.clue.ansTimer = null;
  }
  if (s.final && s.final.step === 'thinking') { s.final.step = 'locked'; s.final.timer = null; }
  if (!s.game) {
    try {
      const r = parseGame(fs.readFileSync(SAMPLE_FILE, 'utf8'));
      s.game = r.game; s.warnings = r.warnings; s.gameName = 'sample-game.csv';
    } catch (e) { console.log('Could not load sample game:', e.message); }
  }
  return s;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(SAVE_FILE, JSON.stringify(S), () => {});
  }, 300);
}

function commit() { save(); broadcast(); }

function sfx(id) { S.sfx = { id, seq: S.sfx.seq + 1 }; }

function clearTimers() {
  for (const k of Object.keys(timers)) { clearTimeout(timers[k]); timers[k] = null; }
}

function snapshot() {
  const { players, view, round, control, used, clue, final, filledRound } = S;
  history.push(JSON.stringify({ players, view, round, control, used, clue, final, filledRound }));
  if (history.length > 100) history.shift();
}

// ---------------------------------------------------------------- CSV

function parseRows(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const ROUND_NAMES = [
  ['J', '1', 'JEOPARDY', 'R1', 'ROUND1', 'SINGLE', 'SINGLEJEOPARDY'],
  ['DJ', '2', 'DOUBLE', 'DOUBLEJEOPARDY', 'R2', 'ROUND2'],
  ['FJ', 'F', 'FINAL', 'FINALJEOPARDY', '3'],
];

function parseGame(text) {
  const rows = parseRows(text);
  if (!rows.length) throw new Error('The file is empty.');
  const hdr = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names) => hdr.findIndex(h => names.includes(h));
  const ci = {
    round: col('round', 'rnd'),
    cat: col('category', 'cat'),
    value: col('value', 'amount', 'points', 'dollars'),
    clue: col('clue', 'question'),
    answer: col('answer', 'response', 'correctresponse'),
    dd: col('dailydouble', 'dd', 'double'),
  };
  if (ci.round < 0 || ci.cat < 0 || ci.clue < 0 || ci.answer < 0) {
    throw new Error('The first row must be column headings that include: round, category, clue, answer (value and daily_double are optional).');
  }
  const rounds = [new Map(), new Map()];
  let final = null;
  const warnings = [];
  rows.slice(1).forEach((r, n) => {
    const g = k => (ci[k] >= 0 ? (r[ci[k]] || '').trim() : '');
    const rd = g('round').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const idx = ROUND_NAMES.findIndex(names => names.includes(rd));
    if (idx < 0) { warnings.push(`Row ${n + 2}: unknown round "${g('round')}" — use J, DJ or FJ. Skipped.`); return; }
    if (idx === 2) {
      if (final) warnings.push(`Row ${n + 2}: more than one Final Jeopardy row — using the last one.`);
      final = { category: g('cat'), text: g('clue'), answer: g('answer') };
      return;
    }
    const name = g('cat') || '(no category)';
    if (!rounds[idx].has(name)) rounds[idx].set(name, []);
    rounds[idx].get(name).push({
      value: parseInt(g('value').replace(/[^0-9]/g, ''), 10) || null,
      text: g('clue'),
      answer: g('answer'),
      dd: /^(y|yes|x|1|true|dd|daily ?double)$/i.test(g('dd')),
    });
  });

  const out = rounds.map((m, ri) => {
    let cats = [...m.entries()];
    const label = ri === 0 ? 'Jeopardy' : 'Double Jeopardy';
    if (cats.length > 6) { warnings.push(`${label} round has ${cats.length} categories — only the first 6 are used.`); cats = cats.slice(0, 6); }
    return {
      categories: cats.map(([name, clues]) => {
        if (clues.length > 5) { warnings.push(`"${name}" has ${clues.length} clues — only the first 5 are used.`); clues = clues.slice(0, 5); }
        return { name, clues: clues.map((c, r) => ({ ...c, value: c.value || (r + 1) * 200 * (ri + 1) })) };
      }),
    };
  });

  // No Daily Doubles marked? Hide 1 in Jeopardy and 2 in Double Jeopardy, in lower rows, different categories.
  out.forEach((rd, ri) => {
    const all = [];
    rd.categories.forEach((cat, c) => cat.clues.forEach((cl, r) => all.push({ cl, c, r })));
    if (!all.length || all.some(x => x.cl.dd)) return;
    const want = ri === 0 ? 1 : 2;
    const pool = shuffle(all.filter(x => x.r >= 2).length >= want ? all.filter(x => x.r >= 2) : all);
    const usedCats = new Set();
    for (const x of pool) {
      if (usedCats.size >= want) break;
      if (usedCats.has(x.c)) continue;
      x.cl.dd = true; usedCats.add(x.c);
    }
  });

  if (!out[0].categories.length) throw new Error('No Jeopardy-round clues found (rows with round = J).');
  if (!out[1].categories.length) warnings.push('No Double Jeopardy clues — the game will go straight to Final Jeopardy.');
  if (!final) warnings.push('No Final Jeopardy row (round = FJ) — the game will end after the last round.');
  return { game: { rounds: out, final }, warnings };
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- game logic

const usedKey = (round, c, r) => `${round}-${c}-${r}`;

function roundMax(round) {
  let max = round === 1 ? 2000 : 1000;
  const rd = S.game && S.game.rounds[round];
  if (rd) for (const cat of rd.categories) for (const cl of cat.clues) max = Math.max(max, cl.value);
  return max;
}

function roundHasClues(round) {
  return !!(S.game && S.game.rounds[round] && S.game.rounds[round].categories.length);
}

function enterBoard() {
  S.view = 'board';
  S.clue = null;
  if (S.filledRound !== S.round) { S.filledRound = S.round; S.fillSeq++; sfx('fill'); }
}

function openBuzzers() {
  const c = S.clue;
  if (!c || c.dd || !c.shown || c.answerShown) return;
  c.buzz = 'open';
  c.buzzed = null;
  c.ansTimer = null;
  c.timesUp = false;
  clearTimeout(timers.ans);
  clearTimeout(timers.buzz);
  const dur = S.settings.buzzWindow * 1000;
  c.buzzTimer = dur > 0 ? { start: Date.now(), dur } : null;
  if (dur > 0) {
    timers.buzz = setTimeout(() => {
      if (S.clue === c && c.buzz === 'open') {
        c.buzz = 'closed'; c.buzzTimer = null; c.timesUp = true;
        sfx('timesup'); commit();
      }
    }, dur);
  }
}

function buzz(p) {
  const now = Date.now();
  const c = S.clue;
  if (S.view !== 'clue' || !c || c.dd || !c.shown || c.answerShown) {
    ping = { p, at: now, seq: ping.seq + 1 }; // buzzer test — flash that podium
    return true;
  }
  if (c.buzz === 'buzzed' || c.locked.includes(p)) return false;
  if ((penalty[p] || 0) > now) return false;
  if (c.buzz !== 'open') { penalty[p] = now + EARLY_BUZZ_PENALTY_MS; return false; }
  c.buzz = 'buzzed';
  c.buzzed = p;
  c.buzzTimer = null;
  clearTimeout(timers.buzz);
  const dur = S.settings.answerTime * 1000;
  c.ansTimer = { start: now, dur };
  c.answerTimeUp = false;
  timers.ans = setTimeout(() => {
    if (S.clue === c && c.buzzed === p && c.buzz === 'buzzed') {
      c.ansTimer = null; c.answerTimeUp = true; sfx('timesup'); commit();
    }
  }, dur);
  return true;
}

function startFinal() {
  clearTimers();
  S.round = 2;
  S.clue = null;
  if (!S.game.final) { S.view = 'end'; return; }
  S.view = 'final';
  S.final = {
    step: 'category', // category -> clue -> thinking -> locked -> reveal
    eligible: S.players.map(p => p.score > 0),
    wagers: S.players.map(() => null),
    answers: S.players.map(() => ''),
    timer: null,
    cur: null,          // player being revealed
    shown: S.players.map(() => false),   // response shown on board
    results: S.players.map(() => null),  // null | {correct}
    answerShown: false,
  };
  sfx('final');
}

class ActionError extends Error {}
const need = (cond, msg) => { if (!cond) throw new ActionError(msg); };
const toInt = v => { const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : NaN; };

// Host actions. Ones listed in UNDOABLE are snapshotted first.
const UNDOABLE = new Set(['setScore', 'adjust', 'setControl', 'showTitle', 'showBoard', 'selectClue', 'setDDPlayer', 'ddWager',
  'judge', 'revealAnswer', 'backToBoard', 'nextRound', 'setRound', 'startFinal', 'finalShowClue', 'finalStartTimer',
  'finalLock', 'finalShow', 'finalJudge', 'finalShowAnswer', 'endGame', 'newGame', 'finalSetWager', 'finalSetAnswer', 'unuseClue']);

const host = {
  loadGame({ text, name }) {
    const r = parseGame(String(text || ''));
    clearTimers();
    S.game = r.game; S.warnings = r.warnings; S.gameName = name || 'game.csv';
    S.used = {}; S.round = 0; S.view = 'title'; S.clue = null; S.final = null; S.filledRound = -1;
    history.length = 0;
    return { warnings: r.warnings };
  },
  setName({ i, name }) { need(S.players[i], 'No such player'); S.players[i].name = String(name || '').slice(0, 30) || `Player ${i + 1}`; },
  setScore({ i, score }) { need(S.players[i], 'No such player'); const n = toInt(score); need(!isNaN(n), 'Not a number'); S.players[i].score = n; },
  adjust({ i, delta }) { need(S.players[i], 'No such player'); S.players[i].score += toInt(delta) || 0; },
  setControl({ i }) { need(S.players[i], 'No such player'); S.control = i; },
  learnKey({ i }) { learning = i; },
  cancelLearn() { learning = null; },
  clearKey({ i }) { for (const k of Object.keys(S.keys)) if (S.keys[k] === i) delete S.keys[k]; },
  setting({ key, value }) {
    need(key in S.settings, 'Unknown setting');
    S.settings[key] = typeof S.settings[key] === 'boolean' ? !!value : Math.max(0, Number(value) || 0);
  },
  playSound({ id }) { sfx(id); },

  showTitle() { clearTimers(); S.view = 'title'; S.clue = null; },
  showBoard() { need(S.round < 2, 'Final Jeopardy has no board'); clearTimers(); enterBoard(); },
  selectClue({ c, r }) {
    need(S.round < 2 && S.game, 'No board in this round');
    const cl = S.game.rounds[S.round].categories[c]?.clues[r];
    need(cl, 'No clue there');
    need(!S.used[usedKey(S.round, c, r)], 'That clue has already been played');
    clearTimers();
    S.used[usedKey(S.round, c, r)] = true;
    S.view = 'clue';
    S.clue = {
      c, r, cat: S.game.rounds[S.round].categories[c].name, value: cl.value, text: cl.text, answer: cl.answer, dd: cl.dd,
      shown: !cl.dd, answerShown: false, buzz: 'closed', buzzed: null, locked: [], buzzTimer: null, ansTimer: null,
      timesUp: false, answerTimeUp: false,
      ddPlayer: cl.dd ? S.control : null, ddWager: null,
    };
    if (cl.dd) sfx('dd');
  },
  unuseClue({ c, r }) { delete S.used[usedKey(S.round, c, r)]; },
  setDDPlayer({ i }) { need(S.clue && S.clue.dd, 'Not a Daily Double'); need(S.players[i], 'No such player'); S.clue.ddPlayer = i; },
  ddWager({ amount }) {
    const c = S.clue;
    need(c && c.dd, 'Not a Daily Double');
    const n = toInt(amount);
    const max = Math.max(S.players[c.ddPlayer].score, roundMax(S.round));
    need(!isNaN(n) && n >= 0 && n <= max, `Wager must be between $0 and $${max.toLocaleString()}`);
    c.ddWager = n; c.shown = true;
  },
  openBuzz() { need(S.clue, 'No clue showing'); openBuzzers(); },
  closeBuzz() {
    const c = S.clue; need(c, 'No clue showing');
    clearTimeout(timers.buzz); c.buzz = c.buzz === 'buzzed' ? 'buzzed' : 'closed'; c.buzzTimer = null;
  },
  judge({ correct }) {
    const c = S.clue;
    need(c, 'No clue showing');
    const p = c.dd ? c.ddPlayer : c.buzzed;
    need(p != null, 'Nobody has buzzed in');
    need(!c.dd || c.ddWager != null, 'Enter the wager first');
    const amt = c.dd ? c.ddWager : c.value;
    clearTimeout(timers.ans);
    c.ansTimer = null; c.answerTimeUp = false;
    if (correct) {
      S.players[p].score += amt;
      S.control = p;
      c.answerShown = true; c.buzz = 'closed'; c.result = { p, correct: true };
      clearTimers();
    } else {
      S.players[p].score -= amt;
      if (c.dd) { c.answerShown = true; c.result = { p, correct: false }; return; }
      c.locked.push(p);
      c.buzzed = null; c.buzz = 'closed';
      const anyoneLeft = S.players.some((_, i) => !c.locked.includes(i));
      if (S.settings.autoReopen && anyoneLeft) openBuzzers();
    }
  },
  revealAnswer() { const c = S.clue; need(c, 'No clue showing'); clearTimers(); c.answerShown = true; c.buzz = 'closed'; c.buzzTimer = null; c.ansTimer = null; c.shown = true; },
  backToBoard() { clearTimers(); need(S.round < 2, 'No board in this round'); enterBoard(); },
  nextRound() {
    clearTimers();
    if (S.round === 0 && roundHasClues(1)) {
      S.round = 1;
      // the player furthest behind picks first in Double Jeopardy
      let low = 0; S.players.forEach((p, i) => { if (p.score < S.players[low].score) low = i; });
      S.control = low;
      enterBoard();
    } else if (S.round < 2) startFinal();
    else S.view = 'end';
  },
  setRound({ round }) {
    clearTimers();
    round = toInt(round);
    need([0, 1, 2].includes(round), 'Bad round');
    if (round === 2) return startFinal();
    need(roundHasClues(round), 'That round has no clues');
    S.round = round; S.final = null; enterBoard();
  },
  startFinal() { startFinal(); },
  finalSetWager({ i, amount }) {
    const f = S.final; need(f, 'Not in Final Jeopardy');
    const n = toInt(amount);
    need(!isNaN(n) && n >= 0 && n <= Math.max(0, S.players[i].score), `Wager must be between $0 and ${S.players[i].score}`);
    f.wagers[i] = n;
  },
  finalSetAnswer({ i, text }) { const f = S.final; need(f, 'Not in Final Jeopardy'); f.answers[i] = String(text || '').slice(0, 200); },
  finalToggleEligible({ i }) { const f = S.final; need(f, 'Not in Final Jeopardy'); f.eligible[i] = !f.eligible[i]; },
  finalShowClue() { const f = S.final; need(f, 'Not in Final Jeopardy'); f.step = 'clue'; },
  finalStartTimer() {
    const f = S.final; need(f, 'Not in Final Jeopardy');
    f.step = 'thinking';
    const dur = S.settings.finalTime * 1000;
    f.timer = { start: Date.now(), dur };
    sfx('think');
    clearTimeout(timers.final);
    timers.final = setTimeout(() => { if (S.final === f && f.step === 'thinking') { f.step = 'locked'; f.lockedAt = Date.now(); f.timer = null; commit(); } }, dur);
  },
  finalLock() { const f = S.final; need(f, 'Not in Final Jeopardy'); clearTimeout(timers.final); f.step = 'locked'; f.lockedAt = Date.now(); f.timer = null; sfx('stop'); },
  finalShow({ i }) {
    const f = S.final; need(f, 'Not in Final Jeopardy'); need(S.players[i], 'No such player');
    clearTimeout(timers.final);
    if (f.step === 'thinking') sfx('stop');
    f.step = 'reveal'; f.timer = null; f.cur = i; f.shown[i] = true;
  },
  finalJudge({ i, correct }) {
    const f = S.final; need(f, 'Not in Final Jeopardy'); need(S.players[i], 'No such player');
    need(!f.results[i], 'Already judged — use Undo to change it');
    const w = f.wagers[i] || 0;
    S.players[i].score += correct ? w : -w;
    f.results[i] = { correct: !!correct };
    f.step = 'reveal'; f.cur = i; f.shown[i] = true;
  },
  finalShowAnswer() { const f = S.final; need(f, 'Not in Final Jeopardy'); f.answerShown = true; f.step = 'reveal'; f.cur = null; },
  endGame() { clearTimers(); S.view = 'end'; },
  newGame() {
    clearTimers();
    S.players.forEach(p => { p.score = 0; });
    S.used = {}; S.round = 0; S.view = 'title'; S.clue = null; S.final = null; S.filledRound = -1; S.control = 0;
  },
  undo() {
    need(history.length, 'Nothing to undo');
    clearTimers();
    const prev = JSON.parse(history.pop());
    Object.assign(S, prev);
    if (S.clue) { if (S.clue.buzz === 'open') S.clue.buzz = 'closed'; S.clue.buzzTimer = null; S.clue.ansTimer = null; }
    if (S.final && S.final.step === 'thinking') { S.final.step = 'locked'; S.final.timer = null; }
  },
};

// Contestant device actions
const contestant = {
  setName({ p, name }) {
    need(S.view === 'title', 'Names can only be changed before the game starts');
    host.setName({ i: p, name });
  },
  wager({ p, amount }) {
    const f = S.final;
    need(f && f.step === 'category', 'Wagers are closed');
    need(f.eligible[p], 'You are not playing Final Jeopardy');
    const n = toInt(amount);
    const max = Math.max(0, S.players[p].score);
    need(!isNaN(n) && n >= 0 && n <= max, `Wager between $0 and $${max.toLocaleString()}`);
    f.wagers[p] = n;
  },
  answer({ p, text }) {
    const f = S.final;
    need(f && f.eligible[p], 'Not playing Final Jeopardy');
    const graceOk = f.step === 'locked' && f.lockedAt && Date.now() - f.lockedAt < 1500;
    need(f.step === 'clue' || f.step === 'thinking' || graceOk, "Time's up — answers are locked");
    f.answers[p] = String(text || '').slice(0, 200);
  },
  buzz({ p }) {
    need(S.settings.phoneBuzz, 'Device buzzers are turned off');
    buzz(p);
  },
};

function onKey(code) {
  const now = Date.now();
  if (now - (lastKeyAt[code] || 0) < 40) return; // same press seen from two pages
  lastKeyAt[code] = now;
  if (learning != null) {
    for (const k of Object.keys(S.keys)) if (S.keys[k] === learning) delete S.keys[k];
    S.keys[code] = learning;
    lastInput = { code, player: learning, at: now };
    learning = null;
    return;
  }
  const p = S.keys[code];
  lastInput = { code, player: p ?? null, at: now };
  if (p != null) buzz(p);
}

let S = loadState();

// ---------------------------------------------------------------- views

const clients = new Set();

function online(role, p) {
  let n = 0;
  for (const c of clients) if (c.role === role && c.p === p) n++;
  return n;
}

function publicView(cl) {
  const v = {
    view: S.view, round: S.round, control: S.control, fillSeq: S.fillSeq, sfx: S.sfx, ping,
    settings: { phoneBuzz: S.settings.phoneBuzz, boardScores: S.settings.boardScores, finalTime: S.settings.finalTime },
    players: S.players.map(p => ({ name: p.name, score: p.score })),
    board: null, clue: null, final: null,
  };
  if (S.game && S.round < 2 && S.game.rounds[S.round]) {
    v.board = S.game.rounds[S.round].categories.map((cat, c) => ({
      name: cat.name,
      clues: cat.clues.map((x, r) => ({ value: x.value, used: !!S.used[usedKey(S.round, c, r)] })),
    }));
  }
  if (S.clue) {
    const c = S.clue;
    v.clue = {
      c: c.c, r: c.r, cat: c.cat, value: c.value, dd: c.dd, ddPlayer: c.ddPlayer, ddWager: c.ddWager, shown: c.shown,
      text: c.shown ? c.text : null, answer: c.answerShown ? c.answer : null,
      buzz: c.buzz, buzzed: c.buzzed, locked: c.locked, buzzTimer: c.buzzTimer, ansTimer: c.ansTimer, timesUp: c.timesUp,
      result: c.result || null,
    };
  }
  if (S.final && S.game && S.game.final) {
    const f = S.final;
    const mine = i => cl.role === 'contestant' && cl.p === i;
    const pastClue = ['clue', 'thinking', 'locked', 'reveal'].includes(f.step);
    v.final = {
      step: f.step, eligible: f.eligible, timer: f.timer, cur: f.cur, shown: f.shown, results: f.results,
      category: S.game.final.category,
      text: pastClue ? S.game.final.text : null,
      answer: f.answerShown ? S.game.final.answer : null,
      wagerIn: f.wagers.map(w => w != null),
      answerIn: f.answers.map(a => !!a),
      wagers: f.wagers.map((w, i) => (f.results[i] || mine(i) ? w : null)),
      answers: f.answers.map((a, i) => (f.shown[i] || mine(i) ? a : null)),
    };
  }
  return v;
}

function controlView() {
  return {
    ...S,
    learning, lastInput, ping,
    canUndo: history.length > 0,
    online: S.players.map((_, i) => ({ contestant: online('contestant', i), podium: online('podium', i) })),
    boards: online('board', null),
    urls: lanUrls(),
    roundMax: S.round < 2 ? roundMax(S.round) : 0,
  };
}

function send(cl) {
  const state = cl.role === 'control' ? controlView() : publicView(cl);
  cl.res.write(`data: ${JSON.stringify({ now: Date.now(), state })}\n\n`);
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
const PAGES = { '/': 'index.html', '/control': 'control.html', '/board': 'board.html', '/contestant': 'contestant.html', '/podium': 'podium.html' };

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
      try {
        let result;
        if (msg.type === 'key') {
          if (!isLocal(req)) return reply(403, { ok: false, error: 'Buzzers must be plugged into the host computer' });
          onKey(String(msg.code || '').slice(0, 60));
        } else if (msg.role === 'control') {
          if (!isLocal(req)) return reply(403, { ok: false, error: 'The control panel only works on the host computer' });
          const fn = host[msg.type];
          need(fn, `Unknown action ${msg.type}`);
          if (UNDOABLE.has(msg.type)) snapshot();
          try { result = fn(msg); } catch (e) { if (UNDOABLE.has(msg.type)) history.pop(); throw e; }
        } else if (msg.role === 'contestant') {
          const fn = contestant[msg.type];
          need(fn, `Unknown action ${msg.type}`);
          const pi = parseInt(msg.p, 10);
          need(pi >= 0 && pi < NUM_PLAYERS, 'Pick a player number');
          result = fn({ ...msg, p: pi });
        } else {
          need(false, 'Not allowed');
        }
        commit();
        reply(200, { ok: true, ...(result || {}) });
      } catch (e) {
        if (!(e instanceof ActionError) && !/^(The |No |Missing|Row )/.test(e.message)) console.error(e);
        reply(200, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (p === '/sample-game.csv') return serveFile(res, SAMPLE_FILE, { 'Content-Disposition': 'attachment; filename="jeopardy-template.csv"' });

  if (PAGES[p]) {
    if (p === '/control' && !isLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('The control panel only opens on the host computer.'); return; }
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
