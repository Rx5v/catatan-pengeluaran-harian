require('dotenv').config(); // Muat variabel lingkungan dari .env (hanya untuk pengembangan lokal)

const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');

// Inisialisasi klien PostgreSQL untuk Supabase
// Gunakan variabel lingkungan untuk kredensial
const pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Penting untuk koneksi dari Vercel ke Supabase
});
let isConnected = false
let isDbConnected = pgClient._connected;

// Fungsi untuk menghubungkan ke database
async function connectDb() {
    // Jika sudah terhubung, tidak perlu melakukan apa-apa lagi
    if (isDbConnected) {
        console.log('[DB] Already connected to Supabase. Reusing existing connection.');
        return;
    }

    // Cek apakah klien saat ini memiliki koneksi aktif yang bisa didaur ulang
    // Ini adalah pengecekan yang lebih robust sebelum mencoba connect()
    // Properti _connected dan _connecting adalah internal, tapi sering digunakan untuk ini
    if (pgClient._connected === true || pgClient._connecting === true) {
        console.log('[DB] Client instance is already in a connected/connecting state. Setting isDbConnected to true.');
        isDbConnected = true; // Anggap sudah terhubung, hindari panggil connect()
        return;
    }

    // Jika klien tidak terhubung dan tidak sedang dalam proses koneksi,
    // coba untuk mengakhiri (end) klien yang mungkin rusak dari invocasi sebelumnya
    // dan buat klien baru.
    // PENTING: Untuk menghindari "Client has already been connected"
    // kita akan membuat instance Client *baru* jika yang lama bermasalah,
    // atau jika belum ada koneksi. Ini lebih aman.

    // === Pendekatan yang Lebih Aman: Membuat Instance Klien Baru ===
    // Ini mencegah masalah "reuse a client" dengan selalu memulai dengan klien baru
    // jika yang lama tidak terhubung atau terdeteksi dalam keadaan aneh.
    // Namun, ini *mungkin* sedikit meningkatkan cold start karena membuat objek baru.

    try {
        console.log('[DB] No active connection found. Attempting to create a new client and connect...');
        // Jika belum terhubung, kita membuat instance Client baru dan menghubungkannya
        // Ini memastikan kita tidak mencoba connect() pada klien yang sudah di-end atau rusak
        const newPgClient = new Client({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
        await newPgClient.connect();
        
        // Ganti instance klien global dengan yang baru yang sudah terhubung
        Object.assign(pgClient, newPgClient); // Copy properties dari newPgClient ke pgClient
        isDbConnected = true; // Set flag menjadi true
        console.log('[DB] Successfully established a new connection to PostgreSQL.');

        // Tambahkan event listener untuk error koneksi
        pgClient.on('error', (err) => {
            console.error('[DB ERROR] Client connection error:', err.message);
            isDbConnected = false; // Set flag false jika ada error di koneksi aktif
            // Tidak perlu end() di sini, biarkan garbage collector membersihkan jika koneksi benar-benar mati
        });

    } catch (err) {
        console.error('[DB ERROR] Failed to establish new connection:', err.message);
        isDbConnected = false; // Set flag menjadi false jika gagal
        // Jangan re-throw di sini, biarkan proses berlanjut, error akan ditangani di query
    }
}


// Inisialisasi bot Telegram dengan mode webhook (tanpa polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token); // Mode webhook, tidak perlu { polling: true }

connectDb();
// --- Logika Penanganan Pesan ---

// Fungsi utilitas untuk memproses pengguna (insert/update)
async function ensureUser(userFromMsg) {
    if (!isDbConnected) {
        console.warn('[DB WARNING] Database not connected. Attempting to reconnect for query...');
        await connectDb(); // Coba hubungkan lagi jika terputus
        if (!isDbConnected) { // Jika setelah reconnect masih gagal
            throw new Error('Database connection failed for ensureUser.');
        }
    }
    
    try {
        const res = await pgClient.query(
            `INSERT INTO users (telegram_id, first_name, last_name, username)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (telegram_id) DO UPDATE SET
                 first_name = EXCLUDED.first_name,
                 last_name = EXCLUDED.last_name,
                 username = EXCLUDED.username
             RETURNING id;`,
            [userFromMsg.id.toString(), userFromMsg.first_name, userFromMsg.last_name, userFromMsg.username]
        );
        return res.rows[0].id;
    } catch (error) {
        console.error('Error ensuring user:', error.message);
        throw error;
    }
}
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await ensureUser(msg.from); // Pastikan pengguna terdaftar/diperbarui

        // Opsi untuk Reply Keyboard
        const replyKeyboard = {
            keyboard: [
                [{ text: '➕ Catat Pengeluaran' }], // Baris 1, Tombol 1
                [{ text: '🗓️ Pengeluaran Hari Ini' }, { text: '📜 Riwayat Pengeluaran' }], // Baris 2, Tombol 1 & 2
                [{ text: 'ℹ️ Bantuan' }] // Baris 3, Tombol 1
            ],
            resize_keyboard: true, // Membuat keyboard lebih kecil
            one_time_keyboard: false, // Keyboard akan tetap ada setelah digunakan
            // selective: true // Hanya tampilkan keyboard untuk pengguna tertentu (opsional)
        };

        bot.sendMessage(chatId, `Halo ${msg.from.first_name || 'pengguna'}! Saya bot pencatat pengeluaran Anda.
Silakan pilih menu di bawah atau ketik perintah langsung:`, {
            reply_markup: replyKeyboard // Lampirkan keyboard ke pesan
        });

    } catch (error) {
        console.error('Error in /start:', error.message);
        bot.sendMessage(chatId, 'Maaf, terjadi kesalahan. Silakan coba lagi nanti.');
    }
});

