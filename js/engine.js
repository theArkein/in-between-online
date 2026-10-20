// In-Between rules engine.
//
// Pure rules: no DOM, no network, no clocks. Randomness comes from an injected
// rng(n) that returns an integer in [0, n). The browser (one-screen mode) and
// the room server (online mode) both run this exact file, so they cannot drift.
//
// Every action mutates the game object `g` and returns either
//   { ok: true,  events: [...] }   public events, safe to send to every player
//   { ok: false, error, message }  nothing was changed
//
// The only secret in the game is the order of `g.deck`. It is never placed in
// an event and `snapshot()` removes it.

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 2;

/* ---------- random numbers ---------- */
export function cryptoRng() {
  return (n) => {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] % n;
  };
}
export function seededRng(seed) {            // for tests
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/* ---------- small helpers ---------- */
export const r2 = (n) => Math.round(n * 100) / 100;
export const isFive = (n) => Math.abs(n / 5 - Math.round(n / 5)) < 1e-9;
export const maxBet = (bank) => Math.floor(bank / 5 + 1e-9) * 5;
export const decksFor = (n) => Math.max(1, Math.ceil((3 * n) / 52));
const fmt = (n) => { n = r2(n); return n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }); };
const RANK = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT = ["\u2660", "\u2665", "\u2666", "\u2663"];
export const cardName = (c) => RANK[c.r] + SUIT[c.s];

