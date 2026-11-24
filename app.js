'use strict';

// =====================================================================
// Storage
// =====================================================================
const STORE_KEY = 'shelf-value-v1';
const SETTINGS_KEY = 'shelf-value-settings';
const REFRESH_KEY = 'shelf-value-last-refresh';
const SETS_KEY = 'shelf-value-sets';
const API = 'https://api.tcgdex.net/v2/en';

const DEFAULT_SETTINGS = { gFee: 25, gExtra: 5, gMin: 30, gP10: 30 };
let settings = { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_KEY, {}) };
let items = readJSON(STORE_KEY, []).map(migrate);

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(items)); }
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Older (pre-Pokémon) items and imported files get sensible defaults.
function migrate(it) {
  it.id = it.id || uid();
  if (!it.kind) it.kind = it.cardId ? 'card' : (it.platform !== undefined ? 'other' : 'sealed');
  if (!it.list) it.list = 'collection';
  if (it.platform && !it.setName) it.setName = it.platform;
  if (!it.added) it.added = it.acquired || today();
  if (!Array.isArray(it.prices)) it.prices = [];
  it.qty = Math.max(1, parseInt(it.qty) || 1);
  return it;
}

// =====================================================================
// Helpers
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const money = n => (n == null || isNaN(n)) ? '—' :
  Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const signedMoney = n => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const pct = n => (n == null || !isFinite(n)) ? '' : ` (${n > 0 ? '+' : ''}${n.toFixed(1)}%)`;
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : 'muted';
const today = () => toISO(new Date());
const toISO = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined,
  { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const num = v => (v === '' || v == null || isNaN(parseFloat(v))) ? null : parseFloat(v);
const COND_SHORT = { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'DMG' };

function variantLabel(key) {
  if (!key) return '';
  return key.split('-').map(w => w === '1st' ? '1st' : w[0].toUpperCase() + w.slice(1)).join(' ')
    .replace('Holofoil', 'Holo');
}
const isGraded = it => it.condition === 'Graded';
const isAutoPriced = it => it.kind === 'card' && it.cardId && !isGraded(it);
const sortedPrices = it => [...(it.prices || [])].sort((a, b) => a.date.localeCompare(b.date));

function versionText(it) {
  if (it.kind === 'card') {
    const cond = isGraded(it) ? `${it.grader || ''} ${it.grade || ''}`.trim() : (COND_SHORT[it.condition] || it.condition);
    return [it.variantName || variantLabel(it.variant), cond].filter(Boolean).join(' · ');
  }
  return it.productType || 'Sealed';
}

function itemStats(it) {
  const ps = sortedPrices(it);
  const last = ps[ps.length - 1], prev = ps[ps.length - 2];
  const qty = it.qty || 1;
  const unit = last ? last.price : (it.paid || 0);
  const value = unit * qty;
  const cost = (it.paid || 0) * qty;
  return {
    unit, value, cost, qty, priced: !!last,
    gain: value - cost,
    gainPct: cost ? (value - cost) / cost * 100 : null,
    change: last && prev ? (last.price - prev.price) * qty : null,
    changePct: last && prev && prev.price ? (last.price - prev.price) / prev.price * 100 : null,
    lastDate: last ? last.date : null,
  };
}

function upsertPrice(it, date, price, source) {
  const existing = it.prices.find(p => p.date === date && p.source === source);
  if (existing) existing.price = price;
  else it.prices.push({ id: uid(), date, price, source });
}

// =====================================================================
// TCGdex API
// =====================================================================
let sets = [], setById = new Map(), setOrder = new Map();
const cardCache = new Map();

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} from card database`);
  return r.json();
}

async function loadSets() {
  const cached = readJSON(SETS_KEY, null);
  if (cached && Date.now() - cached.t < 3 * 864e5) sets = cached.data;
  else {
    try {
      sets = (await getJSON(`${API}/sets`)).map(s => ({ id: s.id, name: s.name, official: s.cardCount?.official }));
      localStorage.setItem(SETS_KEY, JSON.stringify({ t: Date.now(), data: sets }));
    } catch { sets = cached?.data || []; }
  }
  sets.forEach((s, i) => { setById.set(s.id, s); setOrder.set(s.id, i); });
  const opts = [...sets].reverse().map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#setSelect').innerHTML = '<option value="">Any set</option>' + opts;
  itemForm.elements.sealedSet.innerHTML = '<option value="">None</option>' + opts;
}

const setIdOf = cardId => cardId.slice(0, cardId.lastIndexOf('-'));

async function getCard(id) {
  if (cardCache.has(id)) return cardCache.get(id);
  const card = await getJSON(`${API}/cards/${encodeURIComponent(id)}`);
  cardCache.set(id, card);
  return card;
}

// Each priced version of a card (Normal, Holo, Reverse Holo, 1st Edition, ...).
function priceOptions(card) {
  const priced = tp => Object.entries(tp || {})
    .filter(([, v]) => v && typeof v === 'object' && (v.marketPrice != null || v.midPrice != null));
  const opts = priced(card.pricing?.tcgplayer).map(([key, v]) =>
    ({ key, label: variantLabel(key), price: v.marketPrice ?? v.midPrice, productId: v.productId }));
  const seen = new Set(opts.map(o => `${o.productId}|${o.key}`));
  (card.variants_detailed || []).forEach(v => {
    priced(v.pricing?.tcgplayer).forEach(([key, p]) => {
      if (seen.has(`${p.productId}|${key}`)) return;
      seen.add(`${p.productId}|${key}`);
      const label = [variantLabel(key), v.subtype && v.subtype !== 'unlimited' ? variantLabel(v.subtype) : '',
        ...(v.stamp || []).map(variantLabel)].filter(Boolean).join(' · ');
      opts.push({ key: `${v.variantId}~${key}`, label, price: p.marketPrice ?? p.midPrice, productId: p.productId });
    });
  });
  // Regular versions first (they're what most people have), reverse holos and specials after.
  const rank = k => /^normal$/.test(k) ? 0 : /^holofoil$/.test(k) ? 1 : /^unlimited/.test(k) ? 2
    : /^1st-edition/.test(k) ? 3 : /reverse/.test(k) ? 5 : 4;
  return opts.sort((a, b) => rank(a.key) - rank(b.key));
}

// =====================================================================
// Price refresh
// =====================================================================
let refreshing = false;

async function refreshItem(it) {
  const card = await getCard(it.cardId);
  if (!it.image && card.image) it.image = card.image;
  if (!it.rarity && card.rarity) it.rarity = card.rarity;
  const opt = priceOptions(card).find(o => o.key === it.variant);
  if (opt) {
    it.tcgId = opt.productId;
    upsertPrice(it, today(), opt.price, 'TCGplayer market');
  }
}

async function refreshAll() {
  if (refreshing) return;
  // TCGplayer prices for raw cards, then eBay ranges for graded, sealed and grading picks.
  const jobs = items.filter(isAutoPriced).map(it => () => refreshItem(it));
  const tcgCount = jobs.length;
  if (workerUrl()) ebayTargets().forEach(it => jobs.push(() => refreshEbay(it)));
  if (!jobs.length) { updateRefreshStatus(); return; }
  refreshing = true;
  $('#refreshBtn').disabled = true;
  cardCache.clear();
  let done = 0, failed = 0;
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try { await job(); } catch { failed++; }
      done++;
      $('#refreshStatus').textContent = done <= tcgCount
        ? `Updating TCGplayer prices ${done}/${tcgCount}…` : `Checking eBay ${done - tcgCount}/${jobs.length - tcgCount}…`;
    }
  }
  // TCGplayer jobs first (fast), then eBay a few at a time.
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  save();
  localStorage.setItem(REFRESH_KEY, String(Date.now()));
  refreshing = false;
  $('#refreshBtn').disabled = false;
  render();
  if (detailId) renderDetail();
  updateRefreshStatus(failed ? `${failed} card${failed > 1 ? 's' : ''} couldn't be updated.` : '');
}

function updateRefreshStatus(extra = '') {
  const t = +localStorage.getItem(REFRESH_KEY);
  let msg = 'Prices not updated yet';
  if (t) {
    const mins = Math.round((Date.now() - t) / 6e4);
    msg = mins < 1 ? 'Prices updated just now' : mins < 60 ? `Prices updated ${mins} min ago`
      : mins < 1440 ? `Prices updated ${Math.round(mins / 60)} h ago` : `Prices updated ${Math.round(mins / 1440)} days ago`;
  }
  $('#refreshStatus').textContent = [msg, extra].filter(Boolean).join(' · ');
}
$('#refreshBtn').addEventListener('click', refreshAll);

// =====================================================================
// Collection value series
// =====================================================================
function valueAt(date, list) {
  let value = 0, paid = 0;
  list.forEach(it => {
    if (it.acquired && it.acquired > date) return;
    const ps = sortedPrices(it);
    const before = ps.filter(p => p.date <= date);
    const qty = it.qty || 1;
    let unit;
    if (before.length) unit = before[before.length - 1].price;
    else if (it.paid != null) unit = it.paid;
    else unit = ps.length ? ps[0].price : 0;
    value += unit * qty;
    paid += (it.paid || 0) * qty;
  });
  return { date, value, paid };
}

function collectionSeries(rangeDays) {
  const list = items.filter(i => i.list === 'collection');
  const dates = new Set([today()]);
  list.forEach(it => {
    it.prices.forEach(p => dates.add(p.date));
    if (it.acquired) dates.add(it.acquired);
  });
  let all = [...dates].sort();
  if (rangeDays) {
    const start = daysAgo(rangeDays);
    const hadEarlier = all.some(d => d < start);
    all = all.filter(d => d >= start);
    if (hadEarlier) all.unshift(start);
  }
  // Start from the first date anything was owned.
  return all.map(d => valueAt(d, list)).filter((p, i, arr) => p.value > 0 || p.paid > 0 || i === arr.length - 1);
}

