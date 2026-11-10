// Loop canvas client
const $ = s => document.querySelector(s);
const vp = $('#viewport'), world = $('#world'), framesEl = $('#frames'), inkSvg = $('#ink'), cursorsEl = $('#cursors');
const hoverBox = $('#hover-box'), composer = $('#composer'), composerInput = $('#composer-input'), threadEl = $('#thread');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 10);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const COLORS = ['#2F5BFF', '#E5484D', '#1F9D55', '#D9A100', '#8E4EC6', '#0E9AA7', '#E8590C'];
const MARK = '#E5484D';

let S = null;                  // server state
let view = { x: 120, y: 140, z: 0.5 };
let viewLoaded = false;
let tool = 'select', spaceHeld = false;
let selected = null;           // frame id
let openThreadId = null;
let draft = null;              // { frameId, anchor, ink, inkStrokes }
let inkChip = null;            // { frameId, lx, ly }
const myStrokes = new Set();
const frameEls = new Map();    // id -> { el, iframe, ... }
const drag = new Map();        // frameId -> {x,y,w,h} override while dragging
const cursors = new Map();
// In the hosted viewer, cloud.js installs an adapter (Supabase instead of the local server) before loading this file.
const ADAPTER = window.LOOP_ADAPTER || null;
const me = store.get('loop.me', null) || { id: rid(), name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)] };
if (ADAPTER?.me) Object.assign(me, ADAPTER.me);
me.id = me.id || rid();

