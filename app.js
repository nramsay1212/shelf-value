'use strict';

// =====================================================================
// Storage
// =====================================================================
const STORE_KEY = 'shelf-value-v1';
const SETTINGS_KEY = 'shelf-value-settings';
const REFRESH_KEY = 'shelf-value-last-refresh';
const SETS_KEY = 'shelf-value-sets-v2';
const API = 'https://api.tcgdex.net/v2/en';

const DEFAULT_SETTINGS = { gFee: 25, gExtra: 5, gMin: 30, gP10: 30 };
let settings = { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_KEY, {}) };
let items = readJSON(STORE_KEY, []).map(migrate);

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
// Change tracking for sync: each item gets `updatedAt` when it changes, and deleted
// items leave a "tombstone" (id -> time) so the deletion reaches other devices too.
const TOMB_KEY = 'shelf-value-tombstones';
let tombstones = readJSON(TOMB_KEY, {});
const snapshots = new Map();
const stampOf = it => { const { updatedAt, ...rest } = it; return JSON.stringify(rest); };
function resetSnapshots() { snapshots.clear(); items.forEach(it => snapshots.set(it.id, stampOf(it))); }

function save() {
  const now = Date.now(), ids = new Set();
  let changed = false;
  items.forEach(it => {
    ids.add(it.id);
    const s = stampOf(it);
    if (snapshots.get(it.id) !== s) { it.updatedAt = now; snapshots.set(it.id, s); changed = true; }
  });
  for (const id of [...snapshots.keys()]) {
    if (!ids.has(id)) { snapshots.delete(id); tombstones[id] = now; changed = true; }
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(items));
  localStorage.setItem(TOMB_KEY, JSON.stringify(tombstones));
  if (changed && typeof schedulePush === 'function') schedulePush();
}
resetSnapshots();
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
const isAutoPriced = it => it.kind === 'card' && it.cardId && !isGraded(it) && !isCustomCard(it.cardId);
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
      sets = (await getJSON(`${API}/sets`)).filter(s => !isPocket(s.id)).map(s => ({ id: s.id, name: s.name, official: s.cardCount?.official }));
      localStorage.setItem(SETS_KEY, JSON.stringify({ t: Date.now(), data: sets }));
    } catch { sets = cached?.data || []; }
  }
  sets.forEach((s, i) => { setById.set(s.id, s); setOrder.set(s.id, i); });
  Object.values(CUSTOM_SETS).forEach(s => setById.set(s.id, { id: s.id, name: s.name, official: s.cards.length }));
  const opts = [...sets].reverse().map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#setSelect').innerHTML = '<option value="">Any set</option>' + opts;
  itemForm.elements.sealedSet.innerHTML = '<option value="">None</option>' + opts;
}

const setIdOf = cardId => cardId.slice(0, cardId.lastIndexOf('-'));

// ---- Card pictures ----
// TCGdex first; about 1 in 12 cards has no TCGdex picture, so fall back to the
// Pokémon TCG API's image library (different set names), then a "no image" box.
const PTCG_SETS = {
  'sm3.5': 'sm35', 'sm7.5': 'sm75', 'sm11.5': 'sm115', 'swsh3.5': 'swsh35', 'swsh4.5': 'swsh45', 'swsh4.5sv': 'swsh45sv',
  'swsh12.5': 'swsh12pt5', 'swsh12.5gg': 'swsh12pt5gg', 'cel25cc': 'cel25c', 'sv10.5b': 'zsv10pt5', 'sv10.5w': 'rsv10pt5',
  '2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17',
  '2018sm': 'mcd18', '2019sm': 'mcd19', '2021swsh': 'mcd21', '2022swsh': 'mcd22', '2023sv': 'mcd23', '2024sv': 'mcd24',
};
const ptcgSet = id => PTCG_SETS[id] || id.replace(/\.5/, 'pt5').replace(/^([a-z]+)0+(\d)/, '$1$2');

function cardImageUrls(cardId, image, hi = false) {
  if (isCustomCard(cardId)) return image ? [image] : [];
  const urls = [];
  if (image) urls.push(`${image}/${hi ? 'high' : 'low'}.webp`);
  if (cardId && cardId.includes('-')) {
    const set = ptcgSet(setIdOf(cardId)), local = cardId.slice(cardId.lastIndexOf('-') + 1);
    const nums = [/^\d+$/.test(local) ? String(parseInt(local, 10)) : local,
      local.replace(/^([A-Za-z]+)0+(\d)/, '$1$2'), local.replace(/^(\d+)[ab]$/, '$1')];
    [...new Set(nums)].forEach(n => urls.push(`https://images.pokemontcg.io/${set}/${encodeURIComponent(n)}${hi ? '_hires' : ''}.png`));
  }
  return urls;
}

// <img> that walks through the picture addresses until one loads.
function cardImg(cardId, image, { hi = false, lazy = true, zoom = false } = {}) {
  const urls = cardImageUrls(cardId, image, hi);
  if (!urls.length) return '<div class="ph">no image</div>';
  return `<img src="${esc(urls[0])}" data-alts="${esc(JSON.stringify(urls.slice(1)))}" ${zoom ? `data-zoom="${esc(cardId || '')}" data-img="${esc(image || '')}"` : ''}
    alt="" ${lazy ? 'loading="lazy"' : ''} onerror="nextCardImg(this)">`;
}
window.nextCardImg = el => {
  const alts = JSON.parse(el.dataset.alts || '[]');
  if (alts.length) { el.dataset.alts = JSON.stringify(alts.slice(1)); el.src = alts[0]; return; }
  el.onerror = null;
  if (el.dataset.keep) { el.hidden = true; return; } // fixed slots (detail / picker) just hide
  const ph = document.createElement('div');
  ph.className = 'ph'; ph.textContent = 'no image';
  el.replaceWith(ph);
};
// Point an existing <img> element at a card's picture (with the same fallbacks).
function setCardImg(el, cardId, image, hi = false) {
  const urls = cardImageUrls(cardId, image, hi);
  el.hidden = !urls.length;
  el.dataset.keep = '1';
  el.dataset.zoom = cardId || '';
  el.dataset.img = image || '';
  if (!urls.length) return;
  el.dataset.alts = JSON.stringify(urls.slice(1));
  el.onerror = () => nextCardImg(el);
  el.src = urls[0];
}

// Full-screen picture when you tap a card image.
function openImageViewer(cardId, image) {
  const v = $('#imgView'), img = $('#imgViewImg');
  setCardImg(img, cardId, image, true);
  img.hidden = false;
  v.showModal();
}
document.addEventListener('click', e => {
  if (e.target.closest('#imgView')) { $('#imgView').close(); return; } // tap anywhere to close
  const z = e.target.closest('img[data-zoom]');
  if (!z || (!z.dataset.zoom && !z.dataset.img)) return;
  e.preventDefault(); e.stopPropagation();
  openImageViewer(z.dataset.zoom, z.dataset.img);
}, true);
// Pokémon TCG Pocket (the phone game) sets: A1, A2b, B1a, P-A ... not physical cards.
const isPocket = setId => /^([AB]\d+[a-z]?|P-[AB])$/.test(setId);

// ---------------------------------------------------------------------
// Other collectibles: sets that aren't in the card database, built in here.
// They have no automatic prices or pictures; you enter the value yourself.
const HANAFUDA_NAMES = [
  'Blastoise (January)',
  'Dragonite, Gyarados (January)',
  'Mario Pikachu, Qwilfish (January)',
  'Meowth, Tauros (January)',
  'Moltres (January)',
  'Psyduck (January)',
  'Tropius (January)',
  'Venusaur (January)',
  'Chansey, Lickitung (February)',
  'Charizard (February)',
  'Farfetch’d (February)',
  'Flabébé (February)',
  'Golem, Weezing (February)',
  'Hitmonchan, Hitmonlee (February)',
  'Natu (February)',
  'Vileplume (February)',
  'Articuno (March)',
  'Blastoise (March)',
  'Cherrim (March)',
  'Cherrim, Wartortle (March)',
  'Jigglypuff, Kangaskhan (March)',
  'Luigi Pikachu (March)',
  'Nidoran ♀, Nidoran ♂ (March)',
  'Raticate, Rattata (March)',
  'Aerodactyl (April)',
  'Burmy (April)',
  'Foongus (April)',
  'Greninja (April)',
  'Landorus (April)',
  'Magmar, Pinsir (April)',
  'Ninetales, Persian (April)',
  'Pidgeot, Pidgey (April)',
  'Arbok, Slowpoke (May)',
  'Carnivine, Hoppip (May)',
  'Ditto, Oddish, Psyduck (May)',
  'Goomy, Noibat (May)',
  'Grimer, Porygon (May)',
  'Inkay, Poliwag (May)',
  'Jynx (May)',
  'Serperior (May)',
  'Beautifly (June)',
  'Blaziken (June)',
  'Butterfree, Vileplume (June)',
  'Goldeen, Seaking (June)',
  'Kingler, Venonat, Venusaur (June)',
  'Paras, Parasect (June)',
  'Roselia (June)',
  'Roserade (June)',
  'Arcanine, Primeape (July)',
  'Electabuzz, Scyther (July)',
  'Exeggcute, Rhyhorn (July)',
  'Jirachi, Swampert (July)',
  'Kabuto, Omanyte (July)',
  'Piloswine, Swinub (July)',
  'Sceptile (July)',
  'Squirtle (July)',
  'Clefable, Clefairy, Cubone (August)',
  'Diglett, Dugtrio, Voltorb (August)',
  'Electrode, Geodude, Machamp, Onix (August)',
  'Fearow, Snorlax, Spearow (August)',
  'Ferroseed (August)',
  'Mario Pikachu (August)',
  'Pidgeot, Pidgeotto (August)',
  'Shroomish (August)',
  'Beedrill, Weedle (September)',
  'Dewgong, Lapras (September)',
  'Fennekin (September)',
  'Magnemite, Sandslash (September)',
  'Meganium (September)',
  'Pikachu, Zapdos (September)',
  'Pyroar (September)',
  'Qwilfish (September)',
  'Braixen (October)',
  'Cloyster, Tentacruel (October)',
  'Deerling (October)',
  'Dodrio, Gengar, Seadra (October)',
  'Ponyta, Rapidash (October)',
  'Starmie, Staryu (October)',
  'Typhlosion (October)',
  'Volcarona (October)',
  'Abra, Drowzee, Gastly (November)',
  'Exeggutor, Mr. Mime, Poliwag (November)',
  'Feraligatr (November)',
  'Froakie, Taillow (November)',
  'Jolteon (November)',
  'Luigi Pikachu, Slowpoke (November)',
  'Tangela (November)',
  'Victreebel, Zubat (November)',
  'Bulbasaur, Charmander, Squirtle (December)',
  'Charizard (December)',
  'Eevee, Flareon, Jolteon, Vaporeon (December)',
  'Ho-Oh, Mario Pikachu (December)',
  'Luigi Pikachu (December)',
  'Mario Pikachu (December)',
  'Mew, Mewtwo (December)',
  'Pikachu (December)',
];
const CUSTOM_SETS = {
  hanafuda: {
    id: 'hanafuda', name: 'Pokémon Hanafuda', serie: { name: 'Other collectibles' },
    note: 'Japanese Pokémon hanafuda cards from Nintendo, grouped by month. No automatic prices: enter what yours are worth.',
    cards: HANAFUDA_NAMES.map((name, i) => ({ id: `hanafuda-${String(i + 1).padStart(2, '0')}`, localId: String(i + 1).padStart(2, '0'), name })),
  },
};
Object.values(CUSTOM_SETS).forEach(s => { s.cardCount = { official: s.cards.length, total: s.cards.length }; });
const isCustomCard = cardId => !!cardId && setIdOf(cardId) in CUSTOM_SETS;
const OTHER_ERA = { id: 'other', name: 'Other collectibles', custom: true,
  sets: Object.values(CUSTOM_SETS).map(s => ({ id: s.id, name: s.name, logo: '', official: s.cards.length, total: s.cards.length })) };

