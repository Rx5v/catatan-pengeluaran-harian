// api/webhook.js

require('dotenv').config(); // Untuk development lokal

const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb'); // Impor MongoClient dan ObjectId

// Buat instance MongoClient di scope global
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

let client = null; // Ini akan menjadi instance MongoClient
let db = null;      // Ini akan menjadi instance Database
let isDbConnected = false; // Flag untuk status koneksi
let connectionPromise = null;

async function connectDb() {
    // Jika sudah terhubung, langsung keluar
    if (isDbConnected && client && client.topology.isConnected()) {
        console.log('[DB] Already connected to MongoDB. Reusing existing connection.');
        return;
    }

    // Jika ada promise koneksi yang sedang berjalan, tunggu saja promise itu selesai
    if (connectionPromise) {
        console.log('[DB] Connection attempt already in progress. Waiting for it to complete.');
        try {
            await connectionPromise; // Tunggu promise yang sedang berjalan
            // Setelah promise selesai, periksa lagi apakah sudah terhubung
            if (isDbConnected && client && client.topology.isConnected()) {
                return;
            }
        } catch (e) {
            console.error('[DB ERROR] Waiting for existing connection promise failed:', e.message);
            connectionPromise = null; // Reset promise jika gagal
        }
    }
    
    // Jika masih belum terhubung atau ada masalah, buat promise koneksi baru
    if (!isDbConnected || !client || !client.topology.isConnected()) {
        connectionPromise = (async () => { // Bungkus logika koneksi dalam sebuah promise
            try {
                console.log('[DB] Attempting to create a new MongoDB client and connect...');
                client = new MongoClient(uri, {
                    serverSelectionTimeoutMS: 5000 
                });

                await client.connect(); 
                db = client.db(dbName);
                isDbConnected = true;
                console.log('[DB] Successfully connected to MongoDB Atlas.');

                client.on('error', (err) => {
                    console.error('[DB ERROR] MongoDB client connection error:', err.message);
                    isDbConnected = false; 
                    if (client && client.topology.isConnected()) {
                        client.close().catch(e => console.error('Error closing client on error:', e));
                    }
                });
                return true; // Sukses
            } catch (err) {
                console.error('[DB ERROR] Failed to establish new connection to MongoDB Atlas:', err.message);
                isDbConnected = false;
                client = null; // Reset client agar bisa dibuat ulang
                db = null; // Reset db
                throw err; // Lempar error agar bisa ditangkap oleh await
            } finally {
                connectionPromise = null; // Hapus promise setelah selesai (baik sukses maupun gagal)
            }
        })();
        await connectionPromise; // Tunggu promise koneksi baru
    }
}

// Inisialisasi bot (tanpa polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// Panggil connectDb saat awal load modul (sekali per cold start)
connectDb();


// --- Logika Penanganan Pesan ---

// Fungsi utilitas untuk memproses pengguna (insert/update)
async function ensureUser(userFromMsg) {
     await connectDb(); 
    if (!isDbConnected || !db) {
        throw new Error('Database connection is not available for ensureUser.');
    }

    try {
        const usersCollection = db.collection('users'); // Dapatkan koleksi users
        
        // FindOneAndUpdate adalah seperti UPSERT: temukan dan perbarui, atau sisipkan jika tidak ada
        const result = await usersCollection.findOneAndUpdate(
            { telegram_id: userFromMsg.id.toString() }, // Query untuk menemukan user
            { 
                $set: { // Update bidang yang mungkin berubah
                    first_name: userFromMsg.first_name,
                    last_name: userFromMsg.last_name,
                    username: userFromMsg.username
                },
                $setOnInsert: { // Set ini hanya saat dokumen baru disisipkan
                    join_date: new Date()
                }
            },
            { upsert: true, returnDocument: 'after' } // upsert: true akan menyisipkan jika tidak ditemukan; returnDocument: 'after' mengembalikan dokumen setelah update
        );
        
        return result.value._id; // Mengembalikan MongoDB _id sebagai user ID internal
    } catch (error) {
        console.error('Error ensuring user:', error.message);
        throw error;
    }
}

