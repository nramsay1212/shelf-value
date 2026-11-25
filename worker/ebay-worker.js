// Shelf Value - eBay price worker (Cloudflare Workers, free plan)
//
// Holds your eBay API keys so they never appear in the public website, and
// returns current eBay "Buy It Now" listings for a search. The app turns those
// listings into price ranges.
//
// Setup (Cloudflare dashboard):
//   Workers & Pages -> Create -> Worker -> Deploy -> Edit code -> paste this file -> Deploy
//   Settings -> Variables and Secrets -> add two *Secret* variables:
//     EBAY_CLIENT_ID      (eBay App ID / Client ID)
//     EBAY_CLIENT_SECRET  (eBay Cert ID / Client Secret)
//   Optional plain-text variable ALLOWED_ORIGINS (comma separated) to change which
//   websites may use this worker.
//
// Results are cached for 12 hours, so repeat searches don't use eBay quota
// (eBay's free limit is 5,000 searches a day).
//
// Collection sync also lives here: bind a KV namespace as SYNC and add an
// INVITE_CODE secret (people need it once to turn sync on).
//
// PSA cert lookup: add a Secret PSA_TOKEN (free key from psacard.com/publicapi,
// 100 lookups a day). Only people with a sync code can use it, and each cert is
// remembered for 30 days so repeat lookups don't use the daily allowance.

const DEFAULT_ORIGINS = 'https://nramsay1212.github.io,http://localhost:8080';
const CACHE_SECONDS = 12 * 60 * 60;
const CARD_CATEGORY = '183454'; // eBay: CCG Individual Cards

let tokenCache = { token: null, expires: 0 };

async function getToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error('EBAY_CLIENT_ID / EBAY_CLIENT_SECRET secrets are not set on this worker');
  }
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    throw new Error('eBay sign-in failed: ' + (data.error_description || data.error || r.status));
  }
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// ---------------------------------------------------------------------------
// Collection sync (Cloudflare KV, free plan)
//
// Each person has a private sync code. Only a SHA-256 fingerprint of the code is
// used as the storage key, so the stored data never reveals anyone's code.
// New codes can only be created with the INVITE_CODE secret.
//   POST /sync/register  {invite}        create a new (empty) collection for this code
//   GET  /sync                           -> { rev, updated, data }
//   PUT  /sync           {baseRev, data} save; 409 + current copy if someone else saved first
// The code travels in the X-Sync-Code header.
// ---------------------------------------------------------------------------
const MAX_SYNC_BYTES = 5 * 1024 * 1024;