// ---------- api ----------
async function api(method, path, body) {
  if (ADAPTER) return ADAPTER.api(method, path, body);
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const isOwner = () => S?.role === 'owner';

// ---------- live connection ----------
function connect() {
  if (ADAPTER) return ADAPTER.connect(handle);
  const es = new EventSource('/__loop/api/events');
  es.onmessage = e => handle(JSON.parse(e.data));
  es.onerror = () => { $('#agent-pill').classList.add('offline'); };
  es.onopen = () => { $('#agent-pill').classList.remove('offline'); };
}
function handle(ev) {
  if (ev.type === 'state') {
    const first = !S; S = ev.state;
    if (first) onFirstState();
    render();
  } else if (ev.type === 'activity') {
    if (S?.live[ev.frameId]) S.live[ev.frameId].step = ev.step;
    updateFrame(S.frames.find(f => f.id === ev.frameId));
    document.querySelectorAll(`[data-step-for="${ev.commentId}"]`).forEach(n => (n.textContent = ev.step));
  } else if (ev.type === 'frame-changed') {
    reloadFrame(ev.frameId);
    if (ev.done) flash(ev.frameId, ev.status === 'done' ? 'Updated' : ev.status === 'error' ? 'Failed' : '', ev.status !== 'done');
    if (ev.done && ev.status === 'done') resnapshotLater(ev.frameId);
  } else if (ev.type === 'presence') {
    if (ev.id === me.id) return;
    if (ev.leave) cursors.delete(ev.id); else cursors.set(ev.id, { ...ev, t: Date.now() });
    renderCursors(); renderPresence();
  }
}
function onFirstState() {
  const saved = store.get(`loop.view.${S.name}`, null);
  if (saved) { view = saved; applyView(); } else fitAll(false);
  viewLoaded = true;
  if (!me.name) {
    if (isOwner()) me.name = 'Host';
    else { $('#name-modal').hidden = false; setTimeout(() => $('#name-input').focus(), 30); }
  }
  store.set('loop.me', me);
  document.body.classList.toggle('guest', !isOwner());
  $('#new-frame-btn').hidden = !isOwner();
  document.querySelector('#toolbar .tb-sep').hidden = !isOwner();
}

// ---------- view ----------
function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  world.style.setProperty('--z', view.z);
  let gs = 24 * view.z; while (gs < 12) gs *= 4;
  vp.style.setProperty('--gs', `${gs}px`);
  vp.style.setProperty('--gx', `${view.x}px`);
  vp.style.setProperty('--gy', `${view.y}px`);
  $('#zoom-level').textContent = `${Math.round(view.z * 100)}%`;
  positionPops();
  hoverBox.hidden = true;
  if (viewLoaded && S) { clearTimeout(applyView.t); applyView.t = setTimeout(() => store.set(`loop.view.${S.name}`, view), 300); }
}
function zoomAt(cx, cy, factor) {
  const z = Math.min(4, Math.max(0.04, view.z * factor));
  view.x = cx - (cx - view.x) * (z / view.z);
  view.y = cy - (cy - view.y) * (z / view.z);
  view.z = z; applyView();
}
const toWorld = (cx, cy) => ({ x: (cx - view.x) / view.z, y: (cy - view.y) / view.z });
function fitAll(animate = true, ids) {
  const fs = (S?.frames || []).filter(f => !ids || ids.includes(f.id));
  if (!fs.length) { view = { x: innerWidth / 2, y: innerHeight / 2, z: 0.5 }; return applyView(); }
  const minX = Math.min(...fs.map(f => f.x)), minY = Math.min(...fs.map(f => f.y));
  const maxX = Math.max(...fs.map(f => f.x + f.w)), maxY = Math.max(...fs.map(f => f.y + f.h));
  const padX = 80, top = 110, bottom = 110;
  const z = Math.min(1, (innerWidth - padX * 2) / (maxX - minX), (innerHeight - top - bottom) / (maxY - minY));
  const target = { z, x: (innerWidth - (maxX - minX) * z) / 2 - minX * z, y: top + ((innerHeight - top - bottom) - (maxY - minY) * z) / 2 - minY * z };
  if (!animate) { view = target; return applyView(); }
  const from = { ...view }, t0 = performance.now();
  const step = t => {
    const k = Math.min(1, (t - t0) / 280), e = 1 - Math.pow(1 - k, 3);
    view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
    applyView(); if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- render ----------
function render() {
  if (!S) return;
  $('#canvas-name').textContent = S.name;
  document.title = `${S.name} — Loop`;
  $('#empty').hidden = S.frames.length > 0;
  renderAgentPill();
  renderPresence();
  const ids = new Set(S.frames.map(f => f.id));
  for (const [id, fe] of frameEls) if (!ids.has(id)) { fe.el.remove(); frameEls.delete(id); }
  for (const f of S.frames) updateFrame(f);
  if (selected && !ids.has(selected)) selected = null;
  renderInk();
  renderAllPins();
  if (openThreadId) renderThread();
  if (draft && !ids.has(draft.frameId)) closeComposer();
}

function frameView(f) { return { ...f, ...(drag.get(f.id) || {}) }; }

function makeFrame(f) {
  const el = document.createElement('div');
  el.className = 'frame'; el.dataset.id = f.id;
  el.innerHTML = `
    <div class="frame-label">
      <span class="spinner"></span><span class="name"></span><span class="kind" hidden></span><span class="count"></span>
      <span class="step"></span><span class="elapsed"></span><span class="updated"></span>
      <button class="stop" title="Stop the agent">Stop</button>
    </div>
    <div class="frame-body"><iframe title="${esc(f.name)}"></iframe><div class="shield"></div><div class="pins"></div><div class="progress"></div></div>
    <div class="resize"></div>`;
  framesEl.appendChild(el);
  const fe = { el, iframe: el.querySelector('iframe'), label: el.querySelector('.frame-label'), name: el.querySelector('.name'), kind: el.querySelector('.kind'), count: el.querySelector('.count'), step: el.querySelector('.step'), elapsed: el.querySelector('.elapsed'), updated: el.querySelector('.updated'), pins: el.querySelector('.pins'), restore: null };
  fe.iframe.addEventListener('load', () => {
    try {
      const w = fe.iframe.contentWindow;
      if (fe.restore) { w.scrollTo(fe.restore.sx, fe.restore.sy); fe.restore = null; }
      w.addEventListener('scroll', () => positionPins(f.id), { passive: true });
      w.addEventListener('resize', () => positionPins(f.id));
      // pass shortcuts through when the frame has focus
      w.addEventListener('keydown', e => { if (e.key === 'Escape') { selectFrame(null); window.focus(); } });
    } catch {}
    setTimeout(() => positionPins(f.id), 60);
  });
  el.querySelector('.stop').addEventListener('pointerdown', e => e.stopPropagation());
  el.querySelector('.stop').addEventListener('click', () => { const l = S.live[f.id]; if (l) api('POST', `/__loop/api/comments/${l.commentId}/cancel`).catch(err => toast(err.message)); });
  fe.label.addEventListener('dblclick', () => isOwner() && startRename(f.id));
  frameEls.set(f.id, fe);
  return fe;
}

function updateFrame(f0) {
  if (!f0) return;
  const f = frameView(f0);
  const fe = frameEls.get(f.id) || makeFrame(f);
  const s = fe.el.style;
  s.left = `${f.x}px`; s.top = `${f.y}px`; s.width = `${f.w}px`; s.height = `${f.h}px`;
  s.setProperty('--fw', `${f.w}px`);
  // folder frames come from Loop; route frames come from the dev server through Loop (same origin)
  const src = ADAPTER?.frameSrc?.(f) || (f.kind === 'folder' ? `/__loop/f/${f.id}/${encodeURIComponent(f.entry || 'index.html')}` : f.src);
  if (fe.iframe.dataset.src !== src) { fe.iframe.dataset.src = src; fe.iframe.src = src; }
  if (!fe.renaming) fe.name.textContent = f.name;
  fe.kind.hidden = f.kind === 'folder' || f.kind === 'static';
  fe.kind.textContent = f.kind === 'route' ? f.src : 'live url';
  const live = S.live[f.id];
  const open = S.comments.filter(c => c.frameId === f.id && !c.parentId && c.kind !== 'create' && !c.resolved).length;
  fe.count.textContent = open && !live ? `${open}` : '';
  fe.el.classList.toggle('working', !!live);
  if (live) {
    const c = S.comments.find(x => x.id === live.commentId);
    fe.step.textContent = live.step || (c?.kind === 'create' ? 'Building the frame…' : 'Working…');
    fe.elapsed.textContent = elapsed(live.startedAt);
  }
  fe.el.classList.toggle('selected', selected === f.id);
  fe.el.classList.toggle('live', tool === 'select' && selected === f.id && !spaceHeld);
}

function elapsed(t) { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
setInterval(() => {
  if (!S) return;
  for (const [fid, l] of Object.entries(S.live)) { const fe = frameEls.get(fid); if (fe) fe.elapsed.textContent = elapsed(l.startedAt); }
  document.querySelectorAll('[data-elapsed-from]').forEach(n => (n.textContent = elapsed(+n.dataset.elapsedFrom)));
  const now = Date.now(); let pruned = false;
  for (const [id, c] of cursors) if (now - c.t > 15000) { cursors.delete(id); pruned = true; }
  if (pruned) { renderCursors(); renderPresence(); }
}, 1000);

function reloadFrame(id) {
  const fe = frameEls.get(id); if (!fe) return;
  try { const w = fe.iframe.contentWindow; fe.restore = { sx: w.scrollX, sy: w.scrollY }; } catch { fe.restore = null; }
  const base = fe.iframe.dataset.src;
  const f = S.frames.find(x => x.id === id);
  if (f?.kind === 'static') return; // hosted snapshots get a new URL per version
  if (f?.kind === 'folder') fe.iframe.src = `${base}?_m=${Date.now()}`;
  else if (f?.kind === 'route') { try { fe.iframe.contentWindow.location.reload(); } catch { fe.iframe.src = base; } }
  else { try { fe.iframe.contentWindow.location.reload(); } catch { fe.iframe.src = base; } }
}
function flash(id, text, failed) {
  const fe = frameEls.get(id); if (!fe || !text) return;
  fe.updated.textContent = text;
  fe.el.classList.remove('updated', 'failed'); void fe.el.offsetWidth;
  fe.el.classList.add(failed ? 'failed' : 'updated');
  clearTimeout(fe.flashT); fe.flashT = setTimeout(() => fe.el.classList.remove('updated', 'failed'), 4200);
}

function startRename(id) {
  const fe = frameEls.get(id), f = S.frames.find(x => x.id === id);
  fe.renaming = true;
  const input = document.createElement('input'); input.className = 'rename'; input.value = f.name;
  fe.name.replaceChildren(input); input.focus(); input.select();
  input.addEventListener('pointerdown', e => e.stopPropagation());
  const done = save => {
    if (!fe.renaming) return; fe.renaming = false;
    const v = input.value.trim();
    fe.name.textContent = save && v ? v : f.name;
    if (save && v && v !== f.name) api('PATCH', `/__loop/api/frames/${id}`, { name: v });
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

// ---------- agent pill & presence ----------
function renderAgentPill() {
  const pill = $('#agent-pill'), n = Object.keys(S.live).length;
  const queued = S.comments.filter(c => c.status === 'queued').length;
  const waiting = S.comments.filter(c => c.status === 'waiting').length;
  const name = S.agent.mode === 'inbox' ? 'Your agent' : (S.agentBin === 'claude' ? 'Claude Code' : S.agentBin);
  let label = name;
  if (S.hostOnline === false) label = `Host offline · comments wait`;
  if (n) label += ` · ${n} working`;
  else if (queued) label += ` · ${queued} queued`;
  if (waiting && isOwner()) label += ` · ${waiting} to review`;
  $('#agent-label').textContent = label;
  pill.classList.toggle('busy', n > 0);
  pill.classList.toggle('inbox', S.agent.mode === 'inbox' && !n);
  document.querySelectorAll('#agent-menu .menu-item').forEach(b => b.classList.toggle('on', b.dataset.mode === S.agent.mode));
  if (!$('#share-menu').hidden) fillShare();
}
function initials(n) { return (n || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function renderPresence() {
  const people = [{ name: me.name || 'You', color: me.color }, ...cursors.values()];
  $('#presence').innerHTML = people.length > 1 ? people.slice(0, 6).map(p => `<span class="avatar" style="background:${esc(p.color)}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`).join('') : '';
}
function renderCursors() {
  const seen = new Set();
  for (const c of cursors.values()) {
    seen.add(c.id);
    let el = cursorsEl.querySelector(`[data-id="${CSS.escape(c.id)}"]`);
    if (!el) {
      el = document.createElement('div'); el.className = 'cursor'; el.dataset.id = c.id;
      el.innerHTML = `<div class="cursor-inner"><svg viewBox="0 0 18 18"><path d="M2 1.5l13 6.2-5.6 1.5-2.4 5.6z" fill="${esc(c.color)}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="background:${esc(c.color)}">${esc(c.name)}</span></div>`;
      cursorsEl.appendChild(el);
    }
    el.style.transform = `translate(${c.x}px, ${c.y}px)`;
  }
  cursorsEl.querySelectorAll('.cursor').forEach(el => { if (!seen.has(el.dataset.id)) el.remove(); });
}
let lastPresence = 0;
function sendPresence(cx, cy) {
  const now = Date.now(); if (now - lastPresence < 70 || !S) return; lastPresence = now;
  const p = toWorld(cx, cy);
  api('POST', '/__loop/api/presence', { id: me.id, name: me.name || 'Guest', color: me.color, avatar: me.avatar, x: p.x, y: p.y }).catch(() => {});
}
addEventListener('beforeunload', () => !ADAPTER && navigator.sendBeacon?.('/__loop/api/presence', new Blob([JSON.stringify({ id: me.id, leave: true })], { type: 'application/json' })));

// ---------- ink ----------
function pathD(p) {
  if (p.length < 4) return `M${p[0]} ${p[1]}l.01 0`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) d += `Q${p[i]} ${p[i + 1]} ${(p[i] + p[i + 2]) / 2} ${(p[i + 1] + p[i + 3]) / 2}`;
  return d + `L${p[p.length - 2]} ${p[p.length - 1]}`;
}
function renderInk() {
  const ids = new Set(S.strokes.map(s => s.id));
  inkSvg.querySelectorAll('path[data-id]').forEach(p => { if (!ids.has(p.dataset.id)) p.remove(); });
  for (const s of S.strokes) {
    let p = inkSvg.querySelector(`path[data-id="${s.id}"]`);
    if (!p) { p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.dataset.id = s.id; p.setAttribute('d', pathD(s.points)); inkSvg.appendChild(p); }
    p.setAttribute('stroke', s.color); p.setAttribute('stroke-width', s.width);
    p.classList.toggle('used', !!s.commentId);
  }
}
function frameAt(wx, wy) {
  for (let i = S.frames.length - 1; i >= 0; i--) { const f = S.frames[i]; if (wx >= f.x && wx <= f.x + f.w && wy >= f.y && wy <= f.y + f.h) return f; }
  return null;
}

// ---------- element picking inside frames ----------
function frameDoc(fid) { try { return frameEls.get(fid)?.iframe.contentDocument || null; } catch { return null; } }
function localFromClient(fid, cx, cy) {
  const r = frameEls.get(fid).iframe.getBoundingClientRect();
  return { lx: (cx - r.left) / view.z, ly: (cy - r.top) / view.z };
}
function elementAt(fid, lx, ly) {
  const doc = frameDoc(fid); if (!doc) return null;
  try { return doc.elementFromPoint(lx, ly); } catch { return null; }
}
function selectorFor(el) {
  if (!el || !el.ownerDocument) return '';
  const doc = el.ownerDocument, parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) {
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift(`#${n.id}`); break; }
    let part = n.tagName.toLowerCase();
    const sibs = n.parentElement ? [...n.parentElement.children].filter(x => x.tagName === n.tagName) : [];
    if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
    parts.unshift(part);
    if (n.tagName === 'BODY' || parts.length > 7) break;
  }
  return parts.join(' > ');
}
function describeEl(el) {
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
  return el.tagName.toLowerCase() + cls;
}
function anchorFor(fid, lx, ly) {
  const el = elementAt(fid, lx, ly);
  const doc = frameDoc(fid);
  let sx = 0, sy = 0; try { sx = doc.defaultView.scrollX; sy = doc.defaultView.scrollY; } catch {}
  const a = { x: lx, y: ly, sx, sy };
  if (el && el !== doc.documentElement) {
    const r = el.getBoundingClientRect();
    Object.assign(a, {
      selector: selectorFor(el), tag: el.tagName.toLowerCase(), label: describeEl(el),
      text: (el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      html: el.outerHTML.length > 1500 ? el.outerHTML.slice(0, 1500) + '…' : el.outerHTML,
      fx: r.width ? (lx - r.left) / r.width : 0, fy: r.height ? (ly - r.top) / r.height : 0,
    });
  }
  return a;
}
const CANVAS = '__canvas'; // comments placed on the empty canvas
function anchorPos(fid, a) {
  if (fid === CANVAS) return { x: a.wx, y: a.wy };
  if (a.scope === 'frame') return { x: a.x, y: a.y };
  const doc = frameDoc(fid);
  if (doc && a.selector) {
    try {
      const el = doc.querySelector(a.selector);
      if (el) { const r = el.getBoundingClientRect(); if (r.width || r.height) return { x: r.left + a.fx * r.width, y: r.top + a.fy * r.height }; }
    } catch {}
  }
  let dx = 0, dy = 0; try { dx = doc.defaultView.scrollX - (a.sx || 0); dy = doc.defaultView.scrollY - (a.sy || 0); } catch {}
  return { x: a.x - dx, y: a.y - dy };
}
function showHover(fid, cx, cy) {
  const { lx, ly } = localFromClient(fid, cx, cy);
  const el = elementAt(fid, lx, ly);
  const doc = frameDoc(fid);
  if (!el || el === doc?.documentElement) { hoverBox.hidden = true; return; }
  const fr = frameEls.get(fid).iframe.getBoundingClientRect(), r = el.getBoundingClientRect(), z = view.z;
  const left = Math.max(fr.left, fr.left + r.left * z), top = Math.max(fr.top, fr.top + r.top * z);
  const right = Math.min(fr.right, fr.left + r.right * z), bottom = Math.min(fr.bottom, fr.top + r.bottom * z);
  Object.assign(hoverBox.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
  hoverBox.dataset.tag = describeEl(el);
  hoverBox.hidden = false;
}

// ---------- pins ----------
function threadOf(rootId) { return S.comments.filter(c => c.id === rootId || c.parentId === rootId).sort((a, b) => a.createdAt - b.createdAt); }
function threadStatus(rootId) {
  const t = threadOf(rootId);
  if (t.some(c => c.status === 'working')) return 'working';
  return t[t.length - 1]?.status || 'done';
}
function rootsOf(fid) { return S.comments.filter(c => c.frameId === fid && !c.parentId && c.kind !== 'create').sort((a, b) => a.createdAt - b.createdAt); }
function renderAllPins() { for (const f of S.frames) renderPins(f.id); renderPins(CANVAS); }
function pinsBox(fid) { return fid === CANVAS ? $('#canvas-pins') : frameEls.get(fid)?.pins; }
function renderPins(fid) {
  const box = pinsBox(fid); if (!box) return;
  const fe = { pins: box };
  const roots = rootsOf(fid);
  const want = roots.map((c, i) => ({ key: c.id, n: i + 1, c }));
  if (draft?.frameId === fid) want.push({ key: '__draft', n: roots.length + 1, draft: true });
  const keys = new Set(want.map(w => w.key));
  fe.pins.querySelectorAll('.pin').forEach(p => { if (!keys.has(p.dataset.key)) p.remove(); });
  for (const w of want) {
    let p = fe.pins.querySelector(`.pin[data-key="${w.key}"]`);
    if (!p) {
      p = document.createElement('div'); p.className = 'pin'; p.dataset.key = w.key;
      p.innerHTML = `<div class="pin-dot"></div>`;
      p.addEventListener('pointerdown', e => e.stopPropagation());
      if (!w.draft) p.addEventListener('click', e => { e.stopPropagation(); openThread(w.key); });
      fe.pins.appendChild(p);
    }
    p.querySelector('.pin-dot').textContent = w.n;
    const st = w.draft ? 'draft' : threadStatus(w.key);
    p.className = `pin ${st}${w.c?.resolved ? ' resolved' : ''}${(openThreadId === w.key || w.draft) ? ' active' : ''}`;
  }
  positionPins(fid);
}
function positionPins(fid) {
  const box = pinsBox(fid); if (!box || !S) return;
  box.querySelectorAll('.pin').forEach(p => {
    const a = p.dataset.key === '__draft' ? draft?.anchor : S.comments.find(c => c.id === p.dataset.key)?.anchor;
    if (!a) { p.hidden = true; return; }
    const { x, y } = anchorPos(fid, a);
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    const f = S.frames.find(x => x.id === fid);
    p.hidden = !!f && (x < -4 || y < -4 || x > f.w + 4 || y > f.h + 4);
  });
  if ((draft?.frameId === fid) || (openThreadId && S.comments.find(c => c.id === openThreadId)?.frameId === fid)) positionPops();
}

// screen position of a frame-local point
function screenOf(fid, lx, ly) {
  if (fid === CANVAS) return { x: view.x + lx * view.z, y: view.y + ly * view.z };
  const f = frameView(S.frames.find(x => x.id === fid));
  return { x: view.x + (f.x + lx) * view.z, y: view.y + (f.y + ly) * view.z };
}
function placePop(el, sx, sy) {
  const w = el.offsetWidth || 340, h = el.offsetHeight || 140;
  let x = sx + 18, y = sy - 18;
  if (x + w > innerWidth - 12) x = sx - w - 18;
  x = Math.max(12, Math.min(x, innerWidth - w - 12));
  y = Math.max(60, Math.min(y, innerHeight - h - 76));
  el.style.left = `${x}px`; el.style.top = `${y}px`;
}
function positionPops() {
  if (!S) return;
  if (draft && !composer.hidden) { const p = anchorPos(draft.frameId, draft.anchor); const s = screenOf(draft.frameId, p.x, p.y); placePop(composer, s.x, s.y); }
  if (openThreadId && !threadEl.hidden) {
    const c = S.comments.find(x => x.id === openThreadId);
    if (c?.anchor) { const p = anchorPos(c.frameId, c.anchor); const s = screenOf(c.frameId, p.x, p.y); placePop(threadEl, s.x, s.y); }
  }
  if (inkChip) { const s = screenOf(inkChip.frameId, inkChip.lx, inkChip.ly); const ch = $('#ink-chip'); ch.style.left = `${s.x + 10}px`; ch.style.top = `${s.y + 10}px`; }
}

// ---------- composer ----------
function freshInk(fid) { return S.strokes.filter(s => s.frameId === fid && !s.commentId && myStrokes.has(s.id)); }
// scope: 'element' (what you clicked), 'spot' (just that point), 'frame' (the whole frame), 'canvas' (empty canvas)
function openComposer(fid, lx, ly, scope) {
  closeThread(); hideInkChip();
  const picked = fid === CANVAS ? null : anchorFor(fid, lx, ly);
  const strokes = freshInk(fid);
  draft = { frameId: fid, picked, lx, ly, inkStrokes: strokes.map(s => s.id) };
  setScope(scope || (fid === CANVAS ? 'canvas' : picked?.selector ? 'element' : 'spot'));
  const chip = $('#composer-ink');
  chip.hidden = !strokes.length; chip.textContent = `${strokes.length} mark${strokes.length === 1 ? '' : 's'} attached`;
  composerInput.placeholder = isOwner()
    ? (S.agent.mode === 'inbox' ? 'Comment, then ↵ to queue it for your agent' : `Comment, then ↵ to send to ${S.agentBin === 'claude' ? 'Claude Code' : 'the agent'}`)
    : 'Comment, then ↵ — the host sends it to the agent';
  composer.hidden = false; composerInput.value = ''; autosize(composerInput);
  renderPins(fid); positionPops();
  setTimeout(() => composerInput.focus(), 0);
}
function nearFrames(wx, wy) {
  return S.frames.map(f => ({ f, d: Math.hypot(Math.max(f.x - wx, 0, wx - f.x - f.w), Math.max(f.y - wy, 0, wy - f.y - f.h)) }))
    .sort((a, b) => a.d - b.d).slice(0, 2).filter(x => x.d < 1200).map(x => x.f.name);
}
function setScope(scope) {
  const d = draft; if (!d) return;
  const f = S.frames.find(x => x.id === d.frameId);
  if (scope === 'element' && !d.picked?.selector) scope = 'spot';
  d.scope = scope;
  if (scope === 'canvas') d.anchor = { scope, wx: d.lx, wy: d.ly, near: nearFrames(d.lx, d.ly) };
  else if (scope === 'frame') d.anchor = { scope, x: 18, y: 18 };
  else if (scope === 'spot') d.anchor = { scope, x: d.lx, y: d.ly, sx: d.picked?.sx || 0, sy: d.picked?.sy || 0 };
  else d.anchor = { ...d.picked, scope };
  const t = d.anchor;
  $('#composer-target').innerHTML = scope === 'canvas' ? `<b>Canvas</b><span>${t.near.length ? `near ${esc(t.near.join(', '))}` : 'general note'}</span>`
    : scope === 'frame' ? `<b>${esc(f.name)}</b><span>whole frame</span>`
    : scope === 'spot' ? `<b>${esc(f.name)}</b><span>this spot · x ${Math.round(d.lx)}, y ${Math.round(d.ly)}</span>`
    : `<b>${esc(t.label)}</b><span>${esc(t.text ? `“${t.text}”` : t.selector)}</span>`;
  const pick = $('#scope-pick');
  pick.hidden = scope === 'canvas';
  pick.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.scope === scope);
    b.disabled = b.dataset.scope === 'element' && !d.picked?.selector;
  });
  renderPins(d.frameId); positionPops();
}
document.querySelectorAll('#scope-pick button').forEach(b => b.addEventListener('click', () => { setScope(b.dataset.scope); composerInput.focus(); }));
function closeComposer() {
  const fid = draft?.frameId; draft = null; composer.hidden = true;
  if (fid) renderPins(fid);
}
function autosize(t) { t.style.height = 'auto'; t.style.height = `${Math.min(180, t.scrollHeight)}px`; }
composerInput.addEventListener('input', () => autosize(composerInput));
composerInput.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendDraft(); }
  if (e.key === 'Escape') closeComposer();
});
async function sendDraft() {
  const text = composerInput.value.trim();
  if (!text || !draft) return;
  const d = draft;
  closeComposer();
  const strokes = S.strokes.filter(s => d.inkStrokes.includes(s.id));
  const body = { frameId: d.frameId, text, anchor: d.anchor, author: { name: me.name, color: me.color }, inkStrokes: d.inkStrokes };
  if (strokes.length && d.frameId !== CANVAS) Object.assign(body, inkContext(d.frameId, strokes));
  try {
    await api('POST', '/__loop/api/comments', body);
    if (!isOwner()) toast('Comment added — the host will send it to the agent');
  } catch (e) { toast(e.message); }
}

