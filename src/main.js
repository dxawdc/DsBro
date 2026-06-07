const { app, BrowserWindow, ipcMain, shell, screen, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const PLATFORM_URL = 'https://platform.deepseek.com/usage';
const FLOAT_PADDING = 8;
const PANEL_WIDTH = 376;
const PANEL_HEIGHT = 514;
const PANEL_GAP = 12;
const PANEL_EDGE_PADDING = 12;
const REFRESH_INTERVAL_MS = 6 * 60 * 1000;

let floatWindow;
let portalWindow;
let syncTimer;
let refreshTimer;
let panelState = { open: false, side: 'right', orbX: 0, orbY: 0 };
let config = { windowSize: 112 };
let dashboardData = createEmptyDashboardData();
const portalApiHeaders = new Map();

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const dashboardPath = () => path.join(app.getPath('userData'), 'dashboard.json');
const scrapeDebugPath = () => path.join(app.getPath('userData'), 'last-scrape.json');
const networkDebugPath = () => path.join(app.getPath('userData'), 'last-network.json');
const networkResponsesPath = () => path.join(app.getPath('userData'), 'network-responses.json');

function apiPathKey(urlOrEndpoint) {
  try {
    return new URL(urlOrEndpoint, 'https://platform.deepseek.com').pathname;
  } catch {
    return String(urlOrEndpoint || '').split('?')[0];
  }
}

function createEmptyDashboardData() {
  return {
    rechargeBalance: null,
    monthlySpend: null,
    todayCost: null,
    monthlyUsage: null,
    today: {
      inputCacheHit: null,
      inputCacheMiss: null,
      output: null
    },
    sourceUrl: '',
    syncedAt: null,
    status: '等待登录 DeepSeek 后台'
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath(), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(filePath(), JSON.stringify(value, null, 2), 'utf8');
}

async function loadState() {
  config = { ...config, ...(await readJson(configPath, config)) };
  dashboardData = { ...dashboardData, ...(await readJson(dashboardPath, dashboardData)) };
}

async function saveDashboard(data) {
  const incomingToday = data.today || {};
  const incomingTokenTotal =
    numberOrZero(incomingToday.inputCacheHit) + numberOrZero(incomingToday.inputCacheMiss) + numberOrZero(incomingToday.output);
  const existingTokenTotal =
    numberOrZero(dashboardData.today?.inputCacheHit) + numberOrZero(dashboardData.today?.inputCacheMiss) + numberOrZero(dashboardData.today?.output);
  const today =
    incomingTokenTotal === 0 && existingTokenTotal > 0
      ? dashboardData.today
      : { ...dashboardData.today, ...incomingToday };

  dashboardData = {
    ...dashboardData,
    ...data,
    today
  };
  await writeJson(dashboardPath, dashboardData);
  floatWindow?.webContents.send('dashboard-data', getDashboardViewData());
}

function getDashboardViewData() {
  const rechargeBalance = numberOrNull(dashboardData.rechargeBalance);
  const monthlySpend = numberOrNull(dashboardData.monthlySpend);
  const denominator = (rechargeBalance || 0) + (monthlySpend || 0);
  const remainingPercent = denominator > 0 && rechargeBalance !== null ? rechargeBalance / denominator : 0;
  const spendPercent = denominator > 0 && monthlySpend !== null ? monthlySpend / denominator : 0;
  const hit = numberOrZero(dashboardData.today?.inputCacheHit);
  const miss = numberOrZero(dashboardData.today?.inputCacheMiss);

  return {
    ...dashboardData,
    windowSize: Number(config.windowSize) || 112,
    remainingPercent,
    spendPercent,
    cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : 0
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/,/g, '')
    .replace(/[￥¥$]/g, '')
    .replace(/tokens?/gi, '')
    .replace(/元/g, '')
    .trim();
  const multiplier = /万/.test(String(value)) ? 10000 : /亿/.test(String(value)) ? 100000000 : 1;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) * multiplier : null;
}

function isLikelyYear(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 2000 && number <= 2100;
}

function parseTokenNumber(value) {
  const parsed = parseNumber(value);
  if (parsed === null || isLikelyYear(parsed)) return null;
  return parsed;
}

function parseNear(text, labels, options = {}) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escaped}.{0,${options.distance || 80}}?([￥¥$]?\\s*-?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万|亿|tokens?|元)?)`, 'i');
    const match = normalized.match(pattern);
    if (match) {
      const parsed = options.kind === 'token' ? parseTokenNumber(match[1]) : parseNumber(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function parseMonthlyTokensFromText(text) {
  const matches = Array.from(String(text || '').matchAll(/Tokens\s+([0-9]+(?:,[0-9]{3})*(?:\.\d+)?)/gi));
  const values = matches.map((match) => parseTokenNumber(match[1])).filter((value) => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function extractBySemanticRows(rows, labels, options = {}) {
  for (const row of rows) {
    const name = String(row.text || '').replace(/\s+/g, ' ');
    if (!labels.some((label) => name.toLowerCase().includes(label.toLowerCase()))) continue;
    const numbers = row.numbers || [];
    for (let index = numbers.length - 1; index >= 0; index -= 1) {
      const parsed = options.kind === 'token' ? parseTokenNumber(numbers[index]) : parseNumber(numbers[index]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function dateKeys() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return [`${y}-${m}-${d}`, `${y}/${m}/${d}`, `${m}-${d}`, `${m}/${d}`, `${Number(m)}月${Number(d)}日`];
}

function utcDateParts() {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    date: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`
  };
}

