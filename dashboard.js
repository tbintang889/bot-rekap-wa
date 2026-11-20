require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const db = new Database(path.join(__dirname, 'db/data.db'), { readonly: true });
db.pragma('busy_timeout = 5000');
const zone = process.env.BOT_TIMEZONE || 'Asia/Jakarta';

app.use(express.static(path.join(__dirname, 'public')));

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
}

function safeLimit(value, fallback = 25) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 100) : fallback;
}

function safePage(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(n, 1) : 1;
}

app.get('/api/stats', (_req, res) => {
  const totals = db.prepare(`SELECT count(*) AS total,
    sum(CASE WHEN tag='hr' THEN 1 ELSE 0 END) AS hr,
    sum(CASE WHEN tag='klien' THEN 1 ELSE 0 END) AS klien,
    sum(CASE WHEN tag='pribadi' THEN 1 ELSE 0 END) AS pribadi,
    sum(CASE WHEN tag='promo' THEN 1 ELSE 0 END) AS promo,
    sum(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) AS today
    FROM messages`).get();
  const teachings = db.prepare('SELECT count(*) AS n FROM teachings WHERE active=1').get()?.n || 0;
  const corrections = db.prepare('SELECT count(*) AS n FROM corrections').get()?.n || 0;
  const latest = db.prepare('SELECT id, created_at FROM messages ORDER BY created_at DESC,id DESC LIMIT 1').get() || null;
  res.json({ ...totals, teachings, corrections, latest, timezone: zone });
});

app.get('/api/activity', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
  const rows = db.prepare(`SELECT date(created_at) AS date, count(*) AS total,
    sum(CASE WHEN tag='hr' THEN 1 ELSE 0 END) AS hr,
    sum(CASE WHEN tag='klien' THEN 1 ELSE 0 END) AS klien,
    sum(CASE WHEN tag='pribadi' THEN 1 ELSE 0 END) AS pribadi,
    sum(CASE WHEN tag='promo' THEN 1 ELSE 0 END) AS promo
    FROM messages WHERE date(created_at) >= date('now', ?)
    GROUP BY date(created_at) ORDER BY date(created_at)`).all(`-${days - 1} days`);
  res.json({ days, rows });
});

app.get('/api/messages', (req, res) => {
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit);
  const tag = ['hr', 'klien', 'pribadi', 'promo'].includes(req.query.tag) ? req.query.tag : '';
  const q = String(req.query.q || '').trim().slice(0, 100);
  const where = [];
  const params = [];
  if (tag) { where.push('m.tag=?'); params.push(tag); }
  if (q) { where.push('(m.content LIKE ? OR m.sender LIKE ? OR CAST(m.id AS TEXT)=?)'); params.push(`%${q}%`, `%${q}%`, q); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) AS n FROM messages m ${clause}`).get(...params).n;
  const rows = db.prepare(`SELECT m.id,m.source,m.sender,m.content,m.created_at,m.tag,
    c.name AS contact_name,c.notify_name,c.push_name,c.phone,c.is_group
    FROM messages m LEFT JOIN contacts c ON c.jid=m.sender ${clause} ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  res.json({ rows, page, limit, total, pages: Math.ceil(total / limit) });
});

app.get('/api/messages/:id', (req, res) => {
  const row = db.prepare(`SELECT m.*,c.name AS contact_name,c.notify_name,c.push_name,c.phone,c.is_group,
    a.category AS analysis_category,a.stage AS analysis_stage,a.method AS analysis_method,a.company AS analysis_company,
    a.position AS analysis_position,a.scheduled_at AS analysis_scheduled_at,a.location AS analysis_location,
    a.action AS analysis_action,a.status AS analysis_status,a.confidence AS analysis_confidence,a.notes AS analysis_notes,a.updated_at AS analysis_updated_at
    FROM messages m LEFT JOIN contacts c ON c.jid=m.sender LEFT JOIN message_analysis a ON a.message_id=m.id WHERE m.id=?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Pesan tidak ditemukan' });
  res.json(row);
});

app.get('/api/analyses', (req, res) => {
  res.json(db.prepare(`SELECT a.*,m.content,m.sender,m.created_at AS message_created_at
    FROM message_analysis a JOIN messages m ON m.id=a.message_id ORDER BY a.updated_at DESC LIMIT ?`).all(safeLimit(req.query.limit, 20)));
});

app.get('/api/contacts', (req, res) => {
  const limit = safeLimit(req.query.limit, 50);
  const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const type = req.query.type === 'group' ? 1 : req.query.type === 'person' ? 0 : null;
  const saved = req.query.saved === 'yes' ? 1 : req.query.saved === 'no' ? 0 : null;
  const where = [], params = [];
  if (q) { where.push('(c.name LIKE ? OR c.notify_name LIKE ? OR c.push_name LIKE ? OR c.phone LIKE ? OR c.jid LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
  if (type !== null) { where.push('c.is_group=?'); params.push(type); }
  if (saved !== null) { where.push('c.is_saved=?'); params.push(saved); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) AS n FROM contacts c ${clause}`).get(...params).n;
  const rows = db.prepare(`SELECT c.*,count(m.id) AS message_count,max(m.created_at) AS last_message
    FROM contacts c LEFT JOIN messages m ON m.sender=c.jid ${clause}
    GROUP BY c.id ORDER BY last_message DESC,c.name,c.jid LIMIT ? OFFSET ?`).all(...params,limit,offset);
  res.json({ rows, total, page: Math.floor(offset / limit) + 1, limit, pages: Math.ceil(total / limit) });
});

app.get('/api/contacts/:jid/messages', (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  const rows = db.prepare(`SELECT m.*,c.name AS contact_name,c.notify_name,c.push_name,c.phone,c.is_group
    FROM messages m LEFT JOIN contacts c ON c.jid=m.sender WHERE m.sender=? ORDER BY m.created_at DESC,m.id DESC LIMIT 100`).all(jid);
  res.json(rows);
});

app.get('/api/summaries', (req, res) => {
  res.json(db.prepare('SELECT * FROM summaries ORDER BY id DESC LIMIT ?').all(safeLimit(req.query.limit, 10)));
});

app.get('/api/teachings', (_req, res) => {
  res.json(db.prepare('SELECT id,content,created_at,source_message_id FROM teachings WHERE active=1 ORDER BY id DESC LIMIT 100').all());
});

app.get('/api/corrections', (req, res) => {
  res.json(db.prepare(`SELECT c.*,m.content FROM corrections c LEFT JOIN messages m ON m.id=c.message_id
    ORDER BY c.id DESC LIMIT ?`).all(safeLimit(req.query.limit, 20)));
});

app.get('/api/status', (_req, res) => {
  let session = false;
  try { session = fs.existsSync(path.join(__dirname, 'wa-auth', 'creds.json')); } catch {}
  const latest = db.prepare('SELECT created_at FROM messages WHERE source=\'wa\' ORDER BY created_at DESC LIMIT 1').get();
  res.json({ collector: session ? 'scheduled' : 'not_paired', session, latestMessage: latest?.created_at || null, timezone: zone });
});

app.listen(3000, '127.0.0.1', () => console.log('Dashboard jalan di http://localhost:3000'));
