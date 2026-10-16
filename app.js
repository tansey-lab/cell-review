'use strict';
// Cell Review: a sequence of cells, each with candidate labels A/B. Answers are saved per personal link (?r=<token>).

const $ = (s) => document.querySelector(s);
const CFG = window.REVIEW_CONFIG || {};
const PALETTE = ['#ff3b30', '#34c759', '#ffcc00', '#0a84ff', '#ff9f0a', '#bf5af2', '#64d2ff',
  '#ff375f', '#a2f000', '#ffd1dc', '#00c7be', '#ac8e68'];
const SETS_KEY = 'cell-review-marker-sets-' + (new URLSearchParams(location.search).get('r') || 'local');
const UI_KEY = 'cell-review-ui';
const params = new URLSearchParams(location.search);
const TOKEN = params.get('r') || '';
const LOCAL = !(CFG.supabaseUrl && CFG.supabaseAnonKey);    // no backend configured: test mode in this browser

const st = {
  dataset: null, cells: [], idx: 0, data: null, answers: new Map(),
  mod: 'he', z: 0, hl: [], genes: [], geneSet: new Set(),
  sel: null, sv: null, slide: null,
  wv: { s: 1, x: 0, y: 0 },       // wider view: zoom factor and top-left corner of the visible part (µm)
};

// ============================================================================ backend

async function rpc(fn, args) {
  const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    // new-style publishable keys go in apikey only; legacy anon keys (JWTs) also as a bearer token
    headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json',
      ...(CFG.supabaseAnonKey.startsWith('eyJ') ? { Authorization: `Bearer ${CFG.supabaseAnonKey}` } : {}) },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const localKey = () => `cell-review-local-${st.dataset}`;
async function whoami() { return LOCAL ? 'local test mode' : rpc('review_whoami', { p_token: TOKEN }); }
async function myAnswers() {
  if (LOCAL) { try { return JSON.parse(localStorage.getItem(localKey())) || []; } catch (e) { return []; } }
  return (await rpc('review_my_answers', { p_token: TOKEN })) || [];
}
async function submit(a) {
  if (LOCAL) {
    const all = (await myAnswers()).filter((x) => x.cell_id !== a.cell_id);
    all.push({ ...a, dataset: st.dataset, updated_at: new Date().toISOString() });
    try { localStorage.setItem(localKey(), JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
    return;
  }
  await rpc('review_submit', {
    p_token: TOKEN, p_dataset: st.dataset, p_cell: a.cell_id, p_choice: a.choice, p_option_a: a.option_a,
    p_option_b: a.option_b, p_confidence: a.confidence, p_other: a.other_label || '', p_comment: a.comment || '',
  });
}

// ============================================================================ dataset and list

const base = () => `data/${st.dataset}`;

async function openDataset(id) {
  st.dataset = id;
  $('#ds-name').textContent = ((CFG.datasets || []).find((d) => d.id === id) || {}).name || '';
  const [cells, genes] = await Promise.all([
    fetch(`${base()}/cells.json`).then((r) => r.json()),
    fetch(`${base()}/genes.json`).then((r) => r.json()),
  ]);
  st.cells = cells.cells;
  st.genes = genes; st.geneSet = new Set(genes);
  $('#gene-list').innerHTML = genes.map((g) => `<option value="${g}">`).join('');
  st.answers = new Map((await myAnswers()).filter((a) => !a.dataset || a.dataset === id).map((a) => [a.cell_id, a]));
  renderList();
  const firstOpen = st.cells.findIndex((c) => !st.answers.has(c.id));
  await goTo(firstOpen >= 0 ? firstOpen : 0);
}

function renderList() {
  $('#list').innerHTML = st.cells.map((c, i) => {
    const a = st.answers.get(c.id);
    return `<div class="item${i === st.idx ? ' cur' : ''}${a ? ' done' : ''}" data-i="${i}">
      <img loading="lazy" src="${base()}/images/${c.id}/thumb.jpg" alt="">
      <span class="num">${i + 1}</span><span class="mark">${a ? '✓' : ''}</span></div>`;
  }).join('');
  const n = st.answers.size, N = st.cells.length;
  $('#progress span').textContent = `${n} of ${N} done`;
  $('#progress i').style.width = `${(100 * n) / Math.max(N, 1)}%`;
}
$('#list').addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) goTo(+it.dataset.i); });

// ============================================================================ one cell

async function goTo(i) {
  st.idx = Math.max(0, Math.min(st.cells.length - 1, i));
  const c = st.cells[st.idx];
  document.querySelectorAll('#list .item').forEach((el) => el.classList.toggle('cur', +el.dataset.i === st.idx));
  const cur = document.querySelector(`#list .item[data-i="${st.idx}"]`);
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  st.data = await (await fetch(`${base()}/cells/${c.id}.json`)).json();
  if (st.cells[st.idx] !== c) return;
  st.z = st.data.planes.length ? st.data.planes[Math.floor(st.data.planes.length / 2)] : 0;
  st.wv = { s: 1, x: 0, y: 0 };
  st.sv = null;                       // whole-slide view: fitted to the slide on first draw
  st.sel = null;                      // selected neighbouring cell (local id); null = the outlined cell
  snap = null;
  if (!MODS().some(([m]) => m === st.mod)) st.mod = 'he';
  renderQuestion(c);
  renderVignettes();
  drawMain();
  renderTable();
}

