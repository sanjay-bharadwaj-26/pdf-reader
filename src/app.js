import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

// ---------------------------------------------------------------- constants
const T = window.__TAURI__ || null;
const CSS_PER_PT = 96 / 72;                 // "100%" in Chromium = 96 dpi
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_CANVAS_PIXELS = 10e6;             // caps RAM per rendered page
const THUMB_W = 120;
const $ = (id) => document.getElementById(id);

const el = {
  viewer: $('viewer'), pages: $('pages'), empty: $('empty'), sidebar: $('sidebar'),
  title: $('title'), pageInput: $('pageInput'), pageCount: $('pageCount'), zoomInput: $('zoomInput'),
  btnFit: $('btnFit'), menu: $('menu'), toast: $('toast'), fileInput: $('fileInput'), printArea: $('printArea'),
};

// ---------------------------------------------------------------- state
let pdf = null, loadingTask = null, docGen = 0;
let pages = [];          // { num, el, canvas, textDiv, visible, token, key, task }
let thumbs = [];         // { num, box, canvas, visible, token, key }
let sizes = [];          // [widthPt, heightPt] at rotation 0 (includes the page's own /Rotate)
let sizesDirty = false;
let zoom = 1, fitMode = null, rotation = 0, current = 1;
let srcPath = null, fileName = '';
const visible = new Set();

// ---------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const effSize = (s) => (rotation % 180 ? [s[1], s[0]] : [s[0], s[1]]);
let toastTimer;
function toast(msg, ms = 2500) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}
const hideToast = () => (el.toast.hidden = true);
function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }
function baseName(p) { return p.split(/[\\/]/).pop(); }

// ---------------------------------------------------------------- theme (invert)
function setInverted(on) {
  document.body.classList.toggle('inverted', on);
  $('btnTheme').classList.toggle('on', on);
  try { localStorage.setItem('invert', on ? '1' : '0'); } catch { /* ignore */ }
}
const toggleInverted = () => setInverted(!document.body.classList.contains('inverted'));
try { setInverted(localStorage.getItem('invert') === '1'); } catch { /* ignore */ }

// ---------------------------------------------------------------- loading
async function openDoc(source, name, path = null) {
  const gen = ++docGen;
  closeDoc();
  docGen = gen;
  srcPath = path; fileName = name;
  el.title.textContent = name; document.title = name + ' - PDF Reader';
  if (T) T.window.getCurrentWindow().setTitle(name).catch(() => {});

  const base = new URL('./lib/', import.meta.url).href;
  const task = pdfjsLib.getDocument({
    ...source,
    cMapUrl: base + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false,
    disableAutoFetch: true,          // only fetch what is needed -> low RAM
    rangeChunkSize: 1 << 18,
  });
  task.onPassword = (cb, reason) => askPassword(reason).then((p) => (p === null ? task.destroy() : cb(p)));
  loadingTask = task;

  let doc;
  try { doc = await task.promise; }
  catch (e) {
    if (gen !== docGen) return;
    console.error(e); toast('Could not open this PDF: ' + (e.message || e), 5000); return;
  }
  if (gen !== docGen) { doc.destroy(); return; }
  pdf = doc;

  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  first.cleanup();
  sizes = Array.from({ length: pdf.numPages }, () => [vp.width, vp.height]);

  buildPages();
  buildThumbs();
  el.empty.classList.add('gone');
  el.pageCount.textContent = pdf.numPages;
  current = 1; rotation = 0; fitMode = null; zoom = 1;
  relayout();
  el.viewer.scrollTop = 0;
  el.viewer.focus();
  loadSizes(gen);
}

function closeDoc() {
  visible.clear();
  pageObserver.disconnect(); thumbObserver.disconnect();
  for (const p of pages) { p.task?.cancel(); freeCanvas(p.canvas); }
  for (const t of thumbs) freeCanvas(t.canvas);
  pages = []; thumbs = [];
  el.pages.replaceChildren(); el.sidebar.replaceChildren();
  if (loadingTask) { loadingTask.destroy().catch(() => {}); loadingTask = null; }
  pdf = null;
  el.empty.classList.remove('gone');
}

