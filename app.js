'use strict';

// ---------- storage ----------
const STORE_KEY = 'shelf-value-v1';
let items = load();

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
  catch { return []; }
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(items)); }
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const money = n => (n == null || isNaN(n)) ? '—' :
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const signedMoney = n => (n > 0 ? '+' : '') + money(n);
const pct = n => (n == null || !isFinite(n)) ? '' : ` (${n > 0 ? '+' : ''}${n.toFixed(1)}%)`;
const cls = n => n > 0 ? 'up' : n < 0 ? 'down' : 'muted';
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined,
  { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
const daysSince = d => d ? Math.floor((Date.now() - new Date(d + 'T00:00:00')) / 864e5) : Infinity;

function sortedPrices(item) {
  return [...(item.prices || [])].sort((a, b) => a.date.localeCompare(b.date));
}

// Unit value = most recent logged price, or what you paid if never priced.
function itemStats(item) {
  const ps = sortedPrices(item);
  const last = ps[ps.length - 1];
  const prev = ps[ps.length - 2];
  const qty = item.qty || 1;
  const unit = last ? last.price : (item.paid || 0);
  const value = unit * qty;
  const cost = (item.paid || 0) * qty;
  return {
    unit, value, cost, qty,
    gain: value - cost,
    gainPct: cost ? (value - cost) / cost * 100 : null,
    change: last && prev ? (last.price - prev.price) * qty : null,
    changePct: last && prev && prev.price ? (last.price - prev.price) / prev.price * 100 : null,
    lastDate: last ? last.date : null,
  };
}

// Value of whole collection on each date where anything was priced.
function collectionSeries() {
  const dates = new Set();
  items.forEach(it => {
    (it.prices || []).forEach(p => dates.add(p.date));
    if (it.acquired) dates.add(it.acquired);
  });
  return [...dates].sort().map(date => {
    let total = 0;
    items.forEach(it => {
      if (it.acquired && it.acquired > date) return;
      const ps = sortedPrices(it).filter(p => p.date <= date);
      const unit = ps.length ? ps[ps.length - 1].price : (it.paid || 0);
      total += unit * (it.qty || 1);
    });
    return { date, value: total };
  });
}

// ---------- chart ----------
const tooltip = $('#tooltip');

function renderChart(container, points, emptyMsg) {
  if (points.length < 2) {
    container.innerHTML = `<div class="chart-empty">${esc(emptyMsg)}</div>`;
    return;
  }
  const W = container.clientWidth || 600, H = container.clientHeight || 220;
  const m = { t: 10, r: 12, b: 24, l: 62 };
  const t = points.map(p => new Date(p.date + 'T00:00:00').getTime());
  const v = points.map(p => p.value);
  const t0 = Math.min(...t), t1 = Math.max(...t);
  let lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.1; lo = Math.max(0, lo - pad); hi += pad;
  const x = d => m.l + (d - t0) / (t1 - t0 || 1) * (W - m.l - m.r);
  const y = n => m.t + (1 - (n - lo) / (hi - lo)) * (H - m.t - m.b);

  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const val = lo + (hi - lo) * i / ticks, yy = y(val);
    grid += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>` +
      `<text class="axis" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${money(val).replace(/\.\d\d$/, '')}</text>`;
  }
  const xt = [0, 0.5, 1].map(f => t0 + (t1 - t0) * f);
  const xlab = xt.map((d, i) => `<text class="axis" x="${x(d)}" y="${H - 6}" text-anchor="${['start', 'middle', 'end'][i]}">` +
    new Date(d).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) + '</text>').join('');

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${path}L${x(t1)},${y(lo)}L${x(t0)},${y(lo)}Z`;
  const dots = points.length <= 40
    ? points.map((p, i) => `<circle class="dot" r="2.5" cx="${x(t[i])}" cy="${y(p.value)}"/>`).join('') : '';

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}${xlab}<path class="area" d="${area}"/><path class="line" d="${path}"/>${dots}
    <line class="guide" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
    <circle class="focus" r="4.5" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/></svg>`;

  const svg = $('svg', container), guide = $('.guide', svg), focus = $('.focus', svg);
  svg.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (W / r.width);
    let best = 0;
    t.forEach((d, i) => { if (Math.abs(x(d) - mx) < Math.abs(x(t[best]) - mx)) best = i; });
    const px = x(t[best]), py = y(points[best].value);
    guide.setAttribute('x1', px); guide.setAttribute('x2', px); guide.setAttribute('visibility', 'visible');
    focus.setAttribute('cx', px); focus.setAttribute('cy', py); focus.setAttribute('visibility', 'visible');
    tooltip.hidden = false;
    tooltip.innerHTML = `${fmtDate(points[best].date)} · <b>${money(points[best].value)}</b>`;
    tooltip.style.left = (r.left + px * r.width / W + 12) + 'px';
    tooltip.style.top = (r.top + py * r.height / H - 34) + 'px';
  });
  svg.addEventListener('mouseleave', () => {
    tooltip.hidden = true;
    guide.setAttribute('visibility', 'hidden');
    focus.setAttribute('visibility', 'hidden');
  });
}

// ---------- main view ----------
function statTile(label, value, extraClass = '') {
  return `<div class="stat"><div class="label">${label}</div><div class="value ${extraClass}">${value}</div></div>`;
}

function render() {
  const all = items.map(it => ({ it, s: itemStats(it) }));
  const total = all.reduce((a, r) => a + r.s.value, 0);
  const cost = all.reduce((a, r) => a + r.s.cost, 0);
  const count = all.reduce((a, r) => a + r.s.qty, 0);
  const gain = total - cost;
  $('#stats').innerHTML =
    statTile('Collection value', money(total)) +
    statTile('Total paid', money(cost)) +
    statTile('Gain / loss', signedMoney(gain) + `<small>${pct(cost ? gain / cost * 100 : null)}</small>`, cls(gain)) +
    statTile('Items', count.toLocaleString());

  renderChart($('#totalChart'), collectionSeries(),
    'Log prices on your items over time and the chart will appear here.');

  // platform filter options
  const platforms = [...new Set(items.map(i => i.platform).filter(Boolean))].sort();
  const pf = $('#platformFilter'), current = pf.value;
  pf.innerHTML = '<option value="">All platforms</option>' +
    platforms.map(p => `<option ${p === current ? 'selected' : ''}>${esc(p)}</option>`).join('');
  $('#platformList').innerHTML = platforms.map(p => `<option value="${esc(p)}">`).join('');

  const q = $('#search').value.trim().toLowerCase();
  const plat = pf.value;
  let rows = all.filter(({ it }) =>
    (!plat || it.platform === plat) &&
    (!q || [it.name, it.platform, it.condition, it.notes].join(' ').toLowerCase().includes(q)));

  const sorters = {
    'value-desc': (a, b) => b.s.value - a.s.value,
    'value-asc': (a, b) => a.s.value - b.s.value,
    'name-asc': (a, b) => a.it.name.localeCompare(b.it.name),
    'gain-desc': (a, b) => b.s.gain - a.s.gain,
    'updated-asc': (a, b) => (a.s.lastDate || '').localeCompare(b.s.lastDate || ''),
  };
  rows.sort(sorters[$('#sort').value]);

  $('#itemsTable tbody').innerHTML = rows.map(({ it, s }) => `
    <tr data-id="${it.id}">
      <td class="name">${esc(it.name)}</td>
      <td>${esc(it.platform) || '<span class="muted">—</span>'}</td>
      <td>${esc(it.condition)}</td>
      <td class="num">${s.qty}</td>
      <td class="num">${it.paid ? money(s.cost) : '<span class="muted">—</span>'}</td>
      <td class="num"><b>${money(s.value)}</b></td>
      <td class="num ${cls(s.change)}">${s.change == null ? '<span class="muted">—</span>' : signedMoney(s.change) + pct(s.changePct)}</td>
      <td class="num ${cls(s.gain)}">${it.paid ? signedMoney(s.gain) : '<span class="muted">—</span>'}</td>
      <td class="${daysSince(s.lastDate) > 90 ? 'stale' : ''}">${s.lastDate ? fmtDate(s.lastDate) : 'never'}</td>
    </tr>`).join('');
  $('#empty').hidden = items.length > 0;
}

$('#search').addEventListener('input', render);
$('#platformFilter').addEventListener('change', render);
$('#sort').addEventListener('change', render);
$('#itemsTable tbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { render(); if (detailId) renderDetail(); }, 150);
});

// ---------- dialogs ----------
document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () => b.closest('dialog').close()));

const itemDialog = $('#itemDialog'), itemForm = $('#itemForm');
let editingId = null;

function openItemForm(id = null) {
  editingId = id;
  itemForm.reset();
  const it = id && items.find(i => i.id === id);
  $('#itemDialogTitle').textContent = it ? 'Edit item' : 'Add item';
  $('#startPriceLabel').hidden = !!it;
  if (it) {
    for (const k of ['name', 'platform', 'condition', 'qty', 'paid', 'acquired', 'notes'])
      itemForm.elements[k].value = it[k] ?? '';
  } else {
    itemForm.elements.acquired.value = today();
  }
  itemDialog.showModal();
}

itemForm.addEventListener('submit', e => {
  e.preventDefault();
  const f = itemForm.elements;
  const data = {
    name: f.name.value.trim(),
    platform: f.platform.value.trim(),
    condition: f.condition.value,
    qty: Math.max(1, parseInt(f.qty.value) || 1),
    paid: f.paid.value === '' ? null : parseFloat(f.paid.value),
    acquired: f.acquired.value || null,
    notes: f.notes.value.trim(),
  };
  if (!data.name) return;
  if (editingId) {
    Object.assign(items.find(i => i.id === editingId), data);
  } else {
    const it = { id: uid(), ...data, prices: [] };
    if (f.startPrice.value !== '')
      it.prices.push({ id: uid(), date: today(), price: parseFloat(f.startPrice.value), source: 'Initial' });
    items.push(it);
  }
  save();
  itemDialog.close();
  render();
  if (detailId) renderDetail();
});

$('#addBtn').addEventListener('click', () => openItemForm());

// detail
const detailDialog = $('#detailDialog');
let detailId = null;
detailDialog.addEventListener('close', () => { detailId = null; tooltip.hidden = true; });

function openDetail(id) {
  detailId = id;
  $('#priceForm').reset();
  $('#priceForm').elements.date.value = today();
  detailDialog.showModal();
  renderDetail();
}

function ebayUrl(it) {
  const q = [it.name, it.platform,
    it.condition === 'Complete (CIB)' ? 'complete' : it.condition === 'New / Sealed' ? 'sealed' : ''
  ].filter(Boolean).join(' ');
  return 'https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&_nkw=' + encodeURIComponent(q);
}

function renderDetail() {
  const it = items.find(i => i.id === detailId);
  if (!it) { detailDialog.close(); return; }
  const s = itemStats(it);
  $('#dName').textContent = it.name;
  $('#dMeta').textContent = [it.platform, it.condition, s.qty > 1 ? `Qty ${s.qty}` : '',
    it.acquired ? `Acquired ${fmtDate(it.acquired)}` : '', it.notes].filter(Boolean).join(' · ');
  $('#dStats').innerHTML =
    statTile('Value each', money(s.unit)) +
    statTile('Paid each', it.paid != null ? money(it.paid) : '—') +
    statTile('Gain / loss', it.paid != null ? signedMoney(s.gain) + pct(s.gainPct) : '—', cls(s.gain)) +
    statTile('Last priced', s.lastDate ? fmtDate(s.lastDate) : 'never');
  $('#ebayLink').href = ebayUrl(it);
  const ps = sortedPrices(it);
  requestAnimationFrame(() => renderChart($('#itemChart'),
    ps.map(p => ({ date: p.date, value: p.price })),
    ps.length ? 'Log one more price to see the trend.' : 'No prices logged yet.'));
  $('#priceRows').innerHTML = ps.length ? [...ps].reverse().map(p => `
    <tr><td>${fmtDate(p.date)}</td><td class="num">${money(p.price)}</td>
    <td class="src">${esc(p.source)}</td>
    <td class="num"><button class="del" data-pid="${p.id}" title="Remove">✕</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No prices yet. Check eBay sold listings and log what it sells for.</td></tr>';
}

