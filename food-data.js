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

export async function searchFoods(query) {
  const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=24&fields=${FIELDS}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Tally/1.0 (personal)' } });
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return (data.products || [])
    .map(mapProduct)
    .filter((p) => p.per.kcal > 0 && p.name !== 'Unnamed product');
}