// =====================================================================
// Chart (SVG, no libraries)
// =====================================================================
const tooltip = $('#tooltip');

// lines: [{ values: [...], cls: 'line' | 'line paid', label }], all aligned to dates
// Charts are drawn at their box's real pixel size. If the box has no size yet
// (app still starting, dialog not open) or changes size (phone rotated), the
// ResizeObserver below redraws it, so the chart is never stretched or squished.
const chartObserver = new ResizeObserver(entries => entries.forEach(({ target }) => {
  const w = Math.round(target.clientWidth);
  if (target._chart && w && w !== target._drawnWidth) renderChart(target, ...target._chart);
}));

function renderChart(container, dates, lines, emptyMsg) {
  container._chart = [dates, lines, emptyMsg];
  chartObserver.observe(container);
  if (dates.length < 2) {
    container.innerHTML = `<div class="chart-empty">${esc(emptyMsg)}</div>`;
    return;
  }
  const W = Math.round(container.clientWidth), H = container.clientHeight || 220;
  if (!W) { // drawn once it has a size
    container.innerHTML = ''; container._drawnWidth = 0;
    requestAnimationFrame(() => { if (container.clientWidth && !container._drawnWidth) renderChart(container, ...container._chart); });
    return;
  }
  container._drawnWidth = W;
  const m = { t: 10, r: 12, b: 24, l: 64 };
  const t = dates.map(d => new Date(d + 'T00:00:00').getTime());
  const allVals = lines.flatMap(l => l.values);
  const t0 = t[0], t1 = t[t.length - 1];
  let lo = Math.min(...allVals), hi = Math.max(...allVals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1; lo = Math.max(0, lo - pad); hi += pad;
  const x = d => m.l + (d - t0) / (t1 - t0 || 1) * (W - m.l - m.r);
  const y = n => m.t + (1 - (n - lo) / (hi - lo)) * (H - m.t - m.b);

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const val = lo + (hi - lo) * i / 4, yy = y(val);
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>` +
      `<text class="axis" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${money(val).replace(/\.\d\d$/, '')}</text>`;
  }
  const short = (t1 - t0) < 120 * 864e5;
  const xlab = [0, 0.5, 1].map((f, i) => {
    const d = t0 + (t1 - t0) * f;
    const txt = new Date(d).toLocaleDateString(undefined, short ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' });
    return `<text class="axis" x="${x(d)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">${txt}</text>`;
  }).join('');

  const pathOf = vals => vals.map((v, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const main = lines[0];
  const area = `${pathOf(main.values)}L${x(t1)},${y(lo)}L${x(t0)},${y(lo)}Z`;
  const paths = lines.slice().reverse().map(l => `<path class="${l.cls}" d="${pathOf(l.values)}"/>`).join('');
  const dots = dates.length <= 40
    ? main.values.map((v, i) => `<circle class="dot" r="2.5" cx="${x(t[i])}" cy="${y(v)}"/>`).join('') : '';

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}${xlab}<path class="area" d="${area}"/>${paths}${dots}
    <line class="guide" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="focus" r="4.5" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/></svg>`;

  const svg = $('svg', container), guide = $('.guide', svg), focus = $('.focus', svg);
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (W / r.width);
    let best = 0;
    t.forEach((d, i) => { if (Math.abs(x(d) - mx) < Math.abs(x(t[best]) - mx)) best = i; });
    const px = x(t[best]), py = y(main.values[best]);
    guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
    focus.setAttribute('cx', px); focus.setAttribute('cy', py); focus.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    tooltip.innerHTML = `${fmtDate(dates[best])}<br>` +
      lines.map(l => `${l.label}: <b>${money(l.values[best])}</b>`).join('<br>');
    tooltip.style.left = (r.left + px * r.width / W + 12) + 'px';
    tooltip.style.top = (r.top + py * r.height / H - 20 - 18 * lines.length) + 'px';
  });
  svg.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
    guide.setAttribute('visibility', 'hidden');
    focus.setAttribute('visibility', 'hidden');
  });
}

// =====================================================================
// Grading recommendation
// =====================================================================
function gradeEval(it) {
  const s = itemStats(it);
  const raw = s.unit;
  const c = it.comps || {};
  const p = (c.p10 ?? settings.gP10) / 100;
  const cost = (settings.gFee || 0) + (settings.gExtra || 0);
  // Your own sold prices win; otherwise use the eBay listing estimate.
  const er = it.ebay?.ranges || {};
  const psa10 = c.psa10 || (er['PSA 10']?.n >= 2 ? er['PSA 10'].est : null);
  const psa9 = c.psa9 || (er['PSA 9']?.n >= 2 ? er['PSA 9'].est : null);
  const fromEbay = (!c.psa10 && !!psa10) || (!c.psa9 && !!psa9);
  if (!psa10 || !psa9) return { verdict: 'need', label: 'Needs PSA prices', raw, cost, p, psa10, psa9 };
  const ev = p * psa10 + (1 - p) * psa9 - cost;
  const profit = ev - raw;
  const worst = psa9 - cost - raw;
  let verdict, label;
  if (profit >= Math.max(15, raw * 0.2)) { verdict = 'go'; label = 'Grade it'; }
  else if (profit > 0) { verdict = 'maybe'; label = 'Borderline'; }
  else { verdict = 'no'; label = 'Keep it raw'; }
  return { verdict, label, raw, cost, p, ev, profit, worst, psa10, psa9, fromEbay };
}

const gradingCandidates = () => items.filter(it =>
  it.list === 'collection' && it.kind === 'card' && it.condition === 'Near Mint' &&
  itemStats(it).unit >= (settings.gMin || 0));

// =====================================================================
// Main view
// =====================================================================
let view = 'collection';
let rangeDays = 0;

function statTile(label, value, extraClass = '') {
  return `<div class="stat"><div class="label">${label}</div><div class="value ${extraClass}">${value}</div></div>`;
}

function renderHero() {
  const series = collectionSeries(rangeDays);
  const last = series[series.length - 1] || { value: 0, paid: 0 };
  $('#heroValue').textContent = money(last.value);
  const first = series[0];
  if (series.length >= 2 && first) {
    const diff = last.value - first.value;
    const label = rangeDays ? { 30: 'past month', 90: 'past 3 months', 180: 'past 6 months', 365: 'past year' }[rangeDays]
      : `since ${fmtDate(first.date)}`;
    $('#heroChange').innerHTML = `<span class="${cls(diff)}">${signedMoney(diff)}${pct(first.value ? diff / first.value * 100 : null)}</span> ${label}`;
  } else {
    $('#heroChange').textContent = '';
  }
  renderChart($('#totalChart'), series.map(p => p.date), [
    { values: series.map(p => p.value), cls: 'line', label: 'Value' },
    { values: series.map(p => p.paid), cls: 'line paid', label: 'Paid' },
  ], items.some(i => i.list === 'collection')
    ? 'Your chart fills in over time: prices are recorded each day you open the app.'
    : 'Add cards to your collection to start tracking its value.');
}

function render() {
  const coll = items.filter(i => i.list === 'collection').map(it => ({ it, s: itemStats(it) }));
  const wish = items.filter(i => i.list === 'wishlist').map(it => ({ it, s: itemStats(it) }));
  const total = coll.reduce((a, r) => a + r.s.value, 0);
  const cost = coll.reduce((a, r) => a + r.s.cost, 0);
  const count = coll.reduce((a, r) => a + r.s.qty, 0);
  const gain = total - cost;
  const wishTotal = wish.reduce((a, r) => a + r.s.value, 0);
  const picks = gradingCandidates().filter(it => gradeEval(it).verdict === 'go').length;

  renderHero();
  $('#stats').innerHTML =
    statTile('Total paid', money(cost)) +
    statTile('Gain / loss', signedMoney(gain) + `<small>${pct(cost ? gain / cost * 100 : null)}</small>`, cls(gain)) +
    statTile('Items owned', count.toLocaleString()) +
    statTile('Wishlist cost', money(wishTotal)) +
    statTile('Worth grading', picks ? `${picks} card${picks > 1 ? 's' : ''}` : '—');

  // view tabs with counts
  const counts = { collection: coll.length, wishlist: wish.length, grading: gradingCandidates().length, sets: '' };
  $$('#viewTabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.view === view);
    b.innerHTML = b.textContent.replace(/\s*\d+$/, '') + `<span class="count">${counts[b.dataset.view]}</span>`;
  });

  // filter dropdowns
  fillSelect($('#categoryFilter'), 'All categories', items.map(i => i.category));
  fillSelect($('#setFilter'), 'All sets', items.map(i => i.setName));
  $('#categoryList').innerHTML = [...new Set(items.map(i => i.category).filter(Boolean))].sort()
    .map(c => `<option value="${esc(c)}">`).join('');

  $('#typeFilter').hidden = view === 'grading';
  $('#sort').hidden = view === 'grading';
  $('#gradingSettings').hidden = view !== 'grading';
  const sets = view === 'sets';
  $('#setsView').hidden = !sets;
  $('#listToolbar').hidden = sets;
  $('.table-wrap').hidden = sets;

  $('#itemsTable').className = 'v-' + view;
  if (sets) renderSetGrid();
  else if (view === 'grading') renderGrading();
  else renderList(view === 'collection' ? coll : wish);
}