$('#priceForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target.elements;
  const it = items.find(i => i.id === detailId);
  it.prices = it.prices || [];
  it.prices.push({ id: uid(), date: f.date.value, price: parseFloat(f.price.value), source: f.source.value.trim() });
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
$('#deleteBtn').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  if (!confirm(`Delete "${it.name}" and its price history?`)) return;
  items = items.filter(i => i.id !== detailId);
  save(); detailDialog.close(); render();
});

// ---------- data menu ----------
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
const CSV_COLS = ['name', 'platform', 'condition', 'qty', 'paid', 'acquired', 'notes', 'price_date', 'price', 'price_source'];

function toCSV() {
  const lines = [CSV_COLS.join(',')];
  items.forEach(it => {
    const base = [it.name, it.platform, it.condition, it.qty, it.paid, it.acquired, it.notes];
    const ps = sortedPrices(it);
    if (!ps.length) lines.push([...base, '', '', ''].map(csvCell).join(','));
    ps.forEach(p => lines.push([...base, p.date, p.price, p.source].map(csvCell).join(',')));
  });
  return lines.join('\n');
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
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
    const o = Object.fromEntries(head.map((h, i) => [h, r[i]]));
    if (!o.name) return;
    const key = [o.name, o.platform, o.condition].join('|');
    let it = byKey.get(key);
    if (!it) {
      it = { id: uid(), name: o.name, platform: o.platform || '', condition: o.condition || 'Loose',
        qty: parseInt(o.qty) || 1, paid: o.paid ? parseFloat(o.paid) : null,
        acquired: o.acquired || null, notes: o.notes || '', prices: [] };
      byKey.set(key, it);
    }
    if (o.price_date && o.price)
      it.prices.push({ id: uid(), date: o.price_date, price: parseFloat(o.price), source: o.price_source || '' });
  });
  return [...byKey.values()];
}

