// ── Ruff Mode Bingo ───────────────────────────────
const Bingo = (() => {
  const FREE_SPACE = 'Leaves League';
  const BINGO_ITEMS = [
    'Talks about D&D',
    "I'm making money on crypto",
    'Lectures chat about politics and business',
    'Manages to draw a lost game',
    'Says some gay cringe masculinity shit',
    'Does the balance council lisp',
    '"chicks"',
    'Opens ghost cloak drop',
    'Floats more than 2k by 9 mins',
    'Whines about SC2',
    'Whines about social media',
    'Do your own research guys',
    'Talks about trans',
    'Begs for donations or subs',
    'Coaches how to pickup girls',
    'Tries to give self-help lecture',
    'Shows his text messages/phone on stream',
    'Beats 4.3k and brags about it',
    'Hits 1000 minerals on 1 base',
    'Shit talks family',
    'Does landed viking tank drop',
    'Mentions ex-wife',
    'Builds too many prod facilities per base',
    'Stays in game under 10 supply',
    'Brings up his old condo',
    'Gives workout advice',
    'Complains about past nerfs',
    'Loses to roach ravager timing before BC builds',
    'Opponent is 4+ bases up',
    'Complains about standard play',
    'Loses to cannon rush',
    'Loses to one of the boys',
    'Talks about receipts',
    'Calls his opponent a little bitch',
    'Balance council',
    '"there we go"',
    'Talks about crypto',
    'Someone complains about audio',
    'Chatter baits ruff into monologue',
    'Talks about his girl',
    'EU Cucks',
    '"You know what I mean"',
    'Zoomer influencers',
    '"normies"',
    '"common sense"',
    'Brings up being rank 1 on the ladder',
    'Says "tier 1 spam"',
    'Loses to skytoss',
    'Chin in the air like he just don\'t care',
    'Rants about how easy protoss is',
    'Talks about people copying his builds',
    'Talks about or shows off his discord'
  ];

  let card = [];       // 25 cells: { text, marked }
  let active = false;
  let container = null;
  let onBingoCallback = null;
  let hasWon = false;

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function generateCard() {
    const shuffled = shuffle(BINGO_ITEMS);
    const picked = shuffled.slice(0, 24);
    card = picked.map(text => ({ text, marked: false }));
    // Insert free space at center (index 12)
    card.splice(12, 0, { text: FREE_SPACE, marked: true, free: true });
    hasWon = false;
  }

  function checkWin() {
    // Rows
    for (let r = 0; r < 5; r++) {
      if (card.slice(r * 5, r * 5 + 5).every(c => c.marked)) return true;
    }
    // Columns
    for (let c = 0; c < 5; c++) {
      let col = true;
      for (let r = 0; r < 5; r++) { if (!card[r * 5 + c].marked) { col = false; break; } }
      if (col) return true;
    }
    // Diagonals
    let d1 = true, d2 = true;
    for (let i = 0; i < 5; i++) {
      if (!card[i * 5 + i].marked) d1 = false;
      if (!card[i * 5 + (4 - i)].marked) d2 = false;
    }
    return d1 || d2;
  }

  function render() {
    const cardEl = container.querySelector('#bingoCard');
    if (!cardEl) return;
    cardEl.innerHTML = '';

    // Header row: B I N G O
    const letters = ['B', 'I', 'N', 'G', 'O'];
    letters.forEach(letter => {
      const hdr = document.createElement('div');
      hdr.className = 'bingo-header-cell';
      hdr.textContent = letter;
      cardEl.appendChild(hdr);
    });

    card.forEach((cell, i) => {
      const el = document.createElement('div');
      el.className = 'bingo-cell' + (cell.marked ? ' marked' : '') + (cell.free ? ' free-space' : '');
      if (hasWon) el.classList.add('game-won');
      el.textContent = cell.text;
      el.addEventListener('click', () => {
        if (hasWon) return;
        if (cell.free) return; // free space always marked
        cell.marked = !cell.marked;
        el.classList.toggle('marked', cell.marked);
        if (cell.marked && checkWin()) {
          hasWon = true;
          if (onBingoCallback) onBingoCallback();
          // Add won styling to all cells
          cardEl.querySelectorAll('.bingo-cell').forEach(c => c.classList.add('game-won'));
          const status = container.querySelector('#bingoStatus');
          if (status) { status.textContent = 'BINGO! 🎉'; status.style.color = '#00ff00'; }
        }
      });
      cardEl.appendChild(el);
    });
  }

  function init(containerEl, onBingo) {
    container = containerEl;
    onBingoCallback = onBingo;
    active = true;
    generateCard();
    render();

    // New card button
    const newBtn = container.querySelector('#bingoNewGameBtn');
    if (newBtn) {
      newBtn.onclick = () => {
        if (onBingoCallback && onBingoCallback.onNewGame) onBingoCallback.onNewGame();
      };
    }
  }

  function newGame() {
    generateCard();
    const status = container.querySelector('#bingoStatus');
    if (status) { status.textContent = ''; status.style.color = ''; }
    render();
  }

  function destroy() {
    active = false;
    card = [];
    hasWon = false;
    if (container) {
      const cardEl = container.querySelector('#bingoCard');
      if (cardEl) cardEl.innerHTML = '';
    }
    container = null;
    onBingoCallback = null;
  }

  function isActive() { return active; }

  return { init, destroy, isActive, newGame };
})();
