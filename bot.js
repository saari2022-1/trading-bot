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
}async function getATR(symbol) {
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
                const analysis = await getFullAnalysis(symbol);
                if (analysis && analysis.score >= 65) {
                    return analysis;
                }
                return null;
            } catch (error) {
                logError(`Batch Error ${symbol}: ${error.message}`);
                return null;
            }
        }));
        results.push(...batchResults.filter(r => r !== null));
    }
    
    results.sort((a, b) => b.score - a.score);
    logPerformance('top_opportunities', Date.now() - startTime);
    return results.slice(0, limit);
}

function saveSignal(analysis) {
    const id = Date.now().toString();
    db.run(
        `INSERT INTO signals (id, symbol, date, entryPrice, target1, target2, target3, stopLoss, score, rating, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            analysis.symbol,
            new Date().toISOString(),
            analysis.entry,
            analysis.target1,
            analysis.target2,
            analysis.target3,
            analysis.stopLoss,
            analysis.score,
            analysis.rating,
            'pending'
        ]
    );
}

async function updateSignalStatus(symbol, currentPrice) {
    db.all('SELECT * FROM signals WHERE symbol = ? AND status = ?', [symbol, 'pending'], (err, rows) => {
        if (err || rows.length === 0) return;
        for (const row of rows) {
            let newStatus = 'pending';
            let actualExit = null;
            let actualProfit = null;
            
            if (currentPrice <= row.stopLoss) {
                newStatus = 'stoploss';
                actualExit = currentPrice;
                actualProfit = ((currentPrice - row.entryPrice) / row.entryPrice) * 100;
            } else if (currentPrice >= row.target3) {
                newStatus = 'target3';
                actualExit = currentPrice;
                actualProfit = ((currentPrice - row.entryPrice) / row.entryPrice) * 100;
            } else if (currentPrice >= row.target2) {
                newStatus = 'target2';
            } else if (currentPrice >= row.target1) {
                newStatus = 'target1';
            }
            
            if (newStatus !== 'pending' && newStatus !== row.status) {
                db.run(
                    `UPDATE signals SET status = ?, actualExit = ?, actualProfit = ?, updatedAt = ?
                     WHERE id = ?`,
                    [newStatus, actualExit, actualProfit, new Date().toISOString(), row.id]
                );
            }
        }
    });
}

async function runBacktest(days = 180) {
    const startTime = Date.now();
    const results = [];
    const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
    
    for (const symbol of watchlist) {
        try {
            const response = await axios.get(
                `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`,
                { timeout: 5000 }
            );
            const data = response.data.chart.result[0];
            if (!data) continue;
            const quote = data.indicators.quote[0];
            const closes = quote.close.filter(c => c !== null);
            
            if (closes.length < 20) continue;
            
            let wins = 0, losses = 0;
            let totalProfit = 0;
            
            for (let i = 20; i < closes.length - 5; i++) {
                const rsi = calculateWilderRSI(closes.slice(0, i + 1), 14);
                if (rsi > 55 && rsi < 70) {
                    const entry = closes[i];
                    const target = entry * 1.04;
                    const stop = entry * 0.95;
                    
                    for (let j = i + 1; j < Math.min(i + 10, closes.length); j++) {
                        if (closes[j] >= target) {
                            wins++;
                            totalProfit += 4;
                            break;
                        } else if (closes[j] <= stop) {
                            losses++;
                            totalProfit -= 5;
                            break;
                        }
                    }
                }
            }
            
            const totalTrades = wins + losses;
            if (totalTrades > 0) {
                const winRate = (wins / totalTrades) * 100;
                const avgReturn = totalProfit / totalTrades;
                const profitFactor = losses > 0 ? (wins * 4) / (losses * 5) : wins > 0 ? 999 : 0;
                
                results.push({
                    symbol,
                    winRate: winRate.toFixed(1),
                    avgReturn: avgReturn.toFixed(2),
                    profitFactor: profitFactor.toFixed(2),
                    trades: totalTrades
                });
            }
        } catch (error) { continue; }
    }

    logPerformance('backtest', Date.now() - startTime);
    return results;
}

function calculatePurificationRatio(symbol) {
    const forbidden = ['BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'KO', 'PEP'];
    if (forbidden.includes(symbol)) {
        return { percentage: 100, isForbidden: true, reason: 'نشاط محرم' };
    }
    const rates = { 'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3, 'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2 };
    return { percentage: rates[symbol] || 0.5, isForbidden: false, reason: 'نشاط مختلط' };
}

bot.onText(/\/سوبر_فرص/, async (msg) => {
    if (!checkRateLimit(msg.chat.id)) {
        bot.sendMessage(msg.chat.id, '⏳ العديد من الطلبات، انتظر قليلاً');
        return;
    }
    
    const chatId = msg.chat.id;
    const statusMsg = await bot.sendMessage(chatId, '🔍 جاري البحث عن أفضل الفرص...');
    
    const opps = await getTopOpportunities(5);
    if (opps.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد فرص مطابقة للشروط (الحد الأدنى 65 نقطة)');
        return;
    }

    let message = `🔥 *أفضل 5 فرص (نظام التقييم 100 نقطة)*\n━━━━━━━━━━━━━━━━━━\n`;
    opps.forEach((opp, i) => {
        message +=
            `${i+1}. *${opp.symbol}* | ${opp.ratingLabel} (${opp.score}/100)\n` +
            `   📈 السعر: $${opp.indicators.lastPrice.toFixed(2)}\n` +
            `   📊 RSI: ${formatRSI(opp.indicators.rsi)}\n` +
            `   💧 RVOL: ${formatVolume(opp.indicators.volumeRatio)}\n` +
            `   📊 ATR: ${opp.atr ? opp.atr.atrPct.toFixed(2) + '%' : 'غير متاح'}\n` +
            `   🌅 Premarket: ${opp.premarket !== null ? formatChange(opp.premarket) : '⚪ غير متاح'}\n` +
            `   📰 الأخبار: ${opp.sentiment.overall} (ثقة ${opp.sentiment.confidence}%)\n` +
            `   🛡️ المقاومة: ${opp.sr?.nearestResistance ? '$' + opp.sr.nearestResistance.toFixed(2) : 'غير متاح'} | الدعم: ${opp.sr?.nearestSupport ? '$' + opp.sr.nearestSupport.toFixed(2) : 'غير متاح'}\n` +
            `   🎯 الدخول: $${opp.entry.toFixed(2)}\n` +
            `   🚀 الأهداف: $${opp.target1.toFixed(2)} | $${opp.target2.toFixed(2)} | $${opp.target3.toFixed(2)}\n` +
            `   🛑 وقف: $${opp.stopLoss.toFixed(2)}\n` +
            `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward.toFixed(2)}\n` +
            `   🎯 الثقة: ${formatConfidence(opp.confidenceScore)}\n` +
            `   📊 النجاح المتوقع: ${opp.successRate}%\n` +
            `━━━━━━━━━━━━━━━━━━\n`;
    });
    message += `💡 /تحليل [الرمز] للتفاصيل الكاملة`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    bot.deleteMessage(chatId, statusMsg.message_id);
});

bot.onText(/\/تحليل (.+)/, async (msg, match) => {
    if (!checkRateLimit(msg.chat.id)) {
        bot.sendMessage(msg.chat.id, '⏳ العديد من الطلبات، انتظر قليلاً');
        return;
    }
    
    const symbol = match[1].toUpperCase();
    const chatId = msg.chat.id;
    const statusMsg = await bot.sendMessage(chatId, `⏳ جاري تحليل ${symbol}...`);
    
    const analysis = await getFullAnalysis(symbol);
    if (!analysis) {
        bot.sendMessage(chatId, `❌ لم أتمكن من تحليل ${symbol} أو السهم لا يلبي الشروط`);
        return;
    }

    let message =
        `📊 *${symbol} - التحليل المتقدم*\n━━━━━━━━━━━━━━━━━━\n` +
        `💰 *السعر:* $${analysis.indicators.lastPrice.toFixed(2)}\n` +
        `📈 *التغير:* ${formatChange(analysis.indicators.change)}\n` +
        `📊 *RSI:* ${formatRSI(analysis.indicators.rsi)}\n` +
        `💧 *RVOL:* ${formatVolume(analysis.indicators.volumeRatio)}\n` +
        `🌅 *Premarket:* ${analysis.premarket !== null ? formatChange(analysis.premarket) : '⚪ غير متاح'}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 *تفاصيل التقييم (${analysis.score}/100):*\n`;
    analysis.details.forEach(d => { message += `• ${d.name}: ${d.score}/${d.max}\n`; });
    message +=
        `━━━━━━━━━━━━━━━━━━\n` +
        `📰 *الأخبار:* ${analysis.sentiment.overall} (ثقة ${analysis.sentiment.confidence}%)\n` +
        `📊 *ATR:* ${analysis.atr ? analysis.atr.atrPct.toFixed(2) + '%' : 'غير متاح'}\n` +
        `🏢 *القطاع:* ${analysis.sector || 'Other'}\n` +
        `📈 *اتجاه السوق:* ${analysis.market?.message || 'غير متاح'}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🛡️ *المقاومة:* ${analysis.sr?.nearestResistance ? '$' + analysis.sr.nearestResistance.toFixed(2) + ' (بعد ' + analysis.sr.resistanceDistance?.toFixed(2) + '%)' : 'غير متاح'}\n` +
        `🛡️ *الدعم:* ${analysis.sr?.nearestSupport ? '$' + analysis.sr.nearestSupport.toFixed(2) + ' (بعد ' + analysis.sr.supportDistance?.toFixed(2) + '%)' : 'غير متاح'}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎯 *الدخول:* $${analysis.entry.toFixed(2)}\n` +
        `🚀 *الهدف 1:* $${analysis.target1.toFixed(2)} (${((analysis.target1/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
        `🚀 *الهدف 2:* $${analysis.target2.toFixed(2)} (${((analysis.target2/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
        `🚀 *الهدف 3:* $${analysis.target3.toFixed(2)} (${((analysis.target3/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
        `🛑 *وقف الخسارة:* $${analysis.stopLoss.toFixed(2)} (${((analysis.stopLoss/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚖️ *المخاطرة/العائد:* 1:${analysis.riskReward.toFixed(2)}\n` +
        `🎯 *الثقة:* ${formatConfidence(analysis.confidenceScore)}\n` +
        `📊 *النجاح المتوقع:* ${analysis.successRate}%\n` +
        `🏷️ *التصنيف:* ${analysis.ratingLabel}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕌 *التطهير:* ${calculatePurificationRatio(symbol).percentage}%`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    bot.deleteMessage(chatId, statusMsg.message_id);
});bot.onText(/\/باك_تست/, async (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    
    const chatId = msg.chat.id;
    const statusMsg = await bot.sendMessage(chatId, '🔍 جاري تنفيذ Backtesting...');
    
    const results = await runBacktest(180);
    if (results.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد بيانات كافية للاختبار');
        return;
    }

    let message = `📊 *نتائج Backtesting (6 أشهر)*\n━━━━━━━━━━━━━━━━━━\n`;
    results.forEach(r => {
        message +=
            `📈 ${r.symbol}\n` +
            `   نسبة النجاح: ${r.winRate}%\n` +
            `   متوسط العائد: ${r.avgReturn}%\n` +
            `   Profit Factor: ${r.profitFactor}\n` +
            `   عدد الصفقات: ${r.trades}\n━━━━━━━━━━━━━━━━━━\n`;
    });
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    bot.deleteMessage(chatId, statusMsg.message_id);
});

bot.onText(/\/اخبار (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    const sentiment = await getAdvancedNewsSentiment(symbol);
    if (sentiment.news.length === 0) {
        bot.sendMessage(msg.chat.id, `📰 لا توجد أخبار لـ ${symbol}`);
        return;
    }
    let message = `📰 *تحليل الأخبار - ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 *المعنويات العامة:* ${sentiment.overall}\n`;
    message += `📊 *درجة المعنويات:* ${sentiment.score}/100\n`;
    message += `📊 *ثقة التحليل:* ${sentiment.confidence}%\n━━━━━━━━━━━━━━━━━━\n`;
    sentiment.news.forEach((n, i) => {
        message += `${i+1}. ${n.title}\n   ${n.score >= 1 ? '🟢' : n.score <= -1 ? '🔴' : '⚪'} ${n.label}\n\n`;
    });
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/جاب/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔍 جاري البحث عن Gaps...');
    const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
    const results = [];
    for (const symbol of watchlist) {
        try {
            const premarket = await getRealPremarket(symbol);
            const ind = await getIndicators(symbol);
            if (premarket !== null && premarket > 5 && ind && ind.avgVolume > 500000 && ind.lastPrice > 2) {
                results.push({ symbol, gap: premarket, volume: ind.avgVolume, price: ind.lastPrice });
            }
        } catch (error) { continue; }
    }
    results.sort((a, b) => b.gap - a.gap);
    if (results.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد Gaps حالياً');
        return;
    }
    let message = `🌅 *Gap Scanner - أفضل 10 فجوات*\n━━━━━━━━━━━━━━━━━━\n`;
    results.slice(0, 10).forEach((g, i) => {
        message +=
            `${i+1}. *${g.symbol}* | Gap: 🟢 ${g.gap.toFixed(2)}%\n` +
            `   💰 السعر: $${g.price.toFixed(2)}\n` +
            `   💧 الحجم: ${(g.volume/1000000).toFixed(2)}M\n` +
            `━━━━━━━━━━━━━━━━━━\n`;
    });
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/فلتر (.+)/, async (msg, match) => {
    const minVolume = parseInt(match[1]) * 1000000 || 1000000;
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, `⏳ جاري فلترة الأسهم...`);
    const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX', 'PYPL', 'ADBE', 'CRM', 'ORCL', 'IBM'];
    const results = [];
    for (const symbol of watchlist) {
        try {
            const ind = await getIndicators(symbol);
            if (ind && ind.avgVolume >= minVolume && ind.lastPrice >= 5) {
                results.push({ symbol, volume: ind.avgVolume, price: ind.lastPrice });
            }
        } catch (error) { continue; }
    }
    if (results.length === 0) {
        bot.sendMessage(chatId, `📭 لا توجد أسهم بحجم > ${minVolume.toLocaleString()} وسعر > 5$`);
        return;
    }
    let message = `📊 *الأسهم المؤهلة*\n━━━━━━━━━━━━━━━━━━\n`;
    results.slice(0, 15).forEach((f, i) => {
        message += `${i+1}. ${f.symbol}: ${(f.volume/1000000).toFixed(2)}M | $${f.price.toFixed(2)}\n`;
    });
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/فرص_اليوم/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔍 جاري البحث عن الفرص...');
    const opps = await getTopOpportunities(5);
    if (opps.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد فرص (الحد الأدنى 65 نقطة)');
        return;
    }
    let message = `🔥 *أفضل الفرص*\n━━━━━━━━━━━━━━━━━━\n`;
    opps.forEach((opp, i) => {
        message +=
            `${i+1}. *${opp.symbol}* | ${opp.ratingLabel} (${opp.score}/100)\n` +
            `   📈 السعر: $${opp.indicators.lastPrice.toFixed(2)}\n` +
            `   📊 RSI: ${formatRSI(opp.indicators.rsi)}\n` +
            `   💧 RVOL: ${formatVolume(opp.indicators.volumeRatio)}\n` +
            `   🎯 الدخول: $${opp.entry.toFixed(2)}\n` +
            `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━\n`;
    });
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تسجيل (.+?) (.+?) (.+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const entryPrice = parseFloat(match[2]);
    const exitPrice = parseFloat(match[3]);
    if (!symbol || isNaN(entryPrice) || isNaN(exitPrice)) {
        bot.sendMessage(msg.chat.id, '❌ /تسجيل [الرمز] [الدخول] [الخروج]');
        return;
    }
    const p = calculatePurificationRatio(symbol);
    const profit = ((exitPrice - entryPrice) / entryPrice * 100);
    const isProfit = profit > 0;
    db.run(
        `INSERT INTO trades (id, symbol, entryPrice, exitPrice, profit, isProfit, purification, date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Date.now().toString(), symbol, entryPrice, exitPrice, profit, isProfit ? 1 : 0, p.percentage, new Date().toISOString(), 'CLOSED']
    );
    bot.sendMessage(msg.chat.id,
        `✅ *تم تسجيل الصفقة!*\n━━━━━━━━━━━━━━━━━━\n` +
        `📊 ${symbol}\n💰 الدخول: $${entryPrice}\n💰 الخروج: $${exitPrice}\n` +
        `📈 الربح: ${profit.toFixed(2)}%\n🕌 التطهير: ${p.percentage}%`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تطهير (.+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const p = calculatePurificationRatio(symbol);
    let message = `🕌 *نسبة التطهير لـ ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += p.isForbidden ? `❌ غير متوافق\n📌 ${p.reason}\n📊 100%` : `✅ متوافق\n📊 ${p.percentage}%`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تشغيل/, (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    botActive = true;
    bot.sendMessage(msg.chat.id, '✅ *تم تشغيل البوت*', { parse_mode: 'Markdown' });
});

bot.onText(/\/ايقاف/, (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    botActive = false;
    bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف البوت*', { parse_mode: 'Markdown' });
});

bot.onText(/\/توقيت/, (msg) => {
    if (msg.chat.id.toString() !== userId) return;
    const timeframes = {
        '5د': { minutes: 5, label: '5 دقائق' },
        '15د': { minutes: 15, label: 'ربع ساعة' },
        '30د': { minutes: 30, label: 'نصف ساعة' },
        'ساعة': { minutes: 60, label: 'ساعة' },
        '4س': { minutes: 240, label: '4 ساعات' }
    };
    let message =
        `⏰ *اختر الإطار الزمني:*\n━━━━━━━━━━━━━━━━━━\n` +
        `1️⃣ /توقيت_5د - 5 دقائق\n` +
        `2️⃣ /توقيت_15د - ربع ساعة\n` +
        `3️⃣ /توقيت_30د - نصف ساعة\n` +
        `4️⃣ /توقيت_ساعة - ساعة\n` +
        `5️⃣ /توقيت_4س - 4 ساعات\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `الحالي: ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

['5د', '15د', '30د', 'ساعة', '4س'].forEach(tf => {
    bot.onText(new RegExp(`/توقيت_${tf}`), (msg) => {
        if (msg.chat.id.toString() !== userId) return;
        selectedTimeframe = tf;
        bot.sendMessage(msg.chat.id, `✅ تم تغيير الإطار الزمني إلى: ${timeframes[tf].label}`, { parse_mode: 'Markdown' });
    });
});

bot.onText(/\/تقرير_ذاتي (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) {
        bot.sendMessage(msg.chat.id, '⛔ غير مصرح!');
        return;
    }
    let message =
        `📊 *التقارير الذاتية*\n━━━━━━━━━━━━━━━━━━\n` +
        `/تقرير_اليوم 1411 - اليوم\n` +
        `/تقرير_الاسبوع 1411 - الأسبوع\n` +
        `/تقرير_الشهر 1411 - الشهر\n` +
        `/مراجعة 1411 - مراجعة سريعة`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

['اليوم', 'الاسبوع', 'الشهر'].forEach(type => {
    bot.onText(new RegExp(`/تقرير_${type} (.+)`), (msg, match) => {
        if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
        const trades = [];
        db.all('SELECT * FROM trades', [], (err, rows) => {
            if (err || rows.length === 0) {
                bot.sendMessage(msg.chat.id, `📊 لا توجد صفقات في الفترة ${type}`);
                return;
            }
            const now = new Date();
            const days = type === 'اليوم' ? 1 : type === 'الاسبوع' ? 7 : 30;
            const cutoff = new Date(now);
            cutoff.setDate(cutoff.getDate() - days);
            const filtered = rows.filter(t => new Date(t.date) >= cutoff);
            
            if (filtered.length === 0) {
                bot.sendMessage(msg.chat.id, `📊 لا توجد صفقات في الفترة ${type}`);
                return;
            }
            
            const totalProfit = filtered.reduce((s, t) => s + t.profit, 0);
            const winCount = filtered.filter(t => t.isProfit === 1).length;
            const lossCount = filtered.filter(t => t.isProfit === 0).length;
            const winRate = (winCount / filtered.length * 100);
            const avgProfit = totalProfit / filtered.length;
            const bestTrade = Math.max(...filtered.map(t => t.profit));
            const worstTrade = Math.min(...filtered.map(t => t.profit));
            
            let message =
                `📊 *التقرير ${type}*\n━━━━━━━━━━━━━━━━━━\n` +
                `📈 عدد الصفقات: ${filtered.length}\n` +
                `✅ رابحة: ${winCount}\n❌ خاسرة: ${lossCount}\n` +
                `📊 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💰 إجمالي الربح: ${totalProfit.toFixed(2)}%\n` +
                `📊 متوسط الربح: ${avgProfit.toFixed(2)}%\n` +
                `⭐ أفضل صفقة: +${bestTrade.toFixed(2)}%\n` +
                `💀 أسوأ صفقة: ${worstTrade.toFixed(2)}%\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💡 التقييم: ${winRate > 60 ? '🌟 ممتاز' : winRate > 40 ? '⚠️ جيد' : '❌ يحتاج مراجعة'}`;
            bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
        });
    });
});

bot.onText(/\/مراجعة (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
    db.all('SELECT * FROM trades ORDER BY date DESC LIMIT 1', [], (err, lastRow) => {
        if (err || lastRow.length === 0) {
            bot.sendMessage(msg.chat.id, '📭 لا توجد صفقات');
            return;
        }
        db.all('SELECT * FROM trades', [], (err2, allRows) => {
            if (err2) return;
            const last = lastRow[0];
            const total = allRows.reduce((s, t) => s + t.profit, 0);
            const winRate = (allRows.filter(t => t.isProfit === 1).length / allRows.length * 100);
            bot.sendMessage(msg.chat.id,
                `📋 *مراجعة سريعة*\n━━━━━━━━━━━━━━━━━━\n` +
                `📊 آخر صفقة: ${last.symbol} (${last.profit.toFixed(2)}%)\n` +
                `💰 إجمالي الربح: ${total.toFixed(2)}%\n` +
                `📈 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
                `📊 عدد الصفقات: ${allRows.length}\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `💡 ${winRate > 60 ? '✅ ممتاز' : '⚠️ يحتاج تحسين'}`,
                { parse_mode: 'Markdown' }
            );
        });
    });
});

bot.onText(/\/احصائيات/, (msg) => {
    db.all('SELECT * FROM signals', [], (err, signals) => {
        if (err || signals.length === 0) {
            bot.sendMessage(msg.chat.id, '📊 لا توجد إشارات مسجلة');
            return;
        }
        const total = signals.length;
        const pending = signals.filter(s => s.status === 'pending').length;
        const completed = signals.filter(s => s.status !== 'pending').length;
        const successful = signals.filter(s => s.status === 'target1' || s.status === 'target2' || s.status === 'target3').length;
        const failed = signals.filter(s => s.status === 'stoploss').length;
        const winRate = completed > 0 ? (successful / completed * 100) : 0;
        const avgScore = signals.reduce((s, sig) => s + (sig.score || 0), 0) / total;
        const ratings = {
            'ممتاز': signals.filter(s => s.rating === 'ممتاز').length,
            'قوي': signals.filter(s => s.rating === 'قوي').length,
            'متوسط': signals.filter(s => s.rating === 'متوسط').length,
            'ضعيف': signals.filter(s => s.rating === 'ضعيف').length
        };

        let message =
            `📊 *إحصائيات الإشارات*\n━━━━━━━━━━━━━━━━━━\n` +
            `📈 إجمالي الإشارات: ${total}\n` +
            `⏳ قيد التنفيذ: ${pending}\n` +
            `✅ مكتملة: ${completed}\n` +
            `🟢 ناجحة: ${successful}\n` +
            `🔴 فاشلة: ${failed}\n` +
            `📊 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📊 متوسط التقييم: ${avgScore.toFixed(1)}/100\n` +
            `🏷️ التصنيفات:\n` +
            `• ممتاز: ${ratings['ممتاز']}\n` +
            `• قوي: ${ratings['قوي']}\n` +
            `• متوسط: ${ratings['متوسط']}\n` +
            `• ضعيف: ${ratings['ضعيف']}`;
        bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
    });
});

bot.onText(/\/شرح_المؤشرات/, (msg) => {
    const message =
        `📚 *شرح المؤشرات ونظام التقييم*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📈 *المؤشرات الفنية:*\n` +
        `• RSI Wilder: قوة السهم (55-70 = جيد)\n` +
        `• RVOL: حجم التداول (2x+ = ممتاز)\n` +
        `• ATR: متوسط المدى الحقيقي\n` +
        `• MA20/MA50: المتوسطات المتحركة\n` +
        `• MACD: الزخم مع Signal Line\n` +
        `• Premarket: حركة ما قبل الافتتاح\n\n` +
        `📊 *نظام التقييم (100 نقطة):*\n` +
        `• اتجاه السوق (SPY/QQQ/IWM/DIA): 15\n` +
        `• قوة القطاع (ديناميكي): 10\n` +
        `• تحليل الأخبار (معنويات + حداثة): 10\n` +
        `• RSI (Wilder 14): 10\n` +
        `• الاتجاه (MA20/MA50): 10\n` +
        `• MACD (EMA 12/26 + Signal 9): 10\n` +
        `• RVOL (حجم نسبي): 10\n` +
        `• Premarket (حقيقي): 5\n` +
        `• دعم/مقاومة (Pivot + قوة): 10\n` +
        `• سيولة إضافية: 10\n\n` +
        `🏷️ *التصنيفات:*\n` +
        `• 80+ : ممتاز\n` +
        `• 65-79 : قوي\n` +
        `• 50-64 : متوسط\n` +
        `• أقل من 50 : ضعيف\n\n` +
        `🔒 *شروط القبول:*\n` +
        `• حجم التداول > 1M\n` +
        `• السعر > 5$\n` +
        `• Risk/Reward > 1:1.5\n` +
        `• الحد الأدنى للفرص: 65 نقطة\n\n` +
        `📊 *نظام المتابعة:*\n` +
        `• SQLite لقاعدة البيانات\n` +
        `• Cache لمدة 5 دقائق\n` +
        `• Rate Limiting لمنع السبام\n` +
        `• Backtesting لتقييم الاستراتيجية`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/start|\/بدء/, (msg) => {
    const chatId = msg.chat.id;
    const status = botActive ? '🟢 يعمل' : '🔴 متوقف';
    const timeframes = {
        '5د': { minutes: 5, label: '5 دقائق' },
        '15د': { minutes: 15, label: 'ربع ساعة' },
        '30د': { minutes: 30, label: 'نصف ساعة' },
        'ساعة': { minutes: 60, label: 'ساعة' },
        '4س': { minutes: 240, label: '4 ساعات' }
    };
    const message =
        `🏠 *القائمة الرئيسية*\n━━━━━━━━━━━━━━━━━━\n` +
        `📊 *حالة البوت:* ${status}\n` +
        `⏰ *الإطار الزمني:* ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📋 *الأوامر:*\n` +
        `/سوبر_فرص - أفضل 5 فرص (نظام 100 نقطة)\n` +
        `/تحليل [الرمز] - تحليل متقدم\n` +
        `/اخبار [الرمز] - تحليل معنويات الأخبار\n` +
        `/جاب - قائمة الـ Gaps\n` +
        `/فلتر [القيمة] - فلترة الأسهم\n` +
        `/تسجيل [الرمز] [الدخول] [الخروج]\n` +
        `/تقرير_ذاتي 1411 - التقارير\n` +
        `/مراجعة 1411 - مراجعة سريعة\n` +
        `/تطهير [الرمز] - نسبة التطهير\n` +
        `/احصائيات - إحصائيات الإشارات\n` +
        `/باك_تست - اختبار تاريخي\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *الإعدادات:*\n` +
        `✅ /تشغيل - تشغيل البوت\n` +
        `🔄 /ايقاف - إيقاف البوت\n` +
        `⏰ /توقيت - تغيير الإطار الزمني\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📚 /شرح_المؤشرات - شرح المؤشرات\n` +
        `💡 /مساعدة - للمساعدة`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

bot.onText(/\/مساعدة/, (msg) => {
    bot.emit('text', { chat: { id: msg.chat.id }, text: '/start' });
});

setInterval(() => {
    db.all('SELECT * FROM opportunities WHERE status = ?', ['منتهية'], (err, rows) => {
        if (err || rows.length === 0) return;
        const now = Date.now();
        const expiredThreshold = 30 * 60 * 1000;
        for (const row of rows) {
            if ((now - row.expiryTime) > expiredThreshold) {
                db.run('DELETE FROM opportunities WHERE id = ?', [row.id]);
            }
        }
    });
}, 5 * 60 * 1000);

setInterval(() => {
    db.get('SELECT COUNT(*) as count FROM performance WHERE timestamp > ?', [new Date(Date.now() - 3600000).toISOString()], (err, row) => {
        if (err) return;
        if (row.count > 1000) {
            logError(`تحذير: عدد العمليات مرتفع (${row.count}) في الساعة الماضية`);
        }
    });
}, 5 * 60 * 1000);

setInterval(() => {
    const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD'];
    for (const symbol of symbols) {
        (async () => {
            try {
                const response = await axios.get(
                    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
                    { timeout: 5000 }
                );
                const data = response.data.chart.result[0];
                if (data) {
                    const quote = data.indicators.quote[0];
                    const lastPrice = quote.close[quote.close.length - 1];
                    if (lastPrice) {
                        await updateSignalStatus(symbol, lastPrice);
                    }
                }
            } catch (error) { /* ignore */ }
        })();
    }
}, 10 * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const chatId in rateLimit.requests) {
        rateLimit.requests[chatId] = rateLimit.requests[chatId].filter(t => now - t < rateLimit.window);
        if (rateLimit.requests[chatId].length === 0) {
            delete rateLimit.requests[chatId];
        }
    }
}, 60000);

process.on('SIGINT', () => {
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
});

console.log('✅ بوت التداول المتطور يعمل...');
console.log(`📊 قيد التشغيل على الإطار الزمني: ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}`);
console.log(`📈 عدد الأسهم في القائمة: 20`);
console.log(`🔄 تحديث الإشارات كل 10 دقائق`);
console.log(`🗑️ تنظيف الفرص المنتهية كل 5 دقائق`);
console.log(`📊 مراقبة الأداء كل 5 دقائق`);
console.log(`⏳ Rate Limiting: ${rateLimit.maxRequests} طلب لكل ${rateLimit.window/1000} ثانية`);

let botActive = true;
let selectedTimeframe = '30د';
const timeframes = {
    '5د': { minutes: 5, label: '5 دقائق' },
    '15د': { minutes: 15, label: 'ربع ساعة' },
    '30د': { minutes: 30, label: 'نصف ساعة' },
    'ساعة': { minutes: 60, label: 'ساعة' },
    '4س': { minutes: 240, label: '4 ساعات' }
};

console.log('✅ بوت التداول المتطور يعمل...');
