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
let draft = null;
let pendingSelect = null;   // select this frame as soon as it arrives
let pendingPrompt = null;   // …and open the "what should this screen be?" box (new blank frames only)              // { frameId, anchor, ink, inkStrokes }
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
  view.z = z; scheduleView();
}
// batch view updates to one per animation frame (trackpads fire many wheel events per frame)
let viewQueued = false;
function scheduleView() {
  if (viewQueued) return;
  viewQueued = true;
  requestAnimationFrame(() => { viewQueued = false; applyView(); });
}
// pinch (ctrl/⌘ + wheel) → canvas zoom around the cursor; cx/cy are top-window coordinates
function pinchZoom(e, cx, cy) {
  e.preventDefault();
  const dy = Math.max(-30, Math.min(30, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY)); // cap per-event so a mouse wheel notch zooms smoothly
  zoomAt(cx, cy, Math.exp(-dy * (e.ctrlKey && !e.metaKey ? 0.01 : 0.004)));
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
  if (!$('#canvas-name').querySelector('input')) $('#canvas-name').textContent = S.name;
  $('#canvas-name').classList.toggle('editable', isOwner() && !ADAPTER);
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
  if (draft && draft.frameId !== CANVAS && !ids.has(draft.frameId)) closeComposer();
  renderPanel();
}

function frameView(f) { return { ...f, ...(drag.get(f.id) || {}) }; }

