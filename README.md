# Macro Polo — food & body log

A minimalist, installable PWA for logging food, weight, and waist. No backend, no
hosting bill: all your data lives **on your device** (IndexedDB), and the optional AI
features call the Claude API directly from your phone using **your own** API key.
Auto light/dark — follows your phone's system setting.

## Tabs

- **Food** — a macro donut (protein/carbs/fat, calories in the center) and a single,
  flat food list. Tap any food to see its full nutrient breakdown and adjust the
  logged volume with a stepper. Copy a whole day → multiple days in one action, and
  multi-select items to copy or delete.
- **Nutrients** — full per-day nutrient breakdown (calories, macros, sodium/fiber/sugar),
  swipe left/right to move between days.
- **Body** — log weight + waist for any date (backfill), attach **progress photos**,
  and view auto-scaling line charts with preset or custom date ranges. Tap a photo to
  open a **side-by-side comparison viewer** with a scroll strip to pick any other day.
- **Charts** — per-nutrient history as line graphs.

## Adding food (four ways)

Personal library (one-tap re-log), barcode scan (Open Food Facts, free), database
search, and **photo → AI estimate** (Claude vision).

## Solver & Dietician

- **Solver** — instant math: pick a food and a target ("hit 2,400 cal today") and it
  computes the quantity. No API key needed.
- **Dietician** — an AI chat (your Claude key) for natural-language requests and
  nutrition questions; it can propose changes you apply with one tap.

## Run locally

```bash
cd tally
python -m http.server 8766
# open http://localhost:8766
```

A server is needed (ES modules + service worker won't run from a `file://` URL).

## Deploy for free (GitHub Pages)

1. Push this folder to a GitHub repo.
2. **Settings → Pages → Deploy from a branch**, pick `main` / root.
3. Live at `https://<you>.github.io/<repo>/` over HTTPS (required for install + camera).
   Cloudflare Pages and Netlify work the same way, also free.

## Install on your phone

Open the URL in mobile Chrome/Safari → **Add to Home Screen**. Runs full-screen,
offline-capable.

## AI features (optional)

Settings → paste a Claude API key from console.anthropic.com. Stored **only on this
device**; used for photo estimates and the dietician. The math solver needs no key.

## Backup

Settings → **Export JSON** (full backup, includes progress photos) or **Export CSV**.
**Import JSON** restores on any device. Your API key is never included in exports.

## Files

| File | Role |
|------|------|
| `index.html` | shell + service-worker registration |
| `app.js` | UI, routing, all screens & interactions |
| `db.js` | IndexedDB data layer + export/import |
| `charts.js` | dependency-free SVG charts (line + macro donut) |
| `food-data.js` | Open Food Facts barcode + search |
| `ai.js` | Claude API (photo estimate + dietician) |
| `sw.js` | offline cache |
| `styles.css` | minimalist theme (auto light/dark) |