/* ---------- cards ---------- */
export function newDeck(decks, rng) {
  const d = [];
  for (let k = 0; k < decks; k++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = rng(i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
  return d;
}
// The ace is always low, so a card's value is simply its rank.
export function evaluate(c1, c2, c3) {
  const lo = Math.min(c1.r, c2.r), hi = Math.max(c1.r, c2.r);
  if (c3.r === lo || c3.r === hi) return "post";        // hit a card
  return c3.r > lo && c3.r < hi ? "win" : "lose";
}
export const winningRanks = (c1, c2) => Math.max(0, Math.abs(c1.r - c2.r) - 1);
export const sortedPair = (h) => (h.c1.r <= h.c2.r ? [h.c1, h.c2] : [h.c2, h.c1]);

/* ---------- seats ---------- */
export function nextActive(g, i) {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (!g.players[j].left) return j; }
  return -1;
}
export const activeCount = (g) => g.players.filter((p) => !p.left).length;
export function playOrder(g) {
  const out = [], n = g.players.length;
  for (let k = 1; k <= n; k++) { const j = (g.dealer + k) % n; if (!g.players[j].left) out.push(j); }
  return out;
}
export const nets = (g) => g.players.map((p) => p.net);

/* ---------- creating a game ---------- */
export function validateConfig({ names, ante, recollect }) {
  if (!Array.isArray(names) || names.length < MIN_PLAYERS) return "At least two players are needed.";
  if (names.length > MAX_PLAYERS) return `The table seats up to ${MAX_PLAYERS} players.`;
  if (!(ante > 0) || !isFive(ante) || ante > 100000) return "The boat must be a multiple of 5.";
  if (recollect !== "round" && recollect !== "deal") return "Unknown recollect setting.";
  return "";
}

export function createGame({ names, ante, recollect }, rng) {
  const err = validateConfig({ names, ante, recollect });
  if (err) throw new Error(err);
  const n = names.length;
  const deck = newDeck(decksFor(n), rng);
  const g = {
    players: names.map((name) => ({ name, net: -ante, left: false })),
    ante, bank: r2(n * ante), round: 1, dealer: 0, turn: 0, pos: 0, order: [], hands: {},
    recollect, deck, deckTotal: deck.length, phase: "ready",   // ready | bet | result | over
    lastResult: null, roundEnded: false, log: [],
  };
  g.turn = nextActive(g, g.dealer);
  note(g, "info", `Round 1 begins. ${n} players put in the boat of ${fmt(ante)}. Bank is ${fmt(g.bank)}. ${g.players[0].name} deals.`);
  return g;
}

function note(g, kind, text) { const entry = { kind, text }; g.log.push(entry); return entry; }
const bad = (error, message) => ({ ok: false, error, message });

/* The public picture of the game. Removes the deck. */
export function snapshot(g) {
  const { deck, ...rest } = g;
  return JSON.parse(JSON.stringify({ ...rest, deckLeft: deck.length }));
}

/* ---------- actions ---------- */
export function deal(g, rng) {
  if (g.phase !== "ready") return bad("bad_phase", "Cards can only be dealt between deals.");
  const n = activeCount(g);
  if (n < MIN_PLAYERS) return bad("not_enough_players", "At least two players are needed.");
  const events = [];
  if (g.deck.length < 3 * n) {
    g.deck = newDeck(decksFor(n), rng); g.deckTotal = g.deck.length;
    events.push({ e: "recollect", reason: "low", deckLeft: g.deck.length, log: note(g, "info", "The deck ran low. All cards were recollected and shuffled.") });
  }
  g.order = playOrder(g); g.pos = 0; g.hands = {};
  const dealt = {};
  for (const i of g.order) {
    const c1 = g.deck.pop(), c2 = g.deck.pop();
    g.hands[i] = { c1, c2, c3: null, state: "wait", outcome: null, bet: null };
    dealt[i] = [c1, c2];
  }
  events.push({ e: "dealt", dealer: g.dealer, order: g.order.slice(), hands: dealt, deckLeft: g.deck.length, log: note(g, "info", `${g.players[g.dealer].name} dealt two cards to each of the ${n} players.`) });
  g.phase = "bet"; g.turn = g.order[0];
  events.push({ e: "turn", seat: g.turn, pos: 0 });
  return { ok: true, events };
}

export function bet(g, seat, amount) {
  if (g.phase !== "bet") return bad("bad_phase", "It is not time to bet.");
  if (seat !== g.turn) return bad("not_your_turn", "It is not your turn.");
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 5) return bad("bad_bet", "Bet 5 or more, or pass.");
  if (!isFive(amount)) return bad("bad_bet", "Bets must be a multiple of 5.");
  if (amount > maxBet(g.bank) + 1e-9) return bad("bad_bet", `The most you can bet is ${fmt(maxBet(g.bank))}.`);

  const h = g.hands[seat], p = g.players[seat];
  const big = amount >= g.bank / 2;
  h.c3 = g.deck.pop(); h.bet = amount;
  const outcome = evaluate(h.c1, h.c2, h.c3);
  h.outcome = outcome; h.state = "done";
  const cards = `${cardName(h.c1)}, ${cardName(h.c2)} then ${cardName(h.c3)}`;
  let text, logText;
  if (outcome === "win") {
    p.net = r2(p.net + amount); g.bank = r2(g.bank - amount);
    text = `Between! ${p.name} wins ${fmt(amount)} from the bank.`;
    logText = `${p.name} bet ${fmt(amount)}: ${cards}. Won ${fmt(amount)}.`;
  } else {
    p.net = r2(p.net - amount); g.bank = r2(g.bank + amount);
    text = outcome === "post" ? `Hit a card. ${p.name} is fined ${fmt(amount)}.` : `Outside. ${p.name} loses ${fmt(amount)} to the bank.`;
    logText = `${p.name} bet ${fmt(amount)}: ${cards}. ${outcome === "post" ? "Hit a card, fined " : "Outside, lost "}${fmt(amount)}.`;
  }
  g.lastResult = { kind: outcome, text };
  g.roundEnded = g.bank <= 0;
  g.phase = "result";
  const log = note(g, outcome, logText);
  return { ok: true, events: [
    { e: "drawn", seat, card: h.c3, bet: amount, big, deckLeft: g.deck.length },
    { e: "result", seat, outcome, bet: amount, bank: g.bank, nets: nets(g), roundEnded: g.roundEnded, text, log },
  ] };
}

export function pass(g, seat, rng, why) {
  if (g.phase !== "bet") return bad("bad_phase", "It is not time to pass.");
  if (seat !== g.turn) return bad("not_your_turn", "It is not your turn.");
  g.hands[seat].state = "pass";
  const events = [{ e: "pass", seat, timeout: !!why, log: note(g, "info", `${g.players[seat].name} ${why || "passed"}.`) }];
  advanceInternal(g, rng, events);
  return { ok: true, events };
}

export function advance(g, rng) {
  if (g.phase !== "result") return bad("bad_phase", "There is nothing to move on from.");
  const events = [];
  advanceInternal(g, rng, events);
  return { ok: true, events };
}

