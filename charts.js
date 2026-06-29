// charts.js — dependency-free SVG charts. Color is intentional; everything else is calm.

const W = 700; // viewBox width; CSS scales to container

function niceBounds(min, max, pad = 0.08) {
  if (min === max) { const d = Math.abs(min) || 1; min -= d * 0.1; max += d * 0.1; }
  const span = max - min;
  min -= span * pad; max += span * pad;
  // round to nice-ish step
  const rough = (max - min) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const steps = [1, 2, 2.5, 5, 10];
  let step = mag * 10;
  for (const s of steps) { if (mag * s >= rough) { step = mag * s; break; } }
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  return { lo, hi, step };
}

function dayNum(dateStr) {
  // days since epoch (local-agnostic, used only for relative spacing)
  return Math.round(new Date(dateStr + 'T00:00:00').getTime() / 86400000);
}

function fmtNum(n) {
  if (Math.abs(n) >= 1000) return (Math.round(n * 10) / 10).toLocaleString();
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Catmull-Rom -> bezier smoothing for a nice curve through points
function smoothPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/**
 * lineChart — points: [{x:'YYYY-MM-DD', y:Number}] (already filtered to range, sorted)
 * opts: { color, height, yMin, yMax (optional manual), unit, fill }
 */
export function lineChart(points, opts = {}) {
  const color = opts.color || 'var(--cal)';
  const H = opts.height || 260;
  const padL = 46, padR = 14, padT = 16, padB = 26;
  const id = 'g' + Math.random().toString(36).slice(2, 8);

  if (!points.length) {
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}"><text x="${W/2}" y="${H/2}" fill="var(--text-faint)" font-size="15" text-anchor="middle">No data in range</text></svg></div>`;
  }

  const ys = points.map((p) => p.y);
  let { lo, hi, step } = niceBounds(
    opts.yMin != null ? opts.yMin : Math.min(...ys),
    opts.yMax != null ? opts.yMax : Math.max(...ys)
  );
  if (opts.yMin != null) lo = opts.yMin;
  if (opts.yMax != null) hi = opts.yMax;

  const xs = points.map((p) => dayNum(p.x));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xRange = xMax - xMin || 1;

  const sx = (x) => padL + ((x - xMin) / xRange) * (W - padL - padR);
  const sy = (y) => padT + (1 - (y - lo) / (hi - lo)) * (H - padT - padB);

  const scaled = points.map((p) => ({ x: sx(dayNum(p.x)), y: sy(p.y), raw: p }));
  const path = smoothPath(scaled);
  const areaPath = path + ` L${scaled[scaled.length-1].x},${sy(lo)} L${scaled[0].x},${sy(lo)} Z`;

  // y gridlines
  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = sy(v);
    grid += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--line-soft)" stroke-width="1"/>`;
    grid += `<text x="${padL-8}" y="${y+4}" fill="var(--text-faint)" font-size="12" text-anchor="end">${fmtNum(v)}</text>`;
  }

  // x labels — first, middle-ish, last (avoid clutter)
  const labelIdx = points.length <= 3
    ? points.map((_, i) => i)
    : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  let xlabels = '';
  for (const i of [...new Set(labelIdx)]) {
    const px = scaled[i].x;
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    xlabels += `<text x="${px}" y="${H-6}" fill="var(--text-faint)" font-size="12" text-anchor="${anchor}">${fmtDate(points[i].x)}</text>`;
  }

  const last = scaled[scaled.length - 1];
  const dots = scaled.length <= 60
    ? scaled.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="${scaled.length>30?2:3}" fill="${color}"/>`).join('')
    : '';

  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <path d="${areaPath}" fill="url(#${id})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <circle cx="${last.x}" cy="${last.y}" r="5" fill="${color}"/>
    <circle cx="${last.x}" cy="${last.y}" r="9" fill="${color}" opacity="0.2"/>
    ${xlabels}
  </svg></div>`;
}

/**
 * barChart — for calorie/macro history. points: [{x:'YYYY-MM-DD', y:Number}]
 * opts: { color, height, goal (draws a dashed target line) }
 */