async function syncKey(code) {
  const bytes = new TextEncoder().encode('shelf-value:' + code.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'col:' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleSync(req, env, url, cors) {
  if (!env.SYNC) return json({ error: 'Sync storage is not set up on this worker' }, 503, cors);
  const code = req.headers.get('X-Sync-Code') || '';
  if (code.trim().length < 12) return json({ error: 'Missing or too-short sync code' }, 400, cors);
  const key = await syncKey(code);

  if (url.pathname === '/sync/register' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (!env.INVITE_CODE || (body.invite || '').trim().toLowerCase() !== env.INVITE_CODE.trim().toLowerCase()) {
      return json({ error: 'That invite code is not right' }, 403, cors);
    }
    if (await env.SYNC.get(key)) return json({ ok: true, existed: true }, 200, cors);
    await env.SYNC.put(key, JSON.stringify({ rev: 0, updated: new Date().toISOString(), data: null }));
    return json({ ok: true, created: true }, 200, cors);
  }

  const current = await env.SYNC.get(key, 'json');
  if (!current) return json({ error: 'No collection found for that sync code' }, 404, cors);
  const hash = key.slice(4);

  // Send a test notification to this person's phones right now.
  if (url.pathname === '/sync/push/test' && req.method === 'POST') {
    const subs = (await env.SYNC.get('push:' + hash, 'json')) || [];
    if (!subs.length) return json({ ok: false, devices: 0, error: 'No devices have price alerts turned on for this collection' }, 200, cors);
    await env.SYNC.put('alerts:' + hash, JSON.stringify({ at: Date.now(), test: true, list: [] }));
    const result = await sendPushes(env, hash, true);
    return json({ ok: result.sent > 0, devices: subs.length, ...result }, 200, cors);
  }
  // Phone notifications: save / remove this device's push subscription.
  if (url.pathname === '/sync/push') {
    const body = await req.json().catch(() => ({}));
    let subs = (await env.SYNC.get('push:' + hash, 'json')) || [];
    if (req.method === 'POST') {
      const sub = body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return json({ error: 'Bad subscription' }, 400, cors);
      subs = subs.filter(s => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, added: Date.now() }]).slice(-6);
      await env.SYNC.put('push:' + hash, JSON.stringify(subs));
      return json({ ok: true, devices: subs.length }, 200, cors);
    }
    if (req.method === 'DELETE') {
      subs = subs.filter(s => s.endpoint !== body.endpoint);
      await env.SYNC.put('push:' + hash, JSON.stringify(subs));
      return json({ ok: true, devices: subs.length }, 200, cors);
    }
  }
  // The latest price alerts (the notification itself carries no data; the phone fetches this).
  if (url.pathname === '/sync/alerts' && req.method === 'GET') {
    return json((await env.SYNC.get('alerts:' + hash, 'json')) || { at: 0, list: [] }, 200, cors);
  }

  if (url.pathname === '/sync' && req.method === 'GET') return json(current, 200, cors);

  if (url.pathname === '/sync' && req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_SYNC_BYTES) return json({ error: 'Collection is too large to sync' }, 413, cors);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Bad data' }, 400, cors); }
    if (body.baseRev !== current.rev) return json({ error: 'conflict', current }, 409, cors);
    const next = { rev: current.rev + 1, updated: new Date().toISOString(), data: body.data };
    await env.SYNC.put(key, JSON.stringify(next));
    return json({ ok: true, rev: next.rev, updated: next.updated }, 200, cors);
  }
  return json({ error: 'Not found' }, 404, cors);
}

// ---------------------------------------------------------------------------
// Daily prices + wishlist alerts (runs on a schedule, every 30 minutes)
//
// Each day it collects every raw card in every synced collection, looks up
// today's TCGplayer price in small batches (free-plan limits), then adds the
// day's price to each card's history and checks wishlist targets. If a wishlist
// card is at or below its target, it saves an alert and pings the person's
// phones (Web Push, VAPID; no payload — the phone fetches /sync/alerts).
// ---------------------------------------------------------------------------
const BATCH = 20;

