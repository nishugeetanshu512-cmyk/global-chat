'use strict';
const $ = s => document.querySelector(s);
const hue = str => { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let me = null, ws = null, active = null, wantSocket = false;
const convs = new Map();      // id -> conversation
const msgs = new Map();       // id -> messages[] (ascending)
const online = new Set();
const typingNow = new Map();  // cid -> Map(userId -> {name, timer})

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}

/* ------------------------------ Auth ------------------------------ */
let mode = 'login';
function setMode(m) {
  mode = m;
  $('#tab-login').classList.toggle('on', m === 'login');
  $('#tab-register').classList.toggle('on', m === 'register');
  $('#a-go').textContent = m === 'login' ? 'Sign in' : 'Create account';
  $('#auth h1').textContent = m === 'login' ? 'Welcome back' : 'Join Ridge';
  $('#a-sub').textContent = m === 'login' ? 'Sign in to pick up where you left off.' : 'Pick a username and start talking in seconds.';
  $('#a-pass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#a-err').textContent = '';
}
$('#tab-login').onclick = () => setMode('login');
$('#tab-register').onclick = () => setMode('register');
async function submitAuth() {
  try {
    me = await api('POST', '/' + mode, { username: $('#a-user').value.trim(), password: $('#a-pass').value });
    $('#a-pass').value = '';
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    await startApp();
  } catch (e) { $('#a-err').textContent = e.message; }
}
$('#a-go').onclick = submitAuth;
$('#a-pass').onkeydown = e => { if (e.key === 'Enter') submitAuth(); };
$('#a-user').onkeydown = e => { if (e.key === 'Enter') $('#a-pass').focus(); };

$('#logout').onclick = async () => {
  wantSocket = false;
  if (ws) ws.close();
  await api('POST', '/logout').catch(() => {});
  me = null; active = null; convs.clear(); msgs.clear(); online.clear();
  showAuth();
};

function showAuth() { $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); }

async function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden', 'in-chat');
  $('#me-name').textContent = me.username;
  $('#pane').classList.add('hidden'); $('#empty').classList.remove('hidden');
  await loadConversations();
  wantSocket = true;
  connect();
}

/* ------------------------------ Data ------------------------------ */
async function loadConversations() {
  const { conversations, online: on } = await api('GET', '/conversations');
  convs.clear();
  for (const c of conversations) convs.set(c.id, c);
  online.clear(); on.forEach(id => online.add(id));
  renderList();
}

const other = c => c.members.find(m => m.id !== me.id) || c.members[0];
const title = c => c.type === 'group' ? c.name : other(c).username;
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const snippet = m => !m ? 'No messages yet' : m.deleted ? 'Message deleted' : m.file ? (m.senderId === me.id ? 'You: ' : '') + 'Sent ' + m.file.name : (m.senderId === me.id ? 'You: ' : '') + m.body;

