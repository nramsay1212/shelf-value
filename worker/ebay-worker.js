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

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (url.pathname !== '/search') {
      return json({ ok: true, service: 'shelf-value-ebay', keysSet: !!(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) }, 200, cors);
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
};
