import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

// ================================================================ constants / helpers
const T = window.__TAURI__ || null;
const CSS_PER_PT = 96 / 72;                 // "100%" in Chromium = 96 dpi
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_CANVAS_PIXELS = 10e6;             // caps RAM per rendered page
const THUMB_W = 120;
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const baseName = (p) => p.split(/[\\/]/).pop();
const freeCanvas = (c) => { if (c) { c.width = 0; c.height = 0; } };

const el = {
  tabs: $('tabs'), panes: $('panes'), sidebar: $('sidebar'), title: $('title'),
  pageInput: $('pageInput'), pageCount: $('pageCount'), zoomInput: $('zoomInput'),
  btnFit: $('btnFit'), btnTheme: $('btnTheme'), btnSplit: $('btnSplit'),
  menu: $('menu'), tabMenu: $('tabMenu'), toast: $('toast'), fileInput: $('fileInput'), printArea: $('printArea'),
};

let toastTimer;
function toast(msg, ms = 2500) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}
const hideToast = () => (el.toast.hidden = true);

const THEMES = [['light', 'Original'], ['dark', 'Dark'], ['black', 'Black'], ['mono', 'Dark, no colors'], ['sepia', 'Sepia']];
const isTheme = (t) => THEMES.some((x) => x[0] === t);
const BACKDROPS = [['charcoal', 'Charcoal', '#2b2b2b'], ['slate', 'Slate blue', '#2a313b'], ['brown', 'Warm brown', '#35302b'], ['black', 'Near black', '#111111']];
let backdrop = 'charcoal';
try { const b = localStorage.getItem('backdrop'); if (BACKDROPS.some((x) => x[0] === b)) backdrop = b; } catch { /* ignore */ }
function setBackdrop(id) {
  const b = BACKDROPS.find((x) => x[0] === id); if (!b) return;
  backdrop = id; document.documentElement.style.setProperty('--dark-backdrop', b[2]);
  try { localStorage.setItem('backdrop', id); } catch { /* ignore */ }
  refreshUI();
}
let lastTheme = 'light';                     // new tabs start with whatever you used last
let darkChoice = 'dark';                     // what Ctrl+D switches to
try {
  const a = localStorage.getItem('theme'), b = localStorage.getItem('darkChoice');
  if (isTheme(a)) lastTheme = a;
  if (isTheme(b) && b !== 'light') darkChoice = b;
} catch { /* ignore */ }

// remembered position per file (page, zoom, rotation, theme)
function loadState(path) { try { return JSON.parse(localStorage.getItem('pos') || '{}')[path] || null; } catch { return null; } }
function saveState(d) {
  if (!d?.path || !d.pdf) return;
  try {
    const m = JSON.parse(localStorage.getItem('pos') || '{}');
    delete m[d.path];
    m[d.path] = { page: d.current, zoom: d.zoom, fit: d.fit, rot: d.rot, theme: d.theme };
    const keys = Object.keys(m); while (keys.length > 200) delete m[keys.shift()];
    localStorage.setItem('pos', JSON.stringify(m));
  } catch { /* ignore */ }
}
function queueSave(d) { if (!d) return; clearTimeout(d.saveTimer); d.saveTimer = setTimeout(() => saveState(d), 800); }

// ================================================================ Doc = one tab
let seq = 0;
class Doc {
  constructor(name, path) {
    Object.assign(this, {
      id: ++seq, name, path, pdf: null, task: null, sizes: [],
      zoom: 1, fit: null, rot: 0, current: 1, scroll: 0,
      pane: null, loading: true, error: null, closed: false, theme: lastTheme, sizesDirty: false,
      restore: false, saveTimer: 0,
      kind: /\.docx$/i.test(name) ? 'docx' : 'pdf', host: null, docxW: 816, docxH: 1056,
    });
  }
  eff(i) { const s = this.sizes[i]; return this.rot % 180 ? [s[1], s[0]] : [s[0], s[1]]; }
  destroy() {
    this.closed = true;
    if (this.task) this.task.destroy().catch(() => {});
    this.task = null; this.pdf = null; this.host = null;
  }
}

const docs = [];
const panes = [];
let activePane = null;
let splitOn = false;