const PAN = new Set(['context', 'slide']);           // views that zoom and drag
const slideId = () => (st.data && st.data.slide && st.data.slide.id) || '';
const slideBase = () => `data/slides/${slideId()}`;
const MODS = () => [['he', 'H&E'], ['context', 'wider view'], ...(slideId() ? [['slide', 'whole slide']] : []),
  ['composite', 'stains'], ...st.data.channels.map((n, i) => [`c${i}`, n])];

function renderVignettes() {
  const c = st.cells[st.idx];
  $('#vigs').innerHTML = MODS().map(([m, lab]) => {
    const src = m === 'slide' ? `${slideBase()}/thumb.jpg` : `${base()}/images/${c.id}/${m}.jpg`;
    return `<div class="vig${m === st.mod ? ' active' : ''}" data-m="${m}"><img src="${src}" alt=""><span>${lab}</span></div>`;
  }).join('');
  modeClasses();
}
function modeClasses() {
  $('#main').classList.toggle('pannable', PAN.has(st.mod));
  $('#main').classList.toggle('pickable', !PAN.has(st.mod));
}
$('#vigs').addEventListener('click', (e) => {
  const v = e.target.closest('.vig'); if (!v) return;
  st.mod = v.dataset.m;
  document.querySelectorAll('.vig').forEach((el) => el.classList.toggle('active', el.dataset.m === st.mod));
  modeClasses();
  drawMain();
});

const imgCache = new Map();
function img(url) {
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; }));
    if (imgCache.size > 200) imgCache.delete(imgCache.keys().next().value);
  }
  return imgCache.get(url);
}

function sizeCanvas() {
  const cv = $('#main');
  const css = Math.floor(Math.min(cv.parentElement.clientWidth, cv.parentElement.clientHeight));
  const px = Math.round(css * (window.devicePixelRatio || 1));
  if (cv.width !== px) { cv.width = cv.height = px; cv.style.width = cv.style.height = `${css}px`; snap = null; }
  return px;
}

async function drawMain() {
  const d = st.data, c = st.cells[st.idx], mode = st.mod; if (!d) return;
  const depthOK = mode === 'c0' && d.planes.length > 0;
  $('#depth').hidden = !depthOK;
  if (depthOK) {
    const zr = $('#zr');
    zr.min = 0; zr.max = d.planes.length; zr.value = d.planes.indexOf(st.z) >= 0 ? d.planes.indexOf(st.z) + 1 : 0;
  }
  const useZ = depthOK && +$('#zr').value > 0;
  const file = useZ ? `z${st.z}` : mode;
  const label = useZ ? `DAPI, focal plane ${st.z + 1} of ${d.n_planes}` : (MODS().find(([m]) => m === mode) || [, ''])[1];
  $('#main-lab').textContent = PAN.has(mode) ? `${label} · scroll to zoom, drag to move, double-click to reset`
    : `${label} · click a neighbouring cell to see its transcripts`;
  $('#zl').textContent = useZ ? `plane ${st.z + 1} of ${d.n_planes}` : 'in-focus image';
  const cv = $('#main'), px = sizeCanvas(), g = cv.getContext('2d');
  const stale = () => st.cells[st.idx] !== c || st.mod !== mode;
  if (mode === 'slide') {
    const S = await loadSlide(slideId());
    if (stale() || !S) return;
    drawSlide(g, px, S);
  } else if (mode === 'context') {
    const [im, w] = await Promise.all([img(`${base()}/images/${c.id}/context.jpg`), loadWide(c.id)]);
    if (stale()) return;
    const W = d.wide.size, v = viewOf('context');
    g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
    if (im) { const f = im.width / W; g.drawImage(im, v.x0 * f, v.y0 * f, v.w * f, v.w * f, 0, 0, px, px); }
    overlayWide(g, px, d, w);
    scaleBar(g, px, v.w);
  } else {
    const im = await img(`${base()}/images/${c.id}/${file}.jpg`);
    if (stale()) return;
    g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
    if (im) g.drawImage(im, 0, 0, px, px);
    overlay(g, px, d);
    scaleBar(g, px, d.window[2] - d.window[0]);
  }
  if (PAN.has(mode)) {                          // keep the frame: zoom and drag show it instantly, then redraw
    snap = snap && snap.canvas.width === px ? snap : { canvas: document.createElement('canvas') };
    snap.canvas.width = snap.canvas.height = px;
    snap.canvas.getContext('2d').drawImage(cv, 0, 0);
    Object.assign(snap, { mode, id: c.id, v: { ...viewOf(mode) } });
  }
}