async function loadSizes(gen) {           // fetch real sizes of the remaining pages in the background
  const doc = pdf;
  for (let i = 2; i <= doc.numPages; i++) {
    if (gen !== docGen) return;
    try {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      pg.cleanup();
      const old = sizes[i - 1];
      if (Math.abs(old[0] - vp.width) > .5 || Math.abs(old[1] - vp.height) > .5) { sizes[i - 1] = [vp.width, vp.height]; sizesDirty = true; }
    } catch { return; }
    if ((i % 25 === 0 || i === doc.numPages) && sizesDirty) { sizesDirty = false; relayout(false); }
  }
}

function askPassword(reason) {
  const dlg = $('pwdDialog');
  $('pwdMsg').textContent = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
    ? 'Incorrect password. Try again.' : 'This document is password protected.';
  $('pwdInput').value = '';
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? $('pwdInput').value : null), { once: true });
    dlg.returnValue = 'cancel'; dlg.showModal(); $('pwdInput').focus();
  });
}

async function loadPath(path) {
  if (!path) return;
  await openDoc({ url: T.core.convertFileSrc(path) }, baseName(path), path);
}

async function chooseFile() {
  if (T) {
    const p = await T.dialog.open({ multiple: false, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (p) loadPath(Array.isArray(p) ? p[0] : p);
  } else el.fileInput.click();
}
el.fileInput.addEventListener('change', async () => {      // browser fallback (no Tauri)
  const f = el.fileInput.files[0]; if (!f) return;
  openDoc({ data: new Uint8Array(await f.arrayBuffer()) }, f.name);
  el.fileInput.value = '';
});

// ---------------------------------------------------------------- layout
function computeFit() {
  const [w, h] = effSize(sizes[0]);
  const aw = (el.viewer.clientWidth - 16) / (w * CSS_PER_PT);
  const ah = (el.viewer.clientHeight - 16) / (h * CSS_PER_PT);
  return fitMode === 'width' ? aw : Math.min(aw, ah);
}

function applySizes() {
  const s = zoom * CSS_PER_PT;
  pages.forEach((p, i) => {
    const [w, h] = effSize(sizes[i]);
    p.el.style.width = Math.round(w * s) + 'px';
    p.el.style.height = Math.round(h * s) + 'px';
  });
  thumbs.forEach((t, i) => {
    const [w, h] = effSize(sizes[i]);
    t.box.style.height = Math.round(THUMB_W * h / w) + 'px';
  });
}

function relayout(rerender = true) {
  if (!pdf) return;
  if (fitMode) zoom = clamp(computeFit(), 0.1, 5);
  const cp = pages[current - 1];
  let frac = 0;
  if (cp) frac = (el.viewer.scrollTop - cp.el.offsetTop) / Math.max(1, cp.el.offsetHeight);
  applySizes();
  if (cp) el.viewer.scrollTop = cp.el.offsetTop + frac * cp.el.offsetHeight;
  if (rerender) scheduleRender();
  updateUI();
}

function setZoom(z, fit = null) { fitMode = fit; zoom = clamp(z, 0.1, 5); relayout(); }
function stepZoom(dir) {
  const next = dir > 0
    ? STEPS.find((s) => s > zoom + 1e-3) || 5
    : [...STEPS].reverse().find((s) => s < zoom - 1e-3) || 0.25;
  setZoom(next);
}
function rotate() { rotation = (rotation + 270) % 360; relayout(); }
function toggleFit() { setZoom(0, fitMode === 'page' ? 'width' : 'page'); }

// ---------------------------------------------------------------- lazy rendering (the RAM saver)
const pageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = pages[+e.target.dataset.n - 1]; if (!p) continue;
    p.visible = e.isIntersecting;
    if (e.isIntersecting) { visible.add(p); renderPage(p); } else { visible.delete(p); releasePage(p); }
  }
  updateCurrent();
}, { root: el.viewer, rootMargin: '60% 0px 60% 0px' });

const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = thumbs[+e.target.dataset.n - 1]; if (!t) continue;
    t.visible = e.isIntersecting;
    if (e.isIntersecting) renderThumb(t); else releaseThumb(t);
  }
}, { root: el.sidebar, rootMargin: '100% 0px' });

