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
  sv: null, slide: null,
  draw: null,                     // drawing mode: 'nuc' | 'cell' | null
  mine: { nuc: null, cell: null }, // the reviewer's outlines of this cell (flat µm, focus-window coordinates)
  zsel: null,                     // depth interval shown [lo, hi] in µm; null = all
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
  // an answer counts only if it was given against the options shown now (labels can be updated between versions)
  const shown = new Map(st.cells.map((c) => [c.id, c]));
  const current = (a) => { const c = shown.get(a.cell_id); return c && (!a.option_a || (a.option_a === c.A && a.option_b === c.B)); };
  st.answers = new Map((await myAnswers()).filter((a) => (!a.dataset || a.dataset === id) && current(a)).map((a) => [a.cell_id, a]));
  await pullMine(id);
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
  st.mine = loadMine()[c.id] || { nuc: null, cell: null };
  st.zsel = null;
  hover = vdrag = null;
  setDraw(null);
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
  $('#main').classList.toggle('drawing', !!st.draw && !PAN.has(st.mod));
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
  if (!PAN.has(mode)) st.lastFocus = mode;
  $('#he-note').hidden = !['he', 'context', 'slide'].includes(mode);
  $('#main-lab').textContent = PAN.has(mode) ? `${label} · scroll to zoom, drag to move, double-click to reset`
    : st.draw ? `${label} · click points around the ${st.draw === 'nuc' ? 'nucleus' : 'cell'}, then the first point (or Enter) to close · or press and trace · Esc cancels`
    : st.mine.nuc || st.mine.cell ? `${label} · drag a point to move it · click an edge to add one · Alt-click a point to remove it`
    : `${label} · ✎ under the image: draw the nucleus and the cell`;
  $('#zl').textContent = useZ ? `plane ${st.z + 1} of ${d.n_planes}` : 'in-focus image';
  const cv = $('#main'), px = sizeCanvas(), g = cv.getContext('2d');
  drawZbar();
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
  if ($('#ov-outlines').checked) { g.translate(sx, sy); marker(g, lw); }
  g.restore();
}

// ---------------------------------------------------------------------------- marker, the reviewer's outlines, transcripts
// The 10x segmentation is not shown (its cell outlines often take in parts of neighbouring cells): a dot marks the
// centre of the cell's nucleus and the reviewer draws the nucleus and the cell. Outlines are flat [x0, y0, x1, y1, ...]
// in µm, in the coordinates of the focus window.
function flatPath(f) { const p = new Path2D(); for (let i = 0; i < f.length; i += 2) (i ? p.lineTo(f[i], f[i + 1]) : p.moveTo(f[i], f[i + 1])); p.closePath(); return p; }
function inPoly(xy, o, n, x, y) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xy[o + 2 * i], yi = xy[o + 2 * i + 1], xj = xy[o + 2 * j], yj = xy[o + 2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inFlat = (f, x, y) => inPoly(f, 0, f.length / 2, x, y);
function flatArea(f) {
  let a = 0;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) a += f[2 * j] * f[2 * i + 1] - f[2 * i] * f[2 * j + 1];
  return Math.abs(a) / 2;
}
function flatCentroid(f) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
    const c = f[2 * j] * f[2 * i + 1] - f[2 * i] * f[2 * j + 1];
    a += c; cx += (f[2 * j] + f[2 * i]) * c; cy += (f[2 * j + 1] + f[2 * i + 1]) * c;
  }
  return Math.abs(a) > 1e-9 ? [cx / (3 * a), cy / (3 * a)] : [f[0], f[1]];
}
function distToFlat(f, x, y) {                     // distance from a point to the outline's edge
  let best = Infinity;
  for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
    const ax = f[2 * j], ay = f[2 * j + 1], dx = f[2 * i] - ax, dy = f[2 * i + 1] - ay;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}
