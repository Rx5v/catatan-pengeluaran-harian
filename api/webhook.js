require('dotenv').config(); // Muat variabel lingkungan dari .env (hanya untuk pengembangan lokal)

const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');

// Inisialisasi klien PostgreSQL untuk Supabase
// Gunakan variabel lingkungan untuk kredensial
const pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Penting untuk koneksi dari Vercel ke Supabase
});

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

// Perintah /start
bot.onText(/\/start/, async (msg) => {
    console.log("ontext: ", msg);
    
    const chatId = msg.chat.id;
    console.log("chat id: ", chatId);
    console.log("chat from: ", msg.from);
    try {
        await ensureUser(msg.from); // Pastikan pengguna terdaftar/diperbarui
        bot.sendMessage(chatId, `Halo ${msg.from.first_name || 'pengguna'}! Saya bot pencatat pengeluaran Anda.
Gunakan perintah berikut:
/add <jumlah> <deskripsi> [kategori] - Mencatat pengeluaran baru. Contoh: "/add 50000 Makan siang mie ayam"
/today - Melihat ringkasan pengeluaran hari ini.
/history - Melihat 5 pengeluaran terakhir.
`);
    } catch (error) {
        console.error('Error in /start:', error.message);
        bot.sendMessage(chatId, 'Maaf, terjadi kesalahan. Silakan coba lagi nanti.');
    }
});

// Perintah /add <jumlah> <deskripsi> [kategori]
// Regex: (\d+) untuk angka, (.+?) untuk deskripsi (non-greedy), (?: (.+))? untuk kategori opsional
bot.onText(/\/add (\d+) (.+?)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const amount = parseFloat(match[1]);
    const description = match[2].trim();
    const category = match[3] ? match[3].trim() : 'Lain-lain'; // Default kategori jika tidak ada

    if (isNaN(amount) || amount <= 0) {
        bot.sendMessage(chatId, 'Jumlah pengeluaran tidak valid. Format: /add <jumlah> <deskripsi> [kategori]');
        return;
    }
    if (!description) {
        bot.sendMessage(chatId, 'Deskripsi pengeluaran tidak boleh kosong. Format: /add <jumlah> <deskripsi> [kategori]');
        return;
    }

    try {
        const userId = await ensureUser(msg.from); // Dapatkan ID internal pengguna

        await pgClient.query(
            `INSERT INTO expenses (user_id, amount, description, category, transaction_date)
             VALUES ($1, $2, $3, $4, CURRENT_DATE);`,
            [userId, amount, description, category]
        );
        bot.sendMessage(chatId, `✅ Pengeluaran "${description}" sebesar Rp ${amount.toLocaleString('id-ID')} (${category}) berhasil dicatat!`);

    } catch (dbError) {
        console.error('Error adding expense:', dbError.message);
        bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mencatat pengeluaran Anda. Silakan coba lagi.');
    }
});

// Perintah /today
bot.onText(/\/today/, async (msg) => {
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
        bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' }); // Gunakan Markdown untuk format bold
    } catch (dbError) {
        console.error('Error fetching today\'s expenses:', dbError.message);
        bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil data pengeluaran hari ini.');
    }
});

// Perintah /history
bot.onText(/\/history/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    try {
        const userId = await ensureUser(msg.from);
        const res = await pgClient.query(
            `SELECT amount, description, category, transaction_date
             FROM expenses
             WHERE user_id = $1
             ORDER BY transaction_date DESC, created_at DESC
             LIMIT 5;`, // Ambil 5 pengeluaran terakhir
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
        console.error('Error fetching history:', dbError.message);
        bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil riwayat pengeluaran.');
    }
});

// Perintah lain atau pesan yang tidak dikenali
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Hanya merespons jika bukan perintah yang ditangani di atas
    if (!text.startsWith('/') && text.length > 0) {
        bot.sendMessage(chatId, 'Maaf, saya tidak mengerti perintah itu. Ketik /start untuk melihat daftar perintah.');
    }
});

// --- Handler untuk Vercel Serverless Function ---
module.exports = async (req, res) => {
    // Pastikan koneksi DB aktif sebelum memproses request
    await connectDb();
    console.log("method: ", req.method);
    console.log("body: ", req.body);
    
    if (req.method === 'POST') {
        // Proses update yang diterima dari Telegram
        bot.processUpdate(req.body);
        res.status(200).send('OK'); // Penting untuk mengirim respons 200 OK ke Telegram
    } else {
        res.status(405).send('Method Not Allowed');
    }
};