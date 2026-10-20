# In-Between room server

One online room is one **Cloudflare Durable Object**: a small server with its own memory and storage that exists once per room code. Players connect to it with a WebSocket. It runs the shared rules engine, keeps the secret deck, runs the turn timers, and saves its state after every action, so a restart loses nothing.

## Deploy to Cloudflare (free plan)

You need a free Cloudflare account and Node 20 or newer.

```bash
cd server
npm install
npx wrangler login          # opens a browser to sign in
npx wrangler deploy
```

Wrangler prints the address, something like `https://in-between-rooms.YOUR-NAME.workers.dev`.

1. Open `wrangler.toml` and check that `ALLOWED_ORIGINS` is your GitHub Pages address (the part before the repository name, for example `https://thearkein.github.io`). Only websites in this list can create rooms and connect. Several can be separated with commas. Redeploy after changing it.
2. Put the address in the website's `config.js` (`server: "https://in-between-rooms.YOUR-NAME.workers.dev"`) and push.

Cloudflare's current documentation says the Workers Free plan can use Durable Objects (SQLite storage), and that incoming WebSocket messages are billed at a 20 to 1 ratio, so a game among friends uses very little. Daily limits can change, so check the pricing page for Durable Objects before relying on it.

## Try it on your computer

```bash
cd server
npm install
npx wrangler dev --var ALLOWED_ORIGINS:'*'      # real Durable Objects, locally, on http://localhost:8787
```

Or, without Cloudflare tools, the plain Node version (rooms live in memory):

```bash
npm install        # in the repository root
npm run dev:server
```

## What it exposes

| Request | Meaning |
|---|---|
| `POST /api/rooms` | Creates a room. Returns `{ "code": "K7QF2" }`. |
| `GET /ws/K7QF2` | Upgrades to a WebSocket connected to that room. |

### Messages from a player

`join {room, name, token?}`, `config {ante, recollect, turnSeconds, autoDeal}` (host, lobby), `shuffleSeats` (host), `start` (host), `deal`, `bet {amount}`, `pass`, `next`, `leave`, `reset` (host, after the game), `sync`, `ping`.

### Messages from the room

`welcome {you, state}`, `state {v, state}`, `events {v, events}`, `error {code, msg}`, `pong`.

`v` counts updates. If a player sees a gap it sends `sync` and receives the whole picture again. The deck is never sent, only the number of cards left.

## Other places to run it

`src/core.js` has no Cloudflare code in it. `src/node.js` runs the same rooms with the `ws` library, so any machine that can run Node (Fly.io, Render, a spare computer) can host it. Rooms there live in memory, so they are lost if the process restarts.
