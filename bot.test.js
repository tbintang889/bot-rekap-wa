const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { openMemory } = require('./memory');
const { createBot } = require('./bot');

function fixture() {
  // Use one in-memory database connection; create the existing collector schema first.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,source TEXT,sender TEXT,content TEXT,created_at TEXT,tag TEXT);
    CREATE TABLE summaries(id INTEGER PRIMARY KEY,date TEXT,type TEXT,summary TEXT,created_at TEXT);`);
  return db;
}

test('persistent teaching, correction, FTS triggers and owner access', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dantoking-test-'));
  const filename = path.join(dir, 'test.db');
  const initial = fixture();
  await initial.backup(filename);
  initial.close();
  const memory = openMemory(filename);
  try {
    const put = memory.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)');
    put.run(1, 'wa', 'chat-a', 'Undangan wawancara onsite besok', '2026-11-20T01:00:00.000Z', 'pribadi');
    put.run(2, 'wa', 'chat-a', 'Jam dipindah ke 14.00', '2026-11-20T02:00:00.000Z', 'pribadi');
    put.run(3, 'wa', 'chat-b', 'Meeting online harga website', '2026-11-20T03:00:00.000Z', 'klien');
    assert.equal(memory.claim('wrong', 42), false);
    assert.equal(memory.claim(memory.getSetting('claim'), 42), true);
    assert.equal(memory.claim('anything', 77), false);
    assert.equal(memory.getSetting('claim'), undefined);
    const id = memory.teach('Wawancara dan assessment termasuk HR', '42');
    assert.equal(memory.teach('Wawancara dan assessment termasuk HR', '42'), id);
    assert.equal(memory.search('HR interview').some(r => r.id === 1), true);
    memory.correct(1, 'hr', 'Undangan rekrutmen', 42);
    assert.equal(memory.getMessage(1).tag, 'hr');
    assert.equal(memory.db.prepare('SELECT count(*) AS n FROM corrections').get().n, 1);
    assert.throws(() => memory.correct(99, 'hr', '', 42), /tidak ditemukan/);
    assert.throws(() => memory.correct(1, 'unknown', '', 42), /Tag harus/);
    assert.equal(memory.getMessage(1).content, 'Undangan wawancara onsite besok');
    assert.equal(memory.context([memory.getMessage(2)]).some(r => r.id === 1), true);
    assert.equal(memory.context([memory.getMessage(2)]).some(r => r.id === 3), false);
    memory.db.prepare('UPDATE messages SET content=? WHERE id=3').run('Pembayaran invoice unik');
    assert.equal(memory.search('invoice')[0].id, 3);
    assert.deepEqual(memory.search('website'), []);
    memory.db.prepare('DELETE FROM messages WHERE id=3').run();
    assert.deepEqual(memory.search('invoice'), []);
    assert.doesNotThrow(() => memory.search('" OR (NEAR *) SELECT'));
    assert.equal(memory.forget(id), 1);
    assert.equal(memory.forget(id), 0);
    assert.equal(memory.listTeachings().length, 0);

    const answers = [];
    const prompts = [];
    const bot = createBot(memory, async prompt => { prompts.push(prompt); return 'Kategori HR [Pesan #1]'; }, async () => ({
      category: 'HR', stage: 'interview', method: 'online', company: 'Contoh', position: 'Admin',
      scheduled_at: null, location: 'Google Meet', action: 'Konfirmasi', status: 'perlu_tindakan', confidence: 0.95, notes: null
    }));
    bot.botInfo = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot' };
    const original = require('telegraf').Telegram.prototype.callApi;
    require('telegraf').Telegram.prototype.callApi = async function(method, payload) {
      answers.push({ method, ...payload });
      return { message_id: 100 };
    };
    let updateId = 0;
    const command = (user, text) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: user, type: 'private' },
      from: { id: user, is_bot: false, first_name: 'User' }, text,
      entities: [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }]
    } });
    try {
      await command(77, '/pesan 1');
      assert.equal(answers.at(-1).text, 'Bot ini hanya untuk pemiliknya.');
      assert.equal(answers.some(a => a.text?.includes('Undangan')), false);
      await command(42, '/ajari Psikotes termasuk HR');
      const preview = answers.at(-1);
      assert.match(preview.text, /Pratinjau/);
      assert.equal(memory.listTeachings().length, 0);
      const callback = preview.reply_markup.inline_keyboard[0][0].callback_data;
      await bot.handleUpdate({ update_id: ++updateId, callback_query: {
        id: 'cb1', from: { id: 42, is_bot: false, first_name: 'User' }, data: callback,
        chat_instance: 'test', message: { message_id: 100, date: 1, chat: { id: 42, type: 'private' } }
      } });
      assert.equal(memory.listTeachings().length, 1);
      await command(42, '/analisis 1');
      assert.equal(prompts.length, 0);
      assert.equal(memory.db.prepare('SELECT count(*) AS n FROM analyses').get().n, 1);
      assert.equal(memory.getMessage(1).tag, 'hr');
      await command(42, '/koreksi 2 hr Konteks wawancara');
      assert.equal(memory.getMessage(2).tag, 'hr');
      await command(42, '/jadikan 2');
      assert.match(answers.at(-1).text, /Pratinjau ajaran/);
      assert.equal(memory.listTeachings().length, 1, 'corrections and previews do not silently create rules');
    } finally { require('telegraf').Telegram.prototype.callApi = original; }
    memory.db.close();
    const reopened = openMemory(filename);
    assert.equal(reopened.getSetting('owner'), '42');
    assert.equal(reopened.listTeachings().length, 1);
    assert.equal(reopened.getMessage(2).tag, 'hr');
    reopened.db.close();
  } finally {
    if (memory.db.open) memory.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
