// app.js — Macro Polo main controller.
const APP_VERSION = 'v1.53';
import * as DB from './db.js';
import { lineChart, attachScrub, resetScrubData } from './charts.js';
import * as AI from './ai.js';
import { lookupBarcode, searchFoods } from './food-data.js';

// ---------------- State ----------------
const S = {
  tab: 'food', // food | nutrients | body | charts
  date: todayStr(),
  settings: null,
  selection: new Set(),
  body: { mode: '90', from: null, to: null },
  chart: { metric: 'kcal', mode: '30', from: null, to: null },
  chat: [],
  pendingActions: null,
  sort: 'manual', // manual | kcal | carbs | protein | fat | az
};

const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'sodium', 'fiber', 'sugar'];
const NUT = [
  { k: 'kcal', label: 'Calories', unit: 'cal', color: 'var(--cal)' },
  { k: 'protein', label: 'Protein', unit: 'g', color: 'var(--protein)' },
  { k: 'carbs', label: 'Carbs', unit: 'g', color: 'var(--carbs)' },
  { k: 'fat', label: 'Fat', unit: 'g', color: 'var(--fat)' },
  { k: 'sodium', label: 'Sodium', unit: 'mg', color: 'var(--sodium)' },
  { k: 'fiber', label: 'Fiber', unit: 'g', color: 'var(--fiber)' },
  { k: 'sugar', label: 'Sugar', unit: 'g', color: 'var(--sugar)' },
];
const META = Object.fromEntries(NUT.map((n) => [n.k, n]));
const unitOf = (k) => META[k].unit;
const RANGE_LABEL = { '7': '1W', '30': '1M', '90': '3M', '180': '6M', '365': '1Y', all: 'All' };

// Units of measure. Mass units have a fixed grams-per-unit; volume/count units
// carry an editable default (grams per one unit) so nutrition scales from per-100g.
const UNIT_G = { g: 1, oz: 28.3495, lb: 453.592, mg: 0.001, kg: 1000, ml: 1, cup: 240, tbsp: 15, tsp: 5, serving: 100, piece: 50, slice: 30 };
const MASS_UNITS = new Set(['g', 'oz', 'lb', 'mg', 'kg']);
const UOM_LIST = ['g', 'oz', 'ml', 'cup', 'tbsp', 'tsp', 'serving', 'piece', 'slice'];
// Quick multipliers under the amount stepper — each scales the current amount.
const MULTIPLIERS = [['⅓', 1 / 3], ['½', 0.5], ['⅔', 2 / 3], ['1.5', 1.5], ['2', 2], ['3', 3]];

