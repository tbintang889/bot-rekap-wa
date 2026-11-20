const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Telegraf, Markup } = require('telegraf');
const { openMemory, TAGS } = require('./memory');
const { ask, buildPrompt } = require('./llm');
const { analyzeMessage } = require('./analysis');

const help = `Bot Dantoking siap.
/pesan — 10 pesan terbaru
/pesan ID — lihat pesan asal
/cari kata — cari pesan
/ajari aturan — pratinjau ajaran, lalu konfirmasi
/ajaran [kata] — lihat ajaran aktif
/lupakan ID — nonaktifkan ajaran
/koreksi ID tag alasan — perbaiki kategori pesan
/jadikan ID — jadikan pesan yang dikoreksi sebagai contoh ajaran
/analisis ID — analisis ulang pesan dengan ajaran terbaru
/tanya pertanyaan — jawab dengan pencarian chat dan rujukan
/rangkum — ringkasan hari ini
Tag: hr, klien, pribadi, promo.
Contoh: /koreksi 245 hr Undangan tes rekrutmen`;

function createBot(memory, llm = ask, analyzer = analyzeMessage) {
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  const args = ctx => ctx.message.text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  const reply = async (ctx, text) => {
    const value = String(text);
    for (let i = 0; i < value.length; i += 3500) await ctx.reply(value.slice(i, i + 3500));
  };
  const pending = new Map();
  const busy = new Set();
  const format = r => `Pesan #${r.id} | ${r.created_at} | ${r.tag}\n${r.content}`;
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    const owner = memory.getSetting('owner');
    if (!owner) {
      const match = ctx.message?.text?.match(/^\/pasang(?:@\w+)?\s+(\S+)$/);
      if (match && memory.claim(match[1], ctx.from.id)) {
        try { await ctx.deleteMessage(); } catch {}
        return reply(ctx, 'Akun kamu terpasang sebagai pemilik.\n\n' + help);
      }
      return ctx.reply('Bot belum dipasangkan. Gunakan /pasang KODE dari pengelola Termux.');
    }
    if (String(ctx.from.id) !== owner) return ctx.reply('Bot ini hanya untuk pemiliknya.');
    return next();
  });
  const preview = async (ctx, content, source = null) => {
    if (!content || content.length > 1600) return ctx.reply('Isi ajaran harus 1–1600 karakter.');
    const key = require('crypto').randomBytes(8).toString('hex');
    pending.set(key, { content, source, expires: Date.now() + 600000 });
    for (const [id, item] of pending) if (item.expires < Date.now()) pending.delete(id);
    return ctx.reply(`Pratinjau ajaran:\n${content}\n\nPastikan tidak bertentangan dengan /ajaran. Jika mengganti aturan, nonaktifkan aturan lama lewat /lupakan ID.`,
      Markup.inlineKeyboard([Markup.button.callback('Simpan', `teach:${key}`), Markup.button.callback('Batal', `cancel:${key}`)]));
  };
  bot.action(/^(teach|cancel):([a-f0-9]+)$/, async ctx => {
    const [, action, key] = ctx.match;
    const item = pending.get(key);
    pending.delete(key);
    if (!item || item.expires < Date.now()) return ctx.answerCbQuery('Pratinjau kedaluwarsa. Ulangi perintah.');
    if (action === 'teach') {
      const id = memory.teach(item.content, ctx.from.id, item.source);
      await ctx.answerCbQuery('Tersimpan');
      await ctx.editMessageText(`Ajaran #${id} tersimpan:\n${item.content}`);
    } else {
      await ctx.answerCbQuery('Dibatalkan');
      await ctx.editMessageText('Ajaran dibatalkan.');
    }
  });
  bot.start(ctx => reply(ctx, help));
  bot.help(ctx => reply(ctx, help));
  bot.command('ajari', ctx => preview(ctx, args(ctx)));
  bot.command('ajaran', ctx => {
    const all = memory.listTeachings(args(ctx));
    return reply(ctx, all.length ? all.slice(0, 50).map(r => `#${r.id}: ${r.content}`).join('\n\n') + (all.length > 50 ? '\nGunakan /ajaran kata untuk mempersempit hasil.' : '') : 'Belum ada ajaran aktif yang cocok.');
  });
  bot.command('lupakan', ctx => {
    const id = Number(args(ctx));
    return ctx.reply(Number.isSafeInteger(id) && id > 0 && memory.forget(id)
      ? `Ajaran #${id} dinonaktifkan. Hasil analisis lama tetap ada; gunakan /analisis ID untuk menilai pesan lagi.` : 'Ajaran aktif tidak ditemukan. Gunakan /lupakan ID.');
  });
  bot.command('pesan', ctx => {
    if (!args(ctx)) return reply(ctx, memory.latest().map(format).join('\n\n') || 'Belum ada pesan.');
    const row = memory.getMessage(Number(args(ctx)));
    return reply(ctx, row ? format(row) : 'Pesan tidak ditemukan. Gunakan /pesan ID.');
  });
  bot.command('cari', ctx => {
    if (!args(ctx)) return ctx.reply('Contoh: /cari interview');
    return reply(ctx, memory.search(args(ctx), 10).map(format).join('\n\n') || 'Belum ada pesan yang cocok. Coba kata lain.');
  });
  bot.command('koreksi', ctx => {
    const match = args(ctx).match(/^(\d+)\s+(hr|klien|pribadi|promo)(?:\s+([\s\S]+))?$/i);
    if (!match) return ctx.reply('Gunakan /koreksi ID tag alasan. Tag: ' + TAGS.join(', '));
    try {
      memory.correct(Number(match[1]), match[2].toLowerCase(), match[3] || '', ctx.from.id);
      return ctx.reply(`Pesan #${match[1]} dikoreksi menjadi ${match[2].toLowerCase()}.\nKoreksi ini hanya untuk pesan tersebut. Gunakan /jadikan ${match[1]} jika ingin menyimpan contoh ajaran.`);
    } catch (e) { return ctx.reply(e.message); }
  });
  bot.command('jadikan', ctx => {
    const row = memory.getMessage(Number(args(ctx)));
    if (!row) return ctx.reply('Gunakan /jadikan ID_PESAN.');
    const correction = memory.db.prepare('SELECT * FROM corrections WHERE message_id=? ORDER BY id DESC LIMIT 1').get(row.id);
    if (!correction) return ctx.reply('Koreksi pesan ini dahulu dengan /koreksi ID tag alasan.');
    return preview(ctx, `Contoh klasifikasi: ${row.content.slice(0, 1000)}\nKategori yang benar: ${row.tag}. Alasan: ${correction.reason || 'Koreksi pemilik'}. Ini contoh kontekstual, bukan aturan untuk semua pesan.`, row.id);
  });
  const generate = async (ctx, question, rows, save) => {
    if (!rows.length) return ctx.reply('Belum ada pesan yang cocok. Coba /cari kata atau /pesan.');
    if (busy.has(ctx.from.id)) return ctx.reply('Permintaan sebelumnya masih diproses.');
    busy.add(ctx.from.id);
    try {
      await ctx.sendChatAction('typing');
      const result = await llm(buildPrompt(memory, question, memory.context(rows)));
      if (save) save(result);
      await reply(ctx, result);
      await ctx.reply('Pesan sumber: ' + rows.map(r => `#${r.id}`).join(', ') + '\nBuka dengan /pesan ID.');
    } finally { busy.delete(ctx.from.id); }
  };
  bot.command('tanya', ctx => {
    const question = args(ctx);
    if (!question) return ctx.reply('Contoh: /tanya Ada undangan interview apa saja?');
    return generate(ctx, question, memory.search(question));
  });
  bot.command('analisis', async ctx => {
    const row = memory.getMessage(Number(args(ctx)));
    if (!row) return ctx.reply('Gunakan /analisis ID_PESAN.');
    if (busy.has(ctx.from.id)) return ctx.reply('Permintaan sebelumnya masih diproses.');
    busy.add(ctx.from.id);
    try {
      await ctx.sendChatAction('typing');
      const result = await analyzer(row, memory.context([row]));
      memory.saveStructuredAnalysis(row.id, result, JSON.stringify(result));
      const lines = [
        `Analisis Pesan #${row.id}`,
        `Kategori: ${result.category}`,
        `Tahap: ${result.stage || 'belum diketahui'}`,
        `Metode: ${result.method || 'belum diketahui'}`,
        `Perusahaan: ${result.company || 'belum diketahui'}`,
        `Posisi: ${result.position || 'belum diketahui'}`,
        `Jadwal: ${result.scheduled_at || 'belum diketahui'}`,
        `Lokasi/link: ${result.location || 'belum diketahui'}`,
        `Tindakan: ${result.action || 'belum diketahui'}`,
        `Status: ${result.status || 'belum diketahui'}`,
        `Keyakinan: ${Math.round(result.confidence * 100)}%`,
        result.notes ? `Catatan: ${result.notes}` : null
      ].filter(Boolean).join('\n');
      await reply(ctx, lines);
      await ctx.reply(`Sumber: #${row.id}\nTag database saat ini: ${row.tag}`);
    } catch (error) {
      await ctx.reply(error.message || 'Analisis gagal. Coba lagi nanti.');
    } finally { busy.delete(ctx.from.id); }
  });
  bot.command('rangkum', ctx => {
    const zone = process.env.BOT_TIMEZONE || 'Asia/Jakarta';
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
    return generate(ctx, `Rangkum pesan tanggal ${date} (${zone}), pisahkan HR, klien, pribadi, promo. Sebutkan batas cakupan data.`, memory.today(date, zone), result => {
      memory.db.prepare('INSERT INTO summaries(date,type,summary,created_at) VALUES (?,?,?,?)').run(date, 'harian', result, new Date().toISOString());
    });
  });
  bot.catch(async (_error, ctx) => {
    console.error('Permintaan bot gagal; rincian sensitif tidak dicatat.');
    try { await ctx.reply('Permintaan gagal diproses. Coba lagi; untuk ajaran/koreksi periksa format lewat /help.'); } catch {}
  });
  return bot;
}

if (require.main === module) {
  const memory = openMemory(path.join(__dirname, 'db/data.db'));
  const bot = createBot(memory);
  bot.launch().catch(() => { console.error('Koneksi Telegram gagal.'); process.exit(1); });
  console.log('Bot memori dan pencarian aktif; pemasangan pemilik diperlukan jika belum diatur.');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
module.exports = { createBot };