// scale bar, bottom left: a round length close to a fifth of the view
function scaleBar(g, px, um) {
  const target = um / 5, nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const L = nice.reduce((b, v) => (Math.abs(Math.log(v / target)) < Math.abs(Math.log(b / target)) ? v : b));
  const dpr = window.devicePixelRatio || 1, len = (L / um) * px, m = 12 * dpr, x = m, y = px - m;
  g.save();
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 6 * dpr;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
  g.strokeStyle = '#fff'; g.lineWidth = 3 * dpr;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y); g.stroke();
  g.font = `${12 * dpr}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  g.textBaseline = 'bottom'; g.lineWidth = 3 * dpr; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.fillStyle = '#fff';
  const t = L >= 1000 ? `${L / 1000} mm` : `${L} µm`;
  g.strokeText(t, x, y - 6 * dpr); g.fillText(t, x, y - 6 * dpr);
  g.restore();
}

// ---------------------------------------------------------------------------- zoom and drag (wider view, whole slide)
// A view is the square of the image shown, in µm: { x0, y0, w } (wider view: relative to it; slide: on the slide).
const WV_MAX = 4;          // wider view: beyond this the H&E is finer than the scan
const SV_MIN = 150;        // whole slide: narrowest view, µm (finer: use the wider view)
let snap = null, drag = null, frame = 0, idle = 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function fitSlide(S) { const w = Math.max(S.width, S.height) * 1.02; return { w, x0: (S.width - w) / 2, y0: (S.height - w) / 2 }; }
function viewOf(m) {
  if (m === 'context') { const W = st.data.wide.size, w = W / st.wv.s; return { x0: st.wv.x, y0: st.wv.y, w }; }
  return st.sv;
}
function clampW(m, w) {
  if (m === 'context') { const W = st.data.wide.size; return clamp(w, W / WV_MAX, W); }
  return clamp(w, SV_MIN, Math.max(st.slide.width, st.slide.height) * 1.2);
}
function setView(m, v) {
  if (m === 'context') {
    const W = st.data.wide.size;
    st.wv = { s: W / v.w, x: clamp(v.x0, 0, W - v.w), y: clamp(v.y0, 0, W - v.w) };
  } else {
    const S = st.slide;
    st.sv = { w: v.w, x0: clamp(v.x0, -v.w / 2, S.width - v.w / 2), y0: clamp(v.y0, -v.w / 2, S.height - v.w / 2) };
  }
}
function pointerUm(e, v) {
  const r = $('#main').getBoundingClientRect();
  return [v.x0 + ((e.clientX - r.left) / r.width) * v.w, v.y0 + ((e.clientY - r.top) / r.height) * v.w];
}
function interact() {                              // instant preview from the last frame; full redraw after a pause
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; preview(); });
  clearTimeout(idle); idle = setTimeout(drawMain, 130);
}
function preview() {
  const c = st.cells[st.idx];
  if (!snap || snap.mode !== st.mod || snap.id !== c.id) { drawMain(); return; }
  const cv = $('#main'), g = cv.getContext('2d'), px = cv.width, v = viewOf(st.mod), o = snap.v, S = snap.canvas.width;
  g.fillStyle = st.mod === 'slide' ? (st.slide.background || '#ddd') : '#000'; g.fillRect(0, 0, px, px);
  g.drawImage(snap.canvas, ((v.x0 - o.x0) / o.w) * S, ((v.y0 - o.y0) / o.w) * S, (v.w / o.w) * S, (v.w / o.w) * S, 0, 0, px, px);
}
const ready = () => st.data && PAN.has(st.mod) && (st.mod !== 'slide' || (st.sv && st.slide));
$('#main').addEventListener('wheel', (e) => {
  if (!ready()) return;
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
  const v = viewOf(st.mod), [ux, uy] = pointerUm(e, v);
  const w = clampW(st.mod, v.w * Math.exp(dy * (e.ctrlKey ? 0.012 : 0.003)));   // ctrlKey: trackpad pinch
  setView(st.mod, { w, x0: ux - (ux - v.x0) * (w / v.w), y0: uy - (uy - v.y0) * (w / v.w) });
  interact();
}, { passive: false });
$('#main').addEventListener('pointerdown', (e) => {
  if (!ready()) return;
  drag = { x: e.clientX, y: e.clientY, v: { ...viewOf(st.mod) } };
  $('#main').setPointerCapture(e.pointerId); $('#main').classList.add('dragging');
});
$('#main').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = $('#main').getBoundingClientRect(), f = drag.v.w / r.width;
  setView(st.mod, { w: drag.v.w, x0: drag.v.x0 - (e.clientX - drag.x) * f, y0: drag.v.y0 - (e.clientY - drag.y) * f });
  interact();
});
const endDrag = () => { drag = null; $('#main').classList.remove('dragging'); };
$('#main').addEventListener('pointerup', endDrag);
$('#main').addEventListener('pointercancel', endDrag);
$('#main').addEventListener('dblclick', () => {
  if (st.mod === 'context') st.wv = { s: 1, x: 0, y: 0 };
  else if (st.mod === 'slide' && st.slide) st.sv = fitSlide(st.slide);
  else return;
  drawMain();
});
$('#zr').oninput = () => {
  const v = +$('#zr').value;
  if (v > 0) st.z = st.data.planes[v - 1];
  drawMain();
};

// ---------------------------------------------------------------------------- whole slide (image tiles)
const slideCache = new Map();
function loadSlide(id) {
  if (!slideCache.has(id)) {
    slideCache.set(id, fetch(`data/slides/${id}/slide.json`).then((r) => r.json()).then((S) => {
      S.levels.forEach((l) => { l.have = new Set(l.tiles); }); return S;
    }).catch(() => null));
  }
  return slideCache.get(id).then((S) => { st.slide = S; return S; });
}
const tiles = new Map();
function tile(url) {                               // the tile if loaded; otherwise start loading it and redraw then
  let t = tiles.get(url);
  if (!t) {
    t = new Image(); t.onload = () => { if (st.mod === 'slide') { clearTimeout(idle); idle = setTimeout(drawMain, 60); } };
    t.src = url; tiles.set(url, t);
    if (tiles.size > 600) tiles.delete(tiles.keys().next().value);
  }
  return t.complete && t.naturalWidth ? t : null;
}
function drawSlide(g, px, S) {
  if (!st.sv) st.sv = fitSlide(S);
  const v = st.sv, k = px / v.w;                   // device pixels per µm
  g.fillStyle = S.background || '#ddd'; g.fillRect(0, 0, px, px);
  let L = 0;
  S.levels.forEach((l, i) => { if (l.um_per_px <= 1.4 / k) L = i; });
  for (const li of [...new Set([Math.min(L + 2, S.levels.length - 1), L])]) {   // coarse first (fills gaps), then sharp
    const l = S.levels[li], T = S.tile * l.um_per_px;
    const tx0 = Math.max(0, Math.floor(v.x0 / T)), ty0 = Math.max(0, Math.floor(v.y0 / T));
    const tx1 = Math.min(l.nx - 1, Math.floor((v.x0 + v.w) / T)), ty1 = Math.min(l.ny - 1, Math.floor((v.y0 + v.w) / T));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx}_${ty}`; if (!l.have.has(key)) continue;
        const im = tile(`${slideBase()}/${li}/${key}.jpg`);
        if (im) g.drawImage(im, (tx * T - v.x0) * k, (ty * T - v.y0) * k, T * k + 1, T * k + 1);
      }
    }
  }
  overlaySlide(g, px, v, k);
  scaleBar(g, px, v.w);
}
function overlaySlide(g, px, v, k) {
  const d = st.data, [sx, sy] = d.slide.origin, [ox, oy] = d.wide.offset, W = d.wide.size;
  const dpr = window.devicePixelRatio || 1, lw = dpr / k;
  g.save();
  g.setTransform(k, 0, 0, k, -v.x0 * k, -v.y0 * k);
  const bx = sx - ox, by = sy - oy;                // the wider view on the slide
  g.lineWidth = 3.5 * lw; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.strokeRect(bx, by, W, W);
  g.lineWidth = 1.8 * lw; g.strokeStyle = '#ffd60a'; g.strokeRect(bx, by, W, W);
  if (W * k < 16 * dpr) {                          // too small to see: a ring of fixed size around it
    const cx = bx + W / 2, cy = by + W / 2, r = 16 * lw;
    g.lineWidth = 3.5 * lw; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke();
    g.lineWidth = 2 * lw; g.strokeStyle = '#ffd60a'; g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.stroke();
  }
  if ($('#ov-outlines').checked) {
    g.translate(sx, sy);
    g.lineWidth = 2 * lw; g.strokeStyle = '#ff4fd8'; for (const o of d.outline) g.stroke(flatPath(o));
  }
  g.restore();
}

