// ── Twitch Stream Embeds ─────────────────────────────────────
// Creates 4 Twitch player embeds in a 2x2 grid
// Tracks online/offline status per stream

const StreamStatus = (() => {
  const status = {};   // index -> boolean (true = online)
  const embeds = {};   // index -> Twitch.Embed instance

  function get() { return { ...status }; }

  function isOnline(index) { return !!status[index]; }

  function onlineCount() {
    return Object.values(status).filter(Boolean).length;
  }

  return { get, isOnline, onlineCount, status, embeds };
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

    // Listen for online/offline events
    embed.addEventListener(Twitch.Embed.VIDEO_PLAY, () => {
      if (!StreamStatus.status[i]) {
        StreamStatus.status[i] = true;
        document.getElementById(`stream-${i}`).setAttribute('data-online', 'true');
        window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: true } }));
      }
    });

    embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
      // Check player state after a short delay to detect offline
      setTimeout(() => {
        try {
          const player = embed.getPlayer();
          if (player) {
            // If channel is offline, playback won't start — check periodically
            const checkInterval = setInterval(() => {
              try {
                const qualities = player.getQualities();
                // If we have quality options, stream is likely online
                if (qualities && qualities.length > 1) {
                  if (!StreamStatus.status[i]) {
                    StreamStatus.status[i] = true;
                    document.getElementById(`stream-${i}`).setAttribute('data-online', 'true');
                    window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: true } }));
                  }
                  clearInterval(checkInterval);
                }
              } catch (e) { /* ignore */ }
            }, 5000);

            // Stop checking after 30s
            setTimeout(() => clearInterval(checkInterval), 30000);
          }
        } catch (e) { /* ignore */ }
      }, 2000);
    });

    // Twitch SDK fires OFFLINE when stream goes offline
    if (Twitch.Embed.OFFLINE) {
      embed.addEventListener(Twitch.Embed.OFFLINE, () => {
        StreamStatus.status[i] = false;
        document.getElementById(`stream-${i}`).removeAttribute('data-online');
        window.dispatchEvent(new CustomEvent('stream-status-change', { detail: { index: i, online: false } }));
      });
    }
  });
}
