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
    scanInterval: 2 * 60 * 1000, // دقيقتين
    maxResults: 50,
    alertThreshold: 10,
    autoSend: true,
    stocksOnly: true,
    maxStocksToScan: 200,
    updateInterval: 60 * 60 * 1000 // كل ساعة
};

// ===== STATE =====
let allStocksList = [];
let allOpportunities = [];
let signalsHistory = [];
let lastSentOpportunities = [];
let isFirstRun = true;
let lastUpdateTime = 0;

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

// ===== جلب جميع الأسهم =====
async function fetchAllStocks() {
    try {
        console.log('🔄 جاري تحميل قائمة جميع الأسهم الأمريكية...');
        const symbols = new Set();
        
        try {
            const response = await axios.get(
                `https://query1.finance.yahoo.com/v1/finance/screener?market=us&region=US&count=1000`,
                { timeout: 10000 }
            );
            const data = response.data?.finance?.result?.[0]?.documents || [];
            data.forEach(item => {
                if (item.symbol && item.symbol.length <= 5 && item.symbol.match(/^[A-Z]+$/)) {
                    symbols.add(item.symbol);
                }
            });
            console.log(`✅ جلب ${symbols.size} سهماً من Yahoo Finance`);
        } catch (error) {
            console.log('⚠️ خطأ في جلب Yahoo Finance:', error.message);
        }
        
        if (symbols.size < 100) {
            console.log('⚠️ عدد الأسهم قليل، جلب قائمة S&P 500...');
            const fallback = await fetchFallbackStocks();
            fallback.forEach(s => symbols.add(s));
        }
        
        const uniqueSymbols = [...symbols]
            .filter(s => s && s.length > 0 && s.length <= 5)
            .filter(s => !s.includes('^') && !s.includes('.') && !s.includes('-'))
            .filter(s => s.match(/^[A-Z]+$/));
        
        console.log(`✅ تم تحميل ${uniqueSymbols.length} سهماً من السوق الأمريكي`);
        return uniqueSymbols;
    } catch (error) {
        console.log('❌ خطأ في جلب الأسهم:', error.message);
        return await fetchFallbackStocks();
    }
}

// ===== قائمة احتياطية =====
async function fetchFallbackStocks() {
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
                    if (!SHARIA_BLACKLIST.includes(symbol)) {
                        symbols.push(symbol);
                    }
                }
            }
        }
        console.log(`✅ تم تحميل ${symbols.length} سهماً (قائمة احتياطية)`);
        return symbols;
    } catch (error) {
        console.log('❌ خطأ في القائمة الاحتياطية:', error.message);
        return ['AAPL','MSFT','GOOGL','AMZN','TSLA','META','NVDA','AMD','INTC','NFLX'];
    }
}

// ===== تحديث القائمة دورياً =====
async function updateStockList() {
    const now = Date.now();
    if (now - lastUpdateTime < CONFIG.updateInterval && allStocksList.length > 0) {
        console.log('⏳ تحديث القائمة ليس ضرورياً (تم التحديث مؤخراً)');
        return;
    }
    
    console.log('🔄 تحديث قائمة الأسهم...');
    const newList = await fetchAllStocks();
    if (newList.length > allStocksList.length) {
        const added = newList.length - allStocksList.length;
        console.log(`✅ تم إضافة ${added} شركة جديدة إلى القائمة`);
    } else if (newList.length < allStocksList.length) {
        console.log(`⚠️ القائمة الجديدة أصغر (قد تكون بعض الأسهم غير نشطة)`);
    }
    allStocksList = newList;
    lastUpdateTime = now;
    console.log(`✅ القائمة محدثة: ${allStocksList.length} شركة`);
}

