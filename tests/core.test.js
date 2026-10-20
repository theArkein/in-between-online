import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/engine.js";
import { RoomCore, LIMITS, makeCode, isCode, cleanName } from "../server/src/core.js";

/* a pretend host platform with a clock we control */
class Fake {
  constructor(seed = 5) { this.t = 1_000_000; this.sent = []; this.persisted = null; this.alarm = null; this.closed = []; this.destroyed = false; this.rng = E.seededRng(seed); }
  now() { return this.t; }
  send(cid, str) { this.sent.push({ cid, msg: JSON.parse(str), raw: str }); }
  close(cid, why) { this.closed.push([cid, why]); }
  persist(s) { this.persisted = s; }
  schedule(at) { this.alarm = at; }
  bind() {}
  destroy() { this.destroyed = true; }
}
function room(seed) { const p = new Fake(seed); const core = RoomCore.create(p, "ABCDE"); return { p, core }; }
function tick(ctx, ms) {
  ctx.p.t += ms;
  let guard = 0;
  while (ctx.p.alarm !== null && ctx.p.alarm <= ctx.p.t && guard++ < 50) ctx.core.onTimer();
}
function client(ctx, cid) {
  const c = {
    cid, token: null, id: null, seat: null,
    send(obj) { ctx.core.onMessage(cid, JSON.stringify(obj)); },
    msgs() { return ctx.p.sent.filter((m) => m.cid === cid).map((m) => m.msg); },
    last(type) { const a = c.msgs().filter((m) => m.t === type); return a[a.length - 1]; },
    join(name, token) { c.send({ t: "join", room: "ABCDE", name, token }); const w = c.last("welcome"); if (w) { c.token = w.you.token; c.id = w.you.id; c.seat = w.you.seat; } return w; },
    errors() { return c.msgs().filter((m) => m.t === "error").map((m) => m.code); },
  };
  return c;
}
function lobby(n = 3, seed) {
  const ctx = room(seed);
  const cs = Array.from({ length: n }, (_, i) => client(ctx, "c" + i));
  cs.forEach((c, i) => c.join("P" + (i + 1)));
  return { ctx, cs, core: ctx.core };
}
function started(n = 3, seed) {
  const L = lobby(n, seed);
  L.cs[0].send({ t: "start" });
  return L;
}
const money = (g) => g.players.reduce((a, p) => a + p.net, 0) + g.bank;
const seatClient = (L, seat) => L.cs.find((c) => L.core.s.members.indexOf(L.core.member(c.id)) === seat);

