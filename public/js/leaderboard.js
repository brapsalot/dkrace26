// ── Race Leaderboard (updates stream labels directly) ────────

function updateLeaderboard(standings) {
  if (!standings || standings.length === 0) return;

  // Build a lookup: streamer name -> standing data
  var lookup = {};
  standings.forEach(function(s) { lookup[s.name] = s; });

  // Update each stream cell label
  document.querySelectorAll('.stream-cell').forEach(function(cell) {
    var label = cell.querySelector('.stream-label');
    if (!label) return;

    var levelEl = cell.querySelector('.stream-level-label');

    // Get the base streamer name (stored as data attribute or from initial text)
    var baseName = label.dataset.streamerName;
    if (!baseName) {
      // First time: store the original name
      baseName = label.textContent.trim();
      label.dataset.streamerName = baseName;
    }

    var standing = lookup[baseName];
    if (!standing) return;

    // Update label: "#N - Name"
    label.textContent = '#' + standing.position + ' - ' + baseName;

    // Apply position color class
    label.className = 'stream-label stream-pos-' + standing.position;

    // Create or update level sub-label
    if (!levelEl) {
      levelEl = document.createElement('span');
      levelEl.className = 'stream-level-label';
      label.parentNode.insertBefore(levelEl, label.nextSibling);
    }
    levelEl.textContent = standing.levelName + (standing.connected ? '' : ' (offline)');

    // Also update toolbar streamer button label
    var idx = cell.id.replace('stream-', '');
    var toolbarBtn = document.querySelector('.toolbar-streamer-btn[data-stream="' + idx + '"]');
    if (toolbarBtn) {
      toolbarBtn.textContent = '#' + standing.position + ' ' + baseName;
    }
  });
}
