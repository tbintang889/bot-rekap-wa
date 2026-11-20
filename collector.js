require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, normalizeMessageContent } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

function tagOtomatis(teks) {
  const t = teks.toLowerCase();
  if (['interview', 'lamaran', 'hrd', 'cv'].some(k => t.includes(k))) return 'hr';
  if (['harga', 'landing', 'project', 'bayar'].some(k => t.includes(k))) return 'klien';
  if (['diskon', 'promo'].some(k => t.includes(k))) return 'promo';
  return 'pribadi';
}

async function main() {
  const mode = process.argv[2];
  if (!['login', 'tarik'].includes(mode)) throw new Error('Gunakan: node collector.js login|tarik');
  const lock = path.join(__dirname, 'wa-auth', '.collector.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid > 0) {
      try { process.kill(pid, 0); throw new Error('Collector/login lain masih aktif. Tutup dengan Ctrl+C dahulu.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  process.once('exit', () => { try { fs.unlinkSync(lock); } catch {} });

  const db = new Database(path.join(__dirname, 'db/data.db'));
  db.pragma('busy_timeout = 5000');
  if (!db.pragma('table_info(messages)').some(c => c.name === 'wa_message_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN wa_message_id TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_unique ON messages(source, sender, wa_message_id)');
  db.exec('CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT UNIQUE NOT NULL, phone TEXT, name TEXT, notify_name TEXT, push_name TEXT, is_saved INTEGER NOT NULL DEFAULT 0, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS contacts_phone ON contacts(phone)');
  db.exec('CREATE INDEX IF NOT EXISTS contacts_name ON contacts(name)');
  const insert = db.prepare('INSERT OR IGNORE INTO messages (source, sender, content, created_at, tag, wa_message_id) VALUES (?, ?, ?, ?, ?, ?)');
  const upsertContact = db.prepare(`INSERT INTO contacts (jid,phone,name,notify_name,push_name,is_saved,is_group,updated_at)
    VALUES (@jid,@phone,@name,@notify_name,@push_name,@is_saved,@is_group,@updated_at)
    ON CONFLICT(jid) DO UPDATE SET
      phone=COALESCE(excluded.phone,contacts.phone),
      name=COALESCE(excluded.name,contacts.name),
      notify_name=COALESCE(excluded.notify_name,contacts.notify_name),
      push_name=COALESCE(excluded.push_name,contacts.push_name),
      is_saved=MAX(contacts.is_saved,excluded.is_saved),
      is_group=MAX(contacts.is_group,excluded.is_group),
      updated_at=excluded.updated_at`);
  const saveContact = (jid, data = {}) => {
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const name = data.name || data.verifiedName || null;
    const notifyName = data.notify || data.notifyName || null;
    const pushName = data.pushName || null;
    upsertContact.run({
      jid,
      phone: jid.endsWith('@s.whatsapp.net') ? jid.replace('@s.whatsapp.net', '') : null,
      name, notify_name: notifyName, push_name: pushName,
      is_saved: name ? 1 : 0, is_group: jid.endsWith('@g.us') ? 1 : 0,
      updated_at: new Date().toISOString()
    });
  };
  const saveGroupNames = async sock => {
    const groups = db.prepare("SELECT jid FROM contacts WHERE is_group=1").all();
    for (const { jid } of groups) {
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata?.subject) saveContact(jid, { name: metadata.subject });
      } catch { /* Grup yang tidak bisa dibaca tetap tampil dengan JID. */ }
    }
  };
  const counts = { received: 0, saved: 0, duplicates: 0, skipped: 0, historyBatches: 0 };
  const store = db.transaction(messages => {
    for (const msg of messages) {
      counts.received++;
      const sender = msg.key?.remoteJid;
      saveContact(sender, { pushName: msg.pushName });
      if (msg.key?.participant) saveContact(msg.key.participant, { pushName: msg.pushName });
      const content = normalizeMessageContent(msg.message);
      const text = content?.conversation || content?.extendedTextMessage?.text || content?.imageMessage?.caption || content?.videoMessage?.caption;
      if (!sender || sender === 'status@broadcast' || sender.endsWith('@newsletter') || !msg.key?.id || !text) {
        counts.skipped++;
        continue;
      }
      const seconds = Number(msg.messageTimestamp);
      const date = seconds > 0 && Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date();
      const result = insert.run('wa', sender, text, date.toISOString(), tagOtomatis(text), msg.key.id);
      if (result.changes) counts.saved++; else counts.duplicates++;
    }
  });
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'wa-auth'));
  if (mode === 'tarik' && !state.creds.me) throw new Error('WA belum dipasangkan. Jalankan login dahulu.');
  let sock, ending = false, connected = false, retries = 0, durationTimer;
  let saves = Promise.resolve();
  const finish = async code => {
    if (ending) return;
    ending = true;
    clearTimeout(durationTimer);
    clearTimeout(deadline);
    sock?.end(undefined);
    await saves;
    db.close();
    console.log('Hasil collector:', JSON.stringify({ connected, ...counts }));
    process.exitCode = code;
    setTimeout(() => process.exit(code), 300);
  };
  const deadline = setTimeout(() => { console.error('Batas waktu collector tercapai.'); finish(1); }, 180000);
  process.once('SIGINT', () => finish(0));
  process.once('SIGTERM', () => finish(0));
  function connect() {
    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false
    });
    sock.ev.on('creds.update', () => {
      saves = saves.then(saveCreds).catch(() => { console.error('Gagal menyimpan sesi WA.'); finish(1); });
    });
    sock.ev.on('contacts.upsert', contacts => {
      for (const contact of contacts) saveContact(contact.id || contact.jid, contact);
    });
    sock.ev.on('contacts.update', contacts => {
      for (const contact of contacts) saveContact(contact.id || contact.jid, contact);
    });
    const handle = messages => {
      try { store(messages); }
      catch { console.error('Gagal menyimpan pesan WA.'); finish(1); }
    };
    sock.ev.on('messages.upsert', event => handle(event.messages));
    sock.ev.on('messaging-history.set', event => {
      counts.historyBatches++;
      handle(event.messages || []);
    });
    sock.ev.on('connection.update', update => {
      if (ending) return;
      if (update.qr) {
        if (mode === 'tarik') { console.error('Sesi perlu dipasangkan ulang: jalankan login.'); finish(1); return; }
        console.log('Scan QR: WhatsApp > Perangkat tertaut > Tautkan perangkat');
        qrcode.generate(update.qr, { small: true });
      }
      if (update.connection === 'open') {
        connected = true;
        console.log('WA tersambung. Menunggu pesan dan sinkronisasi.');
        saveGroupNames(sock).catch(() => {});
        if (mode === 'tarik') {
          const seconds = Math.max(30, Math.min(120, Number(process.env.WA_COLLECT_SECONDS) || 60));
          clearTimeout(durationTimer);
          durationTimer = setTimeout(() => finish(0), seconds * 1000);
        } else console.log('Pemasangan berhasil. Tekan Ctrl+C untuk selesai.');
      }
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.restartRequired && retries++ < 2) connect();
        else { console.error('Koneksi WA ditutup. Kode:', code || 'tidak diketahui'); finish(1); }
      }
    });
  }
  connect();
}

main().catch(error => { console.error(error.message); process.exit(1); });
