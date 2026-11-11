// Loop hosted viewer: sign in, open a canvas you were invited to, comment.
// Installs window.LOOP_ADAPTER (Supabase-backed) and then loads the same canvas app the host uses.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm';

const cfg = window.LOOP_CONFIG;
const sb = createClient(cfg.url, cfg.key, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } });
const params = new URLSearchParams(location.search);
const canvasId = params.get('c');
const gate = document.getElementById('gate'), body = document.getElementById('gate-body');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 10);
const COLORS = ['#2F5BFF', '#E5484D', '#1F9D55', '#D9A100', '#8E4EC6', '#0E9AA7', '#E8590C'];
const GOOGLE = `<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 013.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>`;

// Is Google sign-in switched on? (checked before redirecting, so nobody lands on a raw error page)
async function googleEnabled() {
  try { const r = await fetch(`${cfg.url}/auth/v1/settings`, { headers: { apikey: cfg.key } }); return !!(await r.json()).external?.google; } catch { return true; }
}
function show(html) { gate.hidden = false; body.innerHTML = html; }
const profileOf = u => { const m = u?.user_metadata || {}; return { name: m.full_name || m.name || (u?.email || '').split('@')[0], avatar: m.avatar_url || m.picture || null, email: u?.email }; };

async function saveAuthForFrames(session) {
  if (!session) return;
  const c = await caches.open('loop-auth');
  await c.put('auth', new Response(JSON.stringify({ token: session.access_token, url: cfg.url, apikey: cfg.key })));
}

function signInScreen(note = '') {
  show(`
    <h1>${canvasId ? 'You’ve been invited to a canvas' : 'Sign in to Loop'}</h1>
    <p>Sign in with the email address the invite was sent to.</p>
    <button class="g-btn" id="g-google">${GOOGLE}Continue with Google</button>
    <details class="g-alt"><summary>Use an email link instead</summary>
      <div class="g-row"><input id="g-email" type="email" placeholder="you@company.com"><button id="g-send">Send link</button></div>
    </details>
    <p class="g-note" id="g-note">${esc(note)}</p>`);
  document.getElementById('g-google').onclick = async () => {
    if (!(await googleEnabled())) { document.getElementById('g-note').textContent = 'Google sign-in isn’t switched on for Loop yet. Use an email link for now.'; document.querySelector('.g-alt').open = true; return; }
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href } });
    if (error) document.getElementById('g-note').textContent = error.message.includes('provider is not enabled') ? 'Google sign-in isn’t switched on yet — use an email link for now.' : error.message;
  };
  document.getElementById('g-send').onclick = async () => {
    const email = document.getElementById('g-email').value.trim();
    if (!email) return;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
    document.getElementById('g-note').textContent = error ? error.message : `Check ${email} for a sign-in link.`;
  };
}

async function listScreen(user) {
  const { data, error } = await sb.from('canvases').select('id,name,owner_id,owner_name,owner_avatar,updated_at').order('updated_at', { ascending: false });
  if (error) return show(`<h1>Something went wrong</h1><p>${esc(error.message)}</p>`);
  show(`
    <h1>Canvases shared with you</h1>
    <p>Signed in as ${esc(user.email)} · <button class="g-link" id="g-out">Sign out</button></p>
    <div class="g-list">${data.length ? data.map(c => `
      <a class="g-item" href="?c=${c.id}"><span class="g-av">${c.owner_avatar ? `<img src="${esc(c.owner_avatar)}" referrerpolicy="no-referrer" alt="">` : esc((c.owner_name || '?')[0])}</span>
        <span><b>${esc(c.name)}</b><small>${c.owner_id === user.id ? 'Yours' : `from ${esc(c.owner_name || 'someone')}`} · ${new Date(c.updated_at).toLocaleDateString()}</small></span></a>`).join('')
      : '<p class="g-note">Nothing has been shared with this account yet.</p>'}</div>`);
  document.getElementById('g-out').onclick = () => sb.auth.signOut().then(() => location.reload());
}