// which elements the marks cover, plus an image of the marks over the frame outline
function inkContext(fid, strokes) {
  const f = S.frames.find(x => x.id === fid);
  const doc = frameDoc(fid);
  const found = new Map();
  for (const s of strokes) {
    const n = s.points.length / 2, stepN = Math.max(1, Math.floor(n / 14));
    for (let i = 0; i < n; i += stepN) {
      const lx = s.points[i * 2] - f.x, ly = s.points[i * 2 + 1] - f.y;
      const el = elementAt(fid, lx, ly);
      if (!el || el === doc?.documentElement || el === doc?.body) continue;
      const sel = selectorFor(el);
      if (!found.has(sel)) found.set(sel, { selector: sel, tag: el.tagName.toLowerCase(), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), el });
    }
  }
  const ink = [...found.values()].slice(0, 10);
  const scale = Math.min(1, 1280 / Math.max(f.w, f.h));
  const cv = document.createElement('canvas'); cv.width = Math.round(f.w * scale); cv.height = Math.round(f.h * scale);
  const g = cv.getContext('2d'); g.scale(scale, scale);
  g.fillStyle = '#fff'; g.fillRect(0, 0, f.w, f.h);
  g.strokeStyle = '#c9c6bd'; g.lineWidth = 2; g.strokeRect(1, 1, f.w - 2, f.h - 2);
  g.font = '14px ui-monospace, Menlo, monospace';
  for (const i of ink) {
    try {
      const r = i.el.getBoundingClientRect();
      g.strokeStyle = '#2F5BFF'; g.setLineDash([6, 4]); g.lineWidth = 1.5; g.strokeRect(r.left, r.top, r.width, r.height); g.setLineDash([]);
      g.fillStyle = '#2F5BFF'; g.fillText(i.tag + (i.text ? ` "${i.text.slice(0, 30)}"` : ''), r.left + 4, Math.max(14, r.top - 4));
    } catch {}
  }
  g.strokeStyle = MARK; g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of strokes) {
    g.beginPath();
    for (let i = 0; i < s.points.length; i += 2) { const x = s.points[i] - f.x, y = s.points[i + 1] - f.y; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  return { ink: ink.map(({ el, ...rest }) => rest), annotationPng: cv.toDataURL('image/png') };
}

function showInkChip(fid, lx, ly) {
  inkChip = { frameId: fid, lx, ly }; $('#ink-chip').hidden = false; positionPops();
}
function hideInkChip() { inkChip = null; $('#ink-chip').hidden = true; }
$('#ink-chip button').addEventListener('click', () => {
  if (!inkChip) return;
  const strokes = freshInk(inkChip.frameId), f = S.frames.find(x => x.id === inkChip.frameId);
  // anchor at the centre of the marks
  const xs = strokes.flatMap(s => s.points.filter((_, i) => i % 2 === 0)), ys = strokes.flatMap(s => s.points.filter((_, i) => i % 2 === 1));
  const lx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 - f.x : inkChip.lx, ly = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 - f.y : inkChip.ly;
  openComposer(inkChip.frameId, lx, ly);
});

// ---------- thread ----------
function openThread(id) {
  closeComposer(); hideInkChip();
  openThreadId = id; threadEl.hidden = false;
  renderThread(); renderAllPins(); positionPops();
}
function closeThread() {
  if (!openThreadId) return;
  openThreadId = null; threadEl.hidden = true; renderAllPins();
}
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(t).toLocaleDateString(); };
const CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.2 2.2L9.5 3.5"/></svg>';
function agentLine(c) {
  const owner = isOwner(), live = S.live[c.frameId];
  switch (c.status) {
    case 'waiting': return `<div class="agent-line waiting"><span class="a-ic"></span><div><div>Waiting for the host to send this to the agent.</div>${owner ? `<div class="a-actions"><button data-act="send" data-id="${c.id}">Send to agent</button></div>` : ''}</div></div>`;
    case 'queued': return `<div class="agent-line working"><span class="a-ic">${CHECK}</span><div><div class="a-text">${S.agent.mode === 'inbox' ? 'Queued for your agent — run loop inbox --wait' : 'Queued — waiting for the frame to be free'}</div>${owner ? `<div class="a-actions"><button class="quiet" data-act="cancel" data-id="${c.id}">Cancel</button></div>` : ''}</div></div>`;
    case 'working': return `<div class="agent-line working"><span class="a-ic">${CHECK}</span><div><div><span class="a-text" data-step-for="${c.id}">${esc(live?.commentId === c.id ? live.step : 'Working…')}</span> <span class="muted" data-elapsed-from="${live?.startedAt || c.createdAt}"></span></div>${owner ? `<div class="a-actions"><button class="quiet" data-act="cancel" data-id="${c.id}">Stop</button></div>` : ''}</div></div>`;
    case 'done': return `<div class="agent-line"><span class="a-ic">${CHECK}</span><div><div>${esc(c.undone ? 'Reverted.' : c.reply || 'Done.')}</div>${owner && c.snapshot && !c.undone ? `<div class="a-actions"><button class="quiet" data-act="undo" data-id="${c.id}">Undo change</button></div>` : ''}</div></div>`;
    case 'error': return `<div class="agent-line error"><span class="a-ic">${CHECK}</span><div><div>${esc(c.reply || 'Something went wrong.')}</div>${owner ? `<div class="a-actions"><button data-act="send" data-id="${c.id}">Retry</button></div>` : ''}</div></div>`;
    case 'canceled': return `<div class="agent-line waiting"><span class="a-ic"></span><div><div>Stopped.</div>${owner ? `<div class="a-actions"><button data-act="send" data-id="${c.id}">Send again</button></div>` : ''}</div></div>`;
    default: return '';
  }
}
function renderThread() {
  const root = S.comments.find(c => c.id === openThreadId);
  if (!root) return closeThread();
  const f = S.frames.find(x => x.id === root.frameId);
  const n = rootsOf(root.frameId).findIndex(c => c.id === root.id) + 1;
  const draftText = threadEl.querySelector('textarea')?.value || '';
  const hadFocus = document.activeElement === threadEl.querySelector('textarea');
  const body = threadOf(root.id).map(c => `
    <div class="msg">
      <div class="msg-head"><span class="av" style="background:${esc(c.author?.color || '#888')}">${esc(initials(c.author?.name))}</span><b>${esc(c.author?.name || 'You')}</b><time>${ago(c.createdAt)}</time></div>
      <div class="msg-text">${esc(c.text)}</div>
      ${c.ink?.length ? `<div class="muted" style="font-size:11.5px;margin-top:4px">✎ ${c.ink.length} marked element${c.ink.length === 1 ? '' : 's'}</div>` : ''}
      ${agentLine(c)}
    </div>`).join('');
  threadEl.innerHTML = `
    <div class="thread-head"><span class="t-title">#${n} · ${esc(f?.name || (root.frameId === CANVAS ? 'Canvas' : ''))}${root.anchor?.scope === 'frame' ? ' · whole frame' : ''}</span>
      <span class="t-actions">
        <button class="icon-btn" data-act="resolve" title="${root.resolved ? 'Reopen' : 'Resolve'}">${root.resolved ? '↺' : '✓'}</button>
        <button class="icon-btn" data-act="delete" title="Delete thread">⌫</button>
        <button class="icon-btn" data-act="close" title="Close">×</button>
      </span></div>
    <div class="thread-body">${body}</div>
    <div class="thread-reply"><textarea rows="1" placeholder="Reply — ↵ sends it to the agent"></textarea></div>`;
  const ta = threadEl.querySelector('textarea');
  ta.value = draftText; autosize(ta); if (hadFocus) ta.focus();
  ta.addEventListener('input', () => autosize(ta));
  ta.addEventListener('keydown', async e => {
    e.stopPropagation();
    if (e.key === 'Escape') return closeThread();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = ta.value.trim(); if (!text) return;
      ta.value = '';
      try { await api('POST', '/__loop/api/comments', { frameId: root.frameId, parentId: root.id, text, author: { name: me.name, color: me.color } }); }
      catch (err) { toast(err.message); }
    }
  });
  const tb = threadEl.querySelector('.thread-body'); tb.scrollTop = tb.scrollHeight;
}
threadEl.addEventListener('pointerdown', e => e.stopPropagation());
threadEl.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id || openThreadId;
  try {
    if (act === 'close') return closeThread();
    if (act === 'delete') { if (confirm('Delete this comment thread?')) { await api('DELETE', `/__loop/api/comments/${openThreadId}`); closeThread(); } return; }
    if (act === 'resolve') { await api('POST', `/__loop/api/comments/${openThreadId}/resolve`); return; }
    await api('POST', `/__loop/api/comments/${id}/${act}`);
    if (act === 'undo') toast('Change reverted');
  } catch (err) { toast(err.message); }
});
composer.addEventListener('pointerdown', e => e.stopPropagation());

