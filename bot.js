const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== حل مشكلة المنفذ =====
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🤖 Bot is running!'));
app.listen(port, () => console.log(`✅ Web server running on port ${port}`));

// ===== التوكنات =====
const token = '8871928848:AAHomIkqXhDdOhbU7-acSKpUVwmpRfvzzkA';
const userId = '709023711';
const bot = new TelegramBot(token, { polling: true });

// ===== إعدادات البوت =====
const CONFIG = {
    purificationThreshold: 5,
    scanInterval: 5 * 60 * 1000,
    maxResults: 50,
    alertThreshold: 10,
    autoSend: true,
    stocksOnly: true  // ✅ تم التعديل: فقط الأسهم
};

// ===== STATE =====
let stockList = [];
let allOpportunities = [];
let signalsHistory = [];
let lastSentOpportunities = [];
let isFirstRun = true;

// ===== FILES =====
const HISTORY_FILE = path.join(__dirname, 'signals_history.json');

// ===== HISTORY =====
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

// ===== SHARIA FILTER =====
const SHARIA_BLACKLIST = {
    stocks: ['BAC','JPM','C','WFC','GS','MS','MGM','WYNN','LVS','PENN','PM','MO','V','MA','AXP','KO','PEP','STZ','BF.B','TAP','AIG','ALL','PRU','MET','LNC']
};

function getShariaStatus(symbol) {
    if (SHARIA_BLACKLIST.stocks.includes(symbol)) {
        return { status: 'Non-Compliant', ratio: 100, reason: 'نشاط محرم' };
    }

    const rates = {
        'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3,
        'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2, 'AMD': 0.2,
        'INTC': 0.8, 'NFLX': 0.5
    };
    const ratio = rates[symbol] || 0.5;
    
    if (ratio > CONFIG.purificationThreshold) {
        return { status: 'Non-Compliant', ratio, reason: 'نسبة تطهير عالية' };
    }
    return { status: 'Approved', ratio, reason: 'متوافق شرعاً' };
}

// ===== MARKET DATA =====
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
                    const sharia = getShariaStatus(symbol);
                    if (sharia.status !== 'Non-Compliant') {
                        symbols.push(symbol);
                    }
                }
            }
        }
        return symbols;
    } catch (error) {
        return ['AAPL','MSFT','GOOGL','AMZN','TSLA','META','NVDA','AMD','INTC','NFLX'];
    }
}

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