async function main() {
  // frames are served by the service worker; it must control the page before anything loads
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) { location.reload(); return; }
  }
  let { data: { session } } = await sb.auth.getSession();
  if (location.search.includes('code=')) { // back from Google — the client exchanges the code
    for (let i = 0; !session && i < 20; i++) { await new Promise(r => setTimeout(r, 150)); ({ data: { session } } = await sb.auth.getSession()); }
    const clean = new URL(location.href); clean.searchParams.delete('code'); history.replaceState(null, '', clean);
  }
  if (!session) return signInScreen();
  await saveAuthForFrames(session);
  sb.auth.onAuthStateChange((_e, s) => { if (s) saveAuthForFrames(s); });
  const user = session.user;
  if (!canvasId) return listScreen(user);

  await sb.rpc('mark_joined', { cid: canvasId });
  const { data: canvas } = await sb.from('canvases').select('*').eq('id', canvasId).maybeSingle();
  if (!canvas) {
    return show(`<h1>No access with this account</h1><p>${esc(user.email)} hasn’t been invited to this canvas. Ask the person who shared it to invite this address, or switch accounts.</p>
      <button class="g-btn" id="g-switch">Use another account</button>`), document.getElementById('g-switch').onclick = () => sb.auth.signOut().then(() => location.reload());
  }
  mount(canvas, user);
}

