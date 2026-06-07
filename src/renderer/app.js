const state = {
  dashboard: null,
  size: 112,
  sizeInitialized: false,
  panelOpen: false,
  dragging: null
};

const els = {
  root: document.documentElement,
  orb: document.getElementById('orb'),
  scrim: document.getElementById('scrim'),
  panel: document.getElementById('panel'),
  batteryFill: document.getElementById('batteryFill'),
  balanceText: document.getElementById('balanceText'),
  percentText: document.getElementById('percentText'),
  closePanel: document.getElementById('closePanel'),
  statusText: document.getElementById('statusText'),
  todayCostText: document.getElementById('todayCostText'),
  panelBalance: document.getElementById('panelBalance'),
  panelRemainingPercent: document.getElementById('panelRemainingPercent'),
  panelProgress: document.getElementById('panelProgress'),
  monthlySpendText: document.getElementById('monthlySpendText'),
  spendPercentText: document.getElementById('spendPercentText'),
  monthlyUsageText: document.getElementById('monthlyUsageText'),
  inputCacheHit: document.getElementById('inputCacheHit'),
  inputCacheMiss: document.getElementById('inputCacheMiss'),
  cacheHitRate: document.getElementById('cacheHitRate'),
  outputTokens: document.getElementById('outputTokens'),
  todayTokenTotal: document.getElementById('todayTokenTotal'),
  refreshButton: document.getElementById('refreshButton'),
  openButton: document.getElementById('openButton'),
  quitButton: document.getElementById('quitButton'),
  resizeGrip: document.getElementById('resizeGrip')
};

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(Number(value));
}

function formatCost(value) {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value));
}

function formatNumber(value) {
  if (!Number.isFinite(Number(value))) return '--';
  return new Intl.NumberFormat('zh-CN').format(Number(value));
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '--%';
  return `${Math.round(Number(value) * 100)}%`;
}

function formatPercentExact(value) {
  if (!Number.isFinite(Number(value))) return '--%';
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function accentForRatio(ratio) {
  if (ratio <= 0.2) return '#dc0008';
  if (ratio <= 0.5) return '#b05008';
  if (ratio <= 0.75) return '#f5c400';
  return '#11a83b';
}

function render() {
  const data = state.dashboard || {};
  const today = data.today || {};
  if (!state.sizeInitialized && Number.isFinite(Number(data.windowSize))) {
    state.size = Number(data.windowSize);
    state.sizeInitialized = true;
  }
  const ratio = Math.max(0, Math.min(Number(data.remainingPercent || 0), 1));
  const accent = accentForRatio(ratio);

  els.root.style.setProperty('--accent', accent);
  els.root.style.setProperty('--orb-size', `${state.size}px`);
  els.batteryFill.style.height = `${Math.max(7, Math.min(94, ratio * 94))}%`;

  els.balanceText.textContent = formatMoney(data.rechargeBalance).replace(/\s/g, '');
  els.percentText.textContent = formatPercent(ratio);

  els.statusText.textContent = data.status || '等待后台同步';
  els.todayCostText.textContent = formatCost(data.todayCost);
  els.panelBalance.textContent = formatCost(data.rechargeBalance);
  els.panelRemainingPercent.textContent = formatPercentExact(ratio);
  els.panelRemainingPercent.style.color = accent;
  els.panelProgress.style.width = `${ratio * 100}%`;
  els.monthlySpendText.textContent = formatCost(data.monthlySpend);
  els.spendPercentText.textContent = formatPercentExact(data.spendPercent);
  els.monthlyUsageText.textContent = formatNumber(data.monthlyUsage);

  els.inputCacheHit.textContent = formatNumber(today.inputCacheHit);
  els.inputCacheMiss.textContent = formatNumber(today.inputCacheMiss);
  els.cacheHitRate.textContent = formatPercentExact(data.cacheHitRate);
  els.outputTokens.textContent = formatNumber(today.output);
  const tokenTotal = Number(today.inputCacheHit || 0) + Number(today.inputCacheMiss || 0) + Number(today.output || 0);
  els.todayTokenTotal.textContent = `${formatNumber(tokenTotal)}（总量）`;
}

function applyLayout(layout) {
  if (!layout) return;
  els.root.style.setProperty('--orb-x', `${layout.orbX}px`);
  els.root.style.setProperty('--orb-y', `${layout.orbY}px`);
  els.root.style.setProperty('--panel-x', `${layout.panelX}px`);
  document.body.classList.toggle('panel-left', layout.side === 'left');
  document.body.classList.toggle('panel-right', layout.side !== 'left');
}

async function load() {
  state.dashboard = await window.dsbro.getDashboard();
  render();
}

async function setPanelOpen(open) {
  state.panelOpen = open;
  document.body.classList.toggle('is-panel-open', open);
  els.panel.hidden = !open;
  els.scrim.hidden = !open;
  const layout = await window.dsbro.setDetailOpen(open);
  applyLayout(layout);
  if (open) {
    state.dashboard = await window.dsbro.getDashboard();
    render();
  }
}

els.orb.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  setPanelOpen(true);
});

