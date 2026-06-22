const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dotenv = require('dotenv');
dotenv.config();

const token = process.env.TELEGRAM_TOKEN || '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const userId = process.env.USER_ID || '709023711';

if (!process.env.TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_TOKEN غير موجود في ملف .env');
}

const bot = new TelegramBot(token, { polling: true });

const rateLimit = {
    requests: {},
    window: 60000,
    maxRequests: 30
};

function checkRateLimit(chatId) {
    const now = Date.now();
    if (!rateLimit.requests[chatId]) {
        rateLimit.requests[chatId] = [];
    }
    rateLimit.requests[chatId] = rateLimit.requests[chatId].filter(t => now - t < rateLimit.window);
    if (rateLimit.requests[chatId].length >= rateLimit.maxRequests) {
        return false;
    }
    rateLimit.requests[chatId].push(now);
    return true;
}

const db = new sqlite3.Database(path.join(__dirname, 'trading_bot.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        entryPrice REAL,
        exitPrice REAL,
        profit REAL,
        isProfit INTEGER,
        purification REAL,
        date TEXT,
        status TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        date TEXT,
        entryPrice REAL,
        target1 REAL,
        target2 REAL,
        target3 REAL,
        stopLoss REAL,
        score INTEGER,
        rating TEXT,
        status TEXT,
        actualExit REAL,
        actualProfit REAL,
        updatedAt TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        entry REAL,
        targets TEXT,
        stopLoss REAL,
        timeframe TEXT,
        createdAt INTEGER,
        expiryTime INTEGER,
        status TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        level TEXT,
        message TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT,
        duration INTEGER,
        timestamp TEXT
    )`);
});

function logError(message) {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
    fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] ${message}\n`);
    db.run('INSERT INTO logs (timestamp, level, message) VALUES (?, ?, ?)', [new Date().toISOString(), 'ERROR', message]);
}

function logPerformance(operation, duration) {
    db.run('INSERT INTO performance (operation, duration, timestamp) VALUES (?, ?, ?)', [operation, duration, new Date().toISOString()]);
}

function getCached(key) {
    const cacheFile = path.join(__dirname, 'cache.json');
    try {
        if (fs.existsSync(cacheFile)) {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            const now = Date.now();
            if (cache.data && cache.data[key] && (now - cache.lastUpdate[key] < 300000)) {
                return cache.data[key];
            }
        }
    } catch (error) { /* ignore */ }
    return null;
}

function setCached(key, value) {
    const cacheFile = path.join(__dirname, 'cache.json');
    try {
        let cache = { data: {}, lastUpdate: {} };
        if (fs.existsSync(cacheFile)) {
            cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        }
        cache.data[key] = value;
        cache.lastUpdate[key] = Date.now();
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    } catch (error) { /* ignore */ }
}

function formatChange(value) {
    if (value === null || value === undefined) return '⚪ غير متاح';
    if (value > 1) return `🟢 +${value.toFixed(2)}%`;
    if (value > 0) return `🟠 +${value.toFixed(2)}%`;
    return `🔴 ${value.toFixed(2)}%`;
}

function formatRSI(value) {
    if (value === null || value === undefined) return '⚪ غير متاح';
    if (value >= 55 && value <= 70) return `🟢 ${value.toFixed(1)}`;
    if (value >= 30 && value < 55) return `🟠 ${value.toFixed(1)}`;
    return `🔴 ${value.toFixed(1)}`;
}

function formatVolume(value) {
    if (value === null || value === undefined) return '⚪ غير متاح';
    if (value > 2) return `🟢 ${value.toFixed(2)}x`;
    if (value > 1) return `🟠 ${value.toFixed(2)}x`;
    return `🔴 ${value.toFixed(2)}x`;
}

function formatScore(value) {
    if (value >= 80) return `🟢 ${value}/100 (ممتاز)`;
    if (value >= 65) return `🟢 ${value}/100 (قوي)`;
    if (value >= 50) return `🟠 ${value}/100 (متوسط)`;
    return `🔴 ${value}/100 (ضعيف)`;
}

function formatConfidence(value) {
    if (value >= 80) return `🟢 ${value}%`;
    if (value >= 60) return `🟠 ${value}%`;
    return `🔴 ${value}%`;
}

