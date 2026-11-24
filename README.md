# Shelf Value

A free, self-hosted price tracker for game and collectible collections.

- Track items with platform, condition, quantity, what you paid and when
- Log prices over time and see a chart per item and for your whole collection
- Total value, cost basis and gain/loss at a glance
- One-click **eBay sold listings** search for any item, so logging real prices is quick
- Flags items you haven't re-priced in 90+ days
- Export/import as JSON (backup) or CSV (spreadsheet)
- Light and dark mode

Everything is stored in your browser's local storage. Nothing is sent anywhere.
Export a JSON backup now and then, and use it to move your data between browsers or devices.

## Run it

It's plain HTML/CSS/JS with no build step.

- **Online:** enable GitHub Pages for this repo (Settings → Pages → deploy from `main`, root).
- **Locally:** `powershell -ExecutionPolicy Bypass -File serve.ps1`, then open http://localhost:8080

## CSV format

`name,platform,condition,qty,paid,acquired,notes,price_date,price,price_source`

One row per price point; rows with the same name + platform + condition are grouped into one item.