function fillSelect(sel, allLabel, values) {
  const current = sel.value;
  const opts = [...new Set(values.filter(Boolean))].sort();
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    opts.map(v => `<option ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

function applyFilters(rows) {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#categoryFilter').value, set = $('#setFilter').value, type = $('#typeFilter').value;
  return rows.filter(({ it }) =>
    (!cat || it.category === cat) &&
    (!set || it.setName === set) &&
    (view === 'grading' || !type ||
      (type === 'raw' && it.kind === 'card' && !isGraded(it)) ||
      (type === 'graded' && it.kind === 'card' && isGraded(it)) ||
      (type === 'sealed' && it.kind !== 'card')) &&
    (!q || [it.name, it.setName, it.number, it.category, it.notes, it.rarity, versionText(it)].join(' ').toLowerCase().includes(q)));
}

const thumb = it => it.image
  ? `<td class="thumb"><img src="${esc(it.image)}/low.webp" alt="" loading="lazy"></td>`
  : `<td class="thumb"><div class="ph">${it.kind === 'card' ? 'card' : 'box'}</div></td>`;
const nameCell = it => `<td class="name">${esc(it.name)}${it.category ? `<span class="tag">${esc(it.category)}</span>` : ''}
  <small>${esc([it.setName, it.number && '#' + it.number].filter(Boolean).join(' · '))}</small></td>`;
const dash = '<span class="muted">—</span>';

function renderList(rows) {
  rows = applyFilters(rows);
  const sorters = {
    'value-desc': (a, b) => b.s.value - a.s.value,
    'value-asc': (a, b) => a.s.value - b.s.value,
    'name-asc': (a, b) => a.it.name.localeCompare(b.it.name),
    'gain-desc': (a, b) => b.s.gain - a.s.gain,
    'change-desc': (a, b) => Math.abs(b.s.changePct || 0) - Math.abs(a.s.changePct || 0),
    'added-desc': (a, b) => (b.it.added || '').localeCompare(a.it.added || ''),
  };
  rows.sort(sorters[$('#sort').value]);
  const table = $('#itemsTable');

  if (view === 'collection') {
    $('thead', table).innerHTML = `<tr><th></th><th>Card</th><th>Version</th><th class="num">Qty</th>
      <th class="num">Paid</th><th class="num">Value</th><th class="num">Last change</th><th class="num">Gain</th><th>Priced</th></tr>`;
    $('tbody', table).innerHTML = rows.map(({ it, s }) => `
      <tr data-id="${it.id}">${thumb(it)}${nameCell(it)}
        <td>${esc(versionText(it))}</td>
        <td class="num">${s.qty}</td>
        <td class="num">${it.paid != null ? money(s.cost) : dash}</td>
        <td class="num"><b>${s.priced || it.paid != null ? money(s.value) : dash}</b></td>
        <td class="num ${cls(s.change)}">${s.change == null ? dash : signedMoney(s.change) + pct(s.changePct)}</td>
        <td class="num ${cls(s.gain)}">${it.paid != null && s.priced ? signedMoney(s.gain) : dash}</td>
        <td class="${!isAutoPriced(it) && s.lastDate && s.lastDate < daysAgo(90) ? 'stale' : ''}">${s.lastDate ? fmtDate(s.lastDate) : 'never'}</td>
      </tr>`).join('');
  } else {
    $('thead', table).innerHTML = `<tr><th></th><th>Card</th><th>Version</th>
      <th class="num">Market</th><th class="num">Target</th><th class="num">Last change</th><th>Added</th></tr>`;
    $('tbody', table).innerHTML = rows.map(({ it, s }) => {
      const hit = it.target != null && s.priced && s.unit <= it.target;
      return `<tr data-id="${it.id}">${thumb(it)}${nameCell(it)}
        <td>${esc(versionText(it))}</td>
        <td class="num ${hit ? 'hit' : ''}"><b>${s.priced ? money(s.unit) : dash}</b></td>
        <td class="num">${it.target != null ? money(it.target) + (hit ? ' <span class="hit">✓ at target</span>' : '') : dash}</td>
        <td class="num ${cls(s.change)}">${s.change == null ? dash : signedMoney(s.change / s.qty) + pct(s.changePct)}</td>
        <td>${fmtDate(it.added)}</td></tr>`;
    }).join('');
  }
  const has = view === 'collection' ? items.some(i => i.list === 'collection') : items.some(i => i.list === 'wishlist');
  $('#empty').hidden = rows.length > 0;
  $('#empty').innerHTML = !has
    ? (view === 'collection' ? 'Your collection is empty. Click <b>+ Add</b> to look up your first card.'
      : 'Your wishlist is empty. Click <b>+ Add</b> and choose <b>Wishlist</b> to track cards you want.')
    : 'Nothing matches your filters.';
}

function renderGrading() {
  let rows = applyFilters(gradingCandidates().map(it => ({ it, s: itemStats(it), g: gradeEval(it) })));
  const rank = { go: 0, maybe: 1, need: 2, no: 3 };
  rows.sort((a, b) => rank[a.g.verdict] - rank[b.g.verdict] || (b.g.profit ?? 0) - (a.g.profit ?? 0) || b.s.unit - a.s.unit);
  const table = $('#itemsTable');
  $('thead', table).innerHTML = `<tr><th></th><th>Card</th><th class="num">Raw value</th><th class="num">PSA 10</th>
    <th class="num">PSA 9</th><th>Verdict</th><th class="num">Expected profit</th></tr>`;
  $('tbody', table).innerHTML = rows.map(({ it, g }) => `
    <tr data-id="${it.id}">${thumb(it)}${nameCell(it)}
      <td class="num">${money(g.raw)}</td>
      <td class="num">${g.psa10 ? money(g.psa10) : dash}</td>
      <td class="num">${g.psa9 ? money(g.psa9) : dash}</td>
      <td><span class="verdict ${g.verdict}">${g.label}</span></td>
      <td class="num ${cls(g.profit)}">${g.profit != null ? signedMoney(g.profit) : dash}</td></tr>`).join('');
  $('#empty').hidden = rows.length > 0;
  $('#empty').innerHTML = `No Near Mint raw cards worth ${money(settings.gMin)} or more yet.
    Lower the minimum above, or add more cards.`;
}

// grading settings inputs
['gFee', 'gExtra', 'gMin', 'gP10'].forEach(k => {
  const el = $('#' + k);
  el.value = settings[k];
  el.addEventListener('input', () => { settings[k] = num(el.value) ?? 0; saveSettings(); render(); });
});

$('#viewTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  view = b.dataset.view;
  render();
});
$('#ranges').addEventListener('click', e => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  rangeDays = +b.dataset.range;
  $$('#ranges button').forEach(x => x.classList.toggle('on', x === b));
  renderHero();
});
['#search', '#categoryFilter', '#setFilter', '#typeFilter', '#sort'].forEach(s =>
  $(s).addEventListener(s === '#search' ? 'input' : 'change', render));
$('#itemsTable tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});

// =====================================================================
// Add / edit dialog
// =====================================================================
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

const itemDialog = $('#itemDialog'), itemForm = $('#itemForm');
let editingId = null, formList = 'collection', formKind = 'card', picked = null, pickedOpts = [];

function syncForm() {
  const f = itemForm.elements;
  const editing = !!editingId;
  $$('#listTabs button').forEach(b => b.classList.toggle('on', b.dataset.list === formList));
  $$('#kindTabs button').forEach(b => b.classList.toggle('on', b.dataset.kind === formKind));
  $('#kindTabs').hidden = editing;
  const isCard = formKind === 'card';
  $('#cardPicker').hidden = !isCard || editing || !!picked;
  $('#picked').hidden = !isCard || !picked;
  $('#sealedFields').hidden = isCard;
  $('#cardFields').hidden = !isCard || !picked;
  $$('.gradeField').forEach(el => el.hidden = f.condition.value !== 'Graded');
  $$('.collectionOnly').forEach(el => el.hidden = formList !== 'collection');
  $$('.wishlistOnly').forEach(el => el.hidden = formList !== 'wishlist');
  const needsManual = !isCard || f.condition.value === 'Graded' || (picked && !pickedOpts.length);
  $('#manualPriceLabel').hidden = editing || !needsManual || (isCard && !picked);
  $('#formError').hidden = true;
}

function showPicked() {
  if (!picked) return;
  const f = itemForm.elements;
  $('#picked').innerHTML = `
    ${picked.image ? `<img src="${esc(picked.image)}/low.webp" alt="">` : '<div class="ph" style="width:80px;height:112px">card</div>'}
    <div class="grow">${esc(picked.name)}
      <small>${esc([picked.setName, '#' + picked.number, picked.rarity].filter(Boolean).join(' · '))}</small></div>
    ${editingId ? '' : '<button type="button" id="changeCard">Change card</button>'}`;
  const opts = pickedOpts.length ? pickedOpts : [{ key: '', price: null }];
  f.variant.innerHTML = opts.map(o =>
    `<option value="${esc(o.key)}">${o.key ? esc(o.label) + ' — ' + money(o.price) : 'No price data (enter value yourself)'}</option>`).join('');
}

$('#picked').addEventListener('click', e => {
  if (e.target.id === 'changeCard') { picked = null; pickedOpts = []; syncForm(); $('#cardQuery').focus(); }
});

async function openItemForm(id = null, list = view === 'wishlist' ? 'wishlist' : 'collection') {
  editingId = id;
  itemForm.reset();
  picked = null; pickedOpts = [];
  const it = id && items.find(i => i.id === id);
  $('#itemDialogTitle').textContent = it ? 'Edit' : 'Add';
  $('#results').innerHTML = '';
  formList = it ? it.list : list;
  formKind = it ? (it.kind === 'card' ? 'card' : 'sealed') : 'card';
  const f = itemForm.elements;
  if (it) {
    ['condition', 'grader', 'grade', 'category', 'qty', 'paid', 'acquired', 'target', 'notes']
      .forEach(k => { if (f[k]) f[k].value = it[k] ?? ''; });
    if (it.kind === 'card') {
      picked = { cardId: it.cardId, name: it.name, setName: it.setName, number: it.number, rarity: it.rarity, image: it.image };
      showPicked();
      f.variant.innerHTML = `<option value="${esc(it.variant || '')}">${esc(it.variantName || variantLabel(it.variant) || 'No price data')}</option>`;
      if (it.cardId) getCard(it.cardId).then(card => {
        pickedOpts = priceOptions(card);
        showPicked();
        f.variant.value = it.variant || '';
      }).catch(() => {});
    } else {
      f.sealedName.value = it.name;
      f.productType.value = it.productType || 'Other';
      f.sealedSet.value = it.setId || '';
    }
  } else {
    f.acquired.value = today();
  }
  $('#scanStatus').hidden = true;
  syncForm();
  if (!itemDialog.open) itemDialog.showModal();
}

$('#listTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-list]');
  if (b) { formList = b.dataset.list; syncForm(); }
});
$('#kindTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]');
  if (b) { formKind = b.dataset.kind; syncForm(); }
});
itemForm.elements.condition.addEventListener('change', syncForm);
$('#addBtn').addEventListener('click', () => openItemForm());

// card search
async function searchCards() {
  const q = $('#cardQuery').value.trim();
  const setId = $('#setSelect').value;
  const box = $('#results');
  if (!q && !setId) { box.innerHTML = '<p class="note">Type a card name, pick a set, or both.</p>'; return; }
  box.innerHTML = '<p class="note">Searching…</p>';
  try {
    let cards;
    if (q) {
      cards = await getJSON(`${API}/cards?name=${encodeURIComponent(q)}`);
      if (setId) cards = cards.filter(c => setIdOf(c.id) === setId);
    } else {
      cards = (await getJSON(`${API}/sets/${encodeURIComponent(setId)}`)).cards || [];
    }
    cards.sort((a, b) => (setOrder.get(setIdOf(b.id)) ?? -1) - (setOrder.get(setIdOf(a.id)) ?? -1) ||
      (parseInt(a.localId) || 0) - (parseInt(b.localId) || 0));
    const shown = cards.slice(0, 150);
    box.innerHTML = shown.length ? shown.map(c => {
      const s = setById.get(setIdOf(c.id));
      return `<button type="button" class="result" data-card="${esc(c.id)}">
        ${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : '<div class="ph">no image</div>'}
        <b>${esc(c.name)}</b><span>${esc(s ? s.name : setIdOf(c.id))} · #${esc(c.localId)}</span></button>`;
    }).join('') + (cards.length > shown.length ? `<p class="note">Showing 150 of ${cards.length}. Pick a set to narrow it down.</p>` : '')
      : '<p class="note">No cards found. Check the spelling, or try just the Pokémon\'s name.</p>';
  } catch (err) {
    box.innerHTML = `<p class="note">Couldn't reach the card database (${esc(err.message)}). Check your connection and try again.</p>`;
  }
}
$('#searchBtn').addEventListener('click', searchCards);
$('#cardQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchCards(); } });
$('#setSelect').addEventListener('change', () => { if ($('#setSelect').value) searchCards(); });

// Turn a full card from the database into the fields we store.
function cardIdentity(card) {
  const s = setById.get(card.set?.id) || {};
  const total = card.set?.cardCount?.official || s.official;
  return {
    cardId: card.id, name: card.name, setId: card.set?.id, setName: card.set?.name || s.name,
    number: total ? `${card.localId}/${total}` : card.localId, rarity: card.rarity, image: card.image,
  };
}

async function selectCard(cardId) {
  const card = await getCard(cardId);
  picked = cardIdentity(card);
  pickedOpts = priceOptions(card);
  showPicked();
  syncForm();
}

// Open the Add form with a card already chosen (from the set checklist or a scan).
async function openFormWithCard(cardId, list) {
  await openItemForm(null, list);
  $('#scanStatus').hidden = true;
  try { await selectCard(cardId); }
  catch (err) { alert("Couldn't load that card: " + err.message); }
}

$('#results').addEventListener('click', async e => {
  const b = e.target.closest('[data-card]');
  if (!b) return;
  b.disabled = true;
  try { await selectCard(b.dataset.card); $('#scanStatus').hidden = true; }
  catch (err) {
    b.disabled = false;
    alert("Couldn't load that card: " + err.message);
  }
});

itemForm.addEventListener('submit', e => {
  e.preventDefault();
  const f = itemForm.elements;
  const err = msg => { $('#formError').textContent = msg; $('#formError').hidden = false; };
  const common = {
    list: formList,
    category: f.category.value.trim(),
    qty: Math.max(1, parseInt(f.qty.value) || 1),
    notes: f.notes.value.trim(),
    paid: formList === 'collection' ? num(f.paid.value) : null,
    acquired: formList === 'collection' ? (f.acquired.value || null) : null,
    target: formList === 'wishlist' ? num(f.target.value) : null,
  };
  let data;
  if (formKind === 'card') {
    if (!picked) return err('Search for a card and pick it first.');
    data = {
      ...common, kind: 'card', cardId: picked.cardId, name: picked.name, setId: picked.setId, setName: picked.setName,
      number: picked.number, rarity: picked.rarity, image: picked.image,
      variant: f.variant.value, condition: f.condition.value,
      variantName: (pickedOpts.find(o => o.key === f.variant.value) || {}).label || variantLabel(f.variant.value),
      grader: f.condition.value === 'Graded' ? f.grader.value : '', grade: f.condition.value === 'Graded' ? f.grade.value.trim() : '',
    };
  } else {
    const name = f.sealedName.value.trim();
    if (!name) return err('Give the product a name.');
    const s = setById.get(f.sealedSet.value);
    data = { ...common, kind: 'sealed', name, productType: f.productType.value, setId: s?.id || '', setName: s?.name || '' };
  }

  let it;
  if (editingId) {
    it = items.find(i => i.id === editingId);
    const variantChanged = it.variant !== data.variant || isGraded(it) !== (data.condition === 'Graded');
    // keep picked identity fields from the original when editing
    if (it.kind === 'card') { delete data.setId; delete data.image; }
    Object.assign(it, data);
    if (variantChanged && isAutoPriced(it)) refreshItem(it).then(() => { save(); render(); if (detailId) renderDetail(); }).catch(() => {});
  } else {
    it = { id: uid(), added: today(), prices: [], ...data };
    const opt = pickedOpts.find(o => o.key === data.variant);
    if (isAutoPriced(it) && opt) { it.tcgId = opt.productId; upsertPrice(it, today(), opt.price, 'TCGplayer market'); }
    else if (num(f.manualPrice.value) != null) upsertPrice(it, today(), num(f.manualPrice.value), 'Manual');
    items.push(it);
    if (workerUrl() && !isAutoPriced(it)) {
      refreshEbay(it).then(() => { save(); render(); if (detailId) renderDetail(); }).catch(() => {});
    }
  }
  save();
  itemDialog.close();
  // Got a card you wanted? Take it off the wishlist.
  if (!editingId && it.list === 'collection' && it.cardId) {
    const wished = items.find(i => i.list === 'wishlist' && i.cardId === it.cardId);
    if (wished) { items = items.filter(i => i !== wished); save(); toast(`✓ Added ${it.name} and took it off your wishlist`); }
    else toast(`✓ Added ${it.name} to your collection`);
  }
  if (it.list !== view && view !== 'grading' && view !== 'sets') view = it.list;
  render();
  if (detailId) renderDetail();
});

// =====================================================================
// Detail dialog
// =====================================================================
const detailDialog = $('#detailDialog');
let detailId = null;
const ebayChecking = new Set();
detailDialog.addEventListener('close', () => { detailId = null; tooltip.hidden = true; });

function openDetail(id) {
  detailId = id;
  $('#priceForm').reset();
  $('#priceForm').elements.date.value = today();
  detailDialog.showModal();
  renderDetail();
  if (view === 'grading') setTimeout(() => $('#gradeBox').scrollIntoView({ block: 'nearest' }), 50);
}

function ebayUrl(q) {
  return 'https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=' + encodeURIComponent(q);
}
function searchName(it) {
  return it.kind === 'card' ? [it.name, it.number].filter(Boolean).join(' ') : [it.setName, it.name].filter(Boolean).join(' ');
}

function renderDetail() {
  const it = items.find(i => i.id === detailId);
  if (!it) { detailDialog.close(); return; }
  const s = itemStats(it);
  const img = $('#dImg');
  img.hidden = !it.image;
  if (it.image) img.src = it.image + '/high.webp';
  $('#dName').textContent = it.name;
  $('#dMeta').textContent = [it.setName, it.number && '#' + it.number, it.rarity, versionText(it),
    it.category && `Category: ${it.category}`, s.qty > 1 && `Qty ${s.qty}`,
    it.acquired && `Acquired ${fmtDate(it.acquired)}`, it.notes].filter(Boolean).join(' · ');

  const wish = it.list === 'wishlist';
  $('#dStats').innerHTML =
    statTile('Value each', s.priced || it.paid != null ? money(s.unit) : '—') +
    (wish ? statTile('Target', it.target != null ? money(it.target) : '—')
      : statTile('Paid each', it.paid != null ? money(it.paid) : '—')) +
    (wish ? '' : statTile('Gain / loss', it.paid != null && s.priced ? signedMoney(s.gain) + pct(s.gainPct) : '—', cls(s.gain))) +
    statTile('Last priced', s.lastDate ? fmtDate(s.lastDate) : 'never');

  let q = searchName(it);
  if (it.kind === 'card' && isGraded(it)) q += ` ${it.grader} ${it.grade}`;
  if (it.kind !== 'card') q += ' sealed';
  $('#ebayLink').href = ebayUrl(q);
  $('#tcgLink').hidden = !it.tcgId;
  if (it.tcgId) $('#tcgLink').href = `https://www.tcgplayer.com/product/${it.tcgId}`;
  $('#moveBtn').hidden = !wish;

  // live TCGplayer prices for every version of this card
  $('#dLive').textContent = '';
  if (it.cardId) getCard(it.cardId).then(card => {
    if (detailId !== it.id) return;
    const opts = priceOptions(card);
    $('#dLive').textContent = opts.length
      ? 'TCGplayer market now: ' + opts.map(o => `${o.label} ${money(o.price)}`).join(' · ')
      : 'No TCGplayer price for this card yet. Log prices yourself below.';
    if (isGraded(it)) $('#dLive').textContent += workerUrl()
      ? ' (raw prices; this graded card is valued from eBay listings)' : ' (raw prices; graded cards are priced by you)';
  }).catch(() => {});

  // eBay ranges: show what we have, fetch fresh ones if stale
  renderEbayBox(it);
  if (needsEbay(it) && !ebayChecking.has(it.id)) {
    ebayChecking.add(it.id);
    refreshEbay(it)
      .then(() => { save(); render(); if (detailId === it.id) renderDetail(); })
      .catch(err => { if (detailId === it.id) $('#ebayRanges').innerHTML = `<p class="error">Couldn't check eBay: ${esc(err.message)}</p>`; })
      .finally(() => ebayChecking.delete(it.id));
  }

  // grading box
  const showGrade = !wish && it.kind === 'card' && !isGraded(it);
  $('#gradeBox').hidden = !showGrade;
  if (showGrade) {
    const c = it.comps || {};
    $('#gc10').value = c.psa10 ?? '';
    $('#gc9').value = c.psa9 ?? '';
    $('#gcP').value = c.p10 ?? '';
    $('#gcP').placeholder = settings.gP10;
    const er = it.ebay?.ranges || {};
    $('#gc10').placeholder = er['PSA 10'] ? `eBay: ${money(er['PSA 10'].est)}` : '';
    $('#gc9').placeholder = er['PSA 9'] ? `eBay: ${money(er['PSA 9'].est)}` : '';
    $('#psa10Link').href = ebayUrl(searchName(it) + ' PSA 10');
    $('#psa9Link').href = ebayUrl(searchName(it) + ' PSA 9');
    renderGradeResult(it);
  }

  const ps = sortedPrices(it);
  requestAnimationFrame(() => renderChart($('#itemChart'), ps.map(p => p.date),
    [{ values: ps.map(p => p.price), cls: 'line', label: 'Price' }],
    ps.length ? 'The chart appears once there are two days of prices.' : 'No prices logged yet.'));
  $('#priceRows').innerHTML = ps.length ? [...ps].reverse().map(p => `
    <tr><td>${fmtDate(p.date)}</td><td class="num">${money(p.price)}</td>
    <td class="src">${esc(p.source)}</td>
    <td class="num"><button class="del" data-pid="${p.id}" title="Remove">✕</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No prices yet. Check eBay sold listings and log what it sells for.</td></tr>';
}

function renderGradeResult(it) {
  const g = gradeEval(it);
  const warn = it.condition !== 'Near Mint'
    ? `<p class="math">This card is marked ${esc(it.condition)}. Played cards rarely grade high enough to be worth it.</p>` : '';
  if (g.verdict === 'need') {
    $('#gradeResult').innerHTML = `<span class="verdict need">Needs PSA prices</span>
      <p class="math">Look up recent PSA 10 and PSA 9 sales with the links above and enter them to get a verdict.
      Grading costs you ${money(g.cost)} per card with your current settings.</p>${warn}`;
    return;
  }
  $('#gradeResult').innerHTML = `<span class="verdict ${g.verdict}">${g.label}</span>
    <span class="${cls(g.profit)}"> Expected ${g.profit >= 0 ? 'profit' : 'loss'}: ${signedMoney(g.profit)}</span>
    <p class="math">${Math.round(g.p * 100)}% × ${money(g.psa10)} + ${Math.round((1 - g.p) * 100)}% × ${money(g.psa9)}
      − ${money(g.cost)} grading = ${money(g.ev)} expected, vs ${money(g.raw)} raw.
      If it comes back a 9: ${signedMoney(g.worst)}. If it grades below 9 you'll usually lose money.</p>
    ${g.fromEbay ? `<p class="math">PSA prices are estimated from current eBay listings. For a sharper answer, check
      recent sold prices with the links above and type them in.</p>` : ''}${warn}`;
}

['gc10', 'gc9', 'gcP'].forEach(idName => $('#' + idName).addEventListener('input', () => {
  const it = items.find(i => i.id === detailId);
  if (!it) return;
  it.comps = { psa10: num($('#gc10').value), psa9: num($('#gc9').value), p10: num($('#gcP').value) };
  save();
  renderGradeResult(it);
  render();
}));

$('#priceForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.elements;
  const it = items.find(i => i.id === detailId);
  it.prices.push({ id: uid(), date: f.date.value, price: parseFloat(f.price.value), source: f.source.value.trim() || 'Manual' });
  save();
  f.price.value = ''; f.source.value = '';
  renderDetail(); render();
});

$('#priceRows').addEventListener('click', e => {
  const b = e.target.closest('[data-pid]');
  if (!b) return;
  const it = items.find(i => i.id === detailId);
  it.prices = it.prices.filter(p => p.id !== b.dataset.pid);
  save(); renderDetail(); render();
});

$('#editBtn').addEventListener('click', () => openItemForm(detailId));
$('#moveBtn').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  it.list = 'collection';
  it.acquired = today();
  save();
  view = 'collection';
  detailDialog.close();
  render();
  openItemForm(it.id); // so they can fill in what they paid
});
$('#deleteBtn').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  if (!confirm(`Delete "${it.name}" and its price history?`)) return;
  items = items.filter(i => i.id !== detailId);
  save(); detailDialog.close(); render();
});

// =====================================================================
// Import / export
// =====================================================================
const dataMenu = $('#dataMenu');
$('#dataBtn').addEventListener('click', e => { e.stopPropagation(); dataMenu.hidden = !dataMenu.hidden; });
document.addEventListener('click', () => { dataMenu.hidden = true; });

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const CSV_COLS = ['list', 'kind', 'name', 'set', 'set_id', 'number', 'card_id', 'rarity', 'image', 'variant', 'condition',
  'grader', 'grade', 'product_type', 'category', 'qty', 'paid', 'acquired', 'target', 'notes', 'added',
  'variant_name', 'price_date', 'price', 'price_source'];

function toCSV() {
  const lines = [CSV_COLS.join(',')];
  items.forEach(it => {
    const base = [it.list, it.kind, it.name, it.setName, it.setId, it.number, it.cardId, it.rarity, it.image, it.variant,
      it.condition, it.grader, it.grade, it.productType, it.category, it.qty, it.paid, it.acquired, it.target, it.notes, it.added, it.variantName];
    const ps = sortedPrices(it);
    if (!ps.length) lines.push([...base, '', '', ''].map(csvCell).join(','));
    ps.forEach(p => lines.push([...base, p.date, p.price, p.source].map(csvCell).join(',')));
  });
  return lines.join('\n');
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map(h => h.trim().toLowerCase());
  const byKey = new Map();
  rows.filter(r => r.some(Boolean)).forEach(r => {
    const o = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']));
    if (!o.name) return;
    const key = [o.list, o.card_id, o.name, o.variant, o.condition, o.grader, o.grade, o.category, o.added].join('|');
    let it = byKey.get(key);
    if (!it) {
      it = migrate({
        list: o.list || 'collection', kind: o.kind || (o.card_id ? 'card' : 'sealed'), name: o.name,
        setName: o.set || o.platform || '', setId: o.set_id || '', number: o.number || '', cardId: o.card_id || '',
        rarity: o.rarity || '', image: o.image || '', variant: o.variant || '', condition: o.condition || 'Near Mint',
        grader: o.grader || '', grade: o.grade || '', productType: o.product_type || '', category: o.category || '',
        qty: o.qty, paid: num(o.paid), acquired: o.acquired || null, target: num(o.target), notes: o.notes || '',
        added: o.added || '', variantName: o.variant_name || '', prices: [],
      });
      byKey.set(key, it);
    }
    if (o.price_date && num(o.price) != null)
      it.prices.push({ id: uid(), date: o.price_date, price: num(o.price), source: o.price_source || '' });
  });
  return [...byKey.values()];
}

$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = (file.name.toLowerCase().endsWith('.csv') ? parseCSV(text) : JSON.parse(text));
    if (!Array.isArray(incoming)) throw new Error('Expected a list of items');
    incoming.forEach(migrate);
    const replace = items.length && confirm(
      `Import ${incoming.length} items.\n\nOK = replace your current collection\nCancel = add to it`);
    items = replace ? incoming : items.concat(incoming);
    save(); render();
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  }
});

dataMenu.addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'export-json') download(`shelf-value-${today()}.json`, JSON.stringify(items, null, 2), 'application/json');
  if (act === 'export-csv') download(`shelf-value-${today()}.csv`, toCSV(), 'text/csv');
  if (act === 'import') $('#fileInput').click();
  if (act === 'clear') {
    if (!confirm('Delete your whole collection and wishlist from this browser? Export a backup first if you want to keep it.')) return;
    items = []; save(); render();
  }
});

// =====================================================================
// eBay price ranges (via your own Cloudflare Worker, see worker/ebay-worker.js)
// =====================================================================
const WORKER_KEY = 'shelf-value-worker';
const workerUrl = () => (localStorage.getItem(WORKER_KEY) || '').replace(/\/+$/, '');
const EBAY_MAX_AGE = 20 * 36e5; // re-check a listing range after ~a day

async function workerSearch(q, type) {
  const r = await fetch(`${workerUrl()}/search?type=${type}&q=${encodeURIComponent(q)}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} from price worker`);
  return body.items || [];
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
function rangeStats(prices) {
  const s = [...prices].sort((a, b) => a - b);
  const trim = s.length >= 8;
  return {
    n: s.length, min: s[0],
    low: trim ? quantile(s, 0.1) : s[0], high: trim ? quantile(s, 0.9) : s[s.length - 1],
    median: quantile(s, 0.5),
    est: quantile(s, 0.25), // asking prices run high, so the lower quartile is the value estimate
  };
}

const JUNK = /\b(lot|lots|bundle|proxy|custom|replica|fake|orica|reprint|digital|code cards?|jumbo|oversized|metal|gold plated|japanese|japan|jpn|korean|chinese|choose|pick|you pick|u pick|complete set|binder|sleeve|toploader|empty)\b/i;
const GRADE_RE = /\b(PSA|CGC|BGS|BECKETT|SGC|TAG|ACE)\b[\s\-:#]*(?:(?:GEM|GEM-MT|GEM MT|GEM MINT|MINT|PRISTINE|PERFECT|BLACK LABEL|NM-MT|NM)\s*)*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)(?![\d.])/i;
const SEALED_TYPES = {
  'Booster Box': /booster box|display box|36\s*packs?/i,
  'Elite Trainer Box': /elite trainer|\betb\b/i,
  'Booster Bundle': /bundle/i,
  'Booster Pack': /\bpacks?\b/i,
  'Collection Box': /collection|premium|box/i,
  'Tin': /\btin\b/i,
};

function bucketOf(it) {
  if (it.kind !== 'card') return 'Sealed';
  if (!isGraded(it)) return 'Raw';
  const g = (it.grader || '').toUpperCase().replace('BECKETT', 'BGS');
  return `${g} ${String(it.grade || '').trim()}`;
}

function cardNumberMatches(title, number) {
  if (!number) return true;
  const local = String(number).split('/')[0].trim();
  const n = parseInt(local, 10);
  if (String(n) === local.replace(/^0+(?=\d)/, '')) {
    return new RegExp(`(^|[^\\d.])0*${n}(?![\\d.])`).test(title);
  }
  return title.toLowerCase().includes(local.toLowerCase());
}

// Turn raw listings into price ranges per grade (or for a sealed product).
function analyzeListings(listings, it) {
  const seen = new Set(), buckets = {};
  const nameWord = (it.name || '').toLowerCase().split(/[\s'’]+/).find(w => w.length > 2) || '';
  listings.forEach(l => {
    if (!l.url || seen.has(l.url)) return;
    seen.add(l.url);
    const t = l.title || '';
    if (JUNK.test(t)) return;
    let key;
    if (it.kind === 'card') {
      if (nameWord && !t.toLowerCase().includes(nameWord)) return;
      if (!cardNumberMatches(t, it.number)) return;
      const m = t.match(GRADE_RE);
      if (m) key = `${m[1].toUpperCase().replace('BECKETT', 'BGS')} ${m[2]}`;
      else if (/\b(graded|slab|psa|cgc|bgs|sgc|beckett)\b/i.test(t)) return; // graded but grade unclear
      else key = 'Raw';
    } else {
      if (!/sealed|factory|new/i.test(t) || /\b(opened|case of|no packs?)\b/i.test(t)) return;
      const typeRe = SEALED_TYPES[it.productType];
      if (typeRe && !typeRe.test(t)) return;
      if (it.productType === 'Booster Pack' && /\bbox\b/i.test(t)) return;
      const setWord = (it.setName || '').toLowerCase().split(/\s+/).find(w => w.length > 2);
      if (setWord && !t.toLowerCase().includes(setWord)) return;
      key = 'Sealed';
    }
    (buckets[key] = buckets[key] || []).push(l);
  });
  const out = {};
  Object.entries(buckets).forEach(([k, ls]) => {
    ls.sort((a, b) => a.price - b.price);
    out[k] = { ...rangeStats(ls.map(l => l.price)), cheapest: ls.slice(0, 3).map(l => ({ t: l.title, p: l.price, u: l.url })) };
  });
  return out;
}

async function refreshEbay(it) {
  if (!workerUrl()) return;
  let listings;
  if (it.kind === 'card') {
    const base = `pokemon ${it.name} ${it.number || ''}`.trim();
    const extra = isGraded(it) && it.grader && it.grader !== 'PSA' && it.grader !== 'Other' ? it.grader : 'PSA';
    const [a, b] = await Promise.all([workerSearch(base, 'card'), workerSearch(`${base} ${extra}`, 'card')]);
    listings = a.concat(b);
  } else {
    const q = it.setName && !it.name.toLowerCase().includes(it.setName.toLowerCase())
      ? `pokemon ${it.setName} ${it.name}` : `pokemon ${it.name}`;
    listings = await workerSearch(q, 'sealed');
  }
  it.ebay = { fetched: Date.now(), ranges: analyzeListings(listings, it) };
  // Graded cards and sealed product take their value from eBay; raw cards keep TCGplayer.
  const mine = it.ebay.ranges[bucketOf(it)];
  if (!isAutoPriced(it) && mine && mine.n >= 2) upsertPrice(it, today(), Math.round(mine.est * 100) / 100, 'eBay listings');
}

const needsEbay = it => !!workerUrl() && (!it.ebay || Date.now() - it.ebay.fetched > EBAY_MAX_AGE);
const ebayTargets = () => items.filter(it =>
  it.kind !== 'card' || isGraded(it) ||
  (it.list === 'collection' && it.condition === 'Near Mint' && itemStats(it).unit >= (settings.gMin || 0)));

function renderEbayBox(it) {
  const box = $('#ebayBox');
  box.hidden = !workerUrl();
  if (!workerUrl()) return;
  const el = $('#ebayRanges');
  if (!it.ebay) { el.innerHTML = '<p class="muted small">Checking eBay…</p>'; return; }
  const order = k => k === 'Raw' || k === 'Sealed' ? 100 : -parseFloat(k.split(' ')[1]) + (k.startsWith('PSA') ? 0 : 0.01);
  const entries = Object.entries(it.ebay.ranges).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  if (!entries.length) { el.innerHTML = '<p class="muted small">No matching eBay listings right now.</p>'; return; }
  const max = Math.max(...entries.map(([, r]) => r.high));
  const pos = v => (v / max * 100).toFixed(1) + '%';
  const mineKey = bucketOf(it);
  el.innerHTML = `<div class="ranges-list">${entries.map(([k, r]) => `
    <div class="range-row ${k === mineKey ? 'mine' : ''}">
      <span class="grade">${esc(k)}</span>
      <div class="bar"><div class="span" style="left:${pos(r.low)};width:calc(${pos(r.high - r.low)} + 2px)"></div>
        <div class="est" style="left:${pos(r.est)}"></div></div>
      <span class="nums">${money(r.low)} – ${money(r.high)}<small>typical ${money(r.est)} · ${r.n} listing${r.n > 1 ? 's' : ''}</small></span>
    </div>`).join('')}</div>
    ${(it.ebay.ranges[mineKey]?.cheapest || []).length ? `<p class="muted small">Cheapest ${esc(mineKey)} listings:</p>
      <ul class="listings">${it.ebay.ranges[mineKey].cheapest.map(l =>
        `<li><a href="${esc(l.u)}" target="_blank" rel="noopener">${money(l.p)}</a> ${esc(l.t)}</li>`).join('')}</ul>` : ''}
    <p class="muted small">Current Buy It Now prices incl. shipping, checked ${fmtDate(toISO(new Date(it.ebay.fetched)))}.
      Asking prices run higher than sales, so "typical" uses the cheaper end of the range.</p>`;
}

$('#ebayRefresh').addEventListener('click', async () => {
  const it = items.find(i => i.id === detailId);
  if (!it) return;
  $('#ebayRanges').innerHTML = '<p class="muted small">Checking eBay…</p>';
  try { await refreshEbay(it); save(); render(); renderDetail(); }
  catch (err) { $('#ebayRanges').innerHTML = `<p class="error">Couldn't check eBay: ${esc(err.message)}</p>`; }
});

