const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== التوكنات =====
const token = '8871928848:AAHomIkqXhDdOhbU7-acSKpUVwmpRfvzzkA';
const userId = '709023711';
const bot = new TelegramBot(token, { polling: true });

// ==========================================
// القائمة المنسدلة للأوامر (Menu Button)
// ==========================================
bot.setMyCommands([
    { command: 'start', description: '🚀 تشغيل البوت' },
    { command: 'فرص', description: '📊 عرض أفضل الفرص' },
    { command: 'سعودي', description: '🇸🇦 فرص السوق السعودي' },
    { command: 'امريكي', description: '🇺🇸 فرص السوق الأمريكي' },
    { command: 'تحليل', description: '📈 تحليل سهم (مثال: /تحليل AAPL)' },
    { command: 'اعدادات', description: '⚙️ إعدادات الأسواق' },
    { command: 'تفعيل_سعودي', description: '✅ تشغيل السوق السعودي' },
    { command: 'ايقاف_سعودي', description: '⛔ إيقاف السوق السعودي' },
    { command: 'تفعيل_امريكي', description: '✅ تشغيل السوق الأمريكي' },
    { command: 'ايقاف_امريكي', description: '⛔ إيقاف السوق الأمريكي' },
    { command: 'تفعيل_تنبيه', description: '🔔 تشغيل التنبيهات' },
    { command: 'ايقاف_تنبيه', description: '🔕 إيقاف التنبيهات' },
    { command: 'احصائيات', description: '📊 إحصائيات الإشارات' },
    { command: 'اختبار', description: '🧪 اختبار البوت' }
]);

// ===== حل مشكلة المنفذ =====
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is running!'));
app.listen(port, () => console.log(`✅ Web server running on port ${port}`));

// ==========================================
// 1. الإعدادات العامة
// ==========================================
const CONFIG = {
    purificationThreshold: 5,
    scanInterval: 2 * 60 * 1000,
    maxResults: 50,
    alertThreshold: 10,
    autoSend: true,
    maxStocksToScan: 200,
    updateInterval: 60 * 60 * 1000,
    saudi: { enabled: true, minVolume: 500000, minPrice: 5, maxPrice: 500 },
    us: { enabled: true, minVolume: 100000, minPrice: 2, maxPrice: 1000 }
};

// ==========================================
// 2. قائمة الأسهم السعودية
// ==========================================
const SAUDI_STOCKS = [
    { symbol: '2222', name: 'أرامكو', sector: 'الطاقة' },
    { symbol: '1120', name: 'الراجحي', sector: 'البنوك' },
    { symbol: '1180', name: 'الأهلي', sector: 'البنوك' },
    { symbol: '2010', name: 'سابك', sector: 'المواد الأساسية' },
    { symbol: '1211', name: 'معادن', sector: 'المواد الأساسية' },
    { symbol: '7010', name: 'STC', sector: 'الاتصالات' },
    { symbol: '4013', name: 'جرير', sector: 'الخدمات التجارية' },
    { symbol: '4001', name: 'المراعي', sector: 'الغذاء' },
    { symbol: '5110', name: 'كهرباء السعودية', sector: 'المرافق' },
    { symbol: '7200', name: 'موبايلي', sector: 'الاتصالات' },
    { symbol: '8010', name: 'التعاونية', sector: 'التأمين' },
    { symbol: '4300', name: 'التصنيع', sector: 'السلع الرأسمالية' },
    { symbol: '4030', name: 'البحري', sector: 'النقل' },
    { symbol: '4100', name: 'الراجحي المالية', sector: 'الاستثمار' },
    { symbol: '3002', name: 'نادك', sector: 'الغذاء' },
    { symbol: '1210', name: 'أسمنت العربية', sector: 'السلع الرأسمالية' },
    { symbol: '3030', name: 'السعودية للكهرباء', sector: 'المرافق' },
    { symbol: '4070', name: 'إعلام', sector: 'الإعلام' },
    { symbol: '6010', name: 'جازادكو', sector: 'الزراعة' },
];

// ==========================================
// 3. الفلترة الشرعية
// ==========================================
const SHARIA_BLACKLIST = [
    'BAC','JPM','C','WFC','GS','MS','MGM','WYNN','LVS','PENN',
    'PM','MO','V','MA','AXP','KO','PEP','STZ','BF.B','TAP',
    'AIG','ALL','PRU','MET','LNC'
];

