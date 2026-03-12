// ══════════════════════════════════════════════════════
//  Tetris — Full browser-based Tetris with T-spins
//  Integrated into DK Race Ruff Mode
// ══════════════════════════════════════════════════════

const Tetris = (() => {
  const COLS = 10;
  const ROWS = 20;
  const BLOCK = 28; // px per cell
  const COLORS = {
    I: '#00f0f0', O: '#f0f000', T: '#a000f0',
    S: '#00f000', Z: '#f00000', J: '#0000f0', L: '#f0a000'
  };
  const GHOST_ALPHA = 0.25;

  // SRS piece definitions (4 rotations each)
  const PIECES = {
    I: [
      [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
      [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
      [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
      [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]
    ],
    O: [
      [[1,1],[1,1]],
      [[1,1],[1,1]],
      [[1,1],[1,1]],
      [[1,1],[1,1]]
    ],
    T: [
      [[0,1,0],[1,1,1],[0,0,0]],
      [[0,1,0],[0,1,1],[0,1,0]],
      [[0,0,0],[1,1,1],[0,1,0]],
      [[0,1,0],[1,1,0],[0,1,0]]
    ],
    S: [
      [[0,1,1],[1,1,0],[0,0,0]],
      [[0,1,0],[0,1,1],[0,0,1]],
      [[0,0,0],[0,1,1],[1,1,0]],
      [[1,0,0],[1,1,0],[0,1,0]]
    ],
    Z: [
      [[1,1,0],[0,1,1],[0,0,0]],
      [[0,0,1],[0,1,1],[0,1,0]],
      [[0,0,0],[1,1,0],[0,1,1]],
      [[0,1,0],[1,1,0],[1,0,0]]
    ],
    J: [
      [[1,0,0],[1,1,1],[0,0,0]],
      [[0,1,1],[0,1,0],[0,1,0]],
      [[0,0,0],[1,1,1],[0,0,1]],
      [[0,1,0],[0,1,0],[1,1,0]]
    ],
    L: [
      [[0,0,1],[1,1,1],[0,0,0]],
      [[0,1,0],[0,1,0],[0,1,1]],
      [[0,0,0],[1,1,1],[1,0,0]],
      [[1,1,0],[0,1,0],[0,1,0]]
    ]
  };

  // SRS wall kick data
  const KICK_JLSTZ = [
    [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],  // 0->1
    [[0,0],[1,0],[1,-1],[0,2],[1,2]],       // 1->2
    [[0,0],[1,0],[1,1],[0,-2],[1,-2]],      // 2->3
    [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]    // 3->0
  ];
  const KICK_JLSTZ_CCW = [
    [[0,0],[1,0],[1,1],[0,-2],[1,-2]],      // 0->3
    [[0,0],[1,0],[1,-1],[0,2],[1,2]],       // 1->0
    [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],  // 2->1
    [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]    // 3->2
  ];
  const KICK_I = [
    [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    [[0,0],[1,0],[-2,0],[1,-2],[-2,1]]
  ];
  const KICK_I_CCW = [
    [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    [[0,0],[-2,0],[1,0],[-2,-1],[1,2]]
  ];

  // T-spin corner check positions for each rotation state
  const T_CORNERS = [
    [[0,0],[2,0],[0,2],[2,2]],  // rot 0: front corners [0,0],[2,0]; back [0,2],[2,2]
    [[0,0],[0,2],[2,0],[2,2]],  // rot 1
    [[0,2],[2,2],[0,0],[2,0]],  // rot 2
    [[2,0],[2,2],[0,0],[0,2]]   // rot 3
  ];
  // Front corners are indices 0,1; back corners are 2,3
  const T_FRONT = [[0,1],[0,1],[0,1],[0,1]];

  let canvas, ctx, previewCanvas, previewCtx, holdCanvas, holdCtx;
  let board, current, currentType, currentRot, currentX, currentY;
  let bag, nextQueue, holdPiece, holdUsed;
  let score, level, lines, combo;
  let dropInterval, dropTimer, lockDelay, lockTimer, lockMoves;
  let gameOver, paused, running;
  let lastAction, lastWasRotation, lastKickUsed;
  let animFrame;
  let backToBack;
  let onClose;

  function init(closeCallback) {
    onClose = closeCallback;
    const overlay = document.getElementById('tetrisOverlay');
    if (!overlay) return;

    canvas = document.getElementById('tetrisCanvas');
    ctx = canvas.getContext('2d');
    canvas.width = COLS * BLOCK;
    canvas.height = ROWS * BLOCK;

    previewCanvas = document.getElementById('tetrisPreview');
    previewCtx = previewCanvas.getContext('2d');
    previewCanvas.width = 4 * BLOCK;
    previewCanvas.height = 12 * BLOCK;

    holdCanvas = document.getElementById('tetrisHold');
    holdCtx = holdCanvas.getContext('2d');
    holdCanvas.width = 4 * BLOCK;
    holdCanvas.height = 3 * BLOCK;

    document.getElementById('tetrisClose').addEventListener('click', close);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    reset();
    overlay.style.display = 'flex';
    running = true;
    gameLoop();
  }

  function close() {
    running = false;
    const overlay = document.getElementById('tetrisOverlay');
    if (overlay) overlay.style.display = 'none';
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keyup', handleKeyUp);
    heldKeys = {};
    if (animFrame) cancelAnimationFrame(animFrame);
    if (onClose) onClose();
  }

  function reset() {
    board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    bag = [];
    nextQueue = [];
    for (let i = 0; i < 5; i++) nextQueue.push(pullFromBag());
    holdPiece = null;
    holdUsed = false;
    score = 0;
    level = 1;
    lines = 0;
    combo = -1;
    backToBack = false;
    dropInterval = 1000;
    dropTimer = 0;
    lockDelay = 500;
    lockTimer = 0;
    lockMoves = 0;
    gameOver = false;
    paused = false;
    lastAction = '';
    lastWasRotation = false;
    lastKickUsed = false;
    spawnPiece();
  }

  function pullFromBag() {
    if (bag.length === 0) {
      bag = Object.keys(PIECES).slice();
      // Fisher-Yates shuffle
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  }

  function spawnPiece() {
    currentType = nextQueue.shift();
    nextQueue.push(pullFromBag());
    currentRot = 0;
    const shape = PIECES[currentType][0];
    currentX = Math.floor((COLS - shape[0].length) / 2);
    currentY = 0;
    holdUsed = false;
    lockTimer = 0;
    lockMoves = 0;
    lastWasRotation = false;
    lastKickUsed = false;

    if (collides(currentType, currentRot, currentX, currentY)) {
      gameOver = true;
    }
  }

  function getShape(type, rot) {
    return PIECES[type][rot % 4];
  }

  function collides(type, rot, x, y) {
    const shape = getShape(type, rot);
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const bx = x + c, by = y + r;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && board[by][bx]) return true;
      }
    }
    return false;
  }

  function lock() {
    const shape = getShape(currentType, currentRot);
    for (let r = 0; r < shape.length; r++) {
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const bx = currentX + c, by = currentY + r;
        if (by < 0) { gameOver = true; return; }
        board[by][bx] = currentType;
      }
    }

    // Check T-spin
    let tSpin = false;
    let tSpinMini = false;
    if (currentType === 'T' && lastWasRotation) {
      const corners = T_CORNERS[currentRot];
      let filled = 0;
      let frontFilled = 0;
      for (let i = 0; i < 4; i++) {
        const cx = currentX + corners[i][0];
        const cy = currentY + corners[i][1];
        const isFilled = cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS || (cy >= 0 && board[cy][cx]);
        if (isFilled) {
          filled++;
          if (i < 2) frontFilled++;
        }
      }
      if (filled >= 3) {
        if (frontFilled === 2) {
          tSpin = true;
        } else if (lastKickUsed) {
          tSpin = true;
        } else {
          tSpinMini = true;
        }
      }
    }

    // Clear lines
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every(c => c !== null)) {
        board.splice(r, 1);
        board.unshift(Array(COLS).fill(null));
        cleared++;
        r++; // recheck row
      }
    }

    // Scoring
    let points = 0;
    const isDifficult = tSpin || (cleared === 4);

    if (tSpin) {
      if (cleared === 0) points = 400 * level;
      else if (cleared === 1) points = 800 * level;
      else if (cleared === 2) points = 1200 * level;
      else if (cleared === 3) points = 1600 * level;
      lastAction = 'T-SPIN' + (cleared > 0 ? (' ' + ['', 'SINGLE', 'DOUBLE', 'TRIPLE'][cleared]) : '');
    } else if (tSpinMini) {
      if (cleared === 0) points = 100 * level;
      else if (cleared === 1) points = 200 * level;
      else if (cleared === 2) points = 400 * level;
      lastAction = 'MINI T-SPIN' + (cleared > 0 ? (' ' + ['', 'SINGLE', 'DOUBLE'][cleared]) : '');
    } else if (cleared > 0) {
      const base = [0, 100, 300, 500, 800];
      points = base[cleared] * level;
      if (cleared === 4) lastAction = 'TETRIS';
      else lastAction = ['', 'SINGLE', 'DOUBLE', 'TRIPLE'][cleared];
    } else {
      lastAction = '';
    }

    // Back-to-back bonus
    if (isDifficult && cleared > 0) {
      if (backToBack) {
        points = Math.floor(points * 1.5);
        lastAction = 'B2B ' + lastAction;
      }
      backToBack = true;
    } else if (cleared > 0) {
      backToBack = false;
    }

    // Combo
    if (cleared > 0) {
      combo++;
      if (combo > 0) points += 50 * combo * level;
    } else {
      combo = -1;
    }

    score += points;
    lines += cleared;
    level = Math.floor(lines / 10) + 1;
    dropInterval = Math.max(50, 1000 - (level - 1) * 80);

    updateHUD();
    spawnPiece();
  }

  function hardDrop() {
    let dropped = 0;
    while (!collides(currentType, currentRot, currentX, currentY + 1)) {
      currentY++;
      dropped++;
    }
    score += dropped * 2;
    lastWasRotation = false;
    lock();
  }

  function softDrop() {
    if (!collides(currentType, currentRot, currentX, currentY + 1)) {
      currentY++;
      score += 1;
      dropTimer = 0;
      lastWasRotation = false;
      return true;
    }
    return false;
  }

  function moveLeft() {
    if (!collides(currentType, currentRot, currentX - 1, currentY)) {
      currentX--;
      lastWasRotation = false;
      if (isOnGround()) { lockTimer = 0; lockMoves++; }
      return true;
    }
    return false;
  }

  function moveRight() {
    if (!collides(currentType, currentRot, currentX + 1, currentY)) {
      currentX++;
      lastWasRotation = false;
      if (isOnGround()) { lockTimer = 0; lockMoves++; }
      return true;
    }
    return false;
  }

  function rotate(dir) {
    const newRot = (currentRot + dir + 4) % 4;
    let kicks;
    if (currentType === 'I') {
      kicks = dir === 1 ? KICK_I[currentRot] : KICK_I_CCW[currentRot];
    } else if (currentType === 'O') {
      return false;
    } else {
      kicks = dir === 1 ? KICK_JLSTZ[currentRot] : KICK_JLSTZ_CCW[currentRot];
    }

    for (let i = 0; i < kicks.length; i++) {
      const [kx, ky] = kicks[i];
      if (!collides(currentType, newRot, currentX + kx, currentY - ky)) {
        currentX += kx;
        currentY -= ky;
        currentRot = newRot;
        lastWasRotation = true;
        lastKickUsed = i > 0; // kick test other than (0,0)
        if (isOnGround()) { lockTimer = 0; lockMoves++; }
        return true;
      }
    }
    return false;
  }

  function doHold() {
    if (holdUsed) return;
    holdUsed = true;
    if (holdPiece) {
      const tmp = holdPiece;
      holdPiece = currentType;
      currentType = tmp;
      currentRot = 0;
      const shape = PIECES[currentType][0];
      currentX = Math.floor((COLS - shape[0].length) / 2);
      currentY = 0;
      lockTimer = 0;
      lockMoves = 0;
    } else {
      holdPiece = currentType;
      spawnPiece();
    }
  }

  function isOnGround() {
    return collides(currentType, currentRot, currentX, currentY + 1);
  }

  function ghostY() {
    let gy = currentY;
    while (!collides(currentType, currentRot, currentX, gy + 1)) gy++;
    return gy;
  }

  // ── Input (DAS — Delayed Auto Shift) ─────────────
  const DAS_DELAY = 167;  // ms before auto-repeat starts
  const DAS_REPEAT = 33;  // ms between repeats (~30Hz)
  const SOFT_DROP_REPEAT = 33;
  let heldKeys = {};      // key -> { elapsed, fired }

  function handleKeyDown(e) {
    if (!running) return;
    if (gameOver) {
      if (e.key === 'r' || e.key === 'R') { reset(); }
      if (e.key === 'Escape') { close(); }
      return;
    }
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'p' || e.key === 'P') { paused = !paused; return; }
    if (paused) return;

    const repeatable = ['ArrowLeft', 'ArrowRight', 'ArrowDown'];
    if (repeatable.includes(e.key) || e.key === ' ' || e.key === 'ArrowUp' ||
        e.key === 'z' || e.key === 'Z' || e.key === 'x' || e.key === 'X' ||
        e.key === 'c' || e.key === 'C' || e.key === 'Shift') {
      e.preventDefault();
    }

    // Only fire once on initial press (not on OS key repeat)
    if (heldKeys[e.key]) return;

    // Fire immediately on first press
    fireKey(e.key);

    // Track for DAS (only for movement keys)
    if (repeatable.includes(e.key)) {
      heldKeys[e.key] = { elapsed: 0, fired: true, dasActive: false };
    }
  }

  function handleKeyUp(e) {
    delete heldKeys[e.key];
  }

  function fireKey(key) {
    if (gameOver || paused) return;
    switch (key) {
      case 'ArrowLeft':  moveLeft(); break;
      case 'ArrowRight': moveRight(); break;
      case 'ArrowDown':  softDrop(); break;
      case 'ArrowUp':    rotate(1); break;
      case ' ':          hardDrop(); break;
      case 'z': case 'Z': rotate(-1); break;
      case 'x': case 'X': rotate(1); break;
      case 'c': case 'C': case 'Shift': doHold(); break;
    }
  }

  function processHeldKeys(dt) {
    for (const key in heldKeys) {
      const state = heldKeys[key];
      state.elapsed += dt;
      const repeatRate = key === 'ArrowDown' ? SOFT_DROP_REPEAT : DAS_REPEAT;

      if (!state.dasActive) {
        // Waiting for DAS delay
        if (state.elapsed >= DAS_DELAY) {
          state.dasActive = true;
          state.elapsed = 0;
          fireKey(key);
        }
      } else {
        // Auto-repeating
        if (state.elapsed >= repeatRate) {
          state.elapsed -= repeatRate;
          fireKey(key);
        }
      }
    }
  }

  // ── Game Loop ────────────────────────────────────
  let lastTime = 0;

  function gameLoop(time = 0) {
    if (!running) return;
    const dt = time - lastTime;
    lastTime = time;

    if (!gameOver && !paused) {
      // Process held keys (DAS)
      processHeldKeys(dt);

      dropTimer += dt;
      if (dropTimer >= dropInterval) {
        dropTimer = 0;
        if (!softDrop()) {
          // On ground
        }
      }

      // Lock delay
      if (isOnGround()) {
        lockTimer += dt;
        if (lockTimer >= lockDelay || lockMoves >= 15) {
          lock();
        }
      } else {
        lockTimer = 0;
      }
    }

    draw();
    animFrame = requestAnimationFrame(gameLoop);
  }

  // ── Rendering ────────────────────────────────────
  function draw() {
    // Main board
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * BLOCK);
      ctx.lineTo(COLS * BLOCK, r * BLOCK);
      ctx.stroke();
    }
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * BLOCK, 0);
      ctx.lineTo(c * BLOCK, ROWS * BLOCK);
      ctx.stroke();
    }

    // Locked pieces
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (board[r][c]) {
          drawBlock(ctx, c, r, COLORS[board[r][c]], 1);
        }
      }
    }

    if (!gameOver) {
      // Ghost piece
      const gy = ghostY();
      const shape = getShape(currentType, currentRot);
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            drawBlock(ctx, currentX + c, gy + r, COLORS[currentType], GHOST_ALPHA);
          }
        }
      }

      // Current piece
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            drawBlock(ctx, currentX + c, currentY + r, COLORS[currentType], 1);
          }
        }
      }
    }

    // Preview (next 5)
    previewCtx.fillStyle = '#111';
    previewCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    for (let i = 0; i < Math.min(5, nextQueue.length); i++) {
      const type = nextQueue[i];
      const shape = PIECES[type][0];
      const ox = (4 - shape[0].length) / 2;
      const oy = i * 2.5 + 0.25;
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            drawBlockSmall(previewCtx, ox + c, oy + r, COLORS[type]);
          }
        }
      }
    }

    // Hold
    holdCtx.fillStyle = '#111';
    holdCtx.fillRect(0, 0, holdCanvas.width, holdCanvas.height);
    if (holdPiece) {
      const shape = PIECES[holdPiece][0];
      const ox = (4 - shape[0].length) / 2;
      const oy = (3 - shape.length) / 2;
      const alpha = holdUsed ? 0.4 : 1;
      for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
          if (shape[r][c]) {
            drawBlockSmall(holdCtx, ox + c, oy + r, COLORS[holdPiece], alpha);
          }
        }
      }
    }

    // Game over / pause overlay
    if (gameOver) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#f00';
      ctx.font = 'bold 20px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2 - 10);
      ctx.fillStyle = '#fff';
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.fillText('Press R to restart', canvas.width / 2, canvas.height / 2 + 20);
    } else if (paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = var_yellow();
      ctx.font = 'bold 18px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
    }

    updateHUD();
  }

  function drawBlock(context, x, y, color, alpha) {
    if (y < 0) return;
    const px = x * BLOCK;
    const py = y * BLOCK;
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.fillRect(px + 1, py + 1, BLOCK - 2, BLOCK - 2);
    // Highlight
    context.fillStyle = 'rgba(255,255,255,0.2)';
    context.fillRect(px + 1, py + 1, BLOCK - 2, 4);
    context.fillRect(px + 1, py + 1, 4, BLOCK - 2);
    // Shadow
    context.fillStyle = 'rgba(0,0,0,0.3)';
    context.fillRect(px + BLOCK - 4, py + 1, 3, BLOCK - 2);
    context.fillRect(px + 1, py + BLOCK - 4, BLOCK - 2, 3);
    context.globalAlpha = 1;
  }

  function drawBlockSmall(context, x, y, color, alpha = 1) {
    const sz = BLOCK * 0.75;
    const px = x * sz;
    const py = y * sz;
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.fillRect(px + 1, py + 1, sz - 2, sz - 2);
    context.globalAlpha = 1;
  }

  function var_yellow() { return '#FFD700'; }

  function updateHUD() {
    const scoreEl = document.getElementById('tetrisScore');
    const levelEl = document.getElementById('tetrisLevel');
    const linesEl = document.getElementById('tetrisLines');
    const actionEl = document.getElementById('tetrisAction');
    if (scoreEl) scoreEl.textContent = score.toLocaleString();
    if (levelEl) levelEl.textContent = level;
    if (linesEl) linesEl.textContent = lines;
    if (actionEl) {
      actionEl.textContent = lastAction;
      if (lastAction.includes('T-SPIN')) actionEl.style.color = '#a000f0';
      else if (lastAction.includes('TETRIS')) actionEl.style.color = '#00f0f0';
      else if (lastAction.includes('B2B')) actionEl.style.color = '#f0a000';
      else actionEl.style.color = '#FFD700';
    }
  }

  return { init, close };
})();

