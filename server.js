'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Minimal .env loader (no extra dependency)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const express = require('express');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_UPLOAD = 10 * 1024 * 1024;
const SESSION_MS = 7 * 24 * 3600 * 1000;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------ Database ------------------------------ */
const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('dm','group')),
  name TEXT,
  dm_key TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text',
  file_name TEXT, file_key TEXT, file_mime TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
`);

// Built-in AI participant. Its hash can never match a password, so it cannot log in.
const AI_NAME = 'Assistant';
db.prepare('INSERT OR IGNORE INTO users (username, pass_hash, created_at) VALUES (?,?,?)').run(AI_NAME, '!', Date.now());
const AI_ID = db.prepare('SELECT id FROM users WHERE username=?').get(AI_NAME).id;

/* ------------------------------ Helpers ------------------------------ */
const parseCookies = (h = '') =>
  Object.fromEntries(h.split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));

function userFromCookie(cookieHeader) {
  const token = parseCookies(cookieHeader).sid;
  if (!token) return null;
  return db.prepare(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).get(token, Date.now()) || null;
}

const isMember = (cid, uid) => !!db.prepare('SELECT 1 FROM members WHERE conversation_id=? AND user_id=?').get(cid, uid);
const memberIds = cid => db.prepare('SELECT user_id FROM members WHERE conversation_id=?').all(cid).map(r => r.user_id);

function msgJson(r) {
  return {
    id: r.id, cid: r.conversation_id, senderId: r.sender_id, senderName: r.username,
    body: r.deleted ? '' : r.body, kind: r.kind, deleted: !!r.deleted,
    file: r.file_key && !r.deleted ? { url: '/files/' + r.file_key, name: r.file_name, mime: r.file_mime } : null,
    createdAt: r.created_at, editedAt: r.edited_at
  };
}
const getMsg = id => msgJson(db.prepare(
  'SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(id));

function convJson(cid, uid) {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(cid);
  const members = db.prepare(
    'SELECT u.id, u.username, m.last_read_id AS lastRead FROM members m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=?').all(cid);
  const last = db.prepare(
    'SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE conversation_id=? ORDER BY m.id DESC LIMIT 1').get(cid);
  const me = members.find(m => m.id === uid);
  const unread = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND id>? AND sender_id!=? AND deleted=0').get(cid, me ? me.lastRead : 0, uid).n;
  return { id: c.id, type: c.type, name: c.name, members, last: last ? msgJson(last) : null, unread, createdAt: c.created_at };
}

/* ------------------------------ Realtime ------------------------------ */
const sockets = new Map(); // userId -> Set<ws>
const sendTo = (userIds, obj) => {
  const data = JSON.stringify(obj);
  for (const id of userIds) for (const ws of sockets.get(id) || []) if (ws.readyState === 1) ws.send(data);
};
const broadcastAll = obj => sendTo([...sockets.keys()], obj);
const onlineIds = () => [...sockets.keys()];

/* ------------------------------ App ------------------------------ */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Tiny in-memory rate limiter for auth endpoints
const hits = new Map();
const limiter = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  arr.push(now); hits.set(k, arr); next();
};

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, Date.now() + SESSION_MS);
  res.set('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${PROD ? '; Secure' : ''}`);
}