async function listAll(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.SYNC.list({ prefix, cursor });
    page.keys.forEach(k => keys.push(k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return keys;
}

// Same version keys the app uses: "normal", "holofoil", ... and "<variantId>~<key>" for special printings.
function priceMap(card) {
  const out = {};
  const add = (prefix, tp) => Object.entries(tp || {}).forEach(([k, v]) => {
    if (v && typeof v === 'object' && (v.marketPrice != null || v.midPrice != null)) out[prefix + k] = v.marketPrice ?? v.midPrice;
  });
  add('', card.pricing?.tcgplayer);
  (card.variants_detailed || []).forEach(v => add(`${v.variantId}~`, v.pricing?.tcgplayer));
  return out;
}

const isRawCard = it => it && it.kind === 'card' && it.cardId && it.condition !== 'Graded';

async function runDaily(env, { reset = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let st = reset ? null : await env.SYNC.get('cron:state', 'json');
  if (!st || st.date !== today) {
    const ids = new Set();
    for (const k of await listAll(env, 'col:')) {
      const c = await env.SYNC.get(k, 'json');
      (c?.data?.items || []).forEach(it => { if (isRawCard(it)) ids.add(it.cardId); });
    }
    st = { date: today, queue: [...ids], total: ids.size, prices: {}, applied: false };
  }
  const batch = st.queue.splice(0, BATCH);
  await Promise.all(batch.map(async id => {
    try {
      const r = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(id)}`);
      if (r.ok) st.prices[id] = priceMap(await r.json());
    } catch { /* try again tomorrow */ }
  }));
  let result = { date: st.date, remaining: st.queue.length, priced: Object.keys(st.prices).length, total: st.total };
  if (!st.queue.length && !st.applied) {
    result.applied = await applyPrices(env, st);
    st.applied = true;
  }
  await env.SYNC.put('cron:state', JSON.stringify(st));
  return result;
}

async function applyPrices(env, st) {
  const now = Date.now();
  const summary = [];
  for (const k of await listAll(env, 'col:')) {
    const c = await env.SYNC.get(k, 'json');
    if (!c?.data?.items) continue;
    let changed = false;
    const alerts = [];
    c.data.items.forEach(it => {
      if (!isRawCard(it)) return;
      const price = st.prices[it.cardId]?.[it.variant];
      if (price == null) return;
      it.prices = it.prices || [];
      const existing = it.prices.find(p => p.date === st.date && p.source === 'TCGplayer market');
      if (!existing) { it.prices.push({ id: crypto.randomUUID().slice(0, 12), date: st.date, price, source: 'TCGplayer market' }); it.updatedAt = now; changed = true; }
      else if (existing.price !== price) { existing.price = price; it.updatedAt = now; changed = true; }
      if (it.list === 'wishlist' && it.target != null && price <= it.target) {
        const last = it.alert;
        if (!last || now - last.at > 7 * 864e5 || price < last.price - 0.009) {
          alerts.push({ name: it.name, set: it.setName || '', number: it.number || '', price, target: it.target });
          it.alert = { at: now, price };
          it.updatedAt = now; changed = true;
        }
      }
    });
    if (changed) await env.SYNC.put(k, JSON.stringify({ rev: c.rev + 1, updated: new Date().toISOString(), data: c.data }));
    let pushed = 0;
    if (alerts.length) {
      const hash = k.slice(4);
      await env.SYNC.put('alerts:' + hash, JSON.stringify({ at: now, list: alerts }));
      pushed = await sendPushes(env, hash);
    }
    summary.push({ changed, alerts: alerts.length, pushed });
  }
  return summary;
}

// ---- Web Push (VAPID, empty message) ----
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function vapidJwt(env, aud) {
  const enc = s => b64url(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://nramsay1212.github.io/shelf-value/' })}`;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

async function sendPushes(env, hash, detailed = false) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC) return detailed ? { sent: 0, errors: ['alert keys missing on worker'] } : 0;
  const subs = (await env.SYNC.get('push:' + hash, 'json')) || [];
  const keep = [], errors = [];
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'high', 'Content-Length': '0',
          Authorization: `vapid t=${await vapidJwt(env, new URL(s.endpoint).origin)}, k=${env.VAPID_PUBLIC}` },
      });
      if (r.status === 404 || r.status === 410) { errors.push(`${new URL(s.endpoint).host}: device unsubscribed (${r.status})`); continue; }
      if (r.ok) sent++;
      else errors.push(`${new URL(s.endpoint).host}: ${r.status} ${(await r.text()).slice(0, 160)}`);
      keep.push(s);
    } catch (e) { errors.push(e.message); keep.push(s); }
  }
  if (keep.length !== subs.length) await env.SYNC.put('push:' + hash, JSON.stringify(keep));
  return detailed ? { sent, errors } : sent;
}