// ---------- tools ----------
function setTool(t) {
  tool = t; vp.dataset.tool = t;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  hoverBox.hidden = true;
  if (t !== 'pen') hideInkChip();
  if (S) for (const f of S.frames) updateFrame(f);
}
document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
function selectFrame(id) { selected = id; if (S) for (const f of S.frames) updateFrame(f); }

// ---------- pointer ----------
let gesture = null;
vp.addEventListener('pointerdown', e => {
  if (!S || e.target.closest('.pin, .stop, .rename')) return;
  const frameEl = e.target.closest('.frame'), fid = frameEl?.dataset.id;
  if (e.button === 1 || tool === 'hand' || spaceHeld) return startPan(e);
  if (e.button !== 0) return;
  if (tool === 'pen') return startStroke(e);
  if (tool === 'erase') { gesture = { type: 'erase' }; eraseAt(e); vp.setPointerCapture(e.pointerId); return; }
  if (tool === 'comment') {
    if (fid && e.target.closest('.frame-body')) { const { lx, ly } = localFromClient(fid, e.clientX, e.clientY); openComposer(fid, lx, ly, e.altKey ? 'spot' : undefined); }
    else if (fid && e.target.closest('.frame-label')) openComposer(fid, 18, 18, 'frame');
    else if (!composer.hidden || openThreadId) { closeComposer(); closeThread(); }
    else { const w = toWorld(e.clientX, e.clientY); openComposer(CANVAS, w.x, w.y, 'canvas'); }
    return;
  }
  // select
  closeComposer();
  if (e.target.closest('.resize') && isOwner()) return startResize(fid, e);
  if (e.target.closest('.frame-label')) { selectFrame(fid); closeThread(); return isOwner() ? startMove(fid, e) : undefined; }
  if (fid) { selectFrame(fid); closeThread(); return; }
  selectFrame(null); closeThread();
  startPan(e);
});
function startPan(e) {
  gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function startMove(fid, e) {
  const f = S.frames.find(x => x.id === fid);
  gesture = { type: 'move', fid, sx: e.clientX, sy: e.clientY, fx: f.x, fy: f.y, moved: false };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function startResize(fid, e) {
  const f = S.frames.find(x => x.id === fid);
  gesture = { type: 'resize', fid, sx: e.clientX, sy: e.clientY, w: f.w, h: f.h };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function startStroke(e) {
  hideInkChip();
  const p = toWorld(e.clientX, e.clientY);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('stroke', MARK); path.setAttribute('stroke-width', 3 / view.z);
  inkSvg.appendChild(path);
  gesture = { type: 'stroke', points: [p.x, p.y], path, width: 3 / view.z };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function eraseAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (el?.tagName === 'path' && el.dataset.id) {
    el.remove(); api('DELETE', `/__loop/api/strokes/${el.dataset.id}`).catch(() => {});
  }
}
vp.addEventListener('pointermove', e => {
  sendPresence(e.clientX, e.clientY);
  if (!gesture) {
    if (tool === 'comment') {
      const fid = e.target.closest('.frame-body') && e.target.closest('.frame')?.dataset.id;
      const lfid = !fid && e.target.closest('.frame-label') && e.target.closest('.frame')?.dataset.id;
      if (fid) showHover(fid, e.clientX, e.clientY);
      else if (lfid) {
        const r = frameEls.get(lfid).iframe.getBoundingClientRect();
        Object.assign(hoverBox.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        hoverBox.dataset.tag = 'whole frame'; hoverBox.hidden = false;
      } else hoverBox.hidden = true;
    }
    return;
  }
  const g = gesture;
  if (g.type === 'pan') { view.x = g.vx + e.clientX - g.sx; view.y = g.vy + e.clientY - g.sy; applyView(); }
  else if (g.type === 'move') {
    g.moved = true;
    drag.set(g.fid, { x: g.fx + (e.clientX - g.sx) / view.z, y: g.fy + (e.clientY - g.sy) / view.z });
    updateFrame(S.frames.find(f => f.id === g.fid)); positionPops();
  } else if (g.type === 'resize') {
    drag.set(g.fid, { w: Math.max(240, g.w + (e.clientX - g.sx) / view.z), h: Math.max(160, g.h + (e.clientY - g.sy) / view.z) });
    updateFrame(S.frames.find(f => f.id === g.fid));
  } else if (g.type === 'stroke') {
    const p = toWorld(e.clientX, e.clientY), n = g.points.length;
    if (Math.hypot(p.x - g.points[n - 2], p.y - g.points[n - 1]) * view.z < 1.5) return;
    g.points.push(p.x, p.y); g.path.setAttribute('d', pathD(g.points));
  } else if (g.type === 'erase') eraseAt(e);
});
const endGesture = async e => {
  const g = gesture; if (!g) return;
  gesture = null; vp.classList.remove('dragging');
  if ((g.type === 'move' && g.moved) || g.type === 'resize') {
    const d = drag.get(g.fid);
    const f = S.frames.find(x => x.id === g.fid);
    if (d && f) Object.assign(f, d);
    drag.delete(g.fid);
    if (d) api('PATCH', `/__loop/api/frames/${g.fid}`, d).catch(err => toast(err.message));
    if (g.type === 'resize') setTimeout(() => positionPins(g.fid), 50);
  } else if (g.type === 'stroke') {
    const pts = g.points;
    if (pts.length < 4) pts.push(pts[0] + 0.5, pts[1] + 0.5);
    const counts = new Map();
    for (let i = 0; i < pts.length; i += 2) { const f = frameAt(pts[i], pts[i + 1]); if (f) counts.set(f.id, (counts.get(f.id) || 0) + 1); }
    const frameId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    try {
      const s = await api('POST', '/__loop/api/strokes', { points: pts, color: MARK, width: g.width, frameId });
      myStrokes.add(s.id);
      g.path.remove();
      if (!S.strokes.find(x => x.id === s.id)) S.strokes.push(s);
      renderInk();
      if (frameId) { const f = S.frames.find(x => x.id === frameId); showInkChip(frameId, pts[pts.length - 2] - f.x, pts[pts.length - 1] - f.y); }
    } catch (err) { g.path.remove(); toast(err.message); }
  }
};
vp.addEventListener('pointerup', endGesture);
vp.addEventListener('pointercancel', endGesture);
vp.addEventListener('pointerleave', () => { hoverBox.hidden = true; });

vp.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.012 : 0.005)));
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });
// Safari pinch
let gs0 = 1;
addEventListener('gesturestart', e => { e.preventDefault(); gs0 = view.z; });
addEventListener('gesturechange', e => { e.preventDefault(); zoomAt(e.clientX, e.clientY, (gs0 * e.scale) / view.z); });