// Perintah /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[BOT] Received /start command from chat ID: ${chatId}`);
    try {
        await ensureUser(msg.from);
        console.log(`[BOT] User ${msg.from.id} ensured in DB.`);

        const replyKeyboard = { // Pastikan Anda memiliki definisi ini
            keyboard: [
                [{ text: '➕ Catat Pengeluaran' }],
                [{ text: '🗓️ Pengeluaran Hari Ini' }, { text: '📜 Riwayat Pengeluaran' }],
                [{ text: 'ℹ️ Bantuan' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false,
        };

        await bot.sendMessage(chatId, `Halo ${msg.from.first_name || 'pengguna'}! Saya bot pencatat pengeluaran Anda.
Silakan pilih menu di bawah atau ketik perintah langsung:`, {
            reply_markup: replyKeyboard
        });
        console.log(`[BOT] Sent /start response to chat ID: ${chatId}`);

    } catch (error) {
        console.error(`[BOT ERROR] Error in /start command for chat ID ${chatId}:`, error.message);
        await bot.sendMessage(chatId, 'Maaf, terjadi kesalahan. Silakan coba lagi nanti.');
    }
});

// Perintah /add <jumlah> <deskripsi> [kategori]
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
        if (!isDbConnected || !db) { // Periksa lagi sebelum query penting
            console.warn('[DB WARNING] Database not connected for /add. Attempting to reconnect...');
            await connectDb();
            if (!isDbConnected || !db) {
                 throw new Error('Database connection failed for /add command.');
            }
        }

        const userId = await ensureUser(msg.from); // Dapatkan MongoDB _id sebagai user ID internal
        const expensesCollection = db.collection('expenses'); // Dapatkan koleksi expenses

        await expensesCollection.insertOne({
            userId: userId, // Simpan ObjectId dari user
            amount: amount,
            description: description,
            category: category,
            transaction_date: new Date(), // Simpan sebagai objek Date
            created_at: new Date()
        });
        
        const inlineKeyboard = { /* ... definisi inline keyboard Anda ... */ };

        await bot.sendMessage(chatId, `✅ Pengeluaran "${description}" sebesar Rp ${amount.toLocaleString('id-ID')} (${category}) berhasil dicatat!`, {
            reply_markup: inlineKeyboard
        });
        console.log(`[BOT] Expense added for user ${userId}: ${description} (${amount})`);

    } catch (dbError) {
        console.error('Error adding expense:', dbError.message);
        await bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mencatat pengeluaran Anda. Silakan coba lagi.');
    }
});

// Perintah /today
bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    try {
        if (!isDbConnected || !db) { // Periksa koneksi
            await connectDb();
            if (!isDbConnected || !db) { throw new Error('DB not ready for /today.'); }
        }
        
        const userId = await ensureUser(msg.from);
        const expensesCollection = db.collection('expenses');

        // Untuk query tanggal "hari ini", kita perlu rentang waktu dari awal hari hingga akhir hari
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Mulai hari ini
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1); // Besok awal hari

        const res = await expensesCollection.find({
            userId: userId,
            transaction_date: {
                $gte: today, // Greater than or equal to
                $lt: tomorrow // Less than
            }
        }).sort({ created_at: -1 }).toArray(); // Urutkan dari terbaru, konversi ke array

        if (res.length === 0) {
            await bot.sendMessage(chatId, 'Anda belum mencatat pengeluaran hari ini.');
            return;
        }

        let totalToday = 0;
        let summary = 'Pengeluaran Anda hari ini:\n\n';
        res.forEach(exp => {
            totalToday += parseFloat(exp.amount);
            summary += `• Rp ${exp.amount.toLocaleString('id-ID')} (${exp.category}): ${exp.description}\n`;
        });

        summary += `\nTotal hari ini: *Rp ${totalToday.toLocaleString('id-ID')}*`;
        await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    } catch (dbError) {
        console.error('Error fetching today\'s expenses:', dbError.message);
        await bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil data pengeluaran hari ini.');
    }
});

// Perintah /history
bot.onText(/\/history/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();

    try {
        if (!isDbConnected || !db) { // Periksa koneksi
            await connectDb();
            if (!isDbConnected || !db) { throw new Error('DB not ready for /history.'); }
        }

        const userId = await ensureUser(msg.from);
        const expensesCollection = db.collection('expenses');

        const res = await expensesCollection.find({
            userId: userId
        }).sort({ transaction_date: -1, created_at: -1 }).limit(5).toArray(); // Ambil 5 pengeluaran terakhir

        if (res.length === 0) {
            await bot.sendMessage(chatId, 'Anda belum mencatat pengeluaran apa pun.');
            return;
        }

        let history = '5 Pengeluaran terakhir Anda:\n\n';
        res.forEach(exp => {
            // Format tanggal yang disimpan sebagai objek Date
            const date = new Date(exp.transaction_date).toLocaleDateString('id-ID', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
            history += `- ${date}: Rp ${exp.amount.toLocaleString('id-ID')} (${exp.category}): ${exp.description}\n`;
        });
        await bot.sendMessage(chatId, history);

    } catch (dbError) {
        console.error('Error fetching history:', dbError.message);
        await bot.sendMessage(chatId, '❌ Maaf, terjadi kesalahan saat mengambil riwayat pengeluaran.');
    }
});


// ... (handler lainnya dan callback_query) ...


// --- Handler untuk Vercel Serverless Function ---
module.exports = async (req, res) => {
    console.log('[VERCEL] Webhook function invoked.');

    // Segera kirim respons 200 OK ke Telegram.
    res.status(200).send('OK');
    console.log('[VERCEL] Sent 200 OK response to Telegram.');

    // Proses update dari Telegram di latar belakang secara asynchronous
    if (req.method === 'POST') {
        console.log('[VERCEL] Processing Telegram update asynchronously...');
        // Tidak perlu await connectDb() di sini lagi secara eksplisit,
        // karena bot.processUpdate akan memicu handler onText/onMessage
        // yang di dalamnya sudah memanggil await connectDb()
        try {
            bot.processUpdate(req.body);
            console.log('[VERCEL] Update processed by bot listeners (asynchronously).');
        } catch (error) {
            console.error('[VERCEL ERROR] Error during bot.processUpdate:', error.message);
        }
    } else {
        console.log('[VERCEL] Method Not Allowed for this request.');
    }
};