// ---------------------------------------------------------------------------- outlines, transcripts, neighbours
function flatPath(f) { const p = new Path2D(); for (let i = 0; i < f.length; i += 2) (i ? p.lineTo(f[i], f[i + 1]) : p.moveTo(f[i], f[i + 1])); p.closePath(); return p; }
function payloadPath(pl, only = null) {
  const p = new Path2D(); let o = 0;
  for (let i = 0; i < pl.cell.length; i++) {
    const keep = only === null || pl.cell[i] === only;
    for (let j = 0; j < pl.n[i]; j++, o += 2) if (keep) (j ? p.lineTo(pl.xy[o], pl.xy[o + 1]) : p.moveTo(pl.xy[o], pl.xy[o + 1]));
    if (keep) p.closePath();
  }
  return p;
}
function inPoly(xy, o, n, x, y) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xy[o + 2 * i], yi = xy[o + 2 * i + 1], xj = xy[o + 2 * j], yj = xy[o + 2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// depth: dot size grows with z (5th to 95th percentile of the view mapped to 0.45x to 2x)
const depthOn = () => $('#ov-depth').checked;
function zRange(z) {
  const s = Array.from(z).sort((a, b) => a - b);
  return s.length ? [s[Math.floor(s.length * 0.05)], s[Math.floor(s.length * 0.95)] || s[s.length - 1]] : [0, 1];
}
const zScale = (z, zr) => 0.45 + 1.55 * clamp((z - zr[0]) / (zr[1] - zr[0] || 1), 0, 1);

function overlay(g, px, d) {
  const [x0, y0, x1] = d.window, k = px / (x1 - x0), lw = 1 / k;
  g.save();
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  if ($('#ov-outlines').checked) {
    g.lineWidth = lw; g.strokeStyle = 'rgba(255,255,255,0.45)'; g.stroke(payloadPath(d.neighbors.cell));
    g.setLineDash([3 * lw, 2 * lw]); g.strokeStyle = 'rgba(56,214,255,0.45)'; g.stroke(payloadPath(d.neighbors.nucleus)); g.setLineDash([]);
    g.lineWidth = 2.5 * lw; g.strokeStyle = '#ff4fd8'; for (const o of d.outline) g.stroke(flatPath(o));
    g.lineWidth = 1.5 * lw; g.strokeStyle = '#38d6ff'; for (const o of d.nuclei) g.stroke(flatPath(o));
  }
  if (st.sel !== null) {                            // the selected neighbouring cell
    g.lineWidth = 2.5 * lw; g.strokeStyle = '#ffd60a'; g.stroke(payloadPath(d.neighbors.cell, st.sel));
    g.setLineDash([3 * lw, 2 * lw]); g.lineWidth = 1.5 * lw; g.stroke(payloadPath(d.neighbors.nucleus, st.sel)); g.setLineDash([]);
  }
  const t = d.tx, hl = new Map(st.hl.map((h) => [h.name, h.color]));
  const r = Math.max(1.6, 2.4 * px / 700) / k, dz = depthOn() && t.z;
  if (dz && !d._zr) d._zr = zRange(t.z);
  const ri = (i) => (dz ? r * zScale(t.z[i], d._zr) : r);
  if ($('#ov-all').checked) {
    g.fillStyle = 'rgba(230,230,230,0.75)';
    for (let i = 0; i < t.x.length; i++) if (!hl.has(d.genes[t.g[i]])) { const q = ri(i); g.fillRect(t.x[i] - q / 2, t.y[i] - q / 2, q, q); }
  }
  if ($('#ov-hl').checked || $('#ov-all').checked) {
    for (let i = 0; i < t.x.length; i++) {
      const col = hl.get(d.genes[t.g[i]]); if (!col) continue;
      const q = ri(i);
      g.fillStyle = '#000'; g.fillRect(t.x[i] - q - lw, t.y[i] - q - lw, 2 * q + 2 * lw, 2 * q + 2 * lw);
      g.fillStyle = col; g.fillRect(t.x[i] - q, t.y[i] - q, 2 * q, 2 * q);
    }
  }
  g.restore();
}

// click a neighbouring cell (focus views) to show its transcripts in the table; click the outlined cell to go back
$('#main').addEventListener('click', (e) => {
  const d = st.data; if (!d || PAN.has(st.mod)) return;
  const r = $('#main').getBoundingClientRect(), [x0, y0, x1] = d.window;
  const ux = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0), uy = y0 + ((e.clientY - r.top) / r.height) * (x1 - x0);
  let sel = null;
  if (!d.outline.some((o) => inPoly(o, 0, o.length / 2, ux, uy))) {
    const pl = d.neighbors.cell; let o = 0;
    for (let i = 0; i < pl.cell.length; o += 2 * pl.n[i], i++) {
      if (pl.cell[i] !== d.neighbors.self && inPoly(pl.xy, o, pl.n[i], ux, uy)) { sel = pl.cell[i]; break; }
    }
  }
  if (sel !== null && !(d.neighbor_tx && d.neighbor_tx.cells[sel])) sel = null;
  if (sel === st.sel) return;
  st.sel = sel;
  drawMain(); renderTable();
});

// wider view: every transcript of the extended neighborhood, loaded once per cell
// (uint32 n, then uint16 x, y in 0.01 µm, uint16 gene, uint16 z in 0.01 µm)
const wideCache = new Map();
function loadWide(id) {
  if (!wideCache.has(id)) {
    wideCache.set(id, fetch(`${base()}/cells/${id}.wide.bin`).then((r) => r.arrayBuffer()).then((buf) => {
      const n = new Uint32Array(buf, 0, 1)[0];
      return { n, x: new Uint16Array(buf, 4, n), y: new Uint16Array(buf, 4 + 2 * n, n), g: new Uint16Array(buf, 4 + 4 * n, n),
        z: buf.byteLength >= 4 + 8 * n ? new Uint16Array(buf, 4 + 6 * n, n) : null };
    }).catch(() => null));
    if (wideCache.size > 20) wideCache.delete(wideCache.keys().next().value);
  }
  return wideCache.get(id);
}

function overlayWide(g, px, d, w) {
  const W = d.wide, v = viewOf('context'), k = px / v.w, [ox, oy] = W.offset, size = d.window[2] - d.window[0];
  g.save();
  g.setTransform(k, 0, 0, k, -v.x0 * k, -v.y0 * k);
  const lw = 1 / k;
  if (w) {
    const hl = new Map(st.hl.map((h) => [h.name, h.color]));
    const col = W.genes.map((name) => hl.get(name) || null);
    const r = Math.max(1.2, 1.8 * px / 700) / k, dz = depthOn() && w.z;
    if (dz && !w.zr) w.zr = zRange(w.z);
    const ri = (i) => (dz ? r * zScale(w.z[i], w.zr) : r);
    if ($('#ov-all').checked) {
      g.fillStyle = 'rgba(230,230,230,0.6)';
      for (let i = 0; i < w.n; i++) if (!col[w.g[i]]) { const q = ri(i); g.fillRect(w.x[i] / 100 - q / 2, w.y[i] / 100 - q / 2, q, q); }
    }
    if ($('#ov-hl').checked || $('#ov-all').checked) {
      for (let i = 0; i < w.n; i++) {
        const c = col[w.g[i]]; if (!c) continue;
        const x = w.x[i] / 100, y = w.y[i] / 100, q = ri(i);
        g.fillStyle = '#000'; g.fillRect(x - q - lw, y - q - lw, 2 * q + 2 * lw, 2 * q + 2 * lw);
        g.fillStyle = c; g.fillRect(x - q, y - q, 2 * q, 2 * q);
      }
    }
  }
  if ($('#ov-outlines').checked) {
    g.translate(ox, oy);
    g.lineWidth = 1.5 * lw; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.setLineDash([4 * lw, 3 * lw]);
    g.strokeRect(0, 0, size, size); g.setLineDash([]);
    g.lineWidth = 2 * lw; g.strokeStyle = '#ff4fd8'; for (const o of d.outline) g.stroke(flatPath(o));
  }
  g.restore();
}

