// ── Twitch Stream Embeds ─────────────────────────────────────
// Creates 4 Twitch player embeds in a 2x2 grid

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

    new Twitch.Embed(`stream-embed-${i}`, {
      width: '100%',
      height: '100%',
      channel: s.twitchChannel,
      layout: 'video',
      parent: parentDomains,
      muted: i > 0  // Only first stream has audio
    });
  });
}