$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = file.name.endsWith('.csv') ? parseCSV(text) : JSON.parse(text);
    if (!Array.isArray(incoming)) throw new Error('Expected a list of items');
    const replace = items.length && confirm(
      `Import ${incoming.length} items.\n\nOK = replace your current collection\nCancel = add to it`);
    items = replace ? incoming : items.concat(incoming);
    save(); render();
  } catch (err) {
    alert('Could not import that file: ' + err.message);
  }
});

function demoData() {
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };
  const mk = (name, platform, condition, paid, acq, path) => ({
    id: uid(), name, platform, condition, qty: 1, paid, acquired: d(acq), notes: '',
    prices: path.map(([ago, price]) => ({ id: uid(), date: d(ago), price, source: 'Demo' })),
  });
  return [
    mk('Starfall Saga', 'SNES', 'Complete (CIB)', 85, 400, [[390, 92], [300, 110], [200, 128], [90, 141], [10, 149]]),
    mk('Turbo Kart Rally', 'N64', 'Loose', 22, 380, [[370, 25], [250, 31], [120, 29], [15, 34]]),
    mk('Moonlit Manor', 'PS1', 'Complete (CIB)', 60, 300, [[290, 58], [180, 72], [60, 95], [5, 104]]),
    mk('Pixel Knights II', 'Game Boy', 'Loose', 15, 250, [[240, 14], [100, 12], [30, 13]]),
    mk('Neon Drift', 'Dreamcast', 'New / Sealed', 120, 200, [[190, 135], [95, 160], [20, 152]]),
    mk('Handheld console (teal)', 'Game Boy Color', 'Loose', 45, 150, [[140, 52], [40, 58]]),
  ];
}

dataMenu.addEventListener('click', e => {
  const act = e.target.dataset.act;
  if (act === 'export-json') download(`shelf-value-${today()}.json`, JSON.stringify(items, null, 2), 'application/json');
  if (act === 'export-csv') download(`shelf-value-${today()}.csv`, toCSV(), 'text/csv');
  if (act === 'import') $('#fileInput').click();
  if (act === 'demo') {
    if (items.length && !confirm('Add demo items to your collection?')) return;
    items = items.concat(demoData()); save(); render();
  }
  if (act === 'clear') {
    if (!confirm('Delete your whole collection from this browser? Export a backup first if you want to keep it.')) return;
    items = []; save(); render();
  }
});

render();
