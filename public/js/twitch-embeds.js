// ── Twitch Stream Embeds ─────────────────────────────────────
// Creates 4 Twitch player embeds in a 2x2 grid
// Tracks online/offline status via multiple detection methods

const StreamStatus = (() => {
  const status = {};   // index -> boolean (true = online)
  const embeds = {};   // index -> Twitch.Embed instance
  const players = {};  // index -> Twitch.Player instance

  function get() { return { ...status }; }

  function isOnline(index) { return !!status[index]; }

  function onlineCount() {
    return Object.values(status).filter(Boolean).length;
  }

  function setOnline(i) {
    if (status[i]) return;
    status[i] = true;
    const cell = document.getElementById(`stream-${i}`);
    if (cell) cell.setAttribute('data-online', 'true');
    console.log(`[Stream ${i}] ONLINE`);
    window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: true } }));
  }

  function setOffline(i) {
    if (!status[i]) return;
    status[i] = false;
    const cell = document.getElementById(`stream-${i}`);
    if (cell) cell.removeAttribute('data-online');
    console.log(`[Stream ${i}] OFFLINE`);
    window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: false } }));
  }

  return { get, isOnline, onlineCount, setOnline, setOffline, status, embeds, players };
})();

function initTwitchEmbeds(streamers, parentDomains) {
  if (!window.Twitch || !window.Twitch.Embed) {
    console.warn('Twitch embed SDK not loaded');
    return;
  }

  streamers.forEach((s, i) => {
    const container = document.getElementById(`stream-${i}`);
    if (!container) return;

    // Add streamer label
    const label = container.querySelector('.stream-label');
    if (label) label.textContent = s.name;

    const embed = new Twitch.Embed(`stream-embed-${i}`, {
      width: '100%',
      height: '100%',
      channel: s.twitchChannel,
      layout: 'video',
      parent: parentDomains,
      muted: i > 0  // Only first stream has audio
    });

    StreamStatus.embeds[i] = embed;
    StreamStatus.status[i] = false;

    // ── Method 1: Embed-level VIDEO_PLAY ──
    // This fires on the Embed object when video playback starts.
    // Catches the case where the stream is already live when embed loads.
    embed.addEventListener(Twitch.Embed.VIDEO_PLAY, () => {
      console.log(`[Stream ${i}] VIDEO_PLAY fired`);
      StreamStatus.setOnline(i);
    });

    // ── Method 2: Player-level events (after VIDEO_READY) ──
    embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
      try {
        const player = embed.getPlayer();
        StreamStatus.players[i] = player;
        console.log(`[Stream ${i}] Player ready`);

        // Bind all possible player events with string fallbacks
        const events = {
          online:  (window.Twitch.Player && Twitch.Player.ONLINE)  || 'online',
          offline: (window.Twitch.Player && Twitch.Player.OFFLINE) || 'offline',
          playing: (window.Twitch.Player && Twitch.Player.PLAYING) || 'playing',
          play:    (window.Twitch.Player && Twitch.Player.PLAY)    || 'play',
          ended:   (window.Twitch.Player && Twitch.Player.ENDED)   || 'ended'
        };

        player.addEventListener(events.online, () => {
          console.log(`[Stream ${i}] Player.ONLINE`);
          StreamStatus.setOnline(i);
        });

        player.addEventListener(events.offline, () => {
          console.log(`[Stream ${i}] Player.OFFLINE`);
          StreamStatus.setOffline(i);
        });

        player.addEventListener(events.playing, () => {
          console.log(`[Stream ${i}] Player.PLAYING`);
          StreamStatus.setOnline(i);
        });

        player.addEventListener(events.play, () => {
          console.log(`[Stream ${i}] Player.PLAY`);
          StreamStatus.setOnline(i);
        });

        player.addEventListener(events.ended, () => {
          console.log(`[Stream ${i}] Player.ENDED`);
          StreamStatus.setOffline(i);
        });

      } catch (e) {
        console.warn(`[Stream ${i}] Player init error:`, e);
      }
    });
  });

  // ── Method 3: Polling fallback ──
  // Every 8 seconds, check each player's state.
  // This catches cases where events were missed (race conditions).
  setInterval(() => {
    for (const [idx, player] of Object.entries(StreamStatus.players)) {
      try {
        const i = parseInt(idx);
        const paused = player.isPaused();
        const ended = player.getEnded();

        if (!paused && !ended) {
          // Player is actively playing → stream is online
          StreamStatus.setOnline(i);
        } else if (ended) {
          // Stream ended
          StreamStatus.setOffline(i);
        }
        // If paused, don't change status — user may have paused a live stream
      } catch (e) { /* ignore — player not ready yet */ }
    }
  }, 8000);
}