function makeFrame(f) {
  const el = document.createElement('div');
  el.className = 'frame'; el.dataset.id = f.id;
  el.innerHTML = `
    <div class="frame-label">
      <span class="spinner"></span><span class="name"></span><span class="dims"></span><span class="kind" hidden></span><span class="count"></span>
      <span class="step"></span><span class="elapsed"></span><span class="updated"></span>
      <button class="stop" title="Stop the agent">Stop</button>
    </div>
    <div class="frame-body"><iframe title="${esc(f.name)}"></iframe><div class="empty-hint"><b>✦ Describe this screen</b><span>Click to tell the agent what goes here</span></div><div class="shield"></div><div class="areas"></div><div class="progress"></div></div><div class="pins"></div>
    <div class="resize"></div>`;
  framesEl.appendChild(el);
  const fe = { el, iframe: el.querySelector('iframe'), label: el.querySelector('.frame-label'), name: el.querySelector('.name'), dims: el.querySelector('.dims'), kind: el.querySelector('.kind'), count: el.querySelector('.count'), step: el.querySelector('.step'), elapsed: el.querySelector('.elapsed'), updated: el.querySelector('.updated'), pins: el.querySelector('.pins'), restore: null };
  fe.iframe.addEventListener('load', () => {
    try {
      const w = fe.iframe.contentWindow;
      if (fe.restore) { w.scrollTo(fe.restore.sx, fe.restore.sy); fe.restore = null; }
      fe.el.classList.toggle('empty', !!w.document.querySelector('meta[name="loop-empty"]'));
      w.addEventListener('scroll', () => positionPins(f.id), { passive: true });
      w.addEventListener('resize', () => positionPins(f.id));
      // a pinch over a live frame zooms the canvas, not the frame's page
      const toTop = ev => { const r = fe.iframe.getBoundingClientRect(), z = r.width / (fe.iframe.offsetWidth || 1); return [r.left + ev.clientX * z, r.top + ev.clientY * z]; };
      w.addEventListener('wheel', ev => { if (ev.ctrlKey || ev.metaKey) pinchZoom(ev, ...toTop(ev)); }, { passive: false });
      w.addEventListener('gesturestart', ev => { ev.preventDefault(); gs0 = view.z; });
      w.addEventListener('gesturechange', ev => { ev.preventDefault(); const [x, y] = toTop(ev); zoomAt(x, y, (gs0 * ev.scale) / view.z); });
      // pass shortcuts through when the frame has focus
      w.addEventListener('keydown', e => {
        if (e.key === 'Escape') { selectFrame(null); window.focus(); }
        const t = e.target, editing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if ((e.metaKey || e.ctrlKey) && !editing && (e.key.toLowerCase() === 'z' || (e.ctrlKey && e.key.toLowerCase() === 'y'))) {
          e.preventDefault(); (e.shiftKey || e.key.toLowerCase() === 'y') ? redo() : undo();
        }
      });
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
  fe.dims.textContent = `${Math.round(f.w)} × ${Math.round(f.h)}`;
  if (pendingSelect === f.id) { const ask = pendingPrompt === f.id; pendingSelect = pendingPrompt = null; queueMicrotask(() => { selectFrame(f.id); revealFrame(f.id); if (ask) setTimeout(() => openPrompt(f.id), 340); }); }
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
    if (save && v && v !== f.name) { const old = f.name; api('PATCH', `/__loop/api/frames/${id}`, { name: v }); record('Rename frame', () => patchFrame(id, { name: old }), () => patchFrame(id, { name: v })); }
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

// ---------- agent pill & presence ----------
function renderAgentPill() {
  const pill = $('#agent-pill'), n = Object.keys(S.live).length;
  const queued = S.comments.filter(c => c.status === 'queued').length;
  const waiting = S.comments.filter(c => c.status === 'waiting').length;
  const lastFits = S.agent.lastModel && (S.agentBin === 'codex' ? !/^claude/.test(S.agent.lastModel) : /^claude/.test(S.agent.lastModel));
  const name = S.agent.mode === 'inbox' ? (S.chatListening ? `Your chat · ${S.agentLabel || 'agent'}` : 'Chat away · background') : (S.agentLabel || 'Claude Code') + (lastFits ? ` · ${prettyModel(S.agent.lastModel)}` : '');
  let label = name;
  if (S.hostOnline === false) label = `Host offline · comments wait`;
  if (n) label += ` · ${n} working`;
  else if (queued) label += ` · ${queued} queued`;
  if (waiting && isOwner()) label += ` · ${waiting} to review`;
  $('#agent-label').textContent = label;
  pill.classList.toggle('busy', n > 0);
  pill.classList.toggle('inbox', S.agent.mode === 'inbox' && !n && !S.chatListening);
  document.querySelectorAll('#agent-menu .menu-item').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === S.agent.mode && (!b.dataset.runner || b.dataset.runner === S.agentBin));
    if (b.dataset.runner) { b.hidden = S.runners && !S.runners[b.dataset.runner]; }
  });
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
  if (a.scope === 'frame' || a.scope === 'point' || a.scope === 'area') {
    let dx = 0, dy = 0; try { const w = frameDoc(fid).defaultView; dx = w.scrollX - (a.sx || 0); dy = w.scrollY - (a.sy || 0); } catch {}
    return { x: a.x - (a.scope !== 'frame' ? dx : 0), y: a.y - (a.scope !== 'frame' ? dy : 0) };
  }
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
  const t = threadOf(rootId).filter(c => c.kind !== 'note');
  if (t.some(c => c.status === 'working')) return 'working';
  return t[t.length - 1]?.status || 'done';
}
function rootsOf(fid) { return S.comments.filter(c => c.frameId === fid && !c.parentId && c.kind !== 'create').sort((a, b) => a.createdAt - b.createdAt); }
function renderAllPins() { for (const f of S.frames) renderPins(f.id); renderPins(CANVAS); }
function pinsBox(fid) { return fid === CANVAS ? $('#canvas-pins') : frameEls.get(fid)?.pins; }
function areasBox(fid) { return fid === CANVAS ? $('#canvas-pins') : frameEls.get(fid)?.el.querySelector('.areas'); }
function renderPins(fid) {
  const box = pinsBox(fid); if (!box) return;
  const fe = { pins: box };
  const roots = rootsOf(fid);
  const want = roots.map((c, i) => ({ key: c.id, n: i + 1, c }));
  if (draft?.frameId === fid && !draft.prompt) want.push({ key: '__draft', n: roots.length + 1, draft: true });
  const keys = new Set(want.map(w => w.key));
  fe.pins.querySelectorAll('.pin').forEach(p => { if (!keys.has(p.dataset.key)) p.remove(); });
  for (const w of want) {
    let p = fe.pins.querySelector(`.pin[data-key="${w.key}"]`);
    if (!p) {
      p = document.createElement('div'); p.className = 'pin'; p.dataset.key = w.key;
      p.innerHTML = `<div class="pin-dot"></div>`;
      p.addEventListener('pointerdown', e => e.stopPropagation());
      if (!w.draft) p.addEventListener('click', e => { e.stopPropagation(); openThread(w.key); });
      p.addEventListener('pointerenter', () => areasBox(fid)?.querySelector(`.area[data-key="${w.key}"]`)?.classList.add('hover'));
      p.addEventListener('pointerleave', () => areasBox(fid)?.querySelector(`.area[data-key="${w.key}"]`)?.classList.remove('hover'));
      fe.pins.appendChild(p);
    }
    p.querySelector('.pin-dot').textContent = w.n;
    const st = w.draft ? 'draft' : threadStatus(w.key);
    p.className = `pin ${st}${w.c?.resolved ? ' resolved' : ''}${(openThreadId === w.key || w.draft) ? ' active' : ''}`;
  }
  // highlighted areas (below the pins); visible while composing, on pin hover, and while the thread is open
  const areas = want.filter(w => (w.draft ? draft?.area : w.c?.anchor?.scope === 'area' || w.c?.anchor?.area));
  const akeys = new Set(areas.map(w => w.key));
  const abox = areasBox(fid);
  abox.querySelectorAll('.area:not(.picking)').forEach(a => { if (!akeys.has(a.dataset.key)) a.remove(); });
  for (const w of areas) {
    let a = abox.querySelector(`.area[data-key="${w.key}"]`);
    if (!a) { a = document.createElement('div'); a.dataset.key = w.key; abox.prepend(a); }
    a.className = `area${w.draft ? ' draft show' : ''}${openThreadId === w.key ? ' show' : ''}`;
  }
  positionPins(fid);
}
function positionPins(fid) {
  const box = pinsBox(fid); if (!box || !S) return;
  areasBox(fid)?.querySelectorAll('.area[data-key]').forEach(el => {
    const a = el.dataset.key === '__draft' ? draft?.anchor : S.comments.find(c => c.id === el.dataset.key)?.anchor;
    if (!a) return;
    const { x, y } = anchorPos(fid, a);
    const w = a.area ? a.area.w : a.w, h = a.area ? a.area.h : a.h;
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  });
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
  if (draft?.prompt && !composer.hidden) {
    const f = frameView(S.frames.find(x => x.id === draft.frameId));
    if (f) {
      const cw = composer.offsetWidth || 380, ch = composer.offsetHeight || 200;
      const cx = view.x + (f.x + f.w / 2) * view.z, cy = view.y + (f.y + f.h / 2) * view.z;
      // a small frame stays visible: put the prompt beside it instead of on top
      if (f.w * view.z < cw + 40) placePop(composer, view.x + (f.x + f.w) * view.z, cy - ch / 2 + 18);
      else {
        composer.style.left = `${Math.max(12, Math.min(cx - cw / 2, innerWidth - cw - 12))}px`;
        composer.style.top = `${Math.max(60, Math.min(cy - ch / 2, innerHeight - ch - 76))}px`;
      }
    }
  } else if (draft && !composer.hidden) { const p = anchorPos(draft.frameId, draft.anchor); const s = screenOf(draft.frameId, p.x, p.y); placePop(composer, s.x, s.y); }
  if (openThreadId && !threadEl.hidden) {
    const c = S.comments.find(x => x.id === openThreadId);
    if (c?.anchor) { const p = anchorPos(c.frameId, c.anchor); const s = screenOf(c.frameId, p.x, p.y); placePop(threadEl, s.x, s.y); }
  }
  if (inkChip) { const s = screenOf(inkChip.frameId, inkChip.lx, inkChip.ly); const ch = $('#ink-chip'); ch.style.left = `${s.x + 10}px`; ch.style.top = `${s.y + 10}px`; }
}

// ---------- composer ----------
function freshInk(fid) { return S.strokes.filter(s => s.frameId === fid && !s.commentId && myStrokes.has(s.id)); }
// scope: 'element' (what you clicked), 'spot' (just that point), 'frame' (the whole frame), 'canvas' (empty canvas)
function openComposer(fid, lx, ly, scope, area) {
  closeThread(); hideInkChip();
  composer.classList.remove('prompt');
  const picked = fid === CANVAS ? null : area ? anchorFor(fid, area.x + area.w / 2, area.y + area.h / 2) : anchorFor(fid, lx, ly);
  const strokes = freshInk(fid);
  draft = { frameId: fid, picked, lx, ly, area: area || null, inkStrokes: strokes.map(s => s.id) };
  setScope(fid === CANVAS ? 'canvas' : area ? 'area' : 'point');
  const ac = $('#composer-area');
  ac.hidden = !area;
  if (area) ac.textContent = fid === CANVAS ? `Area · ${draft.anchor.near.length || 'no'} frame${draft.anchor.near.length === 1 ? '' : 's'}` : `Area · ${draft.anchor.elements.length} element${draft.anchor.elements.length === 1 ? '' : 's'}`;
  const chip = $('#composer-ink');
  chip.hidden = !strokes.length; chip.textContent = `${strokes.length} mark${strokes.length === 1 ? '' : 's'} attached`;
  composerInput.placeholder = isOwner()
    ? (S.agent.mode === 'inbox' ? 'Comment, then ↵ to queue it for your agent' : `Comment, then ↵ to send to ${S.agentLabel || 'the agent'}`)
    : 'Comment, then ↵ — the host sends it to the agent';
  composer.hidden = false; composerInput.value = ''; autosize(composerInput);
  renderPins(fid); positionPops();
  setTimeout(() => composerInput.focus(), 0);
}
function nearFrames(wx, wy) {
  return S.frames.map(f => ({ f, d: Math.hypot(Math.max(f.x - wx, 0, wx - f.x - f.w), Math.max(f.y - wy, 0, wy - f.y - f.h)) }))
    .sort((a, b) => a.d - b.d).slice(0, 2).filter(x => x.d < 1200).map(x => x.f.name);
}
// frames a canvas-level box touches
function framesIn(r) {
  const hit = S.frames.filter(f => f.x < r.x + r.w && f.x + f.w > r.x && f.y < r.y + r.h && f.y + f.h > r.y).map(f => f.name);
  return hit.length ? hit : nearFrames(r.x + r.w / 2, r.y + r.h / 2);
}
// elements inside a frame-local box, with a little slack so a loose drag still counts; top-most only
function areaElements(fid, r) {
  const doc = frameDoc(fid); if (!doc?.body) return [];
  const pad = Math.max(12, Math.min(r.w, r.h) * 0.08);
  const L = r.x - pad, T = r.y - pad, R = r.x + r.w + pad, B = r.y + r.h + pad;
  const inside = [];
  for (const el of doc.body.querySelectorAll('*')) {
    if (inside.length > 600) break;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height || ['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName)) continue;
    if (b.left >= L && b.top >= T && b.right <= R && b.bottom <= B) inside.push(el);
  }
  const set = new Set(inside);
  let top = inside.filter(el => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
  if (!top.length) { const c = elementAt(fid, r.x + r.w / 2, r.y + r.h / 2); if (c && c !== doc.documentElement) top = [c]; }
  return top.slice(0, 14).map(el => ({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 80) }));
}
// the smallest element that wraps the whole box (context for the agent)
function areaContainer(fid, r) {
  const doc = frameDoc(fid);
  let el = elementAt(fid, r.x + r.w / 2, r.y + r.h / 2);
  while (el && el !== doc?.body) {
    const b = el.getBoundingClientRect();
    if (b.left <= r.x + 2 && b.top <= r.y + 2 && b.right >= r.x + r.w - 2 && b.bottom >= r.y + r.h - 2) break;
    el = el.parentElement;
  }
  return el && el !== doc?.documentElement ? { selector: selectorFor(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) } : null;
}
function setScope(scope) {
  const d = draft; if (!d) return;
  const f = S.frames.find(x => x.id === d.frameId);
  d.scope = scope;
  if (scope === 'canvas' && d.area) d.anchor = { scope, wx: d.area.x, wy: d.area.y, area: { w: d.area.w, h: d.area.h }, near: framesIn(d.area) };
  else if (scope === 'canvas') d.anchor = { scope, wx: d.lx, wy: d.ly, near: nearFrames(d.lx, d.ly) };
  else if (scope === 'area') d.anchor = { scope, x: d.area.x, y: d.area.y, w: d.area.w, h: d.area.h, sx: d.picked?.sx || 0, sy: d.picked?.sy || 0,
    elements: areaElements(d.frameId, d.area), container: areaContainer(d.frameId, d.area) };
  else d.anchor = { ...(d.picked || {}), scope: 'point', x: d.lx, y: d.ly, fx: undefined, fy: undefined }; // pin stays where you clicked
  renderPins(d.frameId); positionPops();
}
// Empty frame → a prompt box centred on it: "What should this screen be?" with ideas for its size
const IDEAS = {
  Mobile: ['Login', 'Onboarding', 'Home feed', 'Profile', 'Settings', 'Checkout'],
  Tablet: ['Dashboard', 'Reader', 'Calendar', 'Settings', 'Kanban board'],
  Desktop: ['Landing page', 'Dashboard', 'Pricing', 'Sign up', 'Settings', 'Blog post'],
};
function openPrompt(fid) {
  const f = S?.frames.find(x => x.id === fid); if (!f) return;
  closeThread(); hideInkChip();
  const device = f.w <= 480 ? 'Mobile' : f.w <= 1024 ? 'Tablet' : 'Desktop';
  draft = { frameId: fid, picked: null, lx: 24, ly: 24, area: null, inkStrokes: [], prompt: true, scope: 'frame', anchor: { scope: 'frame', x: 24, y: 24 } };
  composer.classList.add('prompt');
  $('#prompt-title').textContent = `What should “${f.name}” be?`;
  $('#prompt-ideas').innerHTML = IDEAS[device].map(i => `<button>${esc(i)}</button>`).join('');
  $('#composer-area').hidden = true; $('#composer-ink').hidden = true;
  composerInput.placeholder = device === 'Mobile' ? 'e.g. a login screen with Google sign-in and a friendly illustration' : 'e.g. a landing page for a habit tracker with pricing and testimonials';
  composer.hidden = false; composerInput.value = ''; autosize(composerInput);
  positionPops();
  setTimeout(() => composerInput.focus(), 0);
}
$('#prompt-ideas').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  composerInput.value = `${b.textContent} screen — `; autosize(composerInput);
  composerInput.focus(); composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
});
function closeComposer() {
  composer.classList.remove('prompt');
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
// "claude-opus-5-5" → "Opus 5.5"
function prettyModel(id) {
  if (!id) return '';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length <= 2 ? '.' + m[3] : ''}`;
  const g = /^gpt-([\d.]+)(?:-([a-z]+))?/i.exec(id); // "gpt-6.1-sol" → "GPT-6.1 Sol"
  if (g) return `GPT-${g[1]}${g[2] ? ' ' + g[2][0].toUpperCase() + g[2].slice(1) : ''}`;
  return id;
}
function runMeta(c) {
  const bits = [];
  if (c.model) bits.push(prettyModel(c.model));
  if (c.startedAt && c.finishedAt) { const s = Math.round((c.finishedAt - c.startedAt) / 1000); bits.push(s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`); }
  return bits.length ? `<div class="a-meta">${esc(bits.join(' · '))}</div>` : '';
}
const CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.5l2.2 2.2L9.5 3.5"/></svg>';
function agentLine(c) {
  const owner = isOwner(), live = S.live[c.frameId];
  switch (c.status) {
    case 'waiting': return `<div class="agent-line waiting"><span class="a-ic"></span><div><div>Waiting for the host to send this to the agent.</div>${owner ? `<div class="a-actions"><button data-act="send" data-id="${c.id}">Send to agent</button></div>` : ''}</div></div>`;
    case 'queued': return `<div class="agent-line working"><span class="a-ic">${CHECK}</span><div><div class="a-text">${S.agent.mode === 'inbox' ? 'Queued for your agent — run loop inbox --wait' : 'Queued — waiting for the frame to be free'}</div>${owner ? `<div class="a-actions"><button class="quiet" data-act="cancel" data-id="${c.id}">Cancel</button></div>` : ''}</div></div>`;
    case 'working': return `<div class="agent-line working"><span class="a-ic">${CHECK}</span><div><div>${c.model ? `<span class="a-model">${esc(prettyModel(c.model))}</span> ` : ''}<span class="a-text" data-step-for="${c.id}">${esc(live?.commentId === c.id ? live.step : 'Working…')}</span> <span class="muted" data-elapsed-from="${live?.startedAt || c.createdAt}"></span></div>${owner ? `<div class="a-actions"><button class="quiet" data-act="cancel" data-id="${c.id}">Stop</button></div>` : ''}</div></div>`;
    case 'done': return `<div class="agent-line"><span class="a-ic">${CHECK}</span><div><div>${esc(c.undone ? 'Reverted.' : c.reply || 'Done.')}</div>${runMeta(c)}${owner && c.snapshot && !c.undone ? `<div class="a-actions"><button class="quiet" data-act="undo" data-id="${c.id}">Undo change</button></div>` : ''}${owner && c.undone && c.redoSnap ? `<div class="a-actions"><button class="quiet" data-act="redo" data-id="${c.id}">Redo change</button></div>` : ''}</div></div>`;
    case 'error': return `<div class="agent-line error"><span class="a-ic">${CHECK}</span><div><div>${esc(c.reply || 'Something went wrong.')}</div>${runMeta(c)}${owner ? `<div class="a-actions"><button data-act="send" data-id="${c.id}">Retry</button></div>` : ''}</div></div>`;
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
  const body = threadOf(root.id).map(c => c.kind === 'note' ? `
    <div class="msg msg-agent">
      <div class="msg-head"><span class="av av-agent">${CHECK}</span><b>${esc(c.author?.name || 'Agent')}</b><time>${ago(c.createdAt)}</time>${c.model ? `<span class="a-model">${esc(prettyModel(c.model))}</span>` : ''}</div>
      <div class="msg-text">${esc(c.text)}</div>
    </div>` : `
    <div class="msg">
      <div class="msg-head"><span class="av" style="background:${esc(c.author?.color || '#888')}">${esc(initials(c.author?.name))}</span><b>${esc(c.author?.name || 'You')}</b><time>${ago(c.createdAt)}</time></div>
      <div class="msg-text">${esc(c.text)}</div>
      ${c.ink?.length ? `<div class="muted" style="font-size:11.5px;margin-top:4px">✎ ${c.ink.length} marked element${c.ink.length === 1 ? '' : 's'}</div>` : ''}
      ${agentLine(c)}
    </div>`).join('');
  threadEl.innerHTML = `
    <div class="thread-head"><span class="t-title">#${n} · ${esc(f?.name || (root.frameId === CANVAS ? 'Canvas' : ''))}</span>
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
    if (act === 'undo') {
      let r = await fetch(`/__loop/api/comments/${id}/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      let j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.error === 'newer') {
        if (!confirm(`This frame has ${j.newer} newer change${j.newer === 1 ? '' : 's'} after this one. Undoing this reverts ${j.newer === 1 ? 'it' : 'them'} too. Continue?`)) return;
        r = await fetch(`/__loop/api/comments/${id}/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
        j = await r.json().catch(() => ({}));
      }
      if (!r.ok) throw new Error(j.error || 'Could not undo');
      toast(j.reverted > 1 ? `Reverted ${j.reverted} changes` : 'Change reverted');
      return;
    }
    await api('POST', `/__loop/api/comments/${id}/${act}`);
    if (act === 'redo') toast('Change re-applied');
  } catch (err) { toast(err.message); }
});
composer.addEventListener('pointerdown', e => e.stopPropagation());

// ---------- tools ----------
function setTool(t) {
  if (t === 'frame' && !isOwner()) return;
  tool = t; vp.dataset.tool = t;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  hoverBox.hidden = true;
  if (t !== 'pen') hideInkChip();
  if (S) for (const f of S.frames) updateFrame(f);
  renderPanel();
}
document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
function selectFrame(id) { selected = id; if (S) for (const f of S.frames) updateFrame(f); renderPanel(); }

// ---------- pointer ----------
let gesture = null;
vp.addEventListener('pointerdown', e => {
  if (!S || e.target.closest('.pin, .stop, .rename')) return;
  const frameEl = e.target.closest('.frame'), fid = frameEl?.dataset.id;
  if (e.button === 1 || tool === 'hand' || spaceHeld) return startPan(e);
  if (e.button !== 0) return;
  if (tool === 'pen') return startStroke(e);
  if (tool === 'frame') return startDraw(e);
  if (tool === 'erase') { gesture = { type: 'erase' }; eraseAt(e); vp.setPointerCapture(e.pointerId); return; }
  if (tool === 'comment') {
    const onFrame = fid && e.target.closest('.frame-body');
    if (!onFrame && (!composer.hidden || openThreadId)) { closeComposer(); closeThread(); return; }
    // click = a pin on that spot; click-and-drag = an area the comment is about
    gesture = { type: 'cpick', fid: onFrame ? fid : CANVAS, sx: e.clientX, sy: e.clientY, area: false, rect: null };
    vp.setPointerCapture(e.pointerId);
    return;
  }
  // select
  closeComposer();
  if (e.target.closest('.resize') && isOwner()) return startResize(fid, e);
  if (e.target.closest('.frame-label')) { selectFrame(fid); closeThread(); return isOwner() ? startMove(fid, e) : undefined; }
  if (fid) { selectFrame(fid); closeThread(); if (frameEls.get(fid)?.el.classList.contains('empty')) openPrompt(fid); return; }
  selectFrame(null); closeThread();
  startPan(e);
});
function startPan(e) {
  gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function startMove(fid, e) {
  const f = S.frames.find(x => x.id === fid);
  gesture = { type: 'move', fid, sx: e.clientX, sy: e.clientY, fx: f.x, fy: f.y, moved: false, dup: e.altKey };
  vp.classList.add('dragging'); vp.setPointerCapture(e.pointerId);
}
function startDraw(e) {
  const p = toWorld(e.clientX, e.clientY);
  gesture = { type: 'draw', x0: p.x, y0: p.y, rect: null };
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
// the eraser is a round brush: anything within its radius (11px on screen) is erased as you sweep
const ERASE_R = 11;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function eraseAt(e) {
  const p = toWorld(e.clientX, e.clientY);
  for (const stroke of [...S.strokes]) {
    if (stroke.commentId || String(stroke.id).startsWith('ink-')) continue; // marks attached to a comment stay
    const r = ERASE_R / view.z + (stroke.width || 3) / 2, pts = stroke.points;
    let hit = false;
    for (let i = 0; i + 1 < pts.length && !hit; i += 2) {
      const bx = i + 3 < pts.length ? pts[i + 2] : pts[i], by = i + 3 < pts.length ? pts[i + 3] : pts[i + 1];
      hit = segDist(p.x, p.y, pts[i], pts[i + 1], bx, by) <= r;
    }
    if (!hit) continue;
    S.strokes = S.strokes.filter(s => s.id !== stroke.id);
    inkSvg.querySelector(`path[data-id="${stroke.id}"]`)?.remove();
    api('DELETE', `/__loop/api/strokes/${stroke.id}`).catch(() => {});
    record('Erase mark', () => restore({ strokes: [stroke] }), () => api('DELETE', `/__loop/api/strokes/${stroke.id}`));
  }
}
vp.addEventListener('pointermove', e => {
  sendPresence(e.clientX, e.clientY);
  if (!gesture) {
    if (tool === 'comment') {
      const fid = e.target.closest('.frame-body') && e.target.closest('.frame')?.dataset.id;
      const lfid = !fid && e.target.closest('.frame-label') && e.target.closest('.frame')?.dataset.id;
      hoverBox.hidden = true;
    }
    return;
  }
  const g = gesture;
  if (g.type === 'pan') { view.x = g.vx + e.clientX - g.sx; view.y = g.vy + e.clientY - g.sy; applyView(); }
  else if (g.type === 'move' && g.dup) {
    // ⌥/Alt-drag: the original stays; an outline of the copy follows the pointer
    g.moved = true;
    const f = S.frames.find(x => x.id === g.fid);
    g.to = { x: g.fx + (e.clientX - g.sx) / view.z, y: g.fy + (e.clientY - g.sy) / view.z };
    const ghost = $('#dup-ghost');
    Object.assign(ghost.style, { left: `${g.to.x}px`, top: `${g.to.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    ghost.querySelector('span').textContent = `${f.name} copy`;
    ghost.hidden = false;
  }
  else if (g.type === 'move') {
    g.moved = true;
    drag.set(g.fid, { x: g.fx + (e.clientX - g.sx) / view.z, y: g.fy + (e.clientY - g.sy) / view.z });
    updateFrame(S.frames.find(f => f.id === g.fid)); positionPops();
  } else if (g.type === 'cpick') {
    if (!g.area && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) { g.area = true; closeComposer(); closeThread(); vp.classList.add('dragging'); }
    if (!g.area) return;
    let a, b;
    if (g.fid === CANVAS) { a = toWorld(g.sx, g.sy); b = toWorld(e.clientX, e.clientY); }
    else {
      const f = S.frames.find(x => x.id === g.fid);
      const clamp = p => ({ x: Math.max(0, Math.min(f.w, p.lx)), y: Math.max(0, Math.min(f.h, p.ly)) });
      a = clamp(localFromClient(g.fid, g.sx, g.sy)); b = clamp(localFromClient(g.fid, e.clientX, e.clientY));
    }
    g.rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    let box = areasBox(g.fid).querySelector('.area.picking');
    if (!box) { box = document.createElement('div'); box.className = 'area picking show'; areasBox(g.fid).prepend(box); }
    Object.assign(box.style, { left: `${g.rect.x}px`, top: `${g.rect.y}px`, width: `${g.rect.w}px`, height: `${g.rect.h}px` });
  } else if (g.type === 'draw') {
    const p = toWorld(e.clientX, e.clientY);
    const r = { x: Math.min(g.x0, p.x), y: Math.min(g.y0, p.y), w: Math.abs(p.x - g.x0), h: Math.abs(p.y - g.y0) };
    if (e.shiftKey) r.w = r.h = Math.max(r.w, r.h);
    g.rect = r;
    const box = $('#draw-box');
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    box.querySelector('span').textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    box.hidden = false;
  } else if (g.type === 'resize') {
    const d = { w: Math.max(120, g.w + (e.clientX - g.sx) / view.z), h: Math.max(120, g.h + (e.clientY - g.sy) / view.z) };
    drag.set(g.fid, d);
    updateFrame(S.frames.find(f => f.id === g.fid));
    if ($('#fp-sw')) { $('#fp-sw').value = Math.round(d.w); $('#fp-sh').value = Math.round(d.h); }
  } else if (g.type === 'stroke') {
    const p = toWorld(e.clientX, e.clientY), n = g.points.length;
    if (Math.hypot(p.x - g.points[n - 2], p.y - g.points[n - 1]) * view.z < 1.5) return;
    g.points.push(p.x, p.y); g.path.setAttribute('d', pathD(g.points));
  } else if (g.type === 'erase') eraseAt(e);
});
const endGesture = async e => {
  const g = gesture; if (!g) return;
  gesture = null; vp.classList.remove('dragging');
  if (g.type === 'cpick') {
    document.querySelectorAll('.area.picking').forEach(n => n.remove());
    if (g.area && g.rect && g.rect.w * view.z > 8 && g.rect.h * view.z > 8) return openComposer(g.fid, g.rect.x, g.rect.y, null, g.rect);
    if (g.area) return;
    if (g.fid === CANVAS) { const w = toWorld(g.sx, g.sy); return openComposer(CANVAS, w.x, w.y, 'canvas'); }
    const { lx, ly } = localFromClient(g.fid, g.sx, g.sy);
    if (frameEls.get(g.fid)?.el.classList.contains('empty')) return openPrompt(g.fid);
    return openComposer(g.fid, lx, ly);
  }
  if (g.type === 'draw') {
    $('#draw-box').hidden = true;
    const r = g.rect;
    if (r && r.w * view.z > 12 && r.h * view.z > 12) createBlank('Frame', r.w, r.h, r.x, r.y);
    return;
  }
  if (g.type === 'move' && g.dup) {
    $('#dup-ghost').hidden = true;
    if (g.moved && g.to) duplicateFrame(g.fid, g.to);
    return;
  }
  if ((g.type === 'move' && g.moved) || g.type === 'resize') {
    const d = drag.get(g.fid);
    const f = S.frames.find(x => x.id === g.fid);
    const before = g.type === 'move' ? { x: g.fx, y: g.fy } : { w: g.w, h: g.h };
    if (d && f) Object.assign(f, d);
    drag.delete(g.fid);
    if (d) {
      api('PATCH', `/__loop/api/frames/${g.fid}`, d).catch(err => toast(err.message));
      const after = { ...d }, id = g.fid;
      record(g.type === 'move' ? 'Move frame' : 'Resize frame', () => patchFrame(id, before), () => patchFrame(id, after));
    }
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
      record('Draw mark', () => api('DELETE', `/__loop/api/strokes/${s.id}`), () => restore({ strokes: [s] }));
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

// Pinch anywhere in Loop zooms the canvas (never the browser page); scrolling over the canvas pans it,
// while panels, menus and comment threads keep their own scrolling.
addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) return pinchZoom(e, e.clientX, e.clientY);
  if (!e.target.closest?.('#viewport')) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1;
  view.x -= e.deltaX * k; view.y -= e.deltaY * k; scheduleView();
}, { passive: false, capture: true });
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
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (e.key.toLowerCase() === 'c' && selected && isOwner()) { e.preventDefault(); clipboardFrame = selected; toast(`Copied “${S.frames.find(f => f.id === selected)?.name}” — ⌘V to paste`, 1600); return; }
    if (e.key.toLowerCase() === 'v' && clipboardFrame && isOwner()) { e.preventDefault(); if (S.frames.find(f => f.id === clipboardFrame)) duplicateFrame(clipboardFrame); else toast('The copied frame no longer exists'); return; }
    if (e.key.toLowerCase() === 'd' && selected && isOwner()) { e.preventDefault(); duplicateFrame(selected); return; }
    if (e.key.toLowerCase() === 'y' && e.ctrlKey) { e.preventDefault(); redo(); return; }
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
  else if (k === 'f' && isOwner()) setTool(tool === 'frame' ? 'select' : 'frame');
  else if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) fitAll();
  else if (e.key === '=' || e.key === '+') zoomAt(innerWidth / 2, innerHeight / 2, 1.25);
  else if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, 0.8);
  else if (e.key === 'Escape') { if (!composer.hidden) closeComposer(); else if (openThreadId) closeThread(); else if (!$('#agent-menu').hidden || !$('#share-menu').hidden) closeMenus(); else { selectFrame(null); setTool('select'); } }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && selected && isOwner()) {
    const f = S.frames.find(x => x.id === selected);
    if (f) removeFrame(f.id).then(() => { selected = null; renderPanel(); });
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
  try { await api('POST', '/__loop/api/settings', { mode: b.dataset.mode, runner: b.dataset.runner }); toast(b.dataset.mode === 'inbox' ? 'Comments will queue for your agent session' : `Loop will run ${b.dataset.runner === 'codex' ? 'Codex' : 'Claude Code'} on each comment`); }
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
let newSize = '1440x1024';
function openNewFrame() {
  closeMenus(); $('#new-frame').hidden = false;
  const t = $('#new-frame-input'); t.value = ''; setTimeout(() => t.focus(), 0);
}
function closeNewFrame() { $('#new-frame').hidden = true; }
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

// ---------- frame tool: presets, freeform, size inspector ----------
const QUICK = [['Mobile', 393, 852], ['Tablet', 834, 1194], ['Desktop', 1440, 1024]];
const PRESET_GROUPS = [
  ['Phone', [['iPhone 16', 393, 852], ['iPhone 16 Pro Max', 440, 956], ['iPhone SE', 375, 667], ['Android (compact)', 412, 917], ['Android (large)', 448, 998]]],
  ['Tablet', [['iPad mini', 744, 1133], ['iPad Pro 11"', 834, 1194], ['iPad Pro 13"', 1032, 1376], ['Android tablet', 800, 1280]]],
  ['Desktop', [['Desktop', 1440, 1024], ['MacBook Air', 1280, 832], ['MacBook Pro 14"', 1512, 982], ['Desktop HD', 1920, 1080], ['Wide', 1728, 1117]]],
];
const DEVICE_ICON = {
  Mobile: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>',
  Tablet: '<svg viewBox="0 0 24 24"><rect x="4.5" y="2.5" width="15" height="19" rx="2.2"/><path d="M11 18.5h2"/></svg>',
  Desktop: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12.5" rx="1.8"/><path d="M9 20h6M12 16.5V20"/></svg>',
};
function uniqueName(base) {
  const names = new Set(S.frames.map(f => f.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
// a spot where a w×h frame fits without overlapping, near the middle of the screen
function freeSpot(w, h) {
  const c = toWorld(innerWidth / 2, innerHeight / 2);
  const hit = (x, y) => S.frames.some(f => x < f.x + f.w + 80 && x + w + 80 > f.x && y < f.y + f.h + 80 && y + h + 80 > f.y);
  const x0 = Math.round(c.x - w / 2), y0 = Math.round(c.y - h / 2);
  for (let ring = 0; ring < 30; ring++) for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const x = x0 + dx * ring * (w * 0.5 + 80), y = y0 + dy * ring * (h * 0.5 + 80);
    if (!hit(x, y)) return { x, y };
  }
  return { x: x0, y: y0 };
}
function revealFrame(id) {
  const f = S.frames.find(x => x.id === id); if (!f) return;
  const a = { x: view.x + f.x * view.z, y: view.y + f.y * view.z }, b = { x: a.x + f.w * view.z, y: a.y + f.h * view.z };
  if (a.x < 0 || a.y < 60 || b.x > innerWidth || b.y > innerHeight - 80) fitAll(true, [id]);
}
async function createBlank(base, w, h, x, y) {
  const pos = x != null ? { x: Math.round(x), y: Math.round(y) } : freeSpot(w, h);
  try {
    const f = await api('POST', '/__loop/api/frames', { new: true, blank: true, name: uniqueName(base), w: Math.round(w), h: Math.round(h), ...pos });
    pendingSelect = f.id; pendingPrompt = f.id;
    let snap = null;
    record('Add frame', async () => { snap = frameSnapshot(f.id) || snap; await api('DELETE', `/__loop/api/frames/${f.id}`); }, () => restore(snap || { frames: [f] }));
    setTool('select');
    if (S.frames.find(x => x.id === f.id)) { pendingSelect = pendingPrompt = null; selectFrame(f.id); revealFrame(f.id); setTimeout(() => openPrompt(f.id), 340); }
  } catch (e) { toast(e.message); }
}
function renderPanel() {
  const panel = $('#frame-panel');
  if (!S || !isOwner() || ADAPTER) { panel.hidden = true; return; }
  if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // don't clobber typing
  const sel = tool === 'select' && selected && S.frames.find(f => f.id === selected);
  if (tool !== 'frame' && !sel) { panel.hidden = true; return; }
  panel.hidden = false;
  const body = $('#fp-body');
  if (tool === 'frame') {
    $('#fp-title').textContent = 'New frame';
    body.innerHTML = `
      <div class="fp-quick">${QUICK.map(([n, w, h]) => `<button class="fp-q" data-w="${w}" data-h="${h}" data-name="${n}">${DEVICE_ICON[n]}<b>${n}</b><small>${w} × ${h}</small></button>`).join('')}</div>
      <p class="fp-hint">Or drag on the canvas to draw any size. Hold ⇧ for a square.</p>
      ${PRESET_GROUPS.map(([g, list]) => `<details class="fp-group"><summary>${g}</summary>${list.map(([n, w, h]) => `<button class="fp-row" data-w="${w}" data-h="${h}" data-name="${n}"><span>${esc(n)}</span><small>${w} × ${h}</small></button>`).join('')}</details>`).join('')}
      <div class="fp-custom"><label>W<input id="fp-w" inputmode="numeric" value="1200"></label><label>H<input id="fp-h" inputmode="numeric" value="800"></label><button id="fp-make" class="btn-dark">Add</button></div>
      <button id="fp-describe" class="link-btn">Describe a frame and let the agent build it (N)</button>`;
  } else {
    $('#fp-title').innerHTML = `<input id="fp-name" value="${esc(sel.name)}" title="Rename frame" spellcheck="false">`;
    const kind = sel.kind === 'route' ? `App route ${sel.src}` : sel.kind === 'url' ? 'Live URL' : 'Static frame';
    body.innerHTML = `
      <div class="fp-size"><label>W<input id="fp-sw" inputmode="numeric" value="${Math.round(sel.w)}"></label><label>H<input id="fp-sh" inputmode="numeric" value="${Math.round(sel.h)}"></label></div>
      <div class="fp-chips">${QUICK.map(([n, w, h]) => `<button class="fp-chip${Math.round(sel.w) === w && Math.round(sel.h) === h ? ' on' : ''}" data-w="${w}" data-h="${h}">${n}</button>`).join('')}</div>
      <details class="fp-group"><summary>All sizes</summary>${PRESET_GROUPS.flatMap(([, l]) => l).map(([n, w, h]) => `<button class="fp-row resize" data-w="${w}" data-h="${h}"><span>${esc(n)}</span><small>${w} × ${h}</small></button>`).join('')}</details>
      <p class="fp-hint">${esc(kind)} · drag the corner handle to resize freely.</p>`;
  }
}
async function resizeSelected(w, h) {
  const f = S.frames.find(x => x.id === selected); if (!f || !(w > 0 && h > 0)) return;
  const before = { w: f.w, h: f.h }, after = { w: Math.round(w), h: Math.round(h) }, id = f.id;
  if (before.w !== after.w || before.h !== after.h) record('Resize frame', () => patchFrame(id, before), () => patchFrame(id, after));
  Object.assign(f, after); updateFrame(f);
  try { await api('PATCH', `/__loop/api/frames/${f.id}`, { w: f.w, h: f.h }); } catch (e) { toast(e.message); }
  renderPanel(); setTimeout(() => positionPins(f.id), 60);
}
$('#frame-panel').addEventListener('pointerdown', e => e.stopPropagation());
$('#frame-panel').addEventListener('wheel', e => e.stopPropagation());
$('#frame-panel').addEventListener('click', e => {
  if (e.target.closest('#fp-close')) { if (tool === 'frame') setTool('select'); else selectFrame(null); return; }
  if (e.target.closest('#fp-describe')) { setTool('select'); openNewFrame(); return; }
  if (e.target.closest('#fp-make')) { const w = +$('#fp-w').value, h = +$('#fp-h').value; if (w > 0 && h > 0) createBlank('Frame', w, h); return; }
  const b = e.target.closest('[data-w]'); if (!b) return;
  if (tool === 'frame') createBlank(b.dataset.name, +b.dataset.w, +b.dataset.h);
  else resizeSelected(+b.dataset.w, +b.dataset.h);
});
$('#frame-panel').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.target.blur(); return; }
  if (e.key !== 'Enter') return;
  if (e.target.id === 'fp-sw' || e.target.id === 'fp-sh') { const w = +$('#fp-sw').value, h = +$('#fp-sh').value; e.target.blur(); resizeSelected(w, h); }
  if (e.target.id === 'fp-w' || e.target.id === 'fp-h') $('#fp-make').click();
});
$('#frame-panel').addEventListener('focusout', e => {
  if ((e.target.id === 'fp-sw' || e.target.id === 'fp-sh') && !$('#frame-panel').contains(e.relatedTarget)) {
    const f = S.frames.find(x => x.id === selected), w = +$('#fp-sw')?.value, h = +$('#fp-sh')?.value;
    if (f && (w !== Math.round(f.w) || h !== Math.round(f.h))) resizeSelected(w, h);
  }
});