// Macro-vs-calorie sanity check using Atwater factors (carbs 4, protein 4, fat 9).
// US labels fold fiber into total carbs, but fiber only yields ~2 cal/g and makers
// aren't consistent about it — so accept a band between counting fiber at 4 and at 2.
function macroCalRange(n) {
  const c = Number(n.carbs) || 0, p = Number(n.protein) || 0, f = Number(n.fat) || 0;
  const fib = Math.min(Math.max(Number(n.fiber) || 0, 0), c);
  const high = 4 * c + 4 * p + 9 * f;
  return { low: Math.max(0, high - 2 * fib), high };
}
function macrosValidate(n) {
  const kcal = Number(n?.kcal) || 0;
  const c = Number(n?.carbs) || 0, p = Number(n?.protein) || 0, f = Number(n?.fat) || 0;
  if (kcal <= 0 || (c === 0 && p === 0 && f === 0)) return false;   // nothing to check against
  const { low, high } = macroCalRange(n);
  // 9%: USDA uses food-specific Atwater factors (meat protein is ~4.27/g), so the general
  // 4/4/9 underestimates lean meat by ~5%. Still flags anything off by 10% or more.
  const tol = Math.max(0.09 * kcal, 4);                             // floor covers rounding on tiny foods
  return kcal >= low - tol && kcal <= high + tol;
}
const macroTick = (n) => (macrosValidate(n) ? svg('checkCircle', 'macro-ok') : '');
function uomOptions(sel) {
  const inList = UOM_LIST.includes(sel);
  return UOM_LIST.map((u) => `<option value="${u}" ${u === sel ? 'selected' : ''}>${u}</option>`).join('')
    + (inList ? '' : `<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
}

// Resolve an entry/food to a per-100g model + its unit. New foods store per100/gPerUom;
// legacy entries (per + unit string) are derived best-effort.
function unitModel(e) {
  if (e && e.per100 && e.gPerUom) return { per100: e.per100, uom: e.unit || 'g', gPerUom: e.gPerUom, amount: e.qty || 1 };
  const pu = parseUnit((e && e.unit) || '1 serving');
  const label = (pu.label || 'serving').toLowerCase();
  const gPerUom = UNIT_G[label] != null ? UNIT_G[label] : 100;
  const servingGrams = (pu.num || 1) * gPerUom;
  const per100 = {}; for (const k of NUTRIENTS) per100[k] = servingGrams ? ((e && e.per && e.per[k]) || 0) * 100 / servingGrams : ((e && e.per && e.per[k]) || 0);
  const uom = UOM_LIST.includes(label) ? label : (MASS_UNITS.has(label) ? label : 'serving');
  return { per100, uom, gPerUom, amount: ((e && e.qty) || 1) * (pu.num || 1) };
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

// ---------------- Date helpers ----------------
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function pad(n) { return String(n).padStart(2, '0'); }
function addDays(str, n) { const d = new Date(str + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dayLabel(str) {
  if (str === todayStr()) return 'Today';
  if (str === addDays(todayStr(), -1)) return 'Yesterday';
  if (str === addDays(todayStr(), 1)) return 'Tomorrow';
  return new Date(str + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fullDate(str) { return new Date(str + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); }

// ---------------- Nutrition helpers ----------------
// Totals come from the per-100g model, not the cached `per` field: the two can drift
// (per is only a cache of per100 x gPerUom/100), and per100 is the source of truth.
// For legacy entries with no per100, unitModel derives it from `per` and this round-trips.
function entryTotals(e) {
  const m = unitModel(e);
  const o = {}; for (const k of NUTRIENTS) o[k] = (m.per100[k] || 0) * (m.gPerUom || 0) / 100 * (m.amount || 0);
  return o;
}
function sumTotals(entries) { const o = {}; for (const k of NUTRIENTS) o[k] = 0; for (const e of entries) { const t = entryTotals(e); for (const k of NUTRIENTS) o[k] += t[k]; } return o; }
function K(n) { return Math.round(n || 0); }
function G(n) { return Math.round((n || 0) * 10) / 10; }
function nutrientRows(vals, keys) {
  return keys.map((k) => { const n = META[k];
    return `<div class="nut-row"><span class="dot" style="background:${n.color}"></span>
      <span class="nl">${n.label}</span><span class="nv">${k === 'kcal' ? K(vals[k]) : G(vals[k])}<small>${n.unit}</small></span></div>`;
  }).join('');
}
// Split a unit like "100 g" -> {num:100, label:'g'}, "1 cup" -> {num:1, label:'cup'}.
function parseUnit(u) {
  const m = /^\s*([\d.]+)\s*(.*)$/.exec(u || '');
  if (m && m[1]) return { num: Number(m[1]) || 1, label: (m[2] || 'unit').trim() || 'unit' };
  return { num: 1, label: (u || 'serving').trim() || 'serving' };
}
// Amount shown in the unit's own measure, no "×": qty 1.5 of "100 g" -> "150 g".
function portionText(e) { const { num, label } = parseUnit(e.unit); return `${G((e.qty || 1) * num)} ${label}`; }

// ---------------- Icons ----------------
const I = {
  food: '<path d="M2.5 12h19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.5 12a8.5 8.5 0 0 0 17 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M6.5 12a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  nutrients: '<rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  body: '<rect x="3.5" y="4" width="17" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="14" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 14l1.9-1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  charts: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  gear: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 6.6 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.9H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.6 7.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 .9 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  minus: '<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" stroke-width="2"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="9.5" r="1.8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 17l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v12M13 6v12M16 6v12M20 6v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sort: '<path d="M8 5v14M8 19l-3.5-3.5M8 19l3.5-3.5M16 19V5M16 5l-3.5 3.5M16 5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  checkCircle: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12.4l2.6 2.6L16 9.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  dish: '<path d="M3.5 12.5a8.5 8.5 0 0 1 17 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M2.5 12.5h19M6 16.5h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11.2v5M12 7.6v.9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z" fill="currentColor"/>',
  chevL: '<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevR: '<path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  scale: '<path d="M12 4v3M7 7h10l3 8a4 4 0 0 1-8 0l3-8M7 7l-3 8a4 4 0 0 0 8 0L7 7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 9h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="8" y="6" width="8" height="3" rx="1" fill="currentColor"/><circle cx="9" cy="13" r="1.1" fill="currentColor"/><circle cx="12" cy="13" r="1.1" fill="currentColor"/><circle cx="15" cy="13" r="1.1" fill="currentColor"/><circle cx="9" cy="17" r="1.1" fill="currentColor"/><circle cx="12" cy="17" r="1.1" fill="currentColor"/><circle cx="15" cy="17" r="1.1" fill="currentColor"/>',
  edit: '<path d="M4 20h4L18 10a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16v4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 7l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};
function svg(name, cls = '') { return `<svg class="${cls}" viewBox="0 0 24 24">${I[name]}</svg>`; }

// ---------------- DOM utils ----------------
const $app = document.getElementById('app');
const $sheetHost = document.getElementById('sheet-host');
const $toastHost = document.getElementById('toast-host');
function node(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastTimer = null;
function toast(msg, undoFn) {
  $toastHost.innerHTML = '';
  const t = node(`<div class="toast"><span>${esc(msg)}</span>${undoFn ? '<span class="undo">Undo</span>' : ''}</div>`);
  if (undoFn) t.querySelector('.undo').onclick = () => { clearTimeout(toastTimer); $toastHost.innerHTML = ''; undoFn(); };
  $toastHost.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), undoFn ? 5000 : 2200);
}

function openSheet(title, bodyHTML, footHTML, headActions, opts = {}) {
  const back = node(`<div class="sheet-backdrop"><div class="sheet${opts.full ? ' full' : ''}">
    <div class="sheet-head"><div class="grip"></div><h2>${esc(title)}</h2>
      ${headActions || ''}<button class="icon-btn" data-close>${svg('x')}</button></div>
    <div class="sheet-body">${bodyHTML}</div>
    ${footHTML ? `<div class="sheet-foot">${footHTML}</div>` : ''}
  </div></div>`);
  back.addEventListener('click', (e) => { if (e.target === back) closeSheet(back); });
  back.querySelector('[data-close]').onclick = () => closeSheet(back);
  $sheetHost.appendChild(back);
  sheetStack.push(back);
  return back;
}
function closeSheet(back) { back.remove(); const i = sheetStack.indexOf(back); if (i >= 0) sheetStack.splice(i, 1); }

// ---- Android / browser back: close the top modal, else step back a tab, else exit ----
const sheetStack = [];
const tabHistory = [];
function initBackButton() {
  try { history.pushState({ mp: 1 }, ''); } catch {}
  window.addEventListener('popstate', () => {
    if (sheetStack.length) { sheetStack.pop().remove(); try { history.pushState({ mp: 1 }, ''); } catch {} return; }
    if (tabHistory.length) { S.tab = tabHistory.pop(); S.selection.clear(); render(); try { history.pushState({ mp: 1 }, ''); } catch {} return; }
    // nothing left to close — let the next back actually leave the app
  });
}

// ---------------- Day navigation ----------------
// Move the selected day by exactly `delta` days (±1) and re-render with a slide.
function changeDay(delta) {
  if (!delta) return;
  dateDir = delta > 0 ? 1 : -1;
  S.date = addDays(S.date, delta > 0 ? 1 : -1);
  S.selection.clear();
  render();
}

// One horizontal swipe = one day, on the Food and Nutrients tabs.
function initSwipe() {
  let x0 = 0, y0 = 0, tracking = false;
  const THRESH = 55;   // min horizontal travel (px) to count as a swipe
  const RATIO = 1.4;   // must be this much more horizontal than vertical
  document.addEventListener('touchstart', (e) => {
    tracking = false;
    if (S.tab !== 'food' && S.tab !== 'nutrients') return;
    if (sheetStack.length) return;                       // a sheet is open
    if (e.touches.length !== 1) return;                  // pinch / multi-touch
    if (e.target.closest('input, textarea, select, button, .selbar')) return;
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; tracking = true;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!tracking) return; tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < THRESH || Math.abs(dx) < Math.abs(dy) * RATIO) return;
    changeDay(dx < 0 ? 1 : -1);   // swipe left → next day, swipe right → previous day
  }, { passive: true });
}

// ---------------- Delight animations ----------------
let animOn = true;       // animations enabled (user setting, default on)
function setAnim(on) { animOn = !!on; document.body.classList.toggle('anim', animOn); }
let foodPrev = null;     // previous food totals (for count-up)
let foodAnim = null;     // animation payload for the food afterRender hook
let enterEntryId = null; // newly added entry id to animate in
let pendingGain = 0;     // +cal amount to float up
let dateDir = 0;         // -1 = previous day, +1 = next day
function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch {} }
function countUp(el, to, from) {
  if (!el) return; to = Math.round(to || 0); from = Math.round(from || 0);
  if (!animOn || from === to) { el.textContent = to; return; }
  const dur = 450, t0 = performance.now();
  (function step(t) {
    const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step); else el.textContent = to;
  })(t0);
}
function floatGain(g) {
  const top = $app.querySelector('.cal-top'), num = $app.querySelector('.cal-num');
  if (!top || !num || g <= 0) return;
  top.style.position = 'relative';
  const f = document.createElement('span');
  f.className = 'cal-float'; f.textContent = '+' + g + ' cal';
  f.style.left = (num.offsetWidth + 10) + 'px'; f.style.top = '2px';
  top.appendChild(f); f.addEventListener('animationend', () => f.remove());
}

// ---------------- Render ----------------
async function render() {
  if (!S.settings) S.settings = await DB.getSettings();
  resetScrubData();
  let bodyHTML = '';
  if (S.tab === 'food') bodyHTML = await renderFood();
  else if (S.tab === 'nutrients') bodyHTML = await renderNutrients();
  else if (S.tab === 'body') bodyHTML = await renderBody();
  else if (S.tab === 'charts') bodyHTML = await renderCharts();
  $app.innerHTML = header() + bodyHTML + tabbar();
  document.body.classList.toggle('tab-food', S.tab === 'food');   // enables the frozen-list layout
  renderSelbar();
  saveUI();
  if (S.tab === 'food' && foodAnim && foodAnim.animate) {
    const fa = foodAnim;
    countUp($app.querySelector('.cal-num'), fa.totals.kcal, fa.prev.kcal);
    const nums = $app.querySelectorAll('.macro-chip .num');
    ['carbs', 'protein', 'fat'].forEach((k, i) => countUp(nums[i], fa.totals[k], fa.prev[k]));
    requestAnimationFrame(() => $app.querySelectorAll('.macro-seg.grow > i').forEach((el) => { el.style.width = el.dataset.w + '%'; }));
    if (pendingGain > 0) floatGain(pendingGain);
  }
  pendingGain = 0; foodAnim = null;
  if (S.tab === 'body' || S.tab === 'charts') attachScrub($app);
  if (S.tab === 'nutrients') {
    const sc = document.getElementById('nutscroll');
    const target = sc?.querySelector(`[data-date="${S.date}"]`) || sc?.lastElementChild;
    if (sc && target) sc.scrollLeft = target.offsetLeft;
    if (sc) {
      let raf;
      sc.addEventListener('scroll', () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const idx = Math.round(sc.scrollLeft / sc.clientWidth);
          const p = sc.children[idx];
          if (p && p.dataset.date && p.dataset.date !== S.date) {
            S.date = p.dataset.date;
            const cur = document.querySelector('.app-header .current');
            if (cur) { cur.classList.toggle('is-today', S.date === todayStr()); cur.innerHTML = `${dayLabel(S.date)}<small>${fullDate(S.date)}</small>`; }
            const dp = document.getElementById('datepick'); if (dp) dp.value = S.date;
          }
        });
      });
    }
  }
}

function dateNav() {
  const isToday = S.date === todayStr();
  return `<div class="date-nav">
      <button class="arrow" data-act="date-prev">${svg('chevL')}</button>
      <button class="current ${isToday ? 'is-today' : ''}" data-act="date-pick">${dayLabel(S.date)}<small>${fullDate(S.date)}</small></button>
      <button class="arrow" data-act="date-next">${svg('chevR')}</button>
    </div>
    <input type="date" id="datepick" value="${S.date}" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0">`;
}

function header() {
  const sortBtn = `<button class="icon-btn ${S.sort !== 'manual' ? 'on' : ''}" data-act="sort" title="Sort foods">${svg('sort')}</button>`;
  const actions = `<button class="icon-btn" data-act="chat" title="Dietician">${svg('spark')}</button><button class="icon-btn" data-act="settings">${svg('gear')}</button>`;
  if (S.tab === 'food') {
    return `<div class="app-header">
      <div class="row"><span class="brand-mark" aria-hidden="true"></span><h1 class="brand-title">Macro Polo</h1>${sortBtn}${actions}</div>
      ${dateNav()}</div>`;
  }
  if (S.tab === 'nutrients' || S.tab === 'body') {
    const title = S.tab === 'nutrients' ? 'Nutrients' : 'Progress';
    return `<div class="app-header"><div class="row"><h1>${title}</h1>${actions}</div>${dateNav()}</div>`;
  }
  return `<div class="app-header"><div class="row"><h1>Charts</h1>${actions}</div></div>`;
}

function tabbar() {
  const tab = (id, label, icon) => `<button class="${S.tab === id ? 'active' : ''}" data-act="tab" data-tab="${id}">${svg(icon)}<span>${label}</span></button>`;
  return `<nav class="tabbar">${tab('food', 'Food', 'food')}${tab('nutrients', 'Nutrients', 'nutrients')}${tab('body', 'Progress', 'body')}${tab('charts', 'Charts', 'charts')}</nav>`;
}

// ---------- Food tab ----------
async function renderFood() {
  const entries = await DB.getEntries(S.date);
  if (S.sort === 'az') entries.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  else if (S.sort !== 'manual') entries.sort((a, b) => (entryTotals(b)[S.sort] || 0) - (entryTotals(a)[S.sort] || 0));
  const totals = sumTotals(entries);

  // decide whether to animate (only when the day's totals actually changed)
  const changed = !foodPrev || NUTRIENTS.some((k) => K(foodPrev[k]) !== K(totals[k]));
  const animate = animOn && changed;
  foodAnim = { animate, totals, prev: foodPrev || {} };
  foodPrev = totals;
  const enterId = enterEntryId; enterEntryId = null;
  const slideCls = dateDir > 0 ? ' slide-next' : dateDir < 0 ? ' slide-prev' : ''; dateDir = 0;

  const chip = (k) => `<div class="macro-chip"><span class="dot" style="background:${META[k].color}"></span>
    <div><div class="v"><span class="num">${K(totals[k])}</span><small>g</small></div><div class="l">${META[k].label}</div></div></div>`;
  const mk = { carbs: totals.carbs * 4, protein: totals.protein * 4, fat: totals.fat * 9 };
  const mkSum = (mk.carbs + mk.protein + mk.fat) || 1;
  const seg = (k) => { const pct = (mk[k] / mkSum) * 100; return `<i data-w="${pct}" style="width:${animate ? 0 : pct}%;background:${META[k].color}"></i>`; };
  const summary = `<div class="card">
    <div class="cal-top"><span class="cal-num">${K(totals.kcal)}</span><span class="cal-lbl">cal</span></div>
    <div class="macro-seg${animate ? ' grow' : ''}">${seg('carbs')}${seg('protein')}${seg('fat')}</div>
    <div class="macro-chips">${chip('carbs')}${chip('protein')}${chip('fat')}</div>
  </div>`;

  const actions = `<div class="quick-actions">
    <button class="btn" data-act="copy-day">${svg('copy')} Copy day…</button>
    <button class="btn primary" data-act="add-food">${svg('plus')} Add food</button>
  </div>`;

  let listHTML = '';
  for (const e of entries) {
    const t = entryTotals(e);
    const sel = S.selection.has(e.id);
    listHTML += `<div class="entry ${sel ? 'sel' : ''}${e.id === enterId ? ' entry-enter' : ''}" data-act="entry" data-id="${e.id}">
      <button class="check" data-act="toggle" data-id="${e.id}">${sel ? svg('check') : ''}</button>
      <div class="body"><div class="name">${esc(e.name)}${macroTick(t)}</div><div class="meta">${e.brand ? `<span class="brand">${esc(e.brand)}</span> · ` : ''}${esc(portionText(e))}</div></div>
      <div class="entry-stats">
        <div class="es"><b>${K(t.carbs)}</b><small>C</small></div>
        <div class="es"><b>${K(t.protein)}</b><small>P</small></div>
        <div class="es"><b>${K(t.fat)}</b><small>F</small></div>
        <div class="es cal"><b>${K(t.kcal)}</b><small>cal</small></div>
      </div>
    </div>`;
  }
  if (!entries.length) listHTML = `<div class="empty">Nothing logged yet.<br>Tap “Add food” to start.</div>`;

  // Long-press any checkbox to select all (hint shown once).
  if (entries.length && !localStorage.getItem('mp.hintSel')) {
    localStorage.setItem('mp.hintSel', '1');
    setTimeout(() => toast('Tip: hold a checkbox to select all'), 500);
  }

  return `<div class="screen food-screen${slideCls}">${summary}${actions}<div class="food-list">${listHTML}</div></div>`;
}

function renderSelbar() {
  const existing = document.querySelector('.selbar');
  if (existing) existing.remove();
  if (S.tab !== 'food' || S.selection.size === 0) return;
  const bar = node(`<div class="selbar">
    <span class="count">${S.selection.size} selected</span>
    <button data-act="sel-copy" title="Copy or move" aria-label="Copy or move">${svg('copy')}</button>
    ${S.selection.size > 1 ? `<button data-act="sel-dish" title="Save as dish" aria-label="Save as dish">${svg('dish')}</button>` : ''}
    <button class="danger" data-act="sel-delete" title="Delete" aria-label="Delete">${svg('trash')}</button>
    <button data-act="sel-clear" title="Clear selection" aria-label="Clear selection">${svg('x')}</button>
  </div>`);
  document.body.appendChild(bar);
}

// ---------- Nutrients tab (one day at a time; swipe or arrows to change day) ----------
async function renderNutrients() {
  const entries = await DB.getEntries(S.date);
  const totals = sumTotals(entries);
  const count = entries.length;
  const slideCls = dateDir > 0 ? ' slide-next' : dateDir < 0 ? ' slide-prev' : ''; dateDir = 0;

  return `<div class="screen${slideCls}">
    <div class="section-title">Calories</div>
    <div class="card cal-hero"><span class="v">${K(totals.kcal)}</span><span class="u">cal · ${count} item${count === 1 ? '' : 's'}</span></div>
    <div class="section-title">Macros</div>
    <div class="card nut-rows">${nutrientRows(totals, ['carbs', 'protein', 'fat'])}</div>
    <div class="section-title">Micronutrients</div>
    <div class="card nut-rows">${nutrientRows(totals, ['sodium', 'fiber', 'sugar'])}</div>
  </div>`;
}

// ---------- Body tab ----------
function bodyRange(all) {
  const m = S.body.mode;
  if (m === 'all') return all;
  if (m === 'custom') { const f = S.body.from, t = S.body.to; return all.filter((r) => (!f || r.date >= f) && (!t || r.date <= t)); }
  const cutoff = addDays(todayStr(), -Number(m) + 1);
  return all.filter((r) => r.date >= cutoff);
}

async function renderBody() {
  const all = await DB.getAllBody();
  const today = await DB.getBody(S.date) || {};
  const u = S.settings.units;

  const ranged = bodyRange(all);
  const wPts = ranged.filter((r) => r.weight != null).map((r) => ({ x: r.date, y: r.weight }));
  const sPts = ranged.filter((r) => r.waist != null).map((r) => ({ x: r.date, y: r.waist }));

  // Placeholder shows the most recent prior value so the trend is visible on empty days.
  const priorW = [...all].reverse().find((r) => r.date < S.date && r.weight != null);
  const priorS = [...all].reverse().find((r) => r.date < S.date && r.waist != null);
  const ring = `<svg class="prog-ring" preserveAspectRatio="xMidYMid meet"><rect fill="none" stroke="var(--cal)" stroke-width="2" stroke-linecap="round"></rect></svg>`;
  const quick = `<div class="card">
    <div class="prog-row2">
      <div class="prog-field">
        <label>Weight (${u.weight})</label>
        <div class="prog-inwrap ${today.weight != null ? 'logged' : ''}" id="wwrap">
          <input class="input prog-in" id="qw" inputmode="decimal" placeholder="Weight" value="${today.weight ?? (priorW ? G(priorW.weight) : '')}">${ring}
        </div>
      </div>
      <div class="prog-field">
        <label>Waist (${u.length})</label>
        <div class="prog-inwrap ${today.waist != null ? 'logged' : ''}" id="swrap">
          <input class="input prog-in" id="qs" inputmode="decimal" placeholder="Waist" value="${today.waist ?? (priorS ? G(priorS.waist) : '')}">${ring}
        </div>
      </div>
      <div class="prog-btns">
        ${photoInline(today, S.date)}
        <button class="icon-btn" data-act="body-pickdate" title="Change date">${svg('calendar')}</button>
        <button class="icon-btn primary" data-act="body-save" title="Save">${svg('check')}</button>
      </div>
    </div>
    <input type="date" id="bodydate" value="${S.date}" style="position:absolute;opacity:0;pointer-events:none;width:0;height:0">
    <input type="file" id="qphotofile" accept="image/*" capture="environment" style="display:none">
  </div>`;

  const ranges = ['7', '30', '90', '180', '365', 'all'];
  const rangeBtns = ranges.map((r) => `<button class="${S.body.mode === r ? 'active' : ''}" data-act="body-range" data-r="${r}">${RANGE_LABEL[r]}</button>`).join('')
    + `<button class="${S.body.mode === 'custom' ? 'active' : ''}" data-act="body-range" data-r="custom">Custom</button>`;
  const customRow = S.body.mode === 'custom' ? `<div class="field-row" style="margin-top:10px">
    <div class="field"><label>From</label><input type="date" class="input" id="bf" value="${S.body.from || ''}"></div>
    <div class="field"><label>To</label><input type="date" class="input" id="bt" value="${S.body.to || ''}"></div></div>` : '';

  const charts = `<div class="card">
    <div class="range-seg dates">${rangeBtns}</div>${customRow}
    <div class="section-title" style="margin-top:14px">Weight (${u.weight})</div>${lineChart(wPts, { color: 'var(--weight)', height: 230, unit: u.weight })}
    <div class="section-title" style="margin-top:16px">Waist (${u.length})</div>${lineChart(sPts, { color: 'var(--waist)', height: 230, unit: u.length })}
  </div>`;

  let recent = '';
  const recentList = [...all].reverse().slice(0, 40);
  if (recentList.length) {
    recent = `<div class="section-title">History</div>` + recentList.map((r) => {
      const thumb = (r.photos && r.photos.length)
        ? `<button class="hist-thumb" data-act="photo-open" data-date="${r.date}" data-idx="0"><img src="${r.photos[0]}" alt="">${r.photos.length > 1 ? `<span class="cnt">${r.photos.length}</span>` : ''}</button>` : '';
      return `<div class="list-item" data-act="body-edit" data-date="${r.date}">
        ${thumb}
        <div class="body"><div class="name">${dayLabel(r.date)}</div><div class="meta">${fullDate(r.date)}</div></div>
        <div class="right">${[r.weight != null ? `${G(r.weight)} ${u.weight}` : '', r.waist != null ? `${G(r.waist)} ${u.length}` : ''].filter(Boolean).join(' · ')}</div>
      </div>`;
    }).join('');
  }

  return `<div class="screen">${quick}${charts}${recent}</div>`;
}

function photoStrip(rec, date, editable, opts = {}) {
  const all = rec.photos || [];
  const shown = opts.max ? all.slice(0, opts.max) : all;
  const extra = all.length - shown.length;
  const thumbs = shown.map((url, i) => `<div class="photo-thumb">
    <img src="${url}" data-act="photo-open" data-date="${date}" data-idx="${i}" alt="">
    ${extra > 0 && i === shown.length - 1 ? `<span class="more">+${extra}</span>` : ''}
    ${editable && !opts.compact ? `<button class="rm" data-act="photo-remove" data-date="${date}" data-idx="${i}">${svg('x')}</button>` : ''}
  </div>`).join('');
  const add = editable ? `<button class="photo-add" data-act="body-addphoto">${svg('camera')}${opts.compact ? '' : '<span>Add</span>'}</button>` : '';
  return `<div class="photo-row ${opts.compact ? 'compact' : ''}">${thumbs}${add}</div>`;
}

function photoInline(rec, date) {
  const photos = rec.photos || [];
  if (photos.length) {
    return `<button class="photo-inline" data-act="photo-open" data-date="${date}" data-idx="0" style="background-image:url('${photos[0]}')" title="View photos">${photos.length > 1 ? `<span class="more">+${photos.length - 1}</span>` : ''}</button>`;
  }
  return `<button class="photo-inline add" data-act="body-addphoto" title="Add photo">${svg('camera')}</button>`;
}

function statBlock(pts, unit) {
  if (!pts.length) return '';
  const first = pts[0].y, last = pts[pts.length - 1].y;
  const delta = G(last - first); const sign = delta > 0 ? '+' : '';
  return `<div class="stat-row" style="margin-bottom:10px">
    <div class="stat"><div class="v">${G(last)} <small>${unit}</small></div><div class="l">Latest</div></div>
    <div class="stat"><div class="v">${G(Math.min(...pts.map(p=>p.y)))} to ${G(Math.max(...pts.map(p=>p.y)))}</div><div class="l">Range</div></div>
    <div class="stat"><div class="v">${sign}${delta} <small>${unit}</small></div><div class="l">Change</div></div>
  </div>`;
}

// ---------- Charts tab ----------
function chartRange(map) {
  const m = S.chart.mode; const dates = Object.keys(map).sort();
  if (m === 'custom') { const f = S.chart.from, t = S.chart.to; return dates.filter((d) => (!f || d >= f) && (!t || d <= t)); }
  if (m === 'all') return dates;
  const cutoff = addDays(todayStr(), -Number(m) + 1);
  return dates.filter((d) => d >= cutoff);
}

async function renderCharts() {
  const entries = await DB.getAllEntries();
  const byDate = {};
  for (const e of entries) (byDate[e.date] ||= []).push(e);
  const totalsByDate = {}; for (const d in byDate) totalsByDate[d] = sumTotals(byDate[d]);

  const metric = S.chart.metric;
  const dates = chartRange(totalsByDate);
  const pts = dates.map((d) => ({ x: d, y: metric === 'kcal' ? K(totalsByDate[d][metric]) : G(totalsByDate[d][metric]) }));
  const color = META[metric].color;

  const metricBtns = NUT.map((n) => `<button class="${metric === n.k ? 'active' : ''}" data-act="chart-metric" data-m="${n.k}">${n.label}</button>`).join('');
  const ranges = ['7', '30', '90', '180', '365', 'all'];
  const rangeBtns = ranges.map((r) => `<button class="${S.chart.mode === r ? 'active' : ''}" data-act="chart-range" data-r="${r}">${RANGE_LABEL[r]}</button>`).join('')
    + `<button class="${S.chart.mode === 'custom' ? 'active' : ''}" data-act="chart-range" data-r="custom">Custom</button>`;
  const customRow = S.chart.mode === 'custom' ? `<div class="field-row" style="margin-top:10px">
    <div class="field"><label>From</label><input type="date" class="input" id="cf" value="${S.chart.from || ''}"></div>
    <div class="field"><label>To</label><input type="date" class="input" id="ct" value="${S.chart.to || ''}"></div></div>` : '';

  let stats = '';
  if (pts.length) {
    const vals = pts.map((p) => p.y);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    stats = `<div class="stat-row" style="margin:12px 0">
      <div class="stat"><div class="v">${metric === 'kcal' ? K(avg) : G(avg)}<small>${unitOf(metric)}</small></div><div class="l">Daily avg</div></div>
      <div class="stat"><div class="v">${pts.length}</div><div class="l">Days logged</div></div>
      <div class="stat"><div class="v">${metric === 'kcal' ? K(Math.max(...vals)) : G(Math.max(...vals))}</div><div class="l">Peak</div></div>
    </div>`;
  }

  return `<div class="screen"><div class="card">
    <div class="range-seg" style="margin-bottom:10px">${metricBtns}</div>
    <div class="range-seg dates">${rangeBtns}</div>${customRow}${stats}
    ${lineChart(pts, { color, height: 250, unit: unitOf(metric), round: metric === 'kcal', yMin: 0, yMax: (metric === 'kcal' && pts.some((p) => p.y > 4000)) ? 4000 : undefined })}
  </div></div>`;
}

// ---------------- Entry actions ----------------
async function nextOrder(date) { const es = await DB.getEntries(date); return es.length ? Math.max(...es.map((e) => e.order || 0)) + 1 : 0; }

async function addEntry({ name, unit, qty, per, foodId, brand, barcode, per100, gPerUom, image, serving }) {
  const entry = { id: DB.uid(), date: S.date, name, brand: brand || '', unit: unit || '1 serving', qty: qty || 1, per, foodId, order: await nextOrder(S.date) };
  if (per100) entry.per100 = per100;
  if (gPerUom) entry.gPerUom = gPerUom;
  if (barcode) entry.barcode = barcode;
  if (image) entry.image = image;
  if (serving) entry.serving = serving;
  await DB.putEntry(entry);
  await ensureLibrary({ name, unit: entry.unit, per, foodId, brand, barcode, qty: entry.qty, per100, gPerUom, image, serving });
  enterEntryId = entry.id;
  pendingGain = K((per?.kcal || 0) * entry.qty);
  haptic(8);
  toast(`Added ${name}`, async () => { await DB.deleteEntries([entry.id]); render(); });
  render();
}

// Every logged food becomes a reusable library item (deduped by name + unit).
async function ensureLibrary({ name, unit, per, foodId, brand, barcode, qty, per100, gPerUom, image, serving }) {
  if (!name) return;
  const foods = await DB.getFoods();
  let f = foodId ? foods.find((x) => x.id === foodId) : null;
  if (!f) f = foods.find((x) => x.nameLower === (name || '').toLowerCase());
  if (f) {
    f.useCount = (f.useCount || 0) + 1; f.lastUsed = Date.now();
    // Remember the last portion the user actually logged (amount + unit) for one-tap re-logging.
    if (qty != null) f.lastQty = qty;
    if (unit) f.lastUnit = unit;
    if (gPerUom) f.lastGPerUom = gPerUom;
    if (per100) f.per100 = per100; if (gPerUom) f.gPerUom = gPerUom;
    if (serving) f.serving = serving;
    if (image && !f.image) f.image = image; if (brand && !f.brand) f.brand = brand;
    if (barcode && !f.barcode) f.barcode = barcode;
    await DB.putFood(f);
  } else {
    await DB.putFood({ id: DB.uid(), name, unit, per, brand, barcode, per100, gPerUom, image, serving, useCount: 1, lastUsed: Date.now(), lastQty: qty != null ? qty : 1, lastUnit: unit, lastGPerUom: gPerUom });
  }
}

// Grams in one unit for an entry, given a fresh serving size from Open Food Facts.
function gramsForUnit(unit, servingGrams, prevGpu) {
  const u = (unit || 'g').toLowerCase();
  if (MASS_UNITS.has(u)) return UNIT_G[u];
  if (u === 'serving') return servingGrams || prevGpu || 100;
  if (UNIT_G[u] != null) return UNIT_G[u];
  return prevGpu || 100;
}

// One-time repair for foods scanned before the unit-conversion fix: re-fetch each
// barcode item from Open Food Facts and rewrite its brand + per-100-g nutrition, keeping
// each logged entry's amount and unit (so calorie totals are preserved but now scale right).
async function migrateBarcodeFoods(onProgress) {
  const foods = await DB.getFoods();
  const coded = foods.filter((f) => f.barcode);
  const byName = new Map();
  for (const f of coded) byName.set((f.name || '').toLowerCase(), f);

  const cache = new Map();
  const lookup = async (code) => {
    if (cache.has(code)) return cache.get(code);
    let r = null; try { r = await lookupBarcode(code); } catch {}
    cache.set(code, r); return r;
  };

  const entries = await DB.getAllEntries();
  const targets = entries.filter((e) => e.barcode || byName.has((e.name || '').toLowerCase()));
  const total = coded.length + targets.length;
  let done = 0; const tick = () => { done++; if (onProgress) onProgress(done, total); };

  let foodsFixed = 0, entriesFixed = 0, failed = 0;

  for (const f of coded) {
    const fresh = await lookup(f.barcode);
    if (!fresh) { failed++; tick(); continue; }
    f.per100 = fresh.per100; f.gPerUom = fresh.gPerUom; f.unit = fresh.unit; f.per = fresh.per;
    if (fresh.brand) f.brand = fresh.brand;
    if (fresh.image && !f.image) f.image = fresh.image;
    f.servingGrams = fresh.servingGrams || null;
    await DB.putFood(f); foodsFixed++; tick();
  }

  for (const e of targets) {
    const code = e.barcode || byName.get((e.name || '').toLowerCase())?.barcode;
    const fresh = code ? await lookup(code) : null;
    if (!fresh) { tick(); continue; }
    e.per100 = fresh.per100;
    if (!e.barcode) e.barcode = code;
    if (fresh.brand && !e.brand) e.brand = fresh.brand;
    if (fresh.image && !e.image) e.image = fresh.image;
    const g = gramsForUnit(e.unit, fresh.servingGrams, e.gPerUom);
    e.gPerUom = g;
    e.per = {}; for (const k of NUTRIENTS) e.per[k] = (e.per100[k] || 0) * g / 100;
    await DB.putEntry(e); entriesFixed++; tick();
  }

  return { foodsFixed, entriesFixed, failed };
}

// Rebuild the cached `per` (per one logged unit) from the authoritative per-100g model
// wherever the two have drifted apart. Totals already ignore `per`, but the solver and
// the scan preview still read it, so keep the stored data honest.
async function repairPerCache() {
  const rebuild = (o) => {
    if (!o.per100 || !o.gPerUom) return false;
    const per = {}; let changed = false;
    for (const k of NUTRIENTS) {
      per[k] = (o.per100[k] || 0) * o.gPerUom / 100;
      if (Math.abs((o.per?.[k] || 0) - per[k]) > 0.01) changed = true;
    }
    if (changed) o.per = per;
    return changed;
  };
  const entries = await DB.getAllEntries();
  const dirty = entries.filter(rebuild);
  if (dirty.length) await DB.putEntries(dirty);
  const foods = await DB.getFoods();
  let foodsFixed = 0;
  for (const f of foods) if (rebuild(f)) { await DB.putFood(f); foodsFixed++; }
  return { entriesFixed: dirty.length, foodsFixed };
}

// One-time: seed the library from previously-logged real foods (skip MFP day summaries).
const LIB_SKIP = new Set(['regular', 'irregular', 'snacks', 'logged', 'breakfast', 'lunch', 'dinner']);
async function backfillLibrary() {
  if (S.settings.libraryBackfilled) return;
  const [entries, foods] = [await DB.getAllEntries(), await DB.getFoods()];
  const have = new Set(foods.map((f) => (f.nameLower || '') + '|' + (f.unit || '')));
  const seen = new Map();
  for (const e of entries) {
    if (!e.name || (e.unit || '') === 'day') continue;          // skip MFP daily summaries
    if (LIB_SKIP.has(e.name.toLowerCase())) continue;
    const key = e.name.toLowerCase() + '|' + (e.unit || '');
    if (have.has(key)) continue;
    const cur = seen.get(key) || { name: e.name, unit: e.unit || '1 serving', per: e.per, count: 0, lastQty: 1 };
    cur.count++; cur.per = e.per; cur.lastQty = e.qty || 1; seen.set(key, cur);
  }
  for (const v of seen.values()) {
    await DB.putFood({ id: DB.uid(), name: v.name, unit: v.unit, per: v.per, useCount: v.count, lastUsed: Date.now(), lastQty: v.lastQty });
  }
  S.settings.libraryBackfilled = true;
  await DB.saveSettings(S.settings);
}

// ---------------- Add-food sheet ----------------
async function openAddFood(initial = 'library') {
  const tabs = [['library', 'Library'], ['search', 'Search'], ['barcode', 'Scan'], ['photo', 'Photo'], ['manual', 'Manual']];
  const tabSeg = tabs.map((t) => `<button class="${t[0] === initial ? 'active' : ''}" data-sub="${t[0]}">${t[1]}</button>`).join('');
  const back = openSheet(pendingDish ? 'Save as dish' : 'Add food', `<div class="seg" id="subseg">${tabSeg}</div><div id="subcontent"></div>`, null, null, { full: true });
  const sub = back.querySelector('#subcontent');
  back.querySelector('#subseg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    back.querySelectorAll('#subseg button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); loadSub(b.dataset.sub);
  });
  function loadSub(name) {
    if (name === 'library') subLibrary(sub, back);
    else if (name === 'search') subSearch(sub);
    else if (name === 'barcode') subBarcode(sub, back);
    else if (name === 'photo') subPhoto(sub, back);
    else if (name === 'manual') subManual(sub, back);
  }
  loadSub(initial);
}