app.post('/api/register', limiter(10, 60000), (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  if (username.toLowerCase() === AI_NAME.toLowerCase()) return res.status(400).json({ error: 'That username is reserved.' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return res.status(409).json({ error: 'That username is taken.' });
  const info = db.prepare('INSERT INTO users (username,pass_hash,created_at) VALUES (?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), Date.now());
  startSession(res, info.lastInsertRowid);
  res.json({ id: Number(info.lastInsertRowid), username });
});

app.post('/api/login', limiter(10, 60000), (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username));
  if (!u || !bcrypt.compareSync(String(password), u.pass_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  startSession(res, u.id);
  res.json({ id: u.id, username: u.username });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.set('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  // Close any live sockets for this session
  res.json({ ok: true });
});

// Everything below needs a logged-in user
const auth = (req, res, next) => {
  const u = userFromCookie(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Please sign in.' });
  req.user = u; next();
};

app.get('/api/me', auth, (req, res) => res.json({ ...req.user, aiId: AI_ID, aiEnabled: !!process.env.ANTHROPIC_API_KEY }));

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').replace(/[%_]/g, '');
  const rows = db.prepare('SELECT id, username FROM users WHERE id!=? AND username LIKE ? ORDER BY username LIMIT 20')
    .all(req.user.id, q + '%');
  res.json(rows.map(r => ({ ...r, online: onlineIds().includes(r.id) })));
});

app.get('/api/conversations', auth, (req, res) => {
  const ids = db.prepare('SELECT conversation_id id FROM members WHERE user_id=?').all(req.user.id).map(r => r.id);
  const stamp = c => c.last ? c.last.createdAt : c.createdAt;
  const list = ids.map(id => convJson(id, req.user.id)).sort((a, b) => stamp(b) - stamp(a));
  res.json({ conversations: list, online: onlineIds() });
});

app.post('/api/conversations/dm', auth, (req, res) => {
  const other = Number(req.body?.userId);
  if (!other || other === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id=?').get(other))
    return res.status(400).json({ error: 'Pick another user.' });
  const key = [req.user.id, other].sort((a, b) => a - b).join(':');
  let c = db.prepare('SELECT id FROM conversations WHERE dm_key=?').get(key);
  if (!c) {
    const info = db.prepare('INSERT INTO conversations (type,dm_key,created_by,created_at) VALUES (?,?,?,?)')
      .run('dm', key, req.user.id, Date.now());
    c = { id: Number(info.lastInsertRowid) };
    const ins = db.prepare('INSERT INTO members (conversation_id,user_id) VALUES (?,?)');
    ins.run(c.id, req.user.id); ins.run(c.id, other);
    for (const uid of [req.user.id, other]) sendTo([uid], { type: 'conversation', conversation: convJson(c.id, uid) });
  }
  res.json(convJson(c.id, req.user.id));
});

app.post('/api/conversations/group', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const ids = [...new Set([req.user.id, ...(req.body?.memberIds || []).map(Number)])]
    .filter(id => db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
  if (!name) return res.status(400).json({ error: 'Give the group a name.' });
  if (ids.length < 2) return res.status(400).json({ error: 'Add at least one other member.' });
  const info = db.prepare('INSERT INTO conversations (type,name,created_by,created_at) VALUES (?,?,?,?)')
    .run('group', name, req.user.id, Date.now());
  const cid = Number(info.lastInsertRowid);
  const ins = db.prepare('INSERT INTO members (conversation_id,user_id) VALUES (?,?)');
  for (const id of ids) ins.run(cid, id);
  for (const uid of ids) sendTo([uid], { type: 'conversation', conversation: convJson(cid, uid) });
  res.json(convJson(cid, req.user.id));
});

app.get('/api/conversations/:id/messages', auth, (req, res) => {
  const cid = Number(req.params.id);
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not a member.' });
  const before = Number(req.query.before) || 9e15;
  const rows = db.prepare(
    'SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id WHERE conversation_id=? AND m.id<? ORDER BY m.id DESC LIMIT 50')
    .all(cid, before).reverse();
  res.json(rows.map(msgJson));
});

app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_]/g, '');
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`
    SELECT m.*, u.username FROM messages m
    JOIN users u ON u.id=m.sender_id
    JOIN members mem ON mem.conversation_id=m.conversation_id AND mem.user_id=?
    WHERE m.deleted=0 AND m.kind!='file' AND m.body LIKE ? ORDER BY m.id DESC LIMIT 30`).all(req.user.id, '%' + q + '%');
  res.json(rows.map(msgJson));
});

