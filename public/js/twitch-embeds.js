// ── Twitch Stream Embeds ─────────────────────────────────────
// Creates 4 Twitch player embeds in a 2x2 grid
// Tracks online/offline status per stream using Player events

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
    if (status[i]) return; // already marked online
    status[i] = true;
    const cell = document.getElementById(`stream-${i}`);
    if (cell) cell.setAttribute('data-online', 'true');
    console.log(`[Stream ${i}] ONLINE`);
    window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: true } }));
  }

  function setOffline(i) {
    if (!status[i]) return; // already marked offline
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
    StreamStatus.status[i] = false; // assume offline until proven otherwise

    // When the embed's internal player is ready, attach Player-level events
    embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
      try {
        const player = embed.getPlayer();
        StreamStatus.players[i] = player;

        // Use Twitch.Player constants with string fallbacks
        const EVT_ONLINE  = (typeof Twitch.Player !== 'undefined' && Twitch.Player.ONLINE)  || 'online';
        const EVT_OFFLINE = (typeof Twitch.Player !== 'undefined' && Twitch.Player.OFFLINE) || 'offline';
        const EVT_PLAYING = (typeof Twitch.Player !== 'undefined' && Twitch.Player.PLAYING) || 'playing';
        const EVT_PLAY    = (typeof Twitch.Player !== 'undefined' && Twitch.Player.PLAY)    || 'play';

        console.log(`[Stream ${i}] Player ready, binding events:`, EVT_ONLINE, EVT_OFFLINE, EVT_PLAYING);

        // Twitch.Player.ONLINE fires when the channel goes live
        player.addEventListener(EVT_ONLINE, () => {
          StreamStatus.setOnline(i);
        });

        // Twitch.Player.OFFLINE fires when the channel goes offline
        player.addEventListener(EVT_OFFLINE, () => {
          StreamStatus.setOffline(i);
        });

        // Twitch.Player.PLAYING fires when video is actually playing
        player.addEventListener(EVT_PLAYING, () => {
          StreamStatus.setOnline(i);
        });

        // Twitch.Player.PLAY fires when player unpauses / starts buffering
        player.addEventListener(EVT_PLAY, () => {
          StreamStatus.setOnline(i);
        });

        // Check initial state after a delay
        setTimeout(() => {
          try {
            // isPaused() returns false when a live stream is playing
            if (!player.isPaused()) {
              StreamStatus.setOnline(i);
            }
          } catch (e) { /* ignore */ }
        }, 3000);

      } catch (e) {
        console.warn(`[Stream ${i}] Could not get player:`, e);
      }
    });
  });
}