// ---------------------------------------------------------------------------
// PSA cert lookup
async function handlePsa(req, env, url, cors) {
  if (!env.PSA_TOKEN) return json({ error: 'The PSA key is not set up on the worker yet (secret PSA_TOKEN)' }, 503, cors);
  if (!env.SYNC) return json({ error: 'Sync storage is not set up on this worker' }, 503, cors);
  const code = req.headers.get('X-Sync-Code') || '';
  if (code.trim().length < 12 || !(await env.SYNC.get(await syncKey(code)))) {
    return json({ error: 'Turn on Back up & sync in Settings to use PSA lookup' }, 403, cors);
  }
  const cert = (url.searchParams.get('cert') || '').replace(/\D/g, '');
  if (cert.length < 5 || cert.length > 12) return json({ error: "That doesn't look like a PSA cert number" }, 400, cors);

  const cacheKey = 'psa:' + cert;
  const cached = await env.SYNC.get(cacheKey, 'json');
  if (cached && !url.searchParams.has('fresh')) return json({ ...cached, cached: true }, 200, cors);

  const r = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`, {
    headers: { Authorization: 'bearer ' + env.PSA_TOKEN.trim(), Accept: 'application/json' },
  });
  if (r.status === 429) return json({ error: "PSA's daily limit (100 lookups) is used up. Try again tomorrow." }, 429, cors);
  if (r.status === 401 || r.status === 403) return json({ error: 'PSA did not accept the key. Make a new one at psacard.com/publicapi and update PSA_TOKEN.' }, 502, cors);
  if (!r.ok) return json({ error: `PSA returned ${r.status}` }, 502, cors);
  const data = await r.json().catch(() => null);
  const c = data && data.PSACert;
  if (!c || !c.CertNumber) return json({ error: 'PSA has no card with that cert number' }, 404, cors);

  const num = v => (v === undefined || v === null || v === '' ? null : Number(v));
  const out = {
    cert: String(c.CertNumber),
    year: c.Year || '',
    brand: c.Brand || '',          // usually the set, e.g. "POKEMON SWORD & SHIELD EVOLVING SKIES"
    category: c.Category || '',
    number: c.CardNumber || '',
    subject: c.Subject || '',      // the card name, e.g. "UMBREON VMAX"
    variety: c.Variety || '',      // e.g. "ALTERNATE ART SECRET"
    grade: c.CardGrade || '',      // e.g. "GEM MT 10"
    gradeText: c.GradeDescription || '',
    labelType: c.LabelType || '',
    population: num(c.TotalPopulation),
    populationHigher: num(c.PopulationHigher),
    checkedAt: Date.now(),
  };
  await env.SYNC.put(cacheKey, JSON.stringify(out), { expirationTtl: 30 * 24 * 60 * 60 });
  return json(out, 200, cors);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Code',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (url.pathname.startsWith('/sync')) {
      if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
      return handleSync(req, env, url, cors);
    }
    if (url.pathname === '/psa/cert' && req.method === 'GET') {
      if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
      return handlePsa(req, env, url, cors);
    }
    // Manual run of the daily job (for testing); needs the invite code.
    if (url.pathname === '/admin/run-daily' && req.method === 'POST') {
      if (!env.SYNC || !env.INVITE_CODE || req.headers.get('X-Admin') !== env.INVITE_CODE) return json({ error: 'Not allowed' }, 403, cors);
      return json(await runDaily(env, { reset: url.searchParams.get('reset') === '1' }), 200, cors);
    }
    if (url.pathname !== '/search') {
      return json({ ok: true, service: 'shelf-value-ebay', keysSet: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
        sync: !!env.SYNC, psa: !!env.PSA_TOKEN, vapidPublicKey: env.VAPID_PUBLIC || null }, 200, cors);
    }
    if (origin && !allowed.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

    const q = (url.searchParams.get('q') || '').trim().slice(0, 150);
    const type = url.searchParams.get('type') === 'sealed' ? 'sealed' : 'card';
    if (!q) return json({ error: 'Missing q' }, 400, cors);

    const cache = caches.default;
    const cacheKey = new Request(`https://shelf-value.cache/${type}?q=${encodeURIComponent(q.toLowerCase())}`);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(await hit.text(), { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });

    try {
      const token = await getToken(env);
      const params = new URLSearchParams({
        q,
        limit: '200',
        filter: 'buyingOptions:{FIXED_PRICE},priceCurrency:USD',
      });
      if (type === 'card') params.set('category_ids', CARD_CATEGORY);
      const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?' + params, {
        headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
      });
      if (!r.ok) return json({ error: `eBay returned ${r.status}`, detail: (await r.text()).slice(0, 300) }, 502, cors);
      const data = await r.json();
      const items = (data.itemSummaries || []).map(it => {
        const price = parseFloat(it.price?.value || 0);
        const ship = parseFloat(it.shippingOptions?.[0]?.shippingCost?.value || 0);
        return {
          title: it.title,
          price: Math.round((price + ship) * 100) / 100,
          url: it.itemWebUrl,
          image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || '',
        };
      }).filter(i => i.price > 0);
      const body = JSON.stringify({ q, type, total: data.total || 0, items, fetched: new Date().toISOString() });
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
      })));
      return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'MISS' } });
    } catch (err) {
      return json({ error: err.message }, 500, cors);
    }
  },

  // Runs on the schedule set in Cloudflare (every 30 minutes).
  async scheduled(event, env, ctx) {
    if (env.SYNC) ctx.waitUntil(runDaily(env));
  },
};