// ---------- keyboard ----------
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };
addEventListener('keydown', e => {
  if (typing()) return;
  if (e.code === 'Space' && !spaceHeld) { spaceHeld = true; vp.classList.add('panning'); if (S) S.frames.forEach(updateFrame); e.preventDefault(); return; }
  if (e.metaKey || e.ctrlKey) {
    if (e.key === '0') { e.preventDefault(); view.z = 1; applyView(); }
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1.25); }
    if (e.key === '-') { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 0.8); }
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'v') setTool('select');
  else if (k === 'h') setTool('hand');
  else if (k === 'p') setTool('pen');
  else if (k === 'e') setTool('erase');
  else if (k === 'c') setTool('comment');
  else if (k === 'n' && isOwner()) openNewFrame();
  else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) fitAll();
  else if (e.key === '=' || e.key === '+') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  else if (e.key === 'Escape') { if (!composer.hidden) closeComposer(); else if (openThreadId) closeThread(); else if (!$('#agent-menu').hidden || !$('#share-menu').hidden) closeMenus(); else { selectFrame(null); setTool('select'); } }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && selected && isOwner()) {
    const f = S.frames.find(x => x.id === selected);
    if (f && confirm(`Remove “${f.name}” from the canvas? Its files stay on disk.`)) api('DELETE', `/__loop/api/frames/${f.id}`).then(() => { selected = null; });
  }
});
addEventListener('keyup', e => { if (e.code === 'Space') { spaceHeld = false; vp.classList.remove('panning'); if (S) S.frames.forEach(updateFrame); } });
addEventListener('blur', () => { if (spaceHeld) { spaceHeld = false; vp.classList.remove('panning'); } });