// Combine the selected foods into one dish: sum their nutrition and their real weight,
// then hand it to the manual form to name and save. The ingredients stay logged as-is.
let pendingDish = null;
async function saveAsDish() {
  const entries = await DB.getEntries(S.date);
  const chosen = entries.filter((e) => S.selection.has(e.id));
  if (chosen.length < 2) { toast('Select at least two foods'); return; }
  const tot = sumTotals(chosen);
  let grams = 0;
  for (const e of chosen) { const m = unitModel(e); grams += (m.amount || 0) * (m.gPerUom || 0); }
  if (!(grams > 0)) grams = 100;
  const per100 = {}; for (const k of NUTRIENTS) per100[k] = tot[k] * 100 / grams;
  pendingDish = { name: '', brand: '', unit: 'serving', per100, gPerUom: grams, serving: { amt: 1, unit: 'serving', gpu: grams }, count: chosen.length };
  S.selection.clear(); render();
  openAddFood('manual');
}

const LIB_SORTS = {
  recent: (a, b) => (b.lastUsed || 0) - (a.lastUsed || 0),
  frequent: (a, b) => (b.useCount || 0) - (a.useCount || 0),
  az: (a, b) => (a.name || '').localeCompare(b.name || ''),
  za: (a, b) => (b.name || '').localeCompare(a.name || ''),
};

