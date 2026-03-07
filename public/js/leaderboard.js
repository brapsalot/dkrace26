// ── Race Leaderboard ─────────────────────────────────────────

function updateLeaderboard(standings) {
  const container = document.getElementById('leaderboard');
  if (!container) return;

  if (!standings || standings.length === 0) {
    container.innerHTML = '<span class="empty-msg">Waiting for race data...</span>';
    return;
  }

  container.innerHTML = standings.map(s => {
    const posClass = `pos-${s.position}`;
    const dcClass = s.connected ? '' : ' lb-disconnected';
    const firstClass = s.position === 1 ? ' first' : '';
    return `
      <div class="lb-entry${firstClass}${dcClass}">
        <div class="lb-position ${posClass}">#${s.position}</div>
        <div class="lb-info">
          <div class="lb-name">${s.name}</div>
          <div class="lb-level">${s.levelName}${s.connected ? '' : ' (offline)'}</div>
        </div>
      </div>
    `;
  }).join('');
}