const settingsDialog = $('#settingsDialog');
$('#settingsBtn').addEventListener('click', () => {
  $('#workerUrl').value = workerUrl();
  $('#workerStatus').textContent = workerUrl() ? 'Connected.' : 'Not set up yet.';
  settingsDialog.showModal();
});
$('#workerRemove').addEventListener('click', () => {
  localStorage.removeItem(WORKER_KEY);
  $('#workerUrl').value = '';
  $('#workerStatus').textContent = 'Removed.';
});
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  let url = $('#workerUrl').value.trim().replace(/\/+$/, '');
  if (!url) { $('#workerStatus').textContent = 'Paste your worker address first.'; return; }
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  $('#workerStatus').textContent = 'Testing…';
  try {
    const info = await (await fetch(url)).json();
    if (info.service !== 'shelf-value-ebay') throw new Error("that address isn't a Shelf Value worker");
    if (!info.keysSet) throw new Error('the worker is running, but its EBAY_CLIENT_ID / EBAY_CLIENT_SECRET secrets are missing');
    localStorage.setItem(WORKER_KEY, url);
    const test = await workerSearch('pokemon charizard', 'card');
    $('#workerStatus').innerHTML = `<span class="ok">✓ Connected to eBay</span> (test search found ${test.length} listings).`;
    refreshAll();
  } catch (err) {
    $('#workerStatus').textContent = "Couldn't connect: " + err.message;
  }
});

