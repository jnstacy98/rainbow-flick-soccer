# Rainbow Flick Soccer

A third-person 3D soccer game you play in the browser with friends. 1v1 up to 9v9.

- **Create game**: you get a 6-character invite code and an invite link.
- **Send the link**: the link opens the game with the code already filled in. Your friend types a name and presses **Join**.
- **Teams**: up to 9 players per team. Players can switch teams in the lobby, and the host can fill empty spots with bots.
- **Pause or end the match**: open the menu (`Esc` or ☰). Anyone can pause or resume the match for everyone, and the host can end it early to show the result or go back to the lobby.
- **Call for a pass**: press `R` and a "PASS!" bubble appears over your head. Bot teammates on the ball will pass to you, and human teammates get a notification.
- **Bot skill levels**: the host picks Easy, Normal, Hard or Pro bots separately for each team, in the lobby or from the in-game menu.
- **Play goalkeeper**: tap **🧤 Play goalkeeper** in the lobby or the in-game menu (one per team). In your own box you catch the ball automatically. Tackle dives, Pass throws to a teammate, Shoot punts, Chip lobs and Flick rolls the ball out. You can hold the ball for up to 6 seconds.
- **Camera**: the default Pitch view looks down the pitch toward the goal you're attacking and leans a little toward the ball, so "up" on the stick always means toward that goal. `V` (or the menu) switches to Follow player (turns behind you as you run), Ball cam or Manual.
- **Aim arrow and pass target**: when you're on the ball, a yellow arrow shows where a kick will go, and a yellow ring marks the teammate a pass will reach.
- **Free-kick tie breaker**: if a match ends level, it goes to a free-kick shootout. Teams take turns shooting at one goal against the other team's keeper: five kicks each, then sudden death. As the kicker, aim with the stick or `A`/`D` (the arrow shows where) and shoot. As the keeper, move along the line and dive. The host can turn it off in the lobby ("If it's a draw").
- **Practice offline**: play against bots by yourself, no internet needed.

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move | `W A S D` | Left-side joystick |
| Sprint | `Shift` | Sprint button |
| Camera | Mouse (click the field to lock it), `← →` | Drag on the right side |
| Shoot (hold to charge) | Hold left click or `Space` | Hold Shoot |
| Pass to a teammate | Right click or `E` | Pass |
| Chip / lob | `Q` | Chip |
| Rainbow flick | `F` | Flick |
| Tackle (keeper: dive) | `C` | Tackle / Dive |
| Call for a pass | `R` | Call |
| Pause / resume match for everyone | `P` (or the menu) | Menu → Pause |
| Aim | Shots, passes and chips go the way you're steering. Standing still, they go where the camera looks. Shots close to the goal get a little aim assist. | same |
| Camera mode (Pitch / Follow / Ball / Manual) | `V` | Menu |
| Scores / mute / menu | `Tab` / `M` / `Esc` | ☰ button |

## Hosting the page (GitHub Pages)

It's a static site with no build step and no game server.

1. Merge this branch into `main`.
2. On GitHub, open the repo and go to **Settings → Pages**.
3. Under **Build and deployment**, pick **Deploy from a branch**, then branch `main` and folder `/ (root)`. Save.
4. After about a minute the game is live at `https://<your-username>.github.io/rainbow-flick-soccer/`.

Any other static host (Netlify, Vercel, Cloudflare Pages, itch.io as an HTML game) also works: upload the repo as it is.

## How online play works

- Players connect peer-to-peer over WebRTC with [PeerJS](https://peerjs.com/). The invite code is the host's peer ID, so you don't need your own server.
- The host's browser runs the match (physics, bots, scoring) and sends the game state to everyone about 20 times a second. Other players send their inputs, and their own player is predicted on their screen so movement feels responsive.
- The host should keep their tab open. If the host leaves, the match ends for everyone.
- Matchmaking uses the free public PeerJS server (`0.peerjs.com`). To use your own [PeerServer](https://github.com/peers/peerjs-server), add `?peerhost=your.host&peerport=443&peerpath=/` to the page URL. Invite links keep those settings.
- A few strict networks (some corporate or school Wi-Fi) block WebRTC. If a friend can't connect, try a different network or a phone hotspot.

## Project layout

```
index.html       Page, menus, lobby and HUD markup
css/style.css    Styling
js/main.js       App flow: menu, lobby, hosting/joining, game loop, HUD
js/sim.js        Authoritative soccer simulation and bot AI (no DOM)
js/render.js     three.js stadium, players, ball, camera and effects
js/net.js        PeerJS host/client networking and invite codes
js/input.js      Keyboard, mouse and touch controls
js/audio.js      Synthesized sound effects
```

To run it locally, serve the folder with any static server, for example `python3 -m http.server`, then open `http://localhost:8000`. Opening `index.html` directly from disk won't work because ES modules need a server.
