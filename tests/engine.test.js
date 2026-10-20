import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/engine.js";

const C = (r, s = 0) => ({ r, s });
const mk = (n = 3, extra = {}) => E.createGame({ names: Array.from({ length: n }, (_, i) => "P" + (i + 1)), ante: 10, recollect: "round", ...extra }, E.seededRng(7));
const money = (g) => g.players.reduce((a, p) => a + p.net, 0) + g.bank;

test("ace is always low", () => {
  assert.equal(E.evaluate(C(1), C(13), C(7)), "win");
  assert.equal(E.winningRanks(C(1), C(13)), 11);
  assert.equal(E.evaluate(C(1), C(13), C(1)), "post");
  assert.equal(E.evaluate(C(1), C(13), C(13)), "post");
});
test("evaluate covers every category", () => {
  assert.equal(E.evaluate(C(4), C(9), C(6)), "win");
  assert.equal(E.evaluate(C(4), C(9), C(4)), "post");
  assert.equal(E.evaluate(C(4), C(9), C(9)), "post");
  assert.equal(E.evaluate(C(4), C(9), C(2)), "lose");
  assert.equal(E.evaluate(C(4), C(9), C(11)), "lose");
  assert.equal(E.evaluate(C(5), C(5), C(5)), "post");       // pair, then a match
  assert.equal(E.evaluate(C(5), C(5), C(6)), "lose");       // a pair can never win
  assert.equal(E.evaluate(C(6), C(7), C(6)), "post");       // consecutive ranks cannot win
  assert.equal(E.winningRanks(C(5), C(5)), 0);
  assert.equal(E.winningRanks(C(6), C(7)), 0);
});
test("bet validation", () => {
  const g = mk(); E.deal(g, E.seededRng(1));
  const t = g.turn;
  for (const bad of [0, 4, 7, -5, 1000, NaN, "10", null]) assert.equal(E.bet(g, t, bad).ok, false, String(bad));
  assert.equal(E.bet(g, (t + 1) % 3, 10).error, "not_your_turn");
  assert.equal(E.maxBet(35), 35); assert.equal(E.maxBet(37), 35);
});
test("creating a game checks the settings", () => {
  assert.throws(() => E.createGame({ names: ["a"], ante: 10, recollect: "round" }, E.seededRng(1)));
  assert.throws(() => E.createGame({ names: ["a", "b"], ante: 7, recollect: "round" }, E.seededRng(1)));
  assert.throws(() => E.createGame({ names: Array(13).fill("x"), ante: 10, recollect: "round" }, E.seededRng(1)));
});
test("deal order: left of the dealer, dealer last, everyone gets two cards", () => {
  const g = mk(4); E.deal(g, E.seededRng(1));
  assert.deepEqual(g.order, [1, 2, 3, 0]);
  assert.equal(Object.keys(g.hands).length, 4);
  assert.equal(g.turn, 1);
});
test("snapshot never contains the deck", () => {
  const g = mk(); E.deal(g, E.seededRng(1));
  const s = E.snapshot(g);
  assert.equal("deck" in s, false);
  assert.equal(typeof s.deckLeft, "number");
  assert.ok(!JSON.stringify(E.deal(mk(), E.seededRng(2)).events).includes('"deck"'));
});
test("hit a card costs exactly 1x the bet and money is conserved", () => {
  const g = mk(); E.deal(g, E.seededRng(1));
  g.hands[g.turn].c1 = C(5); g.hands[g.turn].c2 = C(9); g.deck.push(C(9));
  const t = g.turn, before = g.players[t].net, bank = g.bank;
  const r = E.bet(g, t, 10);
  assert.equal(r.events[1].outcome, "post");
  assert.equal(g.players[t].net, before - 10); assert.equal(g.bank, bank + 10);
  assert.equal(money(g), 0);
});
test("emptying the bank ends the round, recollects the cards and collects the boats", () => {
  const g = mk(); E.deal(g, E.seededRng(1));
  const seat = g.turn;
  g.hands[seat].c1 = C(3); g.hands[seat].c2 = C(11); g.deck.push(C(7));
  const r = E.bet(g, seat, E.maxBet(g.bank));
  assert.equal(r.events[1].outcome, "win"); assert.equal(g.bank, 0); assert.equal(g.roundEnded, true);
  const a = E.advance(g, E.seededRng(2));
  assert.deepEqual(a.events.map((e) => e.e), ["roundEnd", "newRound"]);
  assert.equal(g.round, 2); assert.equal(g.bank, 30); assert.equal(g.phase, "ready");
  assert.equal(g.deck.length, 52); assert.equal(g.dealer, 1);
  assert.equal(money(g), 0);
});
test("a full deal rotates the dealer and not before", () => {
  const g = mk(3); E.deal(g, E.seededRng(1));
  assert.equal(g.dealer, 0);
  for (let i = 0; i < 3; i++) { assert.equal(g.dealer, 0); E.pass(g, g.turn, E.seededRng(i)); }
  assert.equal(g.phase, "ready"); assert.equal(g.dealer, 1);
});
test("recollect after every deal gives a fresh deck", () => {
  const g = mk(3, { recollect: "deal" }); E.deal(g, E.seededRng(1));
  for (let i = 0; i < 3; i++) E.pass(g, g.turn, E.seededRng(i));
  assert.equal(g.deck.length, 52);
});
test("leaving: skipped, keeps net, no share, game over below two players", () => {
  const g = mk(3); E.deal(g, E.seededRng(1));
  const first = g.turn;
  assert.equal(E.leave(g, (first + 1) % 3, E.seededRng(1)).ok, true);
  E.pass(g, first, E.seededRng(2));
  assert.notEqual(g.turn, (first + 1) % 3);
  const s = E.settle(g);
  assert.equal(s.rows.find((r) => r.left).final, g.players.find((p) => p.left).net);
  const done = E.leave(g, g.turn, E.seededRng(3));
  assert.equal(g.phase, "over"); assert.ok(done.events.some((e) => e.e === "over"));
  assert.ok(Math.abs(E.settle(g).rows.reduce((a, r) => a + r.final, 0)) < 1e-6);
});
test("dealer leaving passes the deal on", () => {
  const g = mk(3);
  E.leave(g, 0, E.seededRng(1));
  assert.equal(g.dealer, 1);
});
test("deck runs low: everything is recollected before dealing", () => {
  const g = mk(3); g.deck = g.deck.slice(0, 5);
  const r = E.deal(g, E.seededRng(9));
  assert.equal(r.events[0].e, "recollect"); assert.equal(g.deck.length, 52 - 6);
});
test("many players need extra decks", () => {
  assert.equal(E.decksFor(12), 1); assert.equal(E.decksFor(17), 1); assert.equal(E.decksFor(18), 2);
});
test("settle: results sum to zero and transfers cancel every debt", () => {
  const g = mk(4);
  g.players[0].net = -80; g.players[1].net = 55; g.players[2].net = 30; g.players[3].net = -5; g.bank = 0;
  const s = E.settle(g);
  assert.ok(Math.abs(s.rows.reduce((a, r) => a + r.final, 0)) < 1e-6);
  const bal = {}; s.rows.forEach((r) => (bal[r.name] = r.final));
  s.transfers.forEach((t) => { bal[t.from] += t.amount; bal[t.to] -= t.amount; });
  Object.values(bal).forEach((v) => assert.ok(Math.abs(v) < 0.011));
  assert.ok(s.transfers.length <= 3);
});