// --- Tambahkan handler untuk tombol Reply Keyboard ---
// Karena tombol Reply Keyboard mengirim teks, kita tangkap teksnya
bot.onText(/➕ Catat Pengeluaran/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Silakan masukkan pengeluaran Anda dalam format: `/add <jumlah> <deskripsi> [kategori]`\nContoh: `/add 50000 Makan siang mie ayam`', { parse_mode: 'Markdown' });
});

bot.onText(/🗓️ Pengeluaran Hari Ini/, async (msg) => {
    // Panggil logika yang sama dengan perintah /today
    // Anda bisa memisahkan logika /today ke fungsi terpisah agar bisa dipanggil ulang
    // Contoh: await handleTodayCommand(msg);
    // Untuk saat ini, kita bisa memanggil ulang onText handler secara internal atau copy-paste
    // Lebih baik buat fungsi terpisah:
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    try {
        const userId = await ensureUser(msg.from);
        const res = await pgClient.query(
            `SELECT amount, description, category
             FROM expenses
             WHERE user_id = $1 AND transaction_date = CURRENT_DATE
             ORDER BY created_at DESC;`,
            [userId]
        );

        if (res.rows.length === 0) {
            bot.sendMessage(chatId, 'Anda belum mencatat pengeluaran hari ini.');
            return;
        }

        let totalToday = 0;
        let summary = 'Pengeluaran Anda hari ini:\n\n';
        res.rows.forEach(exp => {
            totalToday += parseFloat(exp.amount);
            summary += `• Rp ${exp.amount.toLocaleString('id-ID')} (${exp.category}): ${exp.description}\n`;
        });

        summary += `\nTotal hari ini: *Rp ${totalToday.toLocaleString('id-ID')}*`;
        bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    } catch (dbError) {
        console.error('Error fetching today\'s expenses from button:', dbError.message);
        bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil data pengeluaran hari ini.');
    }
});

