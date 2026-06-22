const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });

// ===== إعدادات الأسواق =====
let marketSettings = {
    stocks: true,
    crypto: true
};

// ===== قوائم الأسهم والعملات (ديناميكية) =====
let stockList = [];
let cryptoList = [];

// ===== قائمة الأسهم المحرمة (نسبة تطهير 100%) =====
const forbiddenStocks = [
    'BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'AXP',
    'KO', 'PEP', 'STZ', 'BF.B', 'TAP',
    'MGM', 'WYNN', 'LVS', 'DKNG', 'PENN',
    'PM', 'MO', 'BTI'
];

// ===== دالة جلب قائمة الأسهم من S&P 500 =====
async function fetchStockList() {
    try {
        const response = await axios.get(
            'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
        );
        const lines = response.data.split('\n');
        const symbols = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const parts = line.split(',');
                if (parts[0]) {
                    const symbol = parts[0].trim().replace(/"/g, '');
                    if (!forbiddenStocks.includes(symbol)) {
                        symbols.push(symbol);
                    }
                }
            }
        }
        return symbols;
    } catch (error) {
        console.log('❌ خطأ في جلب قائمة الأسهم:', error.message);
        return ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
    }
}

// ===== دالة جلب قائمة العملات المشفرة =====
async function fetchCryptoList() {
    try {
        const response = await axios.get(
            'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false'
        );
        const symbols = response.data.map(c => c.symbol.toUpperCase() + '-USD');
        return symbols;
    } catch (error) {
        console.log('❌ خطأ في جلب العملات:', error.message);
        return ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOT-USD', 'AVAX-USD', 'MATIC-USD', 'LINK-USD', 'UNI-USD'];
    }
}

