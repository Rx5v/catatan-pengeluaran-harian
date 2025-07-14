// api/webhook.js

require('dotenv').config(); // Untuk development lokal

const TelegramBot = require('node-telegram-bot-api');

// Inisialisasi bot (tanpa polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token);

// Perintah /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`[BOT] Received /start command from chat ID: ${chatId}`);
    try {
        console.log('[BOT] Attempting to ensure user...'); // <-- NEW LOG
        // await ensureUser(msg.from);
        
        console.log(`[BOT] User ${msg.from.id} ensured in DB.`); // <-- NEW LOG
        const replyKeyboard = { // Pastikan ini terdefinisi dengan benar
            keyboard: [
                [{ text: '➕ Catat Pengeluaran' }],
                [{ text: '🗓️ Pengeluaran Hari Ini' }, { text: '📜 Riwayat Pengeluaran' }],
                [{ text: 'ℹ️ Bantuan' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false,
        };

        console.log('[BOT] Attempting to send message with keyboard...'); // <-- NEW LOG
        await bot.sendMessage(msg.chat.id, "Welcome", {
        reply_markup: replyKeyboard
        });
        console.log('[BOT] OK');
        
    } catch (error) {
        console.error(`[BOT ERROR] Error in /start command for chat ID ${chatId}:`, error.message);
        await bot.sendMessage(chatId, 'Maaf, terjadi kesalahan. Silakan coba lagi nanti.');
    }
});
module.exports = async (req, res) => {
    console.log('[VERCEL] Webhook function invoked.');
    res.status(200).send('OK');
     console.log('[VERCEL] Sent 200 OK response to Telegram (DB ready).');

    // Proses update dari Telegram di latar belakang secara asynchronous
    if (req.method === 'POST') {
        console.log('[VERCEL] Processing Telegram update asynchronously...');
        try {
            // bot.processUpdate akan memicu event listeners bot.
            // Handler bot sekarang akan mengasumsikan 'db' sudah siap.
            bot.processUpdate(req.body)
            console.log('[VERCEL] Update processed by bot listeners (asynchronously).');
            
        } catch (error) {
            console.error('[VERCEL ERROR] Error during bot.processUpdate:', error.message);
        }
    } else {
        console.log('[VERCEL] Method Not Allowed for this request.');
    }
};