const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN

const bot = new TelegramBot(token, {polling: true});

bot.on('message', (msg) => {

var Hi = "hi";
if (msg.text.toString().toLowerCase().indexOf(Hi) === 0) {
bot.sendMessage(msg.chat.id,"Hello dear user");
}

});
bot.onText(/\/start/, (msg) => {

bot.sendMessage(msg.chat.id, "Welcome", {
"reply_markup": {
    "keyboard": [["Sample text", "Second sample"],   ["Keyboard"], ["I'm robot"]]
    }
});

});
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        // Proses update yang diterima dari Telegram
        bot.processUpdate(req.body);
        res.status(200).send('OK'); // Penting untuk mengirim respons 200 OK ke Telegram
    } else {
        res.status(405).send('Method Not Allowed');
    }
};