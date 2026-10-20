// RoomCore: one online room, independent of where it runs.
//
// It runs in a Cloudflare Durable Object (worker.js) or a plain Node process
// (node.js). The host platform supplies a few functions:
//
//   platform.now()                 current time in ms
//   platform.rng                   rng(n) -> integer in [0, n)   (engine randomness)
//   platform.send(connId, string)  deliver a message to one connection
//   platform.close(connId, why)    close one connection
//   platform.persist(string)       save the whole room (called after every change)
//   platform.schedule(atMs|null)   wake the room at that time (timers)
//   platform.bind(connId, memberId) remember which member owns a connection
//   platform.destroy()             delete the room's stored data
//
// The room is the single source of truth. Clients send intents (bet, pass...),
// the room checks them with the shared rules engine and broadcasts public
// events. The shuffled deck never leaves this file.

import * as E from "../../js/engine.js";

export const LIMITS = {
  maxName: 20,
  maxMessage: 4000,
  resultDelayMs: 3800,        // pause after a result before the next player is up
  dealDelayMs: 6000,          // pause before the next deal starts by itself
  recollectExtraMs: 2500,     // extra pause while the cards fly back into the deck
  firstTurnGraceMs: 3500,     // the deal animation plays before the first turn timer starts
  turnGraceMs: 900,
  awayGraceMs: 15000,         // a disconnected player's turn lasts this long at most
  idleMs: 24 * 3600 * 1000,   // an unused room deletes itself after a day
  minResultBeforeSkipMs: 1200,
  maxMisses: 3,               // timed-out turns in a row before a player is removed
};
export const TURN_CHOICES = [0, 30, 60, 90, 120];
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0 O 1 I L

export function makeCode(rng = E.cryptoRng()) {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_CHARS[rng(CODE_CHARS.length)];
  return s;
}
export const isCode = (c) => typeof c === "string" && /^[A-HJKMNP-Z2-9]{5}$/.test(c);

function rid(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (const b of a) s += abc[b % abc.length];
  return s;
}
export function cleanName(x) {
  const s = String(x == null ? "" : x).replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.maxName);
  return s || "Player";
}

export class RoomCore {
  constructor(platform, saved) {
    this.p = platform;
    this.s = saved;
    this.conns = new Map();          // connId -> memberId
  }

  static create(platform, code) {
    const now = platform.now();
    return new RoomCore(platform, {
      code, createdAt: now, lastActive: now, v: 0,
      phase: "lobby",                 // lobby | playing | over
      hostId: null,
      config: { ante: 10, recollect: "round", turnSeconds: 60, autoDeal: true },
      members: [],                    // seat order; index = seat once the game starts
      game: null, timers: {}, resultAt: 0,
    });
  }

  /* ---------- plumbing ---------- */
  get now() { return this.p.now(); }
  save() {
    this.p.persist(JSON.stringify(this.s));
    this.rescheduleAlarm();
  }
  rescheduleAlarm() {
    const t = Object.values(this.s.timers).filter((x) => typeof x === "number");
    this.p.schedule(t.length ? Math.min(...t) : null);
  }
  send(connId, obj) { this.p.send(connId, JSON.stringify(obj)); }
  broadcast(obj, exceptConn) {
    const str = JSON.stringify(obj);
    for (const cid of this.conns.keys()) if (cid !== exceptConn) this.p.send(cid, str);
  }
  bump() { return ++this.s.v; }
  err(connId, code, msg) { this.send(connId, { t: "error", code, msg }); return false; }
  member(id) { return this.s.members.find((m) => m.id === id); }
  memberOf(connId) { return this.member(this.conns.get(connId)); }
  seatOf(m) { return this.s.members.indexOf(m); }
  isHost(m) { return m && m.id === this.s.hostId; }
  touch() {
    this.s.lastActive = this.now;
    this.s.timers.idle = this.now + LIMITS.idleMs;
  }

  publicState() {
    const s = this.s, now = this.now;
    return {
      code: s.code, phase: s.phase, hostId: s.hostId, config: s.config, v: s.v,
      members: s.members.map((m, i) => ({ id: m.id, name: m.name, connected: !!m.connected, seat: i })),
      game: s.game ? E.snapshot(s.game) : null,
      turnMs: s.timers.turn ? Math.max(0, s.timers.turn - now) : null,
    };
  }
  broadcastState() { this.bump(); this.broadcast({ t: "state", v: this.s.v, state: this.publicState() }); this.save(); }