// =====================================================================
// Toast
// =====================================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// =====================================================================
// Sets checklist
// =====================================================================
const BROWSE_KEY = 'shelf-value-browse-set';
let browseSetId = localStorage.getItem(BROWSE_KEY) || '';
let setMode = 'all';
const setCache = new Map();

async function getSet(id) {
  if (!setCache.has(id)) setCache.set(id, getJSON(`${API}/sets/${encodeURIComponent(id)}`).catch(err => { setCache.delete(id); throw err; }));
  return setCache.get(id);
}

function fillBrowseSets() {
  $('#browseSet').innerHTML = '<option value="">Choose a set…</option>' + [...sets].reverse()
    .map(s => `<option value="${esc(s.id)}" ${s.id === browseSetId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

// What you have of each card: collection quantity and whether it's wishlisted.
function holdings() {
  const m = new Map();
  items.forEach(it => {
    if (!it.cardId) return;
    const h = m.get(it.cardId) || { qty: 0, wish: false, ids: [] };
    if (it.list === 'collection') { h.qty += it.qty || 1; h.ids.push(it.id); }
    else h.wish = true;
    m.set(it.cardId, h);
  });
  return m;
}

let setRenderToken = 0;
async function renderSetGrid() {
  const grid = $('#setGrid'), prog = $('#setProgress');
  $$('#setChips button').forEach(b => b.classList.toggle('on', b.dataset.f === setMode));
  if (!browseSetId) {
    prog.innerHTML = '';
    grid.innerHTML = '<p class="note">Pick a set above to see every card in it and check off what you own.</p>';
    return;
  }
  const token = ++setRenderToken;
  if (!grid.querySelector('.tile')) grid.innerHTML = '<p class="note">Loading set…</p>';
  let set;
  try { set = await getSet(browseSetId); }
  catch (err) { grid.innerHTML = `<p class="note">Couldn't load this set (${esc(err.message)}).</p>`; return; }
  if (token !== setRenderToken) return;

  const have = holdings();
  const cards = set.cards || [];
  const ownedCount = cards.filter(c => have.get(c.id)?.qty).length;
  const wishCount = cards.filter(c => have.get(c.id)?.wish).length;
  const value = items.filter(it => it.list === 'collection' && it.cardId && setIdOf(it.cardId) === browseSetId)
    .reduce((a, it) => a + itemStats(it).value, 0);
  const pctOwned = cards.length ? ownedCount / cards.length * 100 : 0;
  prog.innerHTML = `<b>${ownedCount} / ${cards.length}</b> owned (${pctOwned.toFixed(0)}%)
    <div class="meter"><span style="width:${pctOwned}%"></span></div>
    <span class="muted">${wishCount} on wishlist · worth ${money(value)}</span>`;

  const shown = cards.filter(c => {
    const h = have.get(c.id);
    return setMode === 'all' || (setMode === 'owned' && h?.qty) || (setMode === 'missing' && !h?.qty) || (setMode === 'wish' && h?.wish);
  });
  grid.innerHTML = shown.length ? shown.map(c => {
    const h = have.get(c.id);
    const state = h?.qty ? 'owned' : h?.wish ? 'wish' : 'missing';
    const mark = state === 'owned' ? '✓' : state === 'wish' ? '♥' : '';
    return `<div class="tile ${state}" data-card="${esc(c.id)}">
      ${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : '<div class="ph">no image</div>'}
      ${h?.qty > 1 ? `<span class="qty-badge">×${h.qty}</span>` : ''}
      <button class="mark" aria-label="Add ${esc(c.name)}">${mark}</button>
      <b>${esc(c.name)}</b><span>#${esc(c.localId)}</span></div>`;
  }).join('') : `<p class="note">${{ owned: 'You don\'t own any cards from this set yet.', missing: 'You have every card in this set! 🎉', wish: 'No cards from this set on your wishlist.' }[setMode] || ''}</p>`;
}

$('#browseSet').addEventListener('change', e => {
  browseSetId = e.target.value;
  localStorage.setItem(BROWSE_KEY, browseSetId);
  $('#setGrid').innerHTML = '';
  renderSetGrid();
});
$('#setChips').addEventListener('click', e => {
  const b = e.target.closest('[data-f]');
  if (b) { setMode = b.dataset.f; renderSetGrid(); }
});

// The box on each card: choose collection or wishlist.
const pickDialog = $('#pickDialog');
let pickCardId = null;

$('#setGrid').addEventListener('click', e => {
  const tile = e.target.closest('.tile[data-card]');
  if (tile) openPick(tile.dataset.card);
});

async function openPick(cardId) {
  pickCardId = cardId;
  const set = await getSet(setIdOf(cardId)).catch(() => null);
  const brief = set?.cards?.find(c => c.id === cardId) || {};
  const h = holdings().get(cardId) || { qty: 0, wish: false, ids: [] };
  $('#pkImg').hidden = !brief.image;
  if (brief.image) $('#pkImg').src = brief.image + '/low.webp';
  $('#pkName').textContent = brief.name || cardId;
  $('#pkMeta').textContent = [set?.name, brief.localId && `#${brief.localId}`].filter(Boolean).join(' · ');
  $('#pkHave').textContent = [h.qty ? `✓ ${h.qty} in your collection` : '', h.wish ? '♥ On your wishlist' : ''].filter(Boolean).join(' · ');
  $('#pkCollection').innerHTML = h.qty ? '&#10003; Add another copy…' : '&#10003; Add to collection…';
  $('#pkWishlist').innerHTML = h.wish ? '&#9829; Remove from wishlist' : '&#9825; Add to wishlist';
  $('#pkView').hidden = !h.qty;
  pickDialog.showModal();
}

$('#pkCollection').addEventListener('click', () => {
  pickDialog.close();
  openFormWithCard(pickCardId, 'collection');
});
$('#pkWishlist').addEventListener('click', async () => {
  const id = pickCardId;
  pickDialog.close();
  const existing = items.find(i => i.list === 'wishlist' && i.cardId === id);
  if (existing) {
    items = items.filter(i => i !== existing);
    save(); render();
    toast(`Removed ${existing.name} from your wishlist`);
    return;
  }
  try { await quickWishlist(id); }
  catch (err) { toast("Couldn't add it: " + err.message); }
});
$('#pkView').addEventListener('click', () => {
  const h = holdings().get(pickCardId);
  pickDialog.close();
  if (h?.ids[0]) openDetail(h.ids[0]);
});

// One tap: add a card to the wishlist with its first priced version.
async function quickWishlist(cardId) {
  const card = await getCard(cardId);
  const opts = priceOptions(card);
  const opt = opts[0];
  const it = migrate({
    ...cardIdentity(card), kind: 'card', list: 'wishlist', added: today(),
    variant: opt?.key || '', variantName: opt?.label || '', condition: 'Near Mint', qty: 1, prices: [],
  });
  if (opt) { it.tcgId = opt.productId; upsertPrice(it, today(), opt.price, 'TCGplayer market'); }
  items.push(it);
  save(); render();
  toast(`♥ Added ${it.name} to your wishlist${opt ? ` (${money(opt.price)})` : ''}`);
}

// =====================================================================
// Camera scan: read the card's name and number on the phone, then match it
// =====================================================================
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let ocrWorker = null;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load the text reader (are you online?)'));
    document.head.appendChild(s);
  });
}

