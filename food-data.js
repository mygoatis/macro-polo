// food-data.js — Open Food Facts lookups (free, no API key). Maps to Tally's nutrition shape.

const OFF = 'https://world.openfoodfacts.org';
const FIELDS = [
  'product_name', 'brands', 'serving_size', 'serving_quantity', 'nutriments', 'code', 'image_small_url',
].join(',');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// Build a per-serving nutrition object from an OFF product.
function mapProduct(p) {
  const n = p.nutriments || {};
  const hasServing = n['energy-kcal_serving'] != null || n['proteins_serving'] != null;
  const pick = (base) => hasServing ? num(n[base + '_serving']) : num(n[base + '_100g']);
  const kcal = hasServing
    ? num(n['energy-kcal_serving']) || num(n['energy-kcal_value'])
    : num(n['energy-kcal_100g']) || num(n['energy-kcal_value']);

  const sodiumG = hasServing ? num(n['sodium_serving']) : num(n['sodium_100g']);
  const servingLabel = hasServing
    ? (p.serving_size || (p.serving_quantity ? `${p.serving_quantity} g` : '1 serving'))
    : '100 g';

  return {
    name: (p.product_name || '').trim() || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim(),
    barcode: p.code || '',
    unit: servingLabel,
    image: p.image_small_url || '',
    per: {
      kcal: Math.round(kcal),
      protein: round1(pick('proteins')),
      carbs: round1(pick('carbohydrates')),
      fat: round1(pick('fat')),
      sodium: Math.round(sodiumG * 1000), // g -> mg
      fiber: round1(pick('fiber')),
      sugar: round1(pick('sugars')),
    },
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
