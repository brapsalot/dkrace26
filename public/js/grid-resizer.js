// ── DK Rap Chaos — Grid Resize Handles ────────────────────────

const GridResizer = (() => {
  const STORAGE_KEY = 'dkrap-grid-resize';
  const MIN_RATIO = 0.2;
  const MAX_RATIO = 0.8;

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

    // Reposition handles on resize
    window.addEventListener('resize', schedulePositionHandles);
    if (window.ResizeObserver) {
      new ResizeObserver(schedulePositionHandles).observe(grid);
    }

    // Initial positioning after a brief delay to let grid render
    setTimeout(positionHandles, 100);
  }

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

    // Hide handles during control mode
    if (grid.classList.contains('control-single') || grid.classList.contains('control-all')) {
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

  function onDragStart(e, axis) {
    e.preventDefault();
    e.stopPropagation();

    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    const gridRect = grid.getBoundingClientRect();
    const handle = axis === 'col' ? vertHandle : horizHandle;

    // Lock grid height before row drag so fr units work
    if (axis === 'row' && !grid.style.height) {
      grid.style.height = gridRect.height + 'px';
    }

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
      let ratio = (pos.x - rect.left) / rect.width;
      ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
      colRatio = ratio;
    } else {
      let ratio = (pos.y - rect.top) / rect.height;
      ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
      rowRatio = ratio;
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

  function updateResizedClass(grid) {
    if (!grid) return;
    grid.classList.toggle('grid-resized', colRatio !== null || rowRatio !== null);
  }

  function applyGridRatios() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim());
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());

    if (cols.length === 2 && colRatio !== null) {
      grid.style.gridTemplateColumns = `${colRatio}fr ${1 - colRatio}fr`;
    }

    if (rows.length === 2 && rowRatio !== null) {
      grid.style.gridTemplateRows = `${rowRatio}fr ${1 - rowRatio}fr`;
    }

    updateResizedClass(grid);
    positionHandles();
  }

  // Called by App after focus/hidden layout changes
  function applyAfterLayout() {
    const grid = document.querySelector('.streams-grid');
    if (!grid) return;

    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(s => s.trim());
    const rows = getComputedStyle(grid).gridTemplateRows.split(' ').filter(s => s.trim());

    if (cols.length === 2 && colRatio !== null) {
      grid.style.gridTemplateColumns = `${colRatio}fr ${1 - colRatio}fr`;
    }

    if (rows.length === 2 && rowRatio !== null) {
      // Lock grid height so fr rows work
      if (!grid.style.height) {
        grid.style.height = grid.offsetHeight + 'px';
      }
      grid.style.gridTemplateRows = `${rowRatio}fr ${1 - rowRatio}fr`;
    } else {
      grid.style.height = '';
    }

    updateResizedClass(grid);
    schedulePositionHandles();
  }

  function resetAxis(axis) {
    const grid = document.querySelector('.streams-grid');
    if (axis === 'col') {
      colRatio = null;
      if (grid) grid.style.gridTemplateColumns = '';
    } else {
      rowRatio = null;
      if (grid) {
        grid.style.gridTemplateRows = '';
        if (colRatio === null) grid.style.height = '';
      }
    }
    updateResizedClass(grid);
    saveState();
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
