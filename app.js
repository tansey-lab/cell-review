'use strict';
// Cell Review: a sequence of cells, each with candidate labels A/B. Answers are saved per personal link (?r=<token>).

const $ = (s) => document.querySelector(s);
const CFG = window.REVIEW_CONFIG || {};
const PALETTE = ['#ff3b30', '#34c759', '#ffcc00', '#0a84ff', '#ff9f0a', '#bf5af2', '#64d2ff',
  '#ff375f', '#a2f000', '#ffd1dc', '#00c7be', '#ac8e68'];
const SETS_KEY = 'cell-review-marker-sets';
const UI_KEY = 'cell-review-ui';
const params = new URLSearchParams(location.search);
const TOKEN = params.get('r') || '';
const LOCAL = !(CFG.supabaseUrl && CFG.supabaseAnonKey);    // no backend configured: test mode in this browser

const st = {
  dataset: null, cells: [], idx: 0, data: null, answers: new Map(),
  mod: 'he', z: 0, hl: [], genes: [], geneSet: new Set(),
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
  renderQuestion(c);
  renderVignettes();
  drawMain();
  renderTable();
}

const MODS = () => [['he', 'H&E'], ['context', 'H&E, wider'], ['composite', 'stains'],
  ...st.data.channels.map((n, i) => [`c${i}`, n])];

function renderVignettes() {
  const c = st.cells[st.idx];
  $('#vigs').innerHTML = MODS().map(([m, lab]) => `<div class="vig${m === st.mod ? ' active' : ''}" data-m="${m}">
    <img src="${base()}/images/${c.id}/${m}.jpg" alt=""><span>${lab}</span></div>`).join('');
}
$('#vigs').addEventListener('click', (e) => {
  const v = e.target.closest('.vig'); if (!v) return;
  st.mod = v.dataset.m;
  document.querySelectorAll('.vig').forEach((el) => el.classList.toggle('active', el.dataset.m === st.mod));
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

async function drawMain() {
  const d = st.data, c = st.cells[st.idx]; if (!d) return;
  const depthOK = st.mod === 'c0' && d.planes.length > 0;
  $('#depth').hidden = !depthOK;
  if (depthOK) {
    const zr = $('#zr');
    zr.min = 0; zr.max = d.planes.length; zr.value = d.planes.indexOf(st.z) >= 0 ? d.planes.indexOf(st.z) + 1 : 0;
  }
  const useZ = depthOK && +$('#zr').value > 0;
  const file = useZ ? `z${st.z}` : st.mod;
  const label = useZ ? `DAPI, focal plane ${st.z + 1} of ${d.n_planes}` : (MODS().find(([m]) => m === st.mod) || [, ''])[1];
  $('#main-lab').textContent = label;
  $('#zl').textContent = useZ ? `plane ${st.z + 1} of ${d.n_planes}` : 'in-focus image';
  const cv = $('#main');
  const css = Math.min(cv.parentElement.clientWidth, cv.parentElement.clientHeight);
  const px = Math.round(css * (window.devicePixelRatio || 1));
  cv.style.width = cv.style.height = `${css}px`;
  cv.width = cv.height = px;
  const im = await img(`${base()}/images/${c.id}/${file}.jpg`);
  if (st.cells[st.idx] !== c) return;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, px, px);
  if (im) g.drawImage(im, 0, 0, px, px);
  if (st.mod !== 'context') overlay(g, px, d);
  else contextBox(g, px, d);
}
$('#zr').oninput = () => {
  const v = +$('#zr').value;
  if (v > 0) st.z = st.data.planes[v - 1];
  drawMain();
};

function flatPath(f) { const p = new Path2D(); for (let i = 0; i < f.length; i += 2) (i ? p.lineTo(f[i], f[i + 1]) : p.moveTo(f[i], f[i + 1])); p.closePath(); return p; }
function payloadPath(pl) {
  const p = new Path2D(); let o = 0;
  for (let i = 0; i < pl.cell.length; i++) {
    for (let j = 0; j < pl.n[i]; j++, o += 2) (j ? p.lineTo(pl.xy[o], pl.xy[o + 1]) : p.moveTo(pl.xy[o], pl.xy[o + 1]));
    p.closePath();
  }
  return p;
}

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
  const t = d.tx, hl = new Map(st.hl.map((h) => [h.name, h.color]));
  const r = Math.max(1.6, 2.4 * px / 700) / k;
  if ($('#ov-all').checked) {
    g.fillStyle = 'rgba(230,230,230,0.75)';
    for (let i = 0; i < t.x.length; i++) if (!hl.has(d.genes[t.g[i]])) g.fillRect(t.x[i] - r / 2, t.y[i] - r / 2, r, r);
  }
  if ($('#ov-hl').checked || $('#ov-all').checked) {
    for (let i = 0; i < t.x.length; i++) {
      const col = hl.get(d.genes[t.g[i]]); if (!col) continue;
      g.fillStyle = '#000'; g.fillRect(t.x[i] - r - lw, t.y[i] - r - lw, 2 * r + 2 * lw, 2 * r + 2 * lw);
      g.fillStyle = col; g.fillRect(t.x[i] - r, t.y[i] - r, 2 * r, 2 * r);
    }
  }
  g.restore();
}