// the marked spot: centre of the cell's (largest) nucleus, else of its 10x outline, else of the window
function markPoint(d) {
  if (!d._mark) {
    const polys = (d.nuclei && d.nuclei.length ? d.nuclei : d.outline) || [];
    const big = polys.reduce((b, p) => (!b || flatArea(p) > flatArea(b) ? p : b), null);
    d._mark = big ? flatCentroid(big) : [(d.window[0] + d.window[2]) / 2, (d.window[1] + d.window[3]) / 2];
  }
  return d._mark;
}
function marker(g, lw) {                           // lw: µm per device pixel
  const [mx, my] = markPoint(st.data), dpr = window.devicePixelRatio || 1;
  g.beginPath(); g.arc(mx, my, 4.5 * dpr * lw, 0, 2 * Math.PI); g.fillStyle = '#000'; g.fill();
  g.beginPath(); g.arc(mx, my, 3 * dpr * lw, 0, 2 * Math.PI); g.fillStyle = '#ff4fd8'; g.fill();
}
function drawMine(g, lw, handles = false) {       // the reviewer's outlines (cell: solid pink, nucleus: dashed cyan)
  const px = (window.devicePixelRatio || 1) * lw;  // µm per css pixel
  for (const [k, col, dash] of [['cell', '#ff4fd8', []], ['nuc', '#38d6ff', [4, 3]]]) {
    const f = st.mine[k]; if (!f) continue;
    g.setLineDash(dash.map((v) => v * px));
    g.lineWidth = 3.5 * px; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.stroke(flatPath(f));
    g.lineWidth = 1.8 * px; g.strokeStyle = col; g.stroke(flatPath(f));
    g.setLineDash([]);
    if (handles) for (let i = 0; i < f.length; i += 2) handle(g, f[i], f[i + 1], col, px, !!hover && hover.kind === k && hover.i === i / 2);
  }
  if (drawing) {                                   // the outline in progress, with the segment to the pointer
    const q = drawing.pts, col = drawing.kind === 'nuc' ? '#38d6ff' : '#ff4fd8';
    if (q.length >= 2) {
      const p = new Path2D();
      for (let i = 0; i < q.length; i += 2) (i ? p.lineTo(q[i], q[i + 1]) : p.moveTo(q[i], q[i + 1]));
      if (drawing.cursor && !drawing.free) p.lineTo(drawing.cursor[0], drawing.cursor[1]);
      g.lineWidth = 3.5 * px; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.stroke(p);
      g.lineWidth = 1.8 * px; g.strokeStyle = col; g.stroke(p);
    }
    if (!drawing.free) for (let i = 0; i < q.length; i += 2) handle(g, q[i], q[i + 1], col, px, i === 0 && q.length >= 6);
  }
}
function handle(g, x, y, col, px, big) {           // a control point (big: the one under the pointer, or the first one)
  const s = (big ? 5 : 3.5) * px;
  g.fillStyle = '#000'; g.fillRect(x - s - px, y - s - px, 2 * s + 2 * px, 2 * s + 2 * px);
  g.fillStyle = big ? '#fff' : col; g.fillRect(x - s, y - s, 2 * s, 2 * s);
}
// Stored per cell: { nuc, cell: control points [x0, y0, x1, y1, ...] in µm (focus-window coordinates), origin: the window's
// origin on the slide, t: time of the last change }. Kept in this browser and, with a backend, saved to the reviewer's
// account shortly after each change (review_save_outlines), so they follow the reviewer to another browser.
const mineKey = () => `cell-review-outlines-v2-${TOKEN || 'local'}-${st.dataset}`;   // v2: control points (v1, traces, ignored)
function loadMine() { try { return JSON.parse(localStorage.getItem(mineKey())) || {}; } catch (e) { return {}; } }
const mineTimers = new Map();
function storeMine() {
  const all = loadMine(), c = st.cells[st.idx], has = !!(st.mine.nuc || st.mine.cell);
  st.mine = { ...st.mine, t: Date.now(), origin: (st.data && st.data.slide && st.data.slide.origin) || null };
  if (has) all[c.id] = st.mine; else delete all[c.id];
  try { localStorage.setItem(mineKey(), JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
  if (LOCAL) return;
  const ds = st.dataset, payload = has ? { nuc: st.mine.nuc, cell: st.mine.cell, origin: st.mine.origin } : null;
  clearTimeout(mineTimers.get(c.id));
  mineTimers.set(c.id, setTimeout(() => rpc('review_save_outlines', { p_token: TOKEN, p_dataset: ds, p_cell: c.id, p_outlines: payload })
    .catch(() => { /* kept in this browser; sent again with the next change */ }), 700));
}
async function pullMine(id) {                      // outlines saved from another browser: the newer copy wins
  if (LOCAL) return;
  try {
    const rows = (await rpc('review_my_outlines', { p_token: TOKEN, p_dataset: id })) || [], all = loadMine();
    for (const r of rows) {
      const t = Date.parse(r.updated_at);
      if (!all[r.cell_id] || (all[r.cell_id].t || 0) < t) all[r.cell_id] = { ...r.outlines, t };
    }
    localStorage.setItem(mineKey(), JSON.stringify(all));
  } catch (e) { /* not available: this browser's copy only */ }
}
// depth interval: only molecules with zsel[0] <= z <= zsel[1] are shown and counted
const zOK = (z) => !st.zsel || (z >= st.zsel[0] && z <= st.zsel[1]);

function overlay(g, px, d) {
  const [x0, y0, x1] = d.window, k = px / (x1 - x0), lw = 1 / k;
  g.save();
  g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  const t = d.tx, hl = new Map(st.hl.map((h) => [h.name, h.color]));
  const r = Math.max(1.6, 2.4 * px / 700) / k, show = (i) => !t.z || zOK(t.z[i]);
  if ($('#ov-all').checked) {
    g.fillStyle = 'rgba(230,230,230,0.75)';
    for (let i = 0; i < t.x.length; i++) if (show(i) && !hl.has(d.genes[t.g[i]])) g.fillRect(t.x[i] - r / 2, t.y[i] - r / 2, r, r);
  }
  if ($('#ov-hl').checked || $('#ov-all').checked) {
    for (let i = 0; i < t.x.length; i++) {
      const col = hl.get(d.genes[t.g[i]]); if (!col || !show(i)) continue;
      g.fillStyle = '#000'; g.fillRect(t.x[i] - r - lw, t.y[i] - r - lw, 2 * r + 2 * lw, 2 * r + 2 * lw);
      g.fillStyle = col; g.fillRect(t.x[i] - r, t.y[i] - r, 2 * r, 2 * r);
    }
  }
  if ($('#ov-outlines').checked || drawing) drawMine(g, lw, $('#ov-outlines').checked);
  if ($('#ov-outlines').checked) marker(g, lw);
  g.restore();
}

// Drawing and editing outlines, on any focus image (not the wider view or the whole slide).
// Drawing: click to place control points, then click the first point, double-click or press Enter to close; or press
// and trace (turned into control points). Backspace removes the last point, Esc cancels.
// Editing: drag a point to move it, click an edge to add a point there, Alt-click or right-click a point to remove it.
let drawing = null, press = null, vdrag = null, hover = null, tableTimer = 0;
function setDraw(kind) {
  st.draw = kind; drawing = kind ? { kind, pts: [], cursor: null, free: false } : null; press = null;
  $('#draw-nuc').classList.toggle('on', kind === 'nuc');
  $('#draw-cell').classList.toggle('on', kind === 'cell');
  $('#main').style.cursor = '';
  modeClasses();
}
function windowUm(e) {
  const r = $('#main').getBoundingClientRect(), [x0, y0, x1] = st.data.window;
  return [x0 + ((e.clientX - r.left) / r.width) * (x1 - x0), y0 + ((e.clientY - r.top) / r.height) * (x1 - x0)];
}
const focusReady = () => !!st.data && !PAN.has(st.mod);
const hitUm = () => (8 * (st.data.window[2] - st.data.window[0])) / $('#main').getBoundingClientRect().width;   // 8 css px
const r2 = (v) => Math.round(v * 100) / 100;
function nearVertex(x, y) {
  const R = hitUm(); let best = null;
  for (const k of ['nuc', 'cell']) {
    const f = st.mine[k]; if (!f) continue;
    for (let i = 0; i < f.length; i += 2) {
      const d = Math.hypot(f[i] - x, f[i + 1] - y);
      if (d <= R && (!best || d < best.d)) best = { kind: k, i: i / 2, d };
    }
  }
  return best;
}
function nearEdge(x, y) {                          // closest edge: the point on it, inserted before vertex `at`
  const R = hitUm(); let best = null;
  for (const k of ['nuc', 'cell']) {
    const f = st.mine[k]; if (!f) continue;
    for (let i = 0, n = f.length / 2, j = n - 1; i < n; j = i++) {
      const ax = f[2 * j], ay = f[2 * j + 1], dx = f[2 * i] - ax, dy = f[2 * i + 1] - ay;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1), d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d <= R && (!best || d < best.d)) best = { kind: k, at: i, x: ax + t * dx, y: ay + t * dy, d };
    }
  }
  return best;
}
function simplify(pts, tol) {                      // a traced loop to control points: Ramer-Douglas-Peucker on each half
  const n = pts.length / 2; if (n < 4) return pts.slice();
  let far = 1, fd = -1;                            // a loop ends where it started: split it at the point farthest away
  for (let i = 1; i < n; i++) { const d = Math.hypot(pts[2 * i] - pts[0], pts[2 * i + 1] - pts[1]); if (d > fd) { fd = d; far = i; } }
  const half = (a, b) => rdp(pts.slice(2 * a, 2 * b + 2), tol);
  return [...half(0, far), ...half(far, n - 1).slice(2)];
}
function rdp(pts, tol) {                           // Ramer-Douglas-Peucker on an open line
  const n = pts.length / 2; if (n < 3) return pts.slice();
  const keep = new Uint8Array(n), stack = [[0, n - 1]]; keep[0] = keep[n - 1] = 1;
  while (stack.length) {
    const [a, b] = stack.pop(), ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay, L = Math.hypot(dx, dy) || 1;
    let m = -1, md = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[2 * i] - ax) * dy - (pts[2 * i + 1] - ay) * dx) / L; if (d > md) { md = d; m = i; } }
    if (m >= 0) { keep[m] = 1; stack.push([a, m], [m, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}
function redraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawMain(); }); }
function outlinesChanged() { storeMine(); clearTimeout(tableTimer); tableTimer = setTimeout(renderTable, 150); }
function finish(pts) {                             // close the outline being drawn
  const kind = drawing.kind, q = pts.map(r2);
  setDraw(null);
  if (q.length >= 6 && flatArea(q) > 0.3) { st.mine = { ...st.mine, [kind]: q }; outlinesChanged(); }
  drawMain();
}
function startDraw(kind) {
  if (!st.data) return;
  if (PAN.has(st.mod)) {                           // drawing is done on a focus image: back to the last one used
    st.mod = st.lastFocus || 'he';
    document.querySelectorAll('.vig').forEach((el) => el.classList.toggle('active', el.dataset.m === st.mod));
  }
  setDraw(st.draw === kind ? null : kind);
  drawMain();
}
$('#draw-nuc').onclick = () => startDraw('nuc');
$('#draw-cell').onclick = () => startDraw('cell');
$('#draw-clear').onclick = () => { st.mine = { nuc: null, cell: null }; outlinesChanged(); setDraw(null); drawMain(); };
$('#main').addEventListener('pointerdown', (e) => {
  if (!focusReady()) return;
  const ae = document.activeElement;               // e.g. the focal-plane slider: the drawing keys must reach the page
  if (ae && ae !== document.body && !isTyping(ae)) ae.blur();
  const [x, y] = windowUm(e);
  if (st.draw) {
    press = { cx: e.clientX, cy: e.clientY, moved: false, start: [x, y] };
    $('#main').setPointerCapture(e.pointerId);
    return;
  }
  if (!$('#ov-outlines').checked) return;
  const v = nearVertex(x, y);
  if (v && (e.altKey || e.button === 2)) {         // remove a point (an outline keeps at least 3)
    const f = st.mine[v.kind];
    if (f.length > 6) { st.mine = { ...st.mine, [v.kind]: [...f.slice(0, 2 * v.i), ...f.slice(2 * v.i + 2)] }; hover = null; outlinesChanged(); drawMain(); }
    return;
  }
  if (e.button !== 0) return;
  if (v) vdrag = { kind: v.kind, i: v.i };
  else {
    const ed = nearEdge(x, y); if (!ed) return;    // add a point on the edge, and move it
    const f = st.mine[ed.kind];
    st.mine = { ...st.mine, [ed.kind]: [...f.slice(0, 2 * ed.at), r2(ed.x), r2(ed.y), ...f.slice(2 * ed.at)] };
    vdrag = { kind: ed.kind, i: ed.at };
  }
  $('#main').setPointerCapture(e.pointerId);
  redraw();
});
$('#main').addEventListener('pointermove', (e) => {
  if (!focusReady()) return;
  const [x, y] = windowUm(e);
  if (press && drawing) {
    if (!press.moved && !drawing.pts.length && Math.hypot(e.clientX - press.cx, e.clientY - press.cy) > 5) {
      press.moved = true; drawing.free = true; drawing.pts = [...press.start];       // a trace, not a click
    }
    if (drawing.free) {
      const p = drawing.pts;
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) >= 0.15) { p.push(x, y); redraw(); }
    }
    return;
  }
  if (vdrag) {
    const f = st.mine[vdrag.kind]; f[2 * vdrag.i] = r2(x); f[2 * vdrag.i + 1] = r2(y);
    redraw(); clearTimeout(tableTimer); tableTimer = setTimeout(renderTable, 150);
    return;
  }
  if (drawing) { drawing.cursor = [x, y]; redraw(); return; }
  const on = $('#ov-outlines').checked, v = on ? nearVertex(x, y) : null, ed = on && !v ? nearEdge(x, y) : null;
  $('#main').style.cursor = v ? 'move' : ed ? 'copy' : '';
  const nh = v ? { kind: v.kind, i: v.i } : null;
  if (nh ? !hover || hover.kind !== nh.kind || hover.i !== nh.i : hover) { hover = nh; redraw(); }
});
$('#main').addEventListener('pointerup', (e) => {
  if (press) {
    press = null;
    if (!drawing) return;
    if (drawing.free) { finish(simplify(drawing.pts, 0.25)); return; }
    const [x, y] = windowUm(e), q = drawing.pts;
    if (q.length >= 6 && Math.hypot(x - q[0], y - q[1]) <= hitUm()) { finish(q); return; }   // the first point: close
    q.push(x, y); redraw();
    return;
  }
  if (vdrag) { vdrag = null; outlinesChanged(); drawMain(); }
});
$('#main').addEventListener('dblclick', () => {    // close (the second click of the double-click added a point: drop it)
  if (!st.draw || !drawing || drawing.free) return;
  const q = drawing.pts, n = q.length;
  if (n >= 4 && Math.hypot(q[n - 2] - q[n - 4], q[n - 1] - q[n - 3]) <= hitUm()) q.splice(-2);
  if (q.length >= 6) finish(q);
});
$('#main').addEventListener('pointerleave', () => { if (drawing && drawing.cursor) { drawing.cursor = null; redraw(); } });
$('#main').addEventListener('contextmenu', (e) => {
  if (focusReady() && $('#ov-outlines').checked && nearVertex(...windowUm(e))) e.preventDefault();
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
    const r = Math.max(1.2, 1.8 * px / 700) / k, show = (i) => !w.z || zOK(w.z[i] / 100);
    if ($('#ov-all').checked) {
      g.fillStyle = 'rgba(230,230,230,0.6)';
      for (let i = 0; i < w.n; i++) if (show(i) && !col[w.g[i]]) g.fillRect(w.x[i] / 100 - r / 2, w.y[i] / 100 - r / 2, r, r);
    }
    if ($('#ov-hl').checked || $('#ov-all').checked) {
      for (let i = 0; i < w.n; i++) {
        const c = col[w.g[i]]; if (!c || !show(i)) continue;
        const x = w.x[i] / 100, y = w.y[i] / 100, q = r;
        g.fillStyle = '#000'; g.fillRect(x - q - lw, y - q - lw, 2 * q + 2 * lw, 2 * q + 2 * lw);
        g.fillStyle = c; g.fillRect(x - q, y - q, 2 * q, 2 * q);
      }
    }
  }
  if ($('#ov-outlines').checked) {
    g.translate(ox, oy);
    g.lineWidth = 1.5 * lw; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.setLineDash([4 * lw, 3 * lw]);
    g.strokeRect(0, 0, size, size); g.setLineDash([]);
    drawMine(g, lw); marker(g, lw);
  }
  g.restore();
}

