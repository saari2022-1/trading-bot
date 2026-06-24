const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== التوكنات ومعرفات الحساب =====
const token = '8871928848:AAHomIkqXhDdOhbU7-acSKpUVwmpRfvzzkA';
const userId = '709023711';
const bot = new TelegramBot(token, { polling: true });

// ===== حل مشكلة المنفذ للمنصات السحابية =====
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
    saudi: {
        enabled: true,
        minVolume: 500000,
        minPrice: 5,
        maxPrice: 500,
        timeframe: '5m',
        targetProfit: 1.5,
        stopLoss: 0.75
    },
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

// ==========================================
// 3. ملفات السجل
// ==========================================
const HISTORY_FILE = path.join(__dirname, 'signals_history.json');

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
    const cleanSymbol = symbol.replace('.SR', '');
    if (SHARIA_BLACKLIST.includes(cleanSymbol)) {
        return { status: 'Non-Compliant', ratio: 100, reason: 'نشاط محرم' };
    }
    return { status: 'Approved', ratio: 0.5, reason: 'متوافق شرعاً' };
}

// ==========================================
// 5. جلب قوائم الأسهم السعودية
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
    { symbol: '3002', name: 'نادك', sector: 'الغذاء' }
];

async function fetchUSStocks() {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/screener?market=us&region=US&count=100`, { timeout: 10000 });
        const data = response.data?.finance?.result?.[0]?.documents || [];
        const symbols = [];
        data.forEach(item => {
            if (item.symbol && item.symbol.length <= 5 && item.symbol.match(/^[A-Z]+$/)) {
                if (getShariaStatus(item.symbol).status !== 'Non-Compliant') symbols.push(item.symbol);
            }
        });
        return symbols.length > 0 ? symbols : ['AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA'];
    } catch {
        return ['AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA'];
    }
}

// ==========================================
// 6. جلب بيانات السوق (المطورة والمحمية من الانهيار)
// ==========================================
async function getMarketData(symbol) {
    try {
        // إضافة لاحقة السوق السعودي إذا كان الرمز رقمياً خالصاً
        const yahooSymbol = /^\d+$/.test(symbol) ? `${symbol}.SR` : symbol;
        
        const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?range=5d&interval=5m`, { timeout: 5000 });
        const r = res.data?.chart?.result?.[0];
        if (!r) return null;

        const q = r.indicators.quote[0];
        const close = (q.close || []).filter(v => v !== null);
        const high = (q.high || []).filter(v => v !== null);
        const low = (q.low || []).filter(v => v !== null);
        const volume = (q.volume || []).filter(v => v !== null);

        // الحماية من البيانات غير الكافية للمؤشرات الفنية
        if (close.length < 50) return null;

        const last = close.at(-1);
        const prev = close.at(-2) || last;
        const change = ((last - prev) / prev) * 100;
        const avgVolume = volume.slice(-20).reduce((a,b)=>a+b,0) / Math.max(1, volume.slice(-20).length);

        return {
            symbol,
            close, high, low, volume, // تمرير المصفوفات التاريخية كاملة لإصلاح الـ Crash الفني
            lastPrice: last, 
            change, 
            currentVolume: volume.at(-1) || 0,
            avgVolume
        };
    } catch {
        return null;
    }
}

