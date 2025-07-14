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

// Fungsi untuk menghubungkan ke database
async function connectDb() {
    try {
        if (!pgClient._connected) { // Hindari koneksi berulang jika sudah terhubung
            await pgClient.connect();
            console.log('Connected to PostgreSQL database (Supabase).');
        }
    } catch (err) {
        console.error('Error connecting to PostgreSQL database:', err.message);
        // Pertimbangkan strategi retry atau keluar jika koneksi vital gagal
    }
}

// Inisialisasi bot Telegram dengan mode webhook (tanpa polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token); // Mode webhook, tidak perlu { polling: true }

connectDb();
// --- Logika Penanganan Pesan ---

// Fungsi utilitas untuk memproses pengguna (insert/update)
async function ensureUser(userFromMsg) {
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
        return res.rows[0].id; // Mengembalikan ID internal pengguna dari tabel users
    } catch (error) {
        console.error('Error ensuring user:', error.message);
        throw error; // Lempar error agar bisa ditangani di pemanggil
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

module.exports = async (req, res) => {
    console.log('[VERCEL] Webhook function invoked.');

    // PENTING: Segera kirim respons 200 OK ke Telegram.
    // Ini memberitahu Telegram bahwa update sudah diterima,
    // mencegah timeout di sisi Telegram.
    res.status(200).send('OK');
    console.log('[VERCEL] Sent 200 OK response to Telegram.');

    // Sekarang, proses update dari Telegram di latar belakang.
    // Pastikan koneksi DB sudah ada atau coba buat lagi jika terputus.
    if (!isConnected) { // Periksa status koneksi
        await connectDb(); // Coba hubungkan lagi jika terputus
    }

    if (req.method === 'POST') {
        console.log('[VERCEL] Processing Telegram update asynchronously...');
        // bot.processUpdate akan memicu event listeners bot
        // Panggil ini tanpa 'await' agar fungsi utama segera selesai
        // dan tidak memblokir respons 200 OK.
        try {
            bot.processUpdate(req.body);
            console.log('[VERCEL] Update processed by bot listeners.');
        } catch (error) {
            console.error('[VERCEL ERROR] Error during bot.processUpdate:', error.message);
        }
    } else {
        // Ini akan dicatat, tapi respon sudah 200 OK sebelumnya.
        console.log('[VERCEL] Method Not Allowed for this request.');
    }
};