['#ov-outlines', '#ov-hl', '#ov-all'].forEach((id) => { $(id).onchange = drawMain; });
new ResizeObserver(() => drawMain()).observe($('#cv-wrap'));

// ---------------------------------------------------------------------------- depth bar
// Beside the image: histogram of the depth (z) of the molecules of the focus window, dots for the highlighted genes,
// and two handles setting the interval shown (top = larger z). Drag a handle, drag inside to move, double-click: all.
const ZB = { top: 16, bot: 16 };                   // css px kept for the labels
let zdrag = null, zTimer = 0;
function zExtent(d) {                             // 0.5th to 99.5th percentile: a few stray molecules do not stretch the bar
  if (!d._zext) {
    const s = Float64Array.from(d.tx.z).sort(), q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
    const lo = q(0.005), hi = q(0.995);
    d._zext = hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
  }
  return d._zext;
}
const zShown = (lo, hi) => (st.zsel ? [Math.max(st.zsel[0], lo), Math.min(st.zsel[1], hi)] : [lo, hi]);
function drawZbar() {
  const d = st.data, show = !!(d && d.tx && d.tx.z && d.tx.z.length) && st.mod !== 'slide';
  $('#zbar').hidden = !show; if (!show) return;
  const dpr = window.devicePixelRatio || 1, css = Math.max(120, (parseFloat($('#main').style.height) || 0) - 36);
  const cv = $('#zcv'), W = Math.round(58 * dpr), H = Math.round(css * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; cv.style.height = `${css}px`; }
  const g = cv.getContext('2d'), [lo, hi] = zExtent(d), top = ZB.top * dpr, h = H - (ZB.top + ZB.bot) * dpr;
  const yOf = (z) => top + ((hi - z) / (hi - lo)) * h, [s0, s1] = zShown(lo, hi), t = d.tx;
  g.clearRect(0, 0, W, H);
  const NB = 48, bins = new Array(NB).fill(0);
  for (const z of t.z) bins[clamp(Math.floor(((z - lo) / (hi - lo)) * NB), 0, NB - 1)]++;
  const mx = Math.max(...bins, 1);
  for (let b = 0; b < NB; b++) {
    const za = lo + (b / NB) * (hi - lo), zb = lo + ((b + 1) / NB) * (hi - lo), zc = (za + zb) / 2;
    g.fillStyle = zc >= s0 && zc <= s1 ? '#8a9099' : '#3a3f46';
    g.fillRect(4 * dpr, yOf(zb), (bins[b] / mx) * (W - 8 * dpr), Math.max(1, yOf(za) - yOf(zb) - 0.5 * dpr));
  }
  const hl = new Map(st.hl.map((x) => [x.name, x.color]));
  for (let i = 0; i < t.x.length; i++) {
    const col = hl.get(d.genes[t.g[i]]); if (!col) continue;
    const x = 6 * dpr + (((i * 7919) % 997) / 997) * (W - 12 * dpr);    // fixed horizontal scatter
    g.fillStyle = col; g.beginPath(); g.arc(x, yOf(clamp(t.z[i], lo, hi)), 1.8 * dpr, 0, 2 * Math.PI); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, top, W, yOf(s1) - top); g.fillRect(0, yOf(s0), W, top + h - yOf(s0));
  g.fillStyle = '#ff4fd8';
  for (const z of [s0, s1]) {
    const y = yOf(z);
    g.fillRect(0, y - dpr, W, 2 * dpr);
    g.beginPath(); g.moveTo(0, y - 5 * dpr); g.lineTo(7 * dpr, y); g.lineTo(0, y + 5 * dpr); g.fill();
  }
  g.font = `${10 * dpr}px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
  g.fillStyle = '#c8ccd2'; g.textAlign = 'center';
  g.textBaseline = 'bottom'; g.fillText(`z ${s1.toFixed(1)}`, W / 2, top - 2 * dpr);
  g.textBaseline = 'top'; g.fillText(`${s0.toFixed(1)} µm`, W / 2, top + h + 2 * dpr);
}
function zAt(e) {
  const [lo, hi] = zExtent(st.data), r = $('#zcv').getBoundingClientRect();
  return hi - clamp((e.clientY - r.top - ZB.top) / (r.height - ZB.top - ZB.bot), 0, 1) * (hi - lo);
}
function zChanged() {
  drawZbar();
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawMain(); });
  clearTimeout(zTimer); zTimer = setTimeout(renderTable, 120);
}
function zMove(e) {
  if (!zdrag) return;
  const [lo, hi] = zExtent(st.data), z = zAt(e), [a, b] = zdrag.s, gap = 0.2;
  let s;
  if (zdrag.mode === 'hi') s = [a, clamp(z, a + gap, hi)];
  else if (zdrag.mode === 'lo') s = [clamp(z, lo, b - gap), b];
  else { const dz = clamp(z - zdrag.z, lo - a, hi - b); s = [a + dz, b + dz]; }
  // a handle at the end of the bar is open-ended: it also takes the few stray molecules beyond it
  st.zsel = s[0] <= lo + 1e-6 && s[1] >= hi - 1e-6 ? null : [s[0] <= lo + 1e-6 ? -Infinity : s[0], s[1] >= hi - 1e-6 ? Infinity : s[1]];
  zChanged();
}
$('#zcv').addEventListener('pointerdown', (e) => {
  if (!st.data || !st.data.tx.z) return;
  const [lo, hi] = zExtent(st.data), [s0, s1] = zShown(lo, hi), z = zAt(e);
  const r = $('#zcv').getBoundingClientRect(), near = (8 * (hi - lo)) / (r.height - ZB.top - ZB.bot);
  const mode = Math.abs(z - s1) <= near && Math.abs(z - s1) <= Math.abs(z - s0) ? 'hi'
    : Math.abs(z - s0) <= near ? 'lo' : z > s0 && z < s1 ? 'move' : z > s1 ? 'hi' : 'lo';
  zdrag = { mode, z, s: [s0, s1] };
  $('#zcv').setPointerCapture(e.pointerId);
  if (mode !== 'move') zMove(e);
});
$('#zcv').addEventListener('pointermove', zMove);
$('#zcv').addEventListener('pointerup', () => { zdrag = null; });
$('#zcv').addEventListener('pointercancel', () => { zdrag = null; });
$('#zcv').addEventListener('dblclick', () => { st.zsel = null; zChanged(); });

// ============================================================================ question

function renderQuestion(c) {
  const a = st.answers.get(c.id) || {};
  const opts = [['A', c.A], ['B', c.B], ['neither', 'neither of these'], ['unsure', "can't tell"],
    ['multiple', 'more than one cell at the marked spot']];
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

// keys typed into a text box stay there; sliders, checkboxes and buttons do not keep them from the page
const isTyping = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
  || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(el.type));
window.addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  if (e.target.type === 'range' && e.key.startsWith('Arrow')) return;   // arrows move the slider (focal plane)
  if (st.draw && drawing) {
    if (e.key === 'Escape') { setDraw(null); drawMain(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (drawing.pts.length >= 6 && !drawing.free) finish(drawing.pts); return; }
    if (e.key === 'Backspace') { e.preventDefault(); drawing.pts.splice(-2); redraw(); return; }
  }
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
// counts inside the reviewer's outlines (and the depth interval); before any outline, only the whole window
function renderTable() {
  const d = st.data; if (!d) return;
  const t = d.tx, acc = new Map(), nuc = st.mine.nuc, cell = st.mine.cell, BAND = 3;
  for (let i = 0; i < t.g.length; i++) {
    if (t.z && !zOK(t.z[i])) continue;
    const gi = t.g[i];
    let a = acc.get(gi);
    if (!a) { a = { gi, gene: d.genes[gi], ctl: d.gene_category[gi].indexOf('gene') < 0, nuc: 0, cell: 0, out: 0, win: 0 }; acc.set(gi, a); }
    a.win++;
    const x = t.x[i], y = t.y[i];
    if (nuc && inFlat(nuc, x, y)) a.nuc++;
    if (cell) { if (inFlat(cell, x, y)) a.cell++; else if (distToFlat(cell, x, y) <= BAND) a.out++; }
  }
  const rows = [...acc.values()].filter((r) => !r.ctl), area = cell ? flatArea(cell) : 0;
  // vs tissue: molecules inside the cell outline / molecules expected in that area at the tissue-wide density
  for (const r of rows) r.ratio = area ? r.cell / Math.max(d.density[r.gi] * area, 1e-3) : 0;
  renderRows(rows);
}
function renderRows(rows) {
  const nuc = st.mine.nuc, cell = st.mine.cell, sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const [za, zb] = st.zsel || [], depth = !st.zsel ? '' : za === -Infinity ? ` Only depth ≤ ${zb.toFixed(1)} µm.`
    : zb === Infinity ? ` Only depth ≥ ${za.toFixed(1)} µm.` : ` Only depth ${za.toFixed(1)}–${zb.toFixed(1)} µm.`;
  $('#tx-summary').innerHTML = (cell || nuc
    ? (cell ? `<b>${sum('cell')}</b> molecules inside your cell outline (<b>${rows.filter((r) => r.cell).length}</b> genes, ${flatArea(cell).toFixed(0)} µm²)` : 'No cell outline yet')
      + (nuc ? `, <b>${sum('nuc')}</b> inside your nucleus outline (${flatArea(nuc).toFixed(0)} µm²).` : ', no nucleus outline yet.')
    : 'Draw the nucleus and the cell (✎ under the image) to count the molecules inside them. Until then, the whole window.')
    + depth + ' Hover a column title for its meaning.';
  const f = $('#tbl-filter').value.trim().toUpperCase();
  if (f) rows = rows.filter((r) => r.gene.includes(f));
  rows.sort((a, b) => (tbl.sort === 'gene' ? a.gene.localeCompare(b.gene) * -tbl.dir : (a[tbl.sort] - b[tbl.sort]) * tbl.dir) || b.win - a.win);
  const cols = [['gene', 'gene', 'gene name'],
    ['nuc', 'nucleus', 'molecules inside your nucleus outline'],
    ['cell', 'cell', 'molecules inside your cell outline (includes the nucleus)'],
    ['out', '3 µm band', 'molecules within 3 µm outside your cell outline'],
    ['win', 'window', 'molecules in the whole window shown'],
    ['ratio', 'vs tissue', 'how many times more molecules are inside your cell outline than expected from the average density of this gene over the whole tissue']];
  $('#tbl thead').innerHTML = '<tr>' + cols.map(([k, l, tip]) => `<th data-k="${k}" title="${tip}" class="${k === tbl.sort ? 'sorted' : ''}">${l}${k === tbl.sort ? (tbl.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr>';
  const hl = new Map(st.hl.map((h) => [h.name, h.color]));
  const fr = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  $('#tbl tbody').innerHTML = rows.slice(0, 300).map((r) => `<tr data-g="${r.gene}"><td>${hl.has(r.gene) ? `<i style="background:${hl.get(r.gene)}"></i>` : ''}${r.gene}</td>
    <td>${r.nuc || ''}</td><td>${r.cell || ''}</td><td>${r.out || ''}</td><td>${r.win || ''}</td><td>${r.cell ? fr(r.ratio) : ''}</td></tr>`).join('');
}
$('#tbl thead').addEventListener('click', (e) => {
  const th = e.target.closest('th'); if (!th) return;
  const k = th.dataset.k; if (tbl.sort === k) tbl.dir *= -1; else { tbl.sort = k; tbl.dir = k === 'gene' ? 1 : -1; }
  renderTable();
});
$('#tbl tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-g]'); if (tr) toggleHl(tr.dataset.g); });
$('#tbl-filter').oninput = renderTable;

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
