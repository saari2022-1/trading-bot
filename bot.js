const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const userId = '709023711';
const bot = new TelegramBot(token, { polling: true });

// ===== حالة الإرسال التلقائي =====
let autoSendEnabled = true;  // يبدأ مفعلاً تلقائياً
let lastSentOpportunities = [];
let isFirstRun = true;

// ===== باقي الإعدادات =====
let marketSettings = { stocks: true, crypto: true };
let stockList = [];
let cryptoList = [];
let allOpportunities = [];
let signalsHistory = [];

const HISTORY_FILE = path.join(__dirname, 'signals_history.json');
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            signalsHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        }
    } catch (error) {}
}
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(signalsHistory, null, 2));
    } catch (error) {}
}
loadHistory();

const forbiddenStocks = [
    'BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'AXP',
    'KO', 'PEP', 'STZ', 'BF.B', 'TAP',
    'MGM', 'WYNN', 'LVS', 'DKNG', 'PENN',
    'PM', 'MO', 'BTI'
];

async function fetchStockList() {
    try {
        const response = await axios.get('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv');
        const lines = response.data.split('\n');
        const symbols = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const parts = line.split(',');
                if (parts[0]) {
                    const symbol = parts[0].trim().replace(/"/g, '');
                    if (!forbiddenStocks.includes(symbol)) symbols.push(symbol);
                }
            }
        }
        return symbols;
    } catch (error) {
        return ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
    }
}

async function fetchCryptoList() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false');
        return response.data.map(c => c.symbol.toUpperCase() + '-USD');
    } catch (error) {
        return ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOT-USD', 'AVAX-USD', 'MATIC-USD', 'LINK-USD', 'UNI-USD'];
    }
}

async function getPrice(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 5000 });
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const lastPrice = quote.close[quote.close.length - 1];
        const openPrice = quote.open[0];
        const change = ((lastPrice - openPrice) / openPrice * 100);
        const highPrice = Math.max(...quote.high);
        const lowPrice = Math.min(...quote.low);
        const volume = quote.volume[quote.volume.length - 1] || 0;
        const prevClose = quote.close[quote.close.length - 2] || lastPrice;
        const volumeAvg = quote.volume.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, quote.volume.length);
        return { symbol, lastPrice, change, highPrice, lowPrice, volume, prevClose, volumeAvg };
    } catch (error) { return null; }
}