async function subLibrary(host, back) {
  const foods = await DB.getFoods();
  host.innerHTML = `<div class="field-row" style="margin-bottom:10px">
      <input class="input" id="libsearch" placeholder="Filter your foods…" style="flex:2">
      <select class="select" id="libsort" style="flex:1">
        <option value="recent">Recent</option><option value="frequent">Frequent</option>
        <option value="az">A to Z</option><option value="za">Z to A</option>
      </select>
    </div><div id="liblist"></div>`;
  const list = host.querySelector('#liblist');
  const draw = (q = '') => {
    const sort = LIB_SORTS[host.querySelector('#libsort').value] || LIB_SORTS.recent;
    const filtered = foods.filter((f) => !q || (f.name + ' ' + (f.brand || '')).toLowerCase().includes(q.toLowerCase())).sort(sort);
    if (!filtered.length) { list.innerHTML = `<div class="empty">${foods.length ? 'No match.' : 'Your library is empty.<br>Foods you log are saved here for one-tap re-logging.'}</div>`; return; }
    list.innerHTML = filtered.map((f) => {
      const m = unitModel(f); const unit = f.lastUnit || m.uom; const amt = f.lastQty != null ? f.lastQty : 1;
      const gpu = MASS_UNITS.has((unit || '').toLowerCase()) ? UNIT_G[(unit || '').toLowerCase()] : (f.lastGPerUom || m.gPerUom || 100);
      const kcal = Math.round((m.per100.kcal || 0) * gpu / 100 * amt);
      return `<div class="list-item food-add" data-fid="${f.id}" style="margin-bottom:8px">
      <div class="fa-name">${f.image ? `<img class="lib-thumb" src="${esc(f.image)}" alt="">` : ''}${esc(f.name)}${f.brand ? ` · <span class="faint">${esc(f.brand)}</span>` : ''}${macroTick(m.per100)}</div>
      <div class="fa-ctrls">
        <span class="fa-meta">${kcal} cal</span>
        <input class="qty-mini" data-qty inputmode="decimal" value="${G(amt)}"><span class="uom">${esc(unit)}</span>
        <button class="btn primary add" data-add>Add</button>
        <button class="icon-btn" data-del="${f.id}">${svg('trash')}</button>
      </div></div>`; }).join('');
  };
  draw();
  host.querySelector('#libsearch').addEventListener('input', (e) => draw(e.target.value));
  host.querySelector('#libsort').addEventListener('change', () => draw(host.querySelector('#libsearch').value));
  list.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { await DB.deleteFood(del.dataset.del); const i = foods.findIndex((f) => f.id === del.dataset.del); if (i >= 0) foods.splice(i, 1); draw(host.querySelector('#libsearch').value); return; }
    const add = e.target.closest('[data-add]'); if (!add) return;
    const row = add.closest('[data-fid]'); const f = foods.find((x) => x.id === row.dataset.fid);
    const m = unitModel(f); const unit = f.lastUnit || m.uom;
    const gpu = MASS_UNITS.has((unit || '').toLowerCase()) ? UNIT_G[(unit || '').toLowerCase()] : (f.lastGPerUom || m.gPerUom || 100);
    const amount = Number(row.querySelector('[data-qty]').value) || (f.lastQty != null ? f.lastQty : 1);
    const per = {}; for (const k of NUTRIENTS) per[k] = (m.per100[k] || 0) * gpu / 100;
    await addEntry({ name: f.name, unit, qty: amount, per, foodId: f.id, brand: f.brand, image: f.image, per100: m.per100, gPerUom: gpu, serving: f.serving });
    closeSheet(back);
  });
}

function subSearch(host) {
  host.innerHTML = `<input class="input" id="ssearch" placeholder="Search foods (USDA)…"><div id="sresults" style="margin-top:10px"></div>`;
  const results = host.querySelector('#sresults'); let timer;
  host.querySelector('#ssearch').addEventListener('input', (e) => {
    const q = e.target.value.trim(); clearTimeout(timer);
    if (q.length < 2) { results.innerHTML = ''; return; }
    results.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    timer = setTimeout(async () => {
      try {
        const found = await searchFoods(q, S.settings.fdcKey);
        if (!found.length) { results.innerHTML = `<div class="empty">No results.</div>`; return; }
        results.innerHTML = found.map((f, i) => {
          const kcal = Math.round((f.per100.kcal || 0) * f.gPerUom / 100 * f.amount);
          const sub = f.servingLabel ? ` <span class="faint" style="font-size:12px">(${esc(f.servingLabel)})</span>` : '';
          return `<div class="list-item food-add" data-i="${i}" style="margin-bottom:8px">
          <div class="fa-name">${esc(f.name)}${f.brand ? ` · <span class="faint">${esc(f.brand)}</span>` : ''}${macroTick(f.per100)}</div>
          <div class="fa-ctrls">
            <span class="fa-meta">${kcal} cal${sub}</span>
            <input class="qty-mini" data-qty inputmode="decimal" value="${G(f.amount)}"><span class="uom">${esc(f.unit)}</span>
            <button class="btn primary add" data-add>Add</button>
          </div></div>`; }).join('');
        results.querySelectorAll('[data-i]').forEach((el) => {
          el.querySelector('[data-add]').onclick = async () => {
            const f = found[Number(el.dataset.i)];
            const amount = Number(el.querySelector('[data-qty]').value) || f.amount;
            const per = {}; for (const k of NUTRIENTS) per[k] = (f.per100[k] || 0) * f.gPerUom / 100;
            await addEntry({ name: f.name, unit: f.unit, qty: amount, per, brand: f.brand, barcode: f.barcode, per100: f.per100, gPerUom: f.gPerUom, serving: f.serving });
            el.querySelector('[data-add]').textContent = 'Added';
          };
        });
      } catch { results.innerHTML = `<div class="empty">Search failed. Check your connection.</div>`; }
    }, 450);
  });
}

