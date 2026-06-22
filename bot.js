const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });

// ===== إعدادات الأسواق =====
let marketSettings = { stocks: true, crypto: true };
let stockList = [];
let cryptoList = [];
let allOpportunities = [];
let signalsHistory = [];

// ===== تحميل سجل الإشارات السابقة =====
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

// ===== قائمة الأسهم المحرمة =====
const forbiddenStocks = [
    'BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'AXP',
    'KO', 'PEP', 'STZ', 'BF.B', 'TAP',
    'MGM', 'WYNN', 'LVS', 'DKNG', 'PENN',
    'PM', 'MO', 'BTI'
];

// ===== دوال جلب البيانات =====
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

// ===== نظام التقييم =====
function calculateScore(data, news, symbol) {
    let score = 0;
    const details = [];
    
    // 1. الأخبار (0-30)
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
    
    // 2. حجم التداول (0-25)
    const volumeRatio = data.volume / (data.volumeAvg || 1);
    let volumeScore = 0;
    if (volumeRatio > 5) volumeScore = 25;
    else if (volumeRatio > 3) volumeScore = 15;
    else if (volumeRatio > 2) volumeScore = 10;
    else if (volumeRatio > 1.5) volumeScore = 5;
    score += volumeScore;
    details.push(`💧 حجم التداول: ${volumeScore}/25 (${volumeRatio.toFixed(2)}x)`);
    
    // 3. الحركة السعرية (0-20)
    const isCrypto = symbol.includes('-USD');
    const sr = data.highPrice;
    const prevHigh = data.prevClose * 1.02;
    let priceScore = 0;
    if (data.lastPrice > prevHigh && data.lastPrice > data.highPrice * 0.98) {
        priceScore = 20; // اختراق مقاومة
    } else if (data.lastPrice > data.highPrice * 0.98) {
        priceScore = 10; // قمة يومية
    } else if (data.change > 1) {
        priceScore = 5; // اتجاه صاعد
    }
    score += priceScore;
    details.push(`📊 الحركة السعرية: ${priceScore}/20 (تغير ${data.change.toFixed(2)}%)`);
    
    // 4. ما قبل الافتتاح (0-15) - للأسهم فقط
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
    
    // 5. المحفزات (0-10)
    let catalystScore = 0;
    const titleLower = news.map(n => n.title.toLowerCase()).join(' ');
    const catalysts = ['earnings', 'profits', 'conference', 'investor', 'regulatory', 'approval', 'contract', 'agreement'];
    catalysts.forEach(c => {
        if (titleLower.includes(c)) catalystScore += 2.5;
    });
    catalystScore = Math.min(catalystScore, 10);
    score += catalystScore;
    details.push(`⚡ المحفزات: ${catalystScore}/10`);
    
    // حساب التطهير
    const p = getPurification(symbol);
    if (p.isForbidden || p.percentage > 5) {
        score = Math.max(score - 20, 0);
        details.push(`🕌 التطهير: -20 (نسبة ${p.percentage}%)`);
    } else {
        details.push(`🕌 التطهير: معتمد (${p.percentage}%)`);
    }
    
    // تحديد الفئة
    let category, confidence;
    if (score >= 80) { category = 'A (Strong Buy)'; confidence = 9; }
    else if (score >= 60) { category = 'B (Good)'; confidence = 7; }
    else if (score >= 40) { category = 'C (Watchlist)'; confidence = 5; }
    else { category = 'D (Monitor)'; confidence = 3; }
    
    // حساب المخاطرة/العائد
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

// ===== مسح السوق بالكامل =====
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
    
    // أخذ عينة عشوائية
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
            
            // تسجيل الإشارة في السجل
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

// ===== عرض أفضل الفرص =====
function formatOpportunities(opportunities, limit = 20) {
    if (opportunities.length === 0) return '📭 لا توجد فرص حالياً';
    
    let message = `🔥 *أفضل الفرص (${opportunities.length})*\n━━━━━━━━━━━━━━━━━━\n`;
    const top = opportunities.slice(0, limit);
    
    top.forEach((opp, i) => {
        const categoryEmoji = opp.category.startsWith('A') ? '🔥' : opp.category.startsWith('B') ? '⭐' : opp.category.startsWith('C') ? '📌' : '👀';
        message +=
            `${i+1}. *${opp.symbol}* ${categoryEmoji} [${opp.category}]\n` +
            `   📊 التقييم: ${opp.score}/100 | الثقة: ${opp.confidence}/10\n` +
            `   💰 السعر: $${opp.price} | التغير: ${opp.change}%\n` +
            `   💧 الحجم: ${opp.volumeRatio}x\n` +
            `   🎯 الدخول: $${opp.entry} | الهدف: $${opp.takeProfit} | وقف: $${opp.stopLoss}\n` +
            `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward}\n` +
            `   📋 ${opp.details.join(' | ')}\n` +
            `━━━━━━━━━━━━━━━━━━\n`;
    });
    return message;
}

// ===== أوامر البوت =====
bot.onText(/\/start|\/بدء/, (msg) => {
    const statusStocks = marketSettings.stocks ? '🟢 مفعل' : '🔴 متوقف';
    const statusCrypto = marketSettings.crypto ? '🟢 مفعل' : '🔴 متوقف';
    
    bot.sendMessage(msg.chat.id,
        `🏠 *القائمة الرئيسية*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق الأمريكي:* ${statusStocks}\n` +
        `🪙 *العملات المشفرة:* ${statusCrypto}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/فرص - عرض أفضل الفرص (نظام التقييم)\n` +
        `/تحليل [الرمز] - تحليل مفصل\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/اختبار - اختبار البوت\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 نظام التقييم: 100 نقطة (أخبار، حجم، حركة، محفزات)`,
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

// ===== تحديث دوري كل 5 دقائق =====
async function periodicUpdate() {
    console.log('🔄 تحديث دوري للفرص...');
    await scanMarket();
    console.log(`✅ تم تحديث ${allOpportunities.length} فرصة`);
}

setInterval(periodicUpdate, 5 * 60 * 1000);

// ===== تحميل القوائم عند بدء التشغيل =====
async function init() {
    console.log('🔄 جاري تحميل قوائم الأسواق...');
    stockList = await fetchStockList();
    cryptoList = await fetchCryptoList();
    console.log(`✅ تم تحميل ${stockList.length} سهماً و ${cryptoList.length} عملة`);
    await periodicUpdate();
    console.log('✅ البوت يعمل بنظام التقييم!');
}

init();