/* --------------------------- File upload & safety --------------------------- */
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'video/mp4'
};
const MAGIC = {
  png: b => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  jpg: b => b[0] === 0xff && b[1] === 0xd8, jpeg: b => b[0] === 0xff && b[1] === 0xd8,
  gif: b => b.subarray(0, 3).toString() === 'GIF',
  webp: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  pdf: b => b.subarray(0, 5).toString() === '%PDF-',
  txt: b => !b.subarray(0, 4096).includes(0)
};
// Returns an error string, or null if the file looks safe.
function checkFile(ext, buf) {
  if (!TYPES[ext]) return `.${ext} files are not allowed.`;
  if (!buf.length) return 'The file is empty.';
  if (MAGIC[ext] && !MAGIC[ext](buf)) return 'File contents do not match its extension.';
  // Executable signatures hiding behind a safe extension
  const head = buf.subarray(0, 4);
  if (head.subarray(0, 2).toString() === 'MZ' || head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || head.toString() === '#!/b')
    return 'Executable content is not allowed.';
  if (ext === 'pdf' && /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(buf.toString('latin1'))) return 'PDF contains active content and was blocked.';
  if (ext === 'txt' && /<\s*script/i.test(buf.toString('utf8', 0, 100000))) return 'Text file contains script tags and was blocked.';
  return null;
}

app.post('/api/upload', auth, express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
  const cid = Number(req.query.cid);
  if (!isMember(cid, req.user.id)) return res.status(403).json({ error: 'Not a member.' });
  const name = path.basename(String(req.query.name || 'file')).slice(0, 100);
  const ext = (name.split('.').pop() || '').toLowerCase();
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const err = checkFile(ext, buf);
  if (err) return res.status(400).json({ error: err });
  const key = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, key), buf);
  const info = db.prepare(
    'INSERT INTO messages (conversation_id,sender_id,kind,file_name,file_key,file_mime,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, req.user.id, 'file', name, key, TYPES[ext], Date.now());
  const msg = getMsg(info.lastInsertRowid);
  sendTo(memberIds(cid), { type: 'message', message: msg });
  res.json(msg);
});

app.get('/files/:key', auth, (req, res) => {
  const key = req.params.key;
  if (!/^[a-f0-9]{32}\.[a-z0-9]+$/.test(key)) return res.sendStatus(404);
  const m = db.prepare('SELECT * FROM messages WHERE file_key=? AND deleted=0').get(key);
  if (!m || !isMember(m.conversation_id, req.user.id)) return res.sendStatus(404);
  const inline = /^(image|audio|video)\//.test(m.file_mime);
  res.set('Content-Type', m.file_mime);
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(m.file_name)}"`);
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(path.join(UPLOAD_DIR, key));
});

/* ------------------------------ AI participant ------------------------------ */
async function aiReply(cid) {
  const members = memberIds(cid);
  const typing = on => sendTo(members, { type: 'typing', cid, userId: AI_ID, username: AI_NAME, on });
  let text;
  typing(true);
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      text = 'The AI assistant is not configured. Set ANTHROPIC_API_KEY on the server to enable it.';
    } else {
      const rows = db.prepare(
        `SELECT m.*, u.username FROM messages m JOIN users u ON u.id=m.sender_id
         WHERE conversation_id=? AND deleted=0 AND kind!='file' ORDER BY m.id DESC LIMIT 20`).all(cid).reverse();
      const turns = [];
      for (const r of rows) {
        const role = r.sender_id === AI_ID ? 'assistant' : 'user';
        const content = role === 'user' ? `${r.username}: ${r.body}` : r.body;
        if (!turns.length && role === 'assistant') continue;
        if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += '\n' + content;
        else turns.push({ role, content });
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: 800,
          system: `You are ${AI_NAME}, a friendly AI participant in a chat app called Ridge. Messages are prefixed with the sender's username. Use the conversation so far for context, answer the latest request concisely, and do not prefix your reply with your own name.`,
          messages: turns
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'AI request failed');
      text = j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '…';
    }
  } catch (e) {
    console.error('AI error:', e.message);
    text = 'Sorry, I could not answer that right now.';
  }
  typing(false);
  const info = db.prepare('INSERT INTO messages (conversation_id,sender_id,body,created_at) VALUES (?,?,?,?)')
    .run(cid, AI_ID, text, Date.now());
  sendTo(members, { type: 'message', message: getMsg(info.lastInsertRowid) });
}

