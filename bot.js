const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '🚀 البوت يعمل!');
});

bot.onText(/\/test/, (msg) => {
    bot.sendMessage(msg.chat.id, '✅ اختبار ناجح!');
});

console.log('✅ البوت يعمل...');