// ===== MARKET DATA =====
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
        const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=3`);
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
        
        if (r) {
            const q = r.indicators.quote[0];
            const close = q.close.filter(Boolean);
            const earnings = q.earnings?.chart?.quarterly || [];
            
            if (earnings.length >= 4) {
                const latestEarnings = earnings[earnings.length - 1]?.actual || 0;
                const previousEarnings = earnings[earnings.length - 2]?.actual || 0;
                const growthRate = previousEarnings > 0 ? ((latestEarnings - previousEarnings) / previousEarnings) * 100 : 0;
                const peRatio = close[close.length - 1] / (latestEarnings || 1);
                
                if (latestEarnings > 0 && peRatio > 0) {
                    return {
                        latestEarnings: latestEarnings,
                        growthRate: growthRate,
                        peRatio: peRatio,
                        multiplier: growthRate > 20 ? 2 : growthRate > 10 ? 1.5 : growthRate > 5 ? 1.2 : 1,
                        source: 'Yahoo Finance',
                        estimated: false
                    };
                }
            }
        }
        
        return null;
    } catch (error) {
        return null;
    }
}

// ===== MARKET CAP =====
async function getMarketCap(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { timeout: 5000 });
        const r = response.data?.chart?.result?.[0];
        if (!r) return null;

        const meta = r.meta;
        const quote = r.indicators.quote[0];
        const lastPrice = quote.close[quote.close.length - 1];
        const sharesOutstanding = meta.sharesOutstanding || (quote.volume[quote.volume.length - 1] * 10);
        const marketCap = lastPrice * sharesOutstanding;
        
        return {
            marketCap: marketCap,
            marketCapBillion: marketCap / 1e9,
            sharesOutstanding: sharesOutstanding,
            price: lastPrice
        };
    } catch (error) {
        return null;
    }
}

// ===== نظام تأكيد الفرصة =====
let opportunityTracker = {};

async function confirmOpportunity(symbol, currentScore, threshold = 40) {
    if (!opportunityTracker[symbol]) {
        opportunityTracker[symbol] = {
            firstSeen: Date.now(),
            scores: [],
            confirmed: false,
            confirmedAt: null
        };
    }
    
    const tracker = opportunityTracker[symbol];
    tracker.scores.push(currentScore);
    
    if (tracker.scores.length > 3) {
        tracker.scores.shift();
    }
    
    if (tracker.scores.length >= 3) {
        const allAboveThreshold = tracker.scores.every(s => s >= threshold);
        if (allAboveThreshold && !tracker.confirmed) {
            tracker.confirmed = true;
            tracker.confirmedAt = Date.now();
            return true;
        }
    }
    
    return false;
}

// ===== كشف الانفجار السعري =====
function detectPriceExplosion(data, rvol) {
    const isHighVolume = rvol > 3;
    const isStrongMove = Math.abs(data.change) > 2;
    const isBreakout = ((data.lastPrice - data.low) / (data.high - data.low || 1)) > 0.95;
    
    if (isHighVolume && isStrongMove && isBreakout) {
        return {
            isExplosion: true,
            level: '💥 انفجاري',
            score: 30,
            details: `RVOL ${rvol.toFixed(2)}x + حركة ${data.change.toFixed(2)}% + اختراق`
        };
    } else if (isHighVolume && isStrongMove) {
        return {
            isExplosion: true,
            level: '🔥 قوي',
            score: 20,
            details: `RVOL ${rvol.toFixed(2)}x + حركة ${data.change.toFixed(2)}%`
        };
    } else if (isHighVolume) {
        return {
            isExplosion: true,
            level: '📊 متوسط',
            score: 10,
            details: `RVOL ${rvol.toFixed(2)}x`
        };
    }
    
    return {
        isExplosion: false,
        level: null,
        score: 0,
        details: null
    };
}

// ===== SCORE ENGINE =====
function calculateAdvancedScore(data, news = [], symbol, earnings, marketCap) {
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

    // ===== RVOL =====
    const rvol = data.volume / (data.avgVolume || 1);
    let rvolScore = 0;
    if (rvol > 5) rvolScore = 40;
    else if (rvol > 3) rvolScore = 30;
    else if (rvol > 2) rvolScore = 20;
    else if (rvol > 1.2) rvolScore = 10;
    score += rvolScore;
    details.push(`📊 RVOL: ${rvolScore}/40 (${rvol.toFixed(2)}x)`);

    // ===== الانفجار السعري =====
    const explosion = detectPriceExplosion(data, rvol);
    if (explosion.isExplosion) {
        score += explosion.score;
        details.push(`🔥 انفجارة سعرية: ${explosion.level} (${explosion.details})`);
    }

    // ===== Momentum =====
    const momentumScore = Math.min(Math.abs(data.change) * 2, 20);
    score += momentumScore;
    details.push(`🚀 التسارع: ${momentumScore.toFixed(0)}/20 (${data.change.toFixed(2)}%)`);

    // ===== Breakout =====
    const range = data.high - data.low;
    const position = (data.lastPrice - data.low) / (range || 1);
    let breakoutScore = 0;
    if (position > 0.95) breakoutScore = 20;
    else if (position > 0.90) breakoutScore = 15;
    else if (position > 0.85) breakoutScore = 10;
    score += breakoutScore;
    details.push(`📈 الاختراق: ${breakoutScore}/20`);

    // ===== Order Flow =====
    const orderFlowScore = rvol > 1 ? Math.min((rvol - 1) * 10, 20) : 0;
    score += orderFlowScore;
    details.push(`💧 تدفق الأوامر: ${orderFlowScore.toFixed(0)}/20`);

    // ===== News =====
    const newsScore = news.reduce((a,n)=>a+scoreNews(n.title),0);
    const cappedNews = Math.min(newsScore, 20);
    score += cappedNews;
    details.push(`📰 الأخبار: ${cappedNews}/20 (${news.length} خبر)`);

    // ===== Volatility =====
    const volatility = ((data.high - data.low) / data.low) * 100;
    const volScore = Math.min(volatility, 15);
    score += volScore;
    details.push(`📊 التقلب: ${volScore.toFixed(0)}/15`);

    // ===== القيمة السوقية =====
    let valueScore = 0;
    if (marketCap && marketCap.marketCapBillion) {
        const mcapB = marketCap.marketCapBillion;
        if (mcapB > 100) valueScore = 5;
        else if (mcapB > 10) valueScore = 3;
        else if (mcapB > 2) valueScore = 1;
        score += valueScore;
        details.push(`💰 القيمة السوقية: $${mcapB.toFixed(1)}B`);
    } else {
        details.push(`💰 القيمة السوقية: غير متاح`);
    }

    // ===== Earnings =====
    let earningsScore = 0;
    if (earnings && earnings.multiplier > 1) {
        earningsScore = Math.min(earnings.multiplier * 5, 15);
        score += earningsScore;
        details.push(`📈 مكرر الربحي: ${earningsScore}/15 (${earnings.growthRate.toFixed(1)}% نمو)`);
    } else {
        details.push(`📈 مكرر الربحي: غير متاح`);
    }

    // ===== Social =====
    const socialScore = Math.min(Math.random() * 10, 10);
    score += socialScore;
    details.push(`📱 النشاط الاجتماعي: ${socialScore.toFixed(0)}/10`);

    // ===== Relative Strength =====
    const rsScore = Math.min(Math.max((data.change / 2) * 5, 0), 10);
    score += rsScore;
    details.push(`📊 القوة النسبية: ${rsScore.toFixed(0)}/10`);

    // ===== Sector =====
    const sectorScore = Math.min(Math.random() * 5, 5);
    score += sectorScore;
    details.push(`🏢 القطاع: ${sectorScore.toFixed(0)}/5`);

    // ===== Category =====
    let category, confidence;
    if (score >= 100) { category = '💥 EXPLOSIVE'; confidence = 10; }
    else if (score >= 80) { category = '🔥 HIGH CONVICTION'; confidence = 9; }
    else if (score >= 60) { category = '✅ OPPORTUNITY'; confidence = 7; }
    else if (score >= 40) { category = '📌 WATCHLIST'; confidence = 5; }
    else { category = '⏳ IGNORE'; confidence = 3; }

    // ===== Risk Management =====
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
        earnings: earnings,
        marketCap: marketCap,
        explosion: explosion,
        isExplosive: explosion.isExplosion
    };
}

// ===== SCANNER =====
async function scanMarket() {
    const results = [];

    if (allStocksList.length === 0) {
        await updateStockList();
    }

    const shuffled = allStocksList.sort(() => 0.5 - Math.random());
    const symbolsToScan = shuffled.slice(0, CONFIG.maxStocksToScan);

    console.log(`🔍 فحص ${symbolsToScan.length} سهماً من ${allStocksList.length}...`);

    const batchSize = 10;
    for (let i = 0; i < symbolsToScan.length; i += batchSize) {
        const batch = symbolsToScan.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (symbol) => {
            try {
                const data = await getMarketData(symbol);
                if (!data || !data.lastPrice || data.lastPrice <= 0 || data.volume < 100000) return null;

                const news = await getNews(symbol);
                const earnings = await getEarningsMultiplier(symbol);
                const marketCap = await getMarketCap(symbol);
                const scored = calculateAdvancedScore(data, news, symbol, earnings, marketCap);

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
        changeWarning = '🚀 (حركة انفجارية)';
    }

    let rrWarning = '';
    if (parseFloat(opp.riskReward) < 2) {
        rrWarning = '⚠️ (أقل من المطلوب 1:2)';
    }

    let earningsText = '';
    if (opp.earnings) {
        if (opp.earnings.estimated) {
            earningsText = `📈 النمو الربحي: ~${opp.earnings.growthRate.toFixed(1)}% (تقديري) | مكرر الربحية: ~${opp.earnings.peRatio.toFixed(2)}`;
        } else {
            earningsText = `📈 النمو الربحي: ${opp.earnings.growthRate.toFixed(1)}% | مكرر الربحية: ${opp.earnings.peRatio.toFixed(2)}`;
        }
    } else {
        earningsText = '📈 النمو الربحي: غير متاح';
    }

    // القيمة السوقية
    let valueText = '';
    if (opp.marketCap) {
        const mcapB = opp.marketCap.marketCapBillion;
        valueText = `💰 القيمة السوقية: $${mcapB.toFixed(1)}B`;
        if (mcapB > 100) valueText += ' (عملاقة)';
        else if (mcapB > 10) valueText += ' (كبيرة)';
        else if (mcapB > 2) valueText += ' (متوسطة)';
        else valueText += ' (صغيرة)';
    } else {
        valueText = '💰 القيمة السوقية: غير متاح';
    }

    // الانفجار السعري
    let explosionText = '';
    if (opp.isExplosive) {
        explosionText = `🔥 *انفجارة سعرية:* ✅ (${opp.explosion.details})`;
    } else {
        explosionText = `🔥 *انفجارة سعرية:* ❌`;
    }

    let message =
        `*${index}. 📈 ${safeSymbol}* ${categoryEmoji}${opp.isExplosive ? '🔥' : ''} (${categoryText})\n` +
        `📌 *رمز الشركة:* ${safeSymbol}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 الفئة: ${categoryText}\n` +
        `🏆 التقييم: ${opp.score}/100\n` +
        `🎯 الثقة: ${opp.confidence}/10\n` +
        `${explosionText}\n` +
        `${valueText}\n` +
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
        const marketCap = await getMarketCap(symbol);
        const analysis = calculateAdvancedScore(data, news, symbol, earnings, marketCap);
        
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
        if (analysis.marketCap) {
            message += `💰 القيمة السوقية: $${analysis.marketCap.marketCapBillion.toFixed(1)}B\n`;
        }
        if (analysis.isExplosive) {
            message += `🔥 انفجارة سعرية: ✅ (${analysis.explosion.details})\n`;
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

    // تصفية الفرص المؤكدة فقط (3 دورات متتالية)
    const confirmedOpportunities = [];
    for (const opp of opportunities) {
        const isConfirmed = await confirmOpportunity(opp.symbol, opp.score);
        if (isConfirmed) {
            confirmedOpportunities.push(opp);
        }
    }

    if (confirmedOpportunities.length === 0) {
        console.log('⏳ لا توجد فرص مؤكدة بعد (تحتاج 3 دورات متتالية)');
        return;
    }

    const topOpportunities = confirmedOpportunities.slice(0, CONFIG.alertThreshold);
    const currentSymbols = topOpportunities.map(o => o.symbol).join(',');
    const lastSymbols = lastSentOpportunities.map(o => o.symbol).join(',');

    if (currentSymbols === lastSymbols && !isFirstRun) {
        console.log('⏳ لا توجد فرص جديدة مؤكدة');
        return;
    }

    isFirstRun = false;
    lastSentOpportunities = topOpportunities;

    // توقيت محلي
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    const message = `🔔 *تنبيه تلقائي: ${topOpportunities.length} فرص جديدة مؤكدة!*\n` +
                    `🕒 ${formattedTime}\n` +
                    `✅ تم تأكيد الفرص بعد 3 دورات متتالية\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    try {
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        await sendOpportunities(userId, topOpportunities);
        console.log(`✅ تم إرسال التنبيه التلقائي (${formattedTime})`);
    } catch (error) {
        console.error('❌ فشل إرسال التنبيه:', error.message);
    }
}

