# Shelf Value

A free Pokémon card collection tracker with automatic prices.

**Live app:** https://nramsay1212.github.io/shelf-value/

## Features

- **Card lookup:** search any Pokémon TCG card by name and/or set, with card images
- **Automatic prices:** TCGplayer market prices for each version (Normal, Holo, Reverse Holo, 1st Edition…), refreshed daily when you open the app
- **Collection value chart:** value vs. total paid over time, with 1M / 3M / 6M / 1Y / All ranges
- **Categories:** group cards however you like (Binder 1, Vintage, For trade…) and filter by them
- **Wishlist:** track cards you want, with a target price that's highlighted when the market drops to it
- **Grading picks:** for raw Near Mint cards, PSA 10 / PSA 9 prices from eBay listings (or sold prices you enter) give a
  "Grade it / Borderline / Keep it raw" verdict, based on your grading fees and odds of a 10
- **Graded cards and sealed product:** valued from eBay listing ranges (see below), or prices you log yourself
- One-click **eBay sold listings** and **TCGplayer** links for every item
- **Rapid scan:** scan a stack of cards back-to-back, review the matches, add them all at once
- **Sold & trades log:** record sales and trades (fees included) and see your real profit
- **Grading tracker:** track cards sent to PSA/CGC/BGS, update the status, enter the grade when it comes back
- Export/import as JSON (backup) or CSV (spreadsheet)

## Your data

Everything is stored in your browser, and optionally backed up and synced between devices (see below).
Each browser/device has its own copy, so use **Data → Export backup** and **Import** to move it, and back up now and then.

## How prices work

Card data and prices come from the free [TCGdex](https://tcgdex.dev) API, which provides TCGplayer market prices (USD).
These reflect Near Mint raw cards. Price history builds up from the days you open the app.
Graded cards and sealed product are valued from eBay listing ranges once the price worker is set up (below).

## eBay price ranges (optional, free)

Graded cards (PSA/CGC/BGS…), sealed product and grading picks get **price ranges from current eBay
Buy It Now listings**, e.g. "PSA 10: $13,200 – $16,800, typical $13,850 (3 listings)".
This uses eBay's free API (5,000 searches/day) through a small Cloudflare Worker you own,
so your eBay keys never appear in this public website.

1. **eBay keys:** sign up at [developer.ebay.com](https://developer.ebay.com), create a **Production** keyset
   (choose the *exemption* for Marketplace Account Deletion notifications, since no eBay user data is stored),
   and note the **App ID (Client ID)** and **Cert ID (Client Secret)**.
2. **Worker:** in the [Cloudflare dashboard](https://dash.cloudflare.com) (free plan) go to
   **Workers & Pages → Create → Create Worker**, name it e.g. `shelf-value-ebay`, **Deploy**, then **Edit code**,
   replace everything with [`worker/ebay-worker.js`](worker/ebay-worker.js) and **Deploy** again.
3. **Secrets:** in the worker's **Settings → Variables and Secrets**, add two variables of type **Secret**:
   `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`.
4. **Connect:** copy the worker's address (`https://shelf-value-ebay.<you>.workers.dev`), open the app,
   click **⚙ Settings**, paste it and **Save & test**.

Asking prices run higher than what cards actually sell for, so the "typical" value uses the cheaper end
of the range (25th percentile). Raw cards keep using TCGplayer market prices for their value.
If you host the app somewhere other than `nramsay1212.github.io`, add a plain-text variable
`ALLOWED_ORIGINS` to the worker with your site's address.

## Run locally

Plain HTML/CSS/JS, no build step:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080

Not affiliated with Nintendo, The Pokémon Company, TCGplayer, or any grading company.

## Backup & sync (optional, free)

The same Cloudflare worker also stores a synced copy of your collection (Cloudflare KV, free plan).
In **⚙ Settings → Back up & sync**, enter the invite code to create a collection and get a private
**sync code**; enter that sync code on your other devices to share the same collection. Each person
gets their own code and their own separate collection. Only a SHA-256 fingerprint of each code is stored.

Worker setup for sync: bind a KV namespace as `SYNC` and add a secret `INVITE_CODE`.

## Daily price history & wishlist alerts

The worker runs every 30 minutes (Cloudflare cron, free). Once a day it looks up today's TCGplayer
price for every raw card in each synced collection (in small batches to stay inside free limits),
adds it to the card's price history, and checks wishlist target prices. When a wishlist card is at
or below its target, the person's phones get a notification (Web Push; turn it on in ⚙ Settings —
on iPhone the app must be opened from its Home Screen icon, iOS 16.4+).

Worker setup: cron trigger `*/30 * * * *`, plain-text variable `VAPID_PUBLIC` and secret
`VAPID_PRIVATE_JWK` (a P-256 key pair).