async function getOcr() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  ocrWorker = await Tesseract.createWorker('eng');
  return ocrWorker;
}

// Shrink the photo, make it grayscale and boost contrast so small print reads better.
async function prepImage(bmp, crop = null, scale = 1, angle = 0) {
  const sx = crop ? crop.x * bmp.width : 0, sy = crop ? crop.y * bmp.height : 0;
  const sw = crop ? crop.w * bmp.width : bmp.width, sh = crop ? crop.h * bmp.height : bmp.height;
  const k = Math.min(1, 1800 / Math.max(sw, sh)) * scale;
  const c = document.createElement('canvas');
  c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  const g = c.getContext('2d');
  if (angle) { // straighten a tilted photo
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2); g.rotate(angle * Math.PI / 180); g.translate(-c.width / 2, -c.height / 2);
  }
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] - lo) * 255 / span; d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(img, 0, 0);
  return c;
}

// Card numbers look like "060/131", "4/102", "TG05/TG30" or "GG01/GG70".
function findNumbers(text) {
  const t = text.replace(/[|\\]/g, '/').replace(/(\d)\s*[Il1]\s*(?=\d{2,3}\b)/g, '$1/');
  const out = [], re = /\b([A-Z]{0,3}\d{1,3})\s*\/\s*([A-Z]{0,3}\d{2,3})\b/gi;
  let m;
  while ((m = re.exec(t))) {
    const local = m[1].toUpperCase().replace(/O/g, '0'), total = m[2].toUpperCase().replace(/O/g, '0');
    if (!out.some(o => o.local === local && o.total === total)) out.push({ local, total });
  }
  return out;
}