['#ov-outlines', '#ov-hl', '#ov-all', '#ov-depth'].forEach((id) => { $(id).onchange = drawMain; });
new ResizeObserver(() => drawMain()).observe($('#stage'));

// ============================================================================ question

function renderQuestion(c) {
  const a = st.answers.get(c.id) || {};
  const opts = [['A', c.A], ['B', c.B], ['neither', 'neither of these'], ['unsure', "can't tell"],
    ['multiple', 'the outline covers more than one cell']];
  $('#choices').innerHTML = opts.map(([v, lab], i) => `<label class="choice${a.choice === v ? ' on' : ''}">
      <input type="radio" name="choice" value="${v}" ${a.choice === v ? 'checked' : ''}>
      <span class="k">${i + 1}</span><span class="t">${lab}</span></label>`).join('');
  otherBox(a.choice);
  $('#other').value = a.other_label || '';
  document.querySelectorAll('input[name=conf]').forEach((r) => { r.checked = +r.value === +(a.confidence || 0); });
  $('#comment').value = a.comment || '';
  $('#save-msg').textContent = a.updated_at ? `saved ${new Date(a.updated_at).toLocaleString()}` : '';
  $('#prev').disabled = st.idx === 0;
}
$('#choices').addEventListener('change', () => {
  const v = (document.querySelector('input[name=choice]:checked') || {}).value;
  document.querySelectorAll('.choice').forEach((el) => el.classList.toggle('on', el.querySelector('input').checked));
  otherBox(v);
  if (v === 'neither' || v === 'multiple') $('#other').focus();
});
function otherBox(v) {
  $('#other').hidden = v !== 'neither' && v !== 'multiple';
  $('#other').placeholder = v === 'multiple' ? 'which cell types? (optional)' : 'if neither: what is it?';
}

async function save() {
  const c = st.cells[st.idx];
  const choice = (document.querySelector('input[name=choice]:checked') || {}).value;
  if (!choice) { $('#save-msg').textContent = 'Pick an answer first.'; return; }
  const conf = +((document.querySelector('input[name=conf]:checked') || {}).value || 0) || null;
  const a = { cell_id: c.id, choice, option_a: c.A, option_b: c.B, confidence: conf,
    other_label: choice === 'neither' || choice === 'multiple' ? $('#other').value.trim() : '', comment: $('#comment').value.trim() };
  $('#save').disabled = true; $('#save-msg').textContent = 'saving…';
  try {
    await submit(a);
    st.answers.set(c.id, { ...a, updated_at: new Date().toISOString() });
    renderList();
    const next = st.cells.findIndex((x, j) => j > st.idx && !st.answers.has(x.id));
    await goTo(next >= 0 ? next : Math.min(st.idx + 1, st.cells.length - 1));
  } catch (e) {
    $('#save-msg').textContent = `Could not save (${e.message}). Check your connection and try again.`;
  } finally { $('#save').disabled = false; }
}
$('#save').onclick = save;
$('#prev').onclick = () => goTo(st.idx - 1);

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if ('12345'.includes(e.key)) { const r = document.querySelectorAll('input[name=choice]')[+e.key - 1]; if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }
  else if (e.key === 'Enter') save();
  else if (e.key === 'ArrowLeft') goTo(st.idx - 1);
  else if (e.key === 'ArrowRight') goTo(st.idx + 1);
});

// ============================================================================ genes: highlights, sets, table

function toggleHl(name) {
  const i = st.hl.findIndex((h) => h.name === name);
  if (i >= 0) st.hl.splice(i, 1);
  else if (st.hl.length < PALETTE.length) {
    const used = new Set(st.hl.map((h) => h.color));
    st.hl.push({ name, color: PALETTE.find((c) => !used.has(c)) });
  }
  hlChanged();
}
function hlChanged() {
  $('#chips').innerHTML = st.hl.map((h) => `<span class="chip"><i style="background:${h.color}"></i>${h.name}<span class="x" data-g="${h.name}">×</span></span>`).join('');
  drawMain(); renderTable();
}
$('#chips').addEventListener('click', (e) => { const x = e.target.closest('.x'); if (x) toggleHl(x.dataset.g); });
$('#gene-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const n = e.target.value.trim().toUpperCase();
  if (!st.geneSet.has(n)) { e.target.style.borderColor = '#ff4d4d'; return; }
  e.target.style.borderColor = '';
  if (!st.hl.some((h) => h.name === n)) toggleHl(n);
  e.target.value = '';
});
$('#hl-clear').onclick = () => { st.hl = []; hlChanged(); };

