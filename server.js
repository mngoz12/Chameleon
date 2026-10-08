const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const T = require('./topics');
const app = express();
const srv = http.createServer(app);
const io = new Server(srv);
app.use(express.static('public'));

const TOPICS = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.split(',')]));
const BOTS = ['Pip', 'Juniper', 'Moss', 'Bramble', 'Fern', 'Sprout', 'Clover', 'Newt'];
const rooms = {};
const pick = a => a[Math.random() * a.length | 0];
const sleep = ms => new Promise(x => setTimeout(x, ms));
const clean = t => t ? String(t).trim().split(/\s+/)[0].replace(/[^\p{L}\p{N}'-]/gu, '').slice(0, 24) : '';

function newCode() {
  let c;
  do c = Array.from({ length: 4 }, () => pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ'])).join('');
  while (rooms[c]);
  return c;
}
const open = () => Object.values(rooms).filter(r => r.phase === 'lobby')
  .map(r => ({ code: r.code, host: r.players[r.host].name, n: r.seats.length }));
const list = () => io.emit('rooms', open());

function view(r, id) {
  const end = r.phase === 'guess' || r.phase === 'result';
  const v = {
    code: r.code, host: r.host, phase: r.phase, me: id, rounds: r.rounds, round: r.round,
    players: r.seats.map(i => { const p = r.players[i]; return { id: i, name: p.name, score: p.score, on: p.on, bot: !!p.bot, voted: i in r.votes }; }),
  };
  if (r.phase !== 'lobby') Object.assign(v, {
    topic: r.topic, grid: r.grid, order: r.order, turn: r.turn, clues: r.clues, result: r.result,
    role: id === r.cham ? 'chameleon' : 'player',
    word: id === r.cham ? null : r.word,
    pos: id === r.cham ? null : r.pos,
    votes: end ? r.votes : null,
    cham: end ? r.cham : null,
    secret: r.phase === 'result' ? r.word : null,
  });
  return v;
}
function push(r) {
  for (const [id, p] of Object.entries(r.players)) if (p.on && !p.bot) io.to(p.sid).emit('state', view(r, id));
  list();
  botTick(r);
}

/* ---------- game actions (shared by humans and bots) ---------- */
function tally(r) {
  const c = {};
  Object.values(r.votes).forEach(v => c[v] = (c[v] || 0) + 1);
  const m = Math.max(0, ...Object.values(c));
  const top = Object.keys(c).filter(k => c[k] === m);
  if (top.length === 1 && top[0] === r.cham) r.phase = 'guess';
  else { r.players[r.cham].score += 3; r.result = { caught: false }; r.phase = 'result'; }
}
function settle(r) {
  if (r.phase === 'clues') {
    const n = r.order.length, end = n * r.rounds;
    while (r.turn < end && !r.players[r.order[r.turn % n]].on) r.turn++;
    if (r.turn >= end) r.phase = 'talk';
  }
  if (r.phase === 'vote' && Object.entries(r.players).filter(([, p]) => p.on).every(([i]) => i in r.votes)) tally(r);
}
function addClue(r, id, text) {
  r.clues.push({ id, text, rd: Math.floor(r.turn / r.order.length) });
  r.turn++; settle(r);
}
function castVote(r, id, target) { r.votes[id] = target; settle(r); }
function doGuess(r, w) {
  const correct = w === r.word;
  if (correct) r.players[r.cham].score += 1;
  else Object.entries(r.players).forEach(([i, p]) => { if (i !== r.cham) p.score += 2; });
  r.result = { caught: true, guess: String(w), correct };
  r.phase = 'result';
}
function begin(r) {
  r.seats = r.seats.filter(i => r.players[i].on);
  for (const i of Object.keys(r.players)) if (!r.players[i].on) delete r.players[i];
  const ids = r.seats;
  r.votes = {}; r.clues = []; r.result = null;
  if (ids.length < 3) { r.phase = 'lobby'; return; }
  const keys = Object.keys(TOPICS);
  let tp = keys.filter(k => !r.seen.includes(k));
  if (!tp.length) { r.seen = []; tp = keys; }
  r.topic = pick(tp); r.seen.push(r.topic);
  r.grid = TOPICS[r.topic];
  const idx = Math.random() * 16 | 0;
  r.word = r.grid[idx];
  r.pos = 'ABCD'[idx % 4] + ((idx >> 2) + 1);
  let pool = ids.filter(i => !r.used.includes(i));
  if (!pool.length) { r.used = []; pool = ids; }
  r.cham = pick(pool); r.used.push(r.cham);
  const k = r.round % ids.length;
  r.order = [...ids.slice(k), ...ids.slice(0, k)];
  r.turn = 0; r.round++; r.phase = 'clues';
}

/* ---------- bot AI (Google Gemini) ---------- */
async function ask(prompt) {
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 1 },
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error((d.error && d.error.message) || res.status);
    return d.candidates[0].content.parts.map(p => p.text || '').join('').trim();
  } catch (e) { console.error('bot AI error:', e.message); return null; }
}
const ctx = (r, id) =>
  `You are "${r.players[id].name}", playing the party game The Chameleon with friends. Topic: ${r.topic}. The grid has these 16 words: ${r.grid.join(', ')}. One secret word from the grid was chosen. Everyone except one player (the Chameleon) knows it; the Chameleon only knows the topic. ` +
  (id === r.cham ? 'YOU ARE THE CHAMELEON: you do not know the secret word.' : `The secret word is "${r.word}". You are NOT the Chameleon.`) +
  `\nPlayers: ${r.seats.map(i => r.players[i].name).join(', ')}.\nClues so far, in order: ${r.clues.map(c => r.players[c.id].name + ': ' + c.text).join('; ') || 'none'}.\n`;

async function botClue(r, id) {
  const p = ctx(r, id) + (id === r.cham
    ? 'Give ONE word as your clue that sounds like you know the word: echo the themes of earlier clues, but stay vague enough to fit several grid words. If you go first, pick something that loosely fits the topic. Reply with only that one word.'
    : 'Give ONE word as your clue. It must show the other players who know the word that you know it too, but not be so obvious that the Chameleon can guess it. Never say the secret word and do not repeat an earlier clue. Reply with only that one word.');
  let w = clean(await ask(p));
  if (!w || (id !== r.cham && w.toLowerCase() === r.word.toLowerCase())) w = pick(['classic', 'popular', 'common', 'everyday', 'famous', 'typical']);
  return w;
}
async function botVote(r, id) {
  const others = r.seats.filter(i => i !== id && r.players[i].on);
  const p = ctx(r, id) + (id === r.cham
    ? 'Vote for another player to throw suspicion off yourself.'
    : 'Decide who the Chameleon is: the player whose clue seems vague, generic or off.') + ' You cannot vote for yourself. Reply with only the exact name of one player.';
  const a = ((await ask(p)) || '').toLowerCase();
  return others.find(i => a.includes(r.players[i].name.toLowerCase())) || pick(others);
}
async function botGuess(r) {
  const p = ctx(r, r.cham) + 'You were caught. Guess the secret word using the clues. Reply with only one word, exactly as written in the grid.';
  const a = ((await ask(p)) || '').toLowerCase().trim();
  return r.grid.find(w => w.toLowerCase() === a) || r.grid.find(w => a.includes(w.toLowerCase())) || pick(r.grid);
}
function botTick(r) {
  if (!r.busy) r.busy = new Set();
  const job = (key, fn) => {
    if (r.busy.has(key)) return;
    r.busy.add(key);
    (async () => {
      await sleep(1500 + Math.random() * 2500);
      if (rooms[r.code] !== r) return;
      try { await fn(); } catch (e) { console.error(e); }
    })();
  };
  if (r.phase === 'clues') {
    const id = r.order[r.turn % r.order.length], turn = r.turn;
    if (r.players[id].bot) job(`c${r.round}:${turn}`, async () => {
      if (r.phase !== 'clues' || r.turn !== turn) return;
      addClue(r, id, await botClue(r, id)); push(r);
    });
  }
  if (r.phase === 'vote') for (const [id, p] of Object.entries(r.players)) {
    if (p.bot && p.on && !(id in r.votes)) job(`v${r.round}:${id}`, async () => {
      if (r.phase !== 'vote' || id in r.votes) return;
      castVote(r, id, await botVote(r, id)); push(r);
    });
  }
  if (r.phase === 'guess' && r.players[r.cham].bot) job(`g${r.round}`, async () => {
    if (r.phase !== 'guess') return;
    doGuess(r, await botGuess(r)); push(r);
  });
}

/* ---------- sockets ---------- */
io.on('connection', s => {
  let pid, name, room;
  const R = () => rooms[room];
  s.emit('rooms', open());

  const enter = r => {
    room = r.code;
    if (!r.seats.includes(pid)) r.seats.push(pid);
    r.players[pid] = Object.assign(r.players[pid] || { score: 0 }, { name, sid: s.id, on: true, left: false });
    push(r);
  };
  const drop = left => {
    const r = R(); room = null;
    if (!r || !r.players[pid] || r.players[pid].sid !== s.id) return;
    if (r.phase === 'lobby') { delete r.players[pid]; r.seats = r.seats.filter(i => i !== pid); }
    else Object.assign(r.players[pid], { on: false, left });
    const humans = Object.entries(r.players).filter(([, p]) => p.on && !p.bot);
    if (!humans.length) { delete rooms[r.code]; return list(); }
    if (!r.players[r.host] || !r.players[r.host].on) r.host = humans[0][0];
    settle(r); push(r);
  };

  s.on('hello', (d, cb) => {
    pid = String(d.pid || '').slice(0, 40);
    name = String(d.name || '').trim().slice(0, 16);
    if (!pid || !name) return cb && cb({ err: 'Enter a name to continue.' });
    const r = Object.values(rooms).find(x => x.players[pid] && !x.players[pid].left);
    if (r) enter(r);
    cb && cb({ ok: true });
  });
  s.on('create', () => {
    if (!name) return;
    drop(true);
    const r = { code: newCode(), host: pid, players: {}, seats: [], phase: 'lobby', votes: {}, clues: [], rounds: 2, round: 0, used: [], seen: [] };
    rooms[r.code] = r;
    enter(r);
  });
  s.on('join', (code, cb) => {
    if (!name) return;
    const r = rooms[String(code).toUpperCase()];
    if (!r) return cb({ err: 'No game with that code.' });
    if (r.phase !== 'lobby' && !r.players[pid]) return cb({ err: 'That game has already started.' });
    if (r.seats.length >= 10 && !r.players[pid]) return cb({ err: 'That game is full (10 players).' });
    if (room !== r.code) drop(true);
    enter(r);
  });
  s.on('leave', () => drop(true));
  s.on('addbot', (_, cb) => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby') return;
    if (!process.env.GEMINI_API_KEY) return cb({ err: 'Bots need GEMINI_API_KEY set on the server.' });
    if (r.seats.length >= 10) return cb({ err: 'The game is full.' });
    const used = r.seats.map(i => r.players[i].name);
    const nm = pick(BOTS.filter(n => !used.includes(n))) || 'Bot';
    const id = 'bot' + Math.random().toString(36).slice(2, 8);
    r.players[id] = { score: 0, name: nm, sid: null, on: true, left: false, bot: true };
    r.seats.push(id); push(r);
  });
  s.on('rmbot', id => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby' || !r.players[id] || !r.players[id].bot) return;
    delete r.players[id]; r.seats = r.seats.filter(i => i !== id); push(r);
  });
  s.on('rounds', n => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby') return;
    r.rounds = Math.min(3, Math.max(1, n | 0)); push(r);
  });
  s.on('start', (_, cb) => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby') return;
    if (r.seats.length < 3) return cb({ err: 'You need at least 3 players.' });
    begin(r); push(r);
  });
  s.on('next', () => {
    const r = R();
    if (!r || r.host !== pid || !['guess', 'result'].includes(r.phase)) return;
    begin(r); push(r);
  });
  s.on('clue', text => {
    const r = R();
    if (!r || r.phase !== 'clues' || r.order[r.turn % r.order.length] !== pid) return;
    const t = clean(text);
    if (!t) return;
    addClue(r, pid, t); push(r);
  });
  s.on('callvote', () => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'talk') return;
    r.phase = 'vote'; settle(r); push(r);
  });
  s.on('vote', id => {
    const r = R();
    if (!r || r.phase !== 'vote' || pid in r.votes || id === pid || !r.players[id]) return;
    castVote(r, pid, id); push(r);
  });
  s.on('guess', w => {
    const r = R();
    if (!r || r.phase !== 'guess' || pid !== r.cham) return;
    doGuess(r, w); push(r);
  });
  s.on('disconnect', () => drop(false));
});

srv.listen(process.env.PORT || 3000, () => console.log('Chameleon running'));