function calculateWilderRSI(closes, period = 14) {
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

function calculateMACD(closes) {
    if (closes.length < 26) return null;
    
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = calculateEMA(macdLine, 9);
    const histogram = macdLine.map((v, i) => v - signalLine[i]);
    
    return {
        macdLine: macdLine[macdLine.length - 1],
        signalLine: signalLine[signalLine.length - 1],
        histogram: histogram[histogram.length - 1],
        positive: macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1]
    };
}

async function getRealPremarket(symbol) {
    const cached = getCached(`premarket_${symbol}`);
    if (cached !== null && cached !== undefined) return cached;

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`,
            { timeout: 5000 }
        );
        const data = response.data.chart.result[0];
        if (!data || !data.meta) return null;
        
        const quote = data.indicators.quote[0];
        const premarketData = quote.close.filter(c => c !== null);
        if (premarketData.length === 0) return null;
        
        const previousClose = data.meta.previousClose;
        const currentPrice = data.meta.regularMarketPrice;
        
        if (currentPrice && previousClose) {
            const result = ((currentPrice - previousClose) / previousClose * 100);
            setCached(`premarket_${symbol}`, result);
            return result;
        }
        return null;
    } catch (error) {
        setCached(`premarket_${symbol}`, null);
        return null;
    }
}

function findPivotPoints(highs, lows, closes, lookback = 5) {
    const pivots = { highs: [], lows: [] };
    
    for (let i = lookback; i < highs.length - lookback; i++) {
        let isHigh = true, isLow = true;
        for (let j = 1; j <= lookback; j++) {
            if (highs[i] <= highs[i-j] || highs[i] <= highs[i+j]) isHigh = false;
            if (lows[i] >= lows[i-j] || lows[i] >= lows[i+j]) isLow = false;
        }
        if (isHigh) pivots.highs.push({ price: highs[i], index: i, strength: 1 });
        if (isLow) pivots.lows.push({ price: lows[i], index: i, strength: 1 });
    }
    
    const mergedHighs = [];
    const mergedLows = [];
    const threshold = 0.02;
    
    for (const h of pivots.highs) {
        let found = false;
        for (const mh of mergedHighs) {
            if (Math.abs(h.price - mh.price) / mh.price < threshold) {
                mh.strength += 1;
                found = true;
                break;
            }
        }
        if (!found) mergedHighs.push({ ...h, strength: 1 });
    }
    
    for (const l of pivots.lows) {
        let found = false;
        for (const ml of mergedLows) {
            if (Math.abs(l.price - ml.price) / ml.price < threshold) {
                ml.strength += 1;
                found = true;
                break;
            }
        }
        if (!found) mergedLows.push({ ...l, strength: 1 });
    }
    
    return { highs: mergedHighs, lows: mergedLows };
}

async function getAdvancedSR(symbol) {
    const cached = getCached(`sr_advanced_${symbol}`);
    if (cached) return cached;

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
            { timeout: 5000 }
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const highs = quote.high.filter(h => h !== null);
        const lows = quote.low.filter(l => l !== null);
        const closes = quote.close.filter(c => c !== null);
        if (highs.length < 50) return null;

        const lastPrice = closes[closes.length - 1];
        const pivots = findPivotPoints(highs, lows, closes, 5);
        
        let nearestResistance = Infinity;
        let nearestResistanceData = null;
        for (const h of pivots.highs) {
            if (h.price > lastPrice && h.price < nearestResistance) {
                nearestResistance = h.price;
                nearestResistanceData = h;
            }
        }
        
        let nearestSupport = -Infinity;
        let nearestSupportData = null;
        for (const l of pivots.lows) {
            if (l.price < lastPrice && l.price > nearestSupport) {
                nearestSupport = l.price;
                nearestSupportData = l;
            }
        }
        
        const result = {
            nearestResistance: nearestResistanceData?.price || null,
            nearestSupport: nearestSupportData?.price || null,
            resistanceStrength: nearestResistanceData?.strength || 0,
            supportStrength: nearestSupportData?.strength || 0,
            resistanceDistance: nearestResistanceData ? ((nearestResistanceData.price - lastPrice) / lastPrice * 100) : null,
            supportDistance: nearestSupportData ? ((lastPrice - nearestSupportData.price) / lastPrice * 100) : null,
            lastPrice
        };
        
        setCached(`sr_advanced_${symbol}`, result);
        return result;
    } catch (error) {
        logError(`SR Error ${symbol}: ${error.message}`);
        return null;
    }
}

async function getMarketAnalysis() {
    const cached = getCached('market_analysis');
    if (cached) return cached;

    try {
        const symbols = ['SPY', 'QQQ', 'IWM', 'DIA'];
        const results = await Promise.all(symbols.map(async (s) => {
            try {
                const resp = await axios.get(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1mo`,
                    { timeout: 5000 }
                );
                const data = resp.data.chart.result[0];
                if (!data) return { symbol: s, change: 0 };
                const quote = data.indicators.quote[0];
                const closes = quote.close.filter(c => c !== null);
                if (closes.length < 5) return { symbol: s, change: 0 };
                const change = ((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
                return { symbol: s, change };
            } catch (error) {
                return { symbol: s, change: 0 };
            }
        }));

        const avgChange = results.reduce((sum, r) => sum + r.change, 0) / results.length;
        const breadthScore = results.filter(r => r.change > 0).length / results.length * 100;

        let trend, score, message;
        if (avgChange > 1.5 && breadthScore > 75) {
            trend = 'صاعد قوي';
            score = 20;
            message = '🟢 سوق صاعد قوي مع زخم واسع';
        } else if (avgChange > 0.5 && breadthScore > 50) {
            trend = 'صاعد';
            score = 15;
            message = '🟢 سوق صاعد';
        } else if (avgChange > -0.5 && breadthScore > 40) {
            trend = 'محايد';
            score = 10;
            message = '🟠 سوق محايد';
        } else if (avgChange > -1.5) {
            trend = 'هابط';
            score = 5;
            message = '🔴 سوق هابط - توخ الحذر';
        } else {
            trend = 'هابط قوي';
            score = 0;
            message = '🔴 سوق هابط قوي - تجنب الشراء';
        }

        const result = { trend, score, message, avgChange, breadthScore, details: results };
        setCached('market_analysis', result);
        return result;
    } catch (error) {
        logError(`Market Analysis Error: ${error.message}`);
        return { trend: 'محايد', score: 5, message: '⚪ بيانات غير متاحة', avgChange: 0, breadthScore: 0 };
    }
}