els.orb.addEventListener('dblclick', async () => {
  state.dashboard = await window.dsbro.refreshDashboard();
  render();
});

async function resizeOrbByWheel(event) {
  if (state.panelOpen && !event.target.closest('#orb')) return;
  event.preventDefault();
  const next = state.size + (event.deltaY < 0 ? 8 : -8);
  const result = await window.dsbro.setSize(next);
  state.size = Number(result?.size || result || state.size);
  applyLayout(result?.layout);
  render();
}

els.orb.addEventListener('wheel', resizeOrbByWheel, { passive: false });

function startDrag(event, element) {
  if (event.button !== 0 || event.target === els.resizeGrip) return;
  if (event.target.closest('button, input, select, textarea, a')) return;
  event.preventDefault();
  state.dragging = {
    element,
    lastX: event.screenX,
    lastY: event.screenY
  };
  element.classList.add('is-dragging');
  element.setPointerCapture(event.pointerId);
}

function moveDrag(event) {
  if (!state.dragging || resizing) return;
  const dx = event.screenX - state.dragging.lastX;
  const dy = event.screenY - state.dragging.lastY;
  if (!dx && !dy) return;
  state.dragging.lastX = event.screenX;
  state.dragging.lastY = event.screenY;
  window.dsbro.moveBy({ x: dx, y: dy });
}

function endDrag(event) {
  if (!state.dragging) return;
  const element = state.dragging.element;
  element.classList.remove('is-dragging');
  state.dragging = null;
  if (element.hasPointerCapture(event.pointerId)) {
    element.releasePointerCapture(event.pointerId);
  }
}

function cancelDrag() {
  state.dragging?.element?.classList.remove('is-dragging');
  state.dragging = null;
}

els.orb.addEventListener('pointerdown', (event) => startDrag(event, els.orb));
els.orb.addEventListener('pointermove', moveDrag);
els.orb.addEventListener('pointerup', endDrag);
els.orb.addEventListener('pointercancel', cancelDrag);
els.panel.addEventListener('pointerdown', (event) => startDrag(event, els.panel));
els.panel.addEventListener('pointermove', moveDrag);
els.panel.addEventListener('pointerup', endDrag);
els.panel.addEventListener('pointercancel', cancelDrag);

let resizing = null;
let resizeSyncTimer = null;

async function commitSize(size) {
  const result = await window.dsbro.setSize(size);
  state.size = Number(result?.size || result || state.size);
  applyLayout(result?.layout);
  render();
}

els.resizeGrip.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  event.stopPropagation();
  resizing = { x: event.screenX, y: event.screenY, size: state.size };
  els.orb.classList.add('is-resizing');
  els.resizeGrip.setPointerCapture(event.pointerId);
});

els.resizeGrip.addEventListener('pointermove', (event) => {
  if (!resizing) return;
  event.preventDefault();
  const delta = Math.max(event.screenX - resizing.x, event.screenY - resizing.y);
  state.size = Math.max(84, Math.min(resizing.size + delta, 220));
  els.root.style.setProperty('--orb-size', `${state.size}px`);
  if (!resizeSyncTimer) {
    resizeSyncTimer = setTimeout(async () => {
      resizeSyncTimer = null;
      await commitSize(state.size);
    }, 40);
  }
});

els.resizeGrip.addEventListener('pointerup', async () => {
  if (!resizing) return;
  resizing = null;
  els.orb.classList.remove('is-resizing');
  if (resizeSyncTimer) {
    clearTimeout(resizeSyncTimer);
    resizeSyncTimer = null;
  }
  await commitSize(state.size);
});

els.closePanel.addEventListener('click', () => setPanelOpen(false));
els.scrim.addEventListener('click', () => setPanelOpen(false));
els.refreshButton.addEventListener('click', async () => {
  els.statusText.textContent = '正在从后台刷新...';
  state.dashboard = await window.dsbro.refreshDashboard();
  render();
});
els.openButton.addEventListener('click', () => window.dsbro.openWeb());
els.quitButton.addEventListener('click', () => window.dsbro.quit());

window.dsbro.onDashboardData((data) => {
  state.dashboard = data;
  render();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.panelOpen) setPanelOpen(false);
});

load();