export function barChart(points, opts = {}) {
  const color = opts.color || 'var(--cal)';
  const H = opts.height || 220;
  const padL = 46, padR = 14, padT = 14, padB = 26;

  if (!points.length) {
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}"><text x="${W/2}" y="${H/2}" fill="var(--text-faint)" font-size="15" text-anchor="middle">No data in range</text></svg></div>`;
  }

  const ys = points.map((p) => p.y);
  const maxY = Math.max(...ys, opts.goal || 0);
  const { hi, step } = niceBounds(0, maxY, 0.05);
  const lo = 0;

  const innerW = W - padL - padR;
  const n = points.length;
  const bw = Math.max(2, Math.min(34, (innerW / n) * 0.62));
  const sx = (i) => padL + (innerW / n) * (i + 0.5);
  const sy = (y) => padT + (1 - (y - lo) / (hi - lo)) * (H - padT - padB);

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const y = sy(v);
    grid += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--line-soft)" stroke-width="1"/>`;
    grid += `<text x="${padL-8}" y="${y+4}" fill="var(--text-faint)" font-size="12" text-anchor="end">${fmtNum(v)}</text>`;
  }

  let bars = '';
  points.forEach((p, i) => {
    const x = sx(i) - bw / 2;
    const y = sy(p.y);
    const h = Math.max(0, sy(lo) - y);
    const over = opts.goal && p.y > opts.goal;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="${Math.min(4,bw/2)}" fill="${color}" opacity="${over ? 1 : 0.72}"/>`;
  });

  let goalLine = '';
  if (opts.goal) {
    const gy = sy(opts.goal);
    goalLine = `<line x1="${padL}" y1="${gy}" x2="${W-padR}" y2="${gy}" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="5 5"/>`;
  }

  const labelIdx = n <= 3 ? points.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  let xlabels = '';
  for (const i of [...new Set(labelIdx)]) {
    const px = sx(i);
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    xlabels += `<text x="${px}" y="${H-6}" fill="var(--text-faint)" font-size="12" text-anchor="${anchor}">${fmtDate(points[i].x)}</text>`;
  }

  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}">
    ${grid}${bars}${goalLine}${xlabels}
  </svg></div>`;
}

/**
 * macroDonut — segmented ring of protein/carbs/fat (by calorie share),
 * with the day's total calories in the center.
 */
export function macroDonut(macros, totalCal, opts = {}) {
  const size = opts.size || 168;
  const sw = opts.stroke || 16;
  const r = (size - sw) / 2;
  const cx = size / 2, cy = size / 2;
  const c = 2 * Math.PI * r;

  // Segments are sized by CALORIE share (carbs*4, protein*4, fat*9) — so per gram,
  // fat occupies 9/4 the arc of carbs/protein. Order: carbs, protein, fat.
  const parts = [
    { k: 'carbs', kcal: (macros.carbs || 0) * 4, color: 'var(--carbs)' },
    { k: 'protein', kcal: (macros.protein || 0) * 4, color: 'var(--protein)' },
    { k: 'fat', kcal: (macros.fat || 0) * 9, color: 'var(--fat)' },
  ];
  const sum = parts.reduce((a, b) => a + b.kcal, 0);

  let segs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>`;
  if (sum > 0) {
    const gap = 0.012 * c; // small gap between segments
    let angle = -90;
    for (const p of parts) {
      const frac = p.kcal / sum;
      if (frac <= 0) continue;
      const arc = Math.max(0, frac * c - gap);
      segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${p.color}" stroke-width="${sw}"
        stroke-dasharray="${arc} ${c - arc}" stroke-dashoffset="0"
        transform="rotate(${angle} ${cx} ${cy})"/>`;
      angle += frac * 360;
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="donut">
    ${segs}
    <text x="${cx}" y="${cy - 7}" text-anchor="middle" dominant-baseline="central" font-size="34" font-weight="780" fill="var(--text)">${Math.round(totalCal)}</text>
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="var(--text-faint)" letter-spacing="0.5">cal</text>
  </svg>`;
}