// ══════════════════════════════════════════════════════
//  RapTetris — Mini Tetris embedded in DK Rap overlay
//  Clears 40 lines across all viewers to skip the rap
// ══════════════════════════════════════════════════════
const RapTetris = (() => {
  const COLS = 10, ROWS = 20, BLOCK = 18;
  const COLORS = {
    I:'#00f0f0',O:'#f0f000',T:'#a000f0',S:'#00f000',Z:'#f00000',J:'#0000f0',L:'#f0a000'
  };
  // Reuse piece/kick data from main Tetris (inline for independence)
  const PIECES = {
    I:[[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],[[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],[[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],[[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]],
    O:[[[1,1],[1,1]],[[1,1],[1,1]],[[1,1],[1,1]],[[1,1],[1,1]]],
    T:[[[0,1,0],[1,1,1],[0,0,0]],[[0,1,0],[0,1,1],[0,1,0]],[[0,0,0],[1,1,1],[0,1,0]],[[0,1,0],[1,1,0],[0,1,0]]],
    S:[[[0,1,1],[1,1,0],[0,0,0]],[[0,1,0],[0,1,1],[0,0,1]],[[0,0,0],[0,1,1],[1,1,0]],[[1,0,0],[1,1,0],[0,1,0]]],
    Z:[[[1,1,0],[0,1,1],[0,0,0]],[[0,0,1],[0,1,1],[0,1,0]],[[0,0,0],[1,1,0],[0,1,1]],[[0,1,0],[1,1,0],[1,0,0]]],
    J:[[[1,0,0],[1,1,1],[0,0,0]],[[0,1,1],[0,1,0],[0,1,0]],[[0,0,0],[1,1,1],[0,0,1]],[[0,1,0],[0,1,0],[1,1,0]]],
    L:[[[0,0,1],[1,1,1],[0,0,0]],[[0,1,0],[0,1,0],[0,1,1]],[[0,0,0],[1,1,1],[1,0,0]],[[1,1,0],[0,1,0],[0,1,0]]]
  };
  const KCW=[[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],[[0,0],[1,0],[1,-1],[0,2],[1,2]],[[0,0],[1,0],[1,1],[0,-2],[1,-2]],[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]];
  const KCCW=[[[0,0],[1,0],[1,1],[0,-2],[1,-2]],[[0,0],[1,0],[1,-1],[0,2],[1,2]],[[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],[[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]];
  const KICW=[[[0,0],[-2,0],[1,0],[-2,-1],[1,2]],[[0,0],[-1,0],[2,0],[-1,2],[2,-1]],[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],[[0,0],[1,0],[-2,0],[1,-2],[-2,1]]];
  const KICCW=[[[0,0],[-1,0],[2,0],[-1,2],[2,-1]],[[0,0],[2,0],[-1,0],[2,1],[-1,-2]],[[0,0],[1,0],[-2,0],[1,-2],[-2,1]],[[0,0],[-2,0],[1,0],[-2,-1],[1,2]]];

  let canvas, ctx, board, cur, curType, curRot, curX, curY;
  let bag, nextQueue, holdPiece, holdUsed;
  let score, totalLines, gameOver, running;
  let dropInterval, dropTimer, lockTimer, lockMoves;
  let lastWasRot, lastKick;
  let animFrame, lastTime;
  let heldKeys = {};
  let onLinesCleared; // callback(linesCleared)
  const DAS_DELAY = 167, DAS_REPEAT = 33;

  function init(onLines) {
    onLinesCleared = onLines;
    canvas = document.getElementById('rapTetrisCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    canvas.width = COLS * BLOCK;
    canvas.height = ROWS * BLOCK;
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    reset();
    running = true;
    lastTime = 0;
    loop();
  }

  function stop() {
    running = false;
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    heldKeys = {};
    if (animFrame) cancelAnimationFrame(animFrame);
  }

  function reset() {
    board = Array.from({length:ROWS},()=>Array(COLS).fill(null));
    bag = []; nextQueue = [];
    for(let i=0;i<3;i++) nextQueue.push(pull());
    holdPiece=null; holdUsed=false;
    score=0; totalLines=0; gameOver=false;
    dropInterval=600; dropTimer=0; lockTimer=0; lockMoves=0;
    lastWasRot=false; lastKick=false;
    spawn();
  }

  function pull(){
    if(!bag.length){bag=Object.keys(PIECES).slice();for(let i=bag.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[bag[i],bag[j]]=[bag[j],bag[i]];}}
    return bag.pop();
  }

  function spawn(){
    curType=nextQueue.shift(); nextQueue.push(pull());
    curRot=0; const s=PIECES[curType][0];
    curX=Math.floor((COLS-s[0].length)/2); curY=0;
    holdUsed=false; lockTimer=0; lockMoves=0; lastWasRot=false; lastKick=false;
    if(collides(curType,curRot,curX,curY)) gameOver=true;
  }

  function shape(t,r){return PIECES[t][r%4];}
  function collides(t,r,x,y){
    const s=shape(t,r);
    for(let rr=0;rr<s.length;rr++) for(let cc=0;cc<s[rr].length;cc++){
      if(!s[rr][cc])continue;
      const bx=x+cc,by=y+rr;
      if(bx<0||bx>=COLS||by>=ROWS)return true;
      if(by>=0&&board[by][bx])return true;
    }
    return false;
  }
  function onGround(){return collides(curType,curRot,curX,curY+1);}
  function ghostY(){let g=curY;while(!collides(curType,curRot,curX,g+1))g++;return g;}

  function lock(){
    const s=shape(curType,curRot);
    for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++){
      if(!s[r][c])continue;
      const bx=curX+c,by=curY+r;
      if(by<0){gameOver=true;return;}
      board[by][bx]=curType;
    }
    // T-spin detection
    let tSpin=false;
    if(curType==='T'&&lastWasRot){
      const corners=[[0,0],[2,0],[0,2],[2,2]];
      let filled=0;
      for(const[cx,cy] of corners){
        const px=curX+cx,py=curY+cy;
        if(px<0||px>=COLS||py<0||py>=ROWS||(py>=0&&board[py][px]))filled++;
      }
      if(filled>=3) tSpin=true;
    }
    // Clear lines
    let cleared=0;
    for(let r=ROWS-1;r>=0;r--){
      if(board[r].every(c=>c!==null)){board.splice(r,1);board.unshift(Array(COLS).fill(null));cleared++;r++;}
    }
    if(cleared>0){
      totalLines+=cleared;
      const base=[0,100,300,500,800];
      let pts=base[cleared]*(Math.floor(totalLines/10)+1);
      if(tSpin) pts*=2;
      score+=pts;
      dropInterval=Math.max(80,600-Math.floor(totalLines/10)*50);
      if(onLinesCleared) onLinesCleared(cleared);
    }
    updateHUD();
    spawn();
  }

  function hardDrop(){while(!collides(curType,curRot,curX,curY+1))curY++;lastWasRot=false;lock();}
  function softDrop(){if(!collides(curType,curRot,curX,curY+1)){curY++;dropTimer=0;lastWasRot=false;return true;}return false;}
  function moveL(){if(!collides(curType,curRot,curX-1,curY)){curX--;lastWasRot=false;if(onGround()){lockTimer=0;lockMoves++;}return true;}return false;}
  function moveR(){if(!collides(curType,curRot,curX+1,curY)){curX++;lastWasRot=false;if(onGround()){lockTimer=0;lockMoves++;}return true;}return false;}

  function rotate(dir){
    const nr=(curRot+dir+4)%4;
    let kicks;
    if(curType==='I') kicks=dir===1?KICW[curRot]:KICCW[curRot];
    else if(curType==='O') return false;
    else kicks=dir===1?KCW[curRot]:KCCW[curRot];
    for(let i=0;i<kicks.length;i++){
      const[kx,ky]=kicks[i];
      if(!collides(curType,nr,curX+kx,curY-ky)){
        curX+=kx;curY-=ky;curRot=nr;lastWasRot=true;lastKick=i>0;
        if(onGround()){lockTimer=0;lockMoves++;}return true;
      }
    }
    return false;
  }

  function doHold(){
    if(holdUsed)return; holdUsed=true;
    if(holdPiece){const t=holdPiece;holdPiece=curType;curType=t;curRot=0;const s=PIECES[curType][0];curX=Math.floor((COLS-s[0].length)/2);curY=0;lockTimer=0;lockMoves=0;}
    else{holdPiece=curType;spawn();}
  }

  // Input
  function onKeyDown(e){
    if(!running)return;
    if(gameOver){if(e.key==='r'||e.key==='R')reset();return;}
    const rep=['ArrowLeft','ArrowRight','ArrowDown'];
    if(rep.includes(e.key)||e.key===' '||e.key==='ArrowUp'||'zZxXcC'.includes(e.key)||e.key==='Shift')e.preventDefault();
    if(heldKeys[e.key])return;
    fire(e.key);
    if(rep.includes(e.key)) heldKeys[e.key]={elapsed:0,dasActive:false};
  }
  function onKeyUp(e){delete heldKeys[e.key];}
  function fire(k){
    if(gameOver)return;
    switch(k){
      case'ArrowLeft':moveL();break;case'ArrowRight':moveR();break;
      case'ArrowDown':softDrop();break;case'ArrowUp':rotate(1);break;
      case' ':hardDrop();break;
      case'z':case'Z':rotate(-1);break;case'x':case'X':rotate(1);break;
      case'c':case'C':case'Shift':doHold();break;
    }
  }
  function processKeys(dt){
    for(const k in heldKeys){
      const s=heldKeys[k]; s.elapsed+=dt;
      const rate=k==='ArrowDown'?33:DAS_REPEAT;
      if(!s.dasActive){if(s.elapsed>=DAS_DELAY){s.dasActive=true;s.elapsed=0;fire(k);}}
      else{if(s.elapsed>=rate){s.elapsed-=rate;fire(k);}}
    }
  }

  // Loop
  function loop(time=0){
    if(!running)return;
    const dt=time-lastTime; lastTime=time;
    if(!gameOver){
      processKeys(dt);
      dropTimer+=dt;
      if(dropTimer>=dropInterval){dropTimer=0;softDrop();}
      if(onGround()){lockTimer+=dt;if(lockTimer>=500||lockMoves>=15)lock();}
      else lockTimer=0;
    }
    draw();
    animFrame=requestAnimationFrame(loop);
  }

  function draw(){
    ctx.fillStyle='#0a0a0a';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.strokeStyle='#1a1a2e';ctx.lineWidth=0.5;
    for(let r=0;r<=ROWS;r++){ctx.beginPath();ctx.moveTo(0,r*BLOCK);ctx.lineTo(COLS*BLOCK,r*BLOCK);ctx.stroke();}
    for(let c=0;c<=COLS;c++){ctx.beginPath();ctx.moveTo(c*BLOCK,0);ctx.lineTo(c*BLOCK,ROWS*BLOCK);ctx.stroke();}
    for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(board[r][c]) blk(c,r,COLORS[board[r][c]],1);
    if(!gameOver){
      const gy=ghostY(),s=shape(curType,curRot);
      for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) if(s[r][c]) blk(curX+c,gy+r,COLORS[curType],0.25);
      for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) if(s[r][c]) blk(curX+c,curY+r,COLORS[curType],1);
    } else {
      ctx.fillStyle='rgba(0,0,0,0.6)';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle='#f00';ctx.font='bold 14px "Press Start 2P",monospace';ctx.textAlign='center';
      ctx.fillText('GAME OVER',canvas.width/2,canvas.height/2-8);
      ctx.fillStyle='#fff';ctx.font='8px "Press Start 2P",monospace';
      ctx.fillText('Press R',canvas.width/2,canvas.height/2+12);
    }
  }
  function blk(x,y,color,a){
    if(y<0)return;
    const px=x*BLOCK,py=y*BLOCK;
    ctx.globalAlpha=a;ctx.fillStyle=color;ctx.fillRect(px+1,py+1,BLOCK-2,BLOCK-2);
    ctx.fillStyle='rgba(255,255,255,0.15)';ctx.fillRect(px+1,py+1,BLOCK-2,3);ctx.fillRect(px+1,py+1,3,BLOCK-2);
    ctx.fillStyle='rgba(0,0,0,0.25)';ctx.fillRect(px+BLOCK-3,py+1,2,BLOCK-2);ctx.fillRect(px+1,py+BLOCK-3,BLOCK-2,2);
    ctx.globalAlpha=1;
  }

  function updateHUD(){
    const el=document.getElementById('rapTetrisScore');
    if(el) el.textContent='Score: '+score.toLocaleString();
  }

  function getLines(){return totalLines;}

  return { init, stop, getLines };
})();