  /* ---------- connections ---------- */
  restoreConnections(list) {
    this.conns = new Map();
    for (const m of this.s.members) m.connected = false;
    for (const { connId, memberId } of list) {
      const m = this.member(memberId);
      if (m) { this.conns.set(connId, memberId); m.connected = true; }
    }
  }

  onMessage(connId, raw) {
    if (typeof raw !== "string" || raw.length > LIMITS.maxMessage) return this.err(connId, "bad_message", "That message is too large.");
    let m;
    try { m = JSON.parse(raw); } catch { return this.err(connId, "bad_message", "That message could not be read."); }
    if (!m || typeof m.t !== "string") return this.err(connId, "bad_message", "That message could not be read.");
    if (m.t === "join") return this.join(connId, m);
    const mem = this.memberOf(connId);
    if (!mem) return this.err(connId, "not_joined", "Join the room first.");
    this.touch();
    switch (m.t) {
      case "ping": return this.send(connId, { t: "pong" });
      case "sync": return this.send(connId, { t: "state", v: this.s.v, state: this.publicState() });
      case "config": return this.config(connId, mem, m);
      case "shuffleSeats": return this.shuffleSeats(connId, mem);
      case "start": return this.start(connId, mem);
      case "deal": return this.deal(connId, mem);
      case "bet": return this.bet(connId, mem, m);
      case "pass": return this.pass(connId, mem);
      case "next": return this.next(connId, mem);
      case "leave": return this.leave(connId, mem);
      case "reset": return this.reset(connId, mem);
      default: return this.err(connId, "bad_message", "Unknown message.");
    }
  }