async function subBarcode(host, back) {
  const hasDetector = 'BarcodeDetector' in window;
  host.innerHTML = `${hasDetector ? `<div class="card tight" style="padding:0;overflow:hidden;position:relative"><video id="cam" playsinline muted style="width:100%;display:block;background:#000;aspect-ratio:4/3;object-fit:cover"></video><div class="scan-guide"></div></div>
      <div class="row-between" style="margin:8px 0"><span class="faint" style="font-size:13px">Center the barcode and hold steady</span><span id="btorch"></span></div>` : `<div class="empty">Live scanning isn't supported here. Enter the barcode number below.</div>`}
    <div class="field-row"><input class="input" id="bcode" inputmode="numeric" placeholder="Barcode number"><button class="btn" id="blook">Look up</button></div>
    <div id="bresult" style="margin-top:10px"></div>`;
  const result = host.querySelector('#bresult');
  async function lookup(code) {
    result.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    try {
      const f = await lookupBarcode(code);
      if (!f) { result.innerHTML = `<div class="empty">Not found (${esc(code)}). Add it manually instead.</div>`; return; }
      const dq = f.qty || 1;
      const kcalDefault = Math.round((f.per?.kcal || 0) * dq);
      const sub = [f.brand, f.servingLabel && `serving ${f.servingLabel}`].filter(Boolean).join(' · ');
      result.innerHTML = `<div class="list-item"><div class="body"><div class="name">${esc(f.name)}</div><div class="meta">${kcalDefault} cal${sub ? ` · ${esc(sub)}` : ''}</div></div>
        <input class="qty-mini" id="bqty" inputmode="decimal" value="${G(dq)}"><span class="uom">${esc(f.unit)}</span></div>
        <button class="btn primary block" id="badd" style="margin-top:10px">Add</button>`;
      result.querySelector('#badd').onclick = async () => {
        const amount = Number(result.querySelector('#bqty').value) || dq;
        await addEntry({ name: f.name, unit: f.unit, qty: amount, per: f.per, brand: f.brand, barcode: f.barcode, image: f.image, per100: f.per100, gPerUom: f.gPerUom }); closeSheet(back);
      };
    } catch { result.innerHTML = `<div class="empty">Lookup failed.</div>`; }
  }
  host.querySelector('#blook').onclick = () => { const c = host.querySelector('#bcode').value.trim(); if (c) lookup(c); };
  if (hasDetector) {
    try {
      const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
      const video = host.querySelector('#cam'); video.srcObject = stream; await video.play();
      const track = stream.getVideoTracks()[0];
      try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
      let done = false; const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); };
      back.addEventListener('click', (e) => { if (e.target === back) stop(); });
      back.querySelector('[data-close]').addEventListener('click', stop);

      // Torch toggle (if the device supports it) for low light
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) {
          let on = false;
          const tb = host.querySelector('#btorch');
          tb.innerHTML = `<button class="btn sm" id="torchbtn">Light off</button>`;
          tb.querySelector('#torchbtn').onclick = async () => { on = !on; try { await track.applyConstraints({ advanced: [{ torch: on }] }); tb.querySelector('#torchbtn').textContent = on ? 'Light on' : 'Light off'; } catch {} };
        }
      } catch {}

      // Require the SAME code on several frames before accepting (kills misreads)
      let candidate = null, hits = 0;
      const scan = async () => {
        if (done || !document.body.contains(video)) { stop(); return; }
        try {
          const codes = await detector.detect(video);
          const val = codes[0] && codes[0].rawValue;
          if (val) {
            if (val === candidate) hits++; else { candidate = val; hits = 1; }
            if (hits >= 4) { stop(); host.querySelector('#bcode').value = val; lookup(val); return; }
          } else { candidate = null; hits = 0; }
        } catch {}
        requestAnimationFrame(scan);
      };
      requestAnimationFrame(scan);
    } catch { host.querySelector('#cam')?.remove(); }
  }
}

function subPhoto(host, back) {
  host.innerHTML = `<button class="btn block" id="pshoot">${svg('camera')} Take / choose photo</button>
    <input type="file" id="pfile" accept="image/*" capture="environment" style="display:none"><div id="presult" style="margin-top:12px"></div>`;
  const result = host.querySelector('#presult');
  host.querySelector('#pshoot').onclick = () => host.querySelector('#pfile').click();
  host.querySelector('#pfile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!S.settings.apiKey) { result.innerHTML = `<div class="empty">Add your Claude API key in Settings to use photo estimation.</div>`; return; }
    result.innerHTML = `<div class="empty"><span class="spinner"></span> Estimating…</div>`;
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const items = await AI.estimateFromPhoto(base64, mediaType, S.settings);
      const checks = items.map((it, i) => `<label class="list-item" style="margin-bottom:8px">
        <input type="checkbox" data-i="${i}" checked style="width:20px;height:20px;accent-color:var(--cal)">
        <div class="body"><div class="name">${esc(it.name)}</div><div class="meta">${it.per.kcal} cal · ${esc(it.unit)}</div></div></label>`).join('');
      result.innerHTML = `<div class="faint" style="font-size:13px;margin-bottom:8px">AI estimate. Tap a food after adding to fine-tune.</div>${checks}
        <button class="btn primary block" id="padd" style="margin-top:8px">Add selected</button>`;
      result.querySelector('#padd').onclick = async () => {
        const chosen = [...result.querySelectorAll('input[type=checkbox]:checked')].map((c) => items[Number(c.dataset.i)]);
        for (const it of chosen) await addEntry({ name: it.name, unit: it.unit, qty: it.qty, per: it.per });
        closeSheet(back);
      };
    } catch (err) { result.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
}

function subManual(host, back) {
  const dish = pendingDish; pendingDish = null;          // consume the preset, if any
  const seed = dish || { name: '', unit: 'serving', per100: emptyPer(), gPerUom: 100, serving: { amt: 1, unit: 'serving', gpu: 100 } };
  host.innerHTML = (dish ? `<div class="dish-note">${svg('info')} Combined from ${dish.count} foods.</div>` : '')
    + entryForm(seed)
    + `<button class="btn primary block" id="madd" style="margin-top:12px">${dish ? 'Save dish to library' : 'Add food'}</button>`;
  wireServingForm(host);
  host.querySelector('#madd').onclick = async () => {
    const data = readEntryForm(host);
    if (!data.name) { toast('Name required'); return; }
    if (dish) {
      // Library-only: logging it too would double-count the ingredients already on the day.
      await ensureLibrary({ name: data.name, brand: data.brand, unit: data.unit, per: data.per, qty: data.qty, per100: data.per100, gPerUom: data.gPerUom, serving: data.serving });
      closeSheet(back); toast(`Saved “${data.name}” to your library`); render();
    } else {
      await addEntry({ name: data.name, brand: data.brand, unit: data.unit, qty: data.qty, per: data.per, per100: data.per100, gPerUom: data.gPerUom, serving: data.serving }); closeSheet(back);
    }
  };
}

function emptyPer() { const o = {}; for (const k of NUTRIENTS) o[k] = 0; return o; }

// The food's canonical serving: how big it is (amount + unit + grams) and the
// nutrition for that one serving. Falls back to "1 base unit" for older foods.
function servingModel(e) {
  const um = unitModel(e);
  const s = e && e.serving;
  const amt = s && s.amt != null ? s.amt : 1;
  const unit = s && s.unit ? s.unit : um.uom;
  const gpu = s && s.gpu != null ? s.gpu : um.gPerUom;
  const grams = (amt || 0) * (gpu || 0);
  const perServing = {}; for (const k of NUTRIENTS) perServing[k] = (um.per100[k] || 0) * grams / 100;
  return { amt, unit, gpu, grams, per100: um.per100, perServing };
}

function entryForm(e) {
  const s = servingModel(e);
  const isMass = MASS_UNITS.has((s.unit || '').toLowerCase());
  const f = (k) => `<div class="field"><label>${META[k].label}${META[k].unit ? ` (${META[k].unit})` : ''}</label>
    <input class="input" data-f="${k}" inputmode="decimal" value="${G(s.perServing[k] ?? 0)}"></div>`;
  return `<div class="field"><label>Name</label><input class="input" data-f="name" value="${esc(e.name)}" placeholder="e.g. Greek yogurt"></div>
    <div class="field" style="margin-top:10px"><label>Brand (optional)</label><input class="input" data-f="brand" value="${esc(e.brand || '')}"></div>
    <div class="section-title" style="margin-top:12px">Serving size</div>
    <div class="field-row">
      <div class="field"><label>Amount</label><input class="input" data-f="serving" inputmode="decimal" value="${G(s.amt)}"></div>
      <div class="field"><label>Unit</label><input class="input" data-f="uom" list="uomlist" value="${esc(s.unit)}" autocapitalize="none"></div>
    </div>
    <div class="field weighs-field ${isMass ? 'hidden' : ''}" style="margin-top:10px"><label>1 <span class="weighs-unit">${esc(s.unit)}</span> weighs (g)</label><input class="input" data-f="gpu" inputmode="decimal" value="${G(s.gpu)}"></div>
    <datalist id="uomlist">${UOM_LIST.map((u) => `<option value="${u}">`).join('')}</datalist>
    <div class="section-title" style="margin-top:12px">Nutrition per serving</div>
    <div class="grid-2">${f('kcal')}${f('protein')}${f('carbs')}${f('fat')}</div>
    <div class="grid-3" style="margin-top:10px">${f('sodium')}${f('fiber')}${f('sugar')}</div>
    <div class="macro-check" id="macrochk"></div>`;
}
// Live "do the macros add up to the calories?" readout under the nutrition fields.
function updateMacroCheck(root) {
  const el = root.querySelector('#macrochk'); if (!el) return;
  const num = (k) => Number(root.querySelector(`[data-f="${k}"]`)?.value) || 0;
  const n = { kcal: num('kcal'), carbs: num('carbs'), protein: num('protein'), fat: num('fat'), fiber: num('fiber') };
  if (n.kcal <= 0 || (n.carbs === 0 && n.protein === 0 && n.fat === 0)) { el.innerHTML = ''; return; }
  if (macrosValidate(n)) { el.innerHTML = `<span class="mc ok">${svg('checkCircle')} Macros match calories</span>`; return; }
  const { low, high } = macroCalRange(n);
  el.innerHTML = `<span class="mc off">${svg('info')} Macros suggest about ${K((low + high) / 2)} cal</span>`;
}
// Show/hide the "weighs" field (only non-weight units need it) and keep its label in sync.
function wireServingForm(root) {
  const uomEl = root.querySelector('[data-f="uom"]');
  if (uomEl) {
    const sync = () => {
      const u = (uomEl.value || '').trim().toLowerCase();
      const wf = root.querySelector('.weighs-field'); const lbl = root.querySelector('.weighs-unit');
      if (wf) wf.classList.toggle('hidden', MASS_UNITS.has(u));
      if (lbl) lbl.textContent = uomEl.value.trim() || 'unit';
    };
    uomEl.addEventListener('input', sync); uomEl.addEventListener('change', sync);
  }
  NUTRIENTS.forEach((k) => root.querySelector(`[data-f="${k}"]`)?.addEventListener('input', () => updateMacroCheck(root)));
  updateMacroCheck(root);
}
// Read the serving-based form into a storable model (per-100g internally).
function readEntryForm(root, qtyOverride) {
  const get = (k) => root.querySelector(`[data-f="${k}"]`)?.value ?? '';
  const sAmt = Number(get('serving')) || 1;
  const unit = (get('uom') || 'serving').trim() || 'serving';
  const lu = unit.toLowerCase();
  const gPerUom = MASS_UNITS.has(lu) ? UNIT_G[lu] : (Number(get('gpu')) || UNIT_G[lu] || 100);
  const grams = sAmt * gPerUom;
  const per100 = {}; for (const k of NUTRIENTS) { const v = Number(get(k)) || 0; per100[k] = grams > 0 ? v * 100 / grams : 0; }
  const per = {}; for (const k of NUTRIENTS) per[k] = per100[k] * gPerUom / 100;
  const qty = qtyOverride != null ? qtyOverride : sAmt;
  return { name: get('name').trim(), brand: get('brand').trim(), unit, qty, per, per100, gPerUom, serving: { amt: sAmt, unit, gpu: gPerUom } };
}

// ---------- Entry detail (view nutrients + adjust volume) ----------
async function openEntryDetail(id) {
  const entries = await DB.getEntries(S.date);
  const e = entries.find((x) => x.id === id); if (!e) return;
  const m0 = unitModel(e);
  const sm = servingModel(e);
  // Show a photo even when the entry lacks one, by borrowing its library food's image.
  let img = e.image, code = e.barcode;
  if (!img) {
    const foods = await DB.getFoods();
    const m = foods.find((f) => (e.foodId && f.id === e.foodId) || (e.barcode && f.barcode === e.barcode) || (f.name || '').toLowerCase() === (e.name || '').toLowerCase());
    if (m) { if (m.image) img = m.image; if (!code && m.barcode) code = m.barcode; }
  }
  const headActions = `<button class="icon-btn" id="dsolve" title="Solve quantity">${svg('calc')}</button>
    <button class="icon-btn" id="dedit" title="Edit details">${svg('edit')}</button>`;
  const back = openSheet(e.name || 'Item', `
    ${e.brand ? `<div class="detail-brand">${esc(e.brand)}</div>` : ''}
    ${img ? `<div class="detail-img"><img src="${img}" alt=""></div>` : ''}
    <div class="qty-stepper">
      <button class="step" id="qminus">${svg('minus')}</button>
      <div class="qty-mid"><input class="qty-in" id="dqty" inputmode="decimal" value="${G(m0.amount)}"><select class="qty-unit-sel" id="dunitsel">${uomOptions(m0.uom)}</select></div>
      <button class="step" id="qplus">${svg('plus')}</button>
    </div>
    <div class="mult-row">${MULTIPLIERS.map(([lbl, v]) => `<button class="mult" data-mult="${v}">${lbl}</button>`).join('')}</div>
    <div id="dtotals"></div>
    <div id="editblock" class="hidden">
      <div class="divider" style="margin:14px 0"></div>
      ${entryForm(e)}
      <button class="btn ghost block" id="drefresh" style="margin-top:12px">${svg('barcode')} Refresh from barcode</button>
      <button class="btn ghost block" id="dphoto" style="margin-top:8px">${svg('camera')} Add / change photo</button>
      <input type="file" id="dphotofile" accept="image/*" style="display:none">
      <button class="btn ghost block danger-text" id="ddel" style="margin-top:8px">${svg('trash')} Delete item</button>
    </div>
  `, `<button class="btn ghost" data-close-foot>Cancel</button><button class="btn primary" id="dsave">Save</button>`, headActions);

  // No photo yet but we have a barcode: fetch it lazily and slot it in (then keep it).
  if (!img && code) {
    lookupBarcode(code).then(async (fresh) => {
      if (!fresh || !fresh.image || !back.isConnected) return;
      const body = back.querySelector('.sheet-body'); const stepper = body.querySelector('.qty-stepper');
      const div = node(`<div class="detail-img"><img src="${esc(fresh.image)}" alt=""></div>`);
      body.insertBefore(div, stepper);
      e.image = fresh.image; try { await DB.putEntry(e); } catch {}
    }).catch(() => {});
  }

  const qtyIn = back.querySelector('#dqty');
  const totalsEl = back.querySelector('#dtotals');
  const unitSel = back.querySelector('#dunitsel');
  wireServingForm(back);
  // Read the serving definition (from the edit block) live.
  const servUnit = () => (back.querySelector('[data-f="uom"]')?.value || sm.unit).trim();
  const servGpu = () => { const su = servUnit().toLowerCase(); return MASS_UNITS.has(su) ? UNIT_G[su] : (Number(back.querySelector('[data-f="gpu"]')?.value) || sm.gpu || 100); };
  // Grams in one of the LOGGED unit (from the stepper), reusing the serving weight when they match.
  function gForLoggedUnit(u) {
    const lu = (u || '').toLowerCase();
    if (MASS_UNITS.has(lu)) return UNIT_G[lu];
    if (lu === servUnit().toLowerCase()) return servGpu();
    if (UNIT_G[lu] != null) return UNIT_G[lu];
    return servGpu();
  }
  function curPer100() {
    const get = (k) => back.querySelector(`[data-f="${k}"]`)?.value;
    const sAmt = Number(back.querySelector('[data-f="serving"]')?.value) || 1;
    const grams = sAmt * servGpu();
    const per100 = {};
    for (const k of NUTRIENTS) { const v = get(k); const perServ = v != null && v !== '' ? Number(v) || 0 : (sm.perServing[k] || 0); per100[k] = grams > 0 ? perServ * 100 / grams : 0; }
    return per100;
  }
  function curPer() { const per100 = curPer100(); const g = gForLoggedUnit(unitSel.value); const per = {}; for (const k of NUTRIENTS) per[k] = per100[k] * g / 100; return per; }
  function drawTotals() {
    const qty = Number(qtyIn.value) || 0; const per = curPer();
    const tot = {}; for (const k of NUTRIENTS) tot[k] = per[k] * qty;
    totalsEl.innerHTML = `
      <div class="section-title">Calories</div>
      <div class="card cal-hero"><span class="v">${K(tot.kcal)}</span><span class="u">cal</span></div>
      <div class="section-title">Macros</div>
      <div class="card nut-rows">${nutrientRows(tot, ['carbs', 'protein', 'fat'])}</div>
      <div class="section-title">Micros</div>
      <div class="card nut-rows">${nutrientRows(tot, ['sodium', 'fiber', 'sugar'])}</div>`;
  }
  drawTotals();
  qtyIn.addEventListener('input', drawTotals);

  // Switching the stepper (logged) unit keeps the total mass constant.
  let curUom = m0.uom;
  unitSel.addEventListener('change', () => {
    const grams = (Number(qtyIn.value) || 0) * gForLoggedUnit(curUom);
    const newG = gForLoggedUnit(unitSel.value);
    qtyIn.value = G(newG ? grams / newG : 0);
    curUom = unitSel.value;
    drawTotals();
  });
  back.querySelector('#qminus').onclick = () => { qtyIn.value = Math.max(0, G((Number(qtyIn.value) || 0) - 0.5)); drawTotals(); };
  back.querySelector('#qplus').onclick = () => { qtyIn.value = G((Number(qtyIn.value) || 0) + 0.5); drawTotals(); };
  back.querySelectorAll('.mult').forEach((b) => b.onclick = () => { qtyIn.value = G((Number(qtyIn.value) || 0) * Number(b.dataset.mult)); haptic(6); drawTotals(); });
  back.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', drawTotals));

  back.querySelector('#dedit').onclick = () => {
    const eb = back.querySelector('#editblock');
    eb.classList.toggle('hidden');
    if (!eb.classList.contains('hidden')) requestAnimationFrame(() => eb.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  back.querySelector('#dsolve').onclick = () => { closeSheet(back); openSolver(e.id); };
  back.querySelector('#dsave').onclick = async () => {
    const d = readEntryForm(back);                 // name, brand, per100, serving definition
    const lu = (unitSel.value || d.unit).trim();    // the logged unit from the stepper
    const glu = gForLoggedUnit(lu);
    const per = {}; for (const k of NUTRIENTS) per[k] = (d.per100[k] || 0) * glu / 100;
    // Find the library food by the entry's CURRENT identity, before applying a possible rename.
    const foods = await DB.getFoods();
    const lf = foods.find((f) => (e.foodId && f.id === e.foodId) || (e.barcode && f.barcode === e.barcode) || (f.name || '').toLowerCase() === (e.name || '').toLowerCase());
    Object.assign(e, { name: d.name, brand: d.brand, per100: d.per100, serving: d.serving, unit: lu, gPerUom: glu, qty: Number(qtyIn.value) || 0, per });
    if (lf) e.foodId = lf.id;   // link so future edits track this food even through a rename
    await DB.putEntry(e);
    // Edits to a food's details stick to the library (name, brand, nutrition, serving) so they
    // don't revert on re-log. Other days you already logged keep their historical snapshot.
    if (lf) {
      if (d.name) lf.name = d.name;
      lf.brand = d.brand; lf.per100 = e.per100; lf.serving = e.serving;
      lf.lastQty = e.qty; lf.lastUnit = e.unit; lf.lastGPerUom = e.gPerUom;
      if (e.image && !lf.image) lf.image = e.image;
      await DB.putFood(lf);
    }
    closeSheet(back); render();
  };
  back.querySelector('[data-close-foot]').onclick = () => closeSheet(back);
  back.querySelector('#ddel').onclick = async () => {
    await DB.deleteEntries([e.id]); closeSheet(back);
    toast('Item deleted', async () => { await DB.putEntry(e); render(); }); render();
  };
  back.querySelector('#dphoto').onclick = () => back.querySelector('#dphotofile').click();
  back.querySelector('#dphotofile').onchange = async (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const url = await compressImage(file, 640, 0.8);
    e.image = url;
    const body = back.querySelector('.sheet-body');
    let d = body.querySelector('.detail-img');
    if (d) d.querySelector('img').src = url;
    else body.insertBefore(node(`<div class="detail-img"><img src="${url}" alt=""></div>`), body.querySelector('.qty-stepper'));
    await DB.putEntry(e);
    // Stamp the library food too, so re-logs and the list thumbnail get the photo.
    const foods = await DB.getFoods();
    const m = foods.find((f) => (e.foodId && f.id === e.foodId) || (e.barcode && f.barcode === e.barcode) || (f.name || '').toLowerCase() === (e.name || '').toLowerCase());
    if (m) { m.image = url; await DB.putFood(m); }
    toast('Photo added');
  };
  back.querySelector('#drefresh').onclick = async () => {
    const btn = back.querySelector('#drefresh'); const orig = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Refreshing…';
    try {
      let code = e.barcode;
      if (!code) {
        const foods = await DB.getFoods();
        code = foods.find((x) => x.barcode && (x.name || '').toLowerCase() === (e.name || '').toLowerCase())?.barcode;
      }
      if (!code) { toast('No barcode on file. Re-scan to add one.'); return; }
      const fresh = await lookupBarcode(code);
      if (!fresh) { toast('Product not found in Open Food Facts.'); return; }
      // Rewrite the serving definition from Open Food Facts: 1 serving weighing its real
      // grams, with the nutrition for that serving.
      const sg = fresh.servingGrams || fresh.gPerUom || 100;
      const setF = (k, v) => { const el = back.querySelector(`[data-f="${k}"]`); if (el) el.value = v; };
      setF('serving', '1');
      const uomEl = back.querySelector('[data-f="uom"]'); if (uomEl) { uomEl.value = 'serving'; uomEl.dispatchEvent(new Event('input')); }
      setF('gpu', G(sg));
      for (const k of NUTRIENTS) setF(k, G((fresh.per100[k] || 0) * sg / 100));
      const brandEl = back.querySelector('[data-f="brand"]'); if (brandEl && !brandEl.value && fresh.brand) brandEl.value = fresh.brand;
      if (fresh.image && !e.image) e.image = fresh.image;
      e.barcode = code;
      drawTotals();
      toast('Refreshed from barcode. Tap Save to keep it.');
    } catch { toast('Refresh failed. Check your connection.'); }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  };
}

// ---------- Solver ----------
async function openSolver(entryId) {
  const entries = await DB.getEntries(S.date);
  const totals = sumTotals(entries);
  const itemOpts = entries.map((x) => `<option value="${x.id}" ${x.id === entryId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const metricOpts = [['kcal', 'Calories'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map((m) => `<option value="${m[0]}">${m[1]}</option>`).join('');
  const defTarget = Math.max(0, Math.round(totals.kcal / 50) * 50) || 2000;

  const back = openSheet('Solve quantity', `
    <div class="field"><label>Adjust this food</label><select class="select" id="sitem">${itemOpts}</select></div>
    <div class="field-row" style="margin-top:10px">
      <div class="field"><label>Target metric</label><select class="select" id="smetric">${metricOpts}</select></div>
      <div class="field"><label>Target total</label><input class="input" id="starget" inputmode="decimal" value="${defTarget}"></div>
    </div>
    <div id="sout" style="margin-top:14px"></div>
  `, `<button class="btn ghost" data-close-foot>Close</button><button class="btn primary" id="sapply" disabled>Apply</button>`);
  const out = back.querySelector('#sout'); let solution = null;
  function compute() {
    const item = entries.find((x) => x.id === back.querySelector('#sitem').value);
    const metric = back.querySelector('#smetric').value;
    const target = Number(back.querySelector('#starget').value);
    const per = item.per[metric] || 0;
    const others = totals[metric] - entryTotals(item)[metric];
    if (per <= 0) { out.innerHTML = `<div class="empty">“${esc(item.name)}” has no ${META[metric].label.toLowerCase()} per unit, so it can't be scaled for this target.</div>`; solution = null; back.querySelector('#sapply').disabled = true; return; }
    const needed = (target - others) / per;
    if (needed < 0) { out.innerHTML = `<div class="empty">Even with 0 of “${esc(item.name)}”, the rest of the day is ${K(others)}${unitOf(metric)}, already above ${K(target)}. Reduce another item.</div>`; solution = null; back.querySelector('#sapply').disabled = true; return; }
    const newQty = G(needed); const nt = {}; for (const k of NUTRIENTS) nt[k] = (totals[k] - entryTotals(item)[k]) + item.per[k] * needed;
    solution = { item, qty: newQty };
    const u = parseUnit(item.unit);
    out.innerHTML = `<div class="card tight">
      <div class="solve-row"><span class="lbl">${esc(item.name)}</span><b class="val">${G(item.qty * u.num)} to ${G(needed * u.num)} ${esc(u.label)}</b></div>
      <div class="divider"></div>
      <div class="solve-row"><span class="lbl">Day ${META[metric].label.toLowerCase()}</span><b class="val">${K(totals[metric])} to ${K(nt[metric])}${unitOf(metric)}</b></div>
      <div class="solve-foot faint">New day: ${K(nt.kcal)} cal · P${G(nt.protein)} C${G(nt.carbs)} F${G(nt.fat)}</div></div>`;
    back.querySelector('#sapply').disabled = false;
  }
  ['#sitem', '#smetric', '#starget'].forEach((sel) => back.querySelector(sel).addEventListener('input', compute));
  back.querySelector('[data-close-foot]').onclick = () => closeSheet(back);
  back.querySelector('#sapply').onclick = async () => { if (!solution) return; solution.item.qty = solution.qty; await DB.putEntry(solution.item); closeSheet(back); toast('Quantity updated'); render(); };
  compute();
}

// ---------- Copy day / copy selected ----------
async function openCopyDay() {
  const src = await DB.getEntries(S.date);
  if (!src.length) { toast('Nothing to copy on this day'); return; }
  openCalendarPicker(`${dayLabel(S.date)} → which days?`, S.date, async (targets, mode) => {
    if (mode === 'move') await moveEntriesToDates(src, targets); else await copyEntriesToDates(src, targets);
  });
}
async function openCopySelected() {
  const entries = await DB.getEntries(S.date);
  const chosen = entries.filter((e) => S.selection.has(e.id));
  if (!chosen.length) return;
  openCalendarPicker(`${chosen.length} item${chosen.length > 1 ? 's' : ''} → which days?`, null, async (targets, mode) => {
    if (mode === 'move') await moveEntriesToDates(chosen, targets); else await copyEntriesToDates(chosen, targets);
  });
}
async function moveEntriesToDates(entries, targets) {
  const clones = [];
  for (const date of targets) {
    let ord = await nextOrder(date);
    for (const e of entries) clones.push({ ...e, id: DB.uid(), date, order: ord++ });
  }
  await DB.putEntries(clones);
  await DB.deleteEntries(entries.map((e) => e.id)); // remove from the source day
  if (targets.length) S.date = targets[0];
  S.selection.clear();
  toast(`Moved to ${targets.length} day${targets.length > 1 ? 's' : ''}`, async () => {
    await DB.deleteEntries(clones.map((c) => c.id)); await DB.putEntries(entries); render();
  });
  render();
}
async function copyEntriesToDates(entries, targets) {
  const clones = [];
  for (const date of targets) {
    let ord = await nextOrder(date);
    for (const e of entries) clones.push({ ...e, id: DB.uid(), date, order: ord++ });
  }
  await DB.putEntries(clones);
  if (targets.length) S.date = targets[0]; // jump to the copied day (first, if several)
  S.selection.clear();
  toast(`Copied to ${targets.length} day${targets.length > 1 ? 's' : ''}`, async () => { await DB.deleteEntries(clones.map((c) => c.id)); render(); });
  render();
}

function openCalendarPicker(title, sourceDate, onConfirm) {
  const selected = new Set();
  let viewMonth = new Date((sourceDate || todayStr()) + 'T00:00:00'); viewMonth.setDate(1);
  const back = openSheet(title, `<div id="calwrap"></div><div class="faint center" id="calcount" style="font-size:13px;margin-top:8px">Tap days to select</div>`,
    `<button class="btn ghost" id="calmove" disabled>Move</button><button class="btn primary" id="calok" disabled>Copy</button>`);
  function drawCal() {
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth();
    const startDow = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate();
    const monthLabel = viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dow">${d}</div>`).join('');
    let cells = ''; for (let i = 0; i < startDow; i++) cells += `<div></div>`;
    for (let d = 1; d <= days; d++) { const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
      const cls = [ds === sourceDate ? 'src' : '', ds === todayStr() ? 'today' : '', selected.has(ds) ? 'sel' : ''].join(' ');
      cells += `<div class="cal-cell ${cls}" data-d="${ds}">${d}</div>`; }
    back.querySelector('#calwrap').innerHTML = `<div class="cal-head"><button class="icon-btn" data-cal="prev">${svg('chevL')}</button><b>${monthLabel}</b><button class="icon-btn" data-cal="next">${svg('chevR')}</button></div><div class="cal-grid">${dow}${cells}</div>`;
  }
  drawCal();
  back.querySelector('#calwrap').addEventListener('click', (e) => {
    const nav = e.target.closest('[data-cal]');
    if (nav) { viewMonth.setMonth(viewMonth.getMonth() + (nav.dataset.cal === 'next' ? 1 : -1)); drawCal(); return; }
    const cell = e.target.closest('[data-d]'); if (!cell) return;
    const ds = cell.dataset.d; if (ds === sourceDate) return;
    selected.has(ds) ? selected.delete(ds) : selected.add(ds); drawCal();
    back.querySelector('#calcount').textContent = selected.size ? `${selected.size} day${selected.size > 1 ? 's' : ''} selected` : 'Tap days to select';
    back.querySelector('#calok').disabled = selected.size === 0;
    back.querySelector('#calmove').disabled = selected.size === 0;
  });
  back.querySelector('#calok').onclick = async () => { closeSheet(back); await onConfirm([...selected].sort(), 'copy'); };
  back.querySelector('#calmove').onclick = async () => { closeSheet(back); await onConfirm([...selected].sort(), 'move'); };
}

// ---------- Body edit + photos ----------
async function openBodyEdit(date) {
  const rec = (await DB.getBody(date)) || { date };
  const u = S.settings.units;
  const back = openSheet(`${dayLabel(date)}`, `
    <div class="faint">${fullDate(date)}</div>
    <div class="field-row" style="margin-top:12px">
      <div class="field"><label>Weight (${u.weight})</label><input class="input" id="ew" inputmode="decimal" value="${rec.weight ?? ''}"></div>
      <div class="field"><label>Waist (${u.length})</label><input class="input" id="es" inputmode="decimal" value="${rec.waist ?? ''}"></div>
    </div>
    <div class="section-title" style="margin-top:14px">Progress photos</div>
    <div id="ephotos">${photoStrip(rec, date, true)}</div>
    <input type="file" id="ephotofile" accept="image/*" capture="environment" style="display:none">`,
    `<button class="btn ghost danger-text" id="ebdel">Delete day</button><button class="btn primary" id="ebsave">Save</button>`);

  const refreshPhotos = async () => { const r = (await DB.getBody(date)) || { date }; back.querySelector('#ephotos').innerHTML = photoStrip(r, date, true); };
  back.querySelector('#ephotos').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-act="body-addphoto"]'); if (add) { back.querySelector('#ephotofile').click(); return; }
    const rm = e.target.closest('[data-act="photo-remove"]'); if (rm) { await removePhotoFromDate(date, Number(rm.dataset.idx)); await refreshPhotos(); render(); return; }
    const open = e.target.closest('[data-act="photo-open"]'); if (open) openPhotoViewer(open.dataset.date, Number(open.dataset.idx));
  });
  back.querySelector('#ephotofile').onchange = async (e) => { const file = e.target.files[0]; if (!file) return; const url = await compressImage(file); await addPhotoToDate(date, url); await refreshPhotos(); render(); };

  back.querySelector('#ebsave').onclick = async () => {
    const w = back.querySelector('#ew').value.trim(), s = back.querySelector('#es').value.trim();
    const cur = (await DB.getBody(date)) || { date };
    await DB.putBody({ ...cur, date, weight: w === '' ? null : Number(w), waist: s === '' ? null : Number(s) });
    closeSheet(back); render();
  };
  back.querySelector('#ebdel').onclick = async () => { await DB.deleteBody(date); closeSheet(back); render(); };
}