bot.onText(/📜 Riwayat Pengeluaran/, async (msg) => {
    // Panggil logika yang sama dengan perintah /history
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    try {
        const userId = await ensureUser(msg.from);
        const res = await pgClient.query(
            `SELECT amount, description, category, transaction_date
             FROM expenses
             WHERE user_id = $1
             ORDER BY transaction_date DESC, created_at DESC
             LIMIT 5;`,
            [userId]
        );

        if (res.rows.length === 0) {
            bot.sendMessage(chatId, 'Anda belum mencatat pengeluaran apa pun.');
            return;
        }

        let history = '5 Pengeluaran terakhir Anda:\n\n';
        res.rows.forEach(exp => {
            const date = new Date(exp.transaction_date).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
            history += `- ${date}: Rp ${exp.amount.toLocaleString('id-ID')} (${exp.category}): ${exp.description}\n`;
        });
        bot.sendMessage(chatId, history);

    } catch (dbError) {
        console.error('Error fetching history from button:', dbError.message);
        bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil riwayat pengeluaran.');
    }
});

bot.onText(/ℹ️ Bantuan/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `Saya bot pencatat pengeluaran Anda.
Gunakan perintah berikut:
/add <jumlah> <deskripsi> [kategori] - Mencatat pengeluaran baru. Contoh: "/add 50000 Makan siang mie ayam"
/today - Melihat ringkasan pengeluaran hari ini.
/history - Melihat 5 pengeluaran terakhir.
`);
});

bot.onText(/\/add (\d+) (.+?)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const amount = parseFloat(match[1]);
    const description = match[2].trim();
    const category = match[3] ? match[3].trim() : 'Lain-lain';

    if (isNaN(amount) || amount <= 0 || !description) {
        await bot.sendMessage(chatId, 'Format salah. Gunakan: `/add <jumlah> <deskripsi> [kategori]`\nContoh: `/add 50000 Makan siang mie ayam`', { parse_mode: 'Markdown' });
        return;
    }

    try {
        if (!isDbConnected) { // Periksa lagi sebelum query penting
            console.warn('[DB WARNING] Database not connected for /add. Attempting to reconnect...');
            await connectDb();
            if (!isDbConnected) {
                 throw new Error('Database connection failed for /add command.');
            }
        }

        const userId = await ensureUser(msg.from); // Dapatkan ID internal pengguna

        await pgClient.query(
            `INSERT INTO expenses (user_id, amount, description, category, transaction_date)
             VALUES ($1, $2, $3, $4, CURRENT_DATE);`,
            [userId, amount, description, category]
        );
        
        const inlineKeyboard = { /* ... definisi inline keyboard Anda ... */ }; // Asumsikan Anda sudah punya ini

        await bot.sendMessage(chatId, `✅ Pengeluaran "${description}" sebesar Rp ${amount.toLocaleString('id-ID')} (${category}) berhasil dicatat!`, {
            reply_markup: inlineKeyboard
        });
        console.log(`[BOT] Expense added for user ${userId}: ${description} (${amount})`);

    } catch (dbError) {
        console.error('Error adding expense:', dbError.message);
        await bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mencatat pengeluaran Anda. Silakan coba lagi.');
    }
});


module.exports = async (req, res) => {
    console.log('[VERCEL] Webhook function invoked.');

    // Segera kirim respons 200 OK ke Telegram.
    res.status(200).send('OK');
    console.log('[VERCEL] Sent 200 OK response to Telegram.');

    // Proses update dari Telegram di latar belakang.
    // Ini penting agar tidak memblokir respons 200 OK.
    // Pastikan koneksi DB sudah ada atau coba buat lagi jika terputus.
    if (!isDbConnected) {
        console.log('[VERCEL] Database not connected yet. Attempting to connect...');
        await connectDb(); // Ini akan mencoba menyambung jika belum terhubung
    }

    if (req.method === 'POST') {
        console.log('[VERCEL] Processing Telegram update asynchronously...');
        try {
            // bot.processUpdate akan memicu event listeners bot
            // Panggil ini tanpa 'await' agar fungsi utama segera selesai
            // dan tidak memblokir respons 200 OK.
            bot.processUpdate(req.body);
            console.log('[VERCEL] Update processed by bot listeners (asynchronously).');
        } catch (error) {
            console.error('[VERCEL ERROR] Error during bot.processUpdate:', error.message);
        }
    } else {
        console.log('[VERCEL] Method Not Allowed for this request.');
    }
};