// Cards from built-in sets whose name (or set name) has every word you typed.
function customMatches(q) {
  const words = String(q || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const plain = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return Object.values(CUSTOM_SETS).flatMap(s => s.cards.filter(c => {
    const hay = plain(`${c.name} ${s.name} ${s.id}`);
    return words.every(w => hay.includes(w));
  }));
}

// Your own latest value for each card of a built-in set.
function customSetPrices(setId) {
  const out = {};
  items.forEach(it => {
    if (!it.cardId || setIdOf(it.cardId) !== setId || it.list === 'sold') return;
    const last = sortedPrices(it).pop();
    if (last && (out[it.cardId]?.p == null || it.list === 'collection')) out[it.cardId] = { p: last.price, r: '' };
  });
  return out;
}

function customCard(id) {
  const s = CUSTOM_SETS[setIdOf(id)];
  const c = s && s.cards.find(x => x.id === id);
  if (!c) throw new Error('Card not found');
  return { ...c, set: { id: s.id, name: s.name }, rarity: '', pricing: {} };
}

async function getCard(id) {
  if (isCustomCard(id)) return customCard(id);
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
  const jobs = items.filter(it => isAutoPriced(it) && it.list !== 'sold').map(it => () => refreshItem(it));
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
  it.list === 'collection' && it.kind === 'card' && it.condition === 'Near Mint' && !activeSub(it) &&
  itemStats(it).unit >= (settings.gMin || 0));

// =====================================================================
// Main view
// =====================================================================
// A notification tap opens ?view=wishlist
const urlView = new URLSearchParams(location.search).get('view');
let view = ['collection', 'wishlist', 'grading', 'sold'].includes(urlView) ? urlView : 'collection';
// Bottom bar page: Collection, Sets or Settings (the app always opens on Collection)
let page = urlView === 'sets' ? 'sets' : 'collection';
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
  if (page === 'sky' && typeof renderSky === 'function') renderSky();
  const coll = items.filter(i => i.list === 'collection').map(it => ({ it, s: itemStats(it) }));
  const wish = items.filter(i => i.list === 'wishlist').map(it => ({ it, s: itemStats(it) }));
  const total = coll.reduce((a, r) => a + r.s.value, 0);
  const cost = coll.reduce((a, r) => a + r.s.cost, 0);
  const count = coll.reduce((a, r) => a + r.s.qty, 0);
  const gain = total - cost;
  const wishTotal = wish.reduce((a, r) => a + r.s.value, 0);
  const picks = gradingCandidates().filter(it => gradeEval(it).verdict === 'go').length;
  const soldItems = items.filter(i => i.list === 'sold');
  const salesProfit = soldItems.filter(it => it.paid != null).reduce((a, it) => a + saleProfit(it), 0);

  renderHero();
  $('#stats').innerHTML =
    statTile('Total paid', money(cost)) +
    statTile('Gain / loss', signedMoney(gain) + `<small>${pct(cost ? gain / cost * 100 : null)}</small>`, cls(gain)) +
    statTile('Items owned', count.toLocaleString()) +
    statTile('Wishlist cost', money(wishTotal)) +
    statTile('Worth grading', picks ? `${picks} card${picks > 1 ? 's' : ''}` : '—') +
    (soldItems.length ? statTile('Profit from sales', signedMoney(salesProfit), cls(salesProfit)) : '');

  // view tabs with counts
  const atGrader = items.filter(i => i.list === 'collection' && activeSub(i)).length;
  const counts = { collection: coll.length, wishlist: wish.length, grading: gradingCandidates().length + atGrader, sets: '', sold: soldItems.length };
  $$('#viewTabs button').forEach(b => {
    b.classList.toggle('on', b.dataset.view === view);
    b.innerHTML = b.textContent.replace(/\s*\d+$/, '') + `<span class="count">${counts[b.dataset.view]}</span>`;
  });

  // filter dropdowns
  const pokeItems = items.filter(i => i.kind !== 'sky');
  fillSelect($('#categoryFilter'), 'All categories', pokeItems.map(i => i.category));
  fillSelect($('#setFilter'), 'All sets', pokeItems.map(i => i.setName));
  $('#categoryList').innerHTML = [...new Set(pokeItems.map(i => i.category).filter(Boolean))].sort()
    .map(c => `<option value="${esc(c)}">`).join('');

  $('#typeFilter').hidden = view === 'grading';
  $('#sort').hidden = view === 'grading';
  $('#gradingSettings').hidden = view !== 'grading';
  // keep ✓ / ♥ marks in the card search up to date after adding something
  if (typeof csResults !== 'undefined' && csResults.length && !$('#cardSearchResults').hidden) renderCardSearch(csToken);
  // the Sets page keeps its marks and progress up to date too
  if (typeof page !== 'undefined' && page === 'sets') renderSetsView();

  $('#itemsTable').className = 'v-' + view;
  $('#viewExtra').hidden = true;
  if (view === 'grading') renderGrading();
  else if (view === 'sold') renderSold();
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

const thumb = it => it.kind === 'card' && (it.image || it.cardId)
  ? `<td class="thumb">${cardImg(it.cardId, it.image)}</td>`
  : `<td class="thumb"><div class="ph">${it.kind === 'card' ? 'card' : 'box'}</div></td>`;
const nameCell = it => `<td class="name">${esc(it.name)}${it.category ? `<span class="tag">${esc(it.category)}</span>` : ''}${
  it.grading && it.grading.status !== 'done' && it.list === 'collection' ? `<span class="badge grading">At ${esc(it.grading.grader)}</span>` : ''}
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
  // Cards currently at a grading company
  const subs = items.filter(i => i.list === 'collection' && activeSub(i))
    .sort((a, b) => (a.grading.sent || '').localeCompare(b.grading.sent || ''));
  $('#viewExtra').hidden = !subs.length;
  $('#viewExtra').innerHTML = subs.length ? `<h3 class="section-title">📦 At the grader (${subs.length})</h3>
    <div class="table-wrap"><table class="compact subs"><thead><tr><th></th><th>Card</th><th>Grader</th><th>Status</th><th class="num">Days</th><th class="num">Fee</th></tr></thead><tbody>
    ${subs.map(it => {
      const g = it.grading, days = Math.max(0, Math.round((Date.now() - new Date(g.sent + 'T00:00:00')) / 864e5));
      return `<tr data-id="${it.id}">${thumb(it)}${nameCell(it)}<td>${esc(g.grader)}${g.service ? `<small class="muted"> ${esc(g.service)}</small>` : ''}</td>
        <td>${SUB_STATUS[g.status] || g.status}</td><td class="num">${days}</td><td class="num">${g.fee != null ? money(g.fee) : dash}</td></tr>`;
    }).join('')}</tbody></table></div><h3 class="section-title">💡 Grading picks</h3>` : '';
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
$('#viewExtra').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDetail(tr.dataset.id);
});

// =====================================================================
// Add / edit dialog
// =====================================================================
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

const itemDialog = $('#itemDialog'), itemForm = $('#itemForm');
let editingId = null, formList = 'collection', formKind = 'card', picked = null, pickedOpts = [], psaPending = null;

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
    ${picked.image || picked.cardId ? cardImg(picked.cardId, picked.image, { lazy: false, zoom: true }) : '<div class="ph" style="width:80px;height:112px">card</div>'}
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
  picked = null; pickedOpts = []; psaPending = null;
  $('#psaInfo').hidden = true;
  const it = id && items.find(i => i.id === id);
  $('#itemDialogTitle').textContent = it ? 'Edit' : 'Add';
  $('#results').innerHTML = '';
  formList = it ? it.list : list;
  formKind = it ? (it.kind === 'card' ? 'card' : 'sealed') : 'card';
  const f = itemForm.elements;
  if (it) {
    ['condition', 'grader', 'grade', 'cert', 'category', 'qty', 'paid', 'acquired', 'target', 'notes']
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
      cards = (await getJSON(`${API}/cards?name=${encodeURIComponent(q)}`)).filter(c => !isPocket(setIdOf(c.id))).concat(customMatches(q));
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
        ${cardImg(c.id, c.image)}
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
  if (psaPending) applyPsa(psaPending);
  syncForm();
}

// ---------------------------------------------------------------------
// PSA cert lookup: type the number on a PSA slab, the card and grade fill in.
function psaGradeNumber(text) {
  const m = String(text || '').match(/(\d+(?:\.5)?)\s*$/) || String(text || '').match(/(\d+(?:\.5)?)/);
  return m ? m[1] : '';
}

function applyPsa(p) {
  const f = itemForm.elements;
  f.condition.value = 'Graded';
  f.grader.value = 'PSA';
  f.grade.value = psaGradeNumber(p.grade) || p.grade || '';
  f.cert.value = p.cert;
  const v = (p.variety || '').toLowerCase();
  const want = /rev/.test(v) ? 'reverse' : /1st|first/.test(v) ? '1st' : /holo/.test(v) ? 'holo' : '';
  if (want) {
    const opt = [...f.variant.options].find(o => o.value.toLowerCase().includes(want));
    if (opt) f.variant.value = opt.value;
  }
  const pop = p.population != null
    ? ` · PSA population: ${p.population} at this grade${p.populationHigher != null ? `, ${p.populationHigher} higher` : ''}` : '';
  $('#psaInfo').textContent = `PSA says: ${[p.year, p.subject, p.variety, '#' + p.number, p.grade].filter(Boolean).join(' · ')}${pop}`;
  $('#psaInfo').hidden = false;
}

// PSA names look like "FA/CHARIZARD EX" or "PIKACHU-HOLO"; turn that into a searchable name.
function psaCardName(subject) {
  return String(subject || '')
    .replace(/^[A-Z]{1,4}\//, '')
    .replace(/-(REV\.?\s*FOIL|REVERSE\s*HOLO|HOLO|1ST\s*ED.*|FULL\s*ART.*)$/i, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

async function psaLookup() {
  const box = $('#results');
  const cert = $('#psaCert').value.replace(/\D/g, '');
  if (!cert) { box.innerHTML = '<p class="note">Type the cert number from the PSA label.</p>'; return; }
  if (!syncCode()) { box.innerHTML = '<p class="note">PSA lookup needs Back up &amp; sync turned on (Settings tab).</p>'; return; }
  box.innerHTML = '<p class="note">Asking PSA…</p>';
  let p;
  try {
    const r = await fetch(`${syncUrl()}/psa/cert?cert=${cert}`, { headers: { 'X-Sync-Code': syncCode() } });
    p = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(p.error || `error ${r.status}`);
  } catch (err) {
    box.innerHTML = `<p class="note">${esc(err.message)}</p>`;
    return;
  }
  psaPending = p;
  const label = [p.year, p.brand, p.subject, p.variety, '#' + p.number, 'PSA ' + p.grade].filter(Boolean).join(' · ');
  box.innerHTML = `<p class="note">Found: ${esc(label)}. Matching the card…</p>`;

  const name = psaCardName(p.subject);
  const numWant = String(p.number || '').replace(/^0+(?=\w)/, '').toLowerCase();
  let cards = [];
  try { cards = await cardsByName(name); } catch {}
  if (!cards.length && name.includes(' ')) {
    try { cards = await cardsByName(name.split(' ')[0]); } catch {}
  }
  const sameNum = c => String(c.localId).replace(/^0+(?=\w)/, '').toLowerCase() === numWant;
  let hits = numWant ? cards.filter(sameNum) : cards;
  // Rank by how many words of PSA's set name show up in our set name.
  const brandWords = String(p.brand || '').toLowerCase().replace(/pokemon|japanese|&/g, ' ').split(/\W+/).filter(w => w.length > 2);
  const score = c => {
    const s = (setById.get(setIdOf(c.id))?.name || '').toLowerCase();
    return brandWords.filter(w => s.includes(w)).length;
  };
  hits = [...hits].sort((a, b) => score(b) - score(a));
  const best = hits[0];
  if (best && (hits.length === 1 || score(best) > score(hits[1]))) {
    try { await selectCard(best.id); box.innerHTML = ''; return; } catch {}
  }
  const list = (hits.length ? hits : sortCards(cards)).slice(0, 60);
  box.innerHTML = `<p class="note">Found: ${esc(label)}. ${list.length ? 'Tap the matching card:' : "Couldn't match it automatically. Search for the card above; the grade and cert will still fill in."}</p>` +
    list.map(c => {
      const s = setById.get(setIdOf(c.id));
      return `<button type="button" class="result" data-card="${esc(c.id)}">
        ${cardImg(c.id, c.image)}
        <b>${esc(c.name)}</b><span>${esc(s ? s.name : setIdOf(c.id))} · #${esc(c.localId)}</span></button>`;
    }).join('');
}
$('#psaLookup').addEventListener('click', psaLookup);
$('#psaCert').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); psaLookup(); } });

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
      cert: f.condition.value === 'Graded' ? f.cert.value.replace(/\D/g, '') : '',
    };
    if (psaPending && data.cert === psaPending.cert && data.grader === 'PSA') {
      data.psaPop = psaPending.population; data.psaPopHigher = psaPending.populationHigher;
    }
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
  if (it.list !== view && view !== 'grading' && page !== 'sets') view = it.list;
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
  if (isCustomCard(it.cardId)) return `pokemon ${setIdOf(it.cardId)} ${it.name.replace(/[(),]/g, ' ')}`.replace(/\s+/g, ' ').trim();
  return it.kind === 'card' ? [it.name, it.number].filter(Boolean).join(' ') : [it.setName, it.name].filter(Boolean).join(' ');
}