async function addPhotoToDate(date, url) { const rec = (await DB.getBody(date)) || { date }; rec.photos = rec.photos || []; rec.photos.push(url); await DB.putBody(rec); }
async function removePhotoFromDate(date, idx) { const rec = await DB.getBody(date); if (!rec?.photos) return; rec.photos.splice(idx, 1); if (!rec.photos.length) delete rec.photos; await DB.putBody(rec); }

// ---------- Photo comparison viewer ----------
async function openPhotoViewer(startDate, startIdx) {
  const all = await DB.getAllBody();
  const photos = [];
  all.forEach((r) => (r.photos || []).forEach((url, i) => photos.push({ date: r.date, url, idx: i })));
  if (!photos.length) return;
  let a = photos.findIndex((p) => p.date === startDate && p.idx === startIdx); if (a < 0) a = photos.length - 1;
  let b = photos.length > 1 ? (a > 0 ? a - 1 : a + 1) : a;
  let active = 'B';

  const back = openSheet('Compare photos', `
    <div class="pv-stage">
      <div class="pv-slot" data-slot="A"><img id="pvA"><div class="pv-cap" id="pvACap"></div></div>
      <div class="pv-slot" data-slot="B"><img id="pvB"><div class="pv-cap" id="pvBCap"></div></div>
    </div>
    <div class="faint center" style="font-size:12px;margin:6px 0">Tap a side to select it, then tap a photo below</div>
    <div class="pv-strip" id="pvstrip"></div>`);

  function paint() {
    const pa = photos[a], pb = photos[b];
    back.querySelector('#pvA').src = pa.url; back.querySelector('#pvACap').textContent = dayLabel(pa.date);
    back.querySelector('#pvB').src = pb.url; back.querySelector('#pvBCap').textContent = dayLabel(pb.date);
    back.querySelectorAll('.pv-slot').forEach((s) => s.classList.toggle('active', s.dataset.slot === active));
    back.querySelector('#pvstrip').innerHTML = photos.map((p, i) => `<button class="pv-thumb ${i === a ? 'isA' : ''} ${i === b ? 'isB' : ''}" data-i="${i}"><img src="${p.url}"><span>${dayLabel(p.date)}</span></button>`).join('');
  }
  paint();
  back.querySelector('.pv-stage').addEventListener('click', (e) => { const slot = e.target.closest('.pv-slot'); if (slot) { active = slot.dataset.slot; paint(); } });
  back.querySelector('#pvstrip').addEventListener('click', (e) => { const th = e.target.closest('[data-i]'); if (!th) return; const i = Number(th.dataset.i); if (active === 'A') a = i; else b = i; paint(); });
}