export function leave(g, seat, rng, why) {
  const p = g.players[seat];
  if (!p || p.left) return bad("bad_seat", "That player is not at the table.");
  if (g.phase === "over") return bad("bad_phase", "The game is over.");
  p.left = true;
  const events = [{ e: "left", seat, net: p.net, log: note(g, "info", `${p.name} ${why || "left the game"} with a net of ${p.net > 0 ? "+" : p.net < 0 ? "\u2212" : ""}${fmt(Math.abs(p.net))} and gave up any share of the bank.`) }];
  const h = g.hands[seat];
  if (h) h.state = "left";
  if (activeCount(g) < 2) {
    g.phase = "over"; g.hands = {}; g.order = [];
    events.push({ e: "over" });
    return { ok: true, events };
  }
  if (seat === g.dealer) {
    g.dealer = nextActive(g, seat);
    if (g.phase === "ready") g.turn = nextActive(g, g.dealer);
    events.push({ e: "dealer", dealer: g.dealer });
  }
  if (seat === g.turn && g.phase === "bet") advanceInternal(g, rng, events);
  return { ok: true, events };
}

/* ---------- moving on ---------- */
function advanceInternal(g, rng, events) {
  if (g.roundEnded) {                       // the bank was emptied: the round ends
    events.push({ e: "roundEnd", round: g.round });
    startNewRound(g, rng, events);
    return;
  }
  let pos = g.pos + 1;
  while (pos < g.order.length && g.players[g.order[pos]].left) pos++;
  if (pos < g.order.length) {               // the next player's turn
    g.pos = pos; g.turn = g.order[pos]; g.phase = "bet";
    events.push({ e: "turn", seat: g.turn, pos });
    return;
  }
  // everyone has played: the deal is over
  const log = note(g, "info", "Everyone has played. The deal moves to the next player.");
  if (g.recollect === "deal") {
    g.deck = newDeck(decksFor(activeCount(g)), rng); g.deckTotal = g.deck.length;
    events.push({ e: "dealEnd", recollect: true, deckLeft: g.deck.length, log });
    events.push({ e: "log", log: note(g, "info", "All cards were recollected and shuffled.") });
  } else {
    events.push({ e: "dealEnd", recollect: false, deckLeft: g.deck.length, log });
  }
  g.hands = {}; g.order = [];
  g.dealer = nextActive(g, g.dealer); g.turn = nextActive(g, g.dealer);
  g.phase = "ready";
  events.push({ e: "ready", dealer: g.dealer, turn: g.turn, deckLeft: g.deck.length });
}

// A new round: every card is recollected into a fresh shuffled deck, boats are collected, the deal moves on.
function startNewRound(g, rng, events) {
  g.round += 1; g.roundEnded = false;
  g.dealer = nextActive(g, g.dealer); g.turn = nextActive(g, g.dealer);
  const act = g.players.filter((p) => !p.left);
  for (const p of act) p.net = r2(p.net - g.ante);
  g.bank = r2(act.length * g.ante);
  g.deck = newDeck(decksFor(act.length), rng); g.deckTotal = g.deck.length;
  g.hands = {}; g.order = []; g.phase = "ready";
  const log = note(g, "info", `Round ${g.round} begins. All cards were recollected and shuffled. Everyone added the boat of ${fmt(g.ante)}. Bank is ${fmt(g.bank)}. ${g.players[g.dealer].name} deals.`);
  events.push({ e: "newRound", round: g.round, dealer: g.dealer, turn: g.turn, bank: g.bank, nets: nets(g), deckLeft: g.deck.length, log });
}

/* ---------- final settle-up ---------- */
// Money left in the bank is split among the players still seated. Leavers keep their net but get no share.
export function settle(g) {
  const active = g.players.filter((p) => !p.left);
  const k = active.length;
  const bankCents = Math.round(g.bank * 100);
  const each = k ? Math.floor(bankCents / k) : 0, extra = k ? bankCents - each * k : 0;   // leftover cents go to the first players, one each
  let given = 0;
  const rows = g.players.map((p) => {
    let share = 0;
    if (!p.left) { share = each + (given < extra ? 1 : 0); given += 1; }
    return { name: p.name, left: p.left, net: p.net, c: Math.round(p.net * 100) + share };
  });
  const cr = rows.filter((r) => r.c > 0).map((r) => ({ name: r.name, c: r.c })).sort((a, b) => b.c - a.c);
  const db = rows.filter((r) => r.c < 0).map((r) => ({ name: r.name, c: -r.c })).sort((a, b) => b.c - a.c);
  const transfers = [];
  let i = 0, j = 0;
  while (i < db.length && j < cr.length) {
    const t = Math.min(db[i].c, cr[j].c);
    transfers.push({ from: db[i].name, to: cr[j].name, amount: t / 100 });
    db[i].c -= t; cr[j].c -= t;
    if (db[i].c === 0) i++;
    if (cr[j].c === 0) j++;
  }
  return { rows: rows.map((r) => ({ ...r, final: r.c / 100 })), transfers, share: k ? bankCents / k / 100 : 0, active: k };
}