function buildPages() {
  const frag = document.createDocumentFragment();
  pages = Array.from({ length: pdf.numPages }, (_, i) => {
    const div = document.createElement('div');
    div.className = 'page'; div.dataset.n = i + 1;
    const textDiv = document.createElement('div'); textDiv.className = 'textLayer';
    div.appendChild(textDiv); frag.appendChild(div);
    return { num: i + 1, el: div, canvas: null, textDiv, visible: false, token: 0, key: null, task: null };
  });
  el.pages.appendChild(frag);
  pages.forEach((p) => pageObserver.observe(p.el));
}

function buildThumbs() {
  const frag = document.createDocumentFragment();
  thumbs = Array.from({ length: pdf.numPages }, (_, i) => {
    const wrap = document.createElement('div'); wrap.className = 'thumb'; wrap.dataset.n = i + 1;
    const box = document.createElement('div'); box.className = 'tbox';
    const num = document.createElement('div'); num.className = 'tnum'; num.textContent = i + 1;
    wrap.append(box, num);
    wrap.addEventListener('click', () => goTo(i + 1));
    frag.appendChild(wrap);
    return { num: i + 1, wrap, box, canvas: null, visible: false, token: 0, key: null };
  });
  el.sidebar.appendChild(frag);
  thumbs.forEach((t) => thumbObserver.observe(t.wrap));
}

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    visible.forEach(renderPage);
    thumbs.forEach((t) => t.visible && renderThumb(t));
  }, 120);
}

async function renderPage(p) {
  if (!pdf) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const key = `${zoom.toFixed(3)}|${rotation}|${dpr}`;
  if (p.key === key && p.canvas) return;
  const token = ++p.token;
  p.task?.cancel(); p.task = null;
  const doc = pdf;
  let page;
  try { page = await doc.getPage(p.num); } catch { return; }
  if (token !== p.token || !p.visible || doc !== pdf) return;

  const scale = zoom * CSS_PER_PT;
  const viewport = page.getViewport({ scale, rotation });
  let out = dpr;
  if (viewport.width * viewport.height * out * out > MAX_CANVAS_PIXELS) out = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * out));
  canvas.height = Math.max(1, Math.floor(viewport.height * out));
  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport, background: '#ffffff',
    transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
  });
  p.task = task;
  try { await task.promise; }
  catch (e) { if (e?.name !== 'RenderingCancelledException') console.error(e); freeCanvas(canvas); return; }
  p.task = null;
  if (token !== p.token) { freeCanvas(canvas); return; }

  if (p.canvas) { freeCanvas(p.canvas); p.canvas.remove(); }   // swap old (stretched) canvas for the sharp one
  p.canvas = canvas; p.key = key;
  p.el.insertBefore(canvas, p.textDiv);

  // selectable text
  try {
    p.textDiv.replaceChildren();
    p.el.style.setProperty('--scale-factor', scale);
    p.el.style.setProperty('--total-scale-factor', scale);
    const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: p.textDiv, viewport });
    await tl.render();
  } catch { /* text layer is optional */ }
  page.cleanup();
}

function releasePage(p) {
  p.token++;
  p.task?.cancel(); p.task = null;
  if (p.canvas) { freeCanvas(p.canvas); p.canvas.remove(); p.canvas = null; }
  p.textDiv.replaceChildren();
  p.key = null;
}

async function renderThumb(t) {
  if (!pdf) return;
  const key = String(rotation);
  if (t.key === key && t.canvas) return;
  const token = ++t.token;
  const doc = pdf;
  let page;
  try { page = await doc.getPage(t.num); } catch { return; }
  if (token !== t.token || !t.visible || doc !== pdf) return;
  const base = page.getViewport({ scale: 1, rotation });
  const viewport = page.getViewport({ scale: THUMB_W / base.width, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, background: '#ffffff' }).promise;
  } catch { freeCanvas(canvas); return; }
  if (token !== t.token) { freeCanvas(canvas); return; }
  if (t.canvas) { freeCanvas(t.canvas); t.canvas.remove(); }
  t.canvas = canvas; t.key = key; t.box.appendChild(canvas);
  page.cleanup();
}

