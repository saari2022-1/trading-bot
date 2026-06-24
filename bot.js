const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== التوكنات =====
const token = '8871928848:AAHomIkqXhDdOhbU7-acSKpUVwmpRfvzzkA';
const userId = '709023711';
const bot = new TelegramBot(token, { polling: true });

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
    scanInterval: 2 * 60 * 1000, // دقيقتين
    maxResults: 50,
    alertThreshold: 10,
    autoSend: true,
    stocksOnly: true,
    maxStocksToScan: 200,
    updateInterval: 60 * 60 * 1000, // كل ساعة
    // السوق السعودي
    saudi: {
        enabled: true,
        minVolume: 500000,
        minPrice: 5,
        maxPrice: 500,
        timeframe: '5m',
        targetProfit: 1.5,
        stopLoss: 0.75
    },
    // السوق الأمريكي
    us: {
        enabled: true,
        minVolume: 100000,
        minPrice: 2,
        maxPrice: 1000,
        timeframe: '5m',
        targetProfit: 1.5,
        stopLoss: 0.75
    }
};

// ==========================================
// 2. المتغيرات العامة
// ==========================================
let allStocksList = [];
let allOpportunities = [];
let signalsHistory = [];
let lastSentOpportunities = [];
let isFirstRun = true;
let lastUpdateTime = 0;

// ==========================================
// 3. ملفات السجل
// ==========================================
const HISTORY_FILE = path.join(__dirname, 'signals_history.json');
const TRADES_FILE = path.join(__dirname, 'trades.json');
const PORTFOLIO_FILE = path.join(__dirname, 'portfolio.json');

function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            signalsHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (e) {}
}
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(signalsHistory.slice(-1000), null, 2));
    } catch (e) {}
}
loadHistory();

// ==========================================
// 4. الفلترة الشرعية
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
// 5. جلب قوائم الأسهم
// ==========================================
// قائمة الأسهم السعودية الرئيسية
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
    { symbol: '4004', name: 'الوطنية', sector: 'الغذاء' },
    { symbol: '4050', name: 'أسمنت السعودية', sector: 'السلع الرأسمالية' },
    { symbol: '4280', name: 'أسمنت المدينة', sector: 'السلع الرأسمالية' },
    { symbol: '6020', name: 'الجبس', sector: 'الزراعة' },
    { symbol: '6050', name: 'السماد', sector: 'الزراعة' },
];

// قائمة الأسهم الأمريكية
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
        console.log(`✅ جلب ${symbols.length} سهماً من السوق الأمريكي`);
        return symbols;
    } catch (error) {
        console.log('⚠️ خطأ في جلب الأسهم الأمريكية:', error.message);
        return ['AAPL','MSFT','GOOGL','AMZN','TSLA','META','NVDA','AMD','INTC','NFLX'];
    }
}

// ==========================================
// 6. جلب بيانات السوق
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

        const last = close.at(-1);
        const prev = close.at(-2) || last;
        const change = ((last - prev) / prev) * 100;
        const avgVolume = volume.slice(-20).reduce((a,b)=>a+b,0) / Math.max(1, volume.slice(-20).length);

        return {
            symbol,
            lastPrice: last,
            change,
            high: Math.max(...high.slice(-20)),
            low: Math.min(...low.slice(-20)),
            volume: volume.at(-1),
            avgVolume
        };
    } catch {
        return null;
    }
}

// ==========================================
// 7. المؤشرات الفنية
// ==========================================
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
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

function calculateEMA(data, period) {
    const ema = [];
    const k = 2 / (period + 1);
    ema[0] = data[0];
    for (let i = 1; i < data.length; i++) {
        ema[i] = data[i] * k + ema[i-1] * (1 - k);
    }
    return ema;
}