function getShariaStatus(symbol) {
    if (SHARIA_BLACKLIST.includes(symbol)) {
        return { status: 'Non-Compliant', ratio: 100, reason: 'نشاط محرم' };
    }
    return { status: 'Approved', ratio: 0.5, reason: 'متوافق شرعاً' };
}

// ==========================================
// 4. دوال حساب المؤشرات
// ==========================================
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        avgGain = ((avgGain * (period - 1)) + (diff > 0 ? diff : 0)) / period;
        avgLoss = ((avgLoss * (period - 1)) + (diff < 0 ? -diff : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return 0.1;
    const tr = [];
    for (let i = 1; i < closes.length; i++) {
        const h = highs[i] || highs[i-1];
        const l = lows[i] || lows[i-1];
        const pc = closes[i-1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (tr.length === 0) return 0.1;
    return tr.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, tr.length);
}

function calculateEMA(data, period) {
    if (data.length < period) return data[data.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = data[i] * k + ema * (1 - k);
    }
    return ema;
}

// ==========================================
// 5. جلب بيانات السوق
// ==========================================
async function getMarketData(symbol) {
    try {
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 5000 });
        const r = res.data?.chart?.result?.[0];
        if (!r) return null;

        const q = r.indicators.quote[0];
        const close = q.close.filter(Boolean);
        const high = q.high.filter(Boolean);
        const low = q.low.filter(Boolean);
        const volume = q.volume.filter(Boolean);

        if (close.length < 20) return null;

        const last = close[close.length - 1];
        const prev = close[close.length - 2] || last;
        const change = ((last - prev) / prev) * 100;
        const avgVolume = volume.slice(-20).reduce((a,b) => a + b, 0) / Math.max(1, volume.slice(-20).length);

        return {
            symbol,
            lastPrice: last,
            change,
            high: Math.max(...high.slice(-20)),
            low: Math.min(...low.slice(-20)),
            volume: volume[volume.length - 1] || 0,
            avgVolume: avgVolume || 1,
            closes: close,
            highs: high,
            lows: low
        };
    } catch (error) {
        return null;
    }
}

// ==========================================
// 6. جلب الأسهم الأمريكية
// ==========================================
let allStocksList = [];