function releaseThumb(t) {
  t.token++;
  if (t.canvas) { freeCanvas(t.canvas); t.canvas.remove(); t.canvas = null; }
  t.key = null;
}

// ---------------------------------------------------------------- navigation / UI state
function goTo(n) {
  if (!pdf) return;
  n = clamp(Math.round(n) || 1, 1, pdf.numPages);
  el.viewer.scrollTop = pages[n - 1].el.offsetTop - 8;
  current = n; updateUI();
}

let rafPending = false;
function updateCurrent() {
  if (rafPending) return; rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (!pdf || !visible.size) return;
    const mid = el.viewer.scrollTop + el.viewer.clientHeight / 2;
    let best = current, bd = Infinity;
    for (const p of visible) {
      const d = Math.abs(p.el.offsetTop + p.el.offsetHeight / 2 - mid);
      if (d < bd) { bd = d; best = p.num; }
    }
    if (best !== current) { current = best; updateUI(); }
  });
}

function updateUI() {
  if (!pdf) { el.pageInput.value = ''; return; }
  if (document.activeElement !== el.pageInput) el.pageInput.value = current;
  if (document.activeElement !== el.zoomInput) el.zoomInput.value = Math.round(zoom * 100) + '%';
  el.btnFit.title = fitMode === 'page' ? 'Fit to width' : 'Fit to page';
  thumbs.forEach((t) => t.wrap.classList.toggle('sel', t.num === current));
  if (!el.sidebar.hidden) thumbs[current - 1]?.wrap.scrollIntoView({ block: 'nearest' });
}

el.viewer.addEventListener('scroll', updateCurrent, { passive: true });
window.addEventListener('resize', () => { if (fitMode) relayout(); });

// ---------------------------------------------------------------- toolbar wiring
$('btnSidebar').onclick = () => { el.sidebar.hidden = !el.sidebar.hidden; if (fitMode) relayout(); updateUI(); };
$('btnZoomIn').onclick = () => stepZoom(1);
$('btnZoomOut').onclick = () => stepZoom(-1);
$('btnFit').onclick = toggleFit;
$('btnRotate').onclick = rotate;
$('btnTheme').onclick = toggleInverted;
$('btnSave').onclick = saveCopy;
$('btnPrint').onclick = printDoc;
$('btnMore').onclick = (e) => { e.stopPropagation(); el.menu.hidden = !el.menu.hidden; };
document.addEventListener('click', () => (el.menu.hidden = true));
el.menu.addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act; if (!act) return;
  ({ open: chooseFile, invert: toggleInverted, present: togglePresent, props: showProps })[act]();
});

el.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { goTo(parseInt(el.pageInput.value, 10)); el.pageInput.blur(); }
  if (e.key === 'Escape') { el.pageInput.blur(); updateUI(); }
});
el.pageInput.addEventListener('focus', () => el.pageInput.select());
el.pageInput.addEventListener('blur', updateUI);
el.zoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = parseFloat(el.zoomInput.value.replace('%', ''));
    if (v > 0) setZoom(v / 100); el.zoomInput.blur();
  }
  if (e.key === 'Escape') { el.zoomInput.blur(); updateUI(); }
});
el.zoomInput.addEventListener('focus', () => el.zoomInput.select());
el.zoomInput.addEventListener('blur', updateUI);