test("room codes avoid look-alike characters", () => {
  for (let i = 0; i < 200; i++) assert.ok(isCode(makeCode()));
  assert.equal(isCode("ABCD0"), false); assert.equal(isCode("ABCDI"), false); assert.equal(isCode("abcde"), false);
});
test("names are cleaned", () => {
  assert.equal(cleanName("  <b>Maya</b>   Rao  "), "bMaya/b Rao");
  assert.equal(cleanName(""), "Player"); assert.equal(cleanName("x".repeat(50)).length, LIMITS.maxName);
});
test("joining: first player is host, duplicate names get a number, tokens are private", () => {
  const { ctx, cs, core } = lobby(2);
  const c3 = client(ctx, "c9"); c3.join("P1");
  assert.equal(core.s.members[2].name, "P1 2");
  assert.equal(core.s.hostId, cs[0].id);
  assert.ok(!ctx.p.sent.some((m) => m.cid !== "c0" && m.raw.includes(cs[0].token)), "a token only goes to its owner");
  const st = cs[1].last("state");
  assert.ok(st.state.members.every((m) => !("token" in m)));
});
test("only the host can change settings or start, and the settings are checked", () => {
  const { cs, core } = lobby(3);
  cs[1].send({ t: "config", ante: 20 }); assert.deepEqual(cs[1].errors(), ["not_host"]);
  cs[1].send({ t: "start" }); assert.equal(cs[1].errors().length, 2);
  cs[0].send({ t: "config", ante: 7 }); assert.ok(cs[0].errors().includes("bad_config"));
  cs[0].send({ t: "config", turnSeconds: 45 }); assert.equal(cs[0].errors().length, 2);
  cs[0].send({ t: "config", ante: 25, recollect: "deal", turnSeconds: 30, autoDeal: false });
  assert.deepEqual(core.s.config, { ante: 25, recollect: "deal", turnSeconds: 30, autoDeal: false });
});
test("needs two players to start; the game starts with the lobby seat order", () => {
  const { ctx, cs, core } = lobby(1);
  cs[0].send({ t: "start" }); assert.deepEqual(cs[0].errors(), ["not_enough_players"]);
  const b = client(ctx, "b"); b.join("Bea");
  cs[0].send({ t: "start" });
  assert.equal(core.s.phase, "playing");
  assert.deepEqual(core.s.game.players.map((p) => p.name), ["P1", "Bea"]);
  const late = client(ctx, "late"); late.join("Late");
  assert.deepEqual(late.errors(), ["started"]);
});
test("the deck order is never sent to anyone", () => {
  const L = started(4);
  const g = L.core.s.game;
  L.cs[0].send({ t: "deal" });                         // dealer is seat 0 = host
  for (let i = 0; i < 4; i++) { const sc = seatClient(L, g.turn); sc.send({ t: "bet", amount: 5 }); tick(L.ctx, 5000); }
  const everything = L.ctx.p.sent.map((m) => m.raw).join("\n");
  assert.ok(!everything.includes('"deck"'), "no message contains the deck");
  assert.ok(!everything.includes('"deck":['));
});
test("turn order and bet checks are enforced by the room", () => {
  const L = started(3);
  L.cs[0].send({ t: "deal" });
  const g = L.core.s.game;
  const wrong = seatClient(L, (g.turn + 1) % 3);
  wrong.send({ t: "bet", amount: 5 }); assert.deepEqual(wrong.errors(), ["not_your_turn"]);
  const right = seatClient(L, g.turn);
  right.send({ t: "bet", amount: 7 }); assert.ok(right.errors().includes("bad_bet"));
  right.send({ t: "bet", amount: 5 }); assert.equal(g.phase, "result");
  right.send({ t: "bet", amount: 5 }); assert.ok(right.errors().includes("bad_phase"));
  assert.ok(Math.abs(money(g)) < 1e-9);
});
test("only the dealer or host deals", () => {
  const L = started(3);
  L.cs[2].send({ t: "deal" }); assert.deepEqual(L.cs[2].errors(), ["not_dealer"]);
  L.cs[0].send({ t: "deal" }); assert.equal(L.core.s.game.phase, "bet");
});
test("timers: the deal starts by itself, a result moves on by itself, a slow player is passed", () => {
  const L = started(3); const g = L.core.s.game;
  L.cs[0].send({ t: "config", autoDeal: true });       // already in game: ignored
  tick(L.ctx, LIMITS.dealDelayMs + 10);
  assert.equal(g.phase, "bet", "auto-deal");
  const first = g.turn;
  tick(L.ctx, LIMITS.firstTurnGraceMs + 60_000 + 10);
  assert.notEqual(g.turn, first, "timed-out turn was passed");
  assert.ok(g.log.some((l) => l.text.includes("ran out of time")));
  seatClient(L, g.turn).send({ t: "bet", amount: 5 });
  assert.equal(g.phase, "result");
  tick(L.ctx, LIMITS.resultDelayMs + 10);
  assert.equal(g.phase, "bet", "result auto-advanced");
});
test("three timed-out turns in a row remove the player", () => {
  const L = started(3); const g = L.core.s.game;
  L.cs[0].send({ t: "deal" });
  const slow = g.turn;
  for (let k = 0; k < 6 && !g.players[slow].left; k++) {
    // everyone else passes quickly, the slow seat never answers
    let guard = 0;
    while (g.phase === "bet" && g.turn !== slow && guard++ < 5) seatClient(L, g.turn).send({ t: "pass" });
    if (g.phase === "ready") { L.cs[0].send({ t: "deal" }); continue; }
    tick(L.ctx, 70_000);
  }
  assert.equal(g.players[slow].left, true);
  assert.ok(g.log.some((l) => l.text.includes("away too long")));
});
test("skipping the wait: only the player who just bet (or the host), and not too soon", () => {
  const L = started(3); const g = L.core.s.game;
  L.cs[0].send({ t: "deal" });
  const actor = seatClient(L, g.turn); actor.send({ t: "bet", amount: 5 });
  actor.send({ t: "next" }); assert.equal(g.phase, "result", "too soon");
  tick(L.ctx, LIMITS.minResultBeforeSkipMs + 5);
  const other = L.cs.find((c) => c !== actor && c !== L.cs[0]);
  if (other) { other.send({ t: "next" }); assert.ok(other.errors().includes("not_your_turn")); }
  actor.send({ t: "next" }); assert.equal(g.phase, "bet");
});
test("disconnect and reconnect with the token returns to the same seat", () => {
  const L = started(3);
  const c = L.cs[1], seat = c.seat;
  L.core.onClose("c1");
  assert.equal(L.core.s.members[seat].connected, false);
  const back = client(L.ctx, "c1b"); const w = back.join("whatever", c.token);
  assert.equal(w.you.seat, seat); assert.equal(w.you.id, c.id);
  assert.equal(L.core.s.members[seat].connected, true);
  assert.equal(w.state.game.players[seat].name, c.last("welcome").state.members[seat].name);
});
test("a second tab replaces the first", () => {
  const L = started(2); const c = L.cs[1];
  const dup = client(L.ctx, "dup"); dup.join("x", c.token);
  assert.ok(L.ctx.p.closed.some(([cid, why]) => cid === "c1" && why === "replaced"));
});
test("a disconnected player's turn is cut short", () => {
  const L = started(3); const g = L.core.s.game;
  L.cs[0].send({ t: "deal" });
  const t = g.turn;
  L.core.onClose(seatClient(L, t).cid);
  tick(L.ctx, LIMITS.awayGraceMs + 100);
  assert.notEqual(g.turn, t);
});
test("the room survives a restart: state and timers come back from storage", () => {
  const L = started(3); L.cs[0].send({ t: "deal" });
  const g = L.core.s.game, seatNow = g.turn;
  const saved = JSON.parse(L.ctx.p.persisted);
  const p2 = new Fake(11); p2.t = L.ctx.p.t;
  const core2 = new RoomCore(p2, saved);
  core2.restoreConnections([]);
  const me = L.core.s.members[seatNow];
  const c = { cid: "n1", send(o) { core2.onMessage("n1", JSON.stringify(o)); } };
  c.send({ t: "join", room: "ABCDE", token: me.token, name: "x" });
  const welcome = p2.sent.find((m) => m.msg.t === "welcome").msg;
  assert.equal(welcome.you.seat, seatNow);
  c.send({ t: "bet", amount: 5 });
  assert.equal(core2.s.game.phase, "result");
  assert.ok(Math.abs(money(core2.s.game)) < 1e-9);
  assert.ok(p2.persisted.length > 0);
});
test("game over, then back to the lobby without the players who left", () => {
  const L = started(3); const g = L.core.s.game;
  L.cs[2].send({ t: "leave" }); L.cs[1].send({ t: "leave" });
  assert.equal(L.core.s.phase, "over");
  L.cs[1].send({ t: "reset" }); assert.ok(L.cs[1].errors().includes("not_host"));
  L.cs[0].send({ t: "reset" });
  assert.equal(L.core.s.phase, "lobby"); assert.equal(L.core.s.members.length, 1);
  assert.equal(L.core.s.game, null);
});
test("lobby: leaving hands the host role on; the last one out deletes the room", () => {
  const { ctx, cs, core } = lobby(2);
  cs[0].send({ t: "leave" });
  assert.equal(core.s.hostId, cs[1].id);
  cs[1].send({ t: "leave" });
  assert.equal(ctx.p.destroyed, true);
});
test("bad input never crashes the room", () => {
  const { ctx, cs, core } = lobby(2);
  for (const raw of ["", "not json", "{}", '{"t":5}', "[]", "null", '{"t":"bet","amount":"x"}', '{"t":"nope"}', "x".repeat(LIMITS.maxMessage + 1)]) core.onMessage("c0", raw);
  core.onMessage("ghost", JSON.stringify({ t: "start" }));
  assert.ok(true);
});
test("idle rooms delete themselves", () => {
  const { ctx } = lobby(2);
  tick(ctx, LIMITS.idleMs + 1000);
  assert.equal(ctx.p.destroyed, true);
});