function calculateATR(highs, lows, closes, period = 14) {
    const tr = [];
    for (let i = 1; i < closes.length; i++) {
        const h = highs[i] || highs[i-1];
        const l = lows[i] || lows[i-1];
        const pc = closes[i-1];
        tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const atr = [];
    for (let i = 0; i < tr.length; i++) {
        if (i < period - 1) {
            atr.push(tr.slice(0, i + 1).reduce((a,b)=>a+b,0) / (i + 1));
        } else {
            atr.push((atr[atr.length - 1] * (period - 1) + tr[i]) / period);
        }
    }
    return atr;
}

// ==========================================
// 8. نظام التقييم المتقدم (KFOO Score)
// ==========================================
function calculateKFOOScore(data) {
    let score = 0;
    const details = [];
    const sharia = getShariaStatus(data.symbol);

    if (sharia.status === 'Non-Compliant') {
        return { score: 0, category: 'BLOCKED', details: ['🕌 مرفوض شرعاً'] };
    }

    // 1. الترند (20 نقطة)
    const ema50 = calculateEMA(data.close, 50);
    const ema200 = calculateEMA(data.close, 200);
    const isUptrend = data.lastPrice > ema50[ema50.length - 1] && ema50[ema50.length - 1] > ema200[ema200.length - 1];
    if (isUptrend) {
        score += 20;
        details.push('📈 الترند: صاعد (+20)');
    } else {
        details.push('📉 الترند: هابط (0)');
    }

    // 2. السيولة (20 نقطة)
    const volPower = data.volume / (data.avgVolume || 1);
    if (volPower > 2) {
        score += 20;
        details.push(`💧 السيولة: عالية جداً (${volPower.toFixed(2)}x) (+20)`);
    } else if (volPower > 1.5) {
        score += 10;
        details.push(`💧 السيولة: جيدة (${volPower.toFixed(2)}x) (+10)`);
    } else {
        details.push(`💧 السيولة: ضعيفة (${volPower.toFixed(2)}x) (0)`);
    }

    // 3. الزخم (20 نقطة)
    const rsi = calculateRSI(data.close, 14);
    if (rsi && rsi > 55) {
        score += 20;
        details.push(`📊 RSI: قوي (${rsi.toFixed(1)}) (+20)`);
    } else if (rsi && rsi > 45) {
        score += 10;
        details.push(`📊 RSI: متوسط (${rsi.toFixed(1)}) (+10)`);
    } else {
        details.push(`📊 RSI: ضعيف (${rsi ? rsi.toFixed(1) : 'غير متاح'}) (0)`);
    }

    // 4. الاختراق (20 نقطة)
    const isBreakout = data.lastPrice > data.high * 0.98;
    if (isBreakout) {
        score += 20;
        details.push(`🚀 الاختراق: قوي (+20)`);
    } else {
        details.push(`🚀 الاختراق: لا يوجد (0)`);
    }

    // 5. التقلب (20 نقطة)
    const range = ((data.high - data.low) / data.low) * 100;
    if (range > 3) {
        score += 20;
        details.push(`🎢 التقلب: عالي (${range.toFixed(2)}%) (+20)`);
    } else if (range > 1.5) {
        score += 10;
        details.push(`🎢 التقلب: متوسط (${range.toFixed(2)}%) (+10)`);
    } else {
        details.push(`🎢 التقلب: منخفض (${range.toFixed(2)}%) (0)`);
    }

    // تحديد الفئة
    let category, confidence;
    if (score >= 80) { category = '🔥 HIGH CONVICTION'; confidence = 9; }
    else if (score >= 60) { category = '✅ OPPORTUNITY'; confidence = 7; }
    else if (score >= 40) { category = '📌 WATCHLIST'; confidence = 5; }
    else { category = '⏳ IGNORE'; confidence = 3; }

    return { score, category, confidence, details, sharia };
}

// ==========================================
// 9. مسح السوق
// ==========================================
async function scanMarket() {
    const results = [];
    const allSymbols = [];

    // جلب الأسهم السعودية
    if (CONFIG.saudi.enabled) {
        const saudiSymbols = SAUDI_STOCKS.map(s => s.symbol);
        allSymbols.push(...saudiSymbols);
    }

    // جلب الأسهم الأمريكية
    if (CONFIG.us.enabled) {
        if (allStocksList.length === 0) {
            allStocksList = await fetchUSStocks();
        }
        allSymbols.push(...allStocksList.slice(0, 150));
    }

    // خلط واختيار عينة
    const shuffled = allSymbols.sort(() => 0.5 - Math.random());
    const symbolsToScan = shuffled.slice(0, CONFIG.maxStocksToScan);

    console.log(`🔍 فحص ${symbolsToScan.length} سهماً...`);

    const batchSize = 10;
    for (let i = 0; i < symbolsToScan.length; i += batchSize) {
        const batch = symbolsToScan.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (symbol) => {
            try {
                const data = await getMarketData(symbol);
                if (!data || !data.lastPrice || data.lastPrice <= 0) return null;

                // فلترة السيولة
                const isSaudi = SAUDI_STOCKS.some(s => s.symbol === symbol);
                const minVolume = isSaudi ? CONFIG.saudi.minVolume : CONFIG.us.minVolume;
                if (data.volume < minVolume) return null;

                const analysis = calculateKFOOScore(data);
                if (analysis.score < 40) return null;

                // حساب نقاط الدخول والخروج
                const atr = calculateATR(data.high, data.low, data.close, 14);
                const currentATR = atr[atr.length - 1] || 0.1;
                const entryPrice = data.lastPrice;
                const target1 = entryPrice + currentATR * 2;
                const target2 = entryPrice + currentATR * 4;
                const stopLoss = entryPrice - currentATR * 1.5;

                return {
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
                    atr: currentATR
                };
            } catch (error) { return null; }
        }));
        results.push(...batchResults.filter(r => r !== null));
    }

    results.sort((a, b) => b.score - a.score);
    allOpportunities = results;
    return results;
}