/* property test: 2,000 random games never break the money rules */
test("property: money is conserved and the bank is a non-negative multiple of 5 in random games", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const rng = E.seededRng(seed);
    const n = 2 + (seed % 11), recollect = seed % 3 === 0 ? "deal" : "round";
    const g = E.createGame({ names: Array.from({ length: n }, (_, i) => "P" + i), ante: 5 * (1 + (seed % 4)), recollect }, rng);
    for (let step = 0; step < 300 && g.phase !== "over"; step++) {
      const r = rng(100);
      if (g.phase === "ready") E.deal(g, rng);
      else if (g.phase === "bet") {
        if (r < 12) E.pass(g, g.turn, rng);
        else { const mb = Math.min(E.maxBet(g.bank), r > 80 ? 1e9 : 60); E.bet(g, g.turn, mb <= 5 ? 5 : 5 * (1 + rng(Math.floor(mb / 5)))); }
      } else if (g.phase === "result") { if (r < 3) E.leave(g, rng(n), rng); else E.advance(g, rng); }
      if (g.phase !== "over" && r > 97) E.leave(g, rng(n), rng);
      assert.ok(Math.abs(money(g)) <= 1e-9 * Math.max(1, g.bank), `seed ${seed} money`);
      assert.ok(g.bank >= 0 && E.isFive(g.bank), `seed ${seed} bank ${g.bank}`);
      assert.ok(g.deck.length >= 0);
    }
    const s = E.settle(g);
    assert.equal(s.rows.reduce((a, r) => a + Math.round(r.final * 100), 0), 0, `seed ${seed} settle (exact cents)`);
  }
});
