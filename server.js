'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const M = 3200, HZ = 30, DT = 1 / HZ, TOTAL = 25, MAX_HUMANS = 20;
const R = Math.random, rr = (a, b) => a + R() * (b - a), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ad = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
// d=damage r=seconds between shots s=bullet speed sp=spread p=pellets l=bullet lifetime
const WP = {
  pistol:  { d: 14, r: .35, s: 750,  sp: .04,  p: 1, l: .9 },
  shotgun: { d: 11, r: .85, s: 700,  sp: .22,  p: 6, l: .38 },
  ar:      { d: 10, r: .11, s: 900,  sp: .07,  p: 1, l: 1.1 },
  sniper:  { d: 70, r: 1.3, s: 1800, sp: .004, p: 1, l: 1.6 }
};
const WK = Object.keys(WP);
const STORM_R = [1500, 950, 520, 220, 0];
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer((req, res) => {
  fs.readFile(INDEX, (err, d) => {
    if (err) { res.writeHead(500); return res.end('missing public/index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });

const clients = new Map();          // ws -> client
const rooms = new Map();           // code -> room
// Game functions below work on the "current" room: call enter(room) first.
let ROOM = null, G = null, nextId = 1, clientSeq = 1;
const enter = room => { ROOM = room; G = room.G; };

const send = (c, o) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); };
const broadcast = o => { for (const c of ROOM.clients) send(c, o); };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoom(mode) {
  let code; do { code = Array.from({ length: 5 }, () => CODE_CHARS[(R() * CODE_CHARS.length) | 0]).join(''); } while (rooms.has(code));
  const room = { code, mode, clients: new Set(), host: null, G: null, phase: 'lobby', phaseT: 0 };
  rooms.set(code, room); return room;
}
function sendLobby(room) {
  const players = [...room.clients].map(c => c.name);
  for (const c of room.clients) send(c, { t: 'lobby', code: room.code, mode: room.mode, players, host: room.host === c });
}
function joinRoom(c, room) { c.room = room; c.ent = null; room.clients.add(c); if (!room.host) room.host = c; }
function leaveRoom(c) {
  const room = c.room; if (!room) return;
  enter(room);
  if (room.phase === 'play' && c.ent && !c.ent.dead) dmg(c.ent, 1e9, null, 'a disconnect');
  room.clients.delete(c); c.room = null; c.ent = null;
  if (!room.clients.size) { rooms.delete(room.code); return; }
  if (room.host === c) room.host = [...room.clients][0];
  if (room.phase === 'lobby') sendLobby(room);
}
const namesMap = () => { const n = {}; for (const e of G.ents) if (!e.bot) n[e.id] = e.name; return n; };

/* ---------- world ---------- */
function addLoot(x, y, t) { G.loot.push({ x, y, t }); G.lv++; }
function randLoot(x, y, good) {
  const q = R(); let t;
  if (q < .3) t = 'heal'; else if (q < .5) t = 'shield'; else if (q < .65) t = 'wood'; else t = WK[1 + ((R() * 3) | 0)];
  if (good && (t === 'wood' || t === 'heal')) t = 'ar';
  addLoot(x, y, t);
}
function house(x, y) {
  const w = 170, h = 130, t = 14, a = (X, Y, A, B) => G.walls.push({ x: X, y: Y, w: A, h: B, hp: 300 });
  a(x, y, w, t); a(x, y + h - t, 60, t); a(x + w - 60, y + h - t, 60, t); a(x, y, t, h); a(x + w - t, y, t, h);
  randLoot(x + w / 2 - 20, y + h / 2); randLoot(x + w / 2 + 20, y + h / 2, true);
}
function mkEnt(bot, name, c) {
  const e = { id: nextId++, x: rr(200, M - 200), y: rr(200, M - 200), hp: 100, sh: 0, w: ['pistol'], cw: 'pistol',
    cd: 0, bc: 0, wood: bot ? 20 : 60, bot, ang: 0, tx: 0, ty: 0, t: 0, dead: false, k: 0, c, place: 0,
    in: { dx: 0, dy: 0, sh: false }, wb: false, killerName: '' };
  e.name = name || 'Bot' + e.id; e.tx = e.x; e.ty = e.y; return e;
}
function addHuman(c) {
  const e = mkEnt(false, c.name, c); c.ent = e; c.wv = c.lv = 0; c.notified = false; G.ents.push(e);
  send(c, { t: 'init', id: e.id, mode: ROOM.mode, code: ROOM.code, M, trees: G.trees.map(t => [Math.round(t.x), Math.round(t.y), Math.round(t.r)]), names: namesMap() });
}
function startMatch(room) {
  room.G = { t: 0, ents: [], trees: [], walls: [], loot: [], bul: [], fx: [], wv: 1, lv: 1, noHuman: 0,
    storm: { cx: rr(1300, 1900), cy: rr(1300, 1900), r: 2400, from: 2400, to: 1500, ph: 0, tm: 0, state: 'wait' } };
  enter(room);
  for (let i = 0; i < 150; i++) G.trees.push({ x: rr(60, M - 60), y: rr(60, M - 60), r: rr(20, 30) });
  for (let i = 0; i < 16; i++) house(rr(200, M - 380), rr(200, M - 330));
  for (let i = 0; i < 90; i++) randLoot(rr(60, M - 60), rr(60, M - 60));
  for (const c of room.clients) addHuman(c);
  if (room.mode === 'solo') for (let i = 0; i < TOTAL - 1; i++) G.ents.push(mkEnt(true));   // bots only in solo
  room.phase = 'play';
  broadcast({ t: 'roster', n: namesMap() });
}

/* ---------- gameplay ---------- */
function take(e, t) {
  if (WP[t]) { if (e.w.includes(t)) return false; e.w.push(t); e.cw = t; return true; }
  if (t === 'heal') { if (e.hp >= 100) return false; e.hp = Math.min(100, e.hp + 30); return true; }
  if (t === 'shield') { if (e.sh >= 100) return false; e.sh = Math.min(100, e.sh + 40); return true; }
  e.wood += 30; return true;
}
function resolve(e, r) {
  for (const t of G.trees) { const dx = e.x - t.x, dy = e.y - t.y, d = Math.hypot(dx, dy), m = r + t.r; if (d < m && d > 0) { e.x = t.x + dx / d * m; e.y = t.y + dy / d * m; } }
  for (const w of G.walls) {
    const cx = clamp(e.x, w.x, w.x + w.w), cy = clamp(e.y, w.y, w.y + w.h), dx = e.x - cx, dy = e.y - cy, d = Math.hypot(dx, dy);
    if (d < r) { if (d > 0) { e.x = cx + dx / d * r; e.y = cy + dy / d * r; } else e.x += r; }
  }
  e.x = clamp(e.x, r, M - r); e.y = clamp(e.y, r, M - r);
}
function shoot(e) {
  const w = WP[e.cw]; if (e.cd > 0) return; e.cd = w.r;
  for (let i = 0; i < w.p; i++) {
    const a = e.ang + (R() - .5) * 2 * w.sp * (e.bot ? 2.2 : 1);
    G.bul.push({ x: e.x + Math.cos(e.ang) * 20, y: e.y + Math.sin(e.ang) * 20, vx: Math.cos(a) * w.s, vy: Math.sin(a) * w.s, l: w.l, d: w.d, o: e });
  }
}
function dmg(e, d, by, label) {
  if (e.dead) return;
  const s = Math.min(e.sh, d); e.sh -= s; e.hp -= d - s;
  if (e.hp > 0) return;
  e.dead = true; e.place = G.ents.filter(x => !x.dead).length + 1;
  e.killerName = by && by !== e ? by.name : (label || 'The storm');
  if (by && by !== e) by.k++;
  addLoot(e.x, e.y, 'wood'); addLoot(e.x - 16, e.y, 'heal');
  const wk = e.w[(R() * e.w.length) | 0]; if (wk !== 'pistol') addLoot(e.x + 16, e.y, wk);
  broadcast({ t: 'feed', a: e.killerName, b: e.name });
}
function build(e) {
  if (e.bc > 0 || e.wood < 10) return; e.bc = .25; e.wood -= 10;
  const c = Math.cos(e.ang), s = Math.sin(e.ang);
  if (Math.abs(c) > Math.abs(s)) { const X = e.x + Math.sign(c) * 56; G.walls.push({ x: X - 7, y: e.y - 45, w: 14, h: 90, hp: 200 }); }
  else { const Y = e.y + Math.sign(s) * 56; G.walls.push({ x: e.x - 45, y: Y - 7, w: 90, h: 14, hp: 200 }); }
  G.wv++;
}
function ai(b, dt) {
  let tg = null, bd = 1e9;
  for (const o of G.ents) { if (o === b || o.dead) continue; const d = Math.hypot(o.x - b.x, o.y - b.y); if (d < bd) { bd = d; tg = o; } }
  const st = G.storm; b.t -= dt;
  if (Math.hypot(b.x - st.cx, b.y - st.cy) > st.r - 120) { b.tx = st.cx + rr(-100, 100); b.ty = st.cy + rr(-100, 100); b.t = 1; }
  else if (b.t <= 0) {
    let l = null, ld = 600;
    for (const it of G.loot) { const d = Math.hypot(it.x - b.x, it.y - b.y); if (d < ld) { ld = d; l = it; } }
    if (l && R() < .7) { b.tx = l.x; b.ty = l.y; } else { b.tx = b.x + rr(-400, 400); b.ty = b.y + rr(-400, 400); }
    b.t = rr(2, 4);
  }
  let mx = 0, my = 0; const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy);
  if (d > 10) { mx = dx / d; my = dy / d; }
  if (tg && bd < 520) {
    const a = Math.atan2(tg.y - b.y, tg.x - b.x), df = ad(a - b.ang); b.ang += df * Math.min(1, dt * 6);
    if ((bd < 380 || b.cw === 'sniper' || b.cw === 'ar') && Math.abs(df) < .25) shoot(b);
    if (bd < 200) { mx *= .3; my *= .3; }
  } else if (d > 10) b.ang = Math.atan2(my, mx);
  return [mx, my];
}
function update(dt) {
  G.t += dt; const st = G.storm; st.tm += dt;
  if (st.state === 'wait' && st.tm > (st.ph === 0 ? 25 : 15)) { st.state = 'shrink'; st.tm = 0; st.from = st.r; st.to = STORM_R[st.ph] ?? 0; }
  else if (st.state === 'shrink') { const k = Math.min(1, st.tm / 22); st.r = st.from + (st.to - st.from) * k; if (k >= 1) { st.state = 'wait'; st.tm = 0; st.ph++; } }

  for (const e of G.ents) {
    if (e.dead) continue; e.cd -= dt; e.bc -= dt; let mx = 0, my = 0;
    if (!e.bot) { mx = e.in.dx; my = e.in.dy; if (e.in.sh) shoot(e); if (e.wb) { e.wb = false; build(e); } }
    else [mx, my] = ai(e, dt);
    const sp = e.bot ? 165 : 230; e.x += mx * sp * dt; e.y += my * sp * dt; resolve(e, 14);
    for (let i = G.loot.length - 1; i >= 0; i--) {
      const it = G.loot[i];
      if (Math.hypot(it.x - e.x, it.y - e.y) < 26 && take(e, it.t)) { G.loot.splice(i, 1); G.lv++; }
    }
    if (Math.hypot(e.x - st.cx, e.y - st.cy) > st.r) dmg(e, (1.5 + st.ph * 1.5) * dt * 3, null);
  }

  for (let i = G.bul.length - 1; i >= 0; i--) {
    const b = G.bul[i]; b.x += b.vx * dt; b.y += b.vy * dt; b.l -= dt; let hit = b.l <= 0;
    if (!hit) for (const e of G.ents) {
      if (e !== b.o && !e.dead && Math.hypot(e.x - b.x, e.y - b.y) < 15) { dmg(e, b.d, b.o); hit = true; G.fx.push([Math.round(b.x), Math.round(b.y)]); break; }
    }
    if (!hit) for (const t of G.trees) if (Math.hypot(t.x - b.x, t.y - b.y) < t.r) { hit = true; break; }
    if (!hit) for (let j = G.walls.length - 1; j >= 0; j--) {
      const w = G.walls[j];
      if (b.x > w.x && b.x < w.x + w.w && b.y > w.y && b.y < w.y + w.h) { w.hp -= b.d; if (w.hp <= 0) G.walls.splice(j, 1); G.wv++; hit = true; break; }
    }
    if (hit) G.bul.splice(i, 1);
  }

  G.ents = G.ents.filter(e => !e.dead);
  for (const c of ROOM.clients) {
    const e = c.ent;
    if (e && e.dead && !c.notified) { c.notified = true; send(c, { t: 'dead', place: e.place, by: e.killerName, k: e.k }); }
  }
  if (!G.ents.some(e => !e.bot)) G.noHuman += dt;
  if (G.ents.length <= 1 || (ROOM.mode === 'solo' && G.noHuman > 2)) {
    const w = G.ents[0];
    broadcast({ t: 'end', winner: w ? w.name : null, wid: w ? w.id : 0 });
    ROOM.phase = 'ended'; ROOM.phaseT = 7;
  }
}
function snapshot() {
  const E = G.ents.map(e => [e.id, Math.round(e.x), Math.round(e.y), Math.round(e.ang * 100), Math.ceil(e.hp), Math.ceil(e.sh), WK.indexOf(e.cw)]);
  const B = G.bul.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy)]);
  const st = G.storm;
  const base = { t: 's', e: E, b: B, fx: G.fx, al: E.length,
    st: [Math.round(st.cx), Math.round(st.cy), Math.round(st.r), st.state === 'wait' ? 0 : 1, st.ph, st.state === 'wait' ? Math.max(0, Math.ceil((st.ph === 0 ? 25 : 15) - st.tm)) : 0] };
  G.fx = [];
  for (const c of ROOM.clients) {
    if (!c.ent) continue; const m = { ...base };
    if (c.wv !== G.wv) { m.w = G.walls.map(w => [Math.round(w.x), Math.round(w.y), w.w, w.h, Math.ceil(w.hp)]); c.wv = G.wv; }
    if (c.lv !== G.lv) { m.l = G.loot.map(l => [Math.round(l.x), Math.round(l.y), l.t]); c.lv = G.lv; }
    const e = c.ent;
    if (!e.dead) m.me = [Math.ceil(e.hp), Math.ceil(e.sh), e.wood, e.w.map(k => WK.indexOf(k)), WK.indexOf(e.cw), e.k];
    send(c, m);
  }
}
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'play') { enter(room); update(DT); snapshot(); }
    else if (room.phase === 'ended' && room.mode === 'custom') { room.phaseT -= DT; if (room.phaseT <= 0) { room.phase = 'lobby'; sendLobby(room); } }
  }
}, 1000 / HZ);

