const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const T = require('./topics');
const app = express();
const srv = http.createServer(app);
const io = new Server(srv);
app.use(express.static('public'));

const TOPICS = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.split(',')]));
const rooms = {};
const pick = a => a[Math.random() * a.length | 0];

function newCode() {
  let c;
  do c = Array.from({ length: 4 }, () => pick([...'ABCDEFGHJKLMNPQRSTUVWXYZ'])).join('');
  while (rooms[c]);
  return c;
}
const open = () => Object.values(rooms).filter(r => r.phase === 'lobby')
  .map(r => ({ code: r.code, host: r.players[r.host].name, n: Object.keys(r.players).length }));
const list = () => io.emit('rooms', open());

function view(r, id) {
  const end = r.phase === 'guess' || r.phase === 'result';
  const v = {
    code: r.code, host: r.host, phase: r.phase, me: id, rounds: r.rounds, round: r.round,
    players: Object.entries(r.players).map(([i, p]) => ({ id: i, name: p.name, score: p.score, on: p.on, voted: i in r.votes })),
  };
  if (r.phase !== 'lobby') Object.assign(v, {
    topic: r.topic, grid: r.grid, order: r.order, turn: r.turn, clues: r.clues, result: r.result,
    role: id === r.cham ? 'chameleon' : 'player',
    word: id === r.cham ? null : r.word,
    votes: end ? r.votes : null,
    cham: end ? r.cham : null,
    secret: r.phase === 'result' ? r.word : null,
  });
  return v;
}
function push(r) {
  for (const [id, p] of Object.entries(r.players)) if (p.on) io.to(p.sid).emit('state', view(r, id));
  list();
}
function tally(r) {
  const c = {};
  Object.values(r.votes).forEach(v => c[v] = (c[v] || 0) + 1);
  const m = Math.max(0, ...Object.values(c));
  const top = Object.keys(c).filter(k => c[k] === m);
  if (top.length === 1 && top[0] === r.cham) r.phase = 'guess';
  else { r.players[r.cham].score += 2; r.result = { caught: false }; r.phase = 'result'; }
}
function settle(r) {
  if (r.phase === 'clues') {
    const n = r.order.length, end = n * r.rounds;
    while (r.turn < end && !r.players[r.order[r.turn % n]].on) r.turn++;
    if (r.turn >= end) r.phase = 'vote';
  }
  if (r.phase === 'vote' && Object.entries(r.players).filter(([, p]) => p.on).every(([i]) => i in r.votes)) tally(r);
}
function begin(r) {
  for (const [i, p] of Object.entries(r.players)) if (!p.on) delete r.players[i];
  const ids = Object.keys(r.players);
  r.votes = {}; r.clues = []; r.result = null;
  if (ids.length < 3) { r.phase = 'lobby'; return; }
  // topics don't repeat until all have been used
  const keys = Object.keys(TOPICS);
  let tp = keys.filter(k => !r.seen.includes(k));
  if (!tp.length) { r.seen = []; tp = keys; }
  r.topic = pick(tp); r.seen.push(r.topic);
  r.grid = TOPICS[r.topic];
  r.word = pick(r.grid);
  // everyone is the Chameleon once before anyone repeats
  let pool = ids.filter(i => !r.used.includes(i));
  if (!pool.length) { r.used = []; pool = ids; }
  r.cham = pick(pool); r.used.push(r.cham);
  r.order = ids.sort(() => Math.random() - 0.5);
  r.turn = 0; r.round++; r.phase = 'clues';
}

io.on('connection', s => {
  let pid, name, room;
  const R = () => rooms[room];
  s.emit('rooms', open());

  const enter = r => {
    room = r.code;
    r.players[pid] = Object.assign(r.players[pid] || { score: 0 }, { name, sid: s.id, on: true, left: false });
    push(r);
  };
  const drop = left => {
    const r = R(); room = null;
    if (!r || !r.players[pid] || r.players[pid].sid !== s.id) return;
    if (r.phase === 'lobby') delete r.players[pid];
    else Object.assign(r.players[pid], { on: false, left });
    const on = Object.entries(r.players).filter(([, p]) => p.on);
    if (!on.length) { delete rooms[r.code]; return list(); }
    if (!r.players[r.host] || !r.players[r.host].on) r.host = on[0][0];
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
    const r = { code: newCode(), host: pid, players: {}, phase: 'lobby', votes: {}, clues: [], rounds: 2, round: 0, used: [], seen: [] };
    rooms[r.code] = r;
    enter(r);
  });
  s.on('join', (code, cb) => {
    if (!name) return;
    const r = rooms[String(code).toUpperCase()];
    if (!r) return cb({ err: 'No game with that code.' });
    if (r.phase !== 'lobby' && !r.players[pid]) return cb({ err: 'That game has already started.' });
    if (Object.keys(r.players).length >= 10 && !r.players[pid]) return cb({ err: 'That game is full (10 players).' });
    if (room !== r.code) drop(true);
    enter(r);
  });
  s.on('leave', () => drop(true));
  s.on('rounds', n => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby') return;
    r.rounds = Math.min(3, Math.max(1, n | 0)); push(r);
  });
  s.on('start', (_, cb) => {
    const r = R();
    if (!r || r.host !== pid || r.phase !== 'lobby') return;
    if (Object.keys(r.players).length < 3) return cb({ err: 'You need at least 3 players.' });
    begin(r); push(r);
  });
  s.on('next', () => {
    const r = R();
    if (!r || r.host !== pid || !['guess', 'result'].includes(r.phase)) return;
    begin(r); push(r);
  });
  s.on('clue', text => {
    const r = R();
    if (!r || r.phase !== 'clues') return;
    const n = r.order.length;
    if (r.order[r.turn % n] !== pid) return;
    const t = String(text).trim().split(/\s+/)[0].slice(0, 24);
    if (!t) return;
    r.clues.push({ id: pid, text: t, rd: Math.floor(r.turn / n) }); r.turn++;
    settle(r); push(r);
  });
  s.on('vote', id => {
    const r = R();
    if (!r || r.phase !== 'vote' || pid in r.votes || id === pid || !r.players[id]) return;
    r.votes[pid] = id;
    settle(r); push(r);
  });
  s.on('guess', w => {
    const r = R();
    if (!r || r.phase !== 'guess' || pid !== r.cham) return;
    const correct = w === r.word;
    if (correct) r.players[r.cham].score += 1;
    else Object.entries(r.players).forEach(([i, p]) => { if (i !== r.cham) p.score += 2; });
    r.result = { caught: true, guess: String(w), correct };
    r.phase = 'result'; push(r);
  });
  s.on('disconnect', () => drop(false));
});

srv.listen(process.env.PORT || 3000, () => console.log('Chameleon running'));