const normId = s => String(s).toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
// A number counts only if some set actually has that many cards (or it's a TG/GG-style number).
const plausibleNumber = text => findNumbers(text).some(n =>
  /[A-Z]/.test(n.total) || sets.some(s => s.official === parseInt(n.total, 10)));
const nameWords = n => n.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/)
  .filter(w => w.length >= 3 && !['vmax', 'vstar', 'gx'].includes(w));

async function matchScan(text, nameText = '') {
  const lower = text.toLowerCase();
  const scoreName = name => nameWords(name).reduce((a, w) => a + (lower.includes(w) ? w.length : 0), 0);
  const found = [];
  for (const { local, total } of findNumbers(text)) {
    const totalNum = parseInt(total.replace(/\D/g, ''), 10);
    const prefix = total.replace(/\d/g, '');
    // Sets with that many cards (newest first); Trainer Gallery etc. have their own sub-sets.
    const cand = sets.filter(s => prefix ? true : s.official === totalNum).reverse().slice(0, prefix ? 40 : 15);
    const lists = await Promise.all(cand.map(s => getSet(s.id).catch(() => null)));
    lists.forEach(set => {
      if (!set) return;
      if (prefix && !(set.cards || []).some(c => normId(c.localId).startsWith(prefix))) return;
      const card = (set.cards || []).find(c => normId(c.localId) === normId(local));
      if (card && !found.some(f => f.id === card.id)) found.push({ ...card, setName: set.name, score: 5 + scoreName(card.name) });
    });
  }
  if (found.length) return found.sort((a, b) => b.score - a.score);

  // No readable number: try the most name-like words, starting with the top of the card where the name is.
  const words = [...new Set(((nameText + '\n' + text).match(/[A-Za-z][A-Za-z'’.-]{3,}/g) || []).map(w => w.replace(/[’.]/g, '')))]
    .filter(w => w.length >= 5 || /^[A-Z][a-z]+$/.test(w))
    .filter(w => !/^(basic|stage|evolves|from|weakness|resistance|retreat|pokemon|pokémon|illus|ability|trainer|energy|damage|attach|discard|opponent|this|your|turn)$/i.test(w))
    .slice(0, 5);
  for (const w of words) {
    const cards = await getJSON(`${API}/cards?name=${encodeURIComponent(w)}`).catch(() => []);
    if (cards.length && cards.length < 300) {
      $('#cardQuery').value = w;
      // Use any number fragments that were read (e.g. "006" or "165") to rank the right printing first.
      const digits = new Set((text.match(/\d{1,3}/g) || []).map(d => String(parseInt(d, 10))));
      return cards.map(c => {
        const s = setById.get(setIdOf(c.id));
        const score = (digits.has(String(parseInt(c.localId, 10))) ? 4 : 0) + (s?.official && digits.has(String(s.official)) ? 3 : 0)
          + (c.name.toLowerCase() === w.toLowerCase() ? 1 : 0);
        return { ...c, setName: s?.name || setIdOf(c.id), score: score >= 7 ? score + 5 : score };
      }).sort((a, b) => b.score - a.score || (setOrder.get(setIdOf(b.id)) ?? -1) - (setOrder.get(setIdOf(a.id)) ?? -1)).slice(0, 60);
    }
  }
  return [];
}

function showScanResults(cards, note, warn = '') {
  const box = $('#results');
  box.innerHTML = cards.map((c, i) => `<button type="button" class="result ${i === 0 && (c.score > 5 || cards.length === 1) ? 'best' : ''}" data-card="${esc(c.id)}">
      ${c.image ? `<img src="${esc(c.image)}/low.webp" alt="" loading="lazy">` : '<div class="ph">no image</div>'}
      <b>${esc(c.name)}</b><span>${esc(c.setName)} · #${esc(c.localId)}</span></button>`).join('');
  setScanStatus(note, warn);
}

function setScanStatus(msg, warn = '') {
  const s = $('#scanStatus');
  s.hidden = false;
  s.innerHTML = esc(msg) + (warn ? `<br><span class="scan-warn">⚠ ${esc(warn)}</span>` : '');
}

// How crooked the printed text came out: tilted cards give sloped text lines,
// and a card that isn't flat (phone held at an angle) gives lines with different slopes.
function textTilt(data) {
  const angles = [];
  (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => {
    const bl = l.baseline;
    if (!bl || !bl.has_baseline || bl.x1 - bl.x0 < 80) return;
    angles.push(Math.atan2(bl.y1 - bl.y0, bl.x1 - bl.x0) * 180 / Math.PI);
  })));
  if (angles.length < 3) return null;
  angles.sort((a, b) => a - b);
  const mid = angles[Math.floor(angles.length / 2)];
  const spread = angles[Math.floor(angles.length * 0.85)] - angles[Math.floor(angles.length * 0.15)];
  return { angle: mid, spread };
}

// Read a card image and show matching cards. `cropped` = the image is just the card (from the in-app camera).
async function scanImage(bmp, { cropped = false, tiltAtCapture = null } = {}) {
  $('#results').innerHTML = '';
  try {
    setScanStatus(ocrWorker ? 'Reading the card…' : 'Getting the text reader ready (first time only, a few seconds)…');
    const worker = await getOcr();
    let tilt = null;
    const read = async (crop, scale, angle, withLines = false) => {
      const res = await worker.recognize(await prepImage(bmp, crop, scale, angle), {}, withLines ? { text: true, blocks: true } : { text: true });
      if (withLines) tilt = textTilt(res.data);
      return res.data.text;
    };
    // The number is small and at the bottom of the card. Try a few views until one shows it.
    const passes = cropped ? [
      [null, 1, 0, true],
      [{ x: 0, y: 0.86, w: 1, h: 0.14 }, 2.5, 0],
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, 0],
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, 4],
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, -4],
    ] : [
      [null, 1, 0, true],
      [{ x: 0, y: 0.80, w: 1, h: 0.20 }, 2, 0],
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, 0],
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, 5],
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, -5],
    ];
    let text = '';
    for (let i = 0; i < passes.length; i++) {
      setScanStatus(`Reading the card… (${i + 1}/${passes.length})`);
      text += '\n' + await read(...passes[i]);
      if (plausibleNumber(text)) break;
    }
    const nameText = plausibleNumber(text) ? '' : await read({ x: 0, y: 0, w: 1, h: cropped ? 0.16 : 0.3 }, 1.6, 0);

    // Flatness warning: from the phone's tilt sensor at capture, or from crooked text in the photo.
    let warn = '';
    if (tiltAtCapture != null && tiltAtCapture > 12) warn = 'Your phone wasn\'t flat when you took this. Lay the card on a table and hold your phone straight above it.';
    else if (tilt && (Math.abs(tilt.angle) > 4 || tilt.spread > 4)) warn = 'The card looks tilted or not flat. Lay it on a table, hold your phone straight above it, and line it up with the frame.';

    setScanStatus('Looking up the card…');
    const matches = await matchScan(text, nameText);
    if (!matches.length) {
      setScanStatus("Couldn't read this card. Try again with the card filling the frame, flat and without glare — or type the name above.", warn);
      return;
    }
    const n = findNumbers(text)[0];
    showScanResults(matches, n
      ? `Read card number ${n.local}/${n.total}. Tap the right card to continue.`
      : `Couldn't read the card number, so here are cards named "${$('#cardQuery').value}". Tap the right one.`, warn);
  } catch (err) {
    setScanStatus('Scan failed: ' + err.message);
  }
}

