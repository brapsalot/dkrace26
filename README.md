# DK Rap Chaos v2 — Speedrun Race Event Tool

A viewer page for Donkey Kong Country speedrun races. Embeds all 4 Twitch streams, tracks who's ahead live, lets viewers trigger the DK Rap lockout, take control of streamers' games, and interact via CrowdControl.

---

## Features

- **4-Stream Twitch Embed** — 2x2 grid of all racers' streams on one page
- **Live Race Leaderboard** — automatically tracks each streamer's progress via BizHawk RAM reading
- **DK Rap Trigger** — viewers donate to lock all 4 streamers out and force them to watch the DK Rap
- **DK Rap Counter** — persistent count of how many times the DK Rap has played
- **Take Control ($10)** — viewers can donate to control a streamer's game for 30 seconds via a virtual SNES gamepad
- **CrowdControl Integration** — embedded CrowdControl effects menu for shared game interactions
- **Responsive Layout** — works on desktop (two-column) and mobile (stacked)

---

## Architecture

```
Viewer Browser (index.html)
      |
      v  WebSocket + REST
  [ server.js ]  ─── WebSocket ──> streamer_client.py (x4, DK Rap lockout)
   (port 3000)   ─── TCP socket ──> race_tracker.lua in BizHawk (x4, race + input)
                  (port 3001)
```

---

## Setup

### 1 — Install & Run the Server

```bash
npm install
npm start
```

The server runs on port 3000 (HTTP/WebSocket) and 3001 (TCP for BizHawk).

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `TCP_PORT` | `3001` | TCP port for BizHawk Lua connections |
| `TRIGGER_SECRET` | `dkrap2024` | Secret code viewers need to trigger events |
| `MIN_DONATION` | `5` | Minimum donation to trigger DK Rap |

### 2 — Edit config.json

```json
{
  "streamers": [
    { "name": "Smile", "twitchChannel": "smile_sc" },
    { "name": "UpATree", "twitchChannel": "upatree" },
    { "name": "Deth", "twitchChannel": "dethsc" },
    { "name": "JuggernautJason", "twitchChannel": "juggernautjason" }
  ],
  "twitchParentDomains": ["your-app.up.railway.app", "localhost"],
  "crowdControlUrl": "https://interact.crowdcontrol.live/#/twitch/yourchannel",
  "minDonation": 5,
  "takeControlDonation": 10,
  "takeControlDurationMs": 30000,
  "dkRapDurationMs": 185000
}
```

**Important:** Set `twitchParentDomains` to your actual deployment domain, or Twitch embeds won't load.

### 3 — Deploy to Railway

1. Push to a GitHub repo
2. Create a new project at https://railway.app
3. Set environment variables: `TRIGGER_SECRET`, `MIN_DONATION`
4. Share the Railway URL with viewers

---

## Streamer Setup

Each streamer needs to run **two things**:

### A — Python Client (DK Rap lockout)

```bash
pip install websockets
python streamer_client.py
```

Edit the config section at the top:

| Variable | Description |
|---|---|
| `SERVER_URL` | WebSocket URL (e.g. `wss://your-app.up.railway.app`) |
| `STREAMER_NAME` | Your name shown on the viewer page |
| `DK_RAP_LOCAL` | Path to local DK Rap video (or `None` for YouTube) |
| `DK_RAP_DURATION` | How long to lock out (default 185s) |
| `LOCK_METHOD` | `"vgamepad"`, `"keyboard"`, or `"none"` |

### B — BizHawk Lua Script (race tracking + viewer input)

1. Open BizHawk and load the Donkey Kong Country ROM
2. Edit `bizhawk/race_tracker.lua`:
   - Set `SERVER_HOST` and `SERVER_PORT` (default: localhost:3001)
   - Set `STREAMER_NAME` to match your name in `config.json`
3. In BizHawk: Tools > Lua Console > Open Script > select `race_tracker.lua`

The Lua script will:
- Read game memory to track your current level
- Send progress to the server for the live leaderboard
- Receive and inject viewer controller inputs (Take Control feature)
- Block your inputs during DK Rap lockout

#### Verifying Level IDs

The level ID mapping in `bizhawk/dkc_levels.lua` may need adjustment for your ROM:

1. Set `DISCOVERY_MODE = true` in `race_tracker.lua`
2. Play through the game — each new level ID prints to the Lua console
3. Update `dkc_levels.lua` with the correct hex values
4. Set `DISCOVERY_MODE = false` for the actual race

---

## Controller Lockout Methods

### Virtual Gamepad Proxy (best for USB controllers)

1. Install [ViGEmBus driver](https://github.com/nefarius/ViGEmBus/releases) (Windows)
2. `pip install vgamepad inputs`
3. Set `LOCK_METHOD = "vgamepad"`
4. In your emulator, select the virtual Xbox 360 controller as your input device

### Keyboard Suppression

1. `pip install pynput`
2. Set `LOCK_METHOD = "keyboard"`

### Honor System

Set `LOCK_METHOD = "none"` — DK Rap plays but no lockout enforced.

---

## Viewer Features

### DK Rap Trigger
Viewers enter their name, donation amount (min $5), and the secret code, then hit the button. All streamers get locked out and the DK Rap plays.

### Take Control ($10)
Viewers donate $10, select a streamer, and get 30 seconds of control. They can use:
- **Virtual SNES gamepad** — click/tap on-screen buttons
- **Keyboard** — Arrows=D-Pad, Z=B, X=A, A=Y, S=X, Q=L, W=R, Enter=Start, Shift=Select

### CrowdControl
The CrowdControl effects menu is embedded (or linked) on the viewer page. All 4 streamers share the same CrowdControl redeems.

---

## Conflict Rules

| Scenario | Behavior |
|---|---|
| DK Rap during Take Control | Inputs blocked, control timer keeps counting |
| Take Control during DK Rap | Rejected — try again after it ends |
| Two viewers, same streamer | Second request rejected |
| Two viewers, different streamers | Both allowed simultaneously |

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Viewer page |
| `/config` | GET | Public config (streamer names, Twitch channels) |
| `/trigger` | POST | Trigger DK Rap (requires secret) |
| `/streamlabs` | POST | Streamlabs webhook auto-trigger |
| `/status` | GET | Server health/status check |

---

## File Structure

```
DK rap/
  server.js              Node.js server (HTTP + WebSocket + TCP)
  index.html             Viewer page
  config.json            Streamer names, Twitch channels, settings
  dk_rap_count.json      Persistent DK Rap counter
  package.json           Dependencies
  streamer_client.py     Python client for DK Rap lockout
  public/
    css/styles.css       Styles
    js/app.js            Main viewer client
    js/twitch-embeds.js  Twitch stream embedding
    js/leaderboard.js    Race standings display
    js/gamepad.js        Virtual SNES gamepad + keyboard input
  bizhawk/
    race_tracker.lua     BizHawk Lua script (progress + input)
    dkc_levels.lua       DKC level ID mapping
```
