// ── DK Rap Chaos — Grid Resize Handles ────────────────────────

const GridResizer = (() => {
  const STORAGE_KEY = 'dkrap-grid-resize';
  const MIN_RATIO = 0.2;
  const MAX_RATIO = 0.8;
  const ASPECT = 9 / 16; // height/width for 16:9 cells

  let colRatio = null;  // null = default, 0.5 = equal
  let rowRatio = null;
  let dragState = null;
  let vertHandle = null;
  let horizHandle = null;
  let positioningScheduled = false;

  function getClientPos(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function init() {
    const wrapper = document.querySelector('.streams-grid-wrapper');
    const grid = document.querySelector('.streams-grid');
    if (!wrapper || !grid) return;

    // Create vertical divider handle (between left and right columns)
    vertHandle = document.createElement('div');
    vertHandle.className = 'grid-resize-handle grid-resize-vert';
    wrapper.appendChild(vertHandle);

    // Create horizontal divider handle (between top and bottom rows)
    horizHandle = document.createElement('div');
    horizHandle.className = 'grid-resize-handle grid-resize-horiz';
    wrapper.appendChild(horizHandle);

    // Bind drag events
    vertHandle.addEventListener('mousedown', (e) => onDragStart(e, 'col'));
    vertHandle.addEventListener('touchstart', (e) => onDragStart(e, 'col'), { passive: false });
    horizHandle.addEventListener('mousedown', (e) => onDragStart(e, 'row'));
    horizHandle.addEventListener('touchstart', (e) => onDragStart(e, 'row'), { passive: false });

    // Double-click to reset axis
    vertHandle.addEventListener('dblclick', () => resetAxis('col'));
    horizHandle.addEventListener('dblclick', () => resetAxis('row'));

    loadState();

    // Recalculate on resize
    window.addEventListener('resize', onWindowResize);
    if (window.ResizeObserver) {
      new ResizeObserver(schedulePositionHandles).observe(grid);
    }

    // Apply persisted ratios and position handles after grid renders
    setTimeout(() => {
      applyAfterLayout();
      positionHandles();
    }, 120);
  }

  // ── Window Resize ──────────────────────────────────
  function onWindowResize() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;
    if (colRatio === null && rowRatio === null) { schedulePositionHandles(); return; }
    if (grid.classList.contains('focus-mode')) { schedulePositionHandles(); return; }
    lockGridHeight(grid);
    schedulePositionHandles();
  }

  // ── Handle Positioning ─────────────────────────────
  function schedulePositionHandles() {
    if (positioningScheduled) return;
    positioningScheduled = true;
    requestAnimationFrame(() => {
      positioningScheduled = false;
      positionHandles();
    });
  }

  function positionHandles() {
    const grid = document.querySelector('.streams-grid');
    const wrapper = document.querySelector('.streams-grid-wrapper');
    if (!grid || !wrapper) return;

    // Hide handles during control mode or focus mode
    if (grid.classList.contains('control-single') ||
        grid.classList.contains('control-all') ||
        grid.classList.contains('focus-mode')) {
      if (vertHandle) vertHandle.style.display = 'none';
      if (horizHandle) horizHandle.style.display = 'none';
      return;
    }

    const gridRect = grid.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();

    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim());
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());

    // Vertical handle — only when 2+ columns
    if (vertHandle) {
      if (cols.length >= 2) {
        const firstColWidth = parseFloat(cols[0]);
        const xOffset = gridRect.left - wrapperRect.left + firstColWidth;

        vertHandle.style.display = 'block';
        vertHandle.style.left = (xOffset - 4) + 'px';
        vertHandle.style.top = (gridRect.top - wrapperRect.top) + 'px';
        vertHandle.style.height = gridRect.height + 'px';
      } else {
        vertHandle.style.display = 'none';
      }
    }

    // Horizontal handle — only when 2+ rows
    if (horizHandle) {
      if (rows.length >= 2) {
        const firstRowHeight = parseFloat(rows[0]);
        const yOffset = gridRect.top - wrapperRect.top + firstRowHeight;

        horizHandle.style.display = 'block';
        horizHandle.style.left = (gridRect.left - wrapperRect.left) + 'px';
        horizHandle.style.top = (yOffset - 4) + 'px';
        horizHandle.style.width = gridRect.width + 'px';
      } else {
        horizHandle.style.display = 'none';
      }
    }
  }

  // ── Height Locking ─────────────────────────────────
  // Compute the "natural" grid height mathematically from grid width + 16:9.
  // Pure math — no dependency on actual rendered cell heights.
  function computeNaturalHeight(grid) {
    const gridWidth = grid.offsetWidth;
    if (gridWidth <= 0) return null;

    const gapStr = getComputedStyle(grid).gap || '8px';
    const gap = parseFloat(gapStr) || 8;

    const numCols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim()).length;
    const numRows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim()).length;

    if (numCols < 1 || numRows < 1) return null;

    // Cell width assuming equal columns (the "natural" reference state)
    const cellWidth = (gridWidth - (numCols - 1) * gap) / numCols;
    const cellHeight = cellWidth * ASPECT;
    return cellHeight * numRows + (numRows - 1) * gap;
  }

  function lockGridHeight(grid) {
    const h = computeNaturalHeight(grid);
    if (h && h > 0) {
      grid.style.height = Math.round(h) + 'px';
    }
  }

  // ── Drag Handlers ──────────────────────────────────
  function onDragStart(e, axis) {
    e.preventDefault();
    e.stopPropagation();

    const grid = document.querySelector('.streams-grid');
    if (!grid) return;
    if (grid.classList.contains('focus-mode')) return;

    const handle = axis === 'col' ? vertHandle : horizHandle;

    // Lock grid height BEFORE stripping aspect-ratio
    lockGridHeight(grid);

    // Strip aspect-ratio from cells so they fill the locked height via fr rows
    grid.classList.add('grid-resized');

    // Ensure explicit row template (needed once aspect-ratio is gone)
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());
    if (rows.length === 2 && rowRatio === null) {
      grid.style.gridTemplateRows = '1fr 1fr';
    }

    const gridRect = grid.getBoundingClientRect();
    dragState = { axis, gridRect, handle };
    handle.classList.add('active');

    if (typeof LayoutManager !== 'undefined') LayoutManager.showIframeOverlay();

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend', onDragEnd);
  }

  function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();

    const pos = getClientPos(e);
    const rect = dragState.gridRect;

    if (dragState.axis === 'col') {
      colRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, (pos.x - rect.left) / rect.width));
    } else {
      rowRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, (pos.y - rect.top) / rect.height));
    }

    applyGridRatios();
  }

  function onDragEnd() {
    if (!dragState) return;
    dragState.handle.classList.remove('active');
    dragState = null;

    if (typeof LayoutManager !== 'undefined') LayoutManager.hideIframeOverlay();

    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend', onDragEnd);

    saveState();
    positionHandles();

    if (typeof DrawCanvas !== 'undefined' && DrawCanvas.resizeCanvas) {
      setTimeout(() => DrawCanvas.resizeCanvas(), 50);
    }
  }

  // ── Apply Ratios ───────────────────────────────────
  function applyGridRatios() {
    const grid = document.querySelector('.streams-grid');
    if (!grid || grid.classList.contains('focus-mode')) return;

    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim());
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());

    if (cols.length === 2 && colRatio !== null) {
      grid.style.gridTemplateColumns = `${colRatio}fr ${1 - colRatio}fr`;
    }

    if (rows.length === 2) {
      if (rowRatio !== null) {
        grid.style.gridTemplateRows = `${rowRatio}fr ${1 - rowRatio}fr`;
      } else if (colRatio !== null) {
        // Column-only resize: keep rows equal
        grid.style.gridTemplateRows = '1fr 1fr';
      }
    }

    positionHandles();
  }

  // Called by App after focus/hidden layout changes
  function applyAfterLayout() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    // In focus mode — don't apply custom ratios, clean up
    if (grid.classList.contains('focus-mode')) {
      grid.classList.remove('grid-resized');
      grid.style.height = '';
      schedulePositionHandles();
      return;
    }

    const hasCustom = colRatio !== null || rowRatio !== null;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim());
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());

    if (hasCustom && cols.length === 2) {
      // Lock height, strip aspect-ratio, apply ratios
      lockGridHeight(grid);
      grid.classList.add('grid-resized');

      if (colRatio !== null) {
        grid.style.gridTemplateColumns = `${colRatio}fr ${1 - colRatio}fr`;
      }

      if (rows.length === 2) {
        if (rowRatio !== null) {
          grid.style.gridTemplateRows = `${rowRatio}fr ${1 - rowRatio}fr`;
        } else {
          grid.style.gridTemplateRows = '1fr 1fr';
        }
      }
    } else {
      // No custom ratios or wrong column count — restore natural state
      grid.classList.remove('grid-resized');
      grid.style.height = '';
    }

    schedulePositionHandles();
  }

  function resetAxis(axis) {
    const grid = document.querySelector('.streams-grid');

    if (axis === 'col') {
      colRatio = null;
      if (grid) grid.style.gridTemplateColumns = '';
    } else {
      rowRatio = null;
    }

    saveState();
    if (!grid) return;

    if (colRatio === null && rowRatio === null) {
      // Fully restore natural state
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.height = '';
      grid.classList.remove('grid-resized');
    } else {
      // One ratio still active — recalculate
      lockGridHeight(grid);
      grid.classList.add('grid-resized');

      if (colRatio !== null) {
        grid.style.gridTemplateColumns = `${colRatio}fr ${1 - colRatio}fr`;
      }

      const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());
      if (rows.length === 2) {
        if (rowRatio !== null) {
          grid.style.gridTemplateRows = `${rowRatio}fr ${1 - rowRatio}fr`;
        } else {
          grid.style.gridTemplateRows = '1fr 1fr';
        }
      }
    }

    positionHandles();
  }

  function resetAll() {
    colRatio = null;
    rowRatio = null;
    localStorage.removeItem(STORAGE_KEY);
    const grid = document.querySelector('.streams-grid');
    if (grid) {
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.height = '';
      grid.classList.remove('grid-resized');
    }
    positionHandles();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.colRatio !== undefined) colRatio = data.colRatio;
      if (data.rowRatio !== undefined) rowRatio = data.rowRatio;
    } catch { /* ignore */ }
  }

  function saveState() {
    const data = {};
    if (colRatio !== null) data.colRatio = colRatio;
    if (rowRatio !== null) data.rowRatio = rowRatio;
    if (Object.keys(data).length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  return { init, applyAfterLayout, resetAll, positionHandles };
})();
