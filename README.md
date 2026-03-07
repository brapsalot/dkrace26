# DK Rap Chaos v2 — Speedrun Race Event Tool

A viewer page for Donkey Kong Country speedrun races. Embeds all 4 Twitch streams, tracks who's ahead live, lets viewers trigger the DK Rap lockout, take control of streamers' games via donation, and interact via CrowdControl.

**Live:** https://dkrace.up.railway.app

---

## Features

- **4-Stream Twitch Embed** — 2x2 grid of all racers' streams on one page
- **Live Race Leaderboard** — tracks each streamer's progress via BizHawk RAM reading
- **DK Rap Trigger** — donate $5+ to lock all 4 streamers out for 3:28 and play the DK Rap
- **Take Control (Single $2.50 / All $10)** — donate to control a streamer's game for 30s via virtual SNES gamepad overlay
- **Claim Code System** — unique codes link Streamlabs donations to specific viewers
- **CrowdControl Integration** — embedded CrowdControl effects menu
- **Per-Streamer Auth Keys** — secret keys prevent streamer impersonation
- **Responsive Layout** — desktop (two-column) and mobile (stacked)

---

## Architecture

```
Viewer Browser (index.html)
      |
      v  WebSocket
  [ server.js on Railway ]
      |
      v  HTTP POST /bizhawk/heartbeat
  [ bizhawk-bridge.js ] <-- file I/O --> [ race_tracker.lua in BizHawk ]
  (runs on each streamer's PC)            (reads RAM, injects inputs, plays DK Rap video)
```

- **Server** (Railway) — handles viewers, donations, CrowdControl, input relay
- **Bridge** (streamer PC) — polls server via HTTPS, relays commands to Lua via file I/O
- **Lua script** (BizHawk) — reads game progress, blocks inputs during DK Rap, injects viewer inputs
- **OBS Browser Source** — plays DK Rap audio through streamer's stream

---

## Deployment (Railway)

The server is deployed at https://dkrace.up.railway.app

### Environment Variables (Railway)

| Variable | Required | Description |
|---|---|---|
| `STREAMER_KEYS` | Yes | JSON map of streamer names to secret keys |
| `CC_TOKEN` | Yes | CrowdControl auth token (JSON from cc_token.json) |
| `TRIGGER_SECRET` | No | Secret code for manual trigger (default: `dkrap2024`) |
| `MIN_DONATION` | No | Min donation for DK Rap (default: `5`) |

### Streamlabs Webhook Setup

1. Go to https://streamlabs.com/dashboard#/settings/api-settings
2. Under **Webhooks**, set the webhook URL to:
   ```
   https://dkrace.up.railway.app/streamlabs
   ```
3. Save. Now when a viewer donates via Streamlabs, the webhook fires and the server processes it automatically.

Donation messages should follow the format:
- `DK RAP` — triggers DK Rap lockout ($5+)
- `CONTROL:StreamerName:ABCD` — Take Control with claim code ($2.50+ single, $10+ all)

---

## Streamer Setup

Each streamer gets a ZIP package containing everything they need. See `setup/create-packages.js`.

### Package Contents

```
DK-Rap-Chaos-{Name}/
  start-bridge.bat       Double-click to run (key + URL pre-configured)
  bizhawk-bridge.js      HTTP bridge between BizHawk and server
  bizhawk/
    race_tracker.lua     BizHawk Lua script (pre-configured with name)
    dkc_levels.lua       DKC level ID mapping
  README.txt             Full setup instructions
```

### What Each Streamer Needs

1. **Node.js** — for running bizhawk-bridge.js
2. **BizHawk 2.6+** — with DKC SNES ROM
3. **OBS Browser Source** — URL: `https://dkrace.up.railway.app/obs-audio` (for DK Rap audio)

### Startup Order

1. Open BizHawk, load DKC ROM
2. Double-click `start-bridge.bat`
3. In BizHawk: Tools > Lua Console > load `race_tracker.lua`
4. Ensure OBS has the browser audio source running

---

## Config (config.json)

```json
{
  "streamers": [
    { "name": "Smile", "twitchChannel": "smile_sc" },
    { "name": "UpATree", "twitchChannel": "upatree" },
    { "name": "Deth", "twitchChannel": "dethsc" },
    { "name": "JuggernautJason", "twitchChannel": "juggernautjason" }
  ],
  "twitchParentDomains": ["localhost", "dkrace.up.railway.app"],
  "takeControlDonationSingle": 2.5,
  "takeControlDonationAll": 10,
  "takeControlDurationMs": 30000,
  "dkRapDurationMs": 208000
}
```

---

## Viewer Features

### DK Rap Trigger
Donate $5+ via Streamlabs with message `DK RAP`. All streamers get locked out for 3:28 — inputs blocked, DK Rap video overlay plays in BizHawk, audio plays through OBS.

### Take Control
- **Single streamer ($2.50)** — control one streamer's game for 30s
- **All streamers ($10)** — control all 4 simultaneously for 30s
- Viewer gets a claim code (e.g. `A7K3`) to include in their Streamlabs donation message
- After donation confirms, viewer clicks "ACTIVATE CONTROL" to start their 30s timer
- Virtual SNES gamepad overlay appears over the stream

### Keyboard Controls (during Take Control)
Arrows=D-Pad, Z=B, X=A, A=Y, S=X, Q=L, W=R, Enter=Start, Shift=Select

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Viewer page |
| `/health` | GET | Health check |
| `/config` | GET | Public config |
| `/trigger` | POST | Manual DK Rap trigger |
| `/streamlabs` | POST | Streamlabs webhook |
| `/obs-audio` | GET | OBS browser source audio page |
| `/bizhawk/heartbeat` | POST | BizHawk bridge heartbeat (auth required) |
| `/media/dkrap_audio.m4a` | GET | DK Rap audio file |

---

## File Structure

```
DK rap/
  server.js              Node.js server (Express + WebSocket)
  index.html             Viewer page
  config.json            Streamer config + settings
  cc-client.js           CrowdControl PubSub client
  bizhawk-bridge.js      BizHawk <-> server HTTP bridge
  streamer_client.py     Python client (optional, for external DK Rap playback)
  extract-frames.js      Extracts video frames + audio from dkrap360.mp4
  generate-keys.js       Generates per-streamer auth keys
  obs-audio.html         OBS browser source audio overlay
  public/
    css/styles.css       Styles
    js/app.js            Main viewer client
    js/twitch-embeds.js  Twitch stream embedding
    js/leaderboard.js    Race standings
    js/gamepad.js        Virtual SNES gamepad
    js/layout.js         Responsive layout
    js/draw.js           Canvas drawing
  bizhawk/
    race_tracker.lua     BizHawk Lua script (progress + input + DK Rap video)
    dkc_levels.lua       DKC level ID mapping
  setup/
    create-packages.js   Generates per-streamer setup ZIPs
```

---

## Conflict Rules

| Scenario | Behavior |
|---|---|
| DK Rap during Take Control | Inputs blocked, control timer keeps counting |
| Take Control during DK Rap | Rejected — try again after it ends |
| Two viewers, same streamer | Second request rejected |
| Two viewers, different streamers | Both allowed simultaneously |