/* ------------------------------ Sidebar ------------------------------ */
function avatar(c) {
  const a = el('div', 'avatar' + (c.type === 'group' ? ' group' : ''), title(c)[0].toUpperCase());
  a.style.background = `hsl(${hue(title(c))} 38% 36%)`;
  if (c.type === 'dm' && online.has(other(c).id)) a.append(el('span', 'dot'));
  return a;
}
function renderList() {
  const ul = $('#list'); ul.replaceChildren();
  const stamp = c => c.last ? c.last.createdAt : c.createdAt;
  const sorted = [...convs.values()].sort((a, b) => stamp(b) - stamp(a));
  if (!sorted.length) { ul.append(el('li', 'muted', 'No chats yet. Search for a username above.')); ul.lastChild.style.padding = '14px'; }
  for (const c of sorted) {
    const li = el('li', 'row-item' + (c.id === active ? ' on' : ''));
    const meta = el('div', 'meta');
    const top = el('div', 'top');
    top.append(el('span', 'name', title(c)), el('span', 'muted', c.last ? fmtTime(c.last.createdAt) : ''));
    meta.append(top, el('div', 'snippet', snippet(c.last)));
    li.append(avatar(c), meta);
    if (c.unread) li.append(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
    li.onclick = () => openConv(c.id);
    ul.append(li);
  }
}

let findTimer;
$('#find').oninput = () => { clearTimeout(findTimer); findTimer = setTimeout(runSearch, 200); };
async function runSearch() {
  const q = $('#find').value.trim(), box = $('#results');
  if (!q) { box.classList.add('hidden'); $('#list').classList.remove('hidden'); return; }
  const [users, found] = await Promise.all([api('GET', '/users?q=' + encodeURIComponent(q)), q.length > 1 ? api('GET', '/search?q=' + encodeURIComponent(q)) : []]);
  box.replaceChildren();
  $('#list').classList.add('hidden'); box.classList.remove('hidden');
  if (users.length) box.append(Object.assign(el('div', 'muted', 'People'), { style: 'padding:8px 14px' }));
  for (const u of users) {
    const li = el('div', 'row-item');
    const a = el('div', 'avatar', u.username[0].toUpperCase()); a.style.background = `hsl(${hue(u.username)} 38% 36%)`; if (u.online) a.append(el('span', 'dot'));
    li.append(a, el('div', 'name', u.username));
    li.onclick = () => startDm(u.id);
    box.append(li);
  }
  if (found.length) box.append(Object.assign(el('div', 'muted', 'Messages'), { style: 'padding:8px 14px' }));
  for (const m of found) {
    const c = convs.get(m.cid); if (!c) continue;
    const li = el('div', 'row-item'), meta = el('div', 'meta');
    meta.append(el('div', 'name', title(c)), el('div', 'snippet', m.senderName + ': ' + m.body));
    li.append(meta); li.onclick = () => openConv(c.id);
    box.append(li);
  }
  if (!users.length && !found.length) box.append(Object.assign(el('div', 'muted', 'No matches.'), { style: 'padding:14px' }));
}
async function startDm(userId) {
  const c = await api('POST', '/conversations/dm', { userId });
  convs.set(c.id, c);
  $('#find').value = ''; runSearch(); renderList();
  openConv(c.id);
}

/* ------------------------------ Conversation view ------------------------------ */
async function openConv(id) {
  active = id;
  const c = convs.get(id);
  $('#app').classList.add('in-chat');
  $('#empty').classList.add('hidden'); $('#pane').classList.remove('hidden');
  $('#c-title').textContent = title(c);
  updateSub();
  if (!msgs.has(id)) msgs.set(id, await api('GET', `/conversations/${id}/messages`));
  renderMsgs(true); renderTyping(); renderList();
  markRead(); $('#text').focus({ preventScroll: true });
}
function updateSub() {
  const c = convs.get(active); if (!c) return;
  $('#c-sub').textContent = c.type === 'group'
    ? c.members.map(m => m.username).join(', ')
    : (online.has(other(c).id) ? 'Online' : 'Offline');
}
$('#back').onclick = () => { $('#app').classList.remove('in-chat'); active = null; renderList(); };

function renderMsgs(forceBottom) {
  const box = $('#msgs'), c = convs.get(active), list = msgs.get(active) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.replaceChildren();
  let lastDay = '';
  let myLast = null;
  for (const m of list) if (m.senderId === me.id && !m.deleted) myLast = m;
  for (const m of list) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { box.append(el('div', 'day', day === new Date().toDateString() ? 'Today' : day)); lastDay = day; }
    const mine = m.senderId === me.id;
    const d = el('div', 'msg' + (mine ? ' mine' : '') + (m.deleted ? ' deleted' : ''));
    if (c.type === 'group' && !mine) { const w = el('span', 'who', m.senderName); w.style.color = `hsl(${hue(m.senderName)} 50% 32%)`; d.append(w); }
    if (m.deleted) d.append('Message deleted');
    else {
      if (m.file) d.append(fileNode(m.file));
      if (m.body) d.append(m.body);
      d.append(el('span', 't', fmtTime(m.createdAt) + (m.editedAt ? ' · edited' : '')));
      if (mine && !m.file) {
        const t = el('div', 'tools');
        const ed = el('button', null, 'Edit'), del = el('button', null, 'Delete');
        ed.onclick = () => { const v = prompt('Edit message', m.body); if (v && v.trim() && v !== m.body) send({ type: 'edit', cid: active, id: m.id, body: v }); };
        del.onclick = () => { if (confirm('Delete this message for everyone?')) send({ type: 'delete', cid: active, id: m.id }); };
        t.append(ed, del); d.append(t);
      } else if (mine) {
        const t = el('div', 'tools'), del = el('button', null, 'Delete');
        del.onclick = () => { if (confirm('Delete this file for everyone?')) send({ type: 'delete', cid: active, id: m.id }); };
        t.append(del); d.append(t);
      }
    }
    box.append(d);
    if (m === myLast) {
      const others = c.members.filter(x => x.id !== me.id && x.username !== 'Assistant');
      if (others.length && others.every(x => x.lastRead >= m.id)) box.append(el('div', 'seen', c.type === 'dm' ? 'Seen' : 'Seen by everyone'));
    }
  }
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}
function fileNode(f) {
  if (f.mime.startsWith('image/')) { const i = el('img'); i.src = f.url; i.alt = f.name; i.loading = 'lazy'; return i; }
  if (f.mime.startsWith('audio/')) { const a = el('audio'); a.controls = true; a.src = f.url; return a; }
  if (f.mime.startsWith('video/')) { const v = el('video'); v.controls = true; v.src = f.url; return v; }
  const a = el('a', null, f.name); a.href = f.url; a.download = f.name; return a;
}