  join(connId, m) {
    const s = this.s;
    let mem = typeof m.token === "string" && m.token ? s.members.find((x) => x.token === m.token) : null;
    if (mem) {
      for (const [cid, mid] of [...this.conns]) {                // a second tab replaces the first
        if (mid === mem.id && cid !== connId) { this.conns.delete(cid); this.p.close(cid, "replaced"); }
      }
      mem.connected = true;
    } else {
      if (s.phase !== "lobby") return this.err(connId, "started", "That game has already started.");
      if (s.members.length >= E.MAX_PLAYERS) return this.err(connId, "full", "That room is full.");
      let name = cleanName(m.name), base = name, n = 2;
      while (s.members.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `${base.slice(0, LIMITS.maxName - 2)} ${n++}`;
      mem = { id: rid(8), token: rid(24), name, connected: true, misses: 0 };
      s.members.push(mem);
      if (!s.hostId) s.hostId = mem.id;
    }
    this.conns.set(connId, mem.id);
    this.p.bind(connId, mem.id);
    this.touch();
    const v = this.bump();
    this.send(connId, { t: "welcome", you: { id: mem.id, token: mem.token, seat: this.seatOf(mem) }, state: this.publicState() });
    if (s.phase === "lobby") this.broadcast({ t: "state", v, state: this.publicState() }, connId);
    else this.broadcast({ t: "events", v, events: [{ e: "presence", seat: this.seatOf(mem), connected: true }] }, connId);
    this.save();
  }

  onClose(connId) {
    const mid = this.conns.get(connId);
    if (!mid) return;
    this.conns.delete(connId);
    const mem = this.member(mid);
    if (!mem || [...this.conns.values()].includes(mid)) return;
    mem.connected = false;
    const s = this.s;
    if (s.phase === "lobby") {
      if (s.hostId === mem.id) {                                   // hand the host role to someone who is here
        const nh = s.members.find((x) => x.connected);
        if (nh) s.hostId = nh.id;
      }
      this.broadcastState();
      return;
    }
    const v = this.bump();
    this.broadcast({ t: "events", v, events: [{ e: "presence", seat: this.seatOf(mem), connected: false }] });
    const g = s.game;
    if (g && g.phase === "bet" && g.turn === this.seatOf(mem)) {   // a missing player's turn is cut short
      const at = this.now + LIMITS.awayGraceMs;
      if (!s.timers.turn || s.timers.turn > at) s.timers.turn = at;
    }
    this.save();
  }

  /* ---------- lobby ---------- */
  config(connId, mem, m) {
    const s = this.s;
    if (s.phase !== "lobby") return this.err(connId, "bad_phase", "Settings can only change in the lobby.");
    if (!this.isHost(mem)) return this.err(connId, "not_host", "Only the host can change settings.");
    const c = { ...s.config };
    if (m.ante !== undefined) {
      if (typeof m.ante !== "number" || !E.isFive(m.ante) || m.ante < 5 || m.ante > 1000) return this.err(connId, "bad_config", "The boat must be a multiple of 5.");
      c.ante = m.ante;
    }
    if (m.recollect !== undefined) { if (m.recollect !== "round" && m.recollect !== "deal") return this.err(connId, "bad_config", "Unknown recollect setting."); c.recollect = m.recollect; }
    if (m.turnSeconds !== undefined) { if (!TURN_CHOICES.includes(m.turnSeconds)) return this.err(connId, "bad_config", "Unknown turn timer."); c.turnSeconds = m.turnSeconds; }
    if (m.autoDeal !== undefined) c.autoDeal = !!m.autoDeal;
    s.config = c;
    this.broadcastState();
  }

  shuffleSeats(connId, mem) {
    const s = this.s;
    if (s.phase !== "lobby") return this.err(connId, "bad_phase", "Seats can only change in the lobby.");
    if (!this.isHost(mem)) return this.err(connId, "not_host", "Only the host can change seats.");
    const a = s.members;
    for (let i = a.length - 1; i > 0; i--) { const j = this.p.rng(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    this.broadcastState();
  }

  start(connId, mem) {
    const s = this.s;
    if (s.phase !== "lobby") return this.err(connId, "bad_phase", "The game has already started.");
    if (!this.isHost(mem)) return this.err(connId, "not_host", "Only the host can start the game.");
    if (s.members.length < E.MIN_PLAYERS) return this.err(connId, "not_enough_players", "At least two players are needed.");
    s.game = E.createGame({ names: s.members.map((x) => x.name), ante: s.config.ante, recollect: s.config.recollect }, this.p.rng);
    s.phase = "playing";
    for (const x of s.members) x.misses = 0;
    this.schedule([]);
    this.broadcastState();
  }

  reset(connId, mem) {
    const s = this.s;
    if (!this.isHost(mem)) return this.err(connId, "not_host", "Only the host can do that.");
    if (s.phase === "lobby") return;
    const gone = new Set((s.game ? s.game.players : []).map((p, i) => (p.left ? s.members[i].id : null)).filter(Boolean));
    s.members = s.members.filter((x) => !gone.has(x.id));
    for (const [cid, mid] of [...this.conns]) if (gone.has(mid)) { this.conns.delete(cid); this.p.close(cid, "left"); }
    if (!this.member(s.hostId)) s.hostId = (s.members.find((x) => x.connected) || s.members[0] || {}).id || null;
    s.game = null; s.phase = "lobby"; s.timers = { idle: s.timers.idle }; s.resultAt = 0;
    this.broadcastState();
  }

  /* ---------- the game ---------- */
  // timers for the state the game is now in
  schedule(events) {
    const s = this.s, g = s.game, now = this.now, t = s.timers;
    delete t.turn; delete t.result; delete t.deal;
    if (!g) return;
    if (g.phase === "ready") {
      if (s.config.autoDeal) {
        const slow = events.some((e) => e.e === "newRound" || e.e === "recollect" || (e.e === "dealEnd" && e.recollect));
        t.deal = now + LIMITS.dealDelayMs + (slow ? LIMITS.recollectExtraMs : 0);
      }
    } else if (g.phase === "bet") {
      const grace = events.some((e) => e.e === "dealt") ? LIMITS.firstTurnGraceMs : LIMITS.turnGraceMs;
      const cur = s.members[g.turn];
      let at = s.config.turnSeconds ? now + grace + s.config.turnSeconds * 1000 : 0;
      if (cur && !cur.connected) { const away = now + grace + LIMITS.awayGraceMs; at = at ? Math.min(at, away) : away; }
      if (at) t.turn = at;
      for (const e of events) if (e.e === "turn") e.ms = t.turn ? t.turn - now : 0;
    } else if (g.phase === "result") {
      t.result = now + LIMITS.resultDelayMs;
      s.resultAt = now;
    } else if (g.phase === "over") {
      s.phase = "over";
    }
  }

  afterAction(events) {
    this.schedule(events);
    const v = this.bump();
    this.broadcast({ t: "events", v, events });
    this.save();
  }

  deal(connId, mem) {
    const s = this.s, g = s.game;
    if (s.phase !== "playing" || !g) return this.err(connId, "bad_phase", "There is no game to deal in.");
    if (g.phase !== "ready") return this.err(connId, "bad_phase", "Cards can only be dealt between deals.");
    if (this.seatOf(mem) !== g.dealer && !this.isHost(mem)) return this.err(connId, "not_dealer", "Only the dealer can deal.");
    this.runDeal();
  }
  runDeal() {
    const r = E.deal(this.s.game, this.p.rng);
    if (r.ok) this.afterAction(r.events);
  }

  bet(connId, mem, m) {
    const s = this.s, g = s.game;
    if (s.phase !== "playing" || !g) return this.err(connId, "bad_phase", "There is no game to bet in.");
    const r = E.bet(g, this.seatOf(mem), m.amount);
    if (!r.ok) return this.err(connId, r.error, r.message);
    mem.misses = 0;
    this.afterAction(r.events);
  }

  pass(connId, mem) {
    const s = this.s, g = s.game;
    if (s.phase !== "playing" || !g) return this.err(connId, "bad_phase", "There is no game to pass in.");
    const r = E.pass(g, this.seatOf(mem), this.p.rng);
    if (!r.ok) return this.err(connId, r.error, r.message);
    mem.misses = 0;
    this.afterAction(r.events);
  }

  next(connId, mem) {
    const s = this.s, g = s.game;
    if (s.phase !== "playing" || !g || g.phase !== "result") return this.err(connId, "bad_phase", "There is nothing to move on from.");
    if (this.seatOf(mem) !== g.turn && !this.isHost(mem)) return this.err(connId, "not_your_turn", "Only the player who just bet can skip the wait.");
    if (this.now - s.resultAt < LIMITS.minResultBeforeSkipMs) return;       // let the reveal finish on everyone's screen
    this.runAdvance();
  }
  runAdvance() {
    const r = E.advance(this.s.game, this.p.rng);
    if (r.ok) this.afterAction(r.events);
  }

  leave(connId, mem) {
    const s = this.s;
    if (s.phase === "lobby") {
      s.members = s.members.filter((x) => x.id !== mem.id);
      for (const [cid, mid] of [...this.conns]) if (mid === mem.id) { this.conns.delete(cid); this.p.close(cid, "left"); }
      if (!s.members.length) { this.p.destroy(); return; }
      if (s.hostId === mem.id) s.hostId = (s.members.find((x) => x.connected) || s.members[0]).id;
      this.broadcastState();
      return;
    }
    if (s.phase !== "playing" || !s.game) return;
    const r = E.leave(s.game, this.seatOf(mem), this.p.rng);
    if (!r.ok) return this.err(connId, r.error, r.message);
    this.afterAction(r.events);
  }

  /* ---------- timers ---------- */
  onTimer() {
    const s = this.s, now = this.now, g = s.game, t = s.timers;
    const due = (k) => typeof t[k] === "number" && t[k] <= now;
    if (due("idle")) { this.p.destroy(); return; }
    if (g && s.phase === "playing") {
      if (due("turn") && g.phase === "bet") {
        const mem = s.members[g.turn];
        mem.misses = (mem.misses || 0) + 1;
        const r = mem.misses >= LIMITS.maxMisses
          ? E.leave(g, g.turn, this.p.rng, "was away too long and left")
          : E.pass(g, g.turn, this.p.rng, "ran out of time and passed");
        if (r.ok) this.afterAction(r.events);
      } else if (due("result") && g.phase === "result") {
        this.runAdvance();
      } else if (due("deal") && g.phase === "ready") {
        this.runDeal();
      }
    }
    for (const k of Object.keys(t)) if (k !== "idle" && typeof t[k] === "number" && t[k] <= now) delete t[k];   // stale timers
    this.save();
  }
}