// ---------- adapter: what the canvas app sees ----------
function mount(canvas, user) {
  const prof = profileOf(user);
  const color = COLORS[[...user.id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
  let comments = [], localStrokes = [], handler = null;
  const me = { id: user.id.slice(0, 12) + rid().slice(0, 4), name: prof.name, color, avatar: prof.avatar };

  const mapComment = r => ({
    id: r.id, frameId: r.frame_id, parentId: r.parent_id, text: r.text, anchor: r.anchor, ink: r.ink?.elements || [],
    author: { name: r.author_name || 'Someone', color: r.author_color || '#888', guest: r.author_id !== canvas.owner_id },
    status: r.status, reply: r.reply, resolved: r.resolved, createdAt: Date.parse(r.created_at), mine: r.author_id === user.id,
    model: r.model, startedAt: r.started_at && Date.parse(r.started_at), finishedAt: r.finished_at && Date.parse(r.finished_at),
  });
  function buildState() {
    const st = canvas.state || {};
    const commentInk = comments.flatMap(c => (c.ink?.strokes || []).map((points, i) => ({ id: `ink-${c.id}-${i}`, points, color: '#E5484D', width: 3, commentId: c.id })));
    return {
      name: canvas.name, role: 'guest', agent: st.agent || { mode: 'headless' }, agentBin: st.agentBin || 'claude',
      frames: st.frames || [], strokes: [...(st.strokes || []), ...commentInk, ...localStrokes],
      comments: comments.map(mapComment), live: st.live || {},
      hostOnline: !!canvas.host_seen_at && Date.now() - Date.parse(canvas.host_seen_at) < 90_000,
    };
  }
  const emit = () => handler?.({ type: 'state', state: buildState() });

  const channel = sb.channel(`loop:${canvas.id}`, { config: { broadcast: { self: false }, presence: { key: me.id } } });

  window.LOOP_ADAPTER = {
    me,
    frameSrc: f => f.version ? `f/${canvas.id}/${f.id}/${f.version}/${f.entry || 'index.html'}` : 'about:blank',
    async connect(h) {
      handler = h;
      const { data } = await sb.from('comments').select('*').eq('canvas_id', canvas.id).order('created_at');
      comments = data || [];
      emit();
      channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `canvas_id=eq.${canvas.id}` }, ({ eventType, new: n, old }) => {
          if (eventType === 'DELETE') comments = comments.filter(c => c.id !== old.id);
          else {
            const prev = comments.find(c => c.id === n.id);
            comments = prev ? comments.map(c => c.id === n.id ? n : c) : [...comments, n];
            if (prev && prev.status !== n.status && ['done', 'error'].includes(n.status)) handler?.({ type: 'frame-changed', frameId: n.frame_id, done: true, status: n.status });
          }
          emit();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'canvases', filter: `id=eq.${canvas.id}` }, ({ new: n }) => { canvas = { ...canvas, ...n }; emit(); })
        .on('broadcast', { event: 'cursor' }, ({ payload }) => handler?.({ type: 'presence', ...payload }))
        .on('presence', { event: 'leave' }, ({ key }) => handler?.({ type: 'presence', id: key, leave: true }))
        .subscribe(s => { if (s === 'SUBSCRIBED') channel.track({ name: me.name, color: me.color, avatar: me.avatar }); });
      setInterval(emit, 30_000); // host online/offline
      accountChip(prof);
    },
    async api(method, path, b) {
      const p = path.replace(/^\/__loop\/api/, '');
      if (p === '/presence') { channel.send({ type: 'broadcast', event: 'cursor', payload: { ...b, id: me.id } }); return { ok: true }; }
      if (method === 'GET' && p === '/state') return buildState();
      if (method === 'POST' && p === '/strokes') { const s = { id: 'l-' + rid(), ...b, createdAt: Date.now() }; localStrokes.push(s); emit(); return s; }
      if (method === 'DELETE' && p.startsWith('/strokes/')) { localStrokes = localStrokes.filter(s => s.id !== p.slice(9)); emit(); return { ok: true }; }
      if (method === 'POST' && p === '/comments') {
        const strokes = localStrokes.filter(s => (b.inkStrokes || []).includes(s.id));
        localStrokes = localStrokes.filter(s => !strokes.includes(s));
        const parent = b.parentId ? comments.find(c => c.id === b.parentId) : null;
        const row = {
          id: rid() + rid().slice(0, 4), canvas_id: canvas.id, frame_id: b.frameId, parent_id: parent ? (parent.parent_id || parent.id) : null,
          author_id: user.id, author_name: me.name, author_color: me.color, text: b.text, anchor: b.anchor || parent?.anchor || null,
          ink: { elements: b.ink || [], strokes: strokes.map(s => s.points) }, status: 'waiting',
        };
        const { data, error } = await sb.from('comments').insert(row).select().single();
        if (error) throw new Error(error.message);
        if (!comments.find(c => c.id === data.id)) comments.push(data);
        emit();
        return mapComment(data);
      }
      const cm = /^\/comments\/([^/]+)(?:\/(\w+))?$/.exec(p);
      if (cm && method === 'DELETE') {
        const { error } = await sb.from('comments').delete().or(`id.eq.${cm[1]},parent_id.eq.${cm[1]}`);
        if (error) throw new Error(error.message);
        comments = comments.filter(c => c.id !== cm[1] && c.parent_id !== cm[1]); emit(); return { ok: true };
      }
      if (cm && cm[2] === 'resolve' && canvas.owner_id === user.id) {
        const c = comments.find(x => x.id === cm[1]);
        await sb.from('comments').update({ resolved: !c?.resolved }).eq('id', cm[1]); return { ok: true };
      }
      if (cm && cm[2] === 'send' && canvas.owner_id === user.id) {
        await sb.from('comments').update({ status: 'queued' }).eq('id', cm[1]); return { ok: true };
      }
      throw new Error('Only the host can do that from their Mac');
    },
  };
  gate.hidden = true;
  import('./app.js?v=mwbdagny');
}

function accountChip(prof) {
  const right = document.querySelector('.top-right'); if (!right || document.getElementById('acct')) return;
  const b = document.createElement('button');
  b.id = 'acct'; b.className = 'acct'; b.title = `${prof.email} — sign out`;
  b.innerHTML = prof.avatar ? `<img src="${esc(prof.avatar)}" alt="" referrerpolicy="no-referrer">` : esc((prof.name || '?')[0].toUpperCase());
  b.onclick = () => { if (confirm(`Signed in as ${prof.email}. Sign out?`)) sb.auth.signOut().then(() => location.reload()); };
  right.appendChild(b);
}

main().catch(e => show(`<h1>Something went wrong</h1><p>${esc(e.message)}</p>`));