async function getNews(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`);
        const articles = response.data.news || [];
        return articles.map(a => ({ title: a.title, pubDate: a.providerPublishTime }));
    } catch (error) { return []; }
}

function getPurification(symbol) {
    if (forbiddenStocks.includes(symbol)) {
        return { percentage: 100, isForbidden: true, reason: 'نشاط محرم' };
    }
    const rates = {
        'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3,
        'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2, 'AMD': 0.2,
        'INTC': 0.8, 'NFLX': 0.5, 'ADBE': 1.0, 'CRM': 1.5,
        'ORCL': 1.2, 'IBM': 1.0
    };
    return { percentage: rates[symbol] || 0.5, isForbidden: false, reason: 'نشاط مختلط' };
}

function calculateScore(data, news, symbol) {
    let score = 0;
    const details = [];
    
    if (news.length > 0) {
        const titles = news.map(n => n.title.toLowerCase());
        const strongWords = ['beat', 'surge', 'breakthrough', 'record', 'excellent', 'outstanding', 'revolutionary', 'dominant'];
        const mediumWords = ['growth', 'profit', 'rise', 'upgrade', 'positive', 'gain', 'bullish'];
        const weakWords = ['update', 'plan', 'announce', 'release', 'launch', 'partner'];
        
        let newsScore = 0;
        titles.forEach(title => {
            strongWords.forEach(w => { if (title.includes(w)) newsScore += 3; });
            mediumWords.forEach(w => { if (title.includes(w)) newsScore += 2; });
            weakWords.forEach(w => { if (title.includes(w)) newsScore += 1; });
        });
        const cappedNews = Math.min(newsScore, 30);
        score += cappedNews;
        details.push(`📰 الأخبار: ${cappedNews}/30 (${news.length} خبر)`);
    } else {
        details.push(`📰 الأخبار: 0/30 (لا توجد أخبار)`);
    }
    
    const volumeRatio = data.volume / (data.volumeAvg || 1);
    let volumeScore = 0;
    if (volumeRatio > 5) volumeScore = 25;
    else if (volumeRatio > 3) volumeScore = 15;
    else if (volumeRatio > 2) volumeScore = 10;
    else if (volumeRatio > 1.5) volumeScore = 5;
    score += volumeScore;
    details.push(`💧 حجم التداول: ${volumeScore}/25 (${volumeRatio.toFixed(2)}x)`);
    
    const isCrypto = symbol.includes('-USD');
    const sr = data.highPrice;
    const prevHigh = data.prevClose * 1.02;
    let priceScore = 0;
    if (data.lastPrice > prevHigh && data.lastPrice > data.highPrice * 0.98) {
        priceScore = 20;
    } else if (data.lastPrice > data.highPrice * 0.98) {
        priceScore = 10;
    } else if (data.change > 1) {
        priceScore = 5;
    }
    score += priceScore;
    details.push(`📊 الحركة السعرية: ${priceScore}/20 (تغير ${data.change.toFixed(2)}%)`);
    
    let premarketScore = 0;
    if (!isCrypto) {
        const premarketChange = ((data.lastPrice - data.prevClose) / data.prevClose * 100);
        if (premarketChange > 10) premarketScore = 15;
        else if (premarketChange > 5) premarketScore = 10;
        else if (premarketChange > 2) premarketScore = 5;
        score += premarketScore;
        details.push(`🌅 ما قبل الافتتاح: ${premarketScore}/15 (${premarketChange.toFixed(2)}%)`);
    } else {
        details.push(`🌅 ما قبل الافتتاح: غير متاح للعملات المشفرة`);
    }
    
    let catalystScore = 0;
    const titleLower = news.map(n => n.title.toLowerCase()).join(' ');
    const catalysts = ['earnings', 'profits', 'conference', 'investor', 'regulatory', 'approval', 'contract', 'agreement'];
    catalysts.forEach(c => {
        if (titleLower.includes(c)) catalystScore += 2.5;
    });
    catalystScore = Math.min(catalystScore, 10);
    score += catalystScore;
    details.push(`⚡ المحفزات: ${catalystScore}/10`);
    
    const p = getPurification(symbol);
    if (p.isForbidden || p.percentage > 5) {
        score = Math.max(score - 20, 0);
        details.push(`🕌 التطهير: -20 (نسبة ${p.percentage}%)`);
    } else {
        details.push(`🕌 التطهير: معتمد (${p.percentage}%)`);
    }
    
    let category, confidence;
    if (score >= 80) { category = 'A (Strong Buy)'; confidence = 9; }
    else if (score >= 60) { category = 'B (Good)'; confidence = 7; }
    else if (score >= 40) { category = 'C (Watchlist)'; confidence = 5; }
    else { category = 'D (Monitor)'; confidence = 3; }
    
    const entry = data.lastPrice * 0.98;
    const takeProfit = data.lastPrice * 1.04;
    const stopLoss = data.lastPrice * 0.95;
    const riskReward = ((takeProfit - entry) / (entry - stopLoss)) || 0;
    
    return {
        symbol,
        score: Math.round(score),
        category,
        confidence,
        details,
        entry: entry.toFixed(2),
        takeProfit: takeProfit.toFixed(2),
        stopLoss: stopLoss.toFixed(2),
        riskReward: riskReward.toFixed(2),
        price: data.lastPrice.toFixed(2),
        change: data.change.toFixed(2),
        volumeRatio: volumeRatio.toFixed(2)
    };
}

async function scanMarket() {
    const allSymbols = [];
    const results = [];
    
    if (marketSettings.stocks) {
        if (stockList.length === 0) stockList = await fetchStockList();
        allSymbols.push(...stockList.slice(0, 100));
    }
    if (marketSettings.crypto) {
        if (cryptoList.length === 0) cryptoList = await fetchCryptoList();
        allSymbols.push(...cryptoList.slice(0, 50));
    }
    
    if (allSymbols.length === 0) return [];
    
    const shuffled = allSymbols.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 50);
    
    for (const symbol of selected) {
        try {
            const data = await getPrice(symbol);
            if (!data || !data.lastPrice || data.lastPrice <= 0) continue;
            
            const isCrypto = symbol.includes('-USD');
            if (!isCrypto && data.volume < 100000) continue;
            
            const news = await getNews(symbol);
            const scored = calculateScore(data, news, symbol);
            
            signalsHistory.push({
                timestamp: Date.now(),
                symbol: scored.symbol,
                score: scored.score,
                category: scored.category,
                price: scored.price
            });
            if (signalsHistory.length > 1000) signalsHistory.shift();
            saveHistory();
            
            results.push(scored);
        } catch (error) {}
    }
    
    results.sort((a, b) => b.score - a.score);
    allOpportunities = results;
    return results;
}

function formatOpportunities(opportunities, limit = 20) {
    if (opportunities.length === 0) return '📭 لا توجد فرص حالياً';
    
    let message = `🔥 *أفضل الفرص المتاحة*\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 إجمالي الفرص: ${opportunities.length}\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    const top = opportunities.slice(0, limit);
    
    top.forEach((opp, i) => {
        const isCrypto = opp.symbol.includes('-USD');
        const marketEmoji = isCrypto ? '🪙' : '📈';
        const marketName = isCrypto ? 'عملة مشفرة' : 'سهم أمريكي';
        
        let categoryEmoji, categoryName, color;
        if (opp.category.startsWith('A')) {
            categoryEmoji = '🔥';
            categoryName = 'فرصة ممتازة';
            color = '🟢';
        } else if (opp.category.startsWith('B')) {
            categoryEmoji = '⭐';
            categoryName = 'فرصة جيدة';
            color = '🟡';
        } else if (opp.category.startsWith('C')) {
            categoryEmoji = '📌';
            categoryName = 'يستحق المتابعة';
            color = '🟠';
        } else {
            categoryEmoji = '👀';
            categoryName = 'مراقبة عامة';
            color = '🔵';
        }
        
        let confidenceEmoji = opp.confidence >= 8 ? '🟢' : opp.confidence >= 5 ? '🟡' : '🔴';
        
        message +=
            `*${i+1}. ${marketEmoji} ${opp.symbol}* ${categoryEmoji} (${categoryName})\n` +
            `   ${color} التقييم: ${opp.score}/100 | ${confidenceEmoji} الثقة: ${opp.confidence}/10\n` +
            `   📍 السوق: ${marketName}\n` +
            `   💰 السعر: $${opp.price} | 📈 التغير: ${opp.change}%\n` +
            `   🎯 *نقطة الدخول:* $${opp.entry}\n` +
            `   🚀 *الهدف:* $${opp.takeProfit}\n` +
            `   🛑 *وقف الخسارة:* $${opp.stopLoss}\n` +
            `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward}\n`;
        
        let recommendation = '';
        if (opp.score >= 80) recommendation = '✅ توصية: شراء قوي';
        else if (opp.score >= 60) recommendation = '👀 توصية: مراقبة';
        else if (opp.score >= 40) recommendation = '📌 توصية: إضافة لقائمة المراقبة';
        else recommendation = '⏳ توصية: انتظر فرصة أفضل';
        message += `   💡 ${recommendation}\n`;
        message += `   ────────────────────────\n\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    message += `💡 *نصيحة:* استخدم /تحليل [الرمز] للحصول على تفاصيل كاملة.`;
    return message;
}

// ===== الإرسال التلقائي للفرص =====
async function sendAutoOpportunities() {
    if (!autoSendEnabled) {
        console.log('⏸️ الإرسال التلقائي موقف');
        return;
    }
    
    console.log('🔍 جاري البحث عن الفرص للإرسال التلقائي...');
    const opportunities = await scanMarket();
    
    if (opportunities.length === 0) {
        console.log('📭 لا توجد فرص حالياً');
        return;
    }
    
    const goodOpportunities = opportunities.filter(opp => 
        opp.category.startsWith('A') || opp.category.startsWith('B')
    );
    
    if (goodOpportunities.length === 0) {
        console.log('📭 لا توجد فرص جيدة حالياً');
        return;
    }
    
    const currentSymbols = goodOpportunities.map(o => o.symbol).join(',');
    const lastSymbols = lastSentOpportunities.map(o => o.symbol).join(',');
    
    if (currentSymbols === lastSymbols && !isFirstRun) {
        console.log('⏳ لا توجد فرص جديدة');
        return;
    }
    
    isFirstRun = false;
    lastSentOpportunities = goodOpportunities;
    
    const message = `🔔 *تنبيه تلقائي: فرص جديدة!*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📊 تم العثور على ${goodOpportunities.length} فرصة جديدة.\n` +
                    `🕒 ${new Date().toLocaleTimeString()}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💡 استخدم /فرص لعرض التفاصيل الكاملة.\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `⏸️ لإيقاف التنبيهات: /ايقاف_تنبيه`;
    
    bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
}

// ===== أوامر تشغيل/إيقاف الإرسال التلقائي =====
bot.onText(/\/تفعيل_تنبيه/, (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    autoSendEnabled = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل التنبيهات التلقائية*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_تنبيه/, (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    autoSendEnabled = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف التنبيهات التلقائية*', { parse_mode: 'Markdown' });
});

// ===== الأوامر الأساسية =====
bot.onText(/\/start|\/بدء/, (msg) => {
    const statusStocks = marketSettings.stocks ? '🟢 مفعل' : '🔴 متوقف';
    const statusCrypto = marketSettings.crypto ? '🟢 مفعل' : '🔴 متوقف';
    const autoStatus = autoSendEnabled ? '🟢 مفعل' : '🔴 متوقف';
    
    bot.sendMessage(msg.chat.id,
        `🏠 *القائمة الرئيسية*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق الأمريكي:* ${statusStocks}\n` +
        `🪙 *العملات المشفرة:* ${statusCrypto}\n` +
        `🔔 *التنبيهات التلقائية:* ${autoStatus}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/تحليل [الرمز] - تحليل مفصل\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/اختبار - اختبار البوت\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *التنبيهات:*\n` +
        `/تفعيل_تنبيه - تشغيل التنبيهات التلقائية\n` +
        `/ايقاف_تنبيه - إيقاف التنبيهات التلقائية\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 البوت يرسل تنبيهات كل 5 دقائق عند وجود فرص جديدة.`,
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

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري تقييم الفرص...');
    const opportunities = await scanMarket();
    const message = formatOpportunities(opportunities);
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تحليل (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);
    
    const data = await getPrice(symbol);
    if (!data) {
        bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`);
        return;
    }
    
    const news = await getNews(symbol);
    const analysis = calculateScore(data, news, symbol);
    
    let message = `📊 *تحليل ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 التقييم: ${analysis.score}/100\n`;
    message += `🏷️ الفئة: ${analysis.category}\n`;
    message += `🎯 الثقة: ${analysis.confidence}/10\n`;
    message += `💰 السعر: $${analysis.price}\n`;
    message += `📈 التغير: ${analysis.change}%\n`;
    message += `💧 الحجم: ${analysis.volumeRatio}x\n`;
    message += `🎯 الدخول: $${analysis.entry}\n`;
    message += `🚀 الهدف: $${analysis.takeProfit}\n`;
    message += `🛑 وقف: $${analysis.stopLoss}\n`;
    message += `⚖️ المخاطرة/العائد: 1:${analysis.riskReward}\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += analysis.details.join('\n');
    
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/احصائيات/, (msg) => {
    const total = signalsHistory.length;
    if (total === 0) {
        bot.sendMessage(msg.chat.id, '📊 لا توجد إشارات مسجلة');
        return;
    }
    const avgScore = signalsHistory.reduce((s, sig) => s + sig.score, 0) / total;
    const categories = {
        'A': signalsHistory.filter(s => s.category.startsWith('A')).length,
        'B': signalsHistory.filter(s => s.category.startsWith('B')).length,
        'C': signalsHistory.filter(s => s.category.startsWith('C')).length,
        'D': signalsHistory.filter(s => s.category.startsWith('D')).length
    };
    const lastSignal = signalsHistory[signalsHistory.length - 1];
    
    bot.sendMessage(msg.chat.id,
        `📊 *إحصائيات الإشارات*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 إجمالي الإشارات: ${total}\n` +
        `📊 متوسط التقييم: ${avgScore.toFixed(1)}/100\n` +
        `🔥 الفئة A: ${categories.A}\n` +
        `⭐ الفئة B: ${categories.B}\n` +
        `📌 الفئة C: ${categories.C}\n` +
        `👀 الفئة D: ${categories.D}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕒 آخر إشارة: ${lastSignal.symbol} (${lastSignal.score}/100)`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/test|\/اختبار/, (msg) => {
    bot.sendMessage(msg.chat.id, '✅ البوت يعمل بشكل ممتاز!');
});

// ===== تحديث دوري =====
async function periodicUpdate() {
    console.log('🔄 تحديث دوري للفرص...');
    await scanMarket();
    console.log(`✅ تم تحديث ${allOpportunities.length} فرصة`);
}

setInterval(periodicUpdate, 5 * 60 * 1000);
setInterval(sendAutoOpportunities, 5 * 60 * 1000);
setTimeout(sendAutoOpportunities, 30000);

async function init() {
    console.log('🔄 جاري تحميل قوائم الأسواق...');
    stockList = await fetchStockList();
    cryptoList = await fetchCryptoList();
    console.log(`✅ تم تحميل ${stockList.length} سهماً و ${cryptoList.length} عملة`);
    await periodicUpdate();
    console.log('✅ البوت يعمل بنظام الإرسال التلقائي!');
}

init();