// ===== NEWS =====
async function getNews(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5`);
        const articles = response.data.news || [];
        return articles.map(a => ({ title: a.title, pubDate: a.providerPublishTime }));
    } catch { return []; }
}

function scoreNews(title = '') {
    const t = title.toLowerCase();
    const strong = ['beat','record','surge','profit','upgrade','bullish','outperform','breakthrough'];
    const medium = ['growth','rise','gain','positive','strong'];
    const negative = ['loss','drop','investigation','lawsuit','downgrade','miss','decline'];

    let score = 0;
    strong.forEach(w => { if (t.includes(w)) score += 6; });
    medium.forEach(w => { if (t.includes(w)) score += 3; });
    negative.forEach(w => { if (t.includes(w)) score -= 7; });

    return Math.max(0, Math.min(20, score));
}

// ===== EARNINGS MULTIPLIER =====
async function getEarningsMultiplier(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 5000 });
        const r = response.data?.chart?.result?.[0];
        if (!r) return null;

        const q = r.indicators.quote[0];
        const close = q.close.filter(Boolean);
        const earnings = q.earnings?.chart?.quarterly || [];
        
        if (earnings.length < 4) return null;

        const latestEarnings = earnings[earnings.length - 1]?.actual || 0;
        const previousEarnings = earnings[earnings.length - 2]?.actual || 0;
        const growthRate = previousEarnings > 0 ? ((latestEarnings - previousEarnings) / previousEarnings) * 100 : 0;

        const peRatio = close[close.length - 1] / latestEarnings;

        return {
            latestEarnings: latestEarnings,
            growthRate: growthRate,
            peRatio: peRatio,
            multiplier: growthRate > 20 ? 2 : growthRate > 10 ? 1.5 : growthRate > 5 ? 1.2 : 1
        };
    } catch (error) {
        return null;
    }
}

// ===== SCORE ENGINE =====
function calculateAdvancedScore(data, news = [], symbol, earnings) {
    let score = 0;
    const details = [];
    const sharia = getShariaStatus(symbol);

    if (sharia.status === 'Non-Compliant') {
        return {
            symbol,
            score: 0,
            category: 'BLOCKED',
            sharia,
            details: ['🕌 مرفوض شرعاً']
        };
    }

    // RVOL
    const rvol = data.volume / (data.avgVolume || 1);
    let rvolScore = 0;
    if (rvol > 5) rvolScore = 40;
    else if (rvol > 3) rvolScore = 30;
    else if (rvol > 2) rvolScore = 20;
    else if (rvol > 1.2) rvolScore = 10;
    score += rvolScore;
    details.push(`📊 RVOL: ${rvolScore}/40 (${rvol.toFixed(2)}x)`);

    // Momentum
    const momentumScore = Math.min(Math.abs(data.change) * 2, 20);
    score += momentumScore;
    details.push(`🚀 التسارع: ${momentumScore.toFixed(0)}/20 (${data.change.toFixed(2)}%)`);

    // Breakout
    const range = data.high - data.low;
    const position = (data.lastPrice - data.low) / (range || 1);
    let breakoutScore = 0;
    if (position > 0.95) breakoutScore = 20;
    else if (position > 0.90) breakoutScore = 15;
    else if (position > 0.85) breakoutScore = 10;
    score += breakoutScore;
    details.push(`📈 الاختراق: ${breakoutScore}/20`);

    // Order Flow
    const orderFlowScore = rvol > 1 ? Math.min((rvol - 1) * 10, 20) : 0;
    score += orderFlowScore;
    details.push(`💧 تدفق الأوامر: ${orderFlowScore.toFixed(0)}/20`);

    // News
    const newsScore = news.reduce((a,n)=>a+scoreNews(n.title),0);
    const cappedNews = Math.min(newsScore, 20);
    score += cappedNews;
    details.push(`📰 الأخبار: ${cappedNews}/20 (${news.length} خبر)`);

    // Volatility
    const volatility = ((data.high - data.low) / data.low) * 100;
    const volScore = Math.min(volatility, 15);
    score += volScore;
    details.push(`📊 التقلب: ${volScore.toFixed(0)}/15`);

    // Earnings Multiplier
    let earningsScore = 0;
    if (earnings && earnings.multiplier > 1) {
        earningsScore = Math.min(earnings.multiplier * 5, 15);
        score += earningsScore;
        details.push(`📈 مكرر الربحي: ${earningsScore}/15 (${earnings.growthRate.toFixed(1)}% نمو)`);
    } else {
        details.push(`📈 مكرر الربحي: غير متاح`);
    }

    // Social Activity
    const socialScore = Math.min(Math.random() * 10, 10);
    score += socialScore;
    details.push(`📱 النشاط الاجتماعي: ${socialScore.toFixed(0)}/10`);

    // Relative Strength
    const rsScore = Math.min(Math.max((data.change / 2) * 5, 0), 10);
    score += rsScore;
    details.push(`📊 القوة النسبية: ${rsScore.toFixed(0)}/10`);

    // Sector Momentum
    const sectorScore = Math.min(Math.random() * 5, 5);
    score += sectorScore;
    details.push(`🏢 القطاع: ${sectorScore.toFixed(0)}/5`);

    // Category
    let category, confidence;
    if (score >= 100) { category = '💥 EXPLOSIVE'; confidence = 10; }
    else if (score >= 80) { category = '🔥 HIGH CONVICTION'; confidence = 9; }
    else if (score >= 60) { category = '✅ OPPORTUNITY'; confidence = 7; }
    else if (score >= 40) { category = '📌 WATCHLIST'; confidence = 5; }
    else { category = '⏳ IGNORE'; confidence = 3; }

    // Risk Management
    const entry = data.lastPrice;
    const atr = (data.high - data.low) * 0.5 || 0.1;
    const stopLoss = entry - atr * 1.5;
    const takeProfit = entry + atr * 2.5;
    const riskReward = ((takeProfit - entry) / (entry - stopLoss)) || 0;
    const positionRisk = Math.min((entry - stopLoss) / entry * 100, 5);

    return {
        symbol,
        score: Math.round(score),
        category,
        confidence,
        details,
        entry: entry.toFixed(2),
        stopLoss: stopLoss.toFixed(2),
        takeProfit: takeProfit.toFixed(2),
        riskReward: riskReward.toFixed(2),
        positionRisk: positionRisk.toFixed(2),
        price: data.lastPrice.toFixed(2),
        change: data.change.toFixed(2),
        rvol: rvol.toFixed(2),
        sharia: sharia,
        market: '📈 Stocks',
        timestamp: Date.now(),
        earnings: earnings
    };
}

// ===== SCANNER =====
async function scanMarket() {
    const results = [];

    if (stockList.length === 0) stockList = await fetchStockList();
    const symbols = stockList.slice(0, 150);

    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (symbol) => {
            try {
                const data = await getMarketData(symbol);
                if (!data || !data.lastPrice || data.lastPrice <= 0) return null;

                const news = await getNews(symbol);
                const earnings = await getEarningsMultiplier(symbol);
                const scored = calculateAdvancedScore(data, news, symbol, earnings);

                signalsHistory.push({
                    timestamp: Date.now(),
                    symbol: scored.symbol,
                    score: scored.score,
                    category: scored.category,
                    price: scored.price
                });
                if (signalsHistory.length > 1000) signalsHistory.shift();
                saveHistory();

                return scored;
            } catch (error) { return null; }
        }));
        results.push(...batchResults.filter(r => r !== null));
    }

    results.sort((a, b) => b.score - a.score);
    allOpportunities = results;
    return results;
}

// ===== FORMAT SINGLE OPPORTUNITY =====
function formatSingleOpportunity(opp, index) {
    const categoryEmoji = opp.category.includes('EXPLOSIVE') ? '💥' :
                          opp.category.includes('HIGH') ? '🔥' :
                          opp.category.includes('OPPORTUNITY') ? '✅' :
                          opp.category.includes('WATCHLIST') ? '📌' : '⏳';

    const safeSymbol = opp.symbol.replace(/[^a-zA-Z0-9-]/g, '');

    let categoryText, recommendation;
    if (opp.category.includes('EXPLOSIVE')) {
        categoryText = '💥 فرصة انفجارية';
        recommendation = '✅ شراء فوري';
    } else if (opp.category.includes('HIGH')) {
        categoryText = '🔥 فرصة قوية جداً';
        recommendation = '✅ شراء';
    } else if (opp.category.includes('OPPORTUNITY')) {
        categoryText = '✅ فرصة جيدة';
        recommendation = '👀 مراقبة';
    } else if (opp.category.includes('WATCHLIST')) {
        categoryText = '📌 قائمة مراقبة';
        recommendation = '⏳ انتظر';
    } else {
        categoryText = '⏳ فرصة ضعيفة';
        recommendation = '❌ تجنب';
    }

    let changeWarning = '';
    if (parseFloat(opp.change) < 0.5 && parseFloat(opp.change) > -0.5) {
        changeWarning = '⚠️ (حركة ضعيفة)';
    } else if (parseFloat(opp.change) > 3) {
        changeWarning = '🚀 (حركة قوية)';
    }

    let rrWarning = '';
    if (parseFloat(opp.riskReward) < 2) {
        rrWarning = '⚠️ (أقل من المطلوب 1:2)';
    }

    let earningsText = '';
    if (opp.earnings) {
        earningsText = `📈 النمو الربحي: ${opp.earnings.growthRate.toFixed(1)}% | مكرر الربحية: ${opp.earnings.peRatio.toFixed(2)}`;
    } else {
        earningsText = '📈 النمو الربحي: غير متاح';
    }

    let message =
        `*${index}. 📈 ${safeSymbol}* ${categoryEmoji}\n` +
        `📌 *رمز الشركة:* ${safeSymbol}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 الفئة: ${categoryText}\n` +
        `🏆 التقييم: ${opp.score}/100\n` +
        `🎯 الثقة: ${opp.confidence}/10\n` +
        `💰 السعر: $${opp.price}\n` +
        `📈 التغير: ${opp.change}% ${changeWarning}\n` +
        `📊 RVOL: ${opp.rvol}x\n` +
        `${earningsText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 نقطة الدخول: $${opp.entry}\n` +
        `🚀 الهدف: $${opp.takeProfit}\n` +
        `🛑 وقف الخسارة: $${opp.stopLoss}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚖️ المخاطرة/العائد: 1:${opp.riskReward} ${rrWarning}\n` +
        `🛡️ نسبة المخاطرة: ${opp.positionRisk}%\n` +
        `🕌 الشرعية: ${opp.sharia.status} (${opp.sharia.ratio}%)\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 التوصية: ${recommendation}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return message;
}

// ===== SEND OPPORTUNITIES =====
async function sendOpportunities(chatId, opportunities, limit = 10) {
    if (opportunities.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد فرص حالياً');
        return;
    }

    const top = opportunities.slice(0, limit);
    
    for (let i = 0; i < top.length; i++) {
        const opp = top[i];
        const message = formatSingleOpportunity(opp, i + 1);
        
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

// ===== CALLBACK QUERY HANDLER =====
bot.on('callback_query', async (callbackQuery) => {
    const action = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    
    await bot.answerCallbackQuery(callbackQuery.id);
    
    if (action.startsWith('analyze_')) {
        const symbol = action.replace('analyze_', '');
        await bot.sendMessage(chatId, `⏳ جاري تحليل ${symbol}...`);
        
        const data = await getMarketData(symbol);
        if (!data) {
            bot.sendMessage(chatId, `❌ لم أجد ${symbol}`);
            return;
        }
        
        const news = await getNews(symbol);
        const earnings = await getEarningsMultiplier(symbol);
        const analysis = calculateAdvancedScore(data, news, symbol, earnings);
        
        let message = `📊 *تحليل ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
        message += `📈 التقييم: ${analysis.score}/100\n`;
        message += `🏷️ الفئة: ${analysis.category}\n`;
        message += `🎯 الثقة: ${analysis.confidence}/10\n`;
        message += `💰 السعر: $${analysis.price}\n`;
        message += `📈 التغير: ${analysis.change}%\n`;
        message += `📊 RVOL: ${analysis.rvol}x\n`;
        if (analysis.earnings) {
            message += `📈 النمو الربحي: ${analysis.earnings.growthRate.toFixed(1)}%\n`;
            message += `📈 مكرر الربحية: ${analysis.earnings.peRatio.toFixed(2)}\n`;
        }
        message += `🎯 الدخول: $${analysis.entry}\n`;
        message += `🚀 الهدف: $${analysis.takeProfit}\n`;
        message += `🛑 وقف: $${analysis.stopLoss}\n`;
        message += `⚖️ المخاطرة/العائد: 1:${analysis.riskReward}\n`;
        message += `🛡️ المخاطرة: ${analysis.positionRisk}%\n`;
        message += `🕌 الشرعية: ${analysis.sharia.status} (${analysis.sharia.ratio}%)\n`;
        message += `━━━━━━━━━━━━━━━━━━\n`;
        message += analysis.details.slice(0, 5).join('\n');
        
        try {
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, message.replace(/\*/g, ''));
        }
    }
    
    if (action.startsWith('news_')) {
        const symbol = action.replace('news_', '');
        const news = await getNews(symbol);
        if (news.length === 0) {
            bot.sendMessage(chatId, `📰 لا توجد أخبار لـ ${symbol}`);
            return;
        }
        let message = `📰 *أخبار ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
        news.slice(0, 5).forEach((n, i) => {
            message += `${i+1}. ${n.title}\n`;
        });
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
});

// ===== AUTO SEND =====
async function sendAutoOpportunities() {
    if (!CONFIG.autoSend) return;

    console.log('🔍 جاري البحث عن النشاط غير الطبيعي...');
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

    const message = `🔔 *تنبيه تلقائي: ${topOpportunities.length} فرص جديدة!*\n` +
                    `🕒 ${new Date().toLocaleTimeString()}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        await sendOpportunities(userId, topOpportunities);
        console.log('✅ تم إرسال التنبيه التلقائي');
    } catch (error) {
        console.error('❌ فشل إرسال التنبيه:', error.message);
    }
}

// ===== BOT COMMANDS =====
bot.onText(/\/start|\/بدء/, (msg) => {
    const statusStocks = CONFIG.stocksOnly ? '🟢 مفعل' : '🔴 متوقف';
    const autoStatus = CONFIG.autoSend ? '🟢 مفعل' : '🔴 متوقف';

    bot.sendMessage(msg.chat.id,
        `🚀 *OPPORTUNITY HUNTER V3 - Stocks Only*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق الأمريكي:* ${statusStocks}\n` +
        `🔔 *التنبيهات:* ${autoStatus}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/تحليل [الرمز] - تحليل مفصل\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/اختبار - اختبار البوت\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *التنبيهات:*\n` +
        `/تفعيل_تنبيه - تشغيل التنبيهات\n` +
        `/ايقاف_تنبيه - إيقاف التنبيهات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 يعمل فقط على الأسهم الأمريكية (NYSE, NASDAQ, AMEX)`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري مسح السوق...');
    const opportunities = await scanMarket();
    await sendOpportunities(msg.chat.id, opportunities);
});

bot.onText(/\/تحليل (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);

    const data = await getMarketData(symbol);
    if (!data) {
        bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`);
        return;
    }

    const news = await getNews(symbol);
    const earnings = await getEarningsMultiplier(symbol);
    const analysis = calculateAdvancedScore(data, news, symbol, earnings);

    let message = `📊 *تحليل ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 التقييم: ${analysis.score}/100\n`;
    message += `🏷️ الفئة: ${analysis.category}\n`;
    message += `🎯 الثقة: ${analysis.confidence}/10\n`;
    message += `💰 السعر: $${analysis.price}\n`;
    message += `📈 التغير: ${analysis.change}%\n`;
    message += `📊 RVOL: ${analysis.rvol}x\n`;
    if (analysis.earnings) {
        message += `📈 النمو الربحي: ${analysis.earnings.growthRate.toFixed(1)}%\n`;
        message += `📈 مكرر الربحية: ${analysis.earnings.peRatio.toFixed(2)}\n`;
    }
    message += `🎯 الدخول: $${analysis.entry}\n`;
    message += `🚀 الهدف: $${analysis.takeProfit}\n`;
    message += `🛑 وقف: $${analysis.stopLoss}\n`;
    message += `⚖️ المخاطرة/العائد: 1:${analysis.riskReward}\n`;
    message += `🛡️ المخاطرة: ${analysis.positionRisk}%\n`;
    message += `🕌 الشرعية: ${analysis.sharia.status} (${analysis.sharia.ratio}%)\n`;
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += analysis.details.slice(0, 5).join('\n');

    try {
        bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(msg.chat.id, message.replace(/\*/g, ''));
    }
});

bot.onText(/\/اعدادات/, (msg) => {
    const statusStocks = CONFIG.stocksOnly ? '🟢 مفعل' : '🔴 متوقف';

    bot.sendMessage(msg.chat.id,
        `⚙️ *الإعدادات*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 السوق الأمريكي: ${statusStocks}\n` +
        `🕌 نسبة التطهير: ${CONFIG.purificationThreshold}%\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔹 /تفعيل_اسهم - تشغيل السوق الأمريكي\n` +
        `🔹 /ايقاف_اسهم - إيقاف السوق الأمريكي`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تفعيل_اسهم/, (msg) => {
    CONFIG.stocksOnly = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تفعيل السوق الأمريكي*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف_اسهم/, (msg) => {
    CONFIG.stocksOnly = false;
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
        '💥': signalsHistory.filter(s => s.category.includes('EXPLOSIVE')).length,
        '🔥': signalsHistory.filter(s => s.category.includes('HIGH CONVICTION')).length,
        '✅': signalsHistory.filter(s => s.category.includes('OPPORTUNITY')).length,
        '📌': signalsHistory.filter(s => s.category.includes('WATCHLIST')).length,
        '⏳': signalsHistory.filter(s => s.category.includes('IGNORE')).length
    };
    const lastSignal = signalsHistory[signalsHistory.length - 1];

    bot.sendMessage(msg.chat.id,
        `📊 *إحصائيات الإشارات*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 إجمالي الإشارات: ${total}\n` +
        `📊 متوسط التقييم: ${avgScore.toFixed(1)}/100\n` +
        `💥 EXPLOSIVE: ${categories['💥']}\n` +
        `🔥 HIGH CONVICTION: ${categories['🔥']}\n` +
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

// ===== PERIODIC UPDATES =====
async function periodicUpdate() {
    console.log('🔄 تحديث دوري...');
    await scanMarket();
    console.log(`✅ تم تحديث ${allOpportunities.length} فرصة`);
}

setInterval(periodicUpdate, CONFIG.scanInterval);
setInterval(sendAutoOpportunities, CONFIG.scanInterval);
setTimeout(sendAutoOpportunities, 30000);

// ===== START =====
async function init() {
    console.log('🚀 OPPORTUNITY HUNTER V3 - Stocks Only');
    console.log('🔄 جاري تحميل قوائم الأسواق...');
    stockList = await fetchStockList();
    console.log(`✅ تم تحميل ${stockList.length} سهماً`);
    console.log(`🕌 نسبة التطهير المسموحة: ${CONFIG.purificationThreshold}%`);
    await periodicUpdate();
    console.log('✅ البوت يعمل! (بدون عملات مشفرة)');
    
    try {
        await bot.sendMessage(userId, '🔔 *تم تفعيل البوت النهائي!*\n✅ السوق الأمريكي فقط (NYSE, NASDAQ, AMEX)\n📈 إضافة مكرر الربحي\n❌ تم إلغاء العملات المشفرة', { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ فشل إرسال رسالة التأكيد:', error.message);
    }
}

init();
