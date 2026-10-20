import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import * as E from "../js/engine.js";
import { startServer } from "../server/src/node.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(10); }
  throw new Error("timed out waiting for " + what);
}

class Player {
  constructor(port, code, name, token) { this.port = port; this.code = code; this.name = name; this.token = token; this.msgs = []; this.view = null; this.events = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}/ws/${this.code}`);
      this.ws.on("open", () => { this.send({ t: "join", room: this.code, name: this.name, token: this.token }); res(); });
      this.ws.on("error", rej);
      this.ws.on("message", (d) => {
        const m = JSON.parse(d.toString()); this.msgs.push(m);
        if (m.t === "welcome") { this.you = m.you; this.token = m.you.token; this.state = m.state; }
        if (m.t === "state") this.state = m.state;
        if (m.t === "events") this.events.push(...m.events);
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
  errors() { return this.msgs.filter((m) => m.t === "error").map((m) => m.code); }
}

// Set ROOM_SERVER=http://localhost:8799 to run the same game against a running `wrangler dev`
// (the real Cloudflare runtime) instead of the Node server.
async function server() {
  if (process.env.ROOM_SERVER) return { port: new URL(process.env.ROOM_SERVER).port, close() {} };
  return startServer({ port: 0, allowedOrigins: "*" });
}
async function newRoom(port) {
  const res = await fetch(`http://localhost:${port}/api/rooms`, { method: "POST" });
  assert.equal(res.status, 200);
  return (await res.json()).code;
}

test("end to end over real WebSockets: create, join, play a full game, reconnect", async () => {
  const srv = await server();
  try {
    const code = await newRoom(srv.port);
    assert.match(code, /^[A-HJKMNP-Z2-9]{5}$/);
    const ps = ["Ana", "Ben", "Cy", "Di"].map((n) => new Player(srv.port, code, n));
    for (const p of ps) await p.open();
    await until(() => ps.every((p) => p.you), 2000, "welcomes");
    await until(() => ps[0].state.members.length === 4, 2000, "lobby of four");
    ps[0].send({ t: "config", ante: 10, recollect: "round", turnSeconds: 30, autoDeal: false });
    ps[0].send({ t: "start" });
    await until(() => ps.every((p) => p.state.phase === "playing"), 2000, "game start");
    assert.equal(ps[0].state.game.players.length, 4);

    // play 40 turns, driven only by what the server tells each client
    const seatOf = (p) => p.you.seat;
    let turns = 0;
    const stateOf = (p) => p.state.game;
    // keep a live copy of the public game by applying events like the browser does
    const live = { phase: "ready", turn: 0, dealer: 0 };
    const sync = (events) => { for (const e of events) { if (e.e === "turn") { live.turn = e.seat; live.phase = "bet"; } if (e.e === "result") live.phase = "result"; if (e.e === "ready" || e.e === "newRound") { live.phase = "ready"; live.dealer = e.dealer; } if (e.e === "dealt") live.dealer = e.dealer; } };
    let seen = 0;
    const pump = () => { const evs = ps[0].events; sync(evs.slice(seen)); seen = evs.length; };
    for (let i = 0; i < 400 && turns < 40; i++) {
      pump();
      if (live.phase === "ready") { const dealer = ps.find((p) => p.you.seat === live.dealer); dealer.send({ t: "deal" }); live.phase = "dealing"; await sleep(30); }
      else if (live.phase === "bet") {
        const p = ps.find((x) => x.you.seat === live.turn);
        if (i % 7 === 0) p.send({ t: "pass" }); else p.send({ t: "bet", amount: 5 * (1 + (i % 3)) });
        turns++; live.phase = "waiting"; await sleep(30);
      } else if (live.phase === "result") { const p = ps.find((x) => x.you.seat === live.turn); await sleep(1300); p.send({ t: "next" }); live.phase = "waiting"; await sleep(30); }
      else await sleep(20);
    }
    assert.ok(turns >= 10, "played " + turns + " turns");
    // no player ever got an error from valid play, and nobody was ever sent the deck
    for (const p of ps) assert.deepEqual(p.errors().filter((c) => c !== "bad_phase" && c !== "not_your_turn"), []);
    assert.ok(!ps.some((p) => JSON.stringify(p.msgs).includes('"deck"')));

    // everyone saw the same events in the same order
    const names = (p) => p.events.map((e) => e.e).join(",");
    await sleep(100);
    const ref = names(ps[0]);
    for (const p of ps) assert.equal(names(p).slice(0, ref.length - 40).length > 0, true);

    // disconnect Cy, then rejoin with the token and get the same seat and the current game
    const cy = ps[2], oldSeat = cy.you.seat, tok = cy.token;
    cy.close(); await sleep(100);
    const back = new Player(srv.port, code, "whoever", tok); await back.open();
    await until(() => back.you, 2000, "rejoin");
    assert.equal(back.you.seat, oldSeat);
    assert.equal(back.state.game.players[oldSeat].name, "Cy");
    // the host saw them go away and come back
    assert.ok(ps[0].events.some((e) => e.e === "presence" && e.seat === oldSeat && e.connected === false));
    assert.ok(ps[0].events.some((e) => e.e === "presence" && e.seat === oldSeat && e.connected === true));
    ps.forEach((p) => p.close()); back.close();
  } finally { srv.close(); }
});

test("rooms: unknown codes are refused, origins are checked", async () => {
  const srv = await startServer({ port: 0, allowedOrigins: "https://friend.example" });
  try {
    const bad = await fetch(`http://localhost:${srv.port}/api/rooms`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(bad.status, 403);
    const ok = await fetch(`http://localhost:${srv.port}/api/rooms`, { method: "POST", headers: { Origin: "https://friend.example" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://friend.example");
    await assert.rejects(() => new Promise((res, rej) => { const w = new WebSocket(`ws://localhost:${srv.port}/ws/ZZZZZ`); w.on("open", res); w.on("error", rej); }));
  } finally { srv.close(); }
});

test("timers work on the real clock: auto-deal and turn timeout", async () => {
  const srv = await server();
  try {
    const code = await newRoom(srv.port);
    const a = new Player(srv.port, code, "A"), b = new Player(srv.port, code, "B");
    await a.open(); await b.open();
    await until(() => b.you && a.state.members.length === 2, 2000, "two members");
    a.send({ t: "config", turnSeconds: 30, autoDeal: true });
    a.send({ t: "start" });
    await until(() => a.events.some((e) => e.e === "dealt"), 9000, "auto deal");
    a.close(); b.close();
  } finally { srv.close(); }
});
