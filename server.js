"use strict";
// ==========================================================================
// ROCKET TEMU ONLINE — game server
// Serves the game page and runs every online match (3v3, bots fill empty seats).
// The server is the referee: it runs the physics, players send only their controls.
//   npm install
//   node server.js            (then open http://localhost:3000)
// ==========================================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
global.THREE = require("three");
global.performance = global.performance || require("perf_hooks").performance;
const S = require("./sim.js");

const PORT = Number(process.env.PORT) || 3000;
const FAKE_LAG_MS = Number(process.env.FAKE_LAG_MS) || 0;   // testing only: adds round-trip delay
const MAX_ROOMS = 40, SIZES = [1, 3, 5], QUEUE_MS = Number(process.env.QUEUE_SECONDS || 20) * 1000;
const TICK = 1 / S.FPS, SNAPSHOT_EVERY = 2;                // 60 Hz physics, 30 Hz updates to players
const MAX_PER_IP = Number(process.env.MAX_PER_IP) || 8;   // connections allowed from one network address
const CHATS = ["Nice shot!", "What a save!", "I got it!", "Defending...", "Thanks!", "Sorry! (refund issued)"];
const ROOM_NAMES = ["Bargain Bin", "Clearance Aisle", "Flash Sale Arena", "Free Shipping Stadium", "Warehouse 7",
  "Lightning Lounge", "Coupon Court", "Final Markdown", "Spin-to-Win Field", "Discount Dome", "Overstock Oval", "Fine Print Park"];
const STATES = ["countdown", "play", "goal", "over"];
const VOTE_MS = Number(process.env.VOTE_SECONDS || 12) * 1000, ARENA_COUNT = 4;

// ---- Static files -------------------------------------------------------------
const PUBLIC = path.join(__dirname, "public");
const FILES = {
  "/": [path.join(PUBLIC, "index.html"), "text/html; charset=utf-8"],
  "/index.html": [path.join(PUBLIC, "index.html"), "text/html; charset=utf-8"],
  "/three.min.js": [require.resolve("three/build/three.min.js"), "application/javascript"],
  // Installable app: manifest, offline service worker and icons
  "/manifest.webmanifest": [path.join(PUBLIC, "manifest.webmanifest"), "application/manifest+json"],
  "/sw.js": [path.join(PUBLIC, "sw.js"), "application/javascript"],
  "/icon-192.png": [path.join(PUBLIC, "icon-192.png"), "image/png"],
  "/icon-512.png": [path.join(PUBLIC, "icon-512.png"), "image/png"],
  "/icon-maskable-512.png": [path.join(PUBLIC, "icon-maskable-512.png"), "image/png"],
  "/apple-touch-icon.png": [path.join(PUBLIC, "apple-touch-icon.png"), "image/png"],
  "/favicon.ico": [path.join(PUBLIC, "icon-192.png"), "image/png"],
};
// Graphics add-ons (glow and reflections) served from the three package
for (const a of ["shaders/CopyShader.js", "shaders/LuminosityHighPassShader.js", "postprocessing/EffectComposer.js", "postprocessing/RenderPass.js",
  "postprocessing/ShaderPass.js", "postprocessing/UnrealBloomPass.js", "environments/RoomEnvironment.js"]) {
  FILES["/three-addons/" + a] = [path.join(path.dirname(require.resolve("three/build/three.min.js")), "..", "examples", "js", a), "application/javascript"];
}
const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  const f = FILES[url];
  if (!f) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
  fs.readFile(f[0], (err, data) => {
    if (err) { res.writeHead(500); res.end("Server error"); return; }
    res.writeHead(200, { "content-type": f[1], "cache-control": url.endsWith(".js") && url !== "/sw.js" ? "public, max-age=86400" : url.endsWith(".png") ? "public, max-age=604800" : "no-cache" });
    res.end(data);
  });
});