// ===== دالة جلب البيانات =====
async function getPrice(symbol) {
    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`,
            { timeout: 5000 }
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const lastPrice = quote.close[quote.close.length - 1];
        const openPrice = quote.open[0];
        const change = ((lastPrice - openPrice) / openPrice * 100);
        const highPrice = Math.max(...quote.high);
        const lowPrice = Math.min(...quote.low);
        const volume = quote.volume[quote.volume.length - 1] || 0;
        return { symbol, lastPrice, change, highPrice, lowPrice, volume };
    } catch (error) {
        return null;
    }
}

// ===== دالة حساب التطهير =====
function getPurification(symbol) {
    if (forbiddenStocks.includes(symbol)) {
        return { percentage: 100, isForbidden: true, reason: 'نشاط محرم (ربا/خمور/قمار)' };
    }
    const rates = {
        'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3,
        'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2, 'AMD': 0.2,
        'INTC': 0.8, 'NFLX': 0.5, 'ADBE': 1.0, 'CRM': 1.5,
        'ORCL': 1.2, 'IBM': 1.0
    };
    const pct = rates[symbol] || 0.5;
    return { percentage: pct, isForbidden: false, reason: 'نشاط مختلط' };
}

// ===== مسح السوق بالكامل =====
async function scanMarket() {
    const results = [];
    const allSymbols = [];
    
    if (marketSettings.stocks) {
        if (stockList.length === 0) {
            stockList = await fetchStockList();
        }
        allSymbols.push(...stockList.slice(0, 50));
    }
    if (marketSettings.crypto) {
        if (cryptoList.length === 0) {
            cryptoList = await fetchCryptoList();
        }
        allSymbols.push(...cryptoList.slice(0, 20));
    }
    
    if (allSymbols.length === 0) return [];
    
    const shuffled = allSymbols.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 30);
    
    for (const symbol of selected) {
        try {
            const data = await getPrice(symbol);
            if (!data || !data.lastPrice || data.lastPrice <= 0) continue;
            
            const isCrypto = symbol.includes('-USD');
            if (!isCrypto && data.volume < 500000) continue;
            
            const p = getPurification(symbol);
            if (p.isForbidden || p.percentage > 3) continue;
            
            const change = data.change;
            const isUptrend = change > 1.5;
            const isVolatile = ((data.highPrice - data.lowPrice) / data.lowPrice * 100) > 2;
            
            if (isUptrend && isVolatile) {
                const entry = (data.lastPrice * 0.98).toFixed(2);
                const target1 = (data.lastPrice * 1.04).toFixed(2);
                const target2 = (data.lastPrice * 1.08).toFixed(2);
                const target3 = (data.lastPrice * 1.12).toFixed(2);
                const stopLoss = (data.lastPrice * 0.95).toFixed(2);
                
                results.push({
                    symbol,
                    marketType: isCrypto ? '🪙 عملة مشفرة' : '📈 سهم أمريكي',
                    price: data.lastPrice,
                    change: change.toFixed(2),
                    entry, target1, target2, target3, stopLoss,
                    purification: p.percentage
                });
            }
        } catch (error) {}
    }
    
    results.sort((a, b) => parseFloat(b.change) - parseFloat(a.change));
    return results.slice(0, 5);
}

// ===== الأوامر =====
bot.onText(/\/start|\/بدء/, (msg) => {
    const statusStocks = marketSettings.stocks ? '🟢 مفعل' : '🔴 متوقف';
    const statusCrypto = marketSettings.crypto ? '🟢 مفعل' : '🔴 متوقف';
    
    bot.sendMessage(msg.chat.id,
        `🏠 *القائمة الرئيسية*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق الأمريكي:* ${statusStocks}\n` +
        `🪙 *العملات المشفرة:* ${statusCrypto}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/تحليل [الرمز] - تحليل سهم أو عملة\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/تطهير [الرمز] - نسبة التطهير\n` +
        `/اختبار - اختبار البوت\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 مثال: /تحليل AAPL أو /تحليل BTC-USD`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/اعدادات/, (msg) => {
    const statusStocks = marketSettings.stocks ? '🟢 مفعل' : '🔴 متوقف';
    const statusCrypto = marketSettings.crypto ? '🟢 مفعل' : '🔴 متوقف';
    
    bot.sendMessage(msg.chat.id,
        `⚙️ *إعدادات الأسواق*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 السوق الأمريكي: ${statusStocks}\n` +
        `🪙 العملات المشفرة: ${statusCrypto}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔹 /تفعيل_اسهم - تشغيل السوق الأمريكي\n` +
        `🔹 /ايقاف_اسهم - إيقاف السوق الأمريكي\n` +
        `🔹 /تفعيل_عملات - تشغيل العملات المشفرة\n` +
        `🔹 /ايقاف_عملات - إيقاف العملات المشفرة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تفعيل_اسهم/, (msg) => {
    marketSettings.stocks = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل السوق الأمريكي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_اسهم/, (msg) => {
    marketSettings.stocks = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف السوق الأمريكي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/تفعيل_عملات/, (msg) => {
    marketSettings.crypto = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل العملات المشفرة*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_عملات/, (msg) => {
    marketSettings.crypto = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف العملات المشفرة*', { parse_mode: 'Markdown' });
});

bot.onText(/\/تحليل (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);
    
    const data = await getPrice(symbol);
    if (!data) {
        bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`);
        return;
    }
    
    const p = getPurification(symbol);
    const isCrypto = symbol.includes('-USD');
    const marketType = isCrypto ? '🪙 عملة مشفرة' : '📈 سهم أمريكي';
    
    const entry = (data.lastPrice * 0.98).toFixed(2);
    const target1 = (data.lastPrice * 1.04).toFixed(2);
    const target2 = (data.lastPrice * 1.08).toFixed(2);
    const target3 = (data.lastPrice * 1.12).toFixed(2);
    const stopLoss = (data.lastPrice * 0.95).toFixed(2);
    
    bot.sendMessage(msg.chat.id,
        `📊 *تحليل ${data.symbol}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🏷️ *النوع:* ${marketType}\n` +
        `💰 *السعر الحالي:* $${data.lastPrice.toFixed(2)}\n` +
        `📈 *التغير:* ${data.change.toFixed(2)}%\n` +
        `🔺 *الأعلى:* $${data.highPrice.toFixed(2)}\n` +
        `🔻 *الأدنى:* $${data.lowPrice.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎯 *صفقة مقترحة:*\n` +
        `• الدخول: $${entry}\n` +
        `• الهدف 1: $${target1} (+4%)\n` +
        `• الهدف 2: $${target2} (+8%)\n` +
        `• الهدف 3: $${target3} (+12%)\n` +
        `🛑 وقف الخسارة: $${stopLoss} (-5%)\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕌 *التطهير:* ${p.percentage}% (${p.isForbidden ? '❌' : '✅'})`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري البحث عن الفرص في جميع الأسواق...');
    
    const opportunities = await scanMarket();
    
    if (opportunities.length === 0) {
        bot.sendMessage(msg.chat.id, '📭 لا توجد فرص حالياً');
        return;
    }
    
    let message = `🔥 *أفضل الفرص اليوم*\n━━━━━━━━━━━━━━━━━━\n`;
    opportunities.forEach((opp, i) => {
        message +=
            `${i+1}. *${opp.symbol}* ${opp.marketType}\n` +
            `   💰 السعر: $${opp.price.toFixed(2)}\n` +
            `   📈 التغير: ${opp.change}%\n` +
            `   🎯 الدخول: $${opp.entry}\n` +
            `   🚀 الأهداف: $${opp.target1} | $${opp.target2} | $${opp.target3}\n` +
            `   🛑 وقف: $${opp.stopLoss}\n` +
            `   🕌 التطهير: ${opp.purification}%\n` +
            `━━━━━━━━━━━━━━━━━━\n`;
    });
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تطهير (.+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const p = getPurification(symbol);
    let message = `🕌 *نسبة التطهير لـ ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += p.isForbidden ? 
        `❌ *غير متوافق شرعاً*\n📌 ${p.reason}\n📊 100%` :
        `✅ *متوافق شرعاً*\n📊 ${p.percentage}%\n📌 ${p.reason}`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/test|\/اختبار/, (msg) => {
    bot.sendMessage(msg.chat.id, '✅ البوت يعمل بشكل ممتاز!');
});

// ===== تحميل القوائم عند بدء التشغيل =====
async function init() {
    console.log('🔄 جاري تحميل قوائم الأسواق...');
    stockList = await fetchStockList();
    cryptoList = await fetchCryptoList();
    console.log(`✅ تم تحميل ${stockList.length} سهماً و ${cryptoList.length} عملة`);
    console.log(`📈 السوق الأمريكي: ${marketSettings.stocks ? 'مفعل' : 'موقف'}`);
    console.log(`🪙 العملات المشفرة: ${marketSettings.crypto ? 'مفعل' : 'موقف'}`);
}

init();

console.log('✅ البوت يعمل...');