// ---------- undo / redo (canvas edits; agent changes have their own Undo in the thread) ----------
const undoStack = [], redoStack = [];
let replaying = false;
function record(label, undoFn, redoFn) {
  if (replaying || ADAPTER || !isOwner()) return;
  undoStack.push({ label, undo: undoFn, redo: redoFn });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
async function step(from, to, dir) {
  const op = from.pop();
  if (!op) { toast(dir === 'undo' ? 'Nothing to undo' : 'Nothing to redo', 1200); return; }
  replaying = true;
  try { await op[dir](); to.push(op); toast(`${dir === 'undo' ? 'Undo' : 'Redo'}: ${op.label}`, 1400); }
  catch (e) { toast(`Couldn't ${dir}: ${e.message}`); }
  finally { replaying = false; }
}
const undo = () => step(undoStack, redoStack, 'undo');
const redo = () => step(redoStack, undoStack, 'redo');
function patchFrame(id, fields) {
  const f = S.frames.find(x => x.id === id);
  if (f) { Object.assign(f, fields); updateFrame(f); renderPanel(); setTimeout(() => positionPins(id), 50); }
  return api('PATCH', `/__loop/api/frames/${id}`, fields);
}
const restore = data => api('POST', '/__loop/api/restore', data);
function frameSnapshot(id) {
  const f = S.frames.find(x => x.id === id); if (!f) return null;
  return { frames: [{ ...f }], comments: S.comments.filter(c => c.frameId === id).map(c => ({ ...c })) };
}
async function removeFrame(id) {
  const snap = frameSnapshot(id); if (!snap) return;
  await api('DELETE', `/__loop/api/frames/${id}`);
  record('Delete frame', () => restore(snap), () => api('DELETE', `/__loop/api/frames/${id}`));
  toast(`Deleted “${snap.frames[0].name}” — ⌘Z to undo`, 2600);
}

// ---------- duplicate ----------
let clipboardFrame = null;
async function duplicateFrame(id, at) {
  try {
    const nf = await api('POST', `/__loop/api/frames/${id}/duplicate`, at ? { x: Math.round(at.x), y: Math.round(at.y) } : {});
    let snap = null;
    record('Duplicate frame', async () => { snap = frameSnapshot(nf.id) || snap; await api('DELETE', `/__loop/api/frames/${nf.id}`); }, () => restore(snap || { frames: [nf] }));
    if (S.frames.find(f => f.id === nf.id)) { selectFrame(nf.id); revealFrame(nf.id); } else pendingSelect = nf.id;
  } catch (e) { toast(e.message); }
}
// holding ⌥/Alt over a frame title shows the copy cursor
addEventListener('keydown', e => { if (e.key === 'Alt') vp.classList.add('alt'); });
addEventListener('keyup', e => { if (e.key === 'Alt') vp.classList.remove('alt'); });
addEventListener('blur', () => vp.classList.remove('alt'));

// ---------- keyboard shortcuts sheet ----------
const SHORTCUTS = [
  ['Tools', [['V', 'Select & interact'], ['H  /  hold Space', 'Pan'], ['F', 'Frame (presets, or drag to draw)'], ['C', 'Comment (click = pin, drag = area)'], ['P', 'Draw'], ['E', 'Erase marks'], ['N', 'Describe a frame for the agent']]],
  ['Edit', [['⌘Z', 'Undo'], ['⇧⌘Z  /  Ctrl Y', 'Redo'], ['⌥ drag title', 'Duplicate frame'], ['⌘C  /  ⌘V', 'Copy / paste frame'], ['⌘D', 'Duplicate in place'], ['Delete', 'Delete selected frame'], ['Double-click title', 'Rename frame'], ['Esc', 'Close / deselect']]],
  ['View', [['Pinch  /  ⌘ scroll', 'Zoom'], ['Scroll', 'Pan'], ['⇧1', 'Fit everything'], ['⌘0', 'Zoom to 100%'], ['+  /  −', 'Zoom in / out']]],
  ['Comments', [['↵', 'Send to the agent'], ['⇧↵', 'New line'], ['?', 'This list']]],
];
function toggleShortcuts(force) {
  let m = $('#shortcuts');
  if (!m) {
    m = document.createElement('div'); m.id = 'shortcuts'; m.className = 'modal'; m.hidden = true;
    m.innerHTML = `<div class="modal-card sc-card"><div class="modal-head"><span>Keyboard shortcuts</span><button class="icon-btn" data-close>×</button></div>
      <div class="sc-grid">${SHORTCUTS.map(([g, rows]) => `<div><div class="sc-group">${g}</div>${rows.map(([k, d]) => `<div class="sc-row"><span>${esc(d)}</span><span class="sc-keys">${k.split('  /  ').map(x => `<kbd>${esc(x)}</kbd>`).join(' ')}</span></div>`).join('')}</div>`).join('')}</div></div>`;
    document.body.appendChild(m);
    m.addEventListener('pointerdown', e => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
  }
  m.hidden = force === undefined ? !m.hidden : !force;
}
addEventListener('keydown', e => {
  if (typing()) return;
  if (e.key === '?') { e.preventDefault(); toggleShortcuts(); }
  else if (e.key === 'Escape' && $('#shortcuts') && !$('#shortcuts').hidden) toggleShortcuts(false);
});

// ---------- renaming ----------
function saveFrameName(input) {
  const f = S.frames.find(x => x.id === selected), v = input.value.trim();
  if (f && v && v !== f.name) { const old = f.name, id = f.id; f.name = v; updateFrame(f); api('PATCH', `/__loop/api/frames/${id}`, { name: v }).catch(e => toast(e.message)); record('Rename frame', () => patchFrame(id, { name: old }), () => patchFrame(id, { name: v })); }
}
$('#frame-panel').addEventListener('change', e => { if (e.target.id === 'fp-name') saveFrameName(e.target); });
$('#frame-panel').addEventListener('keydown', e => { if (e.target.id === 'fp-name' && e.key === 'Enter') { saveFrameName(e.target); e.target.blur(); } }, true);
$('#canvas-name').addEventListener('click', () => {
  const el = $('#canvas-name');
  if (!isOwner() || ADAPTER || el.querySelector('input')) return;
  const input = document.createElement('input'); input.className = 'canvas-rename'; input.value = S.name; input.spellcheck = false;
  el.replaceChildren(input); input.focus(); input.select();
  const done = save => {
    const v = input.value.trim();
    el.textContent = save && v ? v : S.name;
    if (save && v && v !== S.name) { const old = S.name; S.name = v; api('POST', '/__loop/api/settings', { name: v }).catch(e => toast(e.message)); record('Rename canvas', () => api('POST', '/__loop/api/settings', { name: old }), () => api('POST', '/__loop/api/settings', { name: v })); }
  };
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = S.name; input.blur(); } });
  input.addEventListener('blur', () => done(true));
});

addEventListener('resize', () => positionPops());
finishHostSignIn();
setTool('select');
applyView();
connect();