// ---- Helpers ---------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000, r4 = (v) => Math.round(v * 10000) / 10000;
const v3 = (v) => [r2(v.x), r2(v.y), r2(v.z)];
function cleanName(s) {
  s = String(s || "").replace(/[^A-Za-z0-9 _\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 14);
  return s || "Bargain Hunter " + (100 + Math.floor(Math.random() * 900));
}
function toControls(a) {
  const c = new S.Controls();
  if (!Array.isArray(a)) return c;
  const num = (x) => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
  c.throttle = num(a[0]); c.steer = num(a[1]); c.jump = !!a[2]; c.boost = !!a[3]; c.roll = num(a[4]); c.slide = !!a[5];
  if (Number.isFinite(a[6])) c.pitch = num(a[6]);
  if (Number.isFinite(a[7]) && Number.isFinite(a[8])) { const x = num(a[7]), z = num(a[8]), l = Math.hypot(x, z); if (l > 0.5) c.aim = { x: x / l, z: z / l }; }
  return c;
}
let nextId = 1;

// ---- Rooms ------------------------------------------------------------------------
const rooms = new Map();
class Room {
  // size: players per team (3 or 5 for casual lobbies; 1 or 3 for ranked). Ranked rooms wait in a queue
  // for players, fill the rest with TemuBots, play one match, then report everyone's new rating.
  constructor(size = 3, ranked = false) {
    this.size = size; this.ranked = ranked;
    if (ranked) this.queue = { ends: Date.now() + (size === 1 ? QUEUE_MS * 0.75 : QUEUE_MS), sent: 0 };
    this.id = Math.random().toString(36).slice(2, 7).toUpperCase();
    const used = new Set([...rooms.values()].map((r) => r.name));
    let name;
    for (let i = 0; i < 50 && (!name || used.has(name)); i++) name = ROOM_NAMES[(Math.random() * ROOM_NAMES.length) | 0] + " #" + (10 + Math.floor(Math.random() * 90));
    this.name = name;
    this.players = new Set();
    this.tick = 0; this.emptySince = Date.now(); this.events = [];
    this.newMatch();
  }
  max() { return this.size * 2; }
  avgMmr() { const ps = [...this.players]; return ps.length ? ps.reduce((a, p) => a + p.mmr, 0) / ps.length : S.START_MMR; }
  newMatch(skill = 1) {
    this.match = new S.Match({ mode: "online", teamSize: this.size, humans: [], skill });
    if (this.queue) { this.match.state = "countdown"; this.match.countdown = 3; } else this.startVote();
    if (Number(process.env.MATCH_SECONDS)) this.match.timeLeft = Number(process.env.MATCH_SECONDS);   // testing only
    for (const p of this.players) { this.match.setHuman(p.slot, true, p.name); this.match.cars[p.slot].look = p.look; this.match.cars[p.slot].assist = p.assist; }
    this.overSince = 0;
  }
  humans() { return this.players.size; }
  // Arena vote before each match: everyone in the lobby picks field, turf, kart track or garage.
  // The match waits at kickoff until the vote ends (12 s, or as soon as everyone has voted).
  startVote() { this.vote = { start: Date.now(), ends: Date.now() + VOTE_MS, votes: new Map(), sent: 0 }; if (this.arena == null) this.arena = 0; this.sendVote(); }
  voteCounts() { const c = new Array(ARENA_COUNT).fill(0); if (this.vote) for (const v of this.vote.votes.values()) c[v]++; return c; }
  voteInfo(p) {
    if (!this.vote) return null;
    return { left: Math.max(0, Math.ceil((this.vote.ends - Date.now()) / 1000)), counts: this.voteCounts(), mine: p && this.vote.votes.has(p.id) ? this.vote.votes.get(p.id) : -1 };
  }
  sendVote() { if (!this.vote) return; this.vote.sent = Date.now(); for (const p of this.players) send(p, Object.assign({ t: "vote" }, this.voteInfo(p))); }
  castVote(p, i) {
    if (!this.vote || !Number.isInteger(i) || i < 0 || i >= ARENA_COUNT) return;
    this.vote.votes.set(p.id, i); this.sendVote();
  }
  finishVote() {
    const c = this.voteCounts(), max = Math.max(...c);
    const best = max ? c.map((v, i) => (v === max ? i : -1)).filter((i) => i >= 0) : c.map((_, i) => i);
    this.arena = best[(Math.random() * best.length) | 0];
    this.vote = null;
    const msg = JSON.stringify({ t: "arena", a: this.arena, counts: c });
    for (const p of this.players) sendRaw(p, msg);
  }
  freeSlot() {
    const counts = [0, 0];
    for (const p of this.players) counts[p.slot < this.size ? 0 : 1]++;
    const team = counts[0] < counts[1] ? 0 : counts[1] < counts[0] ? 1 : (Math.random() < 0.5 ? 0 : 1);
    for (const t of [team, 1 - team]) {
      for (let k = 0; k < this.size; k++) {
        const i = t * this.size + k;
        if (![...this.players].some((p) => p.slot === i)) return i;
      }
    }
    return -1;
  }
  add(p) {
    const slot = this.freeSlot();
    if (slot < 0) return false;
    p.slot = slot; p.room = this; p.queue = []; p.ack = 0; p.last = new S.Controls(); p.lastInputAt = Date.now();
    this.players.add(p);
    this.match.setHuman(slot, true, p.name); this.match.cars[slot].look = p.look; this.match.cars[slot].assist = p.assist;
    send(p, { t: "joined", room: { id: this.id, name: this.name }, you: slot, size: this.size, ranked: this.ranked, roster: this.roster(), arena: this.arena || 0, vote: this.voteInfo(p), queue: this.queueInfo() });
    if (this.queue) this.sendQueue();
    this.broadcastRoster();
    return true;
  }
  // Ranked queue: shows how many players have been found; bots fill the empty seats when time runs out
  queueInfo() { return this.queue ? { have: this.players.size, need: this.max(), left: Math.max(0, Math.ceil((this.queue.ends - Date.now()) / 1000)) } : null; }
  sendQueue() { if (!this.queue) return; this.queue.sent = Date.now(); const msg = JSON.stringify(Object.assign({ t: "queue" }, this.queueInfo())); for (const p of this.players) sendRaw(p, msg); }
  startRanked() {
    this.queue = null; this.locked = true;
    const skill = S.botSkillFor(this.avgMmr());
    this.newMatch(skill);
    this.botMmr = S.BOT_MMR[skill];
    this.events.push({ type: "newmatch" }); this.broadcastRoster();
    // tell each player what a win or a loss is worth (a loss also counts if they leave early)
    for (const p of this.players) { const d = this.deltas(p); send(p, { t: "rankstart", size: this.size, win: d.win, loss: d.loss, botSkill: skill }); }
  }
  teamMmr(team) {
    let sum = 0;
    for (let i = team * this.size; i < (team + 1) * this.size; i++) { const p = [...this.players].find((q) => q.slot === i); sum += p ? p.mmr : this.botMmr; }
    return sum / this.size;
  }
  deltas(p) {
    const mine = p.slot < this.size ? 0 : 1, a = this.teamMmr(mine), b = this.teamMmr(1 - mine);
    return { win: S.mmrDelta(a, b, true, p.games), loss: S.mmrDelta(a, b, false, p.games) };
  }
  finishRanked() {
    this.rankedDone = true;
    const m = this.match;
    for (const p of this.players) {
      const won = (p.slot < this.size ? 0 : 1) === m.winner, d = this.deltas(p);
      send(p, { t: "rankres", size: this.size, won, delta: won ? d.win : d.loss });
    }
  }
  remove(p) {
    if (!this.players.delete(p)) return;
    if (this.vote) this.vote.votes.delete(p.id);
    this.match.setHuman(p.slot, false, null);
    this.match.cars[p.slot].name = "TEMUBOT " + (p.slot + 1); this.match.cars[p.slot].look = S.randomLook(); this.match.cars[p.slot].assist = false;
    p.room = null;
    if (!this.players.size) this.emptySince = Date.now();
    this.broadcastRoster();
  }
  roster() { return this.match.cars.map((c) => [c.name, c.human ? 1 : 0, c.look]); }
  broadcastRoster() { const msg = JSON.stringify({ t: "roster", roster: this.roster() }); for (const p of this.players) sendRaw(p, msg); }
  step() {
    const m = this.match, now = Date.now();
    const inputs = [];
    for (const p of this.players) {
      // Use exactly one input per tick, in order, so the player's own prediction matches.
      if (p.queue.length > 8) { const dropped = p.queue.splice(0, p.queue.length - 3); p.ack = dropped[dropped.length - 1].s; }
      if (p.queue.length) { const q = p.queue.shift(); p.last = q.c; p.ack = q.s; }
      else if (now - p.lastInputAt > 300) p.last = new S.Controls();     // tab hidden or connection stalled
      inputs[p.slot] = p.last;
    }
    if (this.queue) {                                  // ranked: waiting for players before the match
      if (!this.players.size) { this.queue.ends = now + QUEUE_MS; }
      else if (this.players.size >= this.max() || now >= this.queue.ends) this.startRanked();
      else if (now - this.queue.sent > 1000) this.sendQueue();
      this.tick++;
      if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot();
      return;
    }
    if (this.vote) {                                   // waiting at kickoff while the lobby votes on the arena
      const all = this.players.size > 0 && this.vote.votes.size >= this.players.size;
      if (now >= this.vote.ends || !this.players.size || (all && now - this.vote.start > 1500)) this.finishVote();
      else if (now - this.vote.sent > 500) this.sendVote();
      this.tick++;
      if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot();
      return;
    }
    m.update(TICK, inputs);
    for (const e of m.events) this.events.push(e);
    m.events.length = 0;
    if (m.state === "over") {
      if (!this.overSince) this.overSince = now;
      if (this.ranked) { if (!this.rankedDone) this.finishRanked(); }
      else if (now - this.overSince > 12000) { this.newMatch(); this.events.push({ type: "newmatch" }); this.broadcastRoster(); }
    }
    this.tick++;
    if (this.tick % SNAPSHOT_EVERY === 0) this.snapshot();
  }
  snapshot() {
    const m = this.match;
    let pads = "";
    pads = m.pads.map((pd) => (pd.timer <= 0 ? "1" : "0")).join("");   // one character per pad (there are 34)
    const ev = this.events.map((e) => {
      const o = Object.assign({}, e);
      if (o.pos) o.pos = v3(o.pos);
      if (o.power) o.power = r2(o.power);
      return o;
    });
    this.events = [];
    const common = {
      t: "s", k: this.tick, st: STATES.indexOf(m.state), cd: r2(m.countdown), tl: r2(m.timeLeft), ov: m.overtime ? 1 : 0, ot: r2(m.otTime),
      sc: m.score, gw: m.goWord, gf: m.goFlash > 0 ? 1 : 0, gm: m.state === "goal" ? m.goalMsg : 0,
      to: m.toast ? [m.toast[0], m.toast[1]] : 0, w: m.winner, ol: m.state === "over" ? m.overLine : 0,
      nx: m.state === "over" && !this.ranked ? Math.max(0, 12 - Math.floor((Date.now() - this.overSince) / 1000)) : 0,
      b: [...v3(m.ball.pos), ...v3(m.ball.vel), r2(m.ball.r)],
      c: m.cars.map((c) => [...v3(c.pos), r3(c.quat.x), r3(c.quat.y), r3(c.quat.z), r3(c.quat.w), ...v3(c.vel), Math.round(c.boost),
        (c.demolished ? 1 : 0) | (c.boosting ? 2 : 0) | (c.onGround ? 4 : 0)]),
      p: pads, ev, stx: m.stats.map((st) => [st.score, st.goals, st.assists, st.saves, st.shots, st.demos]),
    };
    const base = JSON.stringify(common).slice(0, -1);
    for (const p of this.players) {
      const c = m.cars[p.slot];
      // Full state of your own car, so your device can replay the inputs the server hasn't used yet
      const me = c.serialize();
      sendRaw(p, base + `,"a":${p.ack},"me":${JSON.stringify(me)}}`);
    }
  }
}
function lobbyList() {
  return [...rooms.values()].filter((r) => !r.ranked).sort((a, b) => b.humans() - a.humans()).map((r) => ({
    id: r.id, name: r.name, humans: r.humans(), max: r.max(), size: r.size, score: r.match.score, state: r.match.state,
    time: Math.ceil(r.match.timeLeft), ot: r.match.overtime, arena: r.arena || 0, voting: !!r.vote,
  }));
}
function quickRoom(size) {
  let best = null;
  for (const r of rooms.values()) if (!r.ranked && r.size === size && r.humans() < r.max() && r.match.state !== "over" && (!best || r.humans() > best.humans())) best = r;
  return best || createRoom(size);
}
// Ranked matchmaking: a queueing room of the same size whose players are rated close to you
// (the allowed gap widens the longer a room has been waiting)
function rankedRoom(size, mmr) {
  let best = null, bestGap = Infinity;
  for (const r of rooms.values()) {
    if (!r.ranked || r.size !== size || !r.queue || r.humans() >= r.max()) continue;
    const waited = (Date.now() - (r.queue.ends - QUEUE_MS)) / 1000, gap = Math.abs(r.avgMmr() - mmr);
    if (gap <= 300 + waited * 25 && gap < bestGap) { best = r; bestGap = gap; }
  }
  return best || createRoom(size, true);
}
function createRoom(size = 3, ranked = false) {
  if (rooms.size >= MAX_ROOMS) {
    for (const r of rooms.values()) if (!r.humans()) { rooms.delete(r.id); break; }
    if (rooms.size >= MAX_ROOMS) return null;
  }
  const r = new Room(size, ranked); rooms.set(r.id, r); return r;
}

// ---- Connections ---------------------------------------------------------------------
function sendRaw(p, str) {
  if (p.ws.readyState !== 1) return;
  if (FAKE_LAG_MS) setTimeout(() => { if (p.ws.readyState === 1) p.ws.send(str); }, FAKE_LAG_MS / 2);
  else p.ws.send(str);
}
function send(p, obj) { sendRaw(p, JSON.stringify(obj)); }
const perIp = new Map();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if ((perIp.get(ip) || 0) >= MAX_PER_IP) { ws.close(1013, "Too many connections"); return; }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const p = { id: nextId++, ws, name: cleanName(""), room: null, slot: -1, alive: true, msgCount: 0, msgWindow: Date.now(), lastChat: 0, look: S.DEFAULT_LOOK.slice(), assist: true };
  ws.on("pong", () => { ws.isAliveFlag = true; });
  ws.on("message", (data) => {
    const handle = () => {
      const now = Date.now();
      if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgCount = 0; }
      if (++p.msgCount > 240) { ws.close(1008, "Too many messages"); return; }
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (!msg || typeof msg.t !== "string") return;
      onMessage(p, msg, now);
    };
    if (FAKE_LAG_MS) setTimeout(handle, FAKE_LAG_MS / 2); else handle();
  });
  ws.on("close", () => {
    if (p.room) p.room.remove(p);
    perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
  });
  ws.on("error", () => {});
  send(p, { t: "welcome", id: p.id, name: p.name, chats: CHATS });
});
function onMessage(p, msg, now) {
  switch (msg.t) {
    case "hello": p.name = cleanName(msg.name); if (msg.look) p.look = S.cleanLook(msg.look); if (typeof msg.assist === "boolean") p.assist = msg.assist;
      if (p.room) { const c = p.room.match.cars[p.slot]; c.name = p.name; c.look = p.look; c.assist = p.assist; p.room.broadcastRoster(); } break;
    case "list": send(p, { t: "lobbies", rooms: lobbyList(), online: wss.clients.size }); break;
    case "quick": case "create": case "join": case "ranked": {
      if (p.room) p.room.remove(p);
      const size = SIZES.includes(msg.size) ? msg.size : 3;
      if (msg.t === "ranked") {
        if (size === 5) break;
        p.mmr = Number.isFinite(msg.mmr) ? Math.max(0, Math.min(4000, msg.mmr)) : S.START_MMR;
        p.games = Number.isInteger(msg.games) && msg.games >= 0 ? msg.games : 0;
      }
      let room = msg.t === "quick" ? quickRoom(size === 1 ? 3 : size) : msg.t === "create" ? createRoom(size === 5 ? 5 : 3) : msg.t === "ranked" ? rankedRoom(size, p.mmr) : rooms.get(String(msg.room || ""));
      if (room && msg.t === "join" && room.ranked) room = null;
      if (!room) { send(p, { t: "error", msg: msg.t === "join" ? "That lobby closed. Pick another one." : "All lobbies are busy. Try again in a minute." }); break; }
      if (!room.add(p)) send(p, { t: "error", msg: "That lobby is full. Try Quick Play." });
      break;
    }
    case "leave": if (p.room) p.room.remove(p); break;
    case "vote": if (p.room) p.room.castVote(p, msg.i); break;
    case "in": {
      if (!p.room || !Number.isInteger(msg.s)) break;
      if (msg.s <= p.ack || (p.queue.length && msg.s <= p.queue[p.queue.length - 1].s)) break;
      p.queue.push({ s: msg.s, c: toControls(msg.c) });
      p.lastInputAt = now;
      break;
    }
    case "chat": {
      const i = msg.i | 0;
      if (!p.room || i < 0 || i >= CHATS.length || now - p.lastChat < 1200) break;
      p.lastChat = now;
      p.room.events.push({ type: "chat", car: p.slot, i });
      break;
    }
    case "ping": send(p, { t: "pong", c: msg.c }); break;
  }
}
// Drop dead connections and long-empty rooms
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAliveFlag === false) { ws.terminate(); continue; }
    ws.isAliveFlag = false; ws.ping();
  }
  for (const r of rooms.values()) for (const p of [...r.players]) {
    if (Date.now() - p.lastInputAt > 90000) { send(p, { t: "error", msg: "You were away too long, so we gave your seat to a TemuBot." }); r.remove(p); }
  }
  for (const r of rooms.values()) if (!r.humans() && Date.now() - r.emptySince > 60000) rooms.delete(r.id);
}, 15000);

// ---- Main loop: fixed 60 Hz -----------------------------------------------------------------
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(now - last, 250); last = now;
  while (acc >= TICK * 1000) {
    for (const r of rooms.values()) if (r.humans()) r.step();     // empty rooms pause
    acc -= TICK * 1000;
  }
}, 4);

server.listen(PORT, () => console.log(`Rocket Temu server running on http://localhost:${PORT}` + (FAKE_LAG_MS ? ` (fake lag ${FAKE_LAG_MS} ms)` : "")));
