/* regbot charts — small time-series charts drawn as SVG, with nothing to load.
 *
 * The same file draws the admin panel's telemetry (../../admin.py) and the
 * desktop app's own (desktop/ui/charts.js is a copy, kept identical by a test).
 *
 *   RegbotCharts.render(element, chart, { points, step })
 *
 * `points` are the start of each interval, in epoch seconds, oldest first;
 * `chart` is { title, unit, kind: 'line' | 'bars', series: [{ label, color,
 * values }] } with one value per point — null where there is nothing to draw.
 * Bars stack; lines break over gaps. Hovering shows every series at that point.
 * The chart redraws itself when its element changes size.
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const H = 190;
  const PAD = { l: 44, r: 12, t: 12, b: 26 };

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  /** The top of the y axis: four even steps that reach `v`, whole ones for counts. */
  function niceMax(v, whole) {
    const raw = Math.max(v > 0 ? v : 0, whole ? 4 : 0) / 4;
    if (!(raw > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) {
      const step = m * exp;
      if (step >= raw && (!whole || Number.isInteger(step))) return step * 4;
    }
    return 40 * exp;
  }

  function fmt(v, unit) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    let text;
    if (unit === '$') return `$${abs >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2)}`;
    if (abs >= 1e6) text = `${(v / 1e6).toFixed(1)}M`;
    else if (abs >= 1e4) text = `${(v / 1e3).toFixed(0)}k`;
    else if (abs >= 1000) text = `${(v / 1e3).toFixed(1)}k`;
    else if (abs >= 100 || Number.isInteger(v)) text = String(Math.round(v));
    else if (abs >= 10) text = v.toFixed(1);
    else text = String(Math.round(v * 100) / 100);
    return unit && unit !== 'credits' ? `${text} ${unit}` : text;
  }

  function when(t, span) {
    const d = new Date(t * 1000);
    if (span <= 2 * 86400) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function stackedTotals(series, n) {
    const out = new Array(n).fill(0);
    for (const s of series) for (let i = 0; i < n; i += 1) out[i] += Number(s.values[i]) || 0;
    return out;
  }

  function draw(box, chart, data) {
    const points = data.points || [];
    const n = points.length;
    const series = chart.series || [];
    const width = Math.max(260, Math.floor(box.clientWidth || 600));
    box.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, class: 'rc-svg', role: 'img',
      'aria-label': chart.title || 'chart' }, null);
    box.appendChild(svg);
    const plotW = width - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const bars = chart.kind === 'bars';
    let top = 0;
    let bottom = 0;
    if (bars) {
      top = Math.max(0, ...stackedTotals(series, n));
    } else {
      for (const s of series) {
        for (const v of s.values || []) {
          if (v === null || v === undefined) continue;
          top = Math.max(top, v);
          bottom = Math.min(bottom, v);
        }
      }
    }
    // Bars with nothing but zeros say nothing happened; a line of zeros is a measurement.
    const any = series.some((s) => (s.values || []).some((v) => v !== null && v !== undefined && (!bars || v !== 0)));
    // Counts are whole, and so is every tick on their axis.
    const whole = chart.unit !== '$' && series.every((s) => (s.values || []).every((v) => v === null || v === undefined || Number.isInteger(v)));
    top = niceMax(top, whole);
    const y = (v) => PAD.t + plotH - ((v - bottom) / (top - bottom || 1)) * plotH;
    const slot = n ? plotW / n : plotW;
    const x = (i) => PAD.l + slot * i + slot / 2;

    // Grid and y labels.
    for (let k = 0; k <= 4; k += 1) {
      const v = bottom + ((top - bottom) * k) / 4;
      const yy = y(v);
      el('line', { x1: PAD.l, x2: width - PAD.r, y1: yy, y2: yy, class: k ? 'rc-grid' : 'rc-axis' }, svg);
      const label = el('text', { x: PAD.l - 6, y: yy + 3.5, class: 'rc-tick', 'text-anchor': 'end' }, svg);
      label.textContent = fmt(v, chart.unit === '$' ? '$' : '');
    }
    // X labels: about five, on whole points, newest first, and none that would
    // run into the one beside it. The newest ends at the right edge rather than
    // overhanging it.
    const span = n > 1 ? points[n - 1] - points[0] : 0;
    const every = Math.max(1, Math.ceil(n / 5));
    let room = width;
    for (let i = n - 1; i >= 0; i -= every) {
      const text = when(points[i], span);
      const w = text.length * 6.4;
      const last = i === n - 1;
      const right = last ? width - PAD.r : x(i) + w / 2;
      if (right > room - 8 || right - w < PAD.l - 20) continue;
      const label = el('text', { x: last ? right : x(i), y: H - 8, class: 'rc-tick', 'text-anchor': last ? 'end' : 'middle' }, svg);
      label.textContent = text;
      room = right - w;
    }

    if (bars) {
      const base = new Array(n).fill(0);
      const w = Math.max(1, slot * 0.78);
      for (const s of series) {
        for (let i = 0; i < n; i += 1) {
          const v = Number(s.values[i]) || 0;
          if (!v) continue;
          const y0 = y(base[i]);
          const y1 = y(base[i] + v);
          el('rect', { x: x(i) - w / 2, y: y1, width: w, height: Math.max(0.5, y0 - y1), fill: s.color, rx: w > 6 ? 1.5 : 0 }, svg);
          base[i] += v;
        }
      }
    } else {
      for (const s of series) {
        let d = '';
        let pen = false;
        const dots = [];
        for (let i = 0; i < n; i += 1) {
          const v = s.values[i];
          if (v === null || v === undefined) { pen = false; continue; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          if (!pen && (i === n - 1 || s.values[i + 1] === null || s.values[i + 1] === undefined)) dots.push(i);
          pen = true;
        }
        if (d) el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
        for (const i of dots) el('circle', { cx: x(i), cy: y(s.values[i]), r: 2.2, fill: s.color }, svg);
      }
    }
    if (!any) {
      const t = el('text', { x: PAD.l + plotW / 2, y: PAD.t + plotH / 2, class: 'rc-empty', 'text-anchor': 'middle' }, svg);
      t.textContent = 'Nothing in this range';
    }

    // Hover: a line, and every series' value at the nearest point.
    const cursor = el('line', { y1: PAD.t, y2: PAD.t + plotH, class: 'rc-cursor', visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'rc-tip';
    tip.hidden = true;
    box.appendChild(tip);
    const hit = el('rect', { x: PAD.l, y: PAD.t, width: plotW, height: plotH, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const scale = width / rect.width;
      const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) * scale - PAD.l) / slot)));
      if (!n) return;
      cursor.setAttribute('x1', x(i));
      cursor.setAttribute('x2', x(i));
      cursor.setAttribute('visibility', 'visible');
      const rows = series.map((s) => `<div><i style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${fmt(s.values[i], chart.unit)}</b></div>`).join('');
      const end = points[i] + (data.step || 0);
      tip.innerHTML = `<div class="rc-tip-t">${new Date(points[i] * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${data.step > 60 ? ` – ${new Date(end * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</div>${rows}`;
      tip.hidden = false;
      const px = x(i) / scale;
      tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, px + 10))}px`;
      tip.style.top = '8px';
    });
    hit.addEventListener('mouseleave', () => { cursor.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** The legend under a chart: each series with its total (bars) or its latest value (lines). */
  function legend(chart) {
    return (chart.series || []).map((s) => {
      const vals = (s.values || []).filter((v) => v !== null && v !== undefined);
      const shown = chart.kind === 'bars' ? vals.reduce((a, b) => a + b, 0) : (vals.length ? vals[vals.length - 1] : null);
      return `<span class="rc-key"><i style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${fmt(shown, chart.unit)}</b>${chart.kind === 'bars' ? '' : ' <small>now</small>'}</span>`;
    }).join('');
  }

  function render(target, chart, data) {
    const box = typeof target === 'string' ? document.getElementById(target) : target;
    if (!box) return;
    box.classList.add('rc');
    let plot = box.querySelector('.rc-plot');
    let keys = box.querySelector('.rc-legend');
    if (!plot) {
      box.innerHTML = `<div class="rc-head"><span class="rc-title"></span><span class="rc-unit"></span></div><div class="rc-plot"></div><div class="rc-legend"></div>`;
      plot = box.querySelector('.rc-plot');
      keys = box.querySelector('.rc-legend');
    }
    box.querySelector('.rc-title').textContent = chart.title || '';
    box.querySelector('.rc-unit').textContent = chart.unit && chart.unit !== '$' ? chart.unit : (chart.unit === '$' ? 'US$' : '');
    keys.innerHTML = legend(chart);
    box.__rc = { chart, data };
    draw(plot, chart, data);
    if (!box.__rcWatched && typeof ResizeObserver === 'function') {
      box.__rcWatched = true;
      let last = plot.clientWidth;
      new ResizeObserver(() => {
        if (Math.abs(plot.clientWidth - last) < 4 || !box.__rc) return;
        last = plot.clientWidth;
        draw(plot, box.__rc.chart, box.__rc.data);
      }).observe(plot);
    }
  }

  const api = { render, fmt, niceMax };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RegbotCharts = api;
}(typeof window !== 'undefined' ? window : this));
