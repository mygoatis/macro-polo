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
// Bucket-average down to ~maxPts so multi-year ranges stay smooth to render.
function downsample(points, maxPts) {
  if (points.length <= maxPts) return points;
  const step = points.length / maxPts;
  const out = [];
  for (let i = 0; i < maxPts; i++) {
    const s = Math.floor(i * step), e = Math.max(s + 1, Math.floor((i + 1) * step));
    const slice = points.slice(s, e);
    const avg = slice.reduce((a, p) => a + p.y, 0) / slice.length;
    out.push({ x: slice[Math.floor(slice.length / 2)].x, y: avg });
  }
  return out;
}

// Registry of per-chart hit-test data for the drag-to-inspect scrubber.
const _scrub = new Map();
let _cid = 0;
export function resetScrubData() { _scrub.clear(); _cid = 0; }

export function lineChart(rawPoints, opts = {}) {
  const color = opts.color || 'var(--cal)';
  const unit = opts.unit || '';
  const round = !!opts.round;
  const H = opts.height || 260;
  const padL = 46, padR = 14, padT = 16, padB = 26;
  const id = 'g' + Math.random().toString(36).slice(2, 8);

  if (!rawPoints.length) {
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}"><text x="${W/2}" y="${H/2}" fill="var(--text-faint)" font-size="15" text-anchor="middle">No data in range</text></svg></div>`;
  }

  // Scales come from the FULL data so hit-testing and the highlighted dot are exact.
  const ys = rawPoints.map((p) => p.y);
  let { lo, hi, step } = niceBounds(
    opts.yMin != null ? opts.yMin : Math.min(...ys),
    opts.yMax != null ? opts.yMax : Math.max(...ys)
  );
  if (opts.yMin != null) lo = opts.yMin;
  if (opts.yMax != null) hi = opts.yMax;

  const xs = rawPoints.map((p) => dayNum(p.x));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xRange = xMax - xMin || 1;

  const sx = (x) => padL + ((x - xMin) / xRange) * (W - padL - padR);
  const sy = (y) => padT + (1 - (y - lo) / (hi - lo)) * (H - padT - padB);

  // The drawn line is downsampled only for rendering speed on multi-year ranges.
  const points = downsample(rawPoints, 400);
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

  // x labels + faint vertical guides
  const firstDN = dayNum(points[0].x), lastDN = dayNum(points[points.length - 1].x);
  const spanDays = lastDN - firstDN;
  const usableW = W - padL - padR;
  let xlabels = '', vgrid = '';
  const place = (px, text, anchor) => {
    vgrid += `<line x1="${px}" y1="${padT}" x2="${px}" y2="${H - padB}" stroke="var(--line-soft)" stroke-width="1"/>`;
    xlabels += `<text x="${px}" y="${H - 6}" fill="var(--text-faint)" font-size="12" text-anchor="${anchor}">${text}</text>`;
  };
  if (spanDays > 380) {
    // multi-year: a tick per year (as many as fit)
    const y0 = +points[0].x.slice(0, 4), y1 = +points[points.length - 1].x.slice(0, 4);
    const maxYears = Math.max(2, Math.floor(usableW / 42));
    const stepY = Math.ceil((y1 - y0 + 1) / maxYears);
    for (let y = y0; y <= y1; y += stepY) {
      let dn = dayNum(`${y}-01-01`);
      if (dn < firstDN) dn = firstDN;
      if (dn > lastDN) break;
      const px = sx(dn);
      const anchor = px <= padL + 16 ? 'start' : px >= W - padR - 16 ? 'end' : 'middle';
      place(px, String(y), anchor);
    }
  } else {
    const n = points.length;
    const count = Math.min(Math.max(4, Math.floor(usableW / 72)), n);
    for (let i = 0; i < count; i++) {
      const idx = count === 1 ? 0 : Math.round((i * (n - 1)) / (count - 1));
      const px = scaled[idx].x;
      const anchor = i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle';
      place(px, fmtDate(points[idx].x), anchor);
    }
  }

  const last = scaled[scaled.length - 1];
  const dots = scaled.length <= 60
    ? scaled.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="${scaled.length>30?2:3}" fill="${color}"/>`).join('')
    : '';

  // Exact per-day hit points for the scrubber (from full data, not the drawn line).
  const cid = 'sc' + (++_cid);
  _scrub.set(cid, {
    hit: rawPoints.map((p) => ({ x: sx(dayNum(p.x)), y: sy(p.y), date: p.x, val: p.y })),
    color, unit, round, W, padT, padB,
  });

  return `<div class="chart-wrap" data-cid="${cid}"><svg viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    ${vgrid}
    <path d="${areaPath}" fill="url(#${id})" class="area-fade"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="line-draw" pathLength="1"/>
    ${dots}
    <circle cx="${last.x}" cy="${last.y}" r="5" fill="${color}"/>
    <circle cx="${last.x}" cy="${last.y}" r="9" fill="${color}" opacity="0.2" class="dot-pulse"/>
    ${xlabels}
    <g class="scrub" style="visibility:hidden;pointer-events:none">
      <line class="scrub-line" x1="0" y1="${padT}" x2="0" y2="${H - padB}" stroke="${color}" stroke-width="1.5" opacity="0.55"/>
      <circle class="scrub-halo" r="9" fill="var(--bg-elev)"/>
      <circle class="scrub-dot" r="5" fill="${color}"/>
      <rect class="scrub-pill-bg" x="0" y="1" width="10" height="23" rx="11" fill="var(--bg-elev-2)" stroke="var(--line)"/>
      <text class="scrub-pill-tx" x="0" y="17" text-anchor="middle" fill="var(--text)" font-size="13" font-weight="700"></text>
    </g>
  </svg></div>`;
}

// Wire drag/hover scrubbing on every line chart found under `root`.
export function attachScrub(root) {
  root.querySelectorAll('.chart-wrap[data-cid]').forEach((wrap) => {
    const meta = _scrub.get(wrap.dataset.cid);
    if (!meta || !meta.hit.length) return;
    const svg = wrap.querySelector('svg');
    const g = wrap.querySelector('.scrub');
    const vline = wrap.querySelector('.scrub-line');
    const halo = wrap.querySelector('.scrub-halo');
    const dot = wrap.querySelector('.scrub-dot');
    const pbg = wrap.querySelector('.scrub-pill-bg');
    const ptx = wrap.querySelector('.scrub-pill-tx');
    const HP = meta.hit;
    const fmtV = (v) => (meta.round ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString();
    const nearest = (X) => {
      if (X <= HP[0].x) return HP[0];
      if (X >= HP[HP.length - 1].x) return HP[HP.length - 1];
      let a = 0, b = HP.length - 1;
      while (a < b) { const m = (a + b) >> 1; if (HP[m].x < X) a = m + 1; else b = m; }
      const p0 = HP[a - 1], p1 = HP[a];
      return (X - p0.x) <= (p1.x - X) ? p0 : p1;
    };
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const X = (clientX - r.left) * meta.W / r.width;
      const p = nearest(X);
      vline.setAttribute('x1', p.x); vline.setAttribute('x2', p.x);
      halo.setAttribute('cx', p.x); halo.setAttribute('cy', p.y);
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
      const d = new Date(p.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      ptx.textContent = `${d} · ${fmtV(p.val)}${meta.unit ? ' ' + meta.unit : ''}`;
      const pw = ptx.getComputedTextLength() + 22, half = pw / 2;
      const cx = Math.min(Math.max(p.x, half + 2), meta.W - half - 2);
      pbg.setAttribute('x', cx - half); pbg.setAttribute('width', pw);
      ptx.setAttribute('x', cx);
      g.style.visibility = 'visible';
    };
    const hide = () => { g.style.visibility = 'hidden'; };
    let active = false, engaged = false, x0 = 0, y0 = 0;
    svg.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { active = true; engaged = false; x0 = e.clientX; y0 = e.clientY; } });
    svg.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') { show(e.clientX); return; }
      if (!active) return;
      if (!engaged) {
        const dx = e.clientX - x0, dy = e.clientY - y0;
        if (Math.abs(dx) > 5 && Math.abs(dx) > Math.abs(dy)) { engaged = true; try { svg.setPointerCapture(e.pointerId); } catch {} }
        else return;
      }
      show(e.clientX);
    });
    const end = () => { active = false; engaged = false; hide(); };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  });
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