const wantsAi = (cid, body) => {
  if (/(^|\s)@ai\b/i.test(body)) return true;
  const c = db.prepare('SELECT type FROM conversations WHERE id=?').get(cid);
  return c.type === 'dm' && memberIds(cid).includes(AI_ID);
};

/* ------------------------------ WebSocket ------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const user = userFromCookie(req.headers.cookie);
  if (!user || new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  // Basic same-origin check against cross-site WebSocket hijacking
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.user = user; wss.emit('connection', ws); });
});

wss.on('connection', ws => {
  const uid = ws.user.id;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const wasOnline = sockets.has(uid);
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(ws);
  if (!wasOnline) broadcastAll({ type: 'presence', userId: uid, online: true });
  ws.send(JSON.stringify({ type: 'hello', online: onlineIds() }));

  ws.on('message', raw => {
    let d; try { d = JSON.parse(raw); } catch { return; }
    const cid = Number(d.cid);
    try {
      if (!cid || !isMember(cid, uid)) return;
      const others = memberIds(cid).filter(id => id !== uid);

      if (d.type === 'send') {
        const body = String(d.body || '').trim().slice(0, 4000);
        if (!body) return;
        const info = db.prepare('INSERT INTO messages (conversation_id,sender_id,body,created_at) VALUES (?,?,?,?)')
          .run(cid, uid, body, Date.now());
        const id = Number(info.lastInsertRowid);
        db.prepare('UPDATE members SET last_read_id=? WHERE conversation_id=? AND user_id=?').run(id, cid, uid);
        sendTo([uid, ...others], { type: 'message', message: getMsg(id), tempId: d.tempId, from: uid });
        if (wantsAi(cid, body)) aiReply(cid);
      } else if (d.type === 'typing') {
        sendTo(others, { type: 'typing', cid, userId: uid, username: ws.user.username, on: !!d.on });
      } else if (d.type === 'read') {
        const id = Number(d.messageId) || 0;
        db.prepare('UPDATE members SET last_read_id=MAX(last_read_id,?) WHERE conversation_id=? AND user_id=?').run(id, cid, uid);
        sendTo(memberIds(cid), { type: 'read', cid, userId: uid, messageId: id });
      } else if (d.type === 'edit') {
        const body = String(d.body || '').trim().slice(0, 4000);
        const r = db.prepare("UPDATE messages SET body=?, edited_at=? WHERE id=? AND sender_id=? AND conversation_id=? AND kind='text' AND deleted=0")
          .run(body, Date.now(), Number(d.id), uid, cid);
        if (body && r.changes) sendTo(memberIds(cid), { type: 'update', message: getMsg(Number(d.id)) });
      } else if (d.type === 'delete') {
        const r = db.prepare('UPDATE messages SET deleted=1, body=\'\' WHERE id=? AND sender_id=? AND conversation_id=?')
          .run(Number(d.id), uid, cid);
        if (r.changes) sendTo(memberIds(cid), { type: 'update', message: getMsg(Number(d.id)) });
      }
    } catch (e) { console.error('ws error', e); }
  });

  ws.on('close', () => {
    const set = sockets.get(uid);
    if (!set) return;
    set.delete(ws);
    if (!set.size) { sockets.delete(uid); broadcastAll({ type: 'presence', userId: uid, online: false }); }
  });
});

// Drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
}, 30000);

server.listen(PORT, () => console.log(`Ridge running on http://localhost:${PORT}`));
