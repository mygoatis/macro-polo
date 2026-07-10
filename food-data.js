// food-data.js — Open Food Facts lookups (free, no API key). Maps to Tally's nutrition shape.

const OFF = 'https://world.openfoodfacts.org';
const FIELDS = [
  'product_name', 'brands', 'brand_owner', 'serving_size', 'serving_quantity', 'nutriments', 'code', 'image_small_url',
].join(',');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Map an OFF product into our per-100g model. The key detail: OFF gives nutrition
// both per 100 g and per serving, and (usually) the grams in one serving. We store
// accurate per-100-g values plus the real grams-per-serving so that switching units
// later (tbsp, cup, oz, grams) stays mathematically correct.
function mapProduct(p) {
  const n = p.nutriments || {};

  // Grams in one serving, if OFF knows it (serving_quantity is grams; else parse "2 tbsp (32 g)").
  let gServing = num(p.serving_quantity);
  if (!gServing && p.serving_size) { const m = /([\d.]+)\s*g\b/i.exec(p.serving_size); if (m) gServing = num(m[1]); }

  const has100 = n['energy-kcal_100g'] != null || n['proteins_100g'] != null || n['carbohydrates_100g'] != null || n['fat_100g'] != null;
  const hasServing = n['energy-kcal_serving'] != null || n['proteins_serving'] != null;

  let per100, unit, gPerUom;
  if (has100) {
    // Best case: real per-100-g nutrition.
    per100 = {
      kcal: Math.round(num(n['energy-kcal_100g']) || num(n['energy-kcal_value'])),
      protein: round1(num(n['proteins_100g'])),
      carbs: round1(num(n['carbohydrates_100g'])),
      fat: round1(num(n['fat_100g'])),
      sodium: Math.round(num(n['sodium_100g']) * 1000), // g -> mg
      fiber: round1(num(n['fiber_100g'])),
      sugar: round1(num(n['sugars_100g'])),
    };
    if (gServing) { unit = 'serving'; gPerUom = gServing; }   // default to 1 serving of the right size
    else { unit = 'g'; gPerUom = 1; }                          // no serving size known -> log by grams
  } else if (hasServing && gServing) {
    // Only per-serving nutrition, but we know the serving grams: scale up to per-100-g.
    const f = 100 / gServing;
    per100 = {
      kcal: Math.round((num(n['energy-kcal_serving']) || num(n['energy-kcal_value'])) * f),
      protein: round1(num(n['proteins_serving']) * f),
      carbs: round1(num(n['carbohydrates_serving']) * f),
      fat: round1(num(n['fat_serving']) * f),
      sodium: Math.round(num(n['sodium_serving']) * 1000 * f),
      fiber: round1(num(n['fiber_serving']) * f),
      sugar: round1(num(n['sugars_serving']) * f),
    };
    unit = 'serving'; gPerUom = gServing;
  } else {
    // Last resort: per-serving nutrition with unknown serving grams. Treat the serving as
    // the unit itself (100 g placeholder) so calories are right, even if unit-switching is approximate.
    per100 = {
      kcal: Math.round(num(n['energy-kcal_serving']) || num(n['energy-kcal_value']) || num(n['energy-kcal_100g'])),
      protein: round1(num(n['proteins_serving']) || num(n['proteins_100g'])),
      carbs: round1(num(n['carbohydrates_serving']) || num(n['carbohydrates_100g'])),
      fat: round1(num(n['fat_serving']) || num(n['fat_100g'])),
      sodium: Math.round((num(n['sodium_serving']) || num(n['sodium_100g'])) * 1000),
      fiber: round1(num(n['fiber_serving']) || num(n['fiber_100g'])),
      sugar: round1(num(n['sugars_serving']) || num(n['sugars_100g'])),
    };
    unit = 'serving'; gPerUom = 100;
  }

  const per = {}; for (const k in per100) per[k] = per100[k] * gPerUom / 100; // per single unit, for display
  const qty = unit === 'g' ? 100 : 1;

  return {
    name: (p.product_name || '').trim() || 'Unnamed product',
    brand: ((p.brands || '').split(',')[0].trim()) || (p.brand_owner || '').trim(),
    barcode: p.code || '',
    image: p.image_small_url || '',
    servingLabel: (p.serving_size || '').trim(),
    servingGrams: gServing || null,
    unit, gPerUom, qty, per100, per,
  };
}
function round1(n) { return Math.round(n * 10) / 10; }

export async function lookupBarcode(code) {
  const url = `${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Tally/1.0 (personal)' } });
  if (!res.ok) throw new Error('Lookup failed');
  const data = await res.json();
  if (data.status !== 1 || !data.product) return null;
  return mapProduct(data.product);
}

// Text search uses USDA FoodData Central — Open Food Facts' search endpoints are
// unreliable from the browser (no CORS on the fast service; 503s/timeouts on the rest).
// FDC is CORS-enabled and dependable. DEMO_KEY works out of the box (rate-limited);
// users can add a free key in Settings for unlimited use.
const FDC = 'https://api.nal.usda.gov/fdc/v1/foods/search';

function titleish(s) {
  s = (s || '').trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s;
}

function usdaPer(food) {
  const list = food.foodNutrients || [];
  const val = (name, unit) => {
    const n = list.find((x) => x.nutrientName === name && (!unit || (x.unitName || '').toUpperCase() === unit));
    return n ? num(n.value) : 0;
  };
  const energy = val('Energy', 'KCAL') || val('Energy', '');
  return {
    kcal: Math.round(energy),
    protein: round1(val('Protein')),
    carbs: round1(val('Carbohydrate, by difference')),
    fat: round1(val('Total lipid (fat)')),
    sodium: Math.round(val('Sodium, Na')),
    fiber: round1(val('Fiber, total dietary')),
    sugar: round1(val('Sugars, total including NLEA') || val('Sugars, total')),
  };
}

export async function searchFoods(query, apiKey) {
  const key = (apiKey || '').trim() || 'DEMO_KEY';
  const url = `${FDC}?query=${encodeURIComponent(query)}&pageSize=25&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('Search limit reached. Add a free USDA key in Settings.');
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return (data.foods || [])
    .map((f) => ({
      name: titleish(f.description),
      brand: titleish(f.brandName || f.brandOwner || ''),
      barcode: f.gtinUpc || '',
      unit: '100 g',
      image: '',
      per: usdaPer(f),
    }))
    .filter((p) => p.per.kcal > 0 && p.name);
}
