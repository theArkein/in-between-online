# In-Between

A card game for friends. Two cards are dealt to every player, then you bet on whether the next card lands strictly between them. 3D table, sound effects, works on phones and laptops. Play on one shared screen, or **online with each friend on their own device**.

**Rules in short:** the ace is always low, bets are multiples of 5, hitting one of your cards or landing outside costs you the bet, and when the bank is emptied the round ends and every card is recollected and reshuffled. Anyone can leave at any time and keeps their net result but gives up any share of the bank.

## Two ways to play

| Mode | Needs a server? |
|---|---|
| **On one screen** (pass the phone around) | No. Everything runs in the browser. |
| **Online with friends** (room code or invite link) | Yes, the small room server in `server/`. |

## Put the game on GitHub Pages

1. Push this folder to your repository's `main` branch.
2. Settings, Pages, "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The game is live at `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

One-screen play works straight away. Online play needs the room server (next section) and its address in `config.js`.

## Turn on online play

1. Deploy the room server: follow `server/README.md` (about ten minutes, free Cloudflare account).
2. Put its address in `config.js`:
   ```js
   window.INBETWEEN_CONFIG = { server: "https://in-between-rooms.YOUR-NAME.workers.dev" };
   ```
3. Commit and push. The "Online with friends" tab now works.

How a game starts: one player taps **Create a room**, shares the code or invite link, friends join, the host starts the game.

## Run it on your computer

```bash
npm install
npm test                  # rules engine, room server logic, real WebSocket games
npm run dev:server        # room server on http://localhost:8787
npm run dev:web           # the site on http://localhost:8080
```

Open `http://localhost:8080/?server=http://localhost:8787` in two browser windows to try online play.
(The page must be opened over http, not by double-clicking the file, because it uses JavaScript modules.)

## How it is built

```
index.html           the game screens, the 3D table and the sound
config.js            address of the room server
js/engine.js         the rules: pure code shared by the browser and the server
server/src/core.js   one online room: lobby, turns, timers, reconnects
server/src/worker.js Cloudflare Worker + Durable Object host for the rooms
server/src/node.js   plain Node host (local testing, or any machine that runs Node)
tests/               engine, room and end-to-end tests
vendor/three.min.js  three.js r128 (MIT licence)
```

The room server is the referee. Players send intents ("bet 20", "pass"), the room checks them with the same rules engine and sends back public events. The shuffled deck never leaves the server, so nobody can peek at the next card.

## Online details

- Up to 12 players per room. Rooms delete themselves after 24 hours without use.
- The host sets the boat, the turn timer (off, 30, 60, 90 or 120 seconds), when cards are recollected, and whether the deal starts by itself.
- A player who loses connection keeps their seat. Opening the link again gets it back. A disconnected player's turn is cut to 15 seconds.
- A player who runs out of time three turns in a row is removed.
- You always sit at the bottom of your own table; everyone else is seated clockwise from you.

## Licence

three.js is included under the MIT licence (`vendor/THREE-LICENSE.txt`).