// ==========================================
// 10. تنسيق رسالة الفرصة
// ==========================================
function formatOpportunity(opp, index) {
    const categoryEmoji = opp.category.includes('HIGH') ? '🔥' :
                          opp.category.includes('OPPORTUNITY') ? '✅' :
                          opp.category.includes('WATCHLIST') ? '📌' : '⏳';

    let message =
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
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return message;
}

// ==========================================
// 11. إرسال الفرص
// ==========================================
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
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                ...inlineKeyboard
            });
        } catch (error) {
            await bot.sendMessage(chatId, message.replace(/\*/g, ''), inlineKeyboard);
        }
    }
}

// ==========================================
// 12. الإرسال التلقائي
// ==========================================
async function sendAutoOpportunities() {
    if (!CONFIG.autoSend) return;

    console.log('🔍 جاري البحث عن الفرص...');
    const opportunities = await scanMarket();

    if (opportunities.length === 0) {
        console.log('📭 لا توجد فرص');
        return;
    }

    const topOpportunities = opportunities.slice(0, CONFIG.alertThreshold);
    const currentSymbols = topOpportunities.map(o => o.symbol).join(',');
    const lastSymbols = lastSentOpportunities.map(o => o.symbol).join(',');

    if (currentSymbols === lastSymbols && !isFirstRun) {
        console.log('⏳ لا توجد فرص جديدة');
        return;
    }

    isFirstRun = false;
    lastSentOpportunities = topOpportunities;

    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    const message = `🔔 *تنبيه تلقائي: ${topOpportunities.length} فرص جديدة!*\n` +
                    `🕒 ${formattedTime}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        await sendOpportunities(userId, topOpportunities);
        console.log(`✅ تم إرسال التنبيه التلقائي (${formattedTime})`);
    } catch (error) {
        console.error('❌ فشل إرسال التنبيه:', error.message);
    }
}

// ==========================================
// 13. أوامر البوت
// ==========================================
bot.onText(/\/start|\/بدء/, (msg) => {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    bot.sendMessage(msg.chat.id,
        `🚀 *KFOO VIP BOT*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق السعودي:* ${CONFIG.saudi.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `📈 *السوق الأمريكي:* ${CONFIG.us.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `🔔 *التنبيهات:* ${CONFIG.autoSend ? '🟢 مفعل' : '🔴 متوقف'}\n` +
        `🕒 *التوقيت المحلي:* ${formattedTime}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/تحليل [الرمز] - تحليل سهم\n` +
        `/سعودي - فرص السوق السعودي\n` +
        `/امريكي - فرص السوق الأمريكي\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *التنبيهات:*\n` +
        `/تفعيل_تنبيه - تشغيل التنبيهات\n` +
        `/ايقاف_تنبيه - إيقاف التنبيهات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *نظام التقييم KFOO:* 100 نقطة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري مسح السوق...');
    const opportunities = await scanMarket();
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
    const atr = calculateATR(data.high, data.low, data.close, 14);
    const currentATR = atr[atr.length - 1] || 0.1;

    let message = `📊 *تحليل ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 التقييم: ${analysis.score}/100\n`;
    message += `🏷️ الفئة: ${analysis.category}\n`;
    message += `🎯 الثقة: ${analysis.confidence}/10\n`;
    message += `💰 السعر: $${data.lastPrice.toFixed(2)}\n`;
    message += `📈 التغير: ${data.change.toFixed(2)}%\n`;
    message += `🎯 الدخول: $${(data.lastPrice).toFixed(2)}\n`;
    message += `🚀 الهدف: $${(data.lastPrice + currentATR * 2).toFixed(2)}\n`;
    message += `🛑 وقف: $${(data.lastPrice - currentATR * 1.5).toFixed(2)}\n`;
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

bot.onText(/\/تفعيل_سعودi/, (msg) => {
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
// 14. تحديث دوري
// ==========================================
async function periodicUpdate() {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    console.log(`🔄 تحديث دوري (${formattedTime})...`);
    await scanMarket();
    console.log(`✅ تم تحديث ${allOpportunities.length} فرصة`);
}

setInterval(periodicUpdate, CONFIG.scanInterval);
setInterval(sendAutoOpportunities, CONFIG.scanInterval);
setTimeout(sendAutoOpportunities, 30000);

// ==========================================
// 15. التشغيل
// ==========================================
async function init() {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    console.log('🚀 KFOO VIP BOT V3');
    console.log(`🕒 التوقيت المحلي: ${formattedTime}`);
    console.log('🔄 جاري تحميل الأسواق...');
    await periodicUpdate();
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