// ==========================================
// 7. المؤشرات الفنية الرياضية
// ==========================================
function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i-1];
        if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period; let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        avgGain = ((avgGain * (period - 1)) + (diff > 0 ? diff : 0)) / period;
        avgLoss = ((avgLoss * (period - 1)) + (diff < 0 ? -diff : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calculateEMA(data, period) {
    if (!data || data.length === 0) return [0];
    const ema = [];
    const k = 2 / (period + 1);
    ema[0] = data[0];
    for (let i = 1; i < data.length; i++) {
        ema[i] = data[i] * k + ema[i-1] * (1 - k);
    }
    return ema;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (!closes || closes.length < 2) return [0.1];
    const tr = [];
    for (let i = 1; i < closes.length; i++) {
        tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    }
    const atr = [];
    atr[0] = tr.slice(0, period).reduce((a,b)=>a+b,0) / Math.max(1, tr.slice(0, period).length);
    for (let i = 1; i < tr.length; i++) {
        atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period;
    }
    return atr;
}

// ==========================================
// 8. نظام التقييم المتقدم الآمن (KFOO Score)
// ==========================================
function calculateKFOOScore(data) {
    let score = 0;
    const details = [];
    const sharia = getShariaStatus(data.symbol);

    if (sharia.status === 'Non-Compliant') {
        return { score: 0, category: 'BLOCKED', details: ['🕌 مرفوض شرعاً'], sharia };
    }

    // 1. الترند عبر الـ EMA
    const ema50 = calculateEMA(data.close, 50);
    const ema200 = calculateEMA(data.close, Math.min(200, data.close.length - 1));
    const lastEma50 = ema50.at(-1) || 0;
    const lastEma200 = ema200.at(-1) || 0;

    if (data.lastPrice > lastEma50 && lastEma50 > lastEma200) {
        score += 20; details.push('📈 الترند: صاعد (+20)');
    } else {
        details.push('📉 الترند: هابط أو غير مستقر (0)');
    }

    // 2. السيولة
    const volPower = data.currentVolume / (data.avgVolume || 1);
    if (volPower > 2) { score += 20; details.push(`💧 السيولة: انفجارية (+20)`); }
    else if (volPower > 1.5) { score += 10; details.push(`💧 السيولة: جيدة (+10)`); }

    // 3. الزخم عبر الـ RSI
    const rsi = calculateRSI(data.close, 14);
    if (rsi > 55) { score += 20; details.push(`📊 RSI: زخم صعودي قوي (${rsi.toFixed(1)}) (+20)`); }
    else if (rsi > 45) { score += 10; details.push(`📊 RSI: معتدل (${rsi.toFixed(1)}) (+10)`); }

    // 4. الاختراق والقرب من القمة
    const recentHigh = Math.max(...data.high.slice(-20));
    if (data.lastPrice >= recentHigh * 0.98) { score += 20; details.push(`🚀 الاختراق: قريب جداً أو تم الاختراق (+20)`); }

    // 5. التقلب والمدى السعري
    const recentLow = Math.min(...data.low.slice(-20));
    const range = ((recentHigh - recentLow) / recentLow) * 100;
    if (range > 3) { score += 20; details.push(`🎢 التقلب: ممتاز للتداول السريع (+20)`); }

    let category = score >= 80 ? '🔥 HIGH CONVICTION' : score >= 60 ? '✅ OPPORTUNITY' : '📌 WATCHLIST';
    return { score, category, confidence: Math.round(score/10), details, sharia };
}

// ==========================================
// 9. مسح السوق
// ==========================================
async function scanMarket() {
    const results = [];
    const allSymbols = [];

    if (CONFIG.saudi.enabled) allSymbols.push(...SAUDI_STOCKS.map(s => s.symbol));
    if (CONFIG.us.enabled) {
        if (allStocksList.length === 0) allStocksList = await fetchUSStocks();
        allSymbols.push(...allStocksList.slice(0, 50));
    }

    for (const symbol of allSymbols) {
        const data = await getMarketData(symbol);
        if (!data) continue;

        const isSaudi = /^\d+$/.test(symbol);
        const minVolume = isSaudi ? CONFIG.saudi.minVolume : CONFIG.us.minVolume;
        if (data.currentVolume < minVolume) continue;

        const analysis = calculateKFOOScore(data);
        if (analysis.score < 40) continue;

        const atrArr = calculateATR(data.high, data.low, data.close, 14);
        const currentATR = atrArr.at(-1) || (data.lastPrice * 0.02);
        
        results.push({
            symbol,
            market: isSaudi ? '🇸🇦 سعودي' : '🇺🇸 أمريكي',
            price: data.lastPrice, change: data.change,
            score: analysis.score, category: analysis.category,
            confidence: analysis.confidence, details: analysis.details, sharia: analysis.sharia,
            entryPrice: data.lastPrice, target1: data.lastPrice + currentATR * 2, stopLoss: data.lastPrice - currentATR * 1.5
        });
    }

    results.sort((a, b) => b.score - a.score);
    allOpportunities = results;
    return results;
}

// ==========================================
// 10. تنسيق الفرص وإرسالها
// ==========================================
function formatOpportunity(opp, index) {
    const emoji = opp.category.includes('HIGH') ? '🔥' : '✅';
    return `*${index}. ${opp.market} ${opp.symbol}* ${emoji}\n` +
           `🏆 التقييم: ${opp.score}/100 | الثقة: ${opp.confidence}/10\n` +
           `💰 السعر الحالي: $${opp.price.toFixed(2)} (${opp.change.toFixed(2)}%)\n` +
           `━━━━━━━━━━━━━━━━━━━\n` +
           `🎯 الدخول المقترح: $${opp.entryPrice.toFixed(2)}\n` +
           `🚀 الهدف الفني الأول: $${opp.target1.toFixed(2)}\n` +
           `🛑 الوقف الحاسم: $${opp.stopLoss.toFixed(2)}\n` +
           `━━━━━━━━━━━━━━━━━━━\n` +
           `🕌 الشرعية الحالية: ${opp.sharia.status}\n` +
           `📝 إشارات الزخم: ${opp.details.join(' | ')}`;
}

async function sendOpportunities(chatId, opportunities, limit = 5) {
    const top = opportunities.slice(0, limit);
    if (top.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد فرص تطابق المعايير الفنية الصارمة حالياً.');
        return;
    }
    for (let i = 0; i < top.length; i++) {
        await bot.sendMessage(chatId, formatOpportunity(top[i], i + 1), { parse_mode: 'Markdown' });
    }
}

async function sendAutoOpportunities() {
    if (!CONFIG.autoSend || !userId) return;
    const opportunities = await scanMarket();
    const topOpportunities = opportunities.slice(0, CONFIG.alertThreshold);
    if (topOpportunities.length === 0) return;

    if (JSON.stringify(topOpportunities.map(o => o.symbol)) === JSON.stringify(lastSentOpportunities.map(o => o.symbol)) && !isFirstRun) return;
    isFirstRun = false; lastSentOpportunities = topOpportunities;

    await bot.sendMessage(userId, `🔔 *تنبيه تلقائي: تم رصد فرص دخول جديدة فائقة السيولة!*`, { parse_mode: 'Markdown' });
    await sendOpportunities(userId, topOpportunities);
}

// ==========================================
// 11. أوامر البوت ولوحة التحكم العربية
// ==========================================
bot.onText(/\/start|\/بدء/, (msg) => {
    bot.sendMessage(msg.chat.id, `🚀 *مرحباً بك في نظام KFOO VIP الذكي*\n/فرص - مسح السوق الفوري واستخراج الأهداف\n/اعدادات - لوحة التحكم بالأسواق والتنبيهات`);
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري مسح الأسواق المحددة وحساب المؤشرات الفنية الفورية...');
    const opps = await scanMarket();
    await sendOpportunities(msg.chat.id, opps);
});

bot.onText(/\/اعدادات/, (msg) => {
    bot.sendMessage(msg.chat.id, `⚙️ *لوحة تحكم الأسواق والأنظمة*\n🇸🇦 تداول السعودية: ${CONFIG.saudi.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n🇺🇸 تداول أمريكا: ${CONFIG.us.enabled ? '🟢 مفعل' : '🔴 متوقف'}\n\n/تفعيل_سعودي | /ايقاف_سعودي\n/تفعيل_امريكي | /ايقاف_امريكي`);
});

bot.onText(/\/تفعيل_سعودي/, (msg) => { CONFIG.saudi.enabled = true; bot.sendMessage(msg.chat.id, '✅ تم تفعيل مسح وتدقيق السوق السعودي.'); });
bot.onText(/\/ايقاف_سعودي/, (msg) => { CONFIG.saudi.enabled = false; bot.sendMessage(msg.chat.id, '⛔ تم إيقاف عمليات السوق السعودي.'); });
bot.onText(/\/تفعيل_امريكي/, (msg) => { CONFIG.us.enabled = true; bot.sendMessage(msg.chat.id, '✅ تم تفعيل مسح وتدقيق السوق الأمريكي.'); });
bot.onText(/\/ايقاف_امريكي/, (msg) => { CONFIG.us.enabled = false; bot.sendMessage(msg.chat.id, '🔴 تم إيقاف عمليات السوق الأمريكي.'); });

// ==========================================
// 12. تشغيل المزامنات التلقائية والـ Loops
// ==========================================
setInterval(async () => { await scanMarket(); }, CONFIG.scanInterval);
setInterval(sendAutoOpportunities, CONFIG.scanInterval);

async function init() {
    console.log('🚀 KFOO VIP BOT V3.5 Is Live and Guarded...');
    
    // ======= تسجيل الأوامر تليجرام لكي تظهر تلقائياً كقائمة منسدلة عند وضع / =======
    try {
        await bot.setMyCommands([
            { command: 'start', description: 'تشغيل البوت وعرض الترحيب' },
            { command: 'بدء', description: 'تشغيل البوت وعرض الترحيب باللغة العربية' },
            { command: 'فرص', description: 'مسح السوق الفوري واستخراج الأهداف وعمليات الاختراق' },
            { command: 'اعدادات', description: 'لوحة التحكم السريعة بالأسواق والتنبيهات المباشرة' },
            { command: 'تفعيل_سعودي', description: 'تشغيل تتبع ومسح أسهم السوق السعودي' },
            { command: 'ايقاف_سعودي', description: 'تعطيل تتبع ومسح أسهم السوق السعودي' },
            { command: 'تفعيل_امريكي', description: 'تشغيل تتبع ومسح أسهم السوق الأمريكي' },
            { command: 'ايقاف_امريكي', description: 'تعطيل تتبع ومسح أسهم السوق الأمريكي' }
        ]);
        console.log('✅ تم تسجيل قائمة الأوامر المنسدلة بنجاح!');
    } catch (error) {
        console.error('❌ فشل تسجيل قائمة الأوامر:', error.message);
    }
    // =========================================================================

    await scanMarket();
    if (userId) bot.sendMessage(userId, '✅ تم تشغيل نظام KFOO المقاوم لثغرات التوقف والمزامنة التاريخية بنجاح!');
}
init();