setInterval(() => { for (const c of clients.values()) c.n = 0; }, 1000);

const cleanName = (n, c) => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player' + c.id;

wss.on('connection', ws => {
  const c = { ws, id: clientSeq++, name: '', room: null, ent: null, n: 0, wv: 0, lv: 0, notified: false };
  clients.set(ws, c);
  ws.on('message', raw => {
    if (++c.n > 120) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const room = c.room;
    if (m.t === 'solo' && !room) {
      c.name = cleanName(m.name, c); const r = makeRoom('solo'); joinRoom(c, r); startMatch(r);
    } else if (m.t === 'create' && !room) {
      c.name = cleanName(m.name, c); const r = makeRoom('custom'); joinRoom(c, r); sendLobby(r);
    } else if (m.t === 'join' && !room) {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = rooms.get(code);
      if (!r || r.mode !== 'custom') return send(c, { t: 'err', msg: 'No match found with that code' });
      if (r.phase !== 'lobby') return send(c, { t: 'err', msg: 'That match has already started' });
      if (r.clients.size >= MAX_HUMANS) return send(c, { t: 'err', msg: 'That match is full' });
      c.name = cleanName(m.name, c); joinRoom(c, r); sendLobby(r);
    } else if (m.t === 'start' && room && room.mode === 'custom' && room.host === c && room.phase === 'lobby') {
      if (room.clients.size < 2) return send(c, { t: 'err', msg: 'Need at least 2 players to start' });
      startMatch(room);
    } else if (m.t === 'again' && room && room.mode === 'solo' && room.phase === 'ended') {
      startMatch(room);
    } else if (m.t === 'leave') {
      leaveRoom(c);
    } else if (m.t === 'in') {
      const e = c.ent; if (!e || e.dead || !room || room.phase !== 'play') return;
      let dx = clamp(+m.dx || 0, -1, 1), dy = clamp(+m.dy || 0, -1, 1); const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      e.in = { dx, dy, sh: !!m.sh };
      if (Number.isFinite(+m.ang)) e.ang = +m.ang;
      if (m.b) e.wb = true;
      if (Number.isInteger(m.w) && e.w[m.w]) e.cw = e.w[m.w];
    }
  });
  ws.on('close', () => { leaveRoom(c); clients.delete(ws); });
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log('Last Zone Standing server on http://localhost:' + PORT));