function loadSets() { try { return JSON.parse(localStorage.getItem(SETS_KEY)) || {}; } catch (e) { return {}; } }
let setsTimer = null;
function saveSets(s) {
  try { localStorage.setItem(SETS_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
  renderSets();
  if (LOCAL) return;
  clearTimeout(setsTimer);
  setsTimer = setTimeout(() => rpc('review_save_sets', { p_token: TOKEN, p_sets: s }).catch(() => { /* kept locally; retried on next change */ }), 600);
}
async function pullSets() {
  if (LOCAL) return;
  try {
    const s = await rpc('review_get_sets', { p_token: TOKEN });
    if (s && typeof s === 'object') { localStorage.setItem(SETS_KEY, JSON.stringify(s)); renderSets(); }
    else if (Object.keys(loadSets()).length) saveSets(loadSets());     // first visit with sets made before syncing
  } catch (e) { /* offline: keep the local copy */ }
}
function renderSets() {
  const s = loadSets(), names = Object.keys(s).sort((a, b) => a.localeCompare(b));
  $('#sets').innerHTML = names.map((n) => `<div class="set" data-n="${encodeURIComponent(n)}">
      <div class="set-head"><span class="name">${n}</span><span class="hint">${s[n].length} gene${s[n].length === 1 ? '' : 's'}</span>
        <button class="apply" ${s[n].length ? '' : 'disabled'}>show</button><button class="del" title="delete this set">×</button></div>
      <div class="set-genes">${s[n].map((g) => `<span class="chip">${g}<span class="gx" data-g="${g}">×</span></span>`).join('')}</div>
      <input class="set-add" list="gene-list" placeholder="add a gene, Enter" autocomplete="off"></div>`).join('');
}
function createSet() {
  const inp = $('#set-name'), n = inp.value.trim();
  if (!n) { inp.style.borderColor = '#ff4d4d'; inp.focus(); return; }
  inp.style.borderColor = '';
  const s = loadSets(); if (!s[n]) s[n] = []; saveSets(s); inp.value = '';
  const card = [...document.querySelectorAll('#sets .set')].find((el) => decodeURIComponent(el.dataset.n) === n);
  if (card) card.querySelector('.set-add').focus();
}
$('#set-create').onclick = createSet;
$('#set-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createSet(); });
$('#sets').addEventListener('click', (e) => {
  const row = e.target.closest('.set'); if (!row) return;
  const n = decodeURIComponent(row.dataset.n), s = loadSets();
  if (e.target.classList.contains('apply')) { for (const g of s[n] || []) if (!st.hl.some((h) => h.name === g) && st.hl.length < PALETTE.length) { const used = new Set(st.hl.map((h) => h.color)); st.hl.push({ name: g, color: PALETTE.find((c) => !used.has(c)) }); } hlChanged(); }
  else if (e.target.classList.contains('del')) { delete s[n]; saveSets(s); }
  else if (e.target.classList.contains('gx')) { s[n] = (s[n] || []).filter((g) => g !== e.target.dataset.g); saveSets(s); }
});
$('#sets').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.classList.contains('set-add')) return;
  const n = decodeURIComponent(e.target.closest('.set').dataset.n), g = e.target.value.trim().toUpperCase();
  if (!st.geneSet.has(g)) { e.target.style.borderColor = '#ff4d4d'; return; }
  const s = loadSets(); if (!(s[n] || []).includes(g)) s[n] = [...(s[n] || []), g]; saveSets(s);
  const card = [...document.querySelectorAll('#sets .set')].find((el) => decodeURIComponent(el.dataset.n) === n);
  if (card) card.querySelector('.set-add').focus();
});

