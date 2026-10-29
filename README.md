# Rocket Temu Online

3D rocket-powered car soccer with public online lobbies. Ordered online for $2.99. Item may differ from picture.

This folder is the whole thing: one small Node.js server that serves the game page **and** runs every online match.

| File | What it is |
| --- | --- |
| `server.js` | The game server: web page, lobbies, and the online matches |
| `sim.js` | The game itself (physics, rules, TemuBots), shared by the server and the page |
| `public/index.html` | The game page players open |
| `package.json` | Tells the host which packages to install |

## How online play works

- **Quick play** puts you in the busiest lobby that has a free seat, or starts a new one.
- Every lobby is a 3v3. TemuBots fill empty seats, so you can play even when nobody else is on. When someone joins, they take a bot's seat. When they leave, a bot takes over.
- Matches restart automatically 12 seconds after they end.
- The server runs the real match. Your own car also runs on your device, so it responds instantly, and quietly corrects itself to match the server.
- Chat is preset quick-chat lines only (keys 1 to 6, or the CHAT button on phones). There is no free typing. Nicknames are limited to 14 letters, numbers, spaces, dashes and underscores.

## Put it online for free (Render)

You need a free GitHub account and a free Render account. It takes about 10 minutes.

1. **Put the files on GitHub.** Sign in at github.com, click **New repository**, name it `rocket-temu`, and click **Create repository**. On the next page, click **uploading an existing file**. Drag in everything from this folder: `server.js`, `sim.js`, `package.json`, `README.md` and the `public` folder. Click **Commit changes**.
2. **Create the server on Render.** Sign in at render.com with your GitHub account. Click **New**, then **Web Service**, and pick your `rocket-temu` repository. Use these settings:
   - Language: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: **Free**
   
   Click **Deploy**.
3. **Play.** After a minute or two Render shows your address, something like `https://rocket-temu.onrender.com`. That address is the live game, online play included. Send it to your friends.

**Good to know about Render's free plan:**
- The server goes to sleep after 15 minutes with nobody playing. The next visitor waits about a minute while it wakes up. If the online screen says it can't reach the server, wait a moment and press Quick play again.
- It can restart occasionally, which ends any matches in progress.
- It has a monthly bandwidth limit. A full lobby of 6 players uses roughly 0.45 GB an hour.
- To update the game later, upload the new files to the same GitHub repository. Render redeploys automatically.

## Already hosting the page somewhere else?

If you put `public/index.html` on Netlify or GitHub Pages, open it in a text editor, find `window.ROCKET_TEMU_SERVER = ... ""`, and put your Render address between the quotes, with `wss://` at the start and `/ws` at the end. For example: `"wss://rocket-temu.onrender.com/ws"`. You still need the Render server running.

## Run it on your own computer

Install Node.js 18 or newer from nodejs.org, then in this folder run:

```
npm install
node server.js
```

Open http://localhost:3000. Other people on the same Wi-Fi can join at `http://YOUR-COMPUTER'S-IP:3000`.

Settings, all optional:

- `PORT`: which port to use. Render sets this for you.
- `MAX_PER_IP`: how many connections one network address may open. The default is 8.