$('#scanInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  scanImage(await createImageBitmap(file));
});

// ---------- In-app camera with a flatness level ----------
const camView = $('#camView'), camVideo = $('#camVideo');
let camStream = null, camTilt = null, camGotMotion = false;

function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  camGotMotion = true;
  $('#camLevel').hidden = false;
  // Lying flat (screen up, camera pointing down at the card) reads beta ≈ 0 and gamma ≈ 0.
  const beta = Math.max(-90, Math.min(90, e.beta)), gamma = e.gamma;
  camTilt = Math.hypot(beta, gamma);
  const clamp = v => Math.max(-1, Math.min(1, v / 20));
  $('#camBubble').style.transform = `translate(${clamp(gamma) * 22}px, ${clamp(beta) * 22}px)`;
  const state = camTilt <= 5 ? 'flat' : camTilt <= 12 ? 'almost' : 'tilted';
  $('#camGuide').className = 'cam-guide ' + state;
  $('#camBubble').style.background = { flat: '#3ad17a', almost: '#f5c242', tilted: '#ff5a5a' }[state];
  const msg = $('#camMsg');
  msg.className = 'cam-msg ' + { flat: 'good', almost: 'meh', tilted: 'bad' }[state];
  msg.textContent = {
    flat: '✓ Flat — line the card up and tap the button',
    almost: 'Almost flat — level your phone a little more',
    tilted: 'Not flat enough — lay the card on a table and hold your phone straight above it',
  }[state];
}

async function openCamera() {
  // iPhone asks for motion access; this must start right inside the tap.
  let motion = Promise.resolve('granted');
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    motion = DeviceOrientationEvent.requestPermission().catch(() => 'denied');
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
  } catch {
    return false;
  }
  camVideo.srcObject = camStream;
  camTilt = null; camGotMotion = false;
  $('#camLevel').hidden = true;
  $('#camGuide').className = 'cam-guide';
  $('#camMsg').className = 'cam-msg';
  $('#camMsg').textContent = 'Line the card up inside the frame';
  camView.showModal();
  camVideo.play().catch(() => {});
  if (await motion === 'granted') window.addEventListener('deviceorientation', onOrient);
  return true;
}

function closeCamera() {
  window.removeEventListener('deviceorientation', onOrient);
  if (camStream) camStream.getTracks().forEach(t => t.stop());
  camStream = null;
  if (camView.open) camView.close();
}
camView.addEventListener('close', closeCamera);
$('#camCancel').addEventListener('click', closeCamera);
$('#camUpload').addEventListener('click', () => { closeCamera(); $('#scanInput').click(); });

// Grab what's inside the card frame (plus a small margin) from the live video.
async function captureCard() {
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  if (!vw || !vh) throw new Error('camera not ready yet');
  const vr = camVideo.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh); // object-fit: cover
  const ox = vr.left + (vr.width - vw * scale) / 2, oy = vr.top + (vr.height - vh * scale) / 2;
  const g = $('#camGuide').getBoundingClientRect();
  const m = 0.04;
  let sx = (g.left - ox) / scale - g.width / scale * m, sy = (g.top - oy) / scale - g.height / scale * m;
  let sw = g.width / scale * (1 + 2 * m), sh = g.height / scale * (1 + 2 * m);
  sx = Math.max(0, sx); sy = Math.max(0, sy); sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(camVideo, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return createImageBitmap(c);
}

$('#camShutter').addEventListener('click', async () => {
  try {
    const bmp = await captureCard();
    const tiltAtCapture = camGotMotion ? camTilt : null;
    closeCamera();
    scanImage(bmp, { cropped: true, tiltAtCapture });
  } catch (err) {
    $('#camMsg').textContent = 'Hold on — ' + err.message;
  }
});

$$('.scanBtn').forEach(b => b.addEventListener('click', () => {
  if (!itemDialog.open) openItemForm(null, view === 'wishlist' ? 'wishlist' : 'collection');
  formKind = 'card'; picked = null; pickedOpts = []; syncForm();
  $('#results').innerHTML = '';
  if (navigator.mediaDevices?.getUserMedia) {
    openCamera().then(ok => {
      if (ok) return;
      setScanStatus("Couldn't open the camera here. ");
      $('#scanStatus').insertAdjacentHTML('beforeend', '<button type="button" id="scanPick" class="small-btn">Choose a photo instead</button>');
    });
  } else {
    $('#scanInput').click(); // must happen right away so the phone allows it
  }
}));
$('#scanStatus').addEventListener('click', e => { if (e.target.id === 'scanPick') $('#scanInput').click(); });

// =====================================================================
// Start
// =====================================================================
render();
updateRefreshStatus();
loadSets().then(() => {
  fillBrowseSets();
  if (view === 'sets') renderSetGrid();
  const last = +localStorage.getItem(REFRESH_KEY);
  if (items.length && Date.now() - last > 12 * 36e5) refreshAll();
});
setInterval(updateRefreshStatus, 60e3);