async function getSectorStrengthDynamic() {
    const cached = getCached('sector_strength');
    if (cached) return cached;

    const sectors = {
        'AI': ['NVDA', 'AMD', 'INTC', 'SMCI', 'AVGO'],
        'Semiconductors': ['NVDA', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AVGO'],
        'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'CRM', 'ADBE', 'ORCL', 'IBM'],
        'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
        'Healthcare': ['JNJ', 'UNH', 'MRK', 'PFE', 'ABBV'],
        'Consumer': ['AMZN', 'TSLA', 'NFLX', 'PYPL']
    };

    const results = {};
    
    for (const [sector, stocks] of Object.entries(sectors)) {
        let totalChange = 0;
        let count = 0;
        for (const symbol of stocks) {
            try {
                const resp = await axios.get(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
                    { timeout: 3000 }
                );
                const data = resp.data.chart.result[0];
                if (data) {
                    const quote = data.indicators.quote[0];
                    const closes = quote.close.filter(c => c !== null);
                    if (closes.length >= 2) {
                        const change = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
                        totalChange += change;
                        count++;
                    }
                }
            } catch (error) { /* ignore */ }
        }
        results[sector] = count > 0 ? totalChange / count : 0;
    }

    setCached('sector_strength', results);
    return results;
}

function getSector(symbol) {
    const sectors = {
        'AI': ['NVDA', 'AMD', 'INTC', 'SMCI', 'AVGO'],
        'Semiconductors': ['NVDA', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AVGO'],
        'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'CRM', 'ADBE', 'ORCL', 'IBM'],
        'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
        'Healthcare': ['JNJ', 'UNH', 'MRK', 'PFE', 'ABBV'],
        'Consumer': ['AMZN', 'TSLA', 'NFLX', 'PYPL']
    };
    for (const [sector, stocks] of Object.entries(sectors)) {
        if (stocks.includes(symbol)) return sector;
    }
    return 'Other';
}

async function getAdvancedNewsSentiment(symbol) {
    const cached = getCached(`news_sentiment_${symbol}`);
    if (cached) return cached;

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=15`,
            { timeout: 5000 }
        );
        const articles = response.data.news || [];
        
        if (articles.length === 0) {
            const result = { overall: '⚪ غير متاح', score: 0, confidence: 0, news: [], label: 'محايد' };
            setCached(`news_sentiment_${symbol}`, result);
            return result;
        }

        const now = Date.now();
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        
        const positiveWords = ['surge', 'rally', 'beat', 'upgrade', 'buy', 'positive', 'growth', 'profit', 'record', 'strong', 'bullish', 'outperform', 'gain', 'rise', 'breakthrough', 'excellent', 'outstanding'];
        const negativeWords = ['drop', 'crash', 'downgrade', 'sell', 'negative', 'loss', 'decline', 'weak', 'miss', 'concern', 'bearish', 'underperform', 'fall', 'plunge', 'risk', 'disaster', 'catastrophic'];

        let totalScore = 0;
        let totalWeight = 0;
        const analyzedNews = [];

        for (const article of articles) {
            const pubTime = article.providerPublishTime * 1000;
            if (pubTime < sevenDaysAgo) continue;
            
            const title = (article.title || '').toLowerCase();
            let score = 0;
            positiveWords.forEach(w => { if (title.includes(w)) score += 1; });
            negativeWords.forEach(w => { if (title.includes(w)) score -= 1; });
            
            const ageHours = (now - pubTime) / (1000 * 60 * 60);
            const freshnessWeight = Math.max(0.5, 1 - (ageHours / 168));
            
            totalScore += score * freshnessWeight;
            totalWeight += freshnessWeight;
            
            let label = 'محايد';
            if (score >= 2) label = 'إيجابي جداً';
            else if (score >= 1) label = 'إيجابي';
            else if (score <= -2) label = 'سلبي جداً';
            else if (score <= -1) label = 'سلبي';
            
            analyzedNews.push({
                title: article.title,
                score,
                label,
                freshness: freshnessWeight,
                pubDate: new Date(pubTime).toISOString()
            });
        }

        const weightedScore = totalWeight > 0 ? totalScore / totalWeight : 0;
        const confidence = Math.min(Math.abs(weightedScore) * 15, 100);

        let overall, overallLabel;
        if (weightedScore >= 2) { overall = '🟢 إيجابي جداً'; overallLabel = 'إيجابي جداً'; }
        else if (weightedScore >= 0.8) { overall = '🟢 إيجابي'; overallLabel = 'إيجابي'; }
        else if (weightedScore > -0.8) { overall = '⚪ محايد'; overallLabel = 'محايد'; }
        else if (weightedScore > -2) { overall = '🔴 سلبي'; overallLabel = 'سلبي'; }
        else { overall = '🔴 سلبي جداً'; overallLabel = 'سلبي جداً'; }

        const result = {
            overall,
            label: overallLabel,
            score: Math.min(Math.max(weightedScore * 15, -100), 100),
            confidence: Math.round(confidence),
            news: analyzedNews.slice(0, 5)
        };

        setCached(`news_sentiment_${symbol}`, result);
        return result;
    } catch (error) {
        logError(`News Error ${symbol}: ${error.message}`);
        const result = { overall: '⚪ غير متاح', score: 0, confidence: 0, news: [], label: 'غير متاح' };
        setCached(`news_sentiment_${symbol}`, result);
        return result;
    }
}

async function getATR(symbol) {
    const cached = getCached(`atr_${symbol}`);
    if (cached) return cached;

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`,
            { timeout: 5000 }
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const highs = quote.high.filter(h => h !== null);
        const lows = quote.low.filter(l => l !== null);
        const closes = quote.close.filter(c => c !== null);
        if (highs.length < 16 || lows.length < 16 || closes.length < 16) return null;

        const trueRanges = [];
        for (let i = 1; i < closes.length; i++) {
            const high = highs[i] || highs[i-1];
            const low = lows[i] || lows[i-1];
            const prevClose = closes[i-1];
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);
        }
        const atr = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length);
        const atrPct = (atr / closes[closes.length - 1]) * 100;
        const result = { atr, atrPct };
        setCached(`atr_${symbol}`, result);
        return result;
    } catch (error) {
        logError(`ATR Error ${symbol}: ${error.message}`);
        return null;
    }
}