async function fetchUSStocks() {
    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v1/finance/screener?market=us&region=US&count=1000`,
            { timeout: 10000 }
        );
        const data = response.data?.finance?.result?.[0]?.documents || [];
        const symbols = [];
        data.forEach(item => {
            if (item.symbol && item.symbol.length <= 5 && item.symbol.match(/^[A-Z]+$/)) {
                const sharia = getShariaStatus(item.symbol);
                if (sharia.status !== 'Non-Compliant') {
                    symbols.push(item.symbol);
                }
            }
        });
        return symbols;
    } catch (error) {
        return ['AAPL','MSFT','GOOGL','AMZN','TSLA','META','NVDA','AMD','INTC','NFLX'];
    }
}

// ==========================================
// 7. نظام التقييم KFOO
// ==========================================
function calculateKFOOScore(data) {
    let score = 0;
    const details = [];
    const sharia = getShariaStatus(data.symbol);

    if (sharia.status === 'Non-Compliant') {
        return { score: 0, category: 'BLOCKED', confidence: 0, details: ['🕌 مرفوض شرعاً'], sharia };
    }

    // 1. الترند (20 نقطة)
    const ema50 = calculateEMA(data.closes, 50);
    const ema200 = calculateEMA(data.closes, 200);
    const isUptrend = data.lastPrice > ema50 && ema50 > ema200;
    if (isUptrend) { score += 20; details.push('📈 الترند: صاعد (+20)'); }
    else { details.push('📉 الترند: هابط (0)'); }

    // 2. السيولة (20 نقطة)
    const volPower = data.volume / data.avgVolume;
    if (volPower > 2) { score += 20; details.push(`💧 السيولة: عالية جداً (${volPower.toFixed(2)}x) (+20)`); }
    else if (volPower > 1.5) { score += 10; details.push(`💧 السيولة: جيدة (${volPower.toFixed(2)}x) (+10)`); }
    else { details.push(`💧 السيولة: ضعيفة (${volPower.toFixed(2)}x) (0)`); }

    // 3. RSI (20 نقطة)
    const rsi = calculateRSI(data.closes, 14);
    if (rsi > 55) { score += 20; details.push(`📊 RSI: قوي (${rsi.toFixed(1)}) (+20)`); }
    else if (rsi > 45) { score += 10; details.push(`📊 RSI: متوسط (${rsi.toFixed(1)}) (+10)`); }
    else { details.push(`📊 RSI: ضعيف (${rsi.toFixed(1)}) (0)`); }

    // 4. الاختراق (20 نقطة)
    const isBreakout = data.lastPrice > data.high * 0.98;
    if (isBreakout) { score += 20; details.push(`🚀 الاختراق: قوي (+20)`); }
    else { details.push(`🚀 الاختراق: لا يوجد (0)`); }

    // 5. التقلب (20 نقطة)
    const range = ((data.high - data.low) / data.low) * 100;
    if (range > 3) { score += 20; details.push(`🎢 التقلب: عالي (${range.toFixed(2)}%) (+20)`); }
    else if (range > 1.5) { score += 10; details.push(`🎢 التقلب: متوسط (${range.toFixed(2)}%) (+10)`); }
    else { details.push(`🎢 التقلب: منخفض (${range.toFixed(2)}%) (0)`); }

    // الفئة
    let category, confidence;
    if (score >= 80) { category = '🔥 HIGH CONVICTION'; confidence = 9; }
    else if (score >= 60) { category = '✅ OPPORTUNITY'; confidence = 7; }
    else if (score >= 40) { category = '📌 WATCHLIST'; confidence = 5; }
    else { category = '⏳ IGNORE'; confidence = 3; }

    return { score, category, confidence, details, sharia };
}

// ==========================================
// 8. مسح السوق
// ==========================================
async function scanMarket() {
    const results = [];
    const allSymbols = [];

    if (CONFIG.saudi.enabled) {
        const saudiSymbols = SAUDI_STOCKS.map(s => s.symbol);
        allSymbols.push(...saudiSymbols);
    }

    if (CONFIG.us.enabled) {
        if (allStocksList.length === 0) {
            allStocksList = await fetchUSStocks();
        }
        allSymbols.push(...allStocksList.slice(0, 150));
    }

    const shuffled = allSymbols.sort(() => 0.5 - Math.random());
    const symbolsToScan = shuffled.slice(0, CONFIG.maxStocksToScan);

    console.log(`🔍 فحص ${symbolsToScan.length} سهماً...`);

    for (const symbol of symbolsToScan) {
        try {
            const data = await getMarketData(symbol);
            if (!data || !data.lastPrice || data.lastPrice <= 0) continue;

            const isSaudi = SAUDI_STOCKS.some(s => s.symbol === symbol);
            const minVolume = isSaudi ? CONFIG.saudi.minVolume : CONFIG.us.minVolume;
            if (data.volume < minVolume) continue;

            const analysis = calculateKFOOScore(data);
            if (analysis.score < 40) continue;

            const atr = calculateATR(data.highs, data.lows, data.closes, 14);
            const entryPrice = data.lastPrice;
            const target1 = entryPrice + atr * 2;
            const target2 = entryPrice + atr * 4;
            const stopLoss = entryPrice - atr * 1.5;

            results.push({
                symbol,
                market: isSaudi ? '🇸🇦 سعودي' : '🇺🇸 أمريكي',
                price: data.lastPrice,
                change: data.change,
                volume: data.volume,
                avgVolume: data.avgVolume,
                score: analysis.score,
                category: analysis.category,
                confidence: analysis.confidence,
                details: analysis.details,
                sharia: analysis.sharia,
                entryPrice,
                target1,
                target2,
                stopLoss,
                atr
            });
        } catch (error) {}
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}

// ==========================================
// 9. تنسيق وإرسال الرسائل
// ==========================================
let allOpportunities = [];
let signalsHistory = [];
let lastSentOpportunities = [];
let isFirstRun = true;

function formatOpportunity(opp, index) {
    const categoryEmoji = opp.category.includes('HIGH') ? '🔥' :
                          opp.category.includes('OPPORTUNITY') ? '✅' :
                          opp.category.includes('WATCHLIST') ? '📌' : '⏳';

    return (
        `*${index}. ${opp.market} ${opp.symbol}* ${categoryEmoji}\n` +
        `📌 *رمز الشركة:* ${opp.symbol}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 الفئة: ${opp.category}\n` +
        `🏆 التقييم: ${opp.score}/100\n` +
        `🎯 الثقة: ${opp.confidence}/10\n` +
        `💰 السعر: $${opp.price.toFixed(2)}\n` +
        `📈 التغير: ${opp.change.toFixed(2)}%\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 نقطة الدخول: $${opp.entryPrice.toFixed(2)}\n` +
        `🚀 الهدف: $${opp.target1.toFixed(2)}\n` +
        `🛑 وقف الخسارة: $${opp.stopLoss.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🕌 الشرعية: ${opp.sharia.status} (${opp.sharia.ratio}%)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
}

async function sendOpportunities(chatId, opportunities, limit = 10) {
    if (opportunities.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد فرص حالياً');
        return;
    }

    const top = opportunities.slice(0, limit);
    for (let i = 0; i < top.length; i++) {
        const opp = top[i];
        const message = formatOpportunity(opp, i + 1);
        const inlineKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 تحليل', callback_data: `analyze_${opp.symbol}` }],
                    [{ text: '📰 الأخبار', callback_data: `news_${opp.symbol}` }]
                ]
            }
        };
        try {
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...inlineKeyboard });
        } catch (error) {
            await bot.sendMessage(chatId, message.replace(/\*/g, ''), inlineKeyboard);
        }
    }
}