const tbl = { sort: 'cell', dir: -1 };
function neighbourRows(d) {
  const nt = d.neighbor_tx, nc = nt.cells[st.sel];
  return nc.g.map((gi, j) => ({ gene: nt.genes[gi], nuc: nc.nuc[j], cell: nc.cell[j], out: nc.band[j],
    ratio: nc.cell[j] / Math.max(nt.density[gi] * nc.area, 1e-3) }));
}
function renderTable() {
  const d = st.data; if (!d) return;
  if (st.sel !== null) return renderRows(neighbourRows(d), true);
  const t = d.tx, acc = new Map();
  for (let i = 0; i < t.g.length; i++) {
    const gi = t.g[i];
    let a = acc.get(gi);
    if (!a) { a = { gene: d.genes[gi], ctl: d.gene_category[gi].indexOf('gene') < 0, nuc: 0, cell: 0, win: 0 }; acc.set(gi, a); }
    a.win++; if (t.in_cell[i]) a.cell++; if (t.in_nuc[i]) a.nuc++;
  }
  let rows = [...acc.values()].filter((r) => !r.ctl);
  const dens = new Map(d.genes.map((gname, i) => [gname, d.density[i]]));
  // vs tissue: molecules inside the cell / molecules expected in a region of that size at the tissue-wide density
  for (const r of rows) { r.out = r.win - r.cell; r.ratio = r.cell / Math.max(dens.get(r.gene) * d.area_cell, 1e-3); }
  renderRows(rows, false);
}
function renderRows(rows, neighbour) {
  const nIn = rows.reduce((s, r) => s + r.cell, 0), nNuc = rows.reduce((s, r) => s + r.nuc, 0);
  $('#tx-summary').innerHTML = (neighbour ? '<span class="nb">Neighbouring cell</span> (yellow outline). <a href="#" id="sel-back">Back to the outlined cell</a><br>' : '')
    + `<b>${nIn}</b> molecules inside the cell (<b>${rows.filter((r) => r.cell).length}</b> genes), <b>${nNuc}</b> inside the nucleus. Hover a column title for its meaning.`;
  const f = $('#tbl-filter').value.trim().toUpperCase();
  if (f) rows = rows.filter((r) => r.gene.includes(f));
  rows.sort((a, b) => (tbl.sort === 'gene' ? a.gene.localeCompare(b.gene) * -tbl.dir : (a[tbl.sort] - b[tbl.sort]) * tbl.dir) || b.cell - a.cell);
  const cols = [['gene', 'gene', 'gene name'],
    ['nuc', 'nucleus', 'molecules inside the nucleus outline'],
    ['cell', 'cell', 'molecules inside the cell outline (includes the nucleus)'],
    ['out', 'neighborhood', neighbour ? 'molecules within 3 µm outside its outline' : 'molecules in the window around the cell, outside its outline'],
    ['ratio', 'vs tissue', 'how many times more molecules are inside the cell than expected from the average density of this gene over the whole tissue']];
  $('#tbl thead').innerHTML = '<tr>' + cols.map(([k, l, tip]) => `<th data-k="${k}" title="${tip}" class="${k === tbl.sort ? 'sorted' : ''}">${l}${k === tbl.sort ? (tbl.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr>';
  const hl = new Map(st.hl.map((h) => [h.name, h.color]));
  const fr = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  $('#tbl tbody').innerHTML = rows.slice(0, 300).map((r) => `<tr data-g="${r.gene}"><td>${hl.has(r.gene) ? `<i style="background:${hl.get(r.gene)}"></i>` : ''}${r.gene}</td>
    <td>${r.nuc || ''}</td><td>${r.cell || ''}</td><td>${r.out || ''}</td><td>${r.cell ? fr(r.ratio) : ''}</td></tr>`).join('');
}
$('#tbl thead').addEventListener('click', (e) => {
  const th = e.target.closest('th'); if (!th) return;
  const k = th.dataset.k; if (tbl.sort === k) tbl.dir *= -1; else { tbl.sort = k; tbl.dir = k === 'gene' ? 1 : -1; }
  renderTable();
});
$('#tbl tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-g]'); if (tr) toggleHl(tr.dataset.g); });
$('#tbl-filter').oninput = renderTable;
$('#tx-summary').addEventListener('click', (e) => {
  if (e.target.id !== 'sel-back') return;
  e.preventDefault(); st.sel = null; drawMain(); renderTable();
});

// ============================================================================ layout

function setRightCollapsed(on) {
  document.body.classList.toggle('right-collapsed', on);
  $('#toggle-right').textContent = on ? '⟨' : '⟩';
  try { localStorage.setItem(UI_KEY, JSON.stringify({ rightCollapsed: on })); } catch (e) { /* storage unavailable */ }
}
$('#toggle-right').onclick = () => setRightCollapsed(!document.body.classList.contains('right-collapsed'));

// ============================================================================ start

function gate(msg) { $('#gate-msg').innerHTML = msg; $('#gate').hidden = false; }

(async function init() {
  let name = null;
  if (!LOCAL && !TOKEN) return gate('This review is open through a personal link. Please use the link you were sent.');
  try { name = await whoami(); } catch (e) { return gate(`Could not reach the review server (${e.message}).`); }
  if (!name) return gate('This link is not valid. Please use the link you were sent.');
  $('#who').innerHTML = `<b>${name}</b>` + (LOCAL ? ' <span class="hint">answers stay in this browser</span>' : '');
  const ds = CFG.datasets || [];
  $('#dataset').innerHTML = ds.map((d) => `<option value="${d.id}">${d.name}</option>`).join('');
  $('#dataset-row').hidden = ds.length < 2;
  $('#dataset').onchange = (e) => openDataset(e.target.value);
  const wanted = ds.find((d) => d.id === params.get('d'));      // ?d=<set id> opens that set
  if (wanted) $('#dataset').value = wanted.id;
  try { if ((JSON.parse(localStorage.getItem(UI_KEY)) || {}).rightCollapsed) setRightCollapsed(true); } catch (e) { /* ignore */ }
  renderSets();
  pullSets();
  $('#app').hidden = false;
  await openDataset((wanted || ds[0] || {}).id);
})();