/* a long random session with random disconnects, never breaking the money rules */
test("simulation: 60 random games with 2-8 clients, disconnects and timeouts", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const n = 2 + (seed % 7);
    const L = lobby(n, seed);
    const rnd = E.seededRng(seed * 31);
    L.cs[0].send({ t: "config", ante: 5 * (1 + (seed % 3)), recollect: seed % 2 ? "round" : "deal", turnSeconds: seed % 5 === 0 ? 0 : 30, autoDeal: seed % 4 !== 0 });
    L.cs[0].send({ t: "start" });
    const g = L.core.s.game;
    for (let step = 0; step < 400 && L.core.s.phase === "playing"; step++) {
      const r = rnd(100);
      const live = (seat) => L.cs.find((c) => L.core.s.members.indexOf(L.core.member(c.id)) === seat && L.core.conns.has(c.cid));
      if (r < 4) { const c = L.cs[rnd(n)]; L.core.onClose(c.cid); }
      else if (r < 8) { const c = L.cs[rnd(n)]; if (!L.core.conns.has(c.cid)) c.join("x", c.token); }
      else if (g.phase === "ready") { if (r < 50) tick(L.ctx, 7000); else (live(g.dealer) || L.cs[0]).send({ t: "deal" }); }
      else if (g.phase === "bet") {
        const c = live(g.turn);
        if (!c || r > 90) tick(L.ctx, 20_000);
        else if (r < 30) c.send({ t: "pass" });
        else { const mb = Math.min(E.maxBet(g.bank), 50); c.send({ t: "bet", amount: mb <= 5 ? 5 : 5 * (1 + rnd(mb / 5)) }); }
      } else if (g.phase === "result") tick(L.ctx, 4000);
      else tick(L.ctx, 1000);
      assert.ok(Math.abs(money(g)) < 1e-9, `seed ${seed} money`);
      assert.ok(g.bank >= 0 && E.isFive(g.bank));
    }
  }
  assert.ok(true);
});