function renderDetail() {
  const it = items.find(i => i.id === detailId);
  if (!it) { detailDialog.close(); return; }
  const s = itemStats(it);
  setCardImg($('#dImg'), it.kind === 'card' ? it.cardId : '', it.image, true);
  $('#dName').textContent = it.name;
  $('#dMeta').textContent = [it.setName, it.number && '#' + it.number, it.rarity, versionText(it),
    it.category && `Category: ${it.category}`, s.qty > 1 && `Qty ${s.qty}`,
    it.acquired && `Acquired ${fmtDate(it.acquired)}`, it.cert && `Cert #${it.cert}`,
    it.psaPop != null && `PSA pop: ${it.psaPop} at this grade` + (it.psaPopHigher != null ? `, ${it.psaPopHigher} higher` : ''),
    it.notes].filter(Boolean).join(' · ');

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
  const inColl = it.list === 'collection';
  $('#sellBtn').hidden = !inColl;
  $('#gradeSendBtn').hidden = !(inColl && it.kind === 'card' && !isGraded(it) && !activeSub(it));
  $('#unsellBtn').hidden = it.list !== 'sold';
  $('#editBtn').hidden = it.list === 'sold';
  renderSubBox(it);
  renderSaleBox(it);

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
  const showGrade = it.list === 'collection' && it.kind === 'card' && !isGraded(it) && !activeSub(it);
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
    if (!confirm('Delete your whole collection and wishlist? If sync is on, this also deletes it from your other devices and the cloud. Export a backup first if you want to keep it.')) return;
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
const ebayTargets = () => items.filter(it => it.list !== 'sold' && it.kind !== 'sky' && (
  it.kind !== 'card' || isGraded(it) ||
  (it.list === 'collection' && it.condition === 'Near Mint' && itemStats(it).unit >= (settings.gMin || 0))));

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

function fillWorkerSetting() {
  $('#workerUrl').value = workerUrl();
  $('#workerStatus').textContent = workerUrl() ? 'Connected.' : 'Not set up yet.';
}
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
// Sets: browse every set by era, open one to see its cards with prices
// =====================================================================
const ERAS_KEY = 'shelf-value-eras-v2';
const SET_PRICES_KEY = 'shelf-value-setprices-';
let browseSetId = '';          // '' = the list of all sets
let setMode = 'all';
let eras = [];                 // [{ id, name, sets: [{ id, name, logo, official, total }] }] newest first
const setCache = new Map();

async function getSet(id) {
  if (CUSTOM_SETS[id]) return CUSTOM_SETS[id];
  if (!setCache.has(id)) setCache.set(id, getJSON(`${API}/sets/${encodeURIComponent(id)}`).catch(err => { setCache.delete(id); throw err; }));
  return setCache.get(id);
}

async function loadEras() {
  const cached = readJSON(ERAS_KEY, null);
  if (cached && Date.now() - cached.t < 3 * 864e5) { eras = cached.data; return; }
  try {
    // Skip Pokémon TCG Pocket: it's the phone game, not physical cards.
    const list = (await getJSON(`${API}/series`)).filter(s => s.id !== 'tcgp');
    const details = await Promise.all(list.map(s => getJSON(`${API}/series/${encodeURIComponent(s.id)}`).catch(() => null)));
    eras = details.filter(Boolean).map(d => ({
      id: d.id, name: d.name, release: d.releaseDate || '',
      sets: (d.sets || []).map(s => ({ id: s.id, name: s.name, logo: s.logo || '', official: s.cardCount?.official, total: s.cardCount?.total })),
    })).filter(e => e.sets.length)
      .sort((a, b) => (b.release || '').localeCompare(a.release || ''));
    localStorage.setItem(ERAS_KEY, JSON.stringify({ t: Date.now(), data: eras }));
  } catch {
    // Fall back to one flat list from the sets we already have.
    eras = cached?.data || [{ id: 'all', name: 'All sets', sets: [...sets].reverse().map(s => ({ id: s.id, name: s.name, official: s.official })) }];
  }
}

// Kept for the code that runs at start-up.
function fillBrowseSets() { if (page === 'sets') renderSetsView(); }

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

function renderSetsView() {
  $('#setList').hidden = !!browseSetId;
  $('#setDetail').hidden = !browseSetId;
  if (browseSetId) renderSetGrid(); else renderSetList();
}

async function renderSetList() {
  const body = $('#setListBody');
  if (!eras.length) { body.innerHTML = '<p class="empty">Loading sets…</p>'; await loadEras(); }
  const q = $('#setSearch').value.trim().toLowerCase();
  const mineOnly = $('#setMineOnly').checked;
  // How many different cards you own per set
  const ownedPerSet = new Map();
  holdings().forEach((h, cardId) => { if (h.qty) { const s = setIdOf(cardId); ownedPerSet.set(s, (ownedPerSet.get(s) || 0) + 1); } });
  // Which eras are open: what you chose before, else the newest era and any era you collect from.
  const saved = readJSON(ERA_OPEN_KEY, null);
  const html = [...eras, OTHER_ERA].map((e, i) => {
    const list = [...e.sets].reverse().filter(s =>
      (!q || s.name.toLowerCase().includes(q) || e.name.toLowerCase().includes(q) || s.id.toLowerCase() === q) &&
      (!mineOnly || ownedPerSet.get(s.id)));
    if (!list.length) return '';
    const ownedSets = e.sets.filter(s => ownedPerSet.get(s.id)).length;
    const open = q || mineOnly ? true : saved ? !!saved[e.id] : (i === 0 || ownedSets > 0);
    return `<details class="era-group" data-era="${esc(e.id)}" ${open ? 'open' : ''}>
      <summary class="era"><span class="chev">▸</span><h3>${esc(e.name)}</h3>
        <span class="muted small">${list.length} set${list.length > 1 ? 's' : ''}${ownedSets ? ` · collecting ${ownedSets}` : ''}</span></summary>
      <div class="set-cards">${list.map(s => {
        const own = ownedPerSet.get(s.id) || 0, tot = s.total || s.official || 0;
        return `<button class="set-card" data-set="${esc(s.id)}">
          ${s.logo ? `<img src="${esc(s.logo)}.webp" alt="" loading="lazy">` : '<span class="nologo">no logo</span>'}
          <span><b>${esc(s.name)}</b><small>${tot ? `${tot} cards` : ''}${own ? ` · ${own} owned` : ''}</small>
          ${own && tot ? `<div class="mini"><span style="width:${Math.min(100, own / tot * 100)}%"></span></div>` : ''}</span>
        </button>`;
      }).join('')}</div></details>`;
  }).join('');
  body.innerHTML = html
    ? `<div class="era-tools"><button type="button" class="small-btn" data-eras="open">Open all</button>
        <button type="button" class="small-btn" data-eras="close">Close all</button></div>` + html
    : `<p class="empty">${mineOnly ? 'You don\'t own cards from any matching set yet.' : 'No sets match that search.'}</p>`;
}

// Remember which eras you open or close (not while searching, when everything matching opens).
const ERA_OPEN_KEY = 'shelf-value-eras-open';
function saveEraState() {
  if ($('#setSearch').value.trim() || $('#setMineOnly').checked) return;
  const state = {};
  $$('#setListBody details[data-era]').forEach(d => { state[d.dataset.era] = d.open; });
  localStorage.setItem(ERA_OPEN_KEY, JSON.stringify(state));
}
$('#setListBody').addEventListener('toggle', saveEraState, true);
$('#setListBody').addEventListener('click', e => {
  const b = e.target.closest('[data-eras]');
  if (!b) return;
  $$('#setListBody details[data-era]').forEach(d => { d.open = b.dataset.eras === 'open'; });
  saveEraState();
});

$('#setSearch').addEventListener('input', () => renderSetList());
$('#setMineOnly').addEventListener('change', () => renderSetList());
$('#setListBody').addEventListener('click', e => {
  const b = e.target.closest('[data-set]');
  if (!b) return;
  openSet(b.dataset.set);
});
$('#setBack').addEventListener('click', () => {
  browseSetId = '';
  renderSetsView();
  window.scrollTo({ top: 0 });
});

function openSet(id) {
  browseSetId = id;
  setMode = 'all';
  $('#setCardSearch').value = '';
  $('#setGrid').innerHTML = '';
  renderSetsView();
  window.scrollTo({ top: 0 });
  loadSetPrices(id);
}

// ---- prices for every card in a set (cached for a day) ----
const setPrices = new Map(); // setId -> { t, prices: { cardId: { p, r } } }
let pricesLoading = null;

async function loadSetPrices(id) {
  if (CUSTOM_SETS[id]) { renderSetGrid(); return; }
  let entry = setPrices.get(id) || readJSON(SET_PRICES_KEY + id, null);
  if (entry && Date.now() - entry.t < 864e5) { setPrices.set(id, entry); renderSetGrid(); return; }
  if (pricesLoading === id) return;
  pricesLoading = id;
  entry = { t: Date.now(), prices: entry?.prices || {} };
  setPrices.set(id, entry);
  let set;
  try { set = await getSet(id); } catch { pricesLoading = null; return; }
  const queue = [...(set.cards || [])];
  let done = 0;
  const status = $('#setPriceStatus');
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      try {
        const card = await getCard(c.id);
        const opt = priceOptions(card)[0];
        entry.prices[c.id] = { p: opt ? opt.price : null, r: card.rarity || '' };
      } catch { /* skip */ }
      done++;
      if (browseSetId === id) {
        status.textContent = `Loading prices… ${done} / ${set.cards.length}`;
        if (done % 25 === 0) renderSetGrid();
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  try { localStorage.setItem(SET_PRICES_KEY + id, JSON.stringify(entry)); } catch { /* storage full: keep in memory */ }
  pricesLoading = null;
  if (browseSetId === id) { status.textContent = ''; renderSetGrid(); }
}

// Rarest last; compared in lowercase because the database mixes capitalisation.
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'holo rare', 'rare holo', 'shiny rare', 'double rare', 'holo rare v',
  'rare holo v', 'holo rare vmax', 'rare holo vmax', 'holo rare vstar', 'rare holo vstar', 'ace spec rare', 'radiant rare',
  'amazing rare', 'ultra rare', 'shiny ultra rare', 'illustration rare', 'rare rainbow', 'secret rare', 'rare secret',
  'special illustration rare', 'hyper rare', 'mega hyper rare'];
const rarityRank = r => { const i = RARITY_ORDER.indexOf(String(r || '').toLowerCase()); return i < 0 ? (r ? 8 : -1) : i; };

let setRenderToken = 0;
async function renderSetGrid() {
  if (!browseSetId) return;
  const grid = $('#setGrid'), prog = $('#setProgress');
  $$('#setChips button').forEach(b => b.classList.toggle('on', b.dataset.f === setMode));
  const token = ++setRenderToken;
  if (!grid.querySelector('.tile')) grid.innerHTML = '<p class="note">Loading set…</p>';
  let set;
  try { set = await getSet(browseSetId); }
  catch (err) { grid.innerHTML = `<p class="note">Couldn't load this set (${esc(err.message)}).</p>`; return; }
  if (token !== setRenderToken) return;

  $('#setLogo').hidden = !set.logo;
  if (set.logo) $('#setLogo').src = set.logo + '.webp';
  $('#setTitle').textContent = set.name;
  $('#setSub').textContent = [set.serie?.name, set.releaseDate && `Released ${fmtDate(set.releaseDate)}`,
    `${set.cardCount?.official || ''} cards${set.cardCount?.total > set.cardCount?.official ? ` + ${set.cardCount.total - set.cardCount.official} secret` : ''}`]
    .filter(Boolean).join(' · ') + (set.note ? `. ${set.note}` : '');

  const have = holdings();
  const cards = set.cards || [];
  // Built-in sets have no market prices: show the value you entered for each card you own.
  const priceInfo = CUSTOM_SETS[browseSetId] ? customSetPrices(browseSetId) : (setPrices.get(browseSetId)?.prices || {});
  const ownedCount = cards.filter(c => have.get(c.id)?.qty).length;
  const wishCount = cards.filter(c => have.get(c.id)?.wish).length;
  const value = items.filter(it => it.list === 'collection' && it.cardId && setIdOf(it.cardId) === browseSetId)
    .reduce((a, it) => a + itemStats(it).value, 0);
  const setTotal = CUSTOM_SETS[browseSetId] ? 0 : cards.reduce((a, c) => a + (priceInfo[c.id]?.p || 0), 0);
  const pctOwned = cards.length ? ownedCount / cards.length * 100 : 0;
  prog.innerHTML = `<b>${ownedCount} / ${cards.length}</b> owned (${pctOwned.toFixed(0)}%)
    <div class="meter"><span style="width:${pctOwned}%"></span></div>
    <span class="muted">${wishCount} on wishlist · yours worth ${money(value)}${setTotal ? ` · full set ≈ ${money(setTotal)}` : ''}</span>`;

  const q = $('#setCardSearch').value.trim().toLowerCase();
  const shown = cards.filter(c => {
    const h = have.get(c.id);
    return (setMode === 'all' || (setMode === 'owned' && h?.qty) || (setMode === 'missing' && !h?.qty) || (setMode === 'wish' && h?.wish)) &&
      (!q || c.name.toLowerCase().includes(q) || c.localId.toLowerCase() === q.replace(/^#/, ''));
  });
  const price = c => priceInfo[c.id]?.p;
  const sort = $('#setSort').value;
  const byNum = (a, b) => (parseInt(a.localId, 10) || 0) - (parseInt(b.localId, 10) || 0) || a.localId.localeCompare(b.localId);
  shown.sort({
    num: byNum,
    'price-desc': (a, b) => (price(b) ?? -1) - (price(a) ?? -1) || byNum(a, b),
    'price-asc': (a, b) => (price(a) ?? Infinity) - (price(b) ?? Infinity) || byNum(a, b),
    name: (a, b) => a.name.localeCompare(b.name) || byNum(a, b),
    rarity: (a, b) => rarityRank(priceInfo[b.id]?.r) - rarityRank(priceInfo[a.id]?.r) || byNum(a, b),
  }[sort]);

  grid.innerHTML = shown.length ? shown.map(c => {
    const h = have.get(c.id);
    const state = h?.qty ? 'owned' : h?.wish ? 'wish' : 'missing';
    const mark = state === 'owned' ? '✓' : state === 'wish' ? '♥' : '';
    const p = price(c), r = priceInfo[c.id]?.r;
    return `<div class="tile ${state}" data-card="${esc(c.id)}">
      ${cardImg(c.id, c.image)}
      ${h?.qty > 1 ? `<span class="qty-badge">×${h.qty}</span>` : ''}
      <button class="mark" aria-label="Add ${esc(c.name)}">${mark}</button>
      <b>${esc(c.name)}</b><span>#${esc(c.localId)}${r ? ` · ${esc(r)}` : ''}</span>
      <span class="price">${p != null ? money(p) : (c.id in priceInfo ? '—' : '')}</span></div>`;
  }).join('') : `<p class="note">${{ owned: 'You don\'t own any cards from this set yet.', missing: 'You have every card in this set! 🎉', wish: 'No cards from this set on your wishlist.' }[setMode] || 'No cards match that search.'}</p>`;
}

$('#setChips').addEventListener('click', e => {
  const b = e.target.closest('[data-f]');
  if (b) { setMode = b.dataset.f; renderSetGrid(); }
});
$('#setSort').addEventListener('change', () => renderSetGrid());
$('#setCardSearch').addEventListener('input', () => renderSetGrid());

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
  setCardImg($('#pkImg'), cardId, brief.image);
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
async function prepImage(bmp, crop = null, scale = 1, angle = 0, bin = false) {
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
  if (bin) {
    // Local (adaptive) threshold: each pixel vs the average around it. Beats uneven glare and foil shine.
    const W = c.width, H = c.height, r = Math.max(8, Math.round(Math.min(W, H) / 12));
    const sum = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      for (let x = 0; x < W; x++) { row += d[(y * W + x) * 4]; sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row; }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      const mean = (sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const i = (y * W + x) * 4, v = d[i] < mean - 12 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
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

// Small edit distance, for names the text reader gets slightly wrong ("Clobbop us", "Cl0bbopus").
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const SKIP_WORDS = /^(basic|stage|evolves|from|weakness|resistance|retreat|pokemon|pokémon|illus|ability|trainer|energy|damage|attach|discard|opponent|this|your|turn|each|card|cards|that|then|does|more|have|with|into|until|during|pokemon's)$/i;

// Match what was read to real cards. Every candidate is checked two ways — the printed number
// AND the card name — so a misread number (shiny reverse holos!) can't beat a name that clearly matches.
async function matchScan(text, nameText = '') {
  const all = nameText + '\n' + text;
  const tokens = [...new Set((all.toLowerCase().replace(/0/g, 'o').match(/[a-zé][a-zé'’]{2,}/g) || []))];
  const hitCache = new Map();
  const wordHit = w => {
    if (!hitCache.has(w)) {
      const max = w.length >= 7 ? 2 : w.length >= 4 ? 1 : 0;
      hitCache.set(w, tokens.includes(w) ? 1 : tokens.some(t => editDistance(t, w, max) <= max) ? 0.8 : 0);
    }
    return hitCache.get(w);
  };
  const nameScore = name => nameWords(name).reduce((a, w) => a + w.length * wordHit(w.replace(/0/g, 'o')), 0);
  const digits = new Set((text.match(/\d{1,3}/g) || []).map(d => String(parseInt(d, 10))));
  // Partly-read numbers ("12" for 112) still count for something.
  const readLocals = findNumbers(text).map(n => String(parseInt(n.local.replace(/\D/g, ''), 10))).filter(l => l.length >= 2);
  const nearNumber = localId => { const v = String(parseInt(localId, 10)); return readLocals.some(l => v.includes(l) || l.includes(v)) ? 2 : 0; };
  const byId = new Map();
  const add = (card, setName, numScore) => {
    const ns = nameScore(card.name);
    const score = numScore + ns * 1.5;
    const prev = byId.get(card.id);
    if (!prev || prev.score < score) byId.set(card.id, { ...card, setName, score, nameOk: ns >= 4, numOk: numScore >= 7 });
  };

  // 1) By number: sets with that many cards, then the card at that number — and any card in those sets whose name was read.
  for (const { local, total } of findNumbers(text)) {
    const totalNum = parseInt(total.replace(/\D/g, ''), 10);
    const prefix = total.replace(/\d/g, '');
    const cand = sets.filter(s => prefix ? true : s.official === totalNum).reverse().slice(0, prefix ? 40 : 15);
    const lists = await Promise.all(cand.map(s => getSet(s.id).catch(() => null)));
    lists.forEach(set => {
      if (!set) return;
      if (prefix && !(set.cards || []).some(c => normId(c.localId).startsWith(prefix))) return;
      (set.cards || []).forEach(c => {
        if (normId(c.localId) === normId(local)) add(c, set.name, 7);
        else if (nameScore(c.name) >= 4) add(c, set.name, 2 + (digits.has(String(parseInt(c.localId, 10))) ? 3 : nearNumber(c.localId)));
      });
    });
  }

  // 2) By name, if nothing so far has a matching name: search the card's name and use number fragments to pick the printing.
  const top = [...byId.values()].sort((a, b) => b.score - a.score)[0];
  if (!top || !top.nameOk) {
    const words = [...new Set((all.match(/[A-Za-z][A-Za-z'’.-]{3,}/g) || []).map(w => w.replace(/[’.]/g, '')))]
      .filter(w => (w.length >= 5 || /^[A-Z][a-z]+$/.test(w)) && !SKIP_WORDS.test(w))
      .slice(0, 6);
    for (const w of words) {
      const cards = (await getJSON(`${API}/cards?name=${encodeURIComponent(w)}`).catch(() => [])).filter(c => !isPocket(setIdOf(c.id)));
      if (!cards.length || cards.length >= 300) continue;
      $('#cardQuery').value = w;
      cards.forEach(c => {
        const s = setById.get(setIdOf(c.id));
        const num = (digits.has(String(parseInt(c.localId, 10))) ? 4 : nearNumber(c.localId)) + (s?.official && digits.has(String(s.official)) ? 3 : 0);
        add(c, s?.name || setIdOf(c.id), num);
      });
      break;
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || (setOrder.get(setIdOf(b.id)) ?? -1) - (setOrder.get(setIdOf(a.id)) ?? -1))
    .slice(0, 60)
    .map((c, i, arr) => ({ ...c, best: i === 0 && c.nameOk && (c.numOk || c.score >= 14) && (arr.length === 1 || c.score - arr[1].score >= 3) }));
}

function showScanResults(cards, note, warn = '', again = true) {
  const box = $('#results');
  box.innerHTML = cards.map(c => `<button type="button" class="result ${c.best ? 'best' : ''}" data-card="${esc(c.id)}">
      ${cardImg(c.id, c.image)}
      <b>${esc(c.name)}</b><span>${esc(c.setName)} · #${esc(c.localId)}</span></button>`).join('');
  setScanStatus(note, warn, again);
}

function setScanStatus(msg, warn = '', again = false) {
  const s = $('#scanStatus');
  s.hidden = false;
  s.innerHTML = esc(msg) + (warn ? `<br><span class="scan-warn">⚠ ${esc(warn)}</span>` : '')
    + (again ? ' <button type="button" id="scanAgain" class="small-btn">&#128247; Scan again</button>' : '');
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
// Read one card image and return the matching cards (best first). Used by single and rapid scans.
async function identifyCard(bmp, { cropped = false, onProgress = () => {} } = {}) {
    const worker = await getOcr();
    let tilt = null;
    const read = async (crop, scale, angle, withLines = false, bin = false) => {
      const res = await worker.recognize(await prepImage(bmp, crop, scale, angle, bin), {}, withLines ? { text: true, blocks: true } : { text: true });
      if (withLines) tilt = textTilt(res.data);
      return res.data.text;
    };
    // The number is small and at the bottom of the card. Try a few views until one shows it.
    const passes = cropped ? [
      [null, 1, 0, true],
      [{ x: 0, y: 0.86, w: 1, h: 0.14 }, 2.5, 0],
      [{ x: 0, y: 0.86, w: 1, h: 0.14 }, 2.5, 0, false, true], // glare-resistant
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, 0],
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, 4],
      [{ x: 0, y: 0.72, w: 1, h: 0.28 }, 2, -4],
    ] : [
      [null, 1, 0, true],
      [{ x: 0, y: 0.80, w: 1, h: 0.20 }, 2, 0],
      [{ x: 0, y: 0.80, w: 1, h: 0.20 }, 2, 0, false, true], // glare-resistant
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, 0],
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, 5],
      [{ x: 0, y: 0.45, w: 1, h: 0.55 }, 1.6, -5],
    ];
    // Read the name area too (top of the card) — used to double-check the number.
    const namePass = [{ x: 0, y: 0, w: 1, h: cropped ? 0.16 : 0.3 }, 1.6, 0];
    let text = '';
    for (let i = 0; i < passes.length; i++) {
      onProgress(i + 1, passes.length);
      text += '\n' + await read(...passes[i]);
      // Stop early only when the number points at a real card and that card's name was read too.
      if (plausibleNumber(text) && (await matchScan(text)).some(m => m.best)) break;
    }
    const nameText = await read(...namePass) + '\n' + await read(...namePass.slice(0, 3), false, true);
    return { matches: await matchScan(text, nameText), text, tilt };
}

async function scanImage(bmp, { cropped = false, tiltAtCapture = null } = {}) {
  $('#results').innerHTML = '';
  try {
    setScanStatus(ocrWorker ? 'Reading the card…' : 'Getting the text reader ready (first time only, a few seconds)…');
    const { matches, text, tilt } = await identifyCard(bmp, { cropped, onProgress: (i, n) => setScanStatus(`Reading the card… (${i}/${n})`) });

    // Flatness warning: from the phone's tilt sensor at capture, or from crooked text in the photo.
    let warn = '';
    if (tiltAtCapture != null && tiltAtCapture > 12) warn = 'Your phone wasn\'t flat when you took this. Lay the card on a table and hold your phone straight above it.';
    else if (tilt && (Math.abs(tilt.angle) > 4 || tilt.spread > 4)) warn = 'The card looks tilted or not flat. Lay it on a table, hold your phone straight above it, and line it up with the frame.';
    setScanStatus('Looking up the card…');
    if (!matches.length) {
      setScanStatus("Couldn't read this card. Try again with the card filling the frame, flat and without glare — or type the name above.", warn, true);
      return;
    }
    const best = matches[0];
    const n = findNumbers(text).find(x => normId(x.local) === normId(best.localId)) || findNumbers(text)[0];
    const note = best.best
      ? `Found it: ${best.name} #${best.localId}. Tap it to continue.`
      : n
        ? `Not sure about this one — the number read as ${n.local}/${n.total}. Check the card below is right, or scan again.`
        : `Not sure about this one — couldn't read the card number. Pick the right "${$('#cardQuery').value}" below, or scan again.`;
    showScanResults(matches, note, warn || (best.best ? '' : 'Shiny cards (reverse holos especially) are harder to read — tilt the card slightly away from the light to cut the glare.'));
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
  if (rapid.active) {
    rapid.active = false;
    $('#camCount').hidden = true;
    $('#camUpload').hidden = false;
    $('#camCancel').textContent = 'Cancel';
    if (rapid.results.length) openBatch();
  }
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
    if (rapid.active) return rapidCaptured(bmp); // keep the camera open for the next card
    const tiltAtCapture = camGotMotion ? camTilt : null;
    closeCamera();
    scanImage(bmp, { cropped: true, tiltAtCapture });
  } catch (err) {
    $('#camMsg').textContent = 'Hold on — ' + err.message;
  }
});

$$('.scanBtn').forEach(b => b.addEventListener('click', startScan));
function startScan() {
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
}
$('#scanStatus').addEventListener('click', e => {
  if (e.target.id === 'scanPick') $('#scanInput').click();
  if (e.target.id === 'scanAgain') startScan();
});

// =====================================================================
// Cloud backup & sync (your own Cloudflare worker; see worker/ebay-worker.js)
// =====================================================================
const SYNC_DEFAULT_URL = 'https://shelf-value-ebay.nramsay1212.workers.dev';
const SYNC_CODE_KEY = 'shelf-value-sync-code';
const SYNC_REV_KEY = 'shelf-value-sync-rev';
const SYNC_AT_KEY = 'shelf-value-sync-at';
const syncUrl = () => workerUrl() || SYNC_DEFAULT_URL;
const syncCode = () => localStorage.getItem(SYNC_CODE_KEY) || '';
let syncRev = +localStorage.getItem(SYNC_REV_KEY) || 0;
let syncBusy = false, syncAgain = false, pushTimer = null, syncError = '';

const SYNC_WORDS = ('amber anchor apple arrow aspen autumn badger bamboo basil beacon berry birch blaze bloom bluebird bramble breeze brook cactus candle canyon cedar cherry cinder clover cobalt comet copper coral cosmos cotton crimson crystal daisy dawn delta dune echo ember falcon fern fjord flame flint forest fossil fox frost galaxy garnet glacier glow granite grove harbor hazel heron honey indigo iris island ivory jade jasmine juniper kelp kestrel lagoon lantern lava lemon lilac lotus lunar maple marble meadow meteor mint misty moss nebula nectar north oasis ocean olive onyx orbit orchid otter pebble pepper pine pixel plum polar poppy prism quartz rain raven reef ridge river robin ruby saffron sage sapphire shadow silver sky slate solar sparrow spruce storm summit sunset thistle thunder tide timber topaz tulip tundra valley velvet violet willow winter zephyr').split(' ');

function newSyncCode() {
  const r = crypto.getRandomValues(new Uint32Array(5));
  const words = [0, 1, 2, 3].map(i => SYNC_WORDS[r[i] % SYNC_WORDS.length]);
  return `${words.join('-')}-${1000 + (r[4] % 9000)}`;
}

async function syncFetch(path, opts = {}, code = syncCode()) {
  const r = await fetch(syncUrl() + path, {
    ...opts, headers: { 'Content-Type': 'application/json', 'X-Sync-Code': code, ...(opts.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

// Combine two copies of the collection: newest version of each card wins; deletions win over older edits.
function mergeCollections(localItems, localTombs, remote) {
  const tombs = { ...(remote?.tombstones || {}) };
  Object.entries(localTombs).forEach(([id, t]) => { if (!tombs[id] || tombs[id] < t) tombs[id] = t; });
  const map = new Map();
  (remote?.items || []).forEach(it => map.set(it.id, it));
  localItems.forEach(it => { const r = map.get(it.id); if (!r || (it.updatedAt || 0) > (r.updatedAt || 0)) map.set(it.id, it); });
  const cutoff = Date.now() - 120 * 864e5; // forget deletions after ~4 months
  Object.keys(tombs).forEach(id => { if (tombs[id] < cutoff) delete tombs[id]; });
  const merged = [...map.values()].filter(it => !(tombs[it.id] && tombs[it.id] >= (it.updatedAt || 0))).map(migrate);
  return { items: merged, tombstones: tombs };
}
const fingerprint = (list, tombs) => JSON.stringify([list.map(i => `${i.id}:${i.updatedAt || 0}`).sort(), Object.keys(tombs || {}).sort()]);

function applyMerged(m) {
  items = m.items;
  tombstones = m.tombstones;
  resetSnapshots();
  localStorage.setItem(STORE_KEY, JSON.stringify(items));
  localStorage.setItem(TOMB_KEY, JSON.stringify(tombstones));
  render();
  if (detailId) renderDetail();
}

function setSyncRev(rev) {
  syncRev = rev;
  localStorage.setItem(SYNC_REV_KEY, String(rev));
  localStorage.setItem(SYNC_AT_KEY, String(Date.now()));
}

// Get the latest from the cloud, merge, and send back anything this device has that the cloud doesn't.
async function syncNow() {
  if (!syncCode()) return;
  if (syncBusy) { syncAgain = true; return; }
  syncBusy = true; syncError = '';
  updateSyncBadge('Syncing…');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = await syncFetch('/sync');
      if (got.status === 404) throw new Error('this sync code was not found');
      if (got.status !== 200) throw new Error(got.body.error || `error ${got.status}`);
      const remote = got.body;
      const m = mergeCollections(items, tombstones, remote.data);
      const changedHere = fingerprint(m.items, m.tombstones) !== fingerprint(items, tombstones);
      if (changedHere) applyMerged(m);
      if (remote.data && fingerprint(m.items, m.tombstones) === fingerprint(remote.data.items || [], remote.data.tombstones)) {
        setSyncRev(remote.rev); break; // cloud already has everything
      }
      const put = await syncFetch('/sync', {
        method: 'PUT',
        body: JSON.stringify({ baseRev: remote.rev, data: { items: m.items, tombstones: m.tombstones, settings, savedAt: Date.now() } }),
      });
      if (put.status === 200) { setSyncRev(put.body.rev); break; }
      if (put.status !== 409) throw new Error(put.body.error || `error ${put.status}`);
      // 409: the other device saved at the same moment — loop and merge again
    }
  } catch (err) {
    syncError = err.message.includes('Failed to fetch') ? 'offline' : err.message;
  } finally {
    syncBusy = false;
    updateSyncBadge();
    if (syncAgain) { syncAgain = false; syncNow(); }
  }
}

function schedulePush() {
  if (!syncCode()) return;
  clearTimeout(pushTimer);
  updateSyncBadge('Saving…');
  pushTimer = setTimeout(syncNow, 3000); // wait for a pause in editing, so a burst of changes is one save
}

function updateSyncBadge(busy = '') {
  const b = $('#syncBadge');
  if (!syncCode()) { b.hidden = true; return; }
  b.hidden = false;
  b.className = 'sync-badge';
  if (busy) { b.textContent = '☁ ' + busy; return; }
  if (syncError) {
    b.classList.add('err');
    b.textContent = syncError === 'offline' ? '☁ Offline — will sync later' : '☁ Sync problem';
    b.title = syncError;
    return;
  }
  const at = +localStorage.getItem(SYNC_AT_KEY);
  const mins = at ? Math.round((Date.now() - at) / 6e4) : null;
  b.classList.add('ok');
  b.textContent = '☁ Synced' + (mins == null ? '' : mins < 1 ? '' : mins < 60 ? ` ${mins}m ago` : ` ${Math.round(mins / 60)}h ago`);
  b.title = '';
}

function renderSyncSettings(msg = '', isError = false) {
  const on = !!syncCode();
  $('#syncOff').hidden = on;
  $('#syncOn').hidden = !on;
  $('#syncCodeShow').textContent = syncCode();
  const m = $('#syncMsg');
  m.textContent = msg || (on && syncError ? `Last sync failed: ${syncError}` : '');
  m.className = 'small ' + (isError ? 'error' : msg ? 'ok' : '');
}

$('#syncCreate').addEventListener('click', async () => {
  const invite = $('#syncInvite').value.trim();
  if (!invite) return renderSyncSettings('Enter the invite code first.', true);
  const code = newSyncCode();
  renderSyncSettings('Setting up…');
  try {
    const r = await syncFetch('/sync/register', { method: 'POST', body: JSON.stringify({ invite }) }, code);
    if (r.status !== 200) throw new Error(r.body.error || `error ${r.status}`);
    localStorage.setItem(SYNC_CODE_KEY, code);
    setSyncRev(0);
    await syncNow();
    renderSyncSettings(`✓ Sync is on and your ${items.length} item${items.length === 1 ? ' is' : 's are'} backed up. Write your sync code down somewhere safe.`);
  } catch (err) {
    renderSyncSettings("Couldn't turn on sync: " + err.message, true);
  }
});

$('#syncJoin').addEventListener('click', async () => {
  const code = $('#syncJoinCode').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (code.length < 12) return renderSyncSettings('Enter the whole sync code from your other device.', true);
  renderSyncSettings('Connecting…');
  try {
    const r = await syncFetch('/sync', {}, code);
    if (r.status === 404) throw new Error("that code wasn't found — check it matches your other device exactly");
    if (r.status !== 200) throw new Error(r.body.error || `error ${r.status}`);
    const remoteCount = r.body.data?.items?.length || 0;
    if (items.length) {
      const keep = confirm(`This device already has ${items.length} item${items.length === 1 ? '' : 's'}; the synced collection has ${remoteCount}.\n\n` +
        'OK = combine them (keeps both)\nCancel = replace this device\'s items with the synced collection');
      if (!keep) { items.forEach(it => { delete it.updatedAt; }); items = []; tombstones = {}; resetSnapshots(); }
    }
    localStorage.setItem(SYNC_CODE_KEY, code);
    setSyncRev(0);
    await syncNow();
    renderSyncSettings(`✓ Connected. ${items.length} item${items.length === 1 ? '' : 's'} on this device now.`);
  } catch (err) {
    renderSyncSettings("Couldn't connect: " + err.message, true);
  }
});

$('#syncNow').addEventListener('click', async () => {
  await syncNow();
  renderSyncSettings(syncError ? '' : '✓ Up to date.', !!syncError);
});
$('#syncCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(syncCode()); renderSyncSettings('Copied.'); }
  catch { renderSyncSettings('Select the code and copy it.'); }
});
$('#syncOffBtn').addEventListener('click', () => {
  if (!confirm('Turn off sync on this device? Your cards stay on this device and in the cloud — you can reconnect any time with your sync code.')) return;
  localStorage.removeItem(SYNC_CODE_KEY);
  localStorage.removeItem(SYNC_REV_KEY);
  renderSyncSettings('Sync is off on this device.');
  updateSyncBadge();
});

// Pull changes from other devices when the app opens, comes back to the front, and every minute while open.
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
setInterval(() => { if (!document.hidden) syncNow(); }, 60e3);
setInterval(() => { if (!syncBusy) updateSyncBadge(); }, 30e3);

// =====================================================================
// Wishlist price alerts (phone notifications sent by the worker's daily job)
// =====================================================================
const ALERT_SEEN_KEY = 'shelf-value-alert-seen';
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// The offline script needs the sync code to fetch alert details when a notification arrives.
async function storeSyncMeta() {
  if (!('caches' in window)) return;
  const c = await caches.open('shelf-meta');
  if (syncCode()) await c.put('/__sync', new Response(JSON.stringify({ code: syncCode(), url: syncUrl() }), { headers: { 'Content-Type': 'application/json' } }));
  else await c.delete('/__sync');
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderAlertsSetting() {
  const btn = $('#alertsBtn'), hint = $('#alertsHint');
  hint.hidden = true;
  if (!pushSupported() || (isIOS() && !isInstalled())) {
    btn.disabled = true;
    btn.textContent = 'Turn on price alerts';
    hint.hidden = false;
    hint.textContent = isIOS()
      ? 'On iPhone, open Shelf Value from its Home Screen icon (not Safari) to turn on alerts. Needs iOS 16.4 or newer.'
      : "This browser doesn't support notifications.";
    return;
  }
  btn.disabled = false;
  const sub = await currentSubscription();
  btn.textContent = sub && Notification.permission === 'granted' ? 'Turn off price alerts on this device' : 'Turn on price alerts';
  btn.classList.toggle('danger', !!sub);
  $('#alertsTest').hidden = !sub;
  if (Notification.permission === 'denied') {
    hint.hidden = false;
    hint.textContent = 'Notifications are blocked for Shelf Value. Allow them in your phone\'s Settings → Notifications, then try again.';
  }
}

const b64ToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));

$('#alertsBtn').addEventListener('click', async () => {
  const existing = await currentSubscription();
  if (existing) {
    await syncFetch('/sync/push', { method: 'DELETE', body: JSON.stringify({ endpoint: existing.endpoint }) }).catch(() => {});
    await existing.unsubscribe().catch(() => {});
    renderSyncSettings('Price alerts are off on this device.');
    return renderAlertsSetting();
  }
  try {
    const perm = await Notification.requestPermission(); // must be the first thing in the tap
    if (perm !== 'granted') throw new Error('notifications were not allowed');
    const info = await (await fetch(syncUrl() + '/')).json();
    if (!info.vapidPublicKey) throw new Error('the price worker is not set up for alerts');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.vapidPublicKey) });
    const r = await syncFetch('/sync/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    if (r.status !== 200) throw new Error(r.body.error || `error ${r.status}`);
    await storeSyncMeta();
    renderSyncSettings('✓ Price alerts are on. Set a target price on wishlist cards to get alerts.');
  } catch (err) {
    renderSyncSettings("Couldn't turn on alerts: " + err.message, true);
  }
  renderAlertsSetting();
});

$('#alertsTest').addEventListener('click', async () => {
  renderSyncSettings('Sending…');
  try {
    // Make sure the worker has this device (in case it was turned on before sync, or got lost).
    const sub = await currentSubscription();
    if (sub) await syncFetch('/sync/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    await storeSyncMeta();
    const r = await syncFetch('/sync/push/test', { method: 'POST', body: '{}' });
    if (r.status !== 200) throw new Error(r.body.error || `error ${r.status}`);
    if (r.body.sent) renderSyncSettings(`✓ Sent to ${r.body.sent} device${r.body.sent > 1 ? 's' : ''}. It should pop up within a few seconds — if this app is open on screen, look in Notification Centre.`);
    else renderSyncSettings("Couldn't send: " + (r.body.error || (r.body.errors || []).join('; ') || 'unknown problem'), true);
  } catch (err) {
    renderSyncSettings("Couldn't send: " + err.message, true);
  }
});

// Also show new alerts inside the app when it opens.
async function checkAlertsInApp() {
  if (!syncCode()) return;
  try {
    const r = await syncFetch('/sync/alerts');
    const a = r.body;
    const seen = +localStorage.getItem(ALERT_SEEN_KEY) || 0;
    if (r.status === 200 && a.at > seen && !a.test && a.list?.length) {
      localStorage.setItem(ALERT_SEEN_KEY, String(a.at));
      const first = a.list[0];
      toast(a.list.length === 1
        ? `🔔 ${first.name} is ${money(first.price)} — at or under your ${money(first.target)} target`
        : `🔔 ${a.list.length} wishlist cards hit your target price`);
    }
  } catch { /* offline */ }
}


// =====================================================================
// Search every card (top of the app): live results with pictures and prices
// =====================================================================
const nameSearchCache = new Map();
let csToken = 0, csTimer = null, csResults = [], csShown = 0;
const CS_PAGE = 36;

async function cardsByName(name) {
  const key = name.toLowerCase();
  if (!nameSearchCache.has(key)) {
    nameSearchCache.set(key, getJSON(`${API}/cards?name=${encodeURIComponent(name)}`)
      .then(list => list.filter(c => !isPocket(setIdOf(c.id))).concat(customMatches(name)))
      .catch(err => { nameSearchCache.delete(key); throw err; }));
  }
  return nameSearchCache.get(key);
}

// Does a leftover word describe this card? (set name, card number like 4 / 004 / 4/102 / TG05)
function wordFits(card, w) {
  const set = setById.get(setIdOf(card.id));
  const setName = (set?.name || '').toLowerCase();
  const m = w.replace(/^#/, '').match(/^([a-z]{0,4}\d+[a-z]?)(?:\/([a-z]{0,4}\d+))?$/i);
  if (m) {
    const numOk = normId(m[1]) === normId(card.localId);
    const totOk = !m[2] || String(set?.official) === String(parseInt(m[2].replace(/\D/g, ''), 10)) || /[a-z]/i.test(m[2]);
    if (numOk && totOk) return true;
  }
  return setName.includes(w) || setIdOf(card.id).toLowerCase() === w;
}

// Understands "charizard", "charizard 4/102", "pikachu 151", "151 pikachu", "umbreon vmax evolving".
async function smartCardSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Try the longest run of words as the card name, the rest must match the set or number.
  const tries = [];
  for (let len = words.length; len >= 1; len--) {
    for (let start = 0; start + len <= words.length; start++) {
      const nameWords = words.slice(start, start + len);
      if (!nameWords.some(w => /[a-z]/.test(w))) continue;        // a name needs letters
      if (nameWords.join('').replace(/[^a-z]/g, '').length < 2) continue;
      tries.push({ name: nameWords.join(' '), rest: [...words.slice(0, start), ...words.slice(start + len)] });
    }
  }
  for (const t of tries.slice(0, 8)) {
    let cards;
    try { cards = await cardsByName(t.name); } catch { continue; }
    const hits = cards.filter(c => t.rest.every(w => wordFits(c, w)));
    if (hits.length) return { cards: hits, name: t.name, rest: t.rest };
  }
  return { cards: [], name: q, rest: [] };
}

function sortCards(cards) {
  return [...cards].sort((a, b) =>
    (setOrder.get(setIdOf(b.id)) ?? -1) - (setOrder.get(setIdOf(a.id)) ?? -1) ||
    (parseInt(a.localId, 10) || 0) - (parseInt(b.localId, 10) || 0));
}

async function runCardSearch() {
  const q = $('#cardSearch').value.trim();
  const box = $('#cardSearchResults');
  $('#cardSearchClear').hidden = !q;
  const token = ++csToken;
  if (q.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<p class="note">Searching…</p>';
  try {
    if (!sets.length) await loadSets();
    const { cards } = await smartCardSearch(q);
    if (token !== csToken) return;
    csResults = sortCards(cards);
    csShown = 0;
    renderCardSearch(token);
  } catch (err) {
    if (token === csToken) box.innerHTML = `<p class="note">Couldn't search right now (${esc(err.message)}).</p>`;
  }
}

function renderCardSearch(token, grow = false) {
  const box = $('#cardSearchResults');
  if (!csResults.length) {
    box.innerHTML = `<p class="note">No cards found for "${esc($('#cardSearch').value.trim())}". Check the spelling, or try just the Pokémon's name.</p>`;
    return;
  }
  if (grow || !csShown) csShown = Math.min(csResults.length, csShown + CS_PAGE);
  const have = holdings();
  const owned = csResults.filter(c => have.get(c.id)?.qty).length;
  box.innerHTML = `<div class="cs-head"><b>${csResults.length} card${csResults.length === 1 ? '' : 's'}</b>
      <span class="muted">${owned ? `you own ${owned} · ` : ''}tap a card to add it</span></div>
    <div class="cs-grid">${csResults.slice(0, csShown).map(c => {
      const h = have.get(c.id);
      const state = h?.qty ? 'owned' : h?.wish ? 'wish' : 'missing';
      const s = setById.get(setIdOf(c.id));
      return `<div class="tile ${state === 'missing' ? '' : state}" data-card="${esc(c.id)}">
        ${cardImg(c.id, c.image)}
        ${h?.qty > 1 ? `<span class="qty-badge">×${h.qty}</span>` : ''}
        ${state !== 'missing' ? `<span class="mark">${state === 'owned' ? '✓' : '♥'}</span>` : ''}
        <b>${esc(c.name)}</b><span>${esc(s?.name || setIdOf(c.id))} · #${esc(c.localId)}</span>
        <span class="price" data-price="${esc(c.id)}"></span></div>`;
    }).join('')}</div>
    ${csShown < csResults.length ? `<button type="button" class="cs-more">Show more (${csResults.length - csShown} left)</button>` : ''}`;
  loadSearchPrices(token);
}

// Prices for the cards on screen, a few at a time.
async function loadSearchPrices(token) {
  const spans = $$('#cardSearchResults [data-price]').filter(s => !s.textContent);
  const queue = [...spans];
  const worker = async () => {
    while (queue.length && token === csToken) {
      const span = queue.shift();
      try {
        const card = await getCard(span.dataset.price);
        const opt = priceOptions(card)[0];
        if (token === csToken) span.textContent = opt ? money(opt.price) : '—';
      } catch { /* leave blank */ }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

$('#cardSearch').addEventListener('input', () => { clearTimeout(csTimer); csTimer = setTimeout(runCardSearch, 300); });
$('#cardSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(csTimer); runCardSearch(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.value = ''; runCardSearch(); }
});
$('#cardSearchClear').addEventListener('click', () => { $('#cardSearch').value = ''; runCardSearch(); });
$('#cardSearchResults').addEventListener('click', e => {
  if (e.target.closest('.cs-more')) { renderCardSearch(csToken, true); return; }
  const tile = e.target.closest('.tile[data-card]');
  if (tile) openPick(tile.dataset.card);
});

// =====================================================================
// Rapid scan: keep the camera open, scan a stack, review everything at the end
// =====================================================================
const rapid = { active: false, results: [], working: false };

function startRapid(keep = false) {
  if (!keep) rapid.results = [];
  if (!navigator.mediaDevices?.getUserMedia) { alert("This device can't open the camera here."); return; }
  rapid.active = true;
  openCamera().then(ok => {
    if (!ok) { rapid.active = false; alert("Couldn't open the camera."); return; }
    $('#camUpload').hidden = true;
    updateRapidCount();
  });
}
$$('.rapidBtn').forEach(b => b.addEventListener('click', () => startRapid()));

function updateRapidCount() {
  const n = rapid.results.length, done = rapid.results.filter(r => r.status !== 'pending').length;
  $('#camCount').hidden = !rapid.active;
  $('#camCount').textContent = n ? `${n} scanned${done < n ? ` · reading ${n - done}…` : ' ✓'}` : '⚡ Rapid scan: tap for each card';
  $('#camCancel').textContent = n ? `Done (${n})` : 'Cancel';
}

function rapidCaptured(bmp) {
  // keep a small picture for the review list
  const c = document.createElement('canvas');
  const k = 160 / bmp.height;
  c.width = Math.round(bmp.width * k); c.height = 160;
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  rapid.results.push({ id: uid(), bmp, thumb: c.toDataURL('image/jpeg', 0.7), status: 'pending', matches: [], choice: null });
  const g = $('#camGuide');
  g.classList.remove('cam-flash'); void g.offsetWidth; g.classList.add('cam-flash');
  if (navigator.vibrate) navigator.vibrate(30);
  updateRapidCount();
  processRapid();
}

// Read the queued cards one at a time in the background while you keep scanning.
async function processRapid() {
  if (rapid.working) return;
  rapid.working = true;
  try {
    for (;;) {
      const r = rapid.results.find(x => x.status === 'pending');
      if (!r) break;
      try {
        const { matches } = await identifyCard(r.bmp, { cropped: true });
        r.matches = matches.slice(0, 12);
        r.choice = matches[0]?.id || null;
        r.status = matches.length ? (matches[0].best ? 'done' : 'unsure') : 'fail';
      } catch { r.status = 'fail'; }
      r.bmp = null; // free memory
      updateRapidCount();
      if ($('#batchDialog').open) renderBatch();
    }
  } finally { rapid.working = false; }
}

function openBatch() {
  $('#batchDate').value = today();
  $('#batchList2').value = view === 'wishlist' ? 'wishlist' : 'collection';
  renderBatch();
  if (!$('#batchDialog').open) $('#batchDialog').showModal();
}

function renderBatch() {
  const list = $('#batchList');
  const pending = rapid.results.filter(r => r.status === 'pending').length;
  const unsure = rapid.results.filter(r => r.status === 'unsure' || r.status === 'fail').length;
  $('#batchStatus').textContent = pending ? `Reading ${pending} more card${pending > 1 ? 's' : ''}…`
    : unsure ? `${unsure} card${unsure > 1 ? 's need' : ' needs'} a check — pick the right one from the list, or remove it.`
    : `All ${rapid.results.length} cards read. Check them over, then tap Add all.`;
  list.innerHTML = rapid.results.map(r => {
    const opts = r.matches.map(m => `<option value="${esc(m.id)}" ${m.id === r.choice ? 'selected' : ''}>${esc(m.name)} — ${esc(m.setName)} #${esc(m.localId)}</option>`).join('');
    const chosen = r.matches.find(m => m.id === r.choice);
    return `<div class="batch-row ${r.status === 'pending' ? 'pending' : ''} ${r.status === 'fail' ? 'fail' : ''}" data-rid="${r.id}">
      ${chosen ? cardImg(chosen.id, chosen.image, { lazy: false }) : `<img src="${r.thumb}" alt="">`}
      <div class="who">${r.status === 'pending' ? '<b>Reading…</b>'
        : r.status === 'fail' ? '<b>Couldn\'t read this one</b><span class="muted small">Remove it and add it by hand.</span>'
        : `<b>${r.status === 'done' ? '✓ ' : '⚠ Check: '}${esc(chosen?.name || '')}</b><select data-pick>${opts}</select>`}</div>
      <button type="button" class="del" data-remove title="Remove">✕</button></div>`;
  }).join('') || '<p class="muted">Nothing scanned.</p>';
  $('#batchAdd').disabled = pending > 0 || !rapid.results.some(r => r.choice);
  $('#batchAdd').textContent = pending ? 'Waiting…' : `Add ${rapid.results.filter(r => r.choice).length} card${rapid.results.filter(r => r.choice).length === 1 ? '' : 's'}`;
}

$('#batchList').addEventListener('change', e => {
  const row = e.target.closest('[data-rid]');
  if (!row || !e.target.matches('[data-pick]')) return;
  const r = rapid.results.find(x => x.id === row.dataset.rid);
  r.choice = e.target.value;
  if (r.status === 'unsure') r.status = 'done';
  renderBatch();
});
$('#batchList').addEventListener('click', e => {
  if (!e.target.closest('[data-remove]')) return;
  const row = e.target.closest('[data-rid]');
  rapid.results = rapid.results.filter(x => x.id !== row.dataset.rid);
  renderBatch();
});
$('#batchMore').addEventListener('click', () => { $('#batchDialog').close(); startRapid(true); });

$('#batchAdd').addEventListener('click', async () => {
  const chosen = rapid.results.filter(r => r.choice);
  const list = $('#batchList2').value, cond = $('#batchCond').value, cat = $('#batchCat').value.trim(), date = $('#batchDate').value || today();
  $('#batchAdd').disabled = true;
  $('#batchStatus').textContent = 'Adding…';
  // Same card scanned twice = quantity 2.
  const counts = new Map();
  chosen.forEach(r => counts.set(r.choice, (counts.get(r.choice) || 0) + 1));
  let added = 0, offWish = 0;
  for (const [cardId, qty] of counts) {
    try {
      const card = await getCard(cardId);
      const opt = priceOptions(card)[0];
      const it = migrate({
        ...cardIdentity(card), kind: 'card', list, category: cat, condition: cond, qty, added: today(),
        acquired: list === 'collection' ? date : null, paid: null,
        variant: opt?.key || '', variantName: opt?.label || '', prices: [],
      });
      if (opt) { it.tcgId = opt.productId; upsertPrice(it, today(), opt.price, 'TCGplayer market'); }
      if (list === 'collection') {
        const wished = items.find(i => i.list === 'wishlist' && i.cardId === cardId);
        if (wished) { items = items.filter(i => i !== wished); offWish++; }
      }
      items.push(it);
      added += qty;
    } catch { /* skip a card that won't load */ }
  }
  save();
  rapid.results = [];
  $('#batchDialog').close();
  if (page !== 'sets') view = list;
  render();
  toast(`✓ Added ${added} card${added === 1 ? '' : 's'}${offWish ? ` (${offWish} taken off your wishlist)` : ''}. Tap any card to set its version or what you paid.`);
});

// =====================================================================
// Sold & traded log
// =====================================================================
const saleDialog = $('#saleDialog'), saleForm = $('#saleForm');
let saleType = 'sold';

const saleProfit = it => {
  const s = it.sale || {};
  return (s.amount || 0) - (s.fees || 0) - (it.paid || 0) * (s.qty || it.qty || 1);
};

function syncSaleForm() {
  $$('#saleType button').forEach(b => b.classList.toggle('on', b.dataset.t === saleType));
  $('#saleAmountLabel').firstChild.textContent = saleType === 'sold' ? 'Sold for (total, $) ' : 'Trade value of what you got (total, $) ';
  const it = items.find(i => i.id === detailId);
  if (!it) return;
  const f = saleForm.elements;
  const qty = Math.min(it.qty || 1, Math.max(1, parseInt(f.qty.value) || 1));
  const profit = (num(f.amount.value) || 0) - (num(f.fees.value) || 0) - (it.paid || 0) * qty;
  $('#saleProfit').innerHTML = it.paid != null && num(f.amount.value) != null
    ? `Profit: <b class="${cls(profit)}">${signedMoney(profit)}</b> <span class="muted">(you paid ${money((it.paid || 0) * qty)})</span>`
    : it.paid == null ? '<span class="muted">Add what you paid (Edit) to see your profit.</span>' : '';
}

$('#sellBtn').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  saleForm.reset();
  saleType = 'sold';
  const f = saleForm.elements;
  f.date.value = today();
  f.qty.value = it.qty || 1;
  f.qty.max = it.qty || 1;
  const s = itemStats(it);
  f.amount.placeholder = s.priced ? `market ≈ ${money(s.unit * (it.qty || 1))}` : '0.00';
  $('#saleWhat').textContent = `${it.name}${it.setName ? ' · ' + it.setName : ''} · ${versionText(it)} · you have ${it.qty || 1}`;
  syncSaleForm();
  saleDialog.showModal();
});
$('#saleType').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { saleType = b.dataset.t; syncSaleForm(); } });
saleForm.addEventListener('input', syncSaleForm);

saleForm.addEventListener('submit', e => {
  e.preventDefault();
  const it = items.find(i => i.id === detailId);
  const f = saleForm.elements;
  const qty = Math.min(it.qty || 1, Math.max(1, parseInt(f.qty.value) || 1));
  const sale = { type: saleType, date: f.date.value || today(), qty, amount: num(f.amount.value) || 0, fees: num(f.fees.value) || 0, notes: f.notes.value.trim() };
  let soldItem = it;
  if (qty < (it.qty || 1)) {
    // Sold some of them: split off the sold copies.
    it.qty -= qty;
    soldItem = migrate({ ...JSON.parse(JSON.stringify(it)), id: uid(), qty, list: 'sold', sale });
    items.push(soldItem);
  } else {
    it.list = 'sold';
    it.sale = sale;
  }
  save();
  saleDialog.close();
  detailDialog.close();
  render();
  const p = saleProfit(soldItem);
  toast(`${saleType === 'sold' ? '💰 Sold' : '🔄 Traded'} ${qty} × ${it.name}${soldItem.paid != null ? ` · profit ${signedMoney(p)}` : ''}`);
});

$('#unsellBtn').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  if (!confirm(`Move ${it.name} back into your collection?`)) return;
  it.list = 'collection';
  delete it.sale;
  save();
  view = 'collection';
  detailDialog.close();
  render();
});

function renderSold() {
  let rows = applyFilters(items.filter(i => i.list === 'sold').map(it => ({ it, s: itemStats(it) })));
  rows.sort((a, b) => (b.it.sale?.date || '').localeCompare(a.it.sale?.date || ''));
  const all = items.filter(i => i.list === 'sold');
  const received = all.reduce((a, it) => a + (it.sale?.amount || 0), 0);
  const fees = all.reduce((a, it) => a + (it.sale?.fees || 0), 0);
  const profit = all.filter(it => it.paid != null).reduce((a, it) => a + saleProfit(it), 0);
  $('#viewExtra').hidden = !all.length;
  $('#viewExtra').innerHTML = `<div class="stats small">
    ${statTile('Cards sold / traded', all.reduce((a, it) => a + (it.sale?.qty || it.qty || 1), 0))}
    ${statTile('Total received', money(received))}
    ${statTile('Fees & shipping', money(fees))}
    ${statTile('Profit', signedMoney(profit), cls(profit))}</div>`;
  const table = $('#itemsTable');
  $('thead', table).innerHTML = `<tr><th></th><th>Card</th><th>Version</th><th>Date</th><th></th>
    <th class="num">Qty</th><th class="num">Received</th><th class="num">Paid</th><th class="num">Profit</th></tr>`;
  $('tbody', table).innerHTML = rows.map(({ it }) => {
    const s = it.sale || {}, p = saleProfit(it);
    return `<tr data-id="${it.id}">${thumb(it)}${nameCell(it)}
      <td>${esc(versionText(it))}</td><td>${fmtDate(s.date)}</td>
      <td><span class="badge sold">${s.type === 'traded' ? 'Traded' : 'Sold'}</span></td>
      <td class="num">${s.qty || it.qty || 1}</td><td class="num">${money(s.amount)}</td>
      <td class="num">${it.paid != null ? money(it.paid * (s.qty || it.qty || 1)) : dash}</td>
      <td class="num ${cls(p)}">${it.paid != null ? signedMoney(p) : dash}</td></tr>`;
  }).join('');
  $('#empty').hidden = rows.length > 0;
  $('#empty').innerHTML = all.length ? 'Nothing matches your filters.'
    : 'Nothing sold or traded yet. Open a card in your collection and tap <b>💰 Sold / traded…</b>';
}

// =====================================================================
// Grading tracker
// =====================================================================
const SUB_STATUS = { submitted: 'Sent', received: 'Received by grader', grading: 'Being graded', shipped: 'Shipped back', done: 'Back' };
const activeSub = it => !!(it.grading && it.grading.status !== 'done');
const subDialog = $('#subDialog'), subForm = $('#subForm');
let subMode = 'send';

function openSub(mode) {
  const it = items.find(i => i.id === detailId);
  subMode = mode;
  subForm.reset();
  const f = subForm.elements;
  $('#subSendFields').hidden = mode !== 'send';
  $('#subBackFields').hidden = mode !== 'back';
  $('#subTitle').textContent = mode === 'send' ? 'Send for grading' : 'Grade is back';
  $('#subWhat').textContent = `${it.name}${it.setName ? ' · ' + it.setName : ''} · ${versionText(it)}`;
  if (mode === 'send') { f.sent.value = today(); f.fee.value = settings.gFee || ''; }
  else { f.back.value = today(); $('#subSave').textContent = `Save as ${it.grading.grader} graded`; }
  if (mode === 'send') $('#subSave').textContent = 'Save';
  subDialog.showModal();
}
$('#gradeSendBtn').addEventListener('click', () => openSub('send'));
$('#subBack').addEventListener('click', () => openSub('back'));

subForm.addEventListener('submit', e => {
  e.preventDefault();
  const it = items.find(i => i.id === detailId);
  const f = subForm.elements;
  if (subMode === 'send') {
    if ((it.qty || 1) > 1 && !confirm(`You have ${it.qty} of this card. Send just one? (OK = one, Cancel = all ${it.qty})`)) {
      /* send all */
    } else if ((it.qty || 1) > 1) {
      it.qty -= 1;
      const one = migrate({ ...JSON.parse(JSON.stringify(it)), id: uid(), qty: 1 });
      items.push(one);
      detailId = one.id;
      return finishSend(one, f);
    }
    finishSend(it, f);
  } else {
    const grade = f.grade.value.trim();
    if (!grade) { alert('Enter the grade it got.'); return; }
    const fee = it.grading.fee || 0;
    it.condition = 'Graded';
    it.grader = it.grading.grader;
    it.grade = grade;
    if (f.cert.value.trim()) it.cert = f.cert.value.trim();
    if (f.addFee.checked && fee) it.paid = (it.paid || 0) + fee;
    it.grading.status = 'done';
    it.grading.back = f.back.value || today();
    it.grading.history = (it.grading.history || []).concat([{ status: 'done', date: it.grading.back }]);
    save();
    subDialog.close();
    render(); renderDetail();
    toast(`🎉 ${it.name} came back a ${it.grader} ${grade}. Log its graded value from eBay sold listings (button below).`);
    if (workerUrl()) refreshEbay(it).then(() => { save(); render(); if (detailId) renderDetail(); }).catch(() => {});
  }
});

function finishSend(it, f) {
  it.grading = {
    status: 'submitted', grader: f.grader.value, service: f.service.value.trim(), sent: f.sent.value || today(),
    fee: num(f.fee.value), order: f.order.value.trim(), history: [{ status: 'submitted', date: f.sent.value || today() }],
  };
  save();
  subDialog.close();
  render(); renderDetail();
  toast(`📦 ${it.name} is marked as sent to ${it.grading.grader}`);
}

$('#subStatus').addEventListener('change', e => {
  const it = items.find(i => i.id === detailId);
  it.grading.status = e.target.value;
  it.grading.history = (it.grading.history || []).concat([{ status: e.target.value, date: today() }]);
  save(); render(); renderDetail();
});
$('#subCancel').addEventListener('click', () => {
  const it = items.find(i => i.id === detailId);
  if (!confirm('Cancel this grading submission? The card stays in your collection as it was.')) return;
  delete it.grading;
  save(); render(); renderDetail();
});

function renderSubBox(it) {
  const g = it.grading;
  const show = it.list === 'collection' && activeSub(it);
  $('#subBox').hidden = !show;
  if (!show) return;
  const days = Math.max(0, Math.round((Date.now() - new Date(g.sent + 'T00:00:00')) / 864e5));
  $('#subInfo').innerHTML = `<p class="small"><b>${esc(g.grader)}</b>${g.service ? ' · ' + esc(g.service) : ''} · sent ${fmtDate(g.sent)} (${days} day${days === 1 ? '' : 's'} ago)
    ${g.fee != null ? ' · fee ' + money(g.fee) : ''}${g.order ? ' · order #' + esc(g.order) : ''}</p>`;
  $('#subStatus').value = g.status;
}

function renderSaleBox(it) {
  const show = it.list === 'sold';
  $('#saleBox').hidden = !show;
  if (!show) return;
  const s = it.sale || {}, p = saleProfit(it);
  $('#saleBox').innerHTML = `<h3>${s.type === 'traded' ? 'Traded' : 'Sold'} on ${fmtDate(s.date)}</h3>
    <p class="small">${s.qty || 1} × for ${money(s.amount)}${s.fees ? ` · fees ${money(s.fees)}` : ''}${it.paid != null ? ` · paid ${money(it.paid * (s.qty || 1))} · <b class="${cls(p)}">profit ${signedMoney(p)}</b>` : ''}</p>
    ${s.notes ? `<p class="small muted">${esc(s.notes)}</p>` : ''}`;
}

// =====================================================================
// Bottom bar: Collection / Sets / Settings
// =====================================================================
// =====================================================================
// Skylanders: its own checklist and totals, kept apart from the Pokémon collection.
// Items are stored with kind 'sky' and list 'sky' (owned) or 'skywish' (wishlist),
// so they sync with everything else but never count toward Pokémon totals.
// =====================================================================
const SKYD = window.SKY || { games: [], types: [], items: [], byId: new Map() };
let skyGameId = '', skyMode = 'all';
const skyOwned = () => items.filter(i => i.kind === 'sky' && i.list === 'sky');
const skyWished = () => items.filter(i => i.kind === 'sky' && i.list === 'skywish');
const skyGameName = id => (SKYD.games.find(g => g.id === id) || {}).name || '';

function skyHoldings() {
  const m = new Map();
  items.forEach(it => {
    if (it.kind !== 'sky') return;
    const h = m.get(it.skyId) || { qty: 0, wish: null, own: null };
    if (it.list === 'sky') { h.qty += it.qty || 1; h.own = it; } else if (it.list === 'skywish') h.wish = it;
    m.set(it.skyId, h);
  });
  return m;
}

// ---- pictures, loaded from the Skylanders wiki's image server (nothing is copied into the app) ----
const SKY_WIKI = 'https://skylanders.fandom.com/api.php?format=json&formatversion=2&origin=*&redirects=1';
const SKY_IMG_KEY = 'shelf-value-sky-wiki-v1';
const skyImgs = readJSON(SKY_IMG_KEY, {});      // item id -> wiki page with its picture ('' = none found)
const SKY_GAME_PAGES = { ssa: "Skylanders: Spyro's Adventure", giants: 'Skylanders: Giants', swap: 'Skylanders: Swap Force',
  trap: 'Skylanders: Trap Team', super: 'Skylanders: SuperChargers', imag: 'Skylanders: Imaginators' };
const SKY_SKIP_TAGS = /^(giants|swap force|trap team|superchargers|imaginators|spyro's adventure|adventure|series [23]|e3|toy fair|employee|holiday|mobile|\d{4}|walmart|target pre-order card|employee edition|happy birthday ben|macy's thanksgiving day parade|sidekicks|minis?|buddy pack)$/i;
const cap = s => s.replace(/\b\w/g, c => c.toUpperCase()).replace(/\bOf\b/g, 'of');

function skyImgCandidates(def) {
  const n = def.name, out = [];
  const elem = (n.match(/^(air|earth|fire|water|life|undead|magic|tech|light|dark|kaos|ultimate kaos)\b/i) || [])[1];
  const E = elem ? cap(elem.replace(/^ultimate /i, '')) : '';
  if (def.type === 'Traps') {
    if (/legendary/i.test(n)) out.push('File:Legendary Traps.png');
    if (/ultimate kaos/i.test(n)) out.push('File:Ultimate Kaos Trap.png');
    if (E) out.push(`File:${E} Traps.png`);
    out.push('Trap');
    return out;
  }
  if (def.type === 'Creation Crystals') {
    if (/legendary/i.test(n)) out.push('File:Legendary Crystals.png');
    if (E) out.push(`File:${E} Crystals.png`);
    out.push('Creation Crystal');
    return out;
  }
  if (def.type === 'Portals') return [def.game === 'trap' ? 'Traptanium Portal' : 'Portal of Power', 'Portal of Power'];
  if (def.type === 'Games') return [/racing/i.test(n) ? 'Skylanders: SuperChargers Racing' : SKY_GAME_PAGES[def.game]].filter(Boolean);
  if (def.note && !/promotional|battle arena|instant/i.test(def.note)) out.push(def.note);
  if (def.type === 'Adventure Packs') {
    const place = n.replace(/^Skylanders[^:]*:\s*/i, '').replace(/^Skylanders .*?(Adventure Pack: )/i, '').replace(/\s*(Adventure Pack|Level Pack|Dark Element Expansion Pack).*$/i, '')
      .replace(/\s*[-[].*$/, '').replace(/^Skylanders\s+/i, '').trim();
    out.push(place, cap(place.toLowerCase()), SKY_GAME_PAGES[def.game]);
    return out.filter(Boolean);
  }
  if (def.type === 'Packs & Bundles' || def.type === 'Accessories') {
    const first = (n.match(/\[([^,\]]+)/) || [])[1] || (n.match(/^([^&-]+?) & /) || [])[1];
    if (first && !/^(magic|mobile|two ways|combo)/i.test(first.trim())) out.push(first.trim());
    out.push(SKY_GAME_PAGES[def.game]);
    return out.filter(Boolean);
  }
  // Figures, variants, vehicles, minis, magic items, trophies
  const base = n.split(/ - |\s*\[/)[0].trim();
  const tags = [...n.slice(base.length).matchAll(/[^,\-\[\]]+/g)].map(m => m[0].trim()).filter(t => t && !SKY_SKIP_TAGS.test(t));
  const plain = base.replace(/^(Master|Sensei)\s+/i, '');
  const tagWord = t => (/^eon's elite$/i.test(t) ? 'Elite' : /^lightcore$/i.test(t) ? 'LightCore' : t);
  if (tags.length) {
    out.push(`${tags.map(tagWord).reverse().join(' ')} ${plain}`, `${tagWord(tags[tags.length - 1])} ${plain}`, `${tagWord(tags[0])} ${plain}`);
  }
  out.push(base, plain);
  return [...new Set(out)];
}

let skyImgBusy = Promise.resolve();
function loadSkyImages(defs) {
  const todo = defs.filter(d => !(d.id in skyImgs)).slice(0, 300);
  if (!todo.length) return;
  skyImgBusy = skyImgBusy.then(async () => {
    const want = new Map(todo.map(d => [d.id, skyImgCandidates(d)]));
    const titles = [...new Set([...want.values()].flat())];
    const found = new Map();  // asked-for title -> picture
    for (let i = 0; i < titles.length; i += 50) {
      const chunk = titles.slice(i, i + 50);
      try {
        const j = await (await fetch(`${SKY_WIKI}&action=query&prop=pageimages|imageinfo&piprop=thumbnail&pithumbsize=300&iiprop=url&iiurlwidth=300&titles=${encodeURIComponent(chunk.join('|'))}`)).json();
        const alias = new Map();
        [...(j.query?.normalized || []), ...(j.query?.redirects || [])].forEach(r => alias.set(r.to, [...(alias.get(r.to) || []), r.from]));
        (j.query?.pages || []).forEach(p => {
          const src = p.thumbnail?.source || p.imageinfo?.[0]?.thumburl || '';
          if (!src) return;
          const names = [p.title, ...(alias.get(p.title) || [])];
          names.forEach(t => { found.set(t, p.title); (alias.get(t) || []).forEach(a => found.set(a, p.title)); });
        });
      } catch { return; } // offline: try again next time
    }
    want.forEach((cands, id) => { skyImgs[id] = cands.map(c => found.get(c)).find(Boolean) || ''; });
    try { localStorage.setItem(SKY_IMG_KEY, JSON.stringify(skyImgs)); } catch { /* storage full */ }
    if (skyDialog.open && skyEditId) showSkyWikiLink();
  });
}

function renderSky() {
  const owned = skyOwned();
  const value = owned.reduce((a, it) => a + itemStats(it).value, 0);
  const cost = owned.reduce((a, it) => a + itemStats(it).cost, 0);
  const count = owned.reduce((a, it) => a + (it.qty || 1), 0);
  $('#skyStats').innerHTML =
    statTile('Worth', money(value)) + statTile('Paid', money(cost)) +
    statTile('Gain / loss', signedMoney(value - cost), cls(value - cost)) +
    statTile('Owned', count.toLocaleString()) + statTile('Wishlist', skyWished().length.toLocaleString());
  $('#skyHome').hidden = !!skyGameId;
  $('#skyGame').hidden = !skyGameId;
  if (skyGameId) renderSkyGame(); else renderSkyHome();
}

function renderSkyHome() {
  const have = skyHoldings();
  $('#skyGames').innerHTML = SKYD.games.map(g => {
    const list = SKYD.items.filter(i => i.game === g.id);
    const own = list.filter(i => have.get(i.id)?.qty).length;
    return `<button class="set-card" data-sky-game="${esc(g.id)}">
      <span class="nologo sky-logo">${esc(g.year || '★')}</span>
      <span><b>${esc(g.name)}</b><small>${list.length} items${own ? ` · ${own} owned` : ''}</small>
      ${own ? `<div class="mini"><span style="width:${Math.min(100, own / list.length * 100)}%"></span></div>` : ''}</span>
    </button>`;
  }).join('');
  const q = $('#skySearchAll').value.trim().toLowerCase();
  const box = $('#skySearchResults');
  box.hidden = !q;
  $('#skyGames').hidden = !!q;
  if (q) {
    const words = q.split(/\s+/);
    const hits = SKYD.items.filter(i => words.every(w => `${i.name} ${i.note || ""} ${i.type} ${skyGameName(i.game)}`.toLowerCase().includes(w)));
    box.innerHTML = hits.length ? hits.slice(0, 200).map(i => skyRow(i, have, true)).join('')
      : '<p class="note">Nothing matches that. Try just the name, like "Spyro".</p>';
  }
}

// Photo for an item: SkylandersCharacterList (with permission) when they have it, else PriceCharting.
const skyPhoto = (def, big = false) => def.scl
  ? `https://skylanderscharacterlist.com/wp-content/uploads/${big ? def.scl.replace(/-200x200(\.\w+)$/, "$1") : def.scl}`
  : def.photo ? `https://storage.googleapis.com/images.pricecharting.com/${def.photo}/${big ? 1600 : 240}.jpg` : "";
function skyRow(i, have, showGame = false) {
  const h = have.get(i.id);
  const state = h?.qty ? 'owned' : h?.wish ? 'wish' : 'missing';
  const mark = state === 'owned' ? '✓' : state === 'wish' ? '♥' : '';
  const v = h?.own ? itemStats(h.own) : null;
  return `<button class="sky-row ${state}" data-sky="${esc(i.id)}">
    <span class="mark">${mark}</span>
    <span class="sky-thumb">${skyPhoto(i) ? `<img src="${skyPhoto(i)}" alt="" loading="lazy">` : ''}</span>
    <span class="grow"><b>${esc(i.name)}</b><small>${esc([i.note, showGame && skyGameName(i.game), i.type, h?.own?.condition, h?.qty > 1 && `×${h.qty}`].filter(Boolean).join(' · '))}</small></span>
    <span class="price">${v?.priced ? money(v.unit) : ''}</span></button>`;
}

function renderSkyGame() {
  const g = SKYD.games.find(x => x.id === skyGameId) || {};
  const list = SKYD.items.filter(i => i.game === skyGameId);
  const have = skyHoldings();
  $('#skyTitle').textContent = g.name ? (g.id === 'other' ? g.name : `Skylanders ${g.name}`) : '';
  $('#skySub').textContent = [g.year, `${list.length} items`, g.note].filter(Boolean).join(' · ');
  const ownedN = list.filter(i => have.get(i.id)?.qty).length;
  const wishN = list.filter(i => have.get(i.id)?.wish).length;
  const worth = list.reduce((a, i) => a + (have.get(i.id)?.own ? itemStats(have.get(i.id).own).value : 0), 0);
  const pctOwned = list.length ? ownedN / list.length * 100 : 0;
  $('#skyProgress').innerHTML = `<b>${ownedN} / ${list.length}</b> owned (${pctOwned.toFixed(0)}%)
    <div class="meter"><span style="width:${pctOwned}%"></span></div>
    <span class="muted">${wishN} on wishlist · yours worth ${money(worth)}</span>`;
  $$('#skyChips button').forEach(b => b.classList.toggle('on', b.dataset.f === skyMode));

  const types = SKYD.types.filter(t => list.some(i => i.type === t));
  const sel = $('#skyType'), cur = sel.value;
  sel.innerHTML = '<option value="">All types</option>' + types.map(t => `<option${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
  const q = $('#skySearch').value.trim().toLowerCase();
  const shown = list.filter(i => {
    const h = have.get(i.id);
    return (skyMode === 'all' || (skyMode === 'owned' && h?.qty) || (skyMode === 'missing' && !h?.qty) || (skyMode === 'wish' && h?.wish)) &&
      (!sel.value || i.type === sel.value) && (!q || `${i.name} ${i.note || ''}`.toLowerCase().includes(q));
  });
  $('#skyList').innerHTML = shown.length ? types.map(t => {
    const rows = shown.filter(i => i.type === t).sort((a, b) => a.name.localeCompare(b.name));
    return rows.length ? `<h3 class="sky-type">${esc(t)} <span class="muted small">${rows.length}</span></h3>` + rows.map(i => skyRow(i, have)).join('') : '';
  }).join('') : `<p class="note">${{ owned: 'You don\'t own anything from this game yet.', missing: 'You have everything here! 🎉', wish: 'Nothing from this game on your wishlist.' }[skyMode] || 'Nothing matches that search.'}</p>`;
}

function openSkyGame(id) {
  skyGameId = id; skyMode = 'all';
  $('#skySearch').value = ''; $('#skyType').value = '';
  renderSky();
  window.scrollTo({ top: 0 });
}
$('#skyGames').addEventListener('click', e => { const b = e.target.closest('[data-sky-game]'); if (b) openSkyGame(b.dataset.skyGame); });
$('#skyBack').addEventListener('click', () => { skyGameId = ''; renderSky(); window.scrollTo({ top: 0 }); });
$('#skyChips').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { skyMode = b.dataset.f; renderSkyGame(); } });
$('#skyType').addEventListener('change', renderSkyGame);
$('#skySearch').addEventListener('input', renderSkyGame);
$('#skySearchAll').addEventListener('input', renderSkyHome);
['#skyList', '#skySearchResults'].forEach(s => $(s).addEventListener('click', e => {
  const b = e.target.closest('[data-sky]');
  if (b) openSkyItem(b.dataset.sky);
}));

// ---- add / edit one item ----
const skyDialog = $('#skyDialog'), skyForm = $('#skyForm');
let skyEditId = '';
// The wiki doesn't allow its pictures to be shown inside other sites, so link to the page that has it.
// Photo at the top of the pop-up; tap it to see it full screen.
function showSkyPhoto(def) {
  const img = $('#skyDImg');
  img.hidden = !skyPhoto(def);
  if (skyPhoto(def)) { img.src = skyPhoto(def); img.title = def.photoLike && !def.scl ? 'Photo of a similar version' : ''; }
}
$('#skyDImg').addEventListener('click', () => {
  const def = SKYD.byId.get(skyEditId);
  if (!def || !skyPhoto(def)) return;
  const v = $('#imgView'), img = $('#imgViewImg');
  img.onerror = null; img.hidden = false; img.src = skyPhoto(def, true);
  v.showModal();
});

function showSkyWikiLink() {
  const def = SKYD.byId.get(skyEditId);
  if (!def) return;
  const page = skyImgs[skyEditId];
  $('#skyDWiki').href = page
    ? `https://skylanders.fandom.com/wiki/${encodeURIComponent(page.replace(/ /g, '_')).replace(/%3A/g, ':')}`
    : `https://skylanders.fandom.com/wiki/Special:Search?query=${encodeURIComponent(def.name.split(/ - |\s*\[/)[0])}`;
}
function openSkyItem(skyId) {
  const def = SKYD.byId.get(skyId);
  if (!def) return;
  skyEditId = skyId;
  const h = skyHoldings().get(skyId) || {};
  const own = h.own, f = skyForm.elements;
  $('#skyDName').textContent = def.name;
  $('#skyDMeta').textContent = [def.note, `Skylanders ${skyGameName(def.game)}`.replace('Skylanders Other items', 'Skylanders'), def.type].filter(Boolean).join(' · ');
  $('#skyDHave').textContent = [own ? `✓ In your collection${own.qty > 1 ? ` (×${own.qty})` : ''}` : '', h.wish ? '♥ On your wishlist' : ''].filter(Boolean).join(' · ');
  f.condition.value = own?.condition || 'Loose';
  f.qty.value = own?.qty || 1;
  f.paid.value = own?.paid ?? '';
  const last = own ? sortedPrices(own).pop() : null;
  f.value.value = last ? last.price : '';
  f.notes.value = own?.notes || '';
  $('#skyDEbay').href = ebayUrl(`skylanders ${def.name.replace(/[[\]]/g, ' ')}`);
  $('#skyDSave').innerHTML = own ? '&#10003; Save changes' : '&#10003; Add to collection';
  $('#skyDWish').innerHTML = h.wish ? '&#9829; Remove from wishlist' : '&#9825; Add to wishlist';
  $('#skyDWish').hidden = !!own;
  $('#skyDDelete').hidden = !own;
  showSkyWikiLink();
  showSkyPhoto(def);
  skyDialog.showModal();
  loadSkyImages([def]);
}

skyForm.addEventListener('submit', e => {
  e.preventDefault();
  const def = SKYD.byId.get(skyEditId), f = skyForm.elements;
  const h = skyHoldings().get(skyEditId) || {};
  let it = h.own;
  const isNew = !it;
  if (!it) {
    it = migrate({ kind: 'sky', list: 'sky', skyId: def.id, name: def.name, setName: `Skylanders ${skyGameName(def.game)}`,
      productType: def.type, added: today(), prices: [] });
    items.push(it);
  }
  it.condition = f.condition.value;
  it.qty = Math.max(1, parseInt(f.qty.value) || 1);
  it.paid = num(f.paid.value);
  it.notes = f.notes.value.trim();
  if (num(f.value.value) != null) upsertPrice(it, today(), num(f.value.value), 'Manual');
  if (isNew && h.wish) items = items.filter(i => i !== h.wish); // got it: off the wishlist
  save();
  skyDialog.close();
  renderSky();
  toast(isNew ? `✓ Added ${def.name}` : `✓ Saved ${def.name}`);
});

$('#skyDWish').addEventListener('click', () => {
  const def = SKYD.byId.get(skyEditId);
  const h = skyHoldings().get(skyEditId) || {};
  if (h.wish) { items = items.filter(i => i !== h.wish); toast(`Removed ${def.name} from your wishlist`); }
  else {
    items.push(migrate({ kind: 'sky', list: 'skywish', skyId: def.id, name: def.name, setName: `Skylanders ${skyGameName(def.game)}`,
      productType: def.type, added: today(), prices: [] }));
    toast(`♥ Added ${def.name} to your wishlist`);
  }
  save(); skyDialog.close(); renderSky();
});

$('#skyDDelete').addEventListener('click', () => {
  const def = SKYD.byId.get(skyEditId);
  const h = skyHoldings().get(skyEditId) || {};
  if (!h.own || !confirm(`Remove ${def.name} from your Skylanders collection?`)) return;
  items = items.filter(i => i !== h.own);
  save(); skyDialog.close(); renderSky();
  toast(`Removed ${def.name}`);
});

function showPage(p, { scroll = true } = {}) {
  page = p;
  $('#pageCollection').hidden = p !== 'collection';
  $('#pageSets').hidden = p !== 'sets';
  $('#pageSky').hidden = p !== 'sky';
  $('#pageSettings').hidden = p !== 'settings';
  $$('#bottomNav button').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  if (p === 'sets') renderSetsView();
  if (p === 'sky') renderSky();
  if (p === 'settings') { renderSyncSettings(); fillWorkerSetting(); renderAlertsSetting(); storeSyncMeta(); }
  if (p === 'collection') render();
  if (scroll) window.scrollTo({ top: 0 });
}
$('#bottomNav').addEventListener('click', e => {
  const b = e.target.closest('[data-page]');
  if (!b) return;
  // Tapping Sets again while inside a set goes back to the list of sets.
  if (b.dataset.page === 'sets' && page === 'sets' && browseSetId) { browseSetId = ''; renderSetsView(); window.scrollTo({ top: 0 }); return; }
  if (b.dataset.page === 'sky' && page === 'sky' && skyGameId) { skyGameId = ''; renderSky(); window.scrollTo({ top: 0 }); return; }
  showPage(b.dataset.page);
});

// =====================================================================
// Start
// =====================================================================
showPage(page, { scroll: false });
updateRefreshStatus();
updateSyncBadge();
syncNow().then(checkAlertsInApp);
storeSyncMeta();
loadSets().then(() => {
  fillBrowseSets();
  if (page === 'sets') renderSetsView();
  const last = +localStorage.getItem(REFRESH_KEY);
  if (items.length && Date.now() - last > 12 * 36e5) refreshAll();
});
setInterval(updateRefreshStatus, 60e3);