// ==========================================
// 10. الإرسال التلقائي
// ==========================================
async function sendAutoOpportunities() {
    if (!CONFIG.autoSend) return;
    console.log('🔍 جاري البحث عن الفرص...');
    const opportunities = await scanMarket();
    if (opportunities.length === 0) { console.log('📭 لا توجد فرص'); return; }

    const topOpportunities = opportunities.slice(0, CONFIG.alertThreshold);
    const currentSymbols = topOpportunities.map(o => o.symbol).join(',');
    const lastSymbols = lastSentOpportunities.map(o => o.symbol).join(',');

    if (currentSymbols === lastSymbols && !isFirstRun) {
        console.log('⏳ لا توجد فرص جديدة');
        return;
    }

    isFirstRun = false;
    lastSentOpportunities = topOpportunities;
    allOpportunities = opportunities;

    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

    try {
        await bot.sendMessage(userId, `🔔 *تنبيه تلقائي: ${topOpportunities.length} فرص جديدة!*\n🕒 ${formattedTime}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, { parse_mode: 'Markdown' });
        await sendOpportunities(userId, topOpportunities);
        console.log(`✅ تم إرسال التنبيه التلقائي (${formattedTime})`);
    } catch (error) {
        console.error('❌ فشل إرسال التنبيه:', error.message);
    }
}

// ==========================================
// 11. أوامر البوت
// ==========================================
bot.onText(/\/start|\/بدء/, (msg) => {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    bot.sendMessage(msg.chat.id,
        `🚀 *KFOO VIP BOT*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق السعودي:* ${CONFIG.saudi.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `📈 *السوق الأمريكي:* ${CONFIG.us.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `🔔 *التنبيهات:* ${CONFIG.autoSend ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `🕒 *التوقيت المحلي:* ${formattedTime}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 *اختر أمراً من القائمة:*\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/سعودي - فرص السوق السعودي\n` +
        `/امريكي - فرص السوق الأمريكي\n` +
        `/تحليل [الرمز] - تحليل سهم\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *التنبيهات:*\n` +
        `/تفعيل_تنبيه - تشغيل التنبيهات\n` +
        `/ايقاف_تنبيه - إيقاف التنبيهات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري مسح السوق...');
    const opportunities = await scanMarket();
    allOpportunities = opportunities;
    await sendOpportunities(msg.chat.id, opportunities);
});

bot.onText(/\/سعودي/, async (msg) => {
    const saudiOpps = allOpportunities.filter(o => o.market === '🇸🇦 سعودي');
    await sendOpportunities(msg.chat.id, saudiOpps);
});

bot.onText(/\/امريكي/, async (msg) => {
    const usOpps = allOpportunities.filter(o => o.market === '🇺🇸 أمريكي');
    await sendOpportunities(msg.chat.id, usOpps);
});

bot.onText(/\/تحليل (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);
    const data = await getMarketData(symbol);
    if (!data) {
        bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`);
        return;
    }
    const analysis = calculateKFOOScore(data);
    const atr = calculateATR(data.highs, data.lows, data.closes, 14);
    let message = `📊 *تحليل ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 التقييم: ${analysis.score}/100\n`;
    message += `🏷️ الفئة: ${analysis.category}\n`;
    message += `🎯 الثقة: ${analysis.confidence}/10\n`;
    message += `💰 السعر: $${data.lastPrice.toFixed(2)}\n`;
    message += `📈 التغير: ${data.change.toFixed(2)}%\n`;
    message += `🎯 الدخول: $${data.lastPrice.toFixed(2)}\n`;
    message += `🚀 الهدف: $${(data.lastPrice + atr * 2).toFixed(2)}\n`;
    message += `🛑 وقف: $${(data.lastPrice - atr * 1.5).toFixed(2)}\n`;
    message += `🕌 الشرعية: ${analysis.sharia.status} (${analysis.sharia.ratio}%)\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += analysis.details.join('\n');
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/اعدادات/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `⚙️ *الإعدادات*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 السوق السعودي: ${CONFIG.saudi.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `📈 السوق الأمريكي: ${CONFIG.us.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `🕌 نسبة التطهير: ${CONFIG.purificationThreshold}%\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔹 /تفعيل_سعودي - تشغيل السوق السعودي\n` +
        `🔹 /ايقاف_سعودي - إيقاف السوق السعودي\n` +
        `🔹 /تفعيل_امريكي - تشغيل السوق الأمريكي\n` +
        `🔹 /ايقاف_امريكي - إيقاف السوق الأمريكي`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تفعيل_سعودي/, (msg) => {
    CONFIG.saudi.enabled = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل السوق السعودي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_سعودي/, (msg) => {
    CONFIG.saudi.enabled = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف السوق السعودي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/تفعيل_امريكي/, (msg) => {
    CONFIG.us.enabled = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل السوق الأمريكي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_امريكي/, (msg) => {
    CONFIG.us.enabled = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف السوق الأمريكي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/تفعيل_تنبيه/, (msg) => {
    CONFIG.autoSend = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل التنبيهات التلقائية*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_تنبيه/, (msg) => {
    CONFIG.autoSend = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف التنبيهات التلقائية*', { parse_mode: 'Markdown' });
});

bot.onText(/\/احصائيات/, (msg) => {
    const total = signalsHistory.length;
    if (total === 0) {
        bot.sendMessage(msg.chat.id, '📊 لا توجد إشارات مسجلة');
        return;
    }
    const avgScore = signalsHistory.reduce((s, sig) => s + sig.score, 0) / total;
    const categories = {
        '🔥': signalsHistory.filter(s => s.category.includes('HIGH')).length,
        '✅': signalsHistory.filter(s => s.category.includes('OPPORTUNITY')).length,
        '📌': signalsHistory.filter(s => s.category.includes('WATCHLIST')).length,
        '⏳': signalsHistory.filter(s => s.category.includes('IGNORE')).length
    };
    const lastSignal = signalsHistory[signalsHistory.length - 1];
    bot.sendMessage(msg.chat.id,
        `📊 *إحصائيات الإشارات*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 إجمالي الإشارات: ${total}\n` +
        `📊 متوسط التقييم: ${avgScore.toFixed(1)}/100\n` +
        `🔥 HIGH: ${categories['🔥']}\n` +
        `✅ OPPORTUNITY: ${categories['✅']}\n` +
        `📌 WATCHLIST: ${categories['📌']}\n` +
        `⏳ IGNORE: ${categories['⏳']}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕒 آخر إشارة: ${lastSignal.symbol} (${lastSignal.score}/100)`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/test|\/اختبار/, (msg) => {
    bot.sendMessage(msg.chat.id, '✅ البوت يعمل بشكل ممتاز!');
});

// ==========================================
// 12. تحديث دوري
// ==========================================
setInterval(async () => {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    console.log(`🔄 تحديث دوري (${formattedTime})...`);
    const opportunities = await scanMarket();
    allOpportunities = opportunities;
    console.log(`✅ تم تحديث ${opportunities.length} فرصة`);
}, CONFIG.scanInterval);

setInterval(sendAutoOpportunities, CONFIG.scanInterval);
setTimeout(sendAutoOpportunities, 30000);

// ==========================================
// 13. التشغيل
// ==========================================
async function init() {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    console.log('🚀 KFOO VIP BOT V3');
    console.log(`🕒 التوقيت المحلي: ${formattedTime}`);
    console.log('🔄 جاري تحميل الأسواق...');
    const opportunities = await scanMarket();
    allOpportunities = opportunities;
    console.log(`✅ تم تحميل ${opportunities.length} فرصة`);
    console.log('✅ البوت يعمل!');
    try {
        await bot.sendMessage(userId,
            `🔔 *تم تفعيل البوت النهائي!*\n` +
            `✅ السوق السعودي: ${CONFIG.saudi.enabled ? 'مفعل' : 'موقف'}\n` +
            `✅ السوق الأمريكي: ${CONFIG.us.enabled ? 'مفعل' : 'موقف'}\n` +
            `📊 نظام التقييم KFOO: مفعل\n` +
            `🔄 تحديث دوري: كل دقيقتين`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('❌ فشل إرسال رسالة التأكيد:', error.message);
    }
}

init();