// Load older messages when scrolling to the top
$('#msgs').onscroll = async e => {
  const box = e.target, list = msgs.get(active);
  if (box.scrollTop > 0 || !list || !list.length || list._done || list._busy) return;
  list._busy = true;
  const older = await api('GET', `/conversations/${active}/messages?before=${list[0].id}`).catch(() => []);
  list._busy = false;
  if (!older.length) { list._done = true; return; }
  const h = box.scrollHeight;
  list.unshift(...older); renderMsgs(false);
  box.scrollTop = box.scrollHeight - h;
};

function markRead() {
  const c = convs.get(active), list = msgs.get(active);
  if (!c || !list || !list.length || document.hidden) return;
  const lastId = list[list.length - 1].id;
  const mineRead = c.members.find(m => m.id === me.id);
  if (c.unread || (mineRead && mineRead.lastRead < lastId)) {
    c.unread = 0; if (mineRead) mineRead.lastRead = lastId;
    send({ type: 'read', cid: active, messageId: lastId });
    renderList();
  }
}
document.addEventListener('visibilitychange', markRead);

/* ------------------------------ Typing ------------------------------ */
function renderTyping() {
  const m = typingNow.get(active);
  const names = m ? [...m.values()].map(v => v.name) : [];
  $('#typing').textContent = names.length ? names.join(', ') + (names.length > 1 ? ' are typing…' : ' is typing…') : '';
}
let iTyping = false, typingOff;
$('#text').oninput = e => {
  const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  if (!iTyping) { iTyping = true; send({ type: 'typing', cid: active, on: true }); }
  clearTimeout(typingOff);
  typingOff = setTimeout(() => { iTyping = false; send({ type: 'typing', cid: active, on: false }); }, 2000);
};

/* ------------------------------ Sending ------------------------------ */
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendText() {
  const t = $('#text'), body = t.value.trim();
  if (!body || !active) return;
  send({ type: 'send', cid: active, body });
  t.value = ''; t.style.height = 'auto';
  clearTimeout(typingOff); iTyping = false; send({ type: 'typing', cid: active, on: false });
}
$('#send').onclick = sendText;
$('#text').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };

async function upload(blob, name) {
  if (!active) return;
  const r = await fetch(`/api/upload?cid=${active}&name=${encodeURIComponent(name)}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: blob
  });
  if (!r.ok) alert((await r.json().catch(() => ({}))).error || 'Upload failed.');
}
$('#attach').onclick = () => $('#file').click();
$('#file').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) await upload(f, f.name); };

let recorder = null, chunks = [];
$('#rec').onclick = async () => {
  const btn = $('#rec');
  if (recorder) { recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream); chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const type = recorder.mimeType || 'audio/webm';
      recorder = null; btn.title = 'Record voice note'; btn.classList.remove('rec');
      const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
      await upload(new Blob(chunks, { type }), `voice-note.${ext}`);
    };
    recorder.start(); btn.title = 'Stop recording'; btn.classList.add('rec');
  } catch { alert('Microphone access was blocked.'); }
};

/* ------------------------------ WebSocket ------------------------------ */
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const conn = $('#conn');
  ws.onopen = async () => {
    conn.textContent = 'connected'; conn.classList.add('on');
    // Re-sync anything missed while offline
    await loadConversations();
    if (active && convs.has(active)) { msgs.delete(active); await openConv(active); }
  };
  ws.onclose = () => {
    conn.textContent = 'reconnecting…'; conn.classList.remove('on');
    if (wantSocket) setTimeout(connect, 1500);
  };
  ws.onmessage = ev => handle(JSON.parse(ev.data));
}

function handle(d) {
  switch (d.type) {
    case 'hello': online.clear(); d.online.forEach(id => online.add(id)); renderList(); updateSub(); break;
    case 'presence': d.online ? online.add(d.userId) : online.delete(d.userId); renderList(); updateSub(); break;
    case 'conversation': convs.set(d.conversation.id, d.conversation); renderList(); break;
    case 'message': onMessage(d.message); break;
    case 'update': {
      const list = msgs.get(d.message.cid);
      if (list) { const i = list.findIndex(m => m.id === d.message.id); if (i > -1) list[i] = d.message; }
      const c = convs.get(d.message.cid); if (c && c.last && c.last.id === d.message.id) c.last = d.message;
      if (active === d.message.cid) renderMsgs(false);
      renderList(); break;
    }
    case 'read': {
      const c = convs.get(d.cid), m = c && c.members.find(x => x.id === d.userId);
      if (m) m.lastRead = Math.max(m.lastRead, d.messageId);
      if (active === d.cid) renderMsgs(false);
      break;
    }
    case 'typing': {
      if (d.userId === me.id) break;
      let m = typingNow.get(d.cid); if (!m) typingNow.set(d.cid, m = new Map());
      const prev = m.get(d.userId); if (prev) clearTimeout(prev.timer);
      if (d.on) m.set(d.userId, { name: d.username, timer: setTimeout(() => { m.delete(d.userId); renderTyping(); }, 4000) });
      else m.delete(d.userId);
      if (active === d.cid) renderTyping();
      break;
    }
  }
}

function onMessage(m) {
  let c = convs.get(m.cid);
  if (!c) { loadConversations(); return; }
  c.last = m;
  const list = msgs.get(m.cid);
  if (list && !list.some(x => x.id === m.id)) list.push(m);
  const mine = m.senderId === me.id;
  const tm = typingNow.get(m.cid); if (tm) { tm.delete(m.senderId); if (active === m.cid) renderTyping(); }
  if (mine) {
    const self = c.members.find(x => x.id === me.id); if (self) self.lastRead = m.id;
  } else if (active === m.cid && !document.hidden) {
    // read immediately
  } else {
    c.unread++;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted')
      new Notification(m.senderName + ' · ' + title(c), { body: m.file ? 'Sent ' + m.file.name : m.body });
  }
  if (active === m.cid) { renderMsgs(mine); markRead(); }
  renderList();
}

/* ------------------------------ Groups ------------------------------ */
const picked = new Map();
$('#new-group').onclick = () => {
  picked.clear(); $('#g-name').value = ''; $('#g-find').value = ''; $('#g-err').textContent = '';
  $('#g-results').replaceChildren(); renderPicked(); $('#group-dlg').showModal();
};
function renderPicked() {
  const box = $('#g-picked'); box.replaceChildren();
  for (const [id, name] of picked) {
    const b = el('button', 'chip', name + ' ×'); b.type = 'button';
    b.onclick = () => { picked.delete(id); renderPicked(); };
    box.append(b);
  }
}
let gTimer;
$('#g-find').oninput = () => {
  clearTimeout(gTimer);
  gTimer = setTimeout(async () => {
    const q = $('#g-find').value.trim(), box = $('#g-results'); box.replaceChildren();
    if (!q) return;
    for (const u of await api('GET', '/users?q=' + encodeURIComponent(q))) {
      const b = el('button', 'chip', u.username); b.type = 'button';
      b.onclick = () => { picked.set(u.id, u.username); renderPicked(); };
      box.append(b);
    }
  }, 200);
};
$('#g-create').onclick = async () => {
  try {
    const c = await api('POST', '/conversations/group', { name: $('#g-name').value, memberIds: [...picked.keys()] });
    convs.set(c.id, c); $('#group-dlg').close(); renderList(); openConv(c.id);
  } catch (e) { $('#g-err').textContent = e.message; }
};

/* ------------------------------ Boot ------------------------------ */
(async () => {
  try { me = await api('GET', '/me'); await startApp(); }
  catch { showAuth(); }
})();