function contextBox(g, px, d) {
  // the wider H&E is centred on the window; mark where the cell window sits
  const CONTEXT_UM = 150, [x0, , x1] = d.window, w = (x1 - x0) / CONTEXT_UM * px;
  g.strokeStyle = '#ff4fd8'; g.lineWidth = 2;
  g.strokeRect(px / 2 - w / 2, px / 2 - w / 2, w, w);
}

['#ov-outlines', '#ov-hl', '#ov-all'].forEach((id) => { $(id).onchange = drawMain; });
new ResizeObserver(() => drawMain()).observe($('#stage'));

// ============================================================================ question

function renderQuestion(c) {
  const a = st.answers.get(c.id) || {};
  const opts = [['A', c.A], ['B', c.B], ['neither', 'neither of these'], ['unsure', "can't tell"]];
  $('#choices').innerHTML = opts.map(([v, lab], i) => `<label class="choice${a.choice === v ? ' on' : ''}">
      <input type="radio" name="choice" value="${v}" ${a.choice === v ? 'checked' : ''}>
      <span class="k">${i + 1}</span><span class="t">${lab}</span></label>`).join('');
  $('#other').hidden = a.choice !== 'neither';
  $('#other').value = a.other_label || '';
  document.querySelectorAll('input[name=conf]').forEach((r) => { r.checked = +r.value === +(a.confidence || 0); });
  $('#comment').value = a.comment || '';
  $('#save-msg').textContent = a.updated_at ? `saved ${new Date(a.updated_at).toLocaleString()}` : '';
  $('#prev').disabled = st.idx === 0;
}
$('#choices').addEventListener('change', () => {
  const v = (document.querySelector('input[name=choice]:checked') || {}).value;
  document.querySelectorAll('.choice').forEach((el) => el.classList.toggle('on', el.querySelector('input').checked));
  $('#other').hidden = v !== 'neither';
  if (v === 'neither') $('#other').focus();
});

async function save() {
  const c = st.cells[st.idx];
  const choice = (document.querySelector('input[name=choice]:checked') || {}).value;
  if (!choice) { $('#save-msg').textContent = 'Pick an answer first.'; return; }
  const conf = +((document.querySelector('input[name=conf]:checked') || {}).value || 0) || null;
  const a = { cell_id: c.id, choice, option_a: c.A, option_b: c.B, confidence: conf,
    other_label: choice === 'neither' ? $('#other').value.trim() : '', comment: $('#comment').value.trim() };
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
  if ('1234'.includes(e.key)) { const r = document.querySelectorAll('input[name=choice]')[+e.key - 1]; if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }
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
function saveSets(s) { try { localStorage.setItem(SETS_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable */ } renderSets(); }
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
function renderTable() {
  const d = st.data; if (!d) return;
  const t = d.tx, acc = new Map();
  for (let i = 0; i < t.g.length; i++) {
    const gi = t.g[i];
    let a = acc.get(gi);
    if (!a) { a = { gene: d.genes[gi], ctl: d.gene_category[gi].indexOf('gene') < 0, nuc: 0, cell: 0, win: 0 }; acc.set(gi, a); }
    a.win++; if (t.in_cell[i]) a.cell++; if (t.in_nuc[i]) a.nuc++;
  }
  const aIn = Math.max(d.area_cell, 1e-6), aOut = Math.max(d.area_window - d.area_cell, 1e-6);
  let rows = [...acc.values()].filter((r) => !r.ctl);
  for (const r of rows) { r.out = r.win - r.cell; r.ratio = (r.cell / aIn) / ((r.out + 0.5) / aOut); }
  const nIn = rows.reduce((s, r) => s + r.cell, 0), nNuc = rows.reduce((s, r) => s + r.nuc, 0);
  $('#tx-summary').innerHTML = `<b>${nIn}</b> gene molecules inside the outline (<b>${rows.filter((r) => r.cell).length}</b> genes), <b>${nNuc}</b> inside the nucleus.`;
  const f = $('#tbl-filter').value.trim().toUpperCase();
  if (f) rows = rows.filter((r) => r.gene.includes(f));
  rows.sort((a, b) => (tbl.sort === 'gene' ? a.gene.localeCompare(b.gene) * -tbl.dir : (a[tbl.sort] - b[tbl.sort]) * tbl.dir) || b.cell - a.cell);
  const cols = [['gene', 'gene'], ['nuc', 'in nucleus'], ['cell', 'in outline'], ['out', 'outside'], ['ratio', 'in / out']];
  $('#tbl thead').innerHTML = '<tr>' + cols.map(([k, l]) => `<th data-k="${k}" class="${k === tbl.sort ? 'sorted' : ''}">${l}${k === tbl.sort ? (tbl.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('') + '</tr>';
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
  try { if ((JSON.parse(localStorage.getItem(UI_KEY)) || {}).rightCollapsed) setRightCollapsed(true); } catch (e) { /* ignore */ }
  renderSets();
  $('#app').hidden = false;
  await openDataset((ds[0] || {}).id);
})();
