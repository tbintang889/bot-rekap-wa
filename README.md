# Dantoking System

Sistem asisten pribadi untuk pengelolaan, pencarian, dan analisis pesan WhatsApp dengan antarmuka Telegram bot dan dashboard web. Dibangun untuk dijalankan di Termux.

## Fitur

- **Pengumpulan pesan WhatsApp** — melalui Baileys dengan sinkronisasi riwayat, disimpan ke SQLite dengan pencarian teks lengkap (FTS5).
- **Tag otomatis** — pesan otomatis dikategorikan: `hr`, `klien`, `pribadi`, `promo`.
- **Telegram Bot** — lihat pesan terbaru, cari, koreksi tag, ajari aturan klasifikasi, analisis AI, dan ringkasan harian.
- **Dashboard Web** — Express API dengan antarmuka untuk memantau statistik, pesan, kontak, analisis, ajaran, dan koreksi.
- **Analisis AI** — klasifikasi pesan dengan Gemini atau Groq (fallback otomatis).
- **Jadwal otomatis** — pengambilan pesan WhatsApp tiap pagi, siang, dan malam melalui `node-cron`.

## Struktur Proyek

```
dantoking-system/
├── bot.js              # Telegram bot (Telegraf)
├── collector.js        # Pengambil pesan WhatsApp (Baileys)
├── dashboard.js        # API dashboard (Express)
├── scheduler.js        # Jadwal pengambilan pesan (node-cron)
├── llm.js              # Klien AI (Gemini / Groq)
├── memory.js           # Database SQLite dan logika memori
├── analysis.js         # Analisis terstruktur pesan
├── ecosystem.config.js # Konfigurasi PM2
├── .env                # Variabel lingkungan (buat sendiri)
├── .gitignore
├── db/                 # Folder database SQLite (diabaikan git)
├── wa-auth/            # Sesi autentikasi WhatsApp (diabaikan git)
├── public/             # Frontend dashboard
│   ├── index.html
│   ├── dashboard.js
│   └── dashboard.css
├── package.json
└── README.md
```

## Persyaratan

- Node.js (disarankan v18+)
- npm / yarn
- Akun WhatsApp untuk dipasangkan
- Token Bot Telegram (`@BotFather`)
- Kunci API Gemini dan/atau Groq (opsional, untuk fitur AI)

## Instalasi

```bash
# Clone repositori
git clone <url-repositori>
cd dantoking-system

# Instal dependensi
npm install
```

## Konfigurasi

Salin contoh variabel lingkungan dan isi nilainya:

```bash
cp .env.example .env  # jika tersedia, atau buat .env manual
```

Isi `.env`:

```env
GEMINI_API_KEY=KUNCI_API_GEMINI_ANDA
GROQ_API_KEY=KUNCI_API_GROQ_ANDA
TELEGRAM_BOT_TOKEN=TOKEN_BOT_TELEGRAM_ANDA
BOT_TIMEZONE=Asia/Jakarta
WA_COLLECT_SECONDS=60
```

> Jangan commit file `.env` karena berisi kunci rahasia.

## Menjalankan

### Secara manual

```bash
# Terminal 1: Bot Telegram
node bot.js

# Terminal 2: Dashboard
node dashboard.js

# Terminal 3: Scheduler
node scheduler.js
```

### Dengan PM2 (disarankan)

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

## Pemasangan WhatsApp

Collector memerlukan sesi WhatsApp yang dipasangkan melalui QR code.

1. Jalankan mode login:
   ```bash
   node collector.js login
   ```
2. Scan QR code yang muncul dengan WhatsApp > Perangkat tertaut > Tautkan perangkat.
3. Setelah tersambung, tekan `Ctrl+C` untuk menyimpan sesi dan keluar.

Untuk mengambil riwayat pesan:

```bash
node collector.js tarik
```

Parameter `WA_COLLECT_SECONDS` menentukan berapa lama collector berjalan untuk menarik riwayat (default 60 detik).

## Pemasangan Pemilik Telegram Bot

Bot hanya dapat digunakan oleh pemilik yang terdaftar. Kode klaim dihasilkan secara otomatis saat pertama kali dijalankan.

1. Jalankan bot:
   ```bash
   node bot.js
   ```
2. Lihat log untuk menemukan kode klaim, atau gunakan perintah yang diberikan oleh pengelola Termux.
3. Kirim di obrolan pribadi bot:
   ```
   /pasang KODE
   ```
4. Setelah terpasang, gunakan `/help` untuk melihat daftar perintah.

## Perintah Telegram Bot

| Perintah | Keterangan |
|----------|------------|
| `/start`, `/help` | Tampilkan bantuan dan daftar perintah |
| `/pesan` | Lihat 10 pesan terbaru |
| `/pesan ID` | Lihat isi pesan berdasarkan ID |
| `/cari kata` | Cari pesan berdasarkan kata kunci |
| `/ajari aturan` | Pratinjau dan simpan ajaran klasifikasi baru |
| `/ajaran [kata]` | Lihat ajaran aktif yang cocok |
| `/lupakan ID` | Nonaktifkan ajaran berdasarkan ID |
| `/koreksi ID tag alasan` | Perbaiki kategori pesan (tag: hr, klien, pribadi, promo) |
| `/jadikan ID` | Jadikan pesan yang dikoreksi sebagai contoh ajaran |
| `/analisis ID` | Analisis ulang pesan dengan AI |
| `/tanya pertanyaan` | Jawab pertanyaan berdasarkan data chat |
| `/rangkum` | Ringkasan pesan hari ini |

## Endpoint Dashboard API

Dashboard berjalan di `http://127.0.0.1:3000`.

| Endpoint | Metode | Keterangan |
|----------|--------|------------|
| `/api/stats` | GET | Statistik pesan dan ajaran |
| `/api/activity?days=7` | GET | Aktivitas harian |
| `/api/messages?page=1&limit=25&tag=hr&q=kata` | GET | Daftar pesan dengan filter |
| `/api/messages/:id` | GET | Detail pesan dan analisis |
| `/api/analyses?limit=20` | GET | Daftar analisis terbaru |
| `/api/contacts?page=1&limit=50&q=&type=&saved=` | GET | Daftar kontak |
| `/api/contacts/:jid/messages` | GET | Pesan dari kontak tertentu |
| `/api/summaries?limit=10` | GET | Ringkasan harian |
| `/api/teachings` | GET | Ajaran aktif |
| `/api/corrections?limit=20` | GET | Riwayat koreksi |
| `/api/status` | GET | Status sesi WhatsApp |

## Variabel Lingkungan

| Variabel | Keterangan | Default |
|----------|------------|---------|
| `GEMINI_API_KEY` | Kunci API Google Gemini | — |
| `GROQ_API_KEY` | Kunci API Groq | — |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram | — |
| `BOT_TIMEZONE` | Zona waktu bot | `Asia/Jakarta` |
| `WA_COLLECT_SECONDS` | Durasi pengambilan riwayat WA | `60` |

## Database

Database SQLite disimpan di `db/data.db`. Tabel utama:

- `messages` — pesan WhatsApp yang terkumpul
- `contacts` — kontak WhatsApp
- `teachings` — ajaran klasifikasi aktif
- `corrections` — riwayat koreksi tag
- `message_analysis` — hasil analisis AI terstruktur
- `analyses` — hasil analisis mentah
- `summaries` — ringkasan harian
- `bot_settings` — pengaturan bot (owner, kode klaim, dll.)

Folder `db/`, `wa-auth/`, dan `node_modules/` diabaikan oleh Git (lihat `.gitignore`).

## Lisensi

Private.
