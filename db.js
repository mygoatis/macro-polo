// db.js — IndexedDB wrapper. All data lives on-device.

const DB_NAME = 'tally';
const DB_VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('foods')) {
        const s = db.createObjectStore('foods', { keyPath: 'id' });
        s.createIndex('name', 'nameLower', { unique: false });
        s.createIndex('barcode', 'barcode', { unique: false });
      }
      if (!db.objectStoreNames.contains('body')) {
        db.createObjectStore('body', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
function reqP(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

export function uid() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
}
// NOTE: uid() uses Date.now/Math.random — fine at runtime in the browser.

// ---------- Entries ----------
export async function getEntries(date) {
  const store = await tx('entries', 'readonly');
  const idx = store.index('date');
  const list = await reqP(idx.getAll(IDBKeyRange.only(date)));
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
export async function getAllEntries() {
  const store = await tx('entries', 'readonly');
  return reqP(store.getAll());
}
export async function putEntry(entry) {
  const store = await tx('entries', 'readwrite');
  await reqP(store.put(entry));
  return entry;
}
export async function putEntries(entries) {
  const store = await tx('entries', 'readwrite');
  await Promise.all(entries.map((e) => reqP(store.put(e))));
  return entries;
}
export async function deleteEntries(ids) {
  const store = await tx('entries', 'readwrite');
  await Promise.all(ids.map((id) => reqP(store.delete(id))));
}

// ---------- Foods (library) ----------
export async function getFoods() {
  const store = await tx('foods', 'readonly');
  const list = await reqP(store.getAll());
  return list.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
}
export async function putFood(food) {
  food.nameLower = (food.name || '').toLowerCase();
  const store = await tx('foods', 'readwrite');
  await reqP(store.put(food));
  return food;
}
export async function deleteFood(id) {
  const store = await tx('foods', 'readwrite');
  await reqP(store.delete(id));
}
export async function findFoodByBarcode(code) {
  const store = await tx('foods', 'readonly');
  const idx = store.index('barcode');
  const list = await reqP(idx.getAll(IDBKeyRange.only(code)));
  return list[0] || null;
}

// ---------- Body ----------
export async function getBody(date) {
  const store = await tx('body', 'readonly');
  return (await reqP(store.get(date))) || null;
}
export async function getAllBody() {
  const store = await tx('body', 'readonly');
  const list = await reqP(store.getAll());
  return list.sort((a, b) => a.date.localeCompare(b.date));
}
export async function putBody(rec) {
  const store = await tx('body', 'readwrite');
  // remove the record entirely if nothing is left on it
  if (rec.weight == null && rec.waist == null && !rec.note && (!rec.photos || !rec.photos.length)) {
    await reqP(store.delete(rec.date));
    return null;
  }
  await reqP(store.put(rec));
  return rec;
}
export async function deleteBody(date) {
  const store = await tx('body', 'readwrite');
  await reqP(store.delete(date));
}

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  key: 'app',
  units: { weight: 'lb', length: 'in' },
  goals: { kcal: 2400, protein: 180, carbs: 240, fat: 70, sodium: 2300, fiber: 30, sugar: 50 },
  meals: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'],
  apiKey: '',
  model: 'claude-haiku-4-5-20251001',
  fdcKey: '', // USDA FoodData Central key for food search; blank = shared DEMO_KEY
};

export async function getSettings() {
  const store = await tx('settings', 'readonly');
  const s = await reqP(store.get('app'));
  if (!s) return structuredClone(DEFAULT_SETTINGS);
  // deep-merge defaults so new fields appear after upgrades
  return {
    ...DEFAULT_SETTINGS, ...s,
    units: { ...DEFAULT_SETTINGS.units, ...(s.units || {}) },
    goals: { ...DEFAULT_SETTINGS.goals, ...(s.goals || {}) },
    meals: s.meals && s.meals.length ? s.meals : DEFAULT_SETTINGS.meals,
  };
}
export async function saveSettings(s) {
  s.key = 'app';
  const store = await tx('settings', 'readwrite');
  await reqP(store.put(s));
  return s;
}

// ---------- Export / Import ----------
export async function exportAll() {
  const [entries, foods, body, settings] = await Promise.all([
    getAllEntries(), getFoods(), getAllBody(), getSettings(),
  ]);
  const safeSettings = { ...settings, apiKey: '' }; // never export the API key
  return { app: 'tally', version: DB_VERSION, exportedAt: new Date().toISOString(), entries, foods, body, settings: safeSettings };
}

export async function importAll(data, { merge = true } = {}) {
  const db = await open();
  if (!merge) {
    await Promise.all(['entries', 'foods', 'body'].map((name) => {
      const store = db.transaction(name, 'readwrite').objectStore(name);
      return reqP(store.clear());
    }));
  }
  if (data.entries) await putEntries(data.entries);
  if (data.foods) for (const f of data.foods) await putFood(f);
  if (data.body) { const store = await tx('body', 'readwrite'); await Promise.all(data.body.map((b) => reqP(store.put(b)))); }
  if (data.settings) {
    const cur = await getSettings();
    await saveSettings({ ...cur, ...data.settings, apiKey: cur.apiKey }); // keep existing key
  }
}