// ---------- Dietician chat ----------
async function openChat() {
  const back = openSheet('Dietician', `<div class="chat-log" id="chatlog"></div>`,
    `<div style="display:flex;flex-direction:column;gap:8px;width:100%">
      <div class="chat-attach" id="chatpreview"></div>
      <div class="chat-input">
        <button class="icon-btn" id="chatattach" title="Attach screenshot" style="flex:none">${svg('image')}</button>
        <textarea class="input" id="chatin" rows="1" placeholder=""></textarea>
        <button class="btn primary" id="chatsend" style="flex:none">${svg('chevR')}</button>
      </div>
      <input type="file" id="chatfile" accept="image/*" style="display:none">
    </div>`,
    `<button class="icon-btn" id="chatclear" title="Clear conversation">${svg('trash')}</button>`);
  const log = back.querySelector('#chatlog'); const input = back.querySelector('#chatin');
  // The scroll container is the sheet body, not the log itself.
  const scroller = back.querySelector('.sheet-body');
  const scrollBottom = () => { scroller.scrollTop = scroller.scrollHeight; };
  let pendingImage = null;
  function drawPreview() {
    const p = back.querySelector('#chatpreview');
    p.innerHTML = pendingImage ? `<div class="att-chip"><img src="${pendingImage.dataUrl}" alt=""><button class="att-rm" id="attrm">${svg('x')}</button></div>` : '';
    const rm = back.querySelector('#attrm'); if (rm) rm.onclick = () => { pendingImage = null; drawPreview(); };
  }
  back.querySelector('#chatattach').onclick = () => back.querySelector('#chatfile').click();
  back.querySelector('#chatfile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    pendingImage = await compressToParts(file); drawPreview(); e.target.value = '';
  };
  function draw() {
    log.innerHTML = S.chat.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'ai'}">${m.image ? `<img class="msg-img" src="${m.image.dataUrl}" alt="">` : ''}${esc(m.text)}</div>`).join('')
      || `<div class="empty">I'm your dietician. Ask me to adjust your day to a target, share a screenshot of a food diary to log it, or ask any nutrition question. I use your Claude API key.</div>`;
    if (S.pendingActions?.length) log.innerHTML += `<div class="msg ai" style="border-color:var(--cal)"><b>Proposed changes:</b><br>${describeActions(S.pendingActions)}<br><button class="btn primary sm" id="applyact" style="margin-top:8px">Apply changes</button></div>`;
    scrollBottom();
    log.querySelectorAll('.msg-img').forEach((im) => { im.onload = scrollBottom; });
    const ap = back.querySelector('#applyact'); if (ap) ap.onclick = applyActions;
  }
  async function clearChat() {
    const prev = S.chat;
    S.chat = []; S.pendingActions = null; await DB.saveChat(S.chat); draw();
    toast('Conversation cleared', async () => { S.chat = prev; await DB.saveChat(S.chat); draw(); });
  }
  back.querySelector('#chatclear').onclick = clearChat;
  draw();
  // Always land at the newest message when the sheet opens (after layout + images).
  requestAnimationFrame(scrollBottom);
  setTimeout(scrollBottom, 120);
  setTimeout(scrollBottom, 350);
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; });
  input.addEventListener('paste', async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); const file = item.getAsFile(); if (file) { pendingImage = await compressToParts(file); drawPreview(); } }
  });
  async function send() {
    const text = input.value.trim(); const img = pendingImage;
    if (!text && !img) return;
    if (!S.settings.apiKey) { S.chat.push({ role: 'assistant', text: 'Add your Claude API key in Settings first.' }); draw(); return; }
    S.chat.push({ role: 'user', text, image: img }); input.value = ''; input.style.height = 'auto';
    pendingImage = null; drawPreview(); S.pendingActions = null; DB.saveChat(S.chat); draw();
    log.innerHTML += `<div class="msg ai thinking"><span class="spinner"></span></div>`; scrollBottom();
    try {
      const entries = await DB.getEntries(S.date);
      const today = todayStr();
      const ctx = {
        today, yesterday: addDays(today, -1), tomorrow: addDays(today, 1),
        todayLabel: new Date(today + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        viewing: S.date,
        viewingLabel: new Date(S.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
        totals: roundTotals(sumTotals(entries)),
        entries: entries.map((e) => ({ id: e.id, name: e.name, qty: e.qty, unit: e.unit, per: e.per })),
      };
      const historyForApi = S.chat.slice(-16); // cap context to keep cost sane
      const { text: reply, actions } = await AI.chatComplete(historyForApi, ctx, S.settings);
      S.chat.push({ role: 'assistant', text: reply }); S.pendingActions = actions && actions.length ? actions : null;
    } catch (err) { S.chat.push({ role: 'assistant', text: '⚠️ ' + err.message }); }
    DB.saveChat(S.chat); draw();
  }
  back.querySelector('#chatsend').onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  async function applyActions() {
    const entries = await DB.getEntries(S.date);
    const touched = new Set();
    for (const act of S.pendingActions) {
      if (act.op === 'setQty') { const e = entries.find((x) => x.id === act.entryId); if (e) { e.qty = Number(act.qty); await DB.putEntry(e); touched.add(S.date); } }
      else if (act.op === 'delete') { await DB.deleteEntries([act.entryId]); touched.add(S.date); }
      else if (act.op === 'add') { touched.add(await addEntrySilent(act)); }
    }
    const others = [...touched].filter((d) => d !== S.date);
    S.pendingActions = null; haptic(10);
    S.chat.push({ role: 'assistant', text: others.length ? `✓ Applied. Added to ${others.map(dayLabel).join(', ')}. Switch the date to view those.` : `✓ Applied to ${dayLabel(S.date)}.` });
    DB.saveChat(S.chat); draw(); render();
  }
}
async function addEntrySilent(a) {
  const date = (a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date)) ? a.date : S.date;
  const unit = a.unit || '1 serving';
  const per = { ...emptyPer(), ...a.per };
  const qty = Number(a.qty) || 1;
  await DB.putEntry({ id: DB.uid(), date, name: a.name, unit, qty, per, order: await nextOrder(date) });
  await ensureLibrary({ name: a.name, unit, per, qty });
  return date;
}
function describeActions(actions) { return actions.map((a) => a.op === 'setQty' ? `• Set quantity to ${a.qty}` : a.op === 'delete' ? '• Remove an item' : a.op === 'add' ? `• Add ${esc(a.name)} (${a.per?.kcal || 0} cal)${a.date && a.date !== S.date ? ' on ' + dayLabel(a.date) : ''}` : '').join('<br>'); }
function roundTotals(t) { const o = {}; for (const k of NUTRIENTS) o[k] = K(t[k]); return o; }

// ---------- Settings ----------
function openSortMenu() {
  const opts = [
    ['manual', 'Manual order'],
    ['kcal', 'Calories (high to low)'],
    ['carbs', 'Carbs (high to low)'],
    ['protein', 'Protein (high to low)'],
    ['fat', 'Fat (high to low)'],
    ['az', 'Name (A to Z)'],
  ];
  const back = openSheet('Sort foods', `<div class="sort-list">${opts.map(([v, label]) =>
    `<button class="sort-opt ${S.sort === v ? 'sel' : ''}" data-sort="${v}">${label}${S.sort === v ? svg('check') : ''}</button>`).join('')}</div>`);
  back.querySelectorAll('[data-sort]').forEach((b) => b.onclick = () => { S.sort = b.dataset.sort; closeSheet(back); render(); });
}

