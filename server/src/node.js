// Plain Node host for the room server: for local development, tests, or running
// the rooms on any machine that can run Node (Fly.io, Render, a Raspberry Pi...).
// Rooms live in memory, so they are lost if this process restarts.
//
//   node server/src/node.js            (PORT=8787 by default)
//   ALLOWED_ORIGINS=https://you.github.io node server/src/node.js

import http from "node:http";
import { WebSocketServer } from "ws";
import { cryptoRng } from "../../js/engine.js";
import { RoomCore, makeCode, isCode } from "./core.js";

export function startServer({ port = Number(process.env.PORT || 8787), allowedOrigins = (process.env.ALLOWED_ORIGINS || "*") } = {}) {
  const origins = allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean);
  const originOk = (o) => origins.includes("*") || !o || origins.includes(o);
  const rooms = new Map();            // code -> { core, timer, sockets: Map<connId, ws> }
  const rng = cryptoRng();
  let nextConn = 1;
  let closed = false;                 // once closed, rooms must not start new timers

  function cors(res, origin) {
    res.setHeader("Access-Control-Allow-Origin", origins.includes("*") ? "*" : origin || "");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }

  function makeRoom(code) {
    const room = { sockets: new Map(), timer: null, core: null };
    const platform = {
      now: () => Date.now(),
      rng,
      send: (cid, str) => { const ws = room.sockets.get(cid); if (ws && ws.readyState === 1) ws.send(str); },
      close: (cid, why) => { const ws = room.sockets.get(cid); if (ws) ws.close(4000, why || ""); },
      persist: () => {},
      bind: () => {},
      schedule: (at) => {
        clearTimeout(room.timer);
        if (closed) return;
        if (at !== null) room.timer = setTimeout(() => room.core && room.core.onTimer(), Math.max(0, at - Date.now()));
      },
      destroy: () => {
        clearTimeout(room.timer);
        for (const ws of room.sockets.values()) ws.close(4404, "room closed");
        rooms.delete(code);
      },
    };
    room.core = RoomCore.create(platform, code);
    return room;
  }

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    cors(res, origin);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("In-Between room server"); return; }
    if (req.method === "POST" && req.url === "/api/rooms") {
      if (!originOk(origin)) { res.writeHead(403); res.end(); return; }
      if (rooms.size > 5000) { res.writeHead(503); res.end(); return; }
      let code; do { code = makeCode(rng); } while (rooms.has(code));
      rooms.set(code, makeRoom(code));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
      return;
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/ws\/([A-Z0-9]{5})$/.exec((req.url || "").split("?")[0]);
    if (!m || !isCode(m[1]) || !rooms.has(m[1]) || !originOk(req.headers.origin)) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = rooms.get(m[1]);
      if (!room) { ws.close(4404, "room closed"); return; }
      const cid = "c" + nextConn++;
      room.sockets.set(cid, ws);
      let burst = [];
      ws.on("message", (data) => {
        const now = Date.now();
        burst = burst.filter((t) => now - t < 1000); burst.push(now);
        if (burst.length > 30) { ws.close(4429, "too many messages"); return; }
        room.core.onMessage(cid, data.toString());
      });
      ws.on("close", () => { room.sockets.delete(cid); if (room.core) room.core.onClose(cid); });
      ws.on("error", () => {});
    });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port, rooms, close: () => {
    closed = true;
    for (const ws of wss.clients) ws.terminate();
    for (const r of rooms.values()) clearTimeout(r.timer);
    wss.close();
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();   // do not wait for idle keep-alive connections
  } })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(({ port }) => console.log(`In-Between room server listening on http://localhost:${port}`));
}
