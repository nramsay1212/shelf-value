# Shelf Value

A free Pokémon card collection tracker with automatic prices.

**Live app:** https://nramsay1212.github.io/shelf-value/

## Features

- **Card lookup:** search any Pokémon TCG card by name and/or set, with card images
- **Automatic prices:** TCGplayer market prices for each version (Normal, Holo, Reverse Holo, 1st Edition…), refreshed daily when you open the app
- **Collection value chart:** value vs. total paid over time, with 1M / 3M / 6M / 1Y / All ranges
- **Categories:** group cards however you like (Binder 1, Vintage, For trade…) and filter by them
- **Wishlist:** track cards you want, with a target price that's highlighted when the market drops to it
- **Grading picks:** for raw Near Mint cards, enter recent PSA 10 / PSA 9 sold prices and get a
  "Grade it / Borderline / Keep it raw" verdict, based on your grading fees and odds of a 10
- **Graded cards and sealed product:** track them too, with prices you log yourself
- One-click **eBay sold listings** and **TCGplayer** links for every item
- Export/import as JSON (backup) or CSV (spreadsheet)

## Your data

Everything is stored in your browser's local storage; nothing is uploaded.
Each browser/device has its own copy, so use **Data → Export backup** and **Import** to move it, and back up now and then.

## How prices work

Card data and prices come from the free [TCGdex](https://tcgdex.dev) API, which provides TCGplayer market prices (USD).
These reflect Near Mint raw cards. Price history builds up from the days you open the app.
Graded cards and sealed product don't have automatic prices; log them from eBay sold listings.

## Run locally

Plain HTML/CSS/JS, no build step:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080

Not affiliated with Nintendo, The Pokémon Company, TCGplayer, or any grading company.