async function getIndicators(symbol) {
    const cached = getCached(`indicators_${symbol}`);
    if (cached) return cached;

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
            { timeout: 5000 }
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const closes = quote.close.filter(c => c !== null);
        if (closes.length < 60) return null;

        const rsi = calculateWilderRSI(closes, 14);
        const macd = calculateMACD(closes);
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;

        const volumes = quote.volume.filter(v => v !== null && v > 0);
        const avgVolume = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(volumes.slice(-30).length, 30);
        const currentVolume = volumes[volumes.length - 1] || 0;
        const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;

        const lastPrice = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2] || lastPrice;
        const change = ((lastPrice - prevClose) / prevClose * 100);

        const result = {
            ma20, ma50, rsi, lastPrice, volumeRatio, currentVolume, avgVolume,
            change, macd,
            priceAboveMA20: lastPrice > ma20,
            priceAboveMA50: lastPrice > ma50,
            ma20AboveMA50: ma20 > ma50
        };

        setCached(`indicators_${symbol}`, result);
        return result;
    } catch (error) {
        logError(`Indicators Error ${symbol}: ${error.message}`);
        return null;
    }
}

async function getFullAnalysis(symbol) {
    const startTime = Date.now();
    
    const [indicators, market, sr, atrData, sentiment, premarket, sectorStrength] = await Promise.all([
        getIndicators(symbol),
        getMarketAnalysis(),
        getAdvancedSR(symbol),
        getATR(symbol),
        getAdvancedNewsSentiment(symbol),
        getRealPremarket(symbol),
        getSectorStrengthDynamic()
    ]);

    if (!indicators) {
        logPerformance(`analysis_${symbol}`, Date.now() - startTime);
        return null;
    }

    if (indicators.avgVolume < 1000000 || indicators.lastPrice < 5) {
        logPerformance(`analysis_${symbol}_filtered`, Date.now() - startTime);
        return null;
    }

    let score = 0;
    const details = [];
    let confidenceScore = 0;

    const marketScore = market?.score || 5;
    score += marketScore;
    details.push({ name: 'اتجاه السوق', score: marketScore, max: 15 });

    const sector = getSector(symbol);
    const sectorScore = Math.min(Math.max((sectorStrength[sector] || 0) * 2 + 5, 0), 10);
    score += sectorScore;
    details.push({ name: `القطاع (${sector})`, score: Math.round(sectorScore), max: 10 });

    const newsScore = Math.min(Math.max(sentiment.score / 12 + 5, 0), 10);
    const newsScoreFinal = sentiment.label !== 'غير متاح' ? Math.round(newsScore) : 0;
    score += newsScoreFinal;
    details.push({ name: 'الأخبار', score: newsScoreFinal, max: 10 });

    let rsiScore = 0;
    if (indicators.rsi > 55 && indicators.rsi < 70) rsiScore = 10;
    else if (indicators.rsi > 45 && indicators.rsi < 55) rsiScore = 5;
    score += rsiScore;
    details.push({ name: 'RSI', score: rsiScore, max: 10 });

    let trendScore = 0;
    if (indicators.priceAboveMA20) trendScore += 4;
    if (indicators.priceAboveMA50) trendScore += 3;
    if (indicators.ma20AboveMA50) trendScore += 3;
    score += trendScore;
    details.push({ name: 'الاتجاه (MA)', score: trendScore, max: 10 });

    let macdScore = 0;
    if (indicators.macd) {
        if (indicators.macd.positive) macdScore += 10;
        else if (indicators.macd.histogram > 0) macdScore += 5;
    }
    score += macdScore;
    details.push({ name: 'MACD', score: macdScore, max: 10 });

    const rvolScore = indicators.volumeRatio > 2.5 ? 10 : indicators.volumeRatio > 1.8 ? 7 : indicators.volumeRatio > 1.2 ? 4 : 0;
    score += rvolScore;
    details.push({ name: 'RVOL', score: rvolScore, max: 10 });

    const premarketScore = premarket !== null && premarket > 3 ? 5 : premarket !== null && premarket > 1 ? 3 : 0;
    score += premarketScore;
    details.push({ name: 'Premarket', score: premarketScore, max: 5 });

    let srScore = 0;
    if (sr) {
        if (sr.resistanceDistance !== null && sr.resistanceDistance > 5) srScore += 5;
        if (sr.supportDistance !== null && sr.supportDistance < 3) srScore += 5;
        if (sr.resistanceStrength > 2) srScore += 2;
        if (sr.supportStrength > 2) srScore += 2;
        srScore = Math.min(srScore, 10);
    }
    score += srScore;
    details.push({ name: 'دعم/مقاومة', score: srScore, max: 10 });

    let liqScore = 0;
    if (indicators.currentVolume > indicators.avgVolume * 2) liqScore += 5;
    if (indicators.currentVolume > 2000000) liqScore += 5;
    score += liqScore;
    details.push({ name: 'سيولة إضافية', score: liqScore, max: 10 });

    confidenceScore = Math.min(Math.round((score / 100) * 100), 100);

    let entry = indicators.lastPrice;
    let target1, target2, target3, stopLoss;
    const timeframeMultipliers = {
        '5د': 0.3, '15د': 0.6, '30د': 1, 'ساعة': 1.5, '4س': 2.5
    };
    const multiplier = timeframeMultipliers[selectedTimeframe] || 1;

    if (atrData && atrData.atrPct > 0) {
        const atrPct = atrData.atrPct / 100;
        const movePct = atrPct * multiplier;
        target1 = entry * (1 + movePct * 0.6);
        target2 = entry * (1 + movePct * 1.2);
        target3 = entry * (1 + movePct * 2);
        stopLoss = entry * (1 - movePct * 0.5);
    } else {
        const baseMove = 0.02 * multiplier;
        target1 = entry * (1 + baseMove * 0.6);
        target2 = entry * (1 + baseMove * 1.2);
        target3 = entry * (1 + baseMove * 2);
        stopLoss = entry * (1 - baseMove * 0.5);
    }

    const risk = ((entry - stopLoss) / entry * 100);
    const reward = ((target2 - entry) / entry * 100);
    const riskReward = risk > 0 ? (reward / risk) : 0;

    if (riskReward < 1.5) {
        logPerformance(`analysis_${symbol}_lowRR`, Date.now() - startTime);
        return null;
    }

    let rating, ratingLabel;
    if (score >= 80) { rating = 'ممتاز'; ratingLabel = '🟢 ممتاز'; }
    else if (score >= 65) { rating = 'قوي'; ratingLabel = '🟢 قوي'; }
    else if (score >= 50) { rating = 'متوسط'; ratingLabel = '🟠 متوسط'; }
    else { rating = 'ضعيف'; ratingLabel = '🔴 ضعيف'; }

    const successRate = Math.min(Math.max(score * 0.65 + 15, 10), 92);

    logPerformance(`analysis_${symbol}`, Date.now() - startTime);

    return {
        symbol,
        score,
        rating,
        ratingLabel,
        confidenceScore,
        successRate: Math.round(successRate),
        details,
        market,
        sentiment,
        sr,
        atr: atrData,
        entry,
        target1,
        target2,
        target3,
        stopLoss,
        indicators,
        premarket,
        sector: sector || 'Other',
        riskReward,
        risk: risk.toFixed(2),
        reward: reward.toFixed(2)
    };
}

async function getTopOpportunities(limit = 5) {
    const startTime = Date.now();
    const results = [];
    const batchSize = 5;
    const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX', 'PYPL', 'ADBE', 'CRM', 'ORCL', 'IBM', 'AVGO', 'TXN', 'QCOM', 'MU', 'SMCI'];
    
    for (let i = 0; i < watchlist.length; i += batchSize) {
        const batch = watchlist.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (symbol) => {
            try {
                const analysis
