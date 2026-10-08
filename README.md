# Last Zone Standing: Online

Authoritative multiplayer server: all movement, shooting, damage, loot and the storm are simulated on the server. Browsers only send inputs and draw what the server reports. Bots fill the match up to 25 players.

## Run it
    npm install
    npm start          # http://localhost:3000   (PORT env var overrides)

Friends on the same Wi-Fi: open `http://<your-computer-ip>:3000`.

## Put it on the internet
Any host that runs Node and supports WebSockets works (Render, Railway, Fly.io, a VPS). Use `npm install` as the build command and `npm start` as the start command. The client automatically uses `wss://` on HTTPS hosts. Home hosting: forward TCP port 3000 on your router.

## Notes
- One global room, one match at a time. Matches restart 8 s after they end. Dead players watch, then drop into the next match automatically.
- Late joiners can drop into a running match until the storm's 3rd shrink; after that they wait for the next one.
- Tunables are at the top of `server.js` (TOTAL players, MAX_HUMANS, tick rate) and in `WP` (weapons).
- There is no client-side prediction, so very high ping will feel laggy. Host near your players.