// ---------- zoom controls ----------
$('#zoom-in').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
$('#zoom-out').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
$('#zoom-level').onclick = () => fitAll();

// ---------- menus ----------
function closeMenus() { $('#agent-menu').hidden = true; $('#share-menu').hidden = true; }
function openMenuBelow(menu, btn) {
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.left = `${Math.max(12, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 12))}px`;
}
$('#agent-pill').addEventListener('click', e => {
  e.stopPropagation();
  if (!isOwner()) return;
  const m = $('#agent-menu'); const was = !m.hidden; closeMenus(); if (!was) openMenuBelow(m, e.currentTarget);
});
document.querySelectorAll('#agent-menu .menu-item').forEach(b => b.addEventListener('click', async () => {
  try { await api('POST', '/__loop/api/settings', { mode: b.dataset.mode }); toast(b.dataset.mode === 'inbox' ? 'Comments will queue for your agent session' : 'Loop will run Claude Code on each comment'); }
  catch (err) { toast(err.message); }
  closeMenus();
}));
function fillShare() {
  const s = S.share || {};
  $('#share-lan').value = s.lan || 'No network connection';
  $('#share-public-row').hidden = !s.public;
  $('#share-public').value = s.public || '';
  $('#share-public-btn').hidden = !!s.public;
  $('#share-public-btn').textContent = s.tunnelAvailable ? 'Create public link' : 'Create public link (needs cloudflared)';
}
$('#share-btn').addEventListener('click', async e => {
  e.stopPropagation();
  if (!isOwner()) { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast(location.href, 5000); } return; }
  const m = $('#share-menu'); const was = !m.hidden; closeMenus();
  if (!was) { fillShare(); $('#share-public-note').textContent = ''; openMenuBelow(m, e.currentTarget); refreshCloud(); }
});
$('#share-public-btn').addEventListener('click', async () => {
  const note = $('#share-public-note'), btn = $('#share-public-btn');
  btn.disabled = true; note.textContent = 'Opening a tunnel…';
  try { S.share = await api('POST', '/__loop/api/share/public'); note.textContent = 'Live while this Mac is awake and Loop is running.'; fillShare(); }
  catch (err) { note.textContent = err.message; }
  btn.disabled = false;
});
$('#share-rotate').addEventListener('click', async () => {
  if (!confirm('Reset share links? Anyone using the old links loses access.')) return;
  S.share = await api('POST', '/__loop/api/share/rotate'); fillShare(); toast('Links reset');
});
document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
  const v = $('#' + b.dataset.copy).value;
  try { await navigator.clipboard.writeText(v); toast('Link copied'); } catch { $('#' + b.dataset.copy).select(); }
}));
document.querySelectorAll('.menu').forEach(m => m.addEventListener('pointerdown', e => e.stopPropagation()));
addEventListener('pointerdown', e => { if (!e.target.closest('.menu, #agent-pill, #share-btn')) closeMenus(); });

