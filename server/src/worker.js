// Cloudflare Worker + Durable Object host for the room server.
//
//   POST /api/rooms   creates a room and returns { code }
//   GET  /ws/:code    upgrades to a WebSocket connected to that room
//
// Each room is one Durable Object (a small server with its own memory and
// storage that exists exactly once per room code). It uses hibernating
// WebSockets, so idle rooms cost nothing, and it saves its state after every
// action, so a restart loses nothing.

import { DurableObject } from "cloudflare:workers";
import { cryptoRng } from "../../js/engine.js";
import { RoomCore, makeCode, isCode } from "./core.js";

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...extra } });

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);
}
function originOk(env, origin) {
  const list = allowedOrigins(env);
  return list.includes("*") || !origin || list.includes(origin);
}
function corsHeaders(env, origin) {
  const list = allowedOrigins(env);
  return {
    "Access-Control-Allow-Origin": list.includes("*") ? "*" : origin || "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!originOk(env, origin)) return new Response("Origin not allowed", { status: 403 });

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const rng = cryptoRng();
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = makeCode(rng);
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const res = await stub.fetch(new Request(`https://room/init?code=${code}`, { method: "POST" }));
        if (res.status === 200) return json({ code }, 200, cors);
      }
      return json({ error: "Could not create a room, try again." }, 503, cors);
    }

    const m = /^\/ws\/([A-Z0-9]{5})$/.exec(url.pathname);
    if (m && isCode(m[1])) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    }
    if (url.pathname === "/") return new Response("In-Between room server", { headers: cors });
    return new Response("Not found", { status: 404, headers: cors });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = null;
    this.rng = cryptoRng();
    // Wake up: load the saved room and work out who is still connected.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("room");
      if (saved) {
        this.core = new RoomCore(this.platform(), JSON.parse(saved));
        const list = [];
        for (const ws of ctx.getWebSockets()) {
          const a = ws.deserializeAttachment();
          if (a && a.memberId) list.push({ connId: a.connId, memberId: a.memberId });
        }
        this.core.restoreConnections(list);
      }
    });
  }

  platform() {
    const ctx = this.ctx;
    const socketFor = (cid) => ctx.getWebSockets().find((ws) => { const a = ws.deserializeAttachment(); return a && a.connId === cid; });
    return {
      now: () => Date.now(),
      rng: this.rng,
      send: (cid, str) => { const ws = socketFor(cid); if (ws) { try { ws.send(str); } catch { /* the socket just closed */ } } },
      close: (cid, why) => { const ws = socketFor(cid); if (ws) { try { ws.close(4000, why || ""); } catch { /* already closed */ } } },
      persist: (str) => { ctx.storage.put("room", str); },
      bind: (cid, memberId) => { const ws = socketFor(cid); if (ws) ws.serializeAttachment({ connId: cid, memberId }); },
      schedule: (at) => { if (at === null) ctx.storage.deleteAlarm(); else ctx.storage.setAlarm(Math.max(at, Date.now() + 5)); },
      destroy: async () => {
        for (const ws of ctx.getWebSockets()) { try { ws.close(4404, "room closed"); } catch { /* ignore */ } }
        this.core = null;
        await ctx.storage.deleteAlarm();
        await ctx.storage.deleteAll();
      },
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/init") {
      if (this.core) return new Response("exists", { status: 409 });
      const code = url.searchParams.get("code");
      if (!isCode(code)) return new Response("bad code", { status: 400 });
      this.core = RoomCore.create(this.platform(), code);
      this.core.touch();
      this.core.save();
      return new Response("ok");
    }
    if (!this.core) return new Response("No such room", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connId = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);                 // hibernation API
    server.serializeAttachment({ connId });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const a = ws.deserializeAttachment();
    if (!this.core || !a) { ws.close(4404, "room closed"); return; }
    // simple flood guard: at most 30 messages a second per connection
    const now = Date.now();
    this.hits = this.hits || new Map();
    const arr = (this.hits.get(a.connId) || []).filter((t) => now - t < 1000);
    arr.push(now); this.hits.set(a.connId, arr);
    if (arr.length > 30) { ws.close(4429, "too many messages"); return; }
    this.core.onMessage(a.connId, typeof message === "string" ? message : new TextDecoder().decode(message));
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (this.core && a) this.core.onClose(a.connId);
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  async alarm() {
    if (this.core) this.core.onTimer();
  }
}
