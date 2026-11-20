const Database = require('better-sqlite3');
const crypto = require('crypto');

const TAGS = ['hr', 'klien', 'pribadi', 'promo'];
function tokens(text) {
  const stop = new Set('apa saja yang dan atau itu ini ada saya aku kamu untuk dengan dari ke di tentang tolong apakah bagaimana kapan mana belum sudah minggu hari'.split(' '));
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => t.length > 1 && !stop.has(t)))].slice(0, 25);
}
function openMemory(filename) {
  const db = new Database(filename);
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teachings (
      id INTEGER PRIMARY KEY, content TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, author TEXT NOT NULL, source_message_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, old_tag TEXT, new_tag TEXT NOT NULL,
      reason TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE,
      category TEXT NOT NULL,
      stage TEXT,
      method TEXT,
      company TEXT,
      position TEXT,
      scheduled_at TEXT,
      location TEXT,
      action TEXT,
      status TEXT,
      confidence REAL,
      notes TEXT,
      raw_result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_analysis_category ON message_analysis(category);
    CREATE INDEX IF NOT EXISTS message_analysis_schedule ON message_analysis(scheduled_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts,rowid,content) VALUES ('delete',old.id,old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts,rowid,content) VALUES ('delete',old.id,old.content);
      INSERT INTO messages_fts(rowid,content) VALUES (new.id,new.content);
    END;
    CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at);
    CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(sender,created_at);
  `);
  const getSetting = key => db.prepare('SELECT value FROM bot_settings WHERE key=?').get(key)?.value;
  const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO bot_settings(key,value) VALUES (?,?)').run(key, String(value));
  if (!getSetting('fts_ready')) {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    setSetting('fts_ready', '1');
  }
  if (!getSetting('owner') && !getSetting('claim')) setSetting('claim', crypto.randomBytes(12).toString('hex'));
  const getMessage = id => db.prepare('SELECT * FROM messages WHERE id=?').get(id);
  const listTeachings = (query = '') => db.prepare('SELECT * FROM teachings WHERE active=1 ORDER BY id DESC').all()
    .filter(r => !query || r.content.toLowerCase().includes(query.toLowerCase()));
  const teach = (content, author, source = null) => {
    const existing = db.prepare('SELECT id FROM teachings WHERE active=1 AND content=?').get(content);
    if (existing) return Number(existing.id);
    return Number(db.prepare('INSERT INTO teachings(content,created_at,author,source_message_id) VALUES (?,?,?,?)')
      .run(content, new Date().toISOString(), String(author), source).lastInsertRowid);
  };
  const claim = db.transaction((code, user) => {
    if (getSetting('owner') || !code || code !== getSetting('claim')) return false;
    setSetting('owner', user);
    db.prepare('DELETE FROM bot_settings WHERE key=?').run('claim');
    return true;
  });
  const correct = db.transaction((id, tag, reason, author) => {
    if (!TAGS.includes(tag)) throw new Error('Tag harus hr, klien, pribadi, atau promo.');
    const row = getMessage(id);
    if (!row) throw new Error('Pesan tidak ditemukan.');
    db.prepare('INSERT INTO corrections(message_id,old_tag,new_tag,reason,author,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, row.tag, tag, reason, String(author), new Date().toISOString());
    db.prepare('UPDATE messages SET tag=? WHERE id=?').run(tag, id);
  });
  function search(query, limit = 20) {
    let terms = tokens(query);
    if (/\b(hr|interview|wawancara|psikotes|rekrutmen)\b/i.test(query)) terms.push('interview', 'wawancara', 'psikotes', 'lamaran', 'hrd', 'offering');
    if (/\bklien\b/i.test(query)) terms.push('harga', 'project', 'landing', 'bayar');
    const relevant = listTeachings().map(r => ({ r, score: tokens(r.content).filter(t => terms.includes(t)).length }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    for (const { r } of relevant) terms.push(...tokens(r.content));
    terms = [...new Set(terms)].slice(0, 45);
    if (!terms.length) return [];
    const expression = terms.map(t => '"' + t.replaceAll('"', '') + '"').join(' OR ');
    return db.prepare(`SELECT m.* FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
      WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts),m.created_at DESC LIMIT ?`).all(expression, limit);
  }
  function context(rows) {
    const result = new Map(rows.map(r => [r.id, r]));
    for (const row of rows.slice(0, 8)) {
      const nearby = db.prepare(`SELECT * FROM messages WHERE sender=? AND created_at<=?
        ORDER BY created_at DESC,id DESC LIMIT 3`).all(row.sender, row.created_at);
      for (const r of nearby) result.set(r.id, r);
    }
    return [...result.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-45);
  }
  const saveStructuredAnalysis = (messageId, analysis, rawResult) => {
    const now = new Date().toISOString();
    const data = { messageId, category: analysis.category || 'tidak_diketahui', stage: analysis.stage || null,
      method: analysis.method || null, company: analysis.company || null, position: analysis.position || null,
      scheduledAt: analysis.scheduled_at || null, location: analysis.location || null, action: analysis.action || null,
      status: analysis.status || null, confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : null,
      notes: analysis.notes || null, rawResult: rawResult || JSON.stringify(analysis), now };
    db.prepare(`INSERT INTO message_analysis (message_id,category,stage,method,company,position,scheduled_at,location,action,status,confidence,notes,raw_result,created_at,updated_at)
      VALUES (@messageId,@category,@stage,@method,@company,@position,@scheduledAt,@location,@action,@status,@confidence,@notes,@rawResult,@now,@now)
      ON CONFLICT(message_id) DO UPDATE SET category=excluded.category,stage=excluded.stage,method=excluded.method,company=excluded.company,
      position=excluded.position,scheduled_at=excluded.scheduled_at,location=excluded.location,action=excluded.action,status=excluded.status,
      confidence=excluded.confidence,notes=excluded.notes,raw_result=excluded.raw_result,updated_at=excluded.updated_at`).run(data);
    db.prepare('INSERT INTO analyses(message_id,result,created_at) VALUES (?,?,?)').run(messageId, rawResult || JSON.stringify(analysis), now);
  };
  return { db, getSetting, setSetting, claim, getMessage, listTeachings, teach, correct, search, context,
    saveStructuredAnalysis,
    getAnalysis: messageId => db.prepare('SELECT * FROM message_analysis WHERE message_id=?').get(messageId),
    latestAnalyses: (limit = 20) => db.prepare('SELECT a.*,m.content,m.created_at AS message_created_at FROM message_analysis a JOIN messages m ON m.id=a.message_id ORDER BY a.updated_at DESC LIMIT ?').all(limit),
    forget: id => db.prepare('UPDATE teachings SET active=0 WHERE id=? AND active=1').run(id).changes,
    latest: (limit = 10) => db.prepare('SELECT * FROM messages ORDER BY created_at DESC,id DESC LIMIT ?').all(limit),
    today: (date, zone) => db.prepare('SELECT * FROM messages ORDER BY created_at DESC,id DESC LIMIT 5000').all()
      .filter(r => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(r.created_at)) === date).slice(0, 50)
  };
}
module.exports = { openMemory, tokens, TAGS };