function amountByUsageType(usage, type) {
  const item = (usage || []).find((entry) => String(entry.type || '').toUpperCase() === type);
  return parseTokenNumber(item?.amount) || 0;
}

function sumUsageAmount(usage) {
  return (usage || []).reduce((sum, entry) => sum + numberOrZero(parseNumber(entry?.amount)), 0);
}

function parseSummaryApi(json) {
  const data = json?.data?.biz_data || json?.biz_data || json?.data || {};
  const normalWallets = Array.isArray(data.normal_wallets) ? data.normal_wallets : [];
  const cnyWallet = normalWallets.find((wallet) => wallet.currency === 'CNY') || normalWallets[0] || {};
  const monthlyCosts = Array.isArray(data.monthly_costs) ? data.monthly_costs : [];
  const cnyCost = monthlyCosts.find((cost) => cost.currency === 'CNY') || monthlyCosts[0] || {};

  return {
    rechargeBalance: parseNumber(cnyWallet.balance),
    monthlySpend: parseNumber(cnyCost.amount),
    monthlyUsage: parseTokenNumber(data.monthly_token_usage ?? data.monthly_usage)
  };
}

function parseAmountApi(json) {
  const targetDate = utcDateParts().date;
  const bizData = json?.data?.biz_data || json?.biz_data || json?.data;
  const blocks = Array.isArray(bizData) ? bizData : [bizData].filter(Boolean);
  const today = { inputCacheHit: 0, inputCacheMiss: 0, output: 0 };
  let foundToday = false;
  let monthlyUsage = 0;

  for (const block of blocks) {
    for (const totalEntry of block?.total || []) {
      monthlyUsage += amountByUsageType(totalEntry.usage, 'PROMPT_CACHE_HIT_TOKEN');
      monthlyUsage += amountByUsageType(totalEntry.usage, 'PROMPT_CACHE_MISS_TOKEN');
      monthlyUsage += amountByUsageType(totalEntry.usage, 'RESPONSE_TOKEN');
    }

    for (const day of block?.days || []) {
      if (day.date !== targetDate) continue;
      foundToday = true;
      for (const model of day.data || []) {
        today.inputCacheHit += amountByUsageType(model.usage, 'PROMPT_CACHE_HIT_TOKEN');
        today.inputCacheMiss += amountByUsageType(model.usage, 'PROMPT_CACHE_MISS_TOKEN');
        today.output += amountByUsageType(model.usage, 'RESPONSE_TOKEN');
      }
    }
  }

  return {
    monthlyUsage: monthlyUsage || null,
    today: foundToday ? today : {}
  };
}