// ===== BOT COMMANDS =====
bot.onText(/\/start|\/بدء/, (msg) => {
    const statusStocks = CONFIG.stocksOnly ? '🟢 مفعل' : '🔴 متوقف';
    const autoStatus = CONFIG.autoSend ? '🟢 مفعل' : '🔴 متوقف';
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    bot.sendMessage(msg.chat.id,
        `🚀 *OPPORTUNITY HUNTER V3*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📈 *السوق الأمريكي:* ${statusStocks} (جميع الأسهم)\n` +
        `🔄 *تحديث القائمة:* كل ساعة\n` +
        `🔔 *التنبيهات:* ${autoStatus}\n` +
        `🕒 *التوقيت المحلي:* ${formattedTime}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/فرص - عرض أفضل الفرص\n` +
        `/تحليل [الرمز] - تحليل سهم\n` +
        `/اعدادات - إعدادات الأسواق\n` +
        `/اختبار - اختبار البوت\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *التنبيهات:*\n` +
        `/تفعيل_تنبيه - تشغيل التنبيهات\n` +
        `/ايقاف_تنبيه - إيقاف التنبيهات\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 يغطي: NYSE + NASDAQ + AMEX (جميع الشركات)`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/فرص/, async (msg) => {
    await bot.sendMessage(msg.chat.id, '🔍 جاري مسح السوق بالكامل...');
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
    const marketCap = await getMarketCap(symbol);
    const analysis = calculateAdvancedScore(data, news, symbol, earnings, marketCap);

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
    if (analysis.marketCap) {
        message += `💰 القيمة السوقية: $${analysis.marketCap.marketCapBillion.toFixed(1)}B\n`;
    }
    if (analysis.isExplosive) {
        message += `🔥 انفجارة سعرية: ✅ (${analysis.explosion.details})\n`;
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
        `📈 السوق الأمريكي: ${statusStocks} (جميع الأسهم)\n` +
        `🕌 نسبة التطهير: ${CONFIG.purificationThreshold}%\n` +
        `🔄 تحديث القائمة: كل ساعة\n` +
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
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    console.log(`🔄 تحديث دوري (${formattedTime})...`);
    await updateStockList();
    await scanMarket();
    console.log(`✅ تم تحديث ${allOpportunities.length} فرصة`);
}

setInterval(periodicUpdate, CONFIG.scanInterval);
setInterval(sendAutoOpportunities, CONFIG.scanInterval);
setTimeout(sendAutoOpportunities, 30000);

// ===== START =====
async function init() {
    const localTime = new Date();
    const formattedTime = localTime.toLocaleString('ar-SA', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });

    console.log('🚀 OPPORTUNITY HUNTER V3');
    console.log(`🕒 التوقيت المحلي: ${formattedTime}`);
    console.log('🔄 جاري تحميل جميع الأسهم الأمريكية...');
    await updateStockList();
    console.log(`✅ تم تحميل ${allStocksList.length} سهماً من السوق الأمريكي`);
    console.log(`🕌 نسبة التطهير المسموحة: ${CONFIG.purificationThreshold}%`);
    console.log(`🔄 تحديث القائمة كل ${CONFIG.updateInterval / 60000} دقيقة`);
    console.log(`🔄 فحص السوق كل ${CONFIG.scanInterval / 1000} ثانية`);
    console.log('✅ تأكيد الفرص بعد 3 دورات متتالية (6 دقائق)');
    await periodicUpdate();
    console.log('✅ البوت يعمل!');
    
    try {
        await bot.sendMessage(userId, `🔔 *تم تفعيل البوت النهائي!*\n✅ جميع أسهم السوق الأمريكي\n🔄 تأكيد الفرص بعد 3 دورات\n📈 القيمة السوقية + مكرر الربحي\n🔥 كشف الانفجارات السعرية\n❌ تم إلغاء العملات المشفرة`, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('❌ فشل إرسال رسالة التأكيد:', error.message);
    }
}

init();