// ---------------------------------------------------------------- keyboard / wheel
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement;
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); }
    else if (k === 's') { e.preventDefault(); saveCopy(); }
    else if (k === 'p') { e.preventDefault(); printDoc(); }
    else if (k === 'd') { e.preventDefault(); toggleInverted(); }
    else if (k === '=' || k === '+') { e.preventDefault(); stepZoom(1); }
    else if (k === '-') { e.preventDefault(); stepZoom(-1); }
    else if (k === '0') { e.preventDefault(); setZoom(1); }
    return;
  }
  if (e.key === 'F11') { e.preventDefault(); togglePresent(); return; }
  if (e.key === 'Escape') { el.menu.hidden = true; return; }
  if (typing || !pdf) return;
  const v = el.viewer;
  switch (e.key) {
    case 'PageDown': case 'ArrowRight': if (e.key === 'ArrowRight' && v.scrollWidth > v.clientWidth) return; e.preventDefault(); goTo(current + 1); break;
    case 'PageUp': case 'ArrowLeft': if (e.key === 'ArrowLeft' && v.scrollWidth > v.clientWidth) return; e.preventDefault(); goTo(current - 1); break;
    case 'Home': e.preventDefault(); goTo(1); break;
    case 'End': e.preventDefault(); goTo(pdf.numPages); break;
    case ' ': e.preventDefault(); v.scrollBy({ top: (e.shiftKey ? -1 : 1) * v.clientHeight * 0.9 }); break;
    case 'ArrowDown': e.preventDefault(); v.scrollBy({ top: 60 }); break;
    case 'ArrowUp': e.preventDefault(); v.scrollBy({ top: -60 }); break;
  }
});
el.viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault(); stepZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// ---------------------------------------------------------------- save / print / present / properties
async function saveCopy() {
  if (!pdf) return;
  if (T && srcPath) {
    const dst = await T.dialog.save({ defaultPath: fileName, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dst) return;
    try { await T.core.invoke('save_copy', { src: srcPath, dst }); toast('Saved'); }
    catch (e) { toast('Save failed: ' + e, 5000); }
  } else {
    const data = await pdf.getData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/pdf' })); a.download = fileName;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

async function printDoc() {
  if (!pdf) return;
  const urls = [];
  el.printArea.replaceChildren();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      toast(`Preparing to print… ${i}/${pdf.numPages}`, 0);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 150 / 72 });       // 150 dpi
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, background: '#fff' }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      freeCanvas(c); page.cleanup();
      const img = new Image(); img.src = URL.createObjectURL(blob); urls.push(img.src);
      await img.decode().catch(() => {});
      el.printArea.appendChild(img);                          // only the (small) JPEGs stay in memory
    }
    hideToast();
    window.print();
  } catch (e) { toast('Print failed: ' + e, 5000); }
  finally { urls.forEach(URL.revokeObjectURL); el.printArea.replaceChildren(); }
}

let presenting = false;
async function togglePresent() {
  presenting = !presenting;
  try {
    if (T) await T.window.getCurrentWindow().setFullscreen(presenting);
    else if (presenting) await document.documentElement.requestFullscreen(); else await document.exitFullscreen();
  } catch { presenting = !presenting; }
  document.getElementById('toolbar').style.display = presenting ? 'none' : '';
  if (fitMode) setTimeout(relayout, 150);
}

async function showProps() {
  if (!pdf) return;
  const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
  const [w, h] = sizes[0];
  const rows = [
    ['File name', fileName], ['Title', info.Title], ['Author', info.Author], ['Subject', info.Subject],
    ['Creator', info.Creator], ['PDF producer', info.Producer], ['PDF version', info.PDFFormatVersion],
    ['Page count', pdf.numPages],
    ['Page size', `${(w / 72).toFixed(2)} × ${(h / 72).toFixed(2)} in  (${(w / 72 * 25.4).toFixed(0)} × ${(h / 72 * 25.4).toFixed(0)} mm)`],
  ].filter((r) => r[1] !== undefined && r[1] !== '');
  const dl = $('propsList'); dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  $('propsDialog').showModal();
}

// ---------------------------------------------------------------- drag & drop, startup
if (T) {
  T.webview.getCurrentWebview().onDragDropEvent((e) => {
    const t = e.payload.type;
    if (t === 'enter' || t === 'over') document.body.classList.add('dragging');
    else document.body.classList.remove('dragging');
    if (t === 'drop') {
      const f = e.payload.paths.find((p) => p.toLowerCase().endsWith('.pdf'));
      if (f) loadPath(f); else toast('Please drop a PDF file');
    }
  });
  T.core.invoke('initial_file').then((f) => f && loadPath(f)).catch(() => {});
} else {
  // plain-browser fallback for quick testing
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files].find((x) => x.name.toLowerCase().endsWith('.pdf'));
    if (f) openDoc({ data: new Uint8Array(await f.arrayBuffer()) }, f.name);
  });
}
window.addEventListener('contextmenu', (e) => { if (!(e.target.closest('.textLayer'))) e.preventDefault(); });
