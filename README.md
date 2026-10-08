# Last Zone Standing: Online

Authoritative multiplayer server: all movement, shooting, damage, loot and the storm are simulated on the server. Browsers only send inputs and draw what the server reports. Bots fill the match up to 25 players.

## Run it
    npm install
    npm start          # http://localhost:3000   (PORT env var overrides)

Friends on the same Wi-Fi: open `http://<your-computer-ip>:3000`.

## Put it on the internet
Any host that runs Node and supports WebSockets works (Render, Railway, Fly.io, a VPS). Use `npm install` as the build command and `npm start` as the start command. The client automatically uses `wss://` on HTTPS hosts. Home hosting: forward TCP port 3000 on your router.

## Game modes
- **Solo (vs bots):** a private match just for you, with 24 bots. After it ends, press Play again.
- **Create custom match:** you get a 5-letter code. Friends enter it under "Join with code", or open the invite link (`/?c=CODE`). No bots. The host presses Start once at least 2 players are in the lobby. After a match, everyone returns to the lobby.

## Notes
- Up to 20 players per custom match. Matches already started can't be joined.
- Tunables are at the top of `server.js` (TOTAL, MAX_HUMANS, tick rate) and in `WP` (weapons).
- There is no client-side prediction, so very high ping will feel laggy. Host near your players.