// ---------- new frame ----------
let newSize = '1280x800';
function openNewFrame() {
  closeMenus(); $('#new-frame').hidden = false;
  const t = $('#new-frame-input'); t.value = ''; setTimeout(() => t.focus(), 0);
}
function closeNewFrame() { $('#new-frame').hidden = true; }
$('#new-frame-btn').addEventListener('click', openNewFrame);
$('#new-frame [data-close]').addEventListener('click', closeNewFrame);
$('#new-frame').addEventListener('pointerdown', e => { if (e.target.id === 'new-frame') closeNewFrame(); });
document.querySelectorAll('#size-pick button').forEach(b => b.addEventListener('click', () => {
  newSize = b.dataset.size; document.querySelectorAll('#size-pick button').forEach(x => x.classList.toggle('on', x === b));
}));
$('#new-frame-input').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') closeNewFrame();
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); createFrame(); }
});
$('#new-frame-go').addEventListener('click', createFrame);
async function createFrame() {
  const v = $('#new-frame-input').value.trim(); if (!v) return;
  const [w, h] = newSize.split('x').map(Number);
  const isSrc = /^(https?:\/\/|\/|~\/|\.\.?\/)/.test(v) && !/\s/.test(v);
  try {
    const f = await api('POST', '/__loop/api/frames', isSrc ? { src: v, w, h } : { prompt: v, w, h });
    closeNewFrame();
    setTimeout(() => { selectFrame(null); fitAll(true, [f.id]); }, 80);
  } catch (err) { toast(err.message, 4000); }
}