function parseCostApi(json) {
  const targetDate = utcDateParts().date;
  const bizData = json?.data?.biz_data || json?.biz_data || json?.data;
  const blocks = Array.isArray(bizData) ? bizData : [bizData].filter(Boolean);
  let todayCost = 0;
  let foundToday = false;

  for (const block of blocks) {
    for (const day of block?.days || []) {
      if (day.date !== targetDate) continue;
      foundToday = true;
      for (const model of day.data || []) {
        todayCost += sumUsageAmount(model.usage);
      }
    }
  }

  return {
    todayCost: foundToday ? todayCost : null
  };
}

function mergeDefined(...parts) {
  const result = { today: {} };
  for (const part of parts) {
    if (!part) continue;
    if (part.rechargeBalance !== undefined && part.rechargeBalance !== null) result.rechargeBalance = part.rechargeBalance;
    if (part.monthlySpend !== undefined && part.monthlySpend !== null) result.monthlySpend = part.monthlySpend;
    if (part.todayCost !== undefined && part.todayCost !== null) result.todayCost = part.todayCost;
    if (part.monthlyUsage !== undefined && part.monthlyUsage !== null) result.monthlyUsage = part.monthlyUsage;
    if (part.today) {
      for (const key of ['inputCacheHit', 'inputCacheMiss', 'output']) {
        if (part.today[key] !== undefined && part.today[key] !== null) result.today[key] = part.today[key];
      }
    }
  }
  return result;
}