// ================================================================ Pane = one scrolling viewer
class Pane {
  constructor(i) {
    this.i = i;
    this.root = document.createElement('div');
    this.root.className = 'pane';
    this.root.innerHTML = '<div class="viewer" tabindex="-1"><div class="pages"></div></div><div class="empty"></div>';
    this.viewer = this.root.querySelector('.viewer');
    this.pagesEl = this.root.querySelector('.pages');
    this.empty = this.root.querySelector('.empty');
    this.pages = [];                     // { num, el, canvas, textDiv, visible, token, key, task }
    this.visible = new Set();
    this.doc = null;
    this.renderTimer = 0; this.raf = false; this.roRaf = 0;

    this.observer = new IntersectionObserver((es) => this.onIntersect(es), { root: this.viewer, rootMargin: '60% 0px 60% 0px' });
    this.viewer.addEventListener('scroll', () => this.updateCurrent(), { passive: true });
    this.viewer.addEventListener('wheel', (e) => {       // Ctrl+wheel and touchpad pinch (sent as Ctrl+wheel)
      if (!e.ctrlKey) return;
      e.preventDefault(); if (activePane !== this) setActive(this);
      const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50;      // mouse wheel click vs. smooth pinch trickle
      if (notch) this.stepZoom(e.deltaY < 0 ? 1 : -1);
      else this.pinchZoom(Math.exp(-clamp(e.deltaY, -25, 25) * 0.01));
    }, { passive: false });
    {                                                    // two-finger pinch on a touchscreen
      const pts = new Map(); let last = 0;
      const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
      this.viewer.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') { pts.set(e.pointerId, [e.clientX, e.clientY]); if (pts.size === 2) last = dist(); } });
      this.viewer.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 2 && last > 0) { const n = dist(); this.pinchZoom(n / last); last = n; }
      });
      const up = (e) => { pts.delete(e.pointerId); };
      this.viewer.addEventListener('pointerup', up); this.viewer.addEventListener('pointercancel', up);
    }
    this.root.addEventListener('pointerdown', () => { if (activePane !== this) setActive(this); }, true);
    new ResizeObserver(() => {           // re-fit when the pane changes size (window, sidebar, split)
      cancelAnimationFrame(this.roRaf);
      this.roRaf = requestAnimationFrame(() => { if (this.doc?.fit) this.relayout(); });
    }).observe(this.viewer);
    this.refreshEmpty();
  }

  // ---------- which document is shown
  show(doc) {
    this.detach();
    this.doc = doc;
    if (doc) { doc.pane = this; if (doc.pdf) this.build(); }
    this.applyTheme(); this.refreshEmpty();
  }

  detach() {                             // frees every canvas; the tab itself stays open
    const d = this.doc; if (!d) return;
    d.scroll = this.viewer.scrollTop;
    saveState(d);
    this.visible.clear(); this.observer.disconnect();
    for (const p of this.pages) { p.token++; p.task?.cancel(); freeCanvas(p.canvas); }
    this.pages = []; this.pagesEl.replaceChildren();
    d.pane = null; this.doc = null;
  }

  build() {
    const d = this.doc;
    if (d.kind === 'docx') { this.buildDocx(); return; }
    const frag = document.createDocumentFragment();
    this.pages = Array.from({ length: d.pdf.numPages }, (_, i) => {
      const div = document.createElement('div');
      div.className = 'page'; div.dataset.n = i + 1;
      const textDiv = document.createElement('div'); textDiv.className = 'textLayer';
      div.appendChild(textDiv); frag.appendChild(div);
      return { num: i + 1, el: div, canvas: null, textDiv, visible: false, token: 0, key: null, task: null };
    });
    this.pagesEl.replaceChildren(frag);
    this.refreshEmpty();
    this.applyTheme();
    this.relayout(false, true);
    if (d.restore) { d.restore = false; this.viewer.scrollTop = this.pages[d.current - 1].el.offsetTop - 8; }
    else this.viewer.scrollTop = d.scroll;
    this.pages.forEach((p) => this.observer.observe(p.el));
  }

  // ---------- Word documents: rendered once into HTML, kept detached while the tab is hidden
  buildDocx() {
    const d = this.doc;
    this.pagesEl.replaceChildren(d.host);
    this.pages = [...d.host.querySelectorAll('section')].map((s, i) => { s.dataset.n = i + 1; return { num: i + 1, el: s, visible: false }; });
    this.refreshEmpty();
    this.applyTheme();
    this.relayoutDocx(true);
    this.viewer.scrollTop = d.restore ? this.docxTop(d.current) : d.scroll;
    d.restore = false;
    this.pages.forEach((p) => this.observer.observe(p.el));
  }

  docxTop(n) {                           // CSS zoom makes offsetTop unreliable, so measure instead
    const p = this.pages[clamp(n, 1, this.pages.length) - 1];
    if (!p) return 0;
    return p.el.getBoundingClientRect().top - this.viewer.getBoundingClientRect().top + this.viewer.scrollTop - 8;
  }

  centerOf(p, d) {
    if (d.kind !== 'docx') return p.el.offsetTop + p.el.offsetHeight / 2;
    const r = p.el.getBoundingClientRect();
    return r.top - this.viewer.getBoundingClientRect().top + this.viewer.scrollTop + r.height / 2;
  }

  relayoutDocx(init = false) {
    const d = this.doc; if (!d?.host) return;
    if (d.fit) {
      const aw = (this.viewer.clientWidth - 16) / d.docxW, ah = (this.viewer.clientHeight - 16) / d.docxH;
      d.zoom = clamp(d.fit === 'width' ? aw : Math.min(aw, ah), 0.1, 5);
    }
    const cp = this.pages[d.current - 1], vTop = () => this.viewer.getBoundingClientRect().top;
    let frac = 0;
    if (!init && cp) { const r = cp.el.getBoundingClientRect(); frac = (vTop() - r.top) / Math.max(1, r.height); }
    d.host.style.zoom = d.zoom;
    if (!init && cp) { const r = cp.el.getBoundingClientRect(); this.viewer.scrollTop += r.top - vTop() + frac * r.height; }
    if (this === activePane) refreshUI();
    queueSave(d);
  }

  refreshEmpty() {
    const d = this.doc;
    let a, b = '';
    if (!d) { a = this.i ? 'Nothing open in this pane' : 'Drop a PDF or Word file here'; b = this.i ? 'Pick a tab, or press Ctrl+O to open a file here' : 'or press Ctrl+O to open one'; }
    else if (d.loading) a = 'Loading…';
    else if (d.error) { a = 'Could not open this PDF'; b = d.error; }
    else { this.empty.classList.add('gone'); return; }
    this.empty.classList.remove('gone');
    const pa = document.createElement('p'); pa.textContent = a;
    const pb = document.createElement('p'); pb.className = 'sub'; pb.textContent = b;
    this.empty.replaceChildren(pa, pb);
  }

  applyTheme() {
    const th = this.doc?.theme || 'light';
    for (const [id] of THEMES) this.root.classList.toggle('t-' + id, id === th && id !== 'light');
  }

  // ---------- layout
  computeFit() {
    const d = this.doc; const [w, h] = d.eff(0);
    if (!this.viewer.clientWidth) return d.zoom;
    const aw = (this.viewer.clientWidth - 16) / (w * CSS_PER_PT);
    const ah = (this.viewer.clientHeight - 16) / (h * CSS_PER_PT);
    return d.fit === 'width' ? aw : Math.min(aw, ah);
  }

  applySizes() {
    const d = this.doc, s = d.zoom * CSS_PER_PT;
    this.pages.forEach((p, i) => {
      const [w, h] = d.eff(i);
      p.el.style.width = Math.round(w * s) + 'px';
      p.el.style.height = Math.round(h * s) + 'px';
    });
  }

  relayout(rerender = true, init = false) {
    const d = this.doc;
    if (d?.kind === 'docx') { if (d.host && this.pages.length) this.relayoutDocx(init); return; }
    if (!d || !d.pdf || !this.pages.length) return;
    if (d.fit) d.zoom = clamp(this.computeFit(), 0.1, 5);
    const cp = this.pages[d.current - 1];
    let frac = 0;
    if (!init && cp) frac = (this.viewer.scrollTop - cp.el.offsetTop) / Math.max(1, cp.el.offsetHeight);
    this.applySizes();
    if (!init && cp) this.viewer.scrollTop = cp.el.offsetTop + frac * cp.el.offsetHeight;
    if (rerender) this.scheduleRender();
    if (this === activePane) { applyThumbSizes(); refreshUI(); }
    queueSave(d);
  }

  pinchZoom(factor) {                    // smooth zoom: collect gesture events, apply once per frame
    const d = this.doc; if (!d?.pdf) return;
    this.pz = clamp((this.pz ?? d.zoom) * factor, 0.1, 5);
    if (this.pzRaf) return;
    this.pzRaf = requestAnimationFrame(() => { this.pzRaf = 0; const z = this.pz; this.pz = null; this.setZoom(z); });
  }

  setZoom(z, fit = null) { const d = this.doc; if (!d?.pdf) return; d.fit = fit; d.zoom = clamp(z, 0.1, 5); this.relayout(); }
  stepZoom(dir) {
    const d = this.doc; if (!d?.pdf) return;
    const next = dir > 0
      ? STEPS.find((s) => s > d.zoom + 1e-3) || 5
      : [...STEPS].reverse().find((s) => s < d.zoom - 1e-3) || 0.25;
    this.setZoom(next);
  }
  rotate() { const d = this.doc; if (!d?.pdf || d.kind === 'docx') return; d.rot = (d.rot + 270) % 360; this.relayout(); if (this === activePane) rebuildThumbs(); }
  toggleFit() { const d = this.doc; if (d?.pdf) this.setZoom(0, d.fit === 'page' ? 'width' : 'page'); }

  goTo(n) {
    const d = this.doc; if (!d?.pdf) return;
    n = clamp(Math.round(n) || 1, 1, d.pdf.numPages);
    this.viewer.scrollTop = d.kind === 'docx' ? this.docxTop(n) : this.pages[n - 1].el.offsetTop - 8;
    d.current = n; if (this === activePane) refreshUI();
  }

  updateCurrent() {
    if (this.raf) return; this.raf = true;
    requestAnimationFrame(() => {
      this.raf = false;
      const d = this.doc; if (!d || !this.visible.size) return;
      const mid = this.viewer.scrollTop + this.viewer.clientHeight / 2;
      let best = d.current, bd = Infinity;
      for (const p of this.visible) {
        const dist = Math.abs(this.centerOf(p, d) - mid);
        if (dist < bd) { bd = dist; best = p.num; }
      }
      if (best !== d.current) { d.current = best; if (this === activePane) refreshUI(); queueSave(d); }
    });
  }

  // ---------- lazy rendering (the RAM saver): only pages near the viewport have a canvas
  onIntersect(entries) {
    for (const e of entries) {
      const p = this.pages[+e.target.dataset.n - 1];
      if (!p || p.el !== e.target) continue;
      p.visible = e.isIntersecting;
      const dx = this.doc?.kind === 'docx';
      if (e.isIntersecting) { this.visible.add(p); if (!dx) this.renderPage(p); }
      else { this.visible.delete(p); if (!dx) releasePage(p); }
    }
    this.updateCurrent();
  }

  scheduleRender() {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      if (this.doc?.kind === 'docx') return;
      this.visible.forEach((p) => this.renderPage(p));
      if (this === activePane) thumbs.forEach((t) => t.visible && renderThumb(t));
    }, 120);
  }

  async renderPage(p) {
    const d = this.doc; if (!d?.pdf) return;
    const pdf = d.pdf;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${d.zoom.toFixed(3)}|${d.rot}|${dpr}`;
    if (p.key === key && p.canvas) return;
    const token = ++p.token;
    p.task?.cancel(); p.task = null;
    let page;
    try { page = await pdf.getPage(p.num); } catch { return; }
    if (token !== p.token || !p.visible || d !== this.doc) return;

    const scale = d.zoom * CSS_PER_PT;
    const viewport = page.getViewport({ scale, rotation: d.rot });
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

    if (p.canvas) { freeCanvas(p.canvas); p.canvas.remove(); }   // swap the stretched old canvas for the sharp one
    p.canvas = canvas; p.key = key;
    p.el.insertBefore(canvas, p.textDiv);

    try {                                                         // selectable text
      p.textDiv.replaceChildren();
      p.el.style.setProperty('--scale-factor', scale);
      p.el.style.setProperty('--total-scale-factor', scale);
      const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: p.textDiv, viewport });
      await tl.render();
    } catch { /* text layer is optional */ }
    page.cleanup();
    if (find.q && find.pane === this) applyHighlights();
  }
}

function releasePage(p) {
  p.token++;
  p.task?.cancel(); p.task = null;
  if (p.canvas) { freeCanvas(p.canvas); p.canvas.remove(); p.canvas = null; }
  p.textDiv.replaceChildren();
  p.key = null;
}

// ================================================================ thumbnails (always for the active pane's tab)
let thumbs = [];
let thumbDoc = null;
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const t = thumbs[+e.target.dataset.n - 1]; if (!t || t.wrap !== e.target) continue;
    t.visible = e.isIntersecting;
    if (e.isIntersecting) renderThumb(t); else releaseThumb(t);
  }
}, { root: el.sidebar, rootMargin: '100% 0px' });

function rebuildThumbs() {
  thumbObserver.disconnect();
  for (const t of thumbs) freeCanvas(t.canvas);
  thumbs = []; thumbDoc = null; el.sidebar.replaceChildren();
  const d = activePane?.doc;
  if (!d?.pdf || d.kind === 'docx') return;      // Word documents have no thumbnails
  thumbDoc = d;
  const frag = document.createDocumentFragment();
  thumbs = Array.from({ length: d.pdf.numPages }, (_, i) => {
    const wrap = document.createElement('div'); wrap.className = 'thumb'; wrap.dataset.n = i + 1;
    const box = document.createElement('div'); box.className = 'tbox';
    const num = document.createElement('div'); num.className = 'tnum'; num.textContent = i + 1;
    wrap.append(box, num);
    wrap.addEventListener('click', () => activePane?.goTo(i + 1));
    frag.appendChild(wrap);
    return { num: i + 1, wrap, box, canvas: null, visible: false, token: 0, key: null };
  });
  el.sidebar.appendChild(frag);
  applyThumbSizes();
  thumbs.forEach((t) => thumbObserver.observe(t.wrap));
}

function applyThumbSizes() {
  const d = thumbDoc; if (!d) return;
  thumbs.forEach((t, i) => {
    const [w, h] = d.eff(i);
    t.box.style.height = Math.round(THUMB_W * h / w) + 'px';
  });
}

async function renderThumb(t) {
  const d = thumbDoc; if (!d?.pdf) return;
  const key = String(d.rot);
  if (t.key === key && t.canvas) return;
  const token = ++t.token;
  let page;
  try { page = await d.pdf.getPage(t.num); } catch { return; }
  if (token !== t.token || !t.visible || d !== thumbDoc) return;
  const base = page.getViewport({ scale: 1, rotation: d.rot });
  const viewport = page.getViewport({ scale: THUMB_W / base.width, rotation: d.rot });
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

// ================================================================ toolbar / tab strip state
function refreshUI() {
  const d = activePane?.doc;
  el.title.textContent = d ? d.name : 'PDF Reader';
  document.title = d ? d.name + ' - PDF Reader' : 'PDF Reader';
  el.sidebar.dataset.theme = d?.theme || 'light';
  el.btnTheme.classList.toggle('on', !!d && d.theme !== 'light');
  el.btnSplit.classList.toggle('on', splitOn);
  el.menu.querySelectorAll('[data-theme]').forEach((b) => {
    b.firstChild.textContent = (b.dataset.theme === (d?.theme || 'light') ? '✓  ' : '  ') + b.dataset.label;
  });
  el.menu.querySelectorAll('[data-backdrop]').forEach((b) => {
    b.firstChild.textContent = (b.dataset.backdrop === backdrop ? '✓  ' : '  ') + b.dataset.label;
  });
  if (!d?.pdf) {
    el.pageCount.textContent = '0';
    if (document.activeElement !== el.pageInput) el.pageInput.value = '';
    if (document.activeElement !== el.zoomInput) el.zoomInput.value = '100%';
    return;
  }
  el.pageCount.textContent = d.pdf.numPages;
  if (document.activeElement !== el.pageInput) el.pageInput.value = d.current;
  if (document.activeElement !== el.zoomInput) el.zoomInput.value = Math.round(d.zoom * 100) + '%';
  el.btnFit.title = d.fit === 'page' ? 'Fit to width' : 'Fit to page';
  thumbs.forEach((t) => t.wrap.classList.toggle('sel', t.num === d.current));
  if (!el.sidebar.hidden) {                // keep the current thumbnail in view (manual: scrollIntoView can shift the whole window)
    const w = thumbs[d.current - 1]?.wrap, sb = el.sidebar;
    if (w) {
      const top = w.offsetTop, bot = top + w.offsetHeight;
      if (top < sb.scrollTop) sb.scrollTop = top - 8;
      else if (bot > sb.scrollTop + sb.clientHeight) sb.scrollTop = bot - sb.clientHeight + 8;
    }
  }
  if (T && lastWinTitle !== d.name) { lastWinTitle = d.name; T.window.getCurrentWindow().setTitle(d.name).catch(() => {}); }
}
let lastWinTitle = '';

function renderTabs() {
  el.tabs.replaceChildren();
  for (const d of docs) {
    const t = document.createElement('div');
    t.className = 'tab' + (d.pane && d.pane === activePane ? ' active' : '');
    t.title = d.path || d.name;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = d.name;
    t.appendChild(name);
    if (splitOn && d.pane) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = d.pane.i ? 'R' : 'L'; t.appendChild(b); }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Close tab (Ctrl+W)';
    x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(d); });
    t.appendChild(x);
    t.addEventListener('click', () => showDoc(d));
    t.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    t.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(d); });
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); showTabMenu(e, d); });
    el.tabs.appendChild(t);
  }
  const act = el.tabs.querySelector('.tab.active');
  if (act) {
    const l = act.offsetLeft, r = l + act.offsetWidth, t = el.tabs;
    if (l < t.scrollLeft) t.scrollLeft = l; else if (r > t.scrollLeft + t.clientWidth) t.scrollLeft = r - t.clientWidth;
  }
}

function showTabMenu(e, d) {
  const m = el.tabMenu; m.replaceChildren();
  const items = [
    ['Open in left pane', () => moveDoc(d, panes[0])],
    ['Open in right pane', () => { setSplit(true); moveDoc(d, panes[1]); }],
    ['Close tab', () => closeTab(d)],
    ['Close other tabs', () => docs.filter((x) => x !== d).forEach(closeTab)],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button'); b.textContent = label;
    b.addEventListener('click', () => { m.hidden = true; fn(); });
    m.appendChild(b);
  }
  m.style.left = Math.min(e.clientX, window.innerWidth - 260) + 'px';
  m.style.top = e.clientY + 'px';
  m.hidden = false;
}

// ================================================================ tab / pane management
function setActive(pane) {
  activePane = pane;
  if (find.q && find.doc !== pane?.doc) closeFind();
  panes.forEach((p) => p.root.classList.toggle('active', p === pane));
  rebuildThumbs(); refreshUI(); renderTabs();
}

function showDoc(doc, pane = activePane) {            // clicking a tab
  if (doc.pane) { if (doc.pane !== activePane) setActive(doc.pane); else renderTabs(); return; }
  pane.show(doc); setActive(pane);
}

function moveDoc(doc, pane) {                          // explicit "open in left/right pane" (swaps if needed)
  if (doc.pane === pane) { setActive(pane); return; }
  const cur = pane.doc, other = doc.pane;
  if (other) other.detach();
  pane.show(doc);
  if (other) other.show(cur);
  setActive(pane);
}

function setSplit(on) {
  if (on === splitOn) return;
  splitOn = on;
  el.panes.classList.toggle('split', on);
  panes[1].root.hidden = !on; $('splitter').hidden = !on;
  panes[0].root.style.flex = '';
  if (on) panes[1].show(docs.find((d) => !d.pane) || null);
  else { panes[1].show(null); if (activePane === panes[1]) { setActive(panes[0]); return; } }
  refreshUI(); renderTabs();
}

function closeTab(doc) {
  const i = docs.indexOf(doc); if (i < 0) return;
  const pane = doc.pane;
  if (pane) pane.detach();
  doc.destroy();
  docs.splice(i, 1);
  if (pane) {
    const free = docs.filter((d) => !d.pane);
    pane.show(free.find((d) => docs.indexOf(d) >= i) || free[free.length - 1] || null);
  }
  setActive(activePane || panes[0]);
}

function cycleTab(dir) {
  if (docs.length < 2) return;
  const cur = docs.indexOf(activePane?.doc);
  showDoc(docs[(cur + dir + docs.length) % docs.length]);
}

// ================================================================ opening documents
function openSource(source, name, path, pane = activePane) {
  const doc = new Doc(name, path);
  docs.push(doc);
  pane.show(doc);
  setActive(pane);
  loadDoc(doc, source);
  return doc;
}

async function openPath(path, pane = activePane) {
  if (!path) return;
  const existing = docs.find((d) => d.path === path);
  if (existing) { showDoc(existing, pane); return; }
  openSource({ url: T.core.convertFileSrc(path) }, baseName(path), path, pane);
}

async function loadDoc(doc, source) {
  if (doc.kind === 'docx') return loadDocx(doc, source);
  const base = new URL('./lib/', import.meta.url).href;
  const task = pdfjsLib.getDocument({
    ...source,
    cMapUrl: base + 'cmaps/', cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false,
    disableAutoFetch: true,            // fetch only what is needed -> low RAM
    rangeChunkSize: 1 << 18,
  });
  task.onPassword = (cb, reason) => askPassword(reason).then((p) => (p === null ? task.destroy() : cb(p)));
  doc.task = task;
  try { doc.pdf = await task.promise; }
  catch (e) {
    if (doc.closed) return;
    doc.loading = false; doc.error = e?.message || String(e);
    doc.pane?.refreshEmpty(); renderTabs(); return;
  }
  if (doc.closed) { doc.pdf?.destroy(); return; }
  try {
    const first = await doc.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 }); first.cleanup();
    doc.sizes = Array.from({ length: doc.pdf.numPages }, () => [vp.width, vp.height]);
  } catch (e) { doc.pdf = null; doc.loading = false; doc.error = String(e); doc.pane?.refreshEmpty(); return; }
  doc.loading = false;
  const st = doc.path ? loadState(doc.path) : null;       // pick up where you left off
  if (st) {
    doc.zoom = st.zoom > 0 ? st.zoom : 1; doc.fit = st.fit || null; doc.rot = st.rot || 0;
    doc.current = clamp(st.page || 1, 1, doc.pdf.numPages);
    if (isTheme(st.theme)) doc.theme = st.theme;
    doc.restore = true;
  }
  if (doc.pane) { doc.pane.build(); if (doc.pane === activePane) { rebuildThumbs(); refreshUI(); } }
  renderTabs();
  loadSizes(doc);
}

// ---- Word (.docx): libraries are loaded only the first time a Word file is opened
let docxLibs = null;
const loadScript = (src) => new Promise((res, rej) => {
  const s = document.createElement('script'); s.src = src; s.onload = res;
  s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s);
});
function ensureDocxLibs() {
  if (!docxLibs) {
    const base = new URL('./lib/', import.meta.url).href;
    docxLibs = loadScript(base + 'jszip.min.js').then(() => loadScript(base + 'docx-preview.min.js'));
    docxLibs.catch(() => { docxLibs = null; });
  }
  return docxLibs;
}

async function loadDocx(doc, source) {
  try {
    await ensureDocxLibs();
    let buf = source.data;
    if (!buf) {
      const r = await fetch(source.url);
      if (!r.ok) throw new Error('Could not read the file');
      buf = await r.arrayBuffer();
    }
    if (doc.closed) return;
    const host = document.createElement('div'); host.className = 'docxhost';
    const styles = document.createElement('div'), body = document.createElement('div');
    host.append(styles, body);
    $('docxStage').appendChild(host);                 // off-screen but laid out, so page sizes can be measured
    await window.docx.renderAsync(buf, body, styles, {
      className: 'dx' + doc.id, inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
      ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, trimXmlDeclaration: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
    });
    const secs = body.querySelectorAll('section');
    if (!secs.length) throw new Error('This document has no content to display');
    const r = secs[0].getBoundingClientRect();
    doc.docxW = r.width || 816; doc.docxH = r.height || 1056;
    host.remove();
    if (doc.closed) return;
    doc.host = host;
    const keep = doc.path ? null : buf;
    // small adapter so the rest of the app can treat a Word file like a PDF with N pages
    doc.pdf = {
      numPages: secs.length, destroy() {},
      getData: async () => (keep ? new Uint8Array(keep) : new Uint8Array(0)),
      getMetadata: async () => ({ info: {} }),
    };
    doc.sizes = [[doc.docxW * 0.75, doc.docxH * 0.75]];
  } catch (e) {
    if (doc.closed) return;
    console.error(e);
    doc.loading = false; doc.error = e?.message || String(e);
    doc.pane?.refreshEmpty(); renderTabs(); return;
  }
  doc.loading = false;
  const st = doc.path ? loadState(doc.path) : null;
  if (st) {
    doc.zoom = st.zoom > 0 ? st.zoom : 1; doc.fit = st.fit || null;
    doc.current = clamp(st.page || 1, 1, doc.pdf.numPages);
    if (isTheme(st.theme)) doc.theme = st.theme;
    doc.restore = true;
  }
  if (doc.pane) { doc.pane.build(); if (doc.pane === activePane) { rebuildThumbs(); refreshUI(); } }
  renderTabs();
}

async function loadSizes(doc) {        // real sizes of the remaining pages, fetched in the background
  const pdf = doc.pdf;
  for (let i = 2; i <= pdf.numPages; i++) {
    if (doc.closed) return;
    try {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: 1 }); pg.cleanup();
      const old = doc.sizes[i - 1];
      if (Math.abs(old[0] - vp.width) > .5 || Math.abs(old[1] - vp.height) > .5) { doc.sizes[i - 1] = [vp.width, vp.height]; doc.sizesDirty = true; }
    } catch { return; }
    if ((i % 25 === 0 || i === pdf.numPages) && doc.sizesDirty) { doc.sizesDirty = false; doc.pane?.relayout(false); }
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

async function chooseFile() {
  if (T) {
    const r = await T.dialog.open({ multiple: true, filters: [{ name: 'PDF and Word documents', extensions: ['pdf', 'docx'] }] });
    if (!r) return;
    const target = activePane;
    for (const p of Array.isArray(r) ? r : [r]) await openPath(p, target);
  } else el.fileInput.click();
}
el.fileInput.addEventListener('change', async () => {        // plain-browser fallback (no Tauri)
  const target = activePane;
  for (const f of el.fileInput.files) openSource({ data: new Uint8Array(await f.arrayBuffer()) }, f.name, null, target);
  el.fileInput.value = '';
});

// ================================================================ actions on the active tab
const curDoc = () => activePane?.doc?.pdf ? activePane.doc : null;

function setTheme(id) {
  const d = activePane?.doc; if (!d || !isTheme(id)) return;
  d.theme = id; lastTheme = id;
  if (id !== 'light') darkChoice = id;
  try { localStorage.setItem('theme', lastTheme); localStorage.setItem('darkChoice', darkChoice); } catch { /* ignore */ }
  activePane.applyTheme(); refreshUI(); queueSave(d);
}
// Ctrl+D / toolbar button: switch between the original colors and your chosen dark theme
function toggleInverted() { const d = activePane?.doc; if (d) setTheme(d.theme === 'light' ? darkChoice : 'light'); }

async function saveCopy() {
  const d = curDoc(); if (!d) return;
  if (T && d.path) {
    const dst = await T.dialog.save({ defaultPath: d.name, filters: d.kind === 'docx' ? [{ name: 'Word document', extensions: ['docx'] }] : [{ name: 'PDF', extensions: ['pdf'] }] });
    if (!dst) return;
    try { await T.core.invoke('save_copy', { src: d.path, dst }); toast('Saved'); }
    catch (e) { toast('Save failed: ' + e, 5000); }
  } else {
    const data = await d.pdf.getData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/pdf' })); a.download = d.name;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

function printDocx(d) {
  const copy = d.host.cloneNode(true); copy.style.zoom = '1';
  el.printArea.replaceChildren(copy);
  const done = () => { el.printArea.replaceChildren(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

async function printDoc() {
  const d = curDoc(); if (!d) return;
  if (d.kind === 'docx') { printDocx(d); return; }
  const pdf = d.pdf, urls = [];
  el.printArea.replaceChildren();
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      toast(`Preparing to print… ${i}/${pdf.numPages}`, 0);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 150 / 72 });          // 150 dpi
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp, background: '#fff' }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      freeCanvas(c); page.cleanup();
      const img = new Image(); img.src = URL.createObjectURL(blob); urls.push(img.src);
      await img.decode().catch(() => {});
      el.printArea.appendChild(img);                              // only the (small) JPEGs stay in memory
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
  $('toolbar').style.display = presenting ? 'none' : '';
  $('tabbar').style.display = presenting ? 'none' : '';
}

async function showProps() {
  const d = curDoc(); if (!d) return;
  const { info } = await d.pdf.getMetadata().catch(() => ({ info: {} }));
  const [w, h] = d.sizes[0];
  const rows = [
    ['File name', d.name], ['Title', info.Title], ['Author', info.Author], ['Subject', info.Subject],
    ['Creator', info.Creator], ['PDF producer', info.Producer], ['PDF version', info.PDFFormatVersion],
    ['Page count', d.pdf.numPages],
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

// ================================================================ find in document (Ctrl+F)
// Matches are located per page from the PDF's text; highlights use the CSS Custom Highlight API on the text layer.
const find = { q: '', doc: null, pane: null, matches: [], idx: -1, gen: 0, scrollPending: false, scanning: false };
const findEls = { bar: $('findbar'), input: $('findInput'), count: $('findCount') };
let findTimer;

function openFind() {
  if (!curDoc()) return;
  findEls.bar.hidden = false;
  findEls.input.focus(); findEls.input.select();
  if (findEls.input.value) runFind(findEls.input.value);
}

function closeFind() {
  find.gen++; find.q = ''; find.matches = []; find.idx = -1; find.scanning = false;
  findEls.bar.hidden = true; findEls.count.textContent = '';
  clearHighlights();
}

function clearHighlights() {
  if (window.CSS?.highlights) for (const k of ['find-all', 'find-cur', 'dfind-all', 'dfind-cur']) CSS.highlights.delete(k);
}

function updateFindLabel() {
  const n = find.matches.length;
  findEls.count.textContent = !find.q ? '' : n ? `${find.idx + 1}/${n}${find.scanning ? '+' : ''}` : (find.scanning ? '…' : '0/0');
}

async function runFind(q) {
  const d = curDoc(), gen = ++find.gen;
  Object.assign(find, { q, doc: d, pane: activePane, matches: [], idx: -1, scanning: !!(d && q) });
  clearHighlights();
  if (!d || !q) { updateFindLabel(); return; }
  if (d.kind === 'docx') { findDocx(d, q); return; }
  const needle = q.toLowerCase();
  const n = d.pdf.numPages, start = d.current;
  for (let s = 0; s < n; s++) {                       // scan from the current page, wrapping around
    const pageNum = ((start - 1 + s) % n) + 1;
    if (gen !== find.gen || d.closed) return;
    let tc;
    try { const pg = await d.pdf.getPage(pageNum); tc = await pg.getTextContent(); pg.cleanup(); } catch { continue; }
    if (gen !== find.gen) return;
    let k = 0;
    for (const it of tc.items) {
      if (!it.str) continue;
      const hay = it.str.toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) find.matches.push({ page: pageNum, k: k++ });
    }
    if (find.idx < 0 && find.matches.length) { find.idx = 0; gotoMatch(); }
    if (s % 5 === 0) updateFindLabel();
  }
  find.scanning = false; updateFindLabel();
}

function findDocx(d, q) {                 // Word documents: search the rendered text directly
  const needle = q.toLowerCase();
  const walker = document.createTreeWalker(d.host, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.data.toLowerCase();
    for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) {
      const r = new Range(); r.setStart(n, i); r.setEnd(n, i + needle.length);
      find.matches.push({ range: r });
    }
  }
  find.scanning = false;
  if (find.matches.length) { find.idx = 0; gotoMatch(); } else updateFindLabel();
}

function gotoDocxMatch() {
  if (window.CSS?.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.set('dfind-all', new Highlight(...find.matches.map((m) => m.range)));
    CSS.highlights.set('dfind-cur', new Highlight(find.matches[find.idx].range));
  }
  find.matches[find.idx].range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  updateFindLabel();
}

function gotoMatch() {
  const m = find.matches[find.idx]; if (!m) return;
  if (m.range) { gotoDocxMatch(); return; }
  find.scrollPending = true;
  const pane = find.pane;
  if (pane.doc === find.doc) pane.goTo(m.page);
  applyHighlights();
  updateFindLabel();
}

function stepFind(dir) {
  const n = find.matches.length; if (!n) return;
  find.idx = (find.idx + dir + n) % n;
  gotoMatch();
}

function applyHighlights() {
  if (!window.CSS?.highlights || typeof Highlight === 'undefined') return;
  clearHighlights();
  const pane = find.pane;
  if (!find.q || !pane || pane.doc !== find.doc) return;
  const needle = find.q.toLowerCase(), cur = find.matches[find.idx];
  const all = []; let curRange = null;
  for (const p of pane.pages) {
    if (!p.canvas) continue;                           // only pages that are rendered have a text layer
    let k = 0;
    for (const span of p.textDiv.querySelectorAll('span')) {
      const tn = span.firstChild;
      if (!tn || tn.nodeType !== 3) continue;
      const s = tn.data.toLowerCase();
      for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) {
        const r = new Range(); r.setStart(tn, i); r.setEnd(tn, i + needle.length);
        all.push(r);
        if (cur && cur.page === p.num && cur.k === k) curRange = r;
        k++;
      }
    }
  }
  if (all.length) CSS.highlights.set('find-all', new Highlight(...all));
  if (curRange) {
    CSS.highlights.set('find-cur', new Highlight(curRange));
    if (find.scrollPending) { find.scrollPending = false; curRange.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' }); }
  }
}

findEls.input.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(findEls.input.value), 200); });
findEls.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(findTimer); if (find.q === findEls.input.value && find.matches.length) stepFind(e.shiftKey ? -1 : 1); else runFind(findEls.input.value); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); activePane?.viewer.focus(); }
});
$('findNext').onclick = () => stepFind(1);
$('findPrev').onclick = () => stepFind(-1);
$('findClose').onclick = closeFind;

// ================================================================ wiring
// panes + splitter
panes.push(new Pane(0), new Pane(1));
const splitter = document.createElement('div'); splitter.id = 'splitter'; splitter.hidden = true;
el.panes.append(panes[0].root, splitter, panes[1].root);
panes[1].root.hidden = true;
splitter.addEventListener('pointerdown', (e) => {
  splitter.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const r = el.panes.getBoundingClientRect();
    panes[0].root.style.flex = `0 0 ${clamp(ev.clientX - r.left, 200, r.width - 206)}px`;
  };
  const up = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); };
  splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', up);
});
splitter.addEventListener('dblclick', () => { panes[0].root.style.flex = ''; });

// toolbar
$('btnSidebar').onclick = () => { el.sidebar.hidden = !el.sidebar.hidden; refreshUI(); };
$('btnZoomIn').onclick = () => activePane.stepZoom(1);
$('btnZoomOut').onclick = () => activePane.stepZoom(-1);
$('btnFit').onclick = () => activePane.toggleFit();
$('btnRotate').onclick = () => activePane.rotate();
el.btnTheme.onclick = toggleInverted;
el.btnSplit.onclick = () => setSplit(!splitOn);
$('btnSave').onclick = saveCopy;
$('btnPrint').onclick = printDoc;
$('btnNewTab').onclick = chooseFile;
$('btnMore').onclick = (e) => { e.stopPropagation(); el.tabMenu.hidden = true; el.menu.hidden = !el.menu.hidden; };
document.addEventListener('click', () => { el.menu.hidden = true; el.tabMenu.hidden = true; });
// theme entries in the ⋮ menu
{
  const anchor = el.menu.querySelector('[data-act="invert"]');
  const sep = document.createElement('div'); sep.className = 'sep'; sep.textContent = 'Theme';
  anchor.after(sep);
  let prev = sep;
  for (const [id, label] of THEMES) {
    const b = document.createElement('button');
    b.dataset.theme = id; b.dataset.label = label;
    b.appendChild(document.createElement('span'));
    prev.after(b); prev = b;
  }
  const sep2 = document.createElement('div'); sep2.className = 'sep'; sep2.textContent = 'Dark backdrop color';
  prev.after(sep2); prev = sep2;
  for (const [id, label] of BACKDROPS) {
    const b = document.createElement('button');
    b.dataset.backdrop = id; b.dataset.label = label;
    b.appendChild(document.createElement('span'));
    prev.after(b); prev = b;
  }
}
el.menu.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  if (btn.dataset.theme) { setTheme(btn.dataset.theme); return; }
  if (btn.dataset.backdrop) { setBackdrop(btn.dataset.backdrop); return; }
  const act = btn.dataset.act; if (!act) return;
  ({
    open: chooseFile, close: () => activePane?.doc && closeTab(activePane.doc),
    split: () => setSplit(!splitOn), invert: toggleInverted, present: togglePresent, props: showProps,
  })[act]();
});

el.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { activePane.goTo(parseInt(el.pageInput.value, 10)); el.pageInput.blur(); }
  if (e.key === 'Escape') { el.pageInput.blur(); refreshUI(); }
});
el.pageInput.addEventListener('focus', () => el.pageInput.select());
el.pageInput.addEventListener('blur', refreshUI);
el.zoomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = parseFloat(el.zoomInput.value.replace('%', ''));
    if (v > 0) activePane.setZoom(v / 100); el.zoomInput.blur();
  }
  if (e.key === 'Escape') { el.zoomInput.blur(); refreshUI(); }
});
el.zoomInput.addEventListener('focus', () => el.zoomInput.select());
el.zoomInput.addEventListener('blur', refreshUI);

// keyboard
document.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement;
  const mod = e.ctrlKey || e.metaKey;
  const pane = activePane, d = pane?.doc;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); }
    else if (k === 's') { e.preventDefault(); saveCopy(); }
    else if (k === 'p') { e.preventDefault(); printDoc(); }
    else if (k === 'd') { e.preventDefault(); toggleInverted(); }
    else if (k === 'f') { e.preventDefault(); openFind(); }
    else if (k === 'g') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    else if (k === 'w') { e.preventDefault(); if (d) closeTab(d); }
    else if (k === '\\') { e.preventDefault(); setSplit(!splitOn); }
    else if (e.key === 'Tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (k === '=' || k === '+') { e.preventDefault(); pane.stepZoom(1); }
    else if (k === '-') { e.preventDefault(); pane.stepZoom(-1); }
    else if (k === '0') { e.preventDefault(); pane.setZoom(1); }
    return;
  }
  if (e.key === 'F11') { e.preventDefault(); togglePresent(); return; }
  if (e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Escape') { el.menu.hidden = true; el.tabMenu.hidden = true; if (!findEls.bar.hidden) closeFind(); return; }
  if (typing || !d?.pdf) return;
  const v = pane.viewer, wide = v.scrollWidth > v.clientWidth;
  switch (e.key) {
    case 'PageDown': e.preventDefault(); pane.goTo(d.current + 1); break;
    case 'ArrowRight': if (wide) return; e.preventDefault(); pane.goTo(d.current + 1); break;
    case 'PageUp': e.preventDefault(); pane.goTo(d.current - 1); break;
    case 'ArrowLeft': if (wide) return; e.preventDefault(); pane.goTo(d.current - 1); break;
    case 'Home': e.preventDefault(); pane.goTo(1); break;
    case 'End': e.preventDefault(); pane.goTo(d.pdf.numPages); break;
    case ' ': e.preventDefault(); v.scrollBy({ top: (e.shiftKey ? -1 : 1) * v.clientHeight * 0.9 }); break;
    case 'ArrowDown': e.preventDefault(); v.scrollBy({ top: 60 }); break;
    case 'ArrowUp': e.preventDefault(); v.scrollBy({ top: -60 }); break;
  }
});

window.addEventListener('contextmenu', (e) => { if (!e.target.closest('.textLayer, .tab, .docxhost')) e.preventDefault(); });

// ================================================================ drag & drop, startup
const paneAtX = (x) => (splitOn && x >= panes[1].root.getBoundingClientRect().left ? panes[1] : panes[0]);

if (T) {
  T.webview.getCurrentWebview().onDragDropEvent((e) => {
    const t = e.payload.type;
    document.body.classList.toggle('dragging', t === 'enter' || t === 'over');
    if (t === 'drop') {
      const files = e.payload.paths.filter((p) => /\.(pdf|docx)$/i.test(p));
      if (!files.length) { toast('Please drop a PDF or Word (.docx) file'); return; }
      const x = (e.payload.position?.x ?? 0) / (window.devicePixelRatio || 1);
      const target = paneAtX(x);
      files.forEach((f) => openPath(f, target));
    }
  });
  // PDFs opened from Explorer while the app is already running arrive here (single-instance)
  T.event.listen('open-file', (e) => openPath(e.payload));
  T.core.invoke('initial_files').then((fs) => fs.forEach((f) => openPath(f))).catch(() => {});
} else {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const target = paneAtX(e.clientX);
    for (const f of e.dataTransfer.files) {
      if (/\.(pdf|docx)$/i.test(f.name)) openSource({ data: new Uint8Array(await f.arrayBuffer()) }, f.name, null, target);
    }
  });
}

setBackdrop(backdrop);
// Never let the browser zoom the whole window (toolbar included) on Ctrl+wheel / pinch; the viewer handles it itself.
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false, capture: true });
// The page itself must never scroll (programmatic scrolling can otherwise shift the whole layout).
window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); });
// If anything fails, show it instead of leaving a dead screen.
window.addEventListener('error', (e) => toast('Error: ' + (e.message || 'unknown'), 8000));
window.addEventListener('unhandledrejection', (e) => toast('Error: ' + (e.reason?.message || e.reason || 'unknown'), 8000));
window.addEventListener('beforeunload', () => docs.forEach((d) => { if (d.pane) d.scroll = d.pane.viewer.scrollTop; saveState(d); }));
setActive(panes[0]);