// ---------- guest name ----------
$('#name-go').addEventListener('click', saveName);
$('#name-input').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') saveName(); });
function saveName() {
  const v = $('#name-input').value.trim(); if (!v) return;
  me.name = v; store.set('loop.me', me); $('#name-modal').hidden = true; renderPresence();
}

// ---------- invite people (host ↔ Loop cloud) ----------
let cloud = null;           // last /api/cloud status
let sbClient = null;
async function supa(cfg) {
  if (sbClient) return sbClient;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
  sbClient = createClient(cfg.url, cfg.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, storageKey: 'loop-host-auth' } });
  return sbClient;
}
async function refreshCloud() {
  if (ADAPTER || !isOwner()) return;
  try { cloud = await api('GET', '/__loop/api/cloud'); } catch (e) { $('#invite-note').textContent = e.message; return; }
  renderCloud();
}
function avatarHtml(name, url) {
  return url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : esc(initials(name));
}
function renderCloud() {
  const signed = !!cloud?.user;
  $('#invite-signin').hidden = signed;
  $('#invite-form').hidden = !signed;
  if (!signed) return;
  $('#me-avatar').innerHTML = avatarHtml(cloud.user.name, cloud.user.avatar);
  $('#me-email').textContent = cloud.user.email;
  $('#cloud-link').value = cloud.link || '';
  if (cloud.error && !$('#invite-note').textContent) $('#invite-note').textContent = cloud.error;
  $('#members').innerHTML = (cloud.members || []).map(m => `
    <div class="member"><span class="m-av">${avatarHtml(m.name || m.email, m.avatar_url)}</span>
      <span class="m-text"><div class="m-name">${esc(m.name || m.email)}</div><div class="m-sub">${m.name ? esc(m.email) + ' · ' : ''}${m.joined_at ? 'Joined' : 'Invited'}${m.role === 'viewer' ? ' · can view' : ''}</div></span>
      <button class="m-x" title="Remove" data-email="${esc(m.email)}">×</button></div>`).join('');
}
$('#members').addEventListener('click', async e => {
  const b = e.target.closest('[data-email]'); if (!b) return;
  if (!confirm(`Remove ${b.dataset.email} from this canvas?`)) return;
  try { await api('DELETE', `/__loop/api/cloud/members/${encodeURIComponent(b.dataset.email)}`); refreshCloud(); } catch (err) { toast(err.message); }
});
$('#cloud-google').addEventListener('click', async () => {
  try {
    const c = cloud || await api('GET', '/__loop/api/cloud');
    const st = await fetch(`${c.config.url}/auth/v1/settings`, { headers: { apikey: c.config.key } }).then(r => r.json()).catch(() => ({ external: { google: true } }));
    if (!st.external?.google) { $('#invite-note').textContent = ''; toast('Google sign-in isn’t switched on yet. Enable the Google provider in Supabase (Authentication → Sign In / Providers).', 7000); return; }
    const sb = await supa(c.config);
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}/__loop/?loop_auth=1` } });
    if (error) throw error;
  } catch (e) { toast(e.message || 'Google sign-in is not available', 5000); }
});
$('#cloud-signout').addEventListener('click', async () => { await api('POST', '/__loop/api/cloud/signout'); cloud = null; refreshCloud(); });

// Coming back from Google: hand the session to the local server, then forget it in the browser
// (the server keeps it refreshed; two holders would fight over the refresh token).
async function finishHostSignIn() {
  if (ADAPTER || !new URLSearchParams(location.search).has('loop_auth')) return;
  try {
    const c = await api('GET', '/__loop/api/cloud');
    const sb = await supa(c.config);
    let { data } = await sb.auth.getSession();
    for (let i = 0; !data.session && i < 20; i++) { await new Promise(r => setTimeout(r, 150)); ({ data } = await sb.auth.getSession()); }
    if (!data.session) throw new Error('Google sign-in did not complete');
    sb.auth.stopAutoRefresh();
    const { user } = await api('POST', '/__loop/api/cloud/session', { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at });
    try { localStorage.removeItem('loop-host-auth'); } catch {}
    toast(`Signed in as ${user.email}`);
    setTimeout(() => $('#share-btn').click(), 300);
  } catch (e) { toast(e.message, 5000); }
  history.replaceState(null, '', '/__loop/');
}

// Live app screens are uploaded as static copies captured from the rendered page
async function snapshot(fid) {
  const doc = frameDoc(fid); if (!doc?.documentElement) throw new Error('screen not loaded yet');
  const html = '<!doctype html>\n' + doc.documentElement.outerHTML;
  return api('POST', '/__loop/api/cloud/snapshot', { frameId: fid, html });
}
async function publishAll(note) {
  await api('POST', '/__loop/api/cloud/publish');
  const routes = S.frames.filter(f => f.kind === 'route');
  let i = 0;
  for (const f of routes) {
    note.textContent = `Uploading screens… ${++i}/${routes.length}`;
    try { await snapshot(f.id); } catch (e) { console.warn('snapshot', f.name, e); }
  }
}
function resnapshotLater(fid) {
  const f = S?.frames.find(x => x.id === fid);
  if (ADAPTER || !f || f.kind !== 'route' || !cloud?.canvasId || !cloud?.user) return;
  setTimeout(() => snapshot(fid).catch(() => {}), 2500); // after the reload / hot update settles
}
$('#invite-go').addEventListener('click', sendInvites);
$('#invite-emails').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') sendInvites(); });
async function sendInvites() {
  const emails = $('#invite-emails').value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const note = $('#invite-note'), btn = $('#invite-go');
  if (!emails.length) { note.textContent = 'Add one or more email addresses.'; return; }
  btn.disabled = true;
  try {
    await publishAll(note);
    note.textContent = 'Sending invites…';
    const r = await api('POST', '/__loop/api/cloud/invite', { emails });
    $('#invite-emails').value = '';
    note.textContent = r.warning ? r.warning : r.failed?.length ? `Invited, but email failed for ${r.failed.map(f => f.email).join(', ')} — share the link with them.` : `Invite${r.emailed.length === 1 ? '' : 's'} sent to ${r.emailed.join(', ')}.`;
    await refreshCloud();
  } catch (e) { note.textContent = e.message; }
  btn.disabled = false;
}

addEventListener('resize', () => positionPops());
finishHostSignIn();
setTool('select');
applyView();
connect();