async function openSettings() {
  const s = S.settings;
  const back = openSheet('Settings', `
    <div class="section-title">Claude API</div>
    <div class="card tight">
      <div class="field"><label>API key (stored only on this device)</label><input class="input" id="setkey" type="password" placeholder="sk-ant-…" value="${esc(s.apiKey)}"></div>
      <div class="field" style="margin-top:10px"><label>Model</label><select class="select" id="setmodel">
        ${modelOpt('claude-haiku-4-5-20251001', 'Haiku 4.5 (fast, cheap)', s.model)}
        ${modelOpt('claude-sonnet-4-6', 'Sonnet 4.6 (balanced)', s.model)}
        ${modelOpt('claude-opus-4-8', 'Opus 4.8 (most capable)', s.model)}</select></div>
      <div class="faint" style="font-size:12px;margin-top:8px">Powers the dietician and photo estimates. Get a key at console.anthropic.com.</div>
    </div>
    <div class="section-title" style="margin-top:14px">Food search (USDA)</div>
    <div class="card tight">
      <div class="field"><label>USDA API key (optional)</label><input class="input" id="setfdc" placeholder="leave blank for shared demo key" value="${esc(s.fdcKey)}"></div>
      <div class="faint" style="font-size:12px;margin-top:8px">Blank uses a shared demo key (rate-limited). Free unlimited key: fdc.nal.usda.gov/api-key-signup</div>
    </div>
    <div class="section-title" style="margin-top:14px">Units</div>
    <div class="field-row">
      <div class="field"><label>Weight</label><select class="select" id="setwu"><option ${s.units.weight === 'lb' ? 'selected' : ''}>lb</option><option ${s.units.weight === 'kg' ? 'selected' : ''}>kg</option></select></div>
      <div class="field"><label>Length</label><select class="select" id="setlu"><option ${s.units.length === 'in' ? 'selected' : ''}>in</option><option ${s.units.length === 'cm' ? 'selected' : ''}>cm</option></select></div>
    </div>
    <label class="row-between" style="margin-top:14px"><span>Animations</span>
      <input type="checkbox" id="setanim" ${s.animations !== false ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--cal)"></label>
    <div class="section-title" style="margin-top:14px">Data</div>
    <div class="grid-2">
      <button class="btn sm" data-act="export-json">Export JSON</button>
      <button class="btn sm" data-act="export-csv">Export CSV</button>
      <button class="btn sm" data-act="import-json">Import JSON</button>
      <button class="btn sm" id="setinstall">Install app</button>
    </div>
    <input type="file" id="importfile" accept="application/json,.json" style="display:none">
    <button class="btn sm block" id="setfix" style="margin-top:8px">Fix scanned foods</button>
    <div class="faint" style="font-size:12px;margin-top:6px">Re-fetches barcode-scanned foods from Open Food Facts and corrects their brand and per-unit nutrition. Totals stay the same.</div>
    <button class="btn sm block" id="setrepair" style="margin-top:8px">Repair food data</button>
    <div class="faint" style="font-size:12px;margin-top:6px">Rebuilds stale per-unit nutrition from each food's per-100g values. Fixes items whose macros looked right but were stored inconsistently.</div>
    <button class="faint center" id="setver" style="font-size:12px;margin-top:14px;width:100%;background:none">Macro Polo ${APP_VERSION} · tap to force update</button>
  `, `<button class="btn ghost" data-close-foot>Cancel</button><button class="btn primary" id="setsave">Save</button>`);
  back.querySelector('#setrepair').onclick = async () => {
    const btn = back.querySelector('#setrepair'); btn.disabled = true; btn.textContent = 'Repairing…';
    try {
      const r = await repairPerCache();
      toast(r.entriesFixed || r.foodsFixed ? `Repaired ${r.entriesFixed} logged, ${r.foodsFixed} saved` : 'Nothing needed repair');
      render();
    } catch { toast('Repair failed'); }
    finally { btn.disabled = false; btn.textContent = 'Repair food data'; }
  };
  back.querySelector('#setfix').onclick = async () => {
    const btn = back.querySelector('#setfix'); btn.disabled = true; btn.textContent = 'Fixing…';
    try {
      const r = await migrateBarcodeFoods((done, total) => { btn.textContent = `Fixing… ${done}/${total}`; });
      const bits = [`${r.entriesFixed} logged`, `${r.foodsFixed} saved`];
      if (r.failed) bits.push(`${r.failed} not found`);
      toast(`Fixed ${bits.join(', ')}`);
      render();
    } catch { toast('Fix failed. Check your connection.'); }
    finally { btn.disabled = false; btn.textContent = 'Fix scanned foods'; }
  };
  back.querySelector('#setver').onclick = async () => {
    toast('Updating…');
    try { if ('serviceWorker' in navigator) { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) await r.unregister(); } } catch {}
    try { if (window.caches) { for (const k of await caches.keys()) await caches.delete(k); } } catch {}
    location.reload();
  };
  back.querySelector('#setsave').onclick = async () => {
    s.apiKey = back.querySelector('#setkey').value.trim(); s.model = back.querySelector('#setmodel').value;
    s.fdcKey = back.querySelector('#setfdc').value.trim();
    s.units.weight = back.querySelector('#setwu').value; s.units.length = back.querySelector('#setlu').value;
    s.animations = back.querySelector('#setanim').checked;
    setAnim(s.animations);
    await DB.saveSettings(s); S.settings = await DB.getSettings(); closeSheet(back); toast('Settings saved'); render();
  };
  back.querySelector('[data-close-foot]').onclick = () => closeSheet(back);
  const installBtn = back.querySelector('#setinstall');
  if (!installPrompt) installBtn.textContent = 'Add via browser menu';
  installBtn.onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; } else toast('Use your browser’s “Add to Home Screen”'); };
  back.querySelector('#importfile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { const data = JSON.parse(await file.text()); await DB.importAll(data, { merge: true }); S.settings = await DB.getSettings(); closeSheet(back); toast('Imported'); render(); }
    catch { toast('Import failed. Invalid file.'); }
  };
}
function modelOpt(id, label, cur) { return `<option value="${id}" ${cur === id ? 'selected' : ''}>${label}</option>`; }

// ---------- Export ----------
function download(filename, text, type) { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function exportJSON() { const data = await DB.exportAll(); download(`macropolo-backup-${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json'); toast('Exported JSON'); }
async function exportCSV() {
  const [entries, body] = [await DB.getAllEntries(), await DB.getAllBody()];
  let csv = 'type,date,name,qty,unit,cal,protein,carbs,fat,sodium,fiber,sugar\n';
  for (const e of entries.sort((a, b) => a.date.localeCompare(b.date))) { const t = entryTotals(e); csv += ['food', e.date, csvq(e.name), G(e.qty), csvq(e.unit), K(t.kcal), G(t.protein), G(t.carbs), G(t.fat), K(t.sodium), G(t.fiber), G(t.sugar)].join(',') + '\n'; }
  csv += '\ntype,date,weight,waist,photos\n';
  for (const b of body) csv += ['body', b.date, b.weight ?? '', b.waist ?? '', (b.photos || []).length].join(',') + '\n';
  download(`macropolo-export-${todayStr()}.csv`, csv, 'text/csv'); toast('Exported CSV');
}
function csvq(s) { s = String(s ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- File helpers ----------
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => { const [meta, b64] = r.result.split(','); res({ base64: b64, mediaType: meta.match(/data:(.*?);/)[1] }); }; r.onerror = rej; r.readAsDataURL(file); });
}
async function compressToParts(file) {
  const dataUrl = await compressImage(file, 1280, 0.8);
  const [meta, b64] = dataUrl.split(',');
  return { base64: b64, mediaType: (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg', dataUrl };
}
function compressImage(file, maxDim = 1280, quality = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = height * maxDim / width; width = maxDim; }
      else if (height > maxDim) { width = width * maxDim / height; height = maxDim; }
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      res(canvas.toDataURL('image/jpeg', quality)); URL.revokeObjectURL(img.src);
    };
    img.onerror = rej; img.src = URL.createObjectURL(file);
  });
}

// ---------------- Global events ----------------
// Long-press a food checkbox to select every item in the day.
let lpTimer = null, lpFired = false, lpStart = null;
document.addEventListener('pointerdown', (e) => {
  const tog = e.target.closest('[data-act="toggle"]');
  if (!tog) return;
  lpFired = false; lpStart = { x: e.clientX, y: e.clientY };
  lpTimer = setTimeout(async () => {
    lpTimer = null; lpFired = true; haptic(14);
    const es = await DB.getEntries(S.date); es.forEach((x) => S.selection.add(x.id)); render();
  }, 450);
});
document.addEventListener('pointermove', (e) => {
  if (!lpTimer || !lpStart) return;
  if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 10) { clearTimeout(lpTimer); lpTimer = null; }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  document.addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }));

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act;
  switch (act) {
    case 'tab': if (t.dataset.tab !== S.tab) tabHistory.push(S.tab); S.tab = t.dataset.tab; S.selection.clear(); render(); break;
    case 'settings': openSettings(); break;
    case 'sort': openSortMenu(); break;
    case 'chat': openChat(); break;
    case 'date-prev': changeDay(-1); break;
    case 'date-next': changeDay(1); break;
    case 'date-pick': { const dp = document.getElementById('datepick'); dp.showPicker ? dp.showPicker() : dp.click(); break; }
    case 'add-food': openAddFood(); break;
    case 'copy-day': openCopyDay(); break;
    case 'entry': openEntryDetail(t.dataset.id); break;
    case 'toggle': { if (lpFired) { lpFired = false; break; } const id = t.dataset.id; S.selection.has(id) ? S.selection.delete(id) : S.selection.add(id); render(); break; }
    case 'sel-copy': openCopySelected(); break;
    case 'sel-dish': await saveAsDish(); break;
    case 'sel-delete': await deleteSelected(); break;
    case 'sel-clear': S.selection.clear(); render(); break;
    case 'select-all': { const es = await DB.getEntries(S.date); const all = es.length && es.every((e) => S.selection.has(e.id)); if (all) S.selection.clear(); else es.forEach((e) => S.selection.add(e.id)); render(); break; }
    case 'body-save': await saveBodyQuick(); break;
    case 'body-pickdate': { const dp = document.getElementById('bodydate'); dp.showPicker ? dp.showPicker() : dp.click(); break; }
    case 'body-range': setBodyRange(t.dataset.r); break;
    case 'body-edit': openBodyEdit(t.dataset.date); break;
    case 'body-addphoto': document.getElementById('qphotofile')?.click(); break;
    case 'photo-remove': await removePhotoFromDate(t.dataset.date, Number(t.dataset.idx)); render(); break;
    case 'photo-open': openPhotoViewer(t.dataset.date, Number(t.dataset.idx)); break;
    case 'chart-metric': S.chart.metric = t.dataset.m; render(); break;
    case 'chart-range': setChartRange(t.dataset.r); break;
    case 'export-json': exportJSON(); break;
    case 'export-csv': exportCSV(); break;
    case 'import-json': document.getElementById('importfile').click(); break;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'datepick') { S.date = e.target.value; S.selection.clear(); render(); }
  else if (e.target.id === 'bodydate') { S.date = e.target.value; render(); }
  else if (e.target.id === 'bf') { S.body.from = e.target.value; render(); }
  else if (e.target.id === 'bt') { S.body.to = e.target.value; render(); }
  else if (e.target.id === 'cf') { S.chart.from = e.target.value; render(); }
  else if (e.target.id === 'ct') { S.chart.to = e.target.value; render(); }
  else if (e.target.id === 'qphotofile') { const file = e.target.files[0]; if (file) { const url = await compressImage(file); await addPhotoToDate(S.date, url); render(); } }
});

async function deleteSelected() {
  const ids = [...S.selection]; const entries = await DB.getEntries(S.date);
  const removed = entries.filter((e) => ids.includes(e.id)); await DB.deleteEntries(ids); S.selection.clear();
  haptic(14);
  toast(`Deleted ${ids.length} item${ids.length > 1 ? 's' : ''}`, async () => { await DB.putEntries(removed); render(); }); render();
}
async function saveBodyQuick() {
  const w = document.getElementById('qw').value.trim(), s = document.getElementById('qs').value.trim();
  const cur = (await DB.getBody(S.date)) || { date: S.date };
  await DB.putBody({ ...cur, date: S.date, weight: w === '' ? null : Number(w), waist: s === '' ? null : Number(s) });
  haptic(10);
  // Confirmation: turn each just-logged field green and draw its border in.
  let animated = false;
  if (w !== '') { const wr = document.getElementById('wwrap'); if (wr) { wr.classList.add('logged'); if (animOn) { drawProgBorder(wr); animated = true; } } }
  if (s !== '') { const sr = document.getElementById('swrap'); if (sr) { sr.classList.add('logged'); if (animOn) { drawProgBorder(sr); animated = true; } } }
  toast('Saved');
  setTimeout(() => render(), animated ? 650 : 0);
}
// Draw a crisp green border around a field using a viewBox matched to its pixel size.
function drawProgBorder(wrap) {
  const svg = wrap.querySelector('.prog-ring'); const rect = svg && svg.querySelector('rect'); if (!rect) return;
  const r = wrap.getBoundingClientRect(); const W = Math.round(r.width), H = Math.round(r.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  rect.setAttribute('x', 1); rect.setAttribute('y', 1); rect.setAttribute('width', W - 2); rect.setAttribute('height', H - 2); rect.setAttribute('rx', 10);
  const len = rect.getTotalLength();
  rect.style.transition = 'none'; rect.style.strokeDasharray = len; rect.style.strokeDashoffset = len;
  void rect.getBoundingClientRect();
  rect.style.transition = 'stroke-dashoffset .5s ease'; rect.style.strokeDashoffset = '0';
}
function setBodyRange(r) { S.body.mode = r; if (r === 'custom' && !S.body.from) { S.body.from = addDays(todayStr(), -30); S.body.to = todayStr(); } render(); }
function setChartRange(r) { S.chart.mode = r; if (r === 'custom' && !S.chart.from) { S.chart.from = addDays(todayStr(), -30); S.chart.to = todayStr(); } render(); }

// ---------------- Persistence of lightweight UI state ----------------
function loadUI() {
  try {
    const u = JSON.parse(localStorage.getItem('mp.ui') || '{}');
    // Only restore the last place on a quick reload or resume-from-background
    // (active within 30 min). A genuine cold restart opens to today + Food.
    const recent = u.ts && (Date.now() - u.ts) < 30 * 60 * 1000;
    if (recent) {
      if (u.date) S.date = u.date;
      if (u.tab && ['food', 'nutrients', 'body', 'charts'].includes(u.tab)) S.tab = u.tab;
    }
    if (u.sort && ['manual', 'kcal', 'carbs', 'protein', 'fat', 'az'].includes(u.sort)) S.sort = u.sort;
  } catch {}
}
function saveUI() {
  try { localStorage.setItem('mp.ui', JSON.stringify({ date: S.date, tab: S.tab, sort: S.sort, ts: Date.now() })); } catch {}
}

// ---------------- Boot ----------------
loadUI();
initBackButton();
initSwipe();
(async () => {
  S.settings = await DB.getSettings();
  setAnim(S.settings.animations !== false);
  try { S.chat = await DB.getChat(); } catch {}
  try { await backfillLibrary(); } catch {}
  render();
})();