async function fetchPortalJson(endpoint) {
  const cookies = await session.defaultSession.cookies.get({ url: 'https://platform.deepseek.com' });
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const capturedHeaders = portalApiHeaders.get(apiPathKey(endpoint)) || {};
  const response = await fetch(`https://platform.deepseek.com${endpoint}`, {
    headers: {
      ...capturedHeaders,
      Accept: 'application/json, text/plain, */*',
      Cookie: cookieHeader,
      Referer: PLATFORM_URL,
      'User-Agent': 'Mozilla/5.0 DsBro Electron'
    }
  });

  if (!response.ok) {
    throw new Error(`${endpoint} ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchDashboardApis() {
  const { year, month } = utcDateParts();
  const [summaryResult, amountResult, costResult] = await Promise.allSettled([
    fetchPortalJson('/api/v0/users/get_user_summary'),
    fetchPortalJson(`/api/v0/usage/amount?month=${month}&year=${year}`),
    fetchPortalJson(`/api/v0/usage/cost?month=${month}&year=${year}`)
  ]);

  const summaryJson = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
  const amountJson = amountResult.status === 'fulfilled' ? amountResult.value : null;
  const costJson = costResult.status === 'fulfilled' ? costResult.value : null;
  const extracted = mergeDefined(parseSummaryApi(summaryJson), parseAmountApi(amountJson), parseCostApi(costJson));
  return {
    extracted,
    summaryOk: summaryResult.status === 'fulfilled',
    amountOk: amountResult.status === 'fulfilled',
    costOk: costResult.status === 'fulfilled',
    summaryError: summaryResult.status === 'rejected' ? String(summaryResult.reason?.message || summaryResult.reason) : null,
    amountError: amountResult.status === 'rejected' ? String(amountResult.reason?.message || amountResult.reason) : null,
    costError: costResult.status === 'rejected' ? String(costResult.reason?.message || costResult.reason) : null,
    summarySample: summaryJson,
    amountSample: amountJson,
    costSample: costJson
  };
}

function headerMatches(header, groups) {
  const text = String(header || '').toLowerCase().replace(/\s+/g, '');
  return groups.every((group) => group.some((word) => text.includes(word.toLowerCase().replace(/\s+/g, ''))));
}

function cellByHeader(headers, cells, groups) {
  const index = headers.findIndex((header) => headerMatches(header, groups));
  return index >= 0 ? parseTokenNumber(cells[index]) : null;
}

function extractTodayUsageFromTables(tables) {
  for (const table of tables || []) {
    const headers = table.headers || [];
    for (const cells of table.rows || []) {
      const rowText = cells.join(' ');
      if (!dateKeys().some((key) => rowText.includes(key))) continue;

      const inputCacheHit = cellByHeader(headers, cells, [
        ['输入', 'input', 'prompt'],
        ['命中', 'hit', 'cached']
      ]);
      const inputCacheMiss = cellByHeader(headers, cells, [
        ['输入', 'input', 'prompt'],
        ['未命中', 'miss']
      ]);
      const output = cellByHeader(headers, cells, [['输出', 'output', 'completion']]);

      if ([inputCacheHit, inputCacheMiss, output].some((value) => value !== null)) {
        return { inputCacheHit, inputCacheMiss, output };
      }
    }
  }
  return {};
}

function walkJson(value, visitor, pathParts = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visitor, [...pathParts, String(index)]));
    return;
  }
  visitor(value, pathParts);
  Object.entries(value).forEach(([key, child]) => walkJson(child, visitor, [...pathParts, key]));
}

function valueByKeyPatterns(object, patternGroups) {
  for (const [key, value] of Object.entries(object || {})) {
    const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
    if (!patternGroups.every((group) => group.some((pattern) => normalized.includes(pattern)))) continue;
    const parsed = parseTokenNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function objectHasToday(object) {
  const keys = dateKeys();
  return Object.entries(object || {}).some(([key, value]) => {
    const name = key.toLowerCase();
    if (!/(date|day|time|created|日期)/i.test(name)) return false;
    return keys.some((dateKey) => String(value).includes(dateKey));
  });
}

function extractDashboardDataFromJson(json) {
  const result = { today: {} };

  walkJson(json, (object) => {
    for (const [key, value] of Object.entries(object)) {
      const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
      const parsedMoney = parseNumber(value);
      if (parsedMoney !== null && /balance|余额/.test(normalized) && result.rechargeBalance === undefined) {
        result.rechargeBalance = parsedMoney;
      }
      if (parsedMoney !== null && /(monthly|month|本月).*(cost|spend|消费)|本月消费/.test(normalized) && result.monthlySpend === undefined) {
        result.monthlySpend = parsedMoney;
      }
      const parsedToken = parseTokenNumber(value);
      if (parsedToken !== null && /(monthlyusage|monthlytokenusage|月度用量|每月用量)/.test(normalized) && result.monthlyUsage === undefined) {
        result.monthlyUsage = parsedToken;
      }
    }

    if (!objectHasToday(object)) return;
    result.today.inputCacheHit ??= valueByKeyPatterns(object, [
      ['input', 'prompt', '输入'],
      ['cachehit', 'cached', 'hit', '命中']
    ]);
    result.today.inputCacheMiss ??= valueByKeyPatterns(object, [
      ['input', 'prompt', '输入'],
      ['cachemiss', 'miss', '未命中']
    ]);
    result.today.output ??= valueByKeyPatterns(object, [['output', 'completion', '输出']]);
  });

  return result;
}

function mergeExtractedData(base, extra) {
  return {
    rechargeBalance: extra.rechargeBalance ?? base.rechargeBalance,
    monthlySpend: extra.monthlySpend ?? base.monthlySpend,
    todayCost: extra.todayCost ?? base.todayCost,
    monthlyUsage: extra.monthlyUsage ?? base.monthlyUsage,
    today: {
      inputCacheHit: extra.today?.inputCacheHit ?? base.today?.inputCacheHit,
      inputCacheMiss: extra.today?.inputCacheMiss ?? base.today?.inputCacheMiss,
      output: extra.today?.output ?? base.today?.output
    }
  };
}

function parseBackendResponseByUrl(url, json) {
  if (/\/api\/v0\/users\/get_user_summary/i.test(url)) {
    return parseSummaryApi(json);
  }
  if (/\/api\/v0\/usage\/amount/i.test(url)) {
    return parseAmountApi(json);
  }
  if (/\/api\/v0\/usage\/cost/i.test(url)) {
    return parseCostApi(json);
  }
  return extractDashboardDataFromJson(json);
}

function installPortalHeaderCapture() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://platform.deepseek.com/api/v0/*'] },
    (details, callback) => {
      const headers = details.requestHeaders || {};
      const pathKey = apiPathKey(details.url);
      if (
        /\/api\/v0\/users\/get_user_summary|\/api\/v0\/usage\/amount|\/api\/v0\/usage\/cost/i.test(pathKey)
      ) {
        portalApiHeaders.set(pathKey, { ...headers });
      }
      callback({ requestHeaders: headers });
    }
  );
}

function extractDashboardData(payload) {
  const text = String(payload?.text || '');
  const jsonText = JSON.stringify(payload?.jsonBlobs || {});
  const combined = `${text} ${jsonText}`;
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const tableUsage = extractTodayUsageFromTables(payload?.tables || []);

  const rechargeBalance =
    extractBySemanticRows(rows, ['充值余额', '账户余额', '当前余额', 'balance']) ??
    parseNear(combined, ['充值余额', '账户余额', '当前余额', '可用余额', 'Balance']);

  const monthlySpend =
    extractBySemanticRows(rows, ['本月消费', '月消费', '本月用量', '本月费用', 'spent', 'cost']) ??
    parseNear(combined, ['本月消费', '月消费', '本月用量', '本月费用', '消费金额', 'Spent', 'Cost']);

  const monthlyUsage =
    extractBySemanticRows(rows, ['每月用量', '月度用量', 'monthly usage'], { kind: 'token' }) ??
    parseNear(combined, ['每月用量', '月度用量', 'Monthly Usage'], { kind: 'token' }) ??
    parseMonthlyTokensFromText(text);

  const inputCacheHit =
    tableUsage.inputCacheHit ??
    extractBySemanticRows(rows, ['输入（命中缓存）', '输入(命中缓存)', '缓存命中输入', '命中缓存输入', 'prompt cache hit', 'cache hit input'], { kind: 'token' }) ??
    parseNear(combined, ['输入（命中缓存）', '输入(命中缓存)', '缓存命中输入', '命中缓存输入', 'Prompt Cache Hit', 'Cache Hit Input'], { kind: 'token' });

  const inputCacheMiss =
    tableUsage.inputCacheMiss ??
    extractBySemanticRows(rows, ['输入（未命中缓存）', '输入(未命中缓存)', '缓存未命中输入', '未命中缓存输入', 'prompt cache miss', 'cache miss input'], { kind: 'token' }) ??
    parseNear(combined, ['输入（未命中缓存）', '输入(未命中缓存)', '缓存未命中输入', '未命中缓存输入', 'Prompt Cache Miss', 'Cache Miss Input'], { kind: 'token' });

  const output =
    tableUsage.output ??
    extractBySemanticRows(rows, ['输出', 'completion tokens', 'output tokens'], { kind: 'token' }) ??
    parseNear(combined, ['输出 Token', '输出 tokens', 'Completion Tokens', 'Output Tokens', '输出'], { kind: 'token' });

  return {
    rechargeBalance,
    monthlySpend,
    monthlyUsage,
    today: {
      inputCacheHit,
      inputCacheMiss,
      output
    }
  };
}

function hasCoreData(data) {
  return Number.isFinite(data.rechargeBalance) && Number.isFinite(data.monthlySpend);
}

function createFloatWindow() {
  const size = Math.round((Number(config.windowSize) || 112) + FLOAT_PADDING * 2);
  floatWindow = new BrowserWindow({
    width: size,
    height: size,
    minWidth: 92,
    minHeight: 92,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatWindow.setAlwaysOnTop(true, 'screen-saver');
  floatWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  floatWindow.webContents.once('did-finish-load', () => {
    floatWindow.webContents.send('dashboard-data', getDashboardViewData());
    if (hasCoreData(getDashboardViewData())) floatWindow.show();
  });
}

function startRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    scrapePortal('auto-refresh');
  }, REFRESH_INTERVAL_MS);
}

function createPortalWindow() {
  portalWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    title: 'DeepSeek 开发者后台',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  portalWindow.loadURL(PLATFORM_URL);
  attachNetworkCapture(portalWindow);
  portalWindow.webContents.on('did-finish-load', () => scheduleScrape(1000));
  portalWindow.webContents.on('did-navigate', () => scheduleScrape(1200));
  portalWindow.webContents.on('did-navigate-in-page', () => scheduleScrape(1200));
  portalWindow.on('closed', () => {
    portalWindow = null;
  });
}

function attachNetworkCapture(window) {
  const debuggee = window.webContents.debugger;
  try {
    debuggee.attach('1.3');
    debuggee.sendCommand('Network.enable');
  } catch {
    return;
  }

  debuggee.on('message', async (_event, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const response = params.response || {};
    const url = response.url || '';
    const type = params.type || '';
    if (!/platform\.deepseek\.com|api\.deepseek\.com/i.test(url)) return;
    if (!/XHR|Fetch|Document/i.test(type)) return;

    try {
      const bodyResult = await debuggee.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const body = bodyResult.base64Encoded ? Buffer.from(bodyResult.body, 'base64').toString('utf8') : bodyResult.body;
      if (!/(token|usage|用量|余额|balance|cache|消费)/i.test(body)) return;
      const json = JSON.parse(body);
      const extracted = parseBackendResponseByUrl(url, json);
      const previousResponses = await readJson(networkResponsesPath, []);
      previousResponses.push({
        url,
        type,
        extracted,
        bodySample: body.slice(0, 12000),
        syncedAt: new Date().toISOString()
      });
      await writeJson(networkResponsesPath, previousResponses.slice(-40));
      await writeJson(networkDebugPath, {
        url,
        type,
        extracted,
        bodySample: body.slice(0, 20000),
        syncedAt: new Date().toISOString()
      });

      const merged = mergeExtractedData(getDashboardViewData(), extracted);
      if (
        merged.rechargeBalance !== dashboardData.rechargeBalance ||
        merged.monthlySpend !== dashboardData.monthlySpend ||
        merged.todayCost !== dashboardData.todayCost ||
        merged.monthlyUsage !== dashboardData.monthlyUsage ||
        merged.today.inputCacheHit !== dashboardData.today?.inputCacheHit ||
        merged.today.inputCacheMiss !== dashboardData.today?.inputCacheMiss ||
        merged.today.output !== dashboardData.today?.output
      ) {
        await saveDashboard({
          ...merged,
          sourceUrl: url,
          syncedAt: new Date().toISOString(),
          status: hasCoreData(merged) ? '已从 DeepSeek 后台同步' : dashboardData.status
        });
      }
    } catch {
      // Some responses are not JSON or are no longer available in the debugger buffer.
    }
  });
}

function scheduleScrape(delay = 0) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => scrapePortal('auto'), delay);
}

async function scrapePortal(reason = 'manual') {
  if (!portalWindow || portalWindow.isDestroyed()) {
    // 窗口已关闭：静默尝试 API 直连（session 中还有 Cookie），不弹窗
    try {
      const apiResult = await fetchDashboardApis();
      const extracted = apiResult.extracted;
      const next = {
        ...extracted,
        sourceUrl: '',
        syncedAt: new Date().toISOString(),
        status: hasCoreData(extracted)
          ? '已从 DeepSeek 后台同步'
          : (reason === 'manual' ? '登录已过期，请点击"打开网页"重新登录' : '等待后台登录')
      };
      await saveDashboard(next);
      if (hasCoreData(next) && floatWindow && !floatWindow.isVisible()) {
        floatWindow.show();
      }
      return getDashboardViewData();
    } catch {
      await saveDashboard({
        status: reason === 'manual' ? '同步失败，请点击"打开网页"重新登录' : dashboardData.status
      });
      return getDashboardViewData();
    }
  }

  try {
    const apiResult = await fetchDashboardApis();
    const apiExtracted = apiResult.extracted;

    const payload = await portalWindow.webContents.executeJavaScript(
      `(() => {
        const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const rows = Array.from(document.querySelectorAll('tr, [role="row"], .ant-table-row, .semi-table-row, .arco-table-tr, .table-row, .card, .statistic, .item'))
          .map((node) => {
            const text = clean(node.innerText || node.textContent);
            const numbers = text.match(/[￥¥$]?\\s*-?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万|亿|tokens?|元)?/gi) || [];
            return { text, numbers };
          })
          .filter((row) => row.text && row.numbers.length);
        const tables = Array.from(document.querySelectorAll('table, [role="table"], .ant-table, .semi-table, .arco-table'))
          .map((table) => {
            const headerNodes = Array.from(table.querySelectorAll('thead th, [role="columnheader"], .ant-table-thead th, .semi-table-thead th, .arco-table-th'));
            const headers = headerNodes.map((node) => clean(node.innerText || node.textContent)).filter(Boolean);
            const rowNodes = Array.from(table.querySelectorAll('tbody tr, [role="row"], .ant-table-row, .semi-table-row, .arco-table-tr'));
            const tableRows = rowNodes
              .map((row) => Array.from(row.querySelectorAll('td, [role="cell"], .ant-table-cell, .semi-table-row-cell, .arco-table-td'))
                .map((cell) => clean(cell.innerText || cell.textContent))
                .filter(Boolean))
              .filter((cells) => cells.length);
            return { headers, rows: tableRows };
          })
          .filter((table) => table.headers.length || table.rows.length);
        const jsonBlobs = [];
        const next = document.getElementById('__NEXT_DATA__');
        if (next) jsonBlobs.push(next.textContent);
        for (const script of Array.from(document.scripts)) {
          const content = script.textContent || '';
          if (/充值余额|本月消费|每月用量|cache|token|balance|usage/i.test(content)) {
            jsonBlobs.push(content.slice(0, 120000));
          }
        }
        return {
          url: location.href,
          title: document.title,
          text: clean(document.body ? document.body.innerText : ''),
          rows,
          tables,
          jsonBlobs
        };
      })()`,
      true
    );

    const domExtracted = extractDashboardData(payload);
    const extracted = mergeDefined(domExtracted, apiExtracted);
    await writeJson(scrapeDebugPath, {
      url: payload.url,
      title: payload.title,
      apiExtracted,
      apiStatus: {
        summaryOk: apiResult.summaryOk,
        amountOk: apiResult.amountOk,
        costOk: apiResult.costOk,
        summaryError: apiResult.summaryError,
        amountError: apiResult.amountError,
        costError: apiResult.costError
      },
      apiSamples: {
        summary: apiResult.summarySample,
        amount: apiResult.amountSample,
        cost: apiResult.costSample
      },
      textSample: String(payload.text || '').slice(0, 5000),
      rows: (payload.rows || []).slice(0, 80),
      tables: payload.tables || [],
      extracted,
      syncedAt: new Date().toISOString()
    });
    const next = {
      ...extracted,
      sourceUrl: payload.url,
      syncedAt: new Date().toISOString(),
      status: hasCoreData(extracted) ? '已从 DeepSeek 后台同步' : '已打开后台，请进入用量信息页面'
    };
    await saveDashboard(next);

    if (hasCoreData(next) && floatWindow && !floatWindow.isVisible()) {
      floatWindow.show();
      portalWindow.hide();
    }
    return getDashboardViewData();
  } catch (error) {
    await saveDashboard({
      status: reason === 'manual' ? `同步失败：${error.message || error}` : '等待后台页面加载'
    });
    return getDashboardViewData();
  }
}

function openPortalWindow() {
  if (!portalWindow || portalWindow.isDestroyed()) createPortalWindow();
  portalWindow.show();
  portalWindow.focus();
  scheduleScrape(800);
}

function positionPanel(open) {
  if (!floatWindow) return;
  const [x, y] = floatWindow.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  const workArea = display.workArea;
  const orbOuter = Math.round((Number(config.windowSize) || 112) + FLOAT_PADDING * 2);
  const openWidth = PANEL_WIDTH + PANEL_GAP + orbOuter + PANEL_EDGE_PADDING;
  const openHeight = Math.max(PANEL_HEIGHT, orbOuter);

  if (open) {
    const orbX = panelState.open ? panelState.orbX : x;
    const orbY = panelState.open ? panelState.orbY : y;
    const openLeft = orbX + orbOuter + PANEL_GAP + PANEL_WIDTH + PANEL_EDGE_PADDING <= workArea.x + workArea.width;
    const side = openLeft ? 'right' : 'left';
    const idealX = side === 'right' ? orbX : orbX - PANEL_WIDTH - PANEL_GAP;
    const nextX = Math.max(workArea.x, Math.min(idealX, workArea.x + workArea.width - openWidth));
    const nextY = Math.max(workArea.y, Math.min(orbY, workArea.y + workArea.height - openHeight));
    const orbCssX = Math.max(FLOAT_PADDING, Math.min(orbX - nextX + FLOAT_PADDING, openWidth - orbOuter + FLOAT_PADDING));
    const orbCssY = Math.max(FLOAT_PADDING, Math.min(orbY - nextY + FLOAT_PADDING, openHeight - orbOuter + FLOAT_PADDING));
    const panelCssX = side === 'right' ? orbCssX + orbOuter + PANEL_GAP : Math.max(FLOAT_PADDING, orbCssX - PANEL_WIDTH - PANEL_GAP);
    panelState = { open: true, side, orbX, orbY };
    floatWindow.setBounds({ x: nextX, y: nextY, width: openWidth, height: openHeight });
    return {
      side,
      orbX: orbCssX,
      panelX: panelCssX,
      orbY: orbCssY
    };
  }

  const nextX = panelState.open ? panelState.orbX : x;
  const nextY = panelState.open ? panelState.orbY : y;
  panelState = { ...panelState, open: false };
  floatWindow.setBounds({ x: nextX, y: nextY, width: orbOuter, height: orbOuter });
  return {
    side: panelState.side,
    orbX: FLOAT_PADDING,
    panelX: FLOAT_PADDING,
    orbY: FLOAT_PADDING
  };
}

app.whenReady().then(async () => {
  await loadState();
  installPortalHeaderCapture();
  createFloatWindow();
  createPortalWindow();
  startRefreshTimer();

  app.on('activate', () => {
    if (!portalWindow && !floatWindow) {
      createFloatWindow();
      createPortalWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('dashboard:get', () => getDashboardViewData());
ipcMain.handle('dashboard:refresh', () => scrapePortal('manual'));
ipcMain.handle('dashboard:open-web', () => openPortalWindow());
ipcMain.handle('window:set-size', async (_event, size) => {
  const next = Math.max(84, Math.min(Number(size) || config.windowSize, 220));
  config.windowSize = next;
  let layout = null;
  if (panelState.open) {
    layout = positionPanel(true);
  } else {
    floatWindow.setSize(Math.round(next + FLOAT_PADDING * 2), Math.round(next + FLOAT_PADDING * 2));
  }
  await writeJson(configPath, config);
  return { size: next, layout };
});
ipcMain.handle('window:move-by', (_event, delta) => {
  if (!floatWindow || !delta) return;
  const [x, y] = floatWindow.getPosition();
  floatWindow.setPosition(Math.round(x + Number(delta.x || 0)), Math.round(y + Number(delta.y || 0)), false);
  if (panelState.open) {
    panelState.orbX = Math.round(panelState.orbX + Number(delta.x || 0));
    panelState.orbY = Math.round(panelState.orbY + Number(delta.y || 0));
  }
});
ipcMain.handle('window:set-detail-open', (_event, open) => positionPanel(open));
ipcMain.handle('external:open-platform', () => shell.openExternal(PLATFORM_URL));
ipcMain.handle('app:quit', () => app.quit());
