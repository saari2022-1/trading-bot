1  const TelegramBot = require('node-telegram-bot-api');
2  const axios = require('axios');
3  const fs = require('fs');
4  const path = require('path');
5  const sqlite3 = require('sqlite3').verbose();
6  
7  // ===== تحميل المتغيرات البيئية =====
8  const dotenv = require('dotenv');
9  dotenv.config();
10 
11 const token = process.env.TELEGRAM_TOKEN || '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
12 const userId = process.env.USER_ID || '709023711';
13 
14 if (!process.env.TELEGRAM_TOKEN) {
15     console.error('❌ TELEGRAM_TOKEN غير موجود في ملف .env');
16 }
17 
18 const bot = new TelegramBot(token, { polling: true });
19 
20 // ===== Rate Limiting =====
21 const rateLimit = {
22     requests: {},
23     window: 60000,
24     maxRequests: 30
25 };
26 
27 function checkRateLimit(chatId) {
28     const now = Date.now();
29     if (!rateLimit.requests[chatId]) {
30         rateLimit.requests[chatId] = [];
31     }
32     rateLimit.requests[chatId] = rateLimit.requests[chatId].filter(t => now - t < rateLimit.window);
33     if (rateLimit.requests[chatId].length >= rateLimit.maxRequests) {
34         return false;
35     }
36     rateLimit.requests[chatId].push(now);
37     return true;
38 }
39 
40 // ===== SQLite =====
41 const db = new sqlite3.Database(path.join(__dirname, 'trading_bot.db'));
42 
43 db.serialize(() => {
44     db.run(`CREATE TABLE IF NOT EXISTS trades (
45         id TEXT PRIMARY KEY,
46         symbol TEXT,
47         entryPrice REAL,
48         exitPrice REAL,
49         profit REAL,
50         isProfit INTEGER,
51         purification REAL,
52         date TEXT,
53         status TEXT
54     )`);
55 
56     db.run(`CREATE TABLE IF NOT EXISTS signals (
57         id TEXT PRIMARY KEY,
58         symbol TEXT,
59         date TEXT,
60         entryPrice REAL,
61         target1 REAL,
62         target2 REAL,
63         target3 REAL,
64         stopLoss REAL,
65         score INTEGER,
66         rating TEXT,
67         status TEXT,
68         actualExit REAL,
69         actualProfit REAL,
70         updatedAt TEXT
71     )`);
72 
73     db.run(`CREATE TABLE IF NOT EXISTS opportunities (
74         id TEXT PRIMARY KEY,
75         symbol TEXT,
76         entry REAL,
77         targets TEXT,
78         stopLoss REAL,
79         timeframe TEXT,
80         createdAt INTEGER,
81         expiryTime INTEGER,
82         status TEXT
83     )`);
84 
85     db.run(`CREATE TABLE IF NOT EXISTS logs (
86         id INTEGER PRIMARY KEY AUTOINCREMENT,
87         timestamp TEXT,
88         level TEXT,
89         message TEXT
90     )`);
91 
92     db.run(`CREATE TABLE IF NOT EXISTS performance (
93         id INTEGER PRIMARY KEY AUTOINCREMENT,
94         operation TEXT,
95         duration INTEGER,
96         timestamp TEXT
97     )`);
98 });
99 
100 // ===== دوال مساعدة =====
101 function logError(message) {
102     const logDir = path.join(__dirname, 'logs');
103     if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
104     fs.appendFileSync(path.join(logDir, 'error.log'), `[${new Date().toISOString()}] ${message}\n`);
105     db.run('INSERT INTO logs (timestamp, level, message) VALUES (?, ?, ?)', [new Date().toISOString(), 'ERROR', message]);
106 }
107 
108 function logPerformance(operation, duration) {
109     db.run('INSERT INTO performance (operation, duration, timestamp) VALUES (?, ?, ?)', [operation, duration, new Date().toISOString()]);
110 }
111 
112 function getCached(key) {
113     const cacheFile = path.join(__dirname, 'cache.json');
114     try {
115         if (fs.existsSync(cacheFile)) {
116             const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
117             const now = Date.now();
118             if (cache.data && cache.data[key] && (now - cache.lastUpdate[key] < 300000)) {
119                 return cache.data[key];
120             }
121         }
122     } catch (error) { /* ignore */ }
123     return null;
124 }
125 
126 function setCached(key, value) {
127     const cacheFile = path.join(__dirname, 'cache.json');
128     try {
129         let cache = { data: {}, lastUpdate: {} };
130         if (fs.existsSync(cacheFile)) {
131             cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
132         }
133         cache.data[key] = value;
134         cache.lastUpdate[key] = Date.now();
135         fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
136     } catch (error) { /* ignore */ }
137 }
138 
139 // ===== دوال التنسيق =====
140 function formatChange(value) {
141     if (value === null || value === undefined) return '⚪ غير متاح';
142     if (value > 1) return `🟢 +${value.toFixed(2)}%`;
143     if (value > 0) return `🟠 +${value.toFixed(2)}%`;
144     return `🔴 ${value.toFixed(2)}%`;
145 }
146 
147 function formatRSI(value) {
148     if (value === null || value === undefined) return '⚪ غير متاح';
149     if (value >= 55 && value <= 70) return `🟢 ${value.toFixed(1)}`;
150     if (value >= 30 && value < 55) return `🟠 ${value.toFixed(1)}`;
151     return `🔴 ${value.toFixed(1)}`;
152 }
153 
154 function formatVolume(value) {
155     if (value === null || value === undefined) return '⚪ غير متاح';
156     if (value > 2) return `🟢 ${value.toFixed(2)}x`;
157     if (value > 1) return `🟠 ${value.toFixed(2)}x`;
158     return `🔴 ${value.toFixed(2)}x`;
159 }
160 
161 function formatScore(value) {
162     if (value >= 80) return `🟢 ${value}/100 (ممتاز)`;
163     if (value >= 65) return `🟢 ${value}/100 (قوي)`;
164     if (value >= 50) return `🟠 ${value}/100 (متوسط)`;
165     return `🔴 ${value}/100 (ضعيف)`;
166 }
167 
168 function formatConfidence(value) {
169     if (value >= 80) return `🟢 ${value}%`;
170     if (value >= 60) return `🟠 ${value}%`;
171     return `🔴 ${value}%`;
172 }
173 
174 // ===== 1. Wilder RSI الحقيقي =====
175 function calculateWilderRSI(closes, period = 14) {
176     if (closes.length < period + 1) return null;
177     
178     let gains = 0, losses = 0;
179     for (let i = 1; i <= period; i++) {
180         const diff = closes[i] - closes[i-1];
181         if (diff > 0) gains += diff;
182         else losses -= diff;
183     }
184     
185     let avgGain = gains / period;
186     let avgLoss = losses / period;
187     
188     for (let i = period + 1; i < closes.length; i++) {
189         const diff = closes[i] - closes[i-1];
190         avgGain = ((avgGain * (period - 1)) + (diff > 0 ? diff : 0)) / period;
191         avgLoss = ((avgLoss * (period - 1)) + (diff < 0 ? -diff : 0)) / period;
192     }
193     
194     if (avgLoss === 0) return 100;
195     const rs = avgGain / avgLoss;
196     return 100 - (100 / (1 + rs));
197 }
198 
199 // ===== 2. MACD الحقيقي مع EMA =====
200 function calculateEMA(data, period) {201     const ema = [];
202     const k = 2 / (period + 1);
203     ema[0] = data[0];
204     for (let i = 1; i < data.length; i++) {
205         ema[i] = data[i] * k + ema[i-1] * (1 - k);
206     }
207     return ema;
208 }
209 
210 function calculateMACD(closes) {
211     if (closes.length < 26) return null;
212     
213     const ema12 = calculateEMA(closes, 12);
214     const ema26 = calculateEMA(closes, 26);
215     const macdLine = ema12.map((v, i) => v - ema26[i]);
216     const signalLine = calculateEMA(macdLine, 9);
217     const histogram = macdLine.map((v, i) => v - signalLine[i]);
218     
219     return {
220         macdLine: macdLine[macdLine.length - 1],
221         signalLine: signalLine[signalLine.length - 1],
222         histogram: histogram[histogram.length - 1],
223         positive: macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1]
224     };
225 }
226 
227 // ===== 3. Premarket حقيقي =====
228 async function getRealPremarket(symbol) {
229     const cached = getCached(`premarket_${symbol}`);
230     if (cached !== null && cached !== undefined) return cached;
231 
232     try {
233         const response = await axios.get(
234             `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`,
235             { timeout: 5000 }
236         );
237         const data = response.data.chart.result[0];
238         if (!data || !data.meta) return null;
239         
240         const quote = data.indicators.quote[0];
241         const premarketData = quote.close.filter(c => c !== null);
242         if (premarketData.length === 0) return null;
243         
244         const previousClose = data.meta.previousClose;
245         const currentPrice = data.meta.regularMarketPrice;
246         
247         if (currentPrice && previousClose) {
248             const result = ((currentPrice - previousClose) / previousClose * 100);
249             setCached(`premarket_${symbol}`, result);
250             return result;
251         }
252         return null;
253     } catch (error) {
254         setCached(`premarket_${symbol}`, null);
255         return null;
256     }
257 }
258 
259 // ===== 4. Pivot High/Low مع دمج المستويات =====
260 function findPivotPoints(highs, lows, closes, lookback = 5) {
261     const pivots = { highs: [], lows: [] };
262     
263     for (let i = lookback; i < highs.length - lookback; i++) {
264         let isHigh = true, isLow = true;
265         for (let j = 1; j <= lookback; j++) {
266             if (highs[i] <= highs[i-j] || highs[i] <= highs[i+j]) isHigh = false;
267             if (lows[i] >= lows[i-j] || lows[i] >= lows[i+j]) isLow = false;
268         }
269         if (isHigh) pivots.highs.push({ price: highs[i], index: i, strength: 1 });
270         if (isLow) pivots.lows.push({ price: lows[i], index: i, strength: 1 });
271     }
272     
273     const mergedHighs = [];
274     const mergedLows = [];
275     const threshold = 0.02;
276     
277     for (const h of pivots.highs) {
278         let found = false;
279         for (const mh of mergedHighs) {
280             if (Math.abs(h.price - mh.price) / mh.price < threshold) {
281                 mh.strength += 1;
282                 found = true;
283                 break;
284             }
285         }
286         if (!found) mergedHighs.push({ ...h, strength: 1 });
287     }
288     
289     for (const l of pivots.lows) {
290         let found = false;
291         for (const ml of mergedLows) {
292             if (Math.abs(l.price - ml.price) / ml.price < threshold) {
293                 ml.strength += 1;
294                 found = true;
295                 break;
296             }
297         }
298         if (!found) mergedLows.push({ ...l, strength: 1 });
299     }
300     
301     return { highs: mergedHighs, lows: mergedLows };
302 }
303 
304 // ===== 5. الدعم والمقاومة المحسن =====
305 async function getAdvancedSR(symbol) {
306     const cached = getCached(`sr_advanced_${symbol}`);
307     if (cached) return cached;
308 
309     try {
310         const response = await axios.get(
311             `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,
312             { timeout: 5000 }
313         );
314         const data = response.data.chart.result[0];
315         if (!data) return null;
316         const quote = data.indicators.quote[0];
317         const highs = quote.high.filter(h => h !== null);
318         const lows = quote.low.filter(l => l !== null);
319         const closes = quote.close.filter(c => c !== null);
320         if (highs.length < 50) return null;
321 
322         const lastPrice = closes[closes.length - 1];
323         const pivots = findPivotPoints(highs, lows, closes, 5);
324         
325         let nearestResistance = Infinity;
326         let nearestResistanceData = null;
327         for (const h of pivots.highs) {
328             if (h.price > lastPrice && h.price < nearestResistance) {
329                 nearestResistance = h.price;
330                 nearestResistanceData = h;
331             }
332         }
333         
334         let nearestSupport = -Infinity;
335         let nearestSupportData = null;
336         for (const l of pivots.lows) {
337             if (l.price < lastPrice && l.price > nearestSupport) {
338                 nearestSupport = l.price;
339                 nearestSupportData = l;
340             }
341         }
342         
343         const result = {
344             nearestResistance: nearestResistanceData?.price || null,
345             nearestSupport: nearestSupportData?.price || null,
346             resistanceStrength: nearestResistanceData?.strength || 0,
347             supportStrength: nearestSupportData?.strength || 0,
348             resistanceDistance: nearestResistanceData ? ((nearestResistanceData.price - lastPrice) / lastPrice * 100) : null,
349             supportDistance: nearestSupportData ? ((lastPrice - nearestSupportData.price) / lastPrice * 100) : null,
350             lastPrice
351         };
352         
353         setCached(`sr_advanced_${symbol}`, result);
354         return result;
355     } catch (error) {
356         logError(`SR Error ${symbol}: ${error.message}`);
357         return null;
358     }
359 }
360 
361 // ===== 6. تحليل السوق المتقدم =====
362 async function getMarketAnalysis() {
363     const cached = getCached('market_analysis');
364     if (cached) return cached;
365 
366     try {
367         const symbols = ['SPY', 'QQQ', 'IWM', 'DIA'];
368         const results = await Promise.all(symbols.map(async (s) => {
369             try {
370                 const resp = await axios.get(
371                     `https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=1mo`,
372                     { timeout: 5000 }
373                 );
374                 const data = resp.data.chart.result[0];
375                 if (!data) return { symbol: s, change: 0 };
376                 const quote = data.indicators.quote[0];
377                 const closes = quote.close.filter(c => c !== null);
378                 if (closes.length < 5) return { symbol: s, change: 0 };
379                 const change = ((closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5]) * 100;
380                 return { symbol: s, change };
381             } catch (error) {
382                 return { symbol: s, change: 0 };
383             }
384         }));
385 
386         const avgChange = results.reduce((sum, r) => sum + r.change, 0) / results.length;
387         const breadthScore = results.filter(r => r.change > 0).length / results.length * 100;
388 
389         let trend, score, message;
390         if (avgChange > 1.5 && breadthScore > 75) {
391             trend = 'صاعد قوي';
392             score = 20;
393             message = '🟢 سوق صاعد قوي مع زخم واسع';
394         } else if (avgChange > 0.5 && breadthScore > 50) {
395             trend = 'صاعد';
396             score = 15;
397             message = '🟢 سوق صاعد';
398         } else if (avgChange > -0.5 && breadthScore > 40) {
399             trend = 'محايد';
400             score = 10;401             message = '🟠 سوق محايد';
402         } else if (avgChange > -1.5) {
403             trend = 'هابط';
404             score = 5;
405             message = '🔴 سوق هابط - توخ الحذر';
406         } else {
407             trend = 'هابط قوي';
408             score = 0;
409             message = '🔴 سوق هابط قوي - تجنب الشراء';
410         }
411 
412         const result = { trend, score, message, avgChange, breadthScore, details: results };
413         setCached('market_analysis', result);
414         return result;
415     } catch (error) {
416         logError(`Market Analysis Error: ${error.message}`);
417         return { trend: 'محايد', score: 5, message: '⚪ بيانات غير متاحة', avgChange: 0, breadthScore: 0 };
418     }
419 }
420 
421 // ===== 7. قوة القطاع الديناميكية =====
422 async function getSectorStrengthDynamic() {
423     const cached = getCached('sector_strength');
424     if (cached) return cached;
425 
426     const sectors = {
427         'AI': ['NVDA', 'AMD', 'INTC', 'SMCI', 'AVGO'],
428         'Semiconductors': ['NVDA', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AVGO'],
429         'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'CRM', 'ADBE', 'ORCL', 'IBM'],
430         'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
431         'Healthcare': ['JNJ', 'UNH', 'MRK', 'PFE', 'ABBV'],
432         'Consumer': ['AMZN', 'TSLA', 'NFLX', 'PYPL']
433     };
434 
435     const results = {};
436     
437     for (const [sector, stocks] of Object.entries(sectors)) {
438         let totalChange = 0;
439         let count = 0;
440         for (const symbol of stocks) {
441             try {
442                 const resp = await axios.get(
443                     `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`,
444                     { timeout: 3000 }
445                 );
446                 const data = resp.data.chart.result[0];
447                 if (data) {
448                     const quote = data.indicators.quote[0];
449                     const closes = quote.close.filter(c => c !== null);
450                     if (closes.length >= 2) {
451                         const change = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
452                         totalChange += change;
453                         count++;
454                     }
455                 }
456             } catch (error) { /* ignore */ }
457         }
458         results[sector] = count > 0 ? totalChange / count : 0;
459     }
460 
461     setCached('sector_strength', results);
462     return results;
463 }
464 
465 function getSector(symbol) {
466     const sectors = {
467         'AI': ['NVDA', 'AMD', 'INTC', 'SMCI', 'AVGO'],
468         'Semiconductors': ['NVDA', 'AMD', 'INTC', 'QCOM', 'TXN', 'MU', 'AVGO'],
469         'Technology': ['AAPL', 'MSFT', 'GOOGL', 'META', 'CRM', 'ADBE', 'ORCL', 'IBM'],
470         'Energy': ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
471         'Healthcare': ['JNJ', 'UNH', 'MRK', 'PFE', 'ABBV'],
472         'Consumer': ['AMZN', 'TSLA', 'NFLX', 'PYPL']
473     };
474     for (const [sector, stocks] of Object.entries(sectors)) {
475         if (stocks.includes(symbol)) return sector;
476     }
477     return 'Other';
478 }
479 
480 // ===== 8. تحليل الأخبار المتقدم =====
481 async function getAdvancedNewsSentiment(symbol) {
482     const cached = getCached(`news_sentiment_${symbol}`);
483     if (cached) return cached;
484 
485     try {
486         const response = await axios.get(
487             `https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=15`,
488             { timeout: 5000 }
489         );
490         const articles = response.data.news || [];
491         
492         if (articles.length === 0) {
493             const result = { overall: '⚪ غير متاح', score: 0, confidence: 0, news: [], label: 'محايد' };
494             setCached(`news_sentiment_${symbol}`, result);
495             return result;
496         }
497 
498         const now = Date.now();
499         const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
500         
501         const positiveWords = ['surge', 'rally', 'beat', 'upgrade', 'buy', 'positive', 'growth', 'profit', 'record', 'strong', 'bullish', 'outperform', 'gain', 'rise', 'breakthrough', 'excellent', 'outstanding'];
502         const negativeWords = ['drop', 'crash', 'downgrade', 'sell', 'negative', 'loss', 'decline', 'weak', 'miss', 'concern', 'bearish', 'underperform', 'fall', 'plunge', 'risk', 'disaster', 'catastrophic'];
503 
504         let totalScore = 0;
505         let totalWeight = 0;
506         const analyzedNews = [];
507 
508         for (const article of articles) {
509             const pubTime = article.providerPublishTime * 1000;
510             if (pubTime < sevenDaysAgo) continue;
511             
512             const title = (article.title || '').toLowerCase();
513             let score = 0;
514             positiveWords.forEach(w => { if (title.includes(w)) score += 1; });
515             negativeWords.forEach(w => { if (title.includes(w)) score -= 1; });
516             
517             const ageHours = (now - pubTime) / (1000 * 60 * 60);
518             const freshnessWeight = Math.max(0.5, 1 - (ageHours / 168));
519             
520             totalScore += score * freshnessWeight;
521             totalWeight += freshnessWeight;
522             
523             let label = 'محايد';
524             if (score >= 2) label = 'إيجابي جداً';
525             else if (score >= 1) label = 'إيجابي';
526             else if (score <= -2) label = 'سلبي جداً';
527             else if (score <= -1) label = 'سلبي';
528             
529             analyzedNews.push({
530                 title: article.title,
531                 score,
532                 label,
533                 freshness: freshnessWeight,
534                 pubDate: new Date(pubTime).toISOString()
535             });
536         }
537 
538         const weightedScore = totalWeight > 0 ? totalScore / totalWeight : 0;
539         const confidence = Math.min(Math.abs(weightedScore) * 15, 100);
540 
541         let overall, overallLabel;
542         if (weightedScore >= 2) { overall = '🟢 إيجابي جداً'; overallLabel = 'إيجابي جداً'; }
543         else if (weightedScore >= 0.8) { overall = '🟢 إيجابي'; overallLabel = 'إيجابي'; }
544         else if (weightedScore > -0.8) { overall = '⚪ محايد'; overallLabel = 'محايد'; }
545         else if (weightedScore > -2) { overall = '🔴 سلبي'; overallLabel = 'سلبي'; }
546         else { overall = '🔴 سلبي جداً'; overallLabel = 'سلبي جداً'; }
547 
548         const result = {
549             overall,
550             label: overallLabel,
551             score: Math.min(Math.max(weightedScore * 15, -100), 100),
552             confidence: Math.round(confidence),
553             news: analyzedNews.slice(0, 5)
554         };
555 
556         setCached(`news_sentiment_${symbol}`, result);
557         return result;
558     } catch (error) {
559         logError(`News Error ${symbol}: ${error.message}`);
560         const result = { overall: '⚪ غير متاح', score: 0, confidence: 0, news: [], label: 'غير متاح' };
561         setCached(`news_sentiment_${symbol}`, result);
562         return result;
563     }
564 }
565 
566 // ===== 9. ATR =====
567 async function getATR(symbol) {
568     const cached = getCached(`atr_${symbol}`);
569     if (cached) return cached;
570 
571     try {
572         const response = await axios.get(
573             `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`,
574             { timeout: 5000 }
575         );
576         const data = response.data.chart.result[0];
577         if (!data) return null;
578         const quote = data.indicators.quote[0];
579         const highs = quote.high.filter(h => h !== null);
580         const lows = quote.low.filter(l => l !== null);
581         const closes = quote.close.filter(c => c !== null);
582         if (highs.length < 16 || lows.length < 16 || closes.length < 16) return null;
583 
584         const trueRanges = [];
585         for (let i = 1; i < closes.length; i++) {
586             const high = highs[i] || highs[i-1];
587             const low = lows[i] || lows[i-1];
588             const prevClose = closes[i-1];
589             const tr = Math.max(
590                 high - low,
591                 Math.abs(high - prevClose),
592                 Math.abs(low - prevClose)
593             );
594             trueRanges.push(tr);
595         }
596         const atr = trueRanges.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trueRanges.length);
597         const atrPct = (atr / closes[closes.length - 1]) * 100;
598         const result = { atr, atrPct };
599         setCached(`atr_${symbol}`, result);
600         return result;601     } catch (error) {
602         logError(`ATR Error ${symbol}: ${error.message}`);
603         return null;
604     }
605 }
606 
607 // ===== 10. المؤشرات الأساسية =====
608 async function getIndicators(symbol) {
609     const cached = getCached(`indicators_${symbol}`);
610     if (cached) return cached;
611 
612     try {
613         const response = await axios.get(
614             `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`,
615             { timeout: 5000 }
616         );
617         const data = response.data.chart.result[0];
618         if (!data) return null;
619         const quote = data.indicators.quote[0];
620         const closes = quote.close.filter(c => c !== null);
621         if (closes.length < 60) return null;
622 
623         const rsi = calculateWilderRSI(closes, 14);
624         const macd = calculateMACD(closes);
625         const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
626         const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
627 
628         const volumes = quote.volume.filter(v => v !== null && v > 0);
629         const avgVolume = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(volumes.slice(-30).length, 30);
630         const currentVolume = volumes[volumes.length - 1] || 0;
631         const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
632 
633         const lastPrice = closes[closes.length - 1];
634         const prevClose = closes[closes.length - 2] || lastPrice;
635         const change = ((lastPrice - prevClose) / prevClose * 100);
636 
637         const result = {
638             ma20, ma50, rsi, lastPrice, volumeRatio, currentVolume, avgVolume,
639             change, macd,
640             priceAboveMA20: lastPrice > ma20,
641             priceAboveMA50: lastPrice > ma50,
642             ma20AboveMA50: ma20 > ma50
643         };
644 
645         setCached(`indicators_${symbol}`, result);
646         return result;
647     } catch (error) {
648         logError(`Indicators Error ${symbol}: ${error.message}`);
649         return null;
650     }
651 }
652 
653 // ===== 11. نظام التقييم المحسن =====
654 async function getFullAnalysis(symbol) {
655     const startTime = Date.now();
656     
657     const [indicators, market, sr, atrData, sentiment, premarket, sectorStrength] = await Promise.all([
658         getIndicators(symbol),
659         getMarketAnalysis(),
660         getAdvancedSR(symbol),
661         getATR(symbol),
662         getAdvancedNewsSentiment(symbol),
663         getRealPremarket(symbol),
664         getSectorStrengthDynamic()
665     ]);
666 
667     if (!indicators) {
668         logPerformance(`analysis_${symbol}`, Date.now() - startTime);
669         return null;
670     }
671 
672     if (indicators.avgVolume < 1000000 || indicators.lastPrice < 5) {
673         logPerformance(`analysis_${symbol}_filtered`, Date.now() - startTime);
674         return null;
675     }
676 
677     let score = 0;
678     const details = [];
679     let confidenceScore = 0;
680 
681     const marketScore = market?.score || 5;
682     score += marketScore;
683     details.push({ name: 'اتجاه السوق', score: marketScore, max: 15 });
684 
685     const sector = getSector(symbol);
686     const sectorScore = Math.min(Math.max((sectorStrength[sector] || 0) * 2 + 5, 0), 10);
687     score += sectorScore;
688     details.push({ name: `القطاع (${sector})`, score: Math.round(sectorScore), max: 10 });
689 
690     const newsScore = Math.min(Math.max(sentiment.score / 12 + 5, 0), 10);
691     const newsScoreFinal = sentiment.label !== 'غير متاح' ? Math.round(newsScore) : 0;
692     score += newsScoreFinal;
693     details.push({ name: 'الأخبار', score: newsScoreFinal, max: 10 });
694 
695     let rsiScore = 0;
696     if (indicators.rsi > 55 && indicators.rsi < 70) rsiScore = 10;
697     else if (indicators.rsi > 45 && indicators.rsi < 55) rsiScore = 5;
698     score += rsiScore;
699     details.push({ name: 'RSI', score: rsiScore, max: 10 });
700 
701     let trendScore = 0;
702     if (indicators.priceAboveMA20) trendScore += 4;
703     if (indicators.priceAboveMA50) trendScore += 3;
704     if (indicators.ma20AboveMA50) trendScore += 3;
705     score += trendScore;
706     details.push({ name: 'الاتجاه (MA)', score: trendScore, max: 10 });
707 
708     let macdScore = 0;
709     if (indicators.macd) {
710         if (indicators.macd.positive) macdScore += 10;
711         else if (indicators.macd.histogram > 0) macdScore += 5;
712     }
713     score += macdScore;
714     details.push({ name: 'MACD', score: macdScore, max: 10 });
715 
716     const rvolScore = indicators.volumeRatio > 2.5 ? 10 : indicators.volumeRatio > 1.8 ? 7 : indicators.volumeRatio > 1.2 ? 4 : 0;
717     score += rvolScore;
718     details.push({ name: 'RVOL', score: rvolScore, max: 10 });
719 
720     const premarketScore = premarket !== null && premarket > 3 ? 5 : premarket !== null && premarket > 1 ? 3 : 0;
721     score += premarketScore;
722     details.push({ name: 'Premarket', score: premarketScore, max: 5 });
723 
724     let srScore = 0;
725     if (sr) {
726         if (sr.resistanceDistance !== null && sr.resistanceDistance > 5) srScore += 5;
727         if (sr.supportDistance !== null && sr.supportDistance < 3) srScore += 5;
728         if (sr.resistanceStrength > 2) srScore += 2;
729         if (sr.supportStrength > 2) srScore += 2;
730         srScore = Math.min(srScore, 10);
731     }
732     score += srScore;
733     details.push({ name: 'دعم/مقاومة', score: srScore, max: 10 });
734 
735     let liqScore = 0;
736     if (indicators.currentVolume > indicators.avgVolume * 2) liqScore += 5;
737     if (indicators.currentVolume > 2000000) liqScore += 5;
738     score += liqScore;
739     details.push({ name: 'سيولة إضافية', score: liqScore, max: 10 });
740 
741     confidenceScore = Math.min(Math.round((score / 100) * 100), 100);
742 
743     let entry = indicators.lastPrice;
744     let target1, target2, target3, stopLoss;
745     const timeframeMultipliers = {
746         '5د': 0.3, '15د': 0.6, '30د': 1, 'ساعة': 1.5, '4س': 2.5
747     };
748     const multiplier = timeframeMultipliers[selectedTimeframe] || 1;
749 
750     if (atrData && atrData.atrPct > 0) {
751         const atrPct = atrData.atrPct / 100;
752         const movePct = atrPct * multiplier;
753         target1 = entry * (1 + movePct * 0.6);
754         target2 = entry * (1 + movePct * 1.2);
755         target3 = entry * (1 + movePct * 2);
756         stopLoss = entry * (1 - movePct * 0.5);
757     } else {
758         const baseMove = 0.02 * multiplier;
759         target1 = entry * (1 + baseMove * 0.6);
760         target2 = entry * (1 + baseMove * 1.2);
761         target3 = entry * (1 + baseMove * 2);
762         stopLoss = entry * (1 - baseMove * 0.5);
763     }
764 
765     const risk = ((entry - stopLoss) / entry * 100);
766     const reward = ((target2 - entry) / entry * 100);
767     const riskReward = risk > 0 ? (reward / risk) : 0;
768 
769     if (riskReward < 1.5) {
770         logPerformance(`analysis_${symbol}_lowRR`, Date.now() - startTime);
771         return null;
772     }
773 
774     let rating, ratingLabel;
775     if (score >= 80) { rating = 'ممتاز'; ratingLabel = '🟢 ممتاز'; }
776     else if (score >= 65) { rating = 'قوي'; ratingLabel = '🟢 قوي'; }
777     else if (score >= 50) { rating = 'متوسط'; ratingLabel = '🟠 متوسط'; }
778     else { rating = 'ضعيف'; ratingLabel = '🔴 ضعيف'; }
779 
780     const successRate = Math.min(Math.max(score * 0.65 + 15, 10), 92);
781 
782     logPerformance(`analysis_${symbol}`, Date.now() - startTime);
783 
784     return {
785         symbol,
786         score,
787         rating,
788         ratingLabel,
789         confidenceScore,
790         successRate: Math.round(successRate),
791         details,
792         market,
793         sentiment,
794         sr,
795         atr: atrData,
796         entry,
797         target1,
798         target2,
799         target3,
800         stopLoss,801         indicators,
802         premarket,
803         sector: sector || 'Other',
804         riskReward,
805         risk: risk.toFixed(2),
806         reward: reward.toFixed(2)
807     };
808 }
809 
810 // ===== 12. الحصول على أفضل الفرص =====
811 async function getTopOpportunities(limit = 5) {
812     const startTime = Date.now();
813     const results = [];
814     const batchSize = 5;
815     const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX', 'PYPL', 'ADBE', 'CRM', 'ORCL', 'IBM', 'AVGO', 'TXN', 'QCOM', 'MU', 'SMCI'];
816     
817     for (let i = 0; i < watchlist.length; i += batchSize) {
818         const batch = watchlist.slice(i, i + batchSize);
819         const batchResults = await Promise.all(batch.map(async (symbol) => {
820             try {
821                 const analysis = await getFullAnalysis(symbol);
822                 if (analysis && analysis.score >= 65) {
823                     return analysis;
824                 }
825                 return null;
826             } catch (error) {
827                 logError(`Batch Error ${symbol}: ${error.message}`);
828                 return null;
829             }
830         }));
831         results.push(...batchResults.filter(r => r !== null));
832     }
833     
834     results.sort((a, b) => b.score - a.score);
835     logPerformance('top_opportunities', Date.now() - startTime);
836     return results.slice(0, limit);
837 }
838 
839 // ===== 13. حفظ الإشارات =====
840 function saveSignal(analysis) {
841     const id = Date.now().toString();
842     db.run(
843         `INSERT INTO signals (id, symbol, date, entryPrice, target1, target2, target3, stopLoss, score, rating, status)
844          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
845         [
846             id,
847             analysis.symbol,
848             new Date().toISOString(),
849             analysis.entry,
850             analysis.target1,
851             analysis.target2,
852             analysis.target3,
853             analysis.stopLoss,
854             analysis.score,
855             analysis.rating,
856             'pending'
857         ]
858     );
859 }
860 
861 // ===== 14. تحديث حالة الإشارات =====
862 async function updateSignalStatus(symbol, currentPrice) {
863     db.all('SELECT * FROM signals WHERE symbol = ? AND status = ?', [symbol, 'pending'], (err, rows) => {
864         if (err || rows.length === 0) return;
865         for (const row of rows) {
866             let newStatus = 'pending';
867             let actualExit = null;
868             let actualProfit = null;
869             
870             if (currentPrice <= row.stopLoss) {
871                 newStatus = 'stoploss';
872                 actualExit = currentPrice;
873                 actualProfit = ((currentPrice - row.entryPrice) / row.entryPrice) * 100;
874             } else if (currentPrice >= row.target3) {
875                 newStatus = 'target3';
876                 actualExit = currentPrice;
877                 actualProfit = ((currentPrice - row.entryPrice) / row.entryPrice) * 100;
878             } else if (currentPrice >= row.target2) {
879                 newStatus = 'target2';
880             } else if (currentPrice >= row.target1) {
881                 newStatus = 'target1';
882             }
883             
884             if (newStatus !== 'pending' && newStatus !== row.status) {
885                 db.run(
886                     `UPDATE signals SET status = ?, actualExit = ?, actualProfit = ?, updatedAt = ?
887                      WHERE id = ?`,
888                     [newStatus, actualExit, actualProfit, new Date().toISOString(), row.id]
889                 );
890             }
891         }
892     });
893 }
894 
895 // ===== 15. Backtesting =====
896 async function runBacktest(days = 180) {
897     const startTime = Date.now();
898     const results = [];
899     const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
900     
901     for (const symbol of watchlist) {
902         try {
903             const response = await axios.get(
904                 `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`,
905                 { timeout: 5000 }
906             );
907             const data = response.data.chart.result[0];
908             if (!data) continue;
909             const quote = data.indicators.quote[0];
910             const closes = quote.close.filter(c => c !== null);
911             
912             if (closes.length < 20) continue;
913             
914             let wins = 0, losses = 0;
915             let totalProfit = 0;
916             
917             for (let i = 20; i < closes.length - 5; i++) {
918                 const rsi = calculateWilderRSI(closes.slice(0, i + 1), 14);
919                 if (rsi > 55 && rsi < 70) {
920                     const entry = closes[i];
921                     const target = entry * 1.04;
922                     const stop = entry * 0.95;
923                     
924                     for (let j = i + 1; j < Math.min(i + 10, closes.length); j++) {
925                         if (closes[j] >= target) {
926                             wins++;
927                             totalProfit += 4;
928                             break;
929                         } else if (closes[j] <= stop) {
930                             losses++;
931                             totalProfit -= 5;
932                             break;
933                         }
934                     }
935                 }
936             }
937             
938             const totalTrades = wins + losses;
939             if (totalTrades > 0) {
940                 const winRate = (wins / totalTrades) * 100;
941                 const avgReturn = totalProfit / totalTrades;
942                 const profitFactor = losses > 0 ? (wins * 4) / (losses * 5) : wins > 0 ? 999 : 0;
943                 
944                 results.push({
945                     symbol,
946                     winRate: winRate.toFixed(1),
947                     avgReturn: avgReturn.toFixed(2),
948                     profitFactor: profitFactor.toFixed(2),
949                     trades: totalTrades
950                 });
951             }
952         } catch (error) { continue; }
953     }
954 
955     logPerformance('backtest', Date.now() - startTime);
956     return results;
957 }
958 
959 // ===== 16. حساب التطهير =====
960 function calculatePurificationRatio(symbol) {
961     const forbidden = ['BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'KO', 'PEP'];
962     if (forbidden.includes(symbol)) {
963         return { percentage: 100, isForbidden: true, reason: 'نشاط محرم' };
964     }
965     const rates = { 'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3, 'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2 };
966     return { percentage: rates[symbol] || 0.5, isForbidden: false, reason: 'نشاط مختلط' };
967 }
968 
969 // ===== 17. الأوامر =====
970 
971 // ===== /سوبر_فرص =====
972 bot.onText(/\/سوبر_فرص/, async (msg) => {
973     if (!checkRateLimit(msg.chat.id)) {
974         bot.sendMessage(msg.chat.id, '⏳ العديد من الطلبات، انتظر قليلاً');
975         return;
976     }
977     
978     const chatId = msg.chat.id;
979     const statusMsg = await bot.sendMessage(chatId, '🔍 جاري البحث عن أفضل الفرص...');
980     
981     const opps = await getTopOpportunities(5);
982     if (opps.length === 0) {
983         bot.sendMessage(chatId, '📭 لا توجد فرص مطابقة للشروط (الحد الأدنى 65 نقطة)');
984         return;
985     }
986 
987     let message = `🔥 *أفضل 5 فرص (نظام التقييم 100 نقطة)*\n━━━━━━━━━━━━━━━━━━\n`;
988     opps.forEach((opp, i) => {
989         message +=
990             `${i+1}. *${opp.symbol}* | ${opp.ratingLabel} (${opp.score}/100)\n` +
991             `   📈 السعر: $${opp.indicators.lastPrice.toFixed(2)}\n` +
992             `   📊 RSI: ${formatRSI(opp.indicators.rsi)}\n` +
993             `   💧 RVOL: ${formatVolume(opp.indicators.volumeRatio)}\n` +
994             `   📊 ATR: ${opp.atr ? opp.atr.atrPct.toFixed(2) + '%' : 'غير متاح'}\n` +
995             `   🌅 Premarket: ${opp.premarket !== null ? formatChange(opp.premarket) : '⚪ غير متاح'}\n` +
996             `   📰 الأخبار: ${opp.sentiment.overall} (ثقة ${opp.sentiment.confidence}%)\n` +
997             `   🛡️ المقاومة: ${opp.sr?.nearestResistance ? '$' + opp.sr.nearestResistance.toFixed(2) : 'غير متاح'} | الدعم: ${opp.sr?.nearestSupport ? '$' + opp.sr.nearestSupport.toFixed(2) : 'غير متاح'}\n` +
998             `   🎯 الدخول: $${opp.entry.toFixed(2)}\n` +
999             `   🚀 الأهداف: $${opp.target1.toFixed(2)} | $${opp.target2.toFixed(2)} | $${opp.target3.toFixed(2)}\n` +
1000            `   🛑 وقف: $${opp.stopLoss.toFixed(2)}\n` +1001            `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward.toFixed(2)}\n` +
1002            `   🎯 الثقة: ${formatConfidence(opp.confidenceScore)}\n` +
1003            `   📊 النجاح المتوقع: ${opp.successRate}%\n` +
1004            `━━━━━━━━━━━━━━━━━━\n`;
1005    });
1006    message += `💡 /تحليل [الرمز] للتفاصيل الكاملة`;
1007    
1008    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1009    bot.deleteMessage(chatId, statusMsg.message_id);
1010 });
1011 
1012 // ===== /تحليل =====
1013 bot.onText(/\/تحليل (.+)/, async (msg, match) => {
1014     if (!checkRateLimit(msg.chat.id)) {
1015         bot.sendMessage(msg.chat.id, '⏳ العديد من الطلبات، انتظر قليلاً');
1016         return;
1017     }
1018     
1019     const symbol = match[1].toUpperCase();
1020     const chatId = msg.chat.id;
1021     const statusMsg = await bot.sendMessage(chatId, `⏳ جاري تحليل ${symbol}...`);
1022     
1023     const analysis = await getFullAnalysis(symbol);
1024     if (!analysis) {
1025         bot.sendMessage(chatId, `❌ لم أتمكن من تحليل ${symbol} أو السهم لا يلبي الشروط`);
1026         return;
1027     }
1028 
1029     let message =
1030         `📊 *${symbol} - التحليل المتقدم*\n━━━━━━━━━━━━━━━━━━\n` +
1031         `💰 *السعر:* $${analysis.indicators.lastPrice.toFixed(2)}\n` +
1032         `📈 *التغير:* ${formatChange(analysis.indicators.change)}\n` +
1033         `📊 *RSI:* ${formatRSI(analysis.indicators.rsi)}\n` +
1034         `💧 *RVOL:* ${formatVolume(analysis.indicators.volumeRatio)}\n` +
1035         `🌅 *Premarket:* ${analysis.premarket !== null ? formatChange(analysis.premarket) : '⚪ غير متاح'}\n` +
1036         `━━━━━━━━━━━━━━━━━━\n` +
1037         `📊 *تفاصيل التقييم (${analysis.score}/100):*\n`;
1038     analysis.details.forEach(d => { message += `• ${d.name}: ${d.score}/${d.max}\n`; });
1039     message +=
1040         `━━━━━━━━━━━━━━━━━━\n` +
1041         `📰 *الأخبار:* ${analysis.sentiment.overall} (ثقة ${analysis.sentiment.confidence}%)\n` +
1042         `📊 *ATR:* ${analysis.atr ? analysis.atr.atrPct.toFixed(2) + '%' : 'غير متاح'}\n` +
1043         `🏢 *القطاع:* ${analysis.sector || 'Other'}\n` +
1044         `📈 *اتجاه السوق:* ${analysis.market?.message || 'غير متاح'}\n` +
1045         `━━━━━━━━━━━━━━━━━━\n` +
1046         `🛡️ *المقاومة:* ${analysis.sr?.nearestResistance ? '$' + analysis.sr.nearestResistance.toFixed(2) + ' (بعد ' + analysis.sr.resistanceDistance?.toFixed(2) + '%)' : 'غير متاح'}\n` +
1047         `🛡️ *الدعم:* ${analysis.sr?.nearestSupport ? '$' + analysis.sr.nearestSupport.toFixed(2) + ' (بعد ' + analysis.sr.supportDistance?.toFixed(2) + '%)' : 'غير متاح'}\n` +
1048         `━━━━━━━━━━━━━━━━━━\n` +
1049         `🎯 *الدخول:* $${analysis.entry.toFixed(2)}\n` +
1050         `🚀 *الهدف 1:* $${analysis.target1.toFixed(2)} (${((analysis.target1/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
1051         `🚀 *الهدف 2:* $${analysis.target2.toFixed(2)} (${((analysis.target2/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
1052         `🚀 *الهدف 3:* $${analysis.target3.toFixed(2)} (${((analysis.target3/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
1053         `🛑 *وقف الخسارة:* $${analysis.stopLoss.toFixed(2)} (${((analysis.stopLoss/analysis.entry - 1) * 100).toFixed(2)}%)\n` +
1054         `━━━━━━━━━━━━━━━━━━\n` +
1055         `⚖️ *المخاطرة/العائد:* 1:${analysis.riskReward.toFixed(2)}\n` +
1056         `🎯 *الثقة:* ${formatConfidence(analysis.confidenceScore)}\n` +
1057         `📊 *النجاح المتوقع:* ${analysis.successRate}%\n` +
1058         `🏷️ *التصنيف:* ${analysis.ratingLabel}\n` +
1059         `━━━━━━━━━━━━━━━━━━\n` +
1060         `🕌 *التطهير:* ${calculatePurificationRatio(symbol).percentage}%`;
1061 
1062     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1063     bot.deleteMessage(chatId, statusMsg.message_id);
1064 });
1065 
1066 // ===== /باك_تست =====
1067 bot.onText(/\/باك_تست/, async (msg) => {
1068     if (msg.chat.id.toString() !== userId) return;
1069     
1070     const chatId = msg.chat.id;
1071     const statusMsg = await bot.sendMessage(chatId, '🔍 جاري تنفيذ Backtesting...');
1072     
1073     const results = await runBacktest(180);
1074     if (results.length === 0) {
1075         bot.sendMessage(chatId, '📭 لا توجد بيانات كافية للاختبار');
1076         return;
1077     }
1078 
1079     let message = `📊 *نتائج Backtesting (6 أشهر)*\n━━━━━━━━━━━━━━━━━━\n`;
1080     results.forEach(r => {
1081         message +=
1082             `📈 ${r.symbol}\n` +
1083             `   نسبة النجاح: ${r.winRate}%\n` +
1084             `   متوسط العائد: ${r.avgReturn}%\n` +
1085             `   Profit Factor: ${r.profitFactor}\n` +
1086             `   عدد الصفقات: ${r.trades}\n━━━━━━━━━━━━━━━━━━\n`;
1087     });
1088     
1089     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1090     bot.deleteMessage(chatId, statusMsg.message_id);
1091 });
1092 
1093 // ===== /اخبار =====
1094 bot.onText(/\/اخبار (.+)/, async (msg, match) => {
1095     const symbol = match[1].toUpperCase();
1096     const sentiment = await getAdvancedNewsSentiment(symbol);
1097     if (sentiment.news.length === 0) {
1098         bot.sendMessage(msg.chat.id, `📰 لا توجد أخبار لـ ${symbol}`);
1099         return;
1100     }
1101     let message = `📰 *تحليل الأخبار - ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
1102     message += `📊 *المعنويات العامة:* ${sentiment.overall}\n`;
1103     message += `📊 *درجة المعنويات:* ${sentiment.score}/100\n`;
1104     message += `📊 *ثقة التحليل:* ${sentiment.confidence}%\n━━━━━━━━━━━━━━━━━━\n`;
1105     sentiment.news.forEach((n, i) => {
1106         message += `${i+1}. ${n.title}\n   ${n.score >= 1 ? '🟢' : n.score <= -1 ? '🔴' : '⚪'} ${n.label}\n\n`;
1107     });
1108     bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1109 });
1110 
1111 // ===== /جاب =====
1112 bot.onText(/\/جاب/, async (msg) => {
1113     const chatId = msg.chat.id;
1114     await bot.sendMessage(chatId, '🔍 جاري البحث عن Gaps...');
1115     const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];
1116     const results = [];
1117     for (const symbol of watchlist) {
1118         try {
1119             const premarket = await getRealPremarket(symbol);
1120             const ind = await getIndicators(symbol);
1121             if (premarket !== null && premarket > 5 && ind && ind.avgVolume > 500000 && ind.lastPrice > 2) {
1122                 results.push({ symbol, gap: premarket, volume: ind.avgVolume, price: ind.lastPrice });
1123             }
1124         } catch (error) { continue; }
1125     }
1126     results.sort((a, b) => b.gap - a.gap);
1127     if (results.length === 0) {
1128         bot.sendMessage(chatId, '📭 لا توجد Gaps حالياً');
1129         return;
1130     }
1131     let message = `🌅 *Gap Scanner - أفضل 10 فجوات*\n━━━━━━━━━━━━━━━━━━\n`;
1132     results.slice(0, 10).forEach((g, i) => {
1133         message +=
1134             `${i+1}. *${g.symbol}* | Gap: 🟢 ${g.gap.toFixed(2)}%\n` +
1135             `   💰 السعر: $${g.price.toFixed(2)}\n` +
1136             `   💧 الحجم: ${(g.volume/1000000).toFixed(2)}M\n` +
1137             `━━━━━━━━━━━━━━━━━━\n`;
1138     });
1139     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1140 });
1141 
1142 // ===== /فلتر =====
1143 bot.onText(/\/فلتر (.+)/, async (msg, match) => {
1144     const minVolume = parseInt(match[1]) * 1000000 || 1000000;
1145     const chatId = msg.chat.id;
1146     await bot.sendMessage(chatId, `⏳ جاري فلترة الأسهم...`);
1147     const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX', 'PYPL', 'ADBE', 'CRM', 'ORCL', 'IBM'];
1148     const results = [];
1149     for (const symbol of watchlist) {
1150         try {
1151             const ind = await getIndicators(symbol);
1152             if (ind && ind.avgVolume >= minVolume && ind.lastPrice >= 5) {
1153                 results.push({ symbol, volume: ind.avgVolume, price: ind.lastPrice });
1154             }
1155         } catch (error) { continue; }
1156     }
1157     if (results.length === 0) {
1158         bot.sendMessage(chatId, `📭 لا توجد أسهم بحجم > ${minVolume.toLocaleString()} وسعر > 5$`);
1159         return;
1160     }
1161     let message = `📊 *الأسهم المؤهلة*\n━━━━━━━━━━━━━━━━━━\n`;
1162     results.slice(0, 15).forEach((f, i) => {
1163         message += `${i+1}. ${f.symbol}: ${(f.volume/1000000).toFixed(2)}M | $${f.price.toFixed(2)}\n`;
1164     });
1165     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1166 });
1167 
1168 // ===== /فرص_اليوم =====
1169 bot.onText(/\/فرص_اليوم/, async (msg) => {
1170     const chatId = msg.chat.id;
1171     await bot.sendMessage(chatId, '🔍 جاري البحث عن الفرص...');
1172     const opps = await getTopOpportunities(5);
1173     if (opps.length === 0) {
1174         bot.sendMessage(chatId, '📭 لا توجد فرص (الحد الأدنى 65 نقطة)');
1175         return;
1176     }
1177     let message = `🔥 *أفضل الفرص*\n━━━━━━━━━━━━━━━━━━\n`;
1178     opps.forEach((opp, i) => {
1179         message +=
1180             `${i+1}. *${opp.symbol}* | ${opp.ratingLabel} (${opp.score}/100)\n` +
1181             `   📈 السعر: $${opp.indicators.lastPrice.toFixed(2)}\n` +
1182             `   📊 RSI: ${formatRSI(opp.indicators.rsi)}\n` +
1183             `   💧 RVOL: ${formatVolume(opp.indicators.volumeRatio)}\n` +
1184             `   🎯 الدخول: $${opp.entry.toFixed(2)}\n` +
1185             `   ⚖️ المخاطرة/العائد: 1:${opp.riskReward.toFixed(2)}\n` +
1186             `━━━━━━━━━━━━━━━━━━\n`;
1187     });
1188     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1189 });
1190 
1191 // ===== /تسجيل =====
1192 bot.onText(/\/تسجيل (.+?) (.+?) (.+)/, (msg, match) => {
1193     const symbol = match[1].toUpperCase();
1194     const entryPrice = parseFloat(match[2]);
1195     const exitPrice = parseFloat(match[3]);
1196     if (!symbol || isNaN(entryPrice) || isNaN(exitPrice)) {
1197         bot.sendMessage(msg.chat.id, '❌ /تسجيل [الرمز] [الدخول] [الخروج]');
1198         return;
1199     }
1200     const p = calculatePurificationRatio(symbol);1201     const profit = ((exitPrice - entryPrice) / entryPrice * 100);
1202     const isProfit = profit > 0;
1203     db.run(
1204         `INSERT INTO trades (id, symbol, entryPrice, exitPrice, profit, isProfit, purification, date, status)
1205          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
1206         [Date.now().toString(), symbol, entryPrice, exitPrice, profit, isProfit ? 1 : 0, p.percentage, new Date().toISOString(), 'CLOSED']
1207     );
1208     bot.sendMessage(msg.chat.id,
1209         `✅ *تم تسجيل الصفقة!*\n━━━━━━━━━━━━━━━━━━\n` +
1210         `📊 ${symbol}\n💰 الدخول: $${entryPrice}\n💰 الخروج: $${exitPrice}\n` +
1211         `📈 الربح: ${profit.toFixed(2)}%\n🕌 التطهير: ${p.percentage}%`,
1212         { parse_mode: 'Markdown' }
1213     );
1214 });
1215 
1216 // ===== /تطهير =====
1217 bot.onText(/\/تطهير (.+)/, (msg, match) => {
1218     const symbol = match[1].toUpperCase();
1219     const p = calculatePurificationRatio(symbol);
1220     let message = `🕌 *نسبة التطهير لـ ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
1221     message += p.isForbidden ? `❌ غير متوافق\n📌 ${p.reason}\n📊 100%` : `✅ متوافق\n📊 ${p.percentage}%`;
1222     bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1223 });
1224 
1225 // ===== /تشغيل =====
1226 bot.onText(/\/تشغيل/, (msg) => {
1227     if (msg.chat.id.toString() !== userId) return;
1228     botActive = true;
1229     bot.sendMessage(msg.chat.id, '✅ *تم تشغيل البوت*', { parse_mode: 'Markdown' });
1230 });
1231 
1232 // ===== /ايقاف =====
1233 bot.onText(/\/ايقاف/, (msg) => {
1234     if (msg.chat.id.toString() !== userId) return;
1235     botActive = false;
1236     bot.sendMessage(msg.chat.id, '⛔ *تم إيقاف البوت*', { parse_mode: 'Markdown' });
1237 });
1238 
1239 // ===== /توقيت =====
1240 bot.onText(/\/توقيت/, (msg) => {
1241     if (msg.chat.id.toString() !== userId) return;
1242     const timeframes = {
1243         '5د': { minutes: 5, label: '5 دقائق' },
1244         '15د': { minutes: 15, label: 'ربع ساعة' },
1245         '30د': { minutes: 30, label: 'نصف ساعة' },
1246         'ساعة': { minutes: 60, label: 'ساعة' },
1247         '4س': { minutes: 240, label: '4 ساعات' }
1248     };
1249     let message =
1250         `⏰ *اختر الإطار الزمني:*\n━━━━━━━━━━━━━━━━━━\n` +
1251         `1️⃣ /توقيت_5د - 5 دقائق\n` +
1252         `2️⃣ /توقيت_15د - ربع ساعة\n` +
1253         `3️⃣ /توقيت_30د - نصف ساعة\n` +
1254         `4️⃣ /توقيت_ساعة - ساعة\n` +
1255         `5️⃣ /توقيت_4س - 4 ساعات\n` +
1256         `━━━━━━━━━━━━━━━━━━\n` +
1257         `الحالي: ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}`;
1258     bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1259 });
1260 
1261 ['5د', '15د', '30د', 'ساعة', '4س'].forEach(tf => {
1262     bot.onText(new RegExp(`/توقيت_${tf}`), (msg) => {
1263         if (msg.chat.id.toString() !== userId) return;
1264         selectedTimeframe = tf;
1265         bot.sendMessage(msg.chat.id, `✅ تم تغيير الإطار الزمني إلى: ${timeframes[tf].label}`, { parse_mode: 'Markdown' });
1266     });
1267 });
1268 
1269 // ===== /تقرير_ذاتي =====
1270 bot.onText(/\/تقرير_ذاتي (.+)/, (msg, match) => {
1271     if (match[1] !== '1411' || msg.chat.id.toString() !== userId) {
1272         bot.sendMessage(msg.chat.id, '⛔ غير مصرح!');
1273         return;
1274     }
1275     let message =
1276         `📊 *التقارير الذاتية*\n━━━━━━━━━━━━━━━━━━\n` +
1277         `/تقرير_اليوم 1411 - اليوم\n` +
1278         `/تقرير_الاسبوع 1411 - الأسبوع\n` +
1279         `/تقرير_الشهر 1411 - الشهر\n` +
1280         `/مراجعة 1411 - مراجعة سريعة`;
1281     bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1282 });
1283 
1284 ['اليوم', 'الاسبوع', 'الشهر'].forEach(type => {
1285     bot.onText(new RegExp(`/تقرير_${type} (.+)`), (msg, match) => {
1286         if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
1287         const trades = [];
1288         db.all('SELECT * FROM trades', [], (err, rows) => {
1289             if (err || rows.length === 0) {
1290                 bot.sendMessage(msg.chat.id, `📊 لا توجد صفقات في الفترة ${type}`);
1291                 return;
1292             }
1293             const now = new Date();
1294             const days = type === 'اليوم' ? 1 : type === 'الاسبوع' ? 7 : 30;
1295             const cutoff = new Date(now);
1296             cutoff.setDate(cutoff.getDate() - days);
1297             const filtered = rows.filter(t => new Date(t.date) >= cutoff);
1298             
1299             if (filtered.length === 0) {
1300                 bot.sendMessage(msg.chat.id, `📊 لا توجد صفقات في الفترة ${type}`);
1301                 return;
1302             }
1303             
1304             const totalProfit = filtered.reduce((s, t) => s + t.profit, 0);
1305             const winCount = filtered.filter(t => t.isProfit === 1).length;
1306             const lossCount = filtered.filter(t => t.isProfit === 0).length;
1307             const winRate = (winCount / filtered.length * 100);
1308             const avgProfit = totalProfit / filtered.length;
1309             const bestTrade = Math.max(...filtered.map(t => t.profit));
1310             const worstTrade = Math.min(...filtered.map(t => t.profit));
1311             
1312             let message =
1313                 `📊 *التقرير ${type}*\n━━━━━━━━━━━━━━━━━━\n` +
1314                 `📈 عدد الصفقات: ${filtered.length}\n` +
1315                 `✅ رابحة: ${winCount}\n❌ خاسرة: ${lossCount}\n` +
1316                 `📊 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
1317                 `━━━━━━━━━━━━━━━━━━\n` +
1318                 `💰 إجمالي الربح: ${totalProfit.toFixed(2)}%\n` +
1319                 `📊 متوسط الربح: ${avgProfit.toFixed(2)}%\n` +
1320                 `⭐ أفضل صفقة: +${bestTrade.toFixed(2)}%\n` +
1321                 `💀 أسوأ صفقة: ${worstTrade.toFixed(2)}%\n` +
1322                 `━━━━━━━━━━━━━━━━━━\n` +
1323                 `💡 التقييم: ${winRate > 60 ? '🌟 ممتاز' : winRate > 40 ? '⚠️ جيد' : '❌ يحتاج مراجعة'}`;
1324             bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1325         });
1326     });
1327 });
1328 
1329 // ===== /مراجعة =====
1330 bot.onText(/\/مراجعة (.+)/, (msg, match) => {
1331     if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
1332     db.all('SELECT * FROM trades ORDER BY date DESC LIMIT 1', [], (err, lastRow) => {
1333         if (err || lastRow.length === 0) {
1334             bot.sendMessage(msg.chat.id, '📭 لا توجد صفقات');
1335             return;
1336         }
1337         db.all('SELECT * FROM trades', [], (err2, allRows) => {
1338             if (err2) return;
1339             const last = lastRow[0];
1340             const total = allRows.reduce((s, t) => s + t.profit, 0);
1341             const winRate = (allRows.filter(t => t.isProfit === 1).length / allRows.length * 100);
1342             bot.sendMessage(msg.chat.id,
1343                 `📋 *مراجعة سريعة*\n━━━━━━━━━━━━━━━━━━\n` +
1344                 `📊 آخر صفقة: ${last.symbol} (${last.profit.toFixed(2)}%)\n` +
1345                 `💰 إجمالي الربح: ${total.toFixed(2)}%\n` +
1346                 `📈 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
1347                 `📊 عدد الصفقات: ${allRows.length}\n` +
1348                 `━━━━━━━━━━━━━━━━━━\n` +
1349                 `💡 ${winRate > 60 ? '✅ ممتاز' : '⚠️ يحتاج تحسين'}`,
1350                 { parse_mode: 'Markdown' }
1351             );
1352         });
1353     });
1354 });
1355 
1356 // ===== /احصائيات =====
1357 bot.onText(/\/احصائيات/, (msg) => {
1358     db.all('SELECT * FROM signals', [], (err, signals) => {
1359         if (err || signals.length === 0) {
1360             bot.sendMessage(msg.chat.id, '📊 لا توجد إشارات مسجلة');
1361             return;
1362         }
1363         const total = signals.length;
1364         const pending = signals.filter(s => s.status === 'pending').length;
1365         const completed = signals.filter(s => s.status !== 'pending').length;
1366         const successful = signals.filter(s => s.status === 'target1' || s.status === 'target2' || s.status === 'target3').length;
1367         const failed = signals.filter(s => s.status === 'stoploss').length;
1368         const winRate = completed > 0 ? (successful / completed * 100) : 0;
1369         const avgScore = signals.reduce((s, sig) => s + (sig.score || 0), 0) / total;
1370         const ratings = {
1371             'ممتاز': signals.filter(s => s.rating === 'ممتاز').length,
1372             'قوي': signals.filter(s => s.rating === 'قوي').length,
1373             'متوسط': signals.filter(s => s.rating === 'متوسط').length,
1374             'ضعيف': signals.filter(s => s.rating === 'ضعيف').length
1375         };
1376 
1377         let message =
1378             `📊 *إحصائيات الإشارات*\n━━━━━━━━━━━━━━━━━━\n` +
1379             `📈 إجمالي الإشارات: ${total}\n` +
1380             `⏳ قيد التنفيذ: ${pending}\n` +
1381             `✅ مكتملة: ${completed}\n` +
1382             `🟢 ناجحة: ${successful}\n` +
1383             `🔴 فاشلة: ${failed}\n` +
1384             `📊 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
1385             `━━━━━━━━━━━━━━━━━━\n` +
1386             `📊 متوسط التقييم: ${avgScore.toFixed(1)}/100\n` +
1387             `🏷️ التصنيفات:\n` +
1388             `• ممتاز: ${ratings['ممتاز']}\n` +
1389             `• قوي: ${ratings['قوي']}\n` +
1390             `• متوسط: ${ratings['متوسط']}\n` +
1391             `• ضعيف: ${ratings['ضعيف']}`;
1392         bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1393     });
1394 });
1395 
1396 // ===== /شرح_المؤشرات =====
1397 bot.onText(/\/شرح_المؤشرات/, (msg) => {
1398     const message =
1399         `📚 *شرح المؤشرات ونظام التقييم*\n━━━━━━━━━━━━━━━━━━\n\n` +
1400         `📈 *المؤشرات الفنية:*\n` +1401         `• RSI Wilder: قوة السهم (55-70 = جيد)\n` +
1402         `• RVOL: حجم التداول (2x+ = ممتاز)\n` +
1403         `• ATR: متوسط المدى الحقيقي\n` +
1404         `• MA20/MA50: المتوسطات المتحركة\n` +
1405         `• MACD: الزخم مع Signal Line\n` +
1406         `• Premarket: حركة ما قبل الافتتاح\n\n` +
1407         `📊 *نظام التقييم (100 نقطة):*\n` +
1408         `• اتجاه السوق (SPY/QQQ/IWM/DIA): 15\n` +
1409         `• قوة القطاع (ديناميكي): 10\n` +
1410         `• تحليل الأخبار (معنويات + حداثة): 10\n` +
1411         `• RSI (Wilder 14): 10\n` +
1412         `• الاتجاه (MA20/MA50): 10\n` +
1413         `• MACD (EMA 12/26 + Signal 9): 10\n` +
1414         `• RVOL (حجم نسبي): 10\n` +
1415         `• Premarket (حقيقي): 5\n` +
1416         `• دعم/مقاومة (Pivot + قوة): 10\n` +
1417         `• سيولة إضافية: 10\n\n` +
1418         `🏷️ *التصنيفات:*\n` +
1419         `• 80+ : ممتاز\n` +
1420         `• 65-79 : قوي\n` +
1421         `• 50-64 : متوسط\n` +
1422         `• أقل من 50 : ضعيف\n\n` +
1423         `🔒 *شروط القبول:*\n` +
1424         `• حجم التداول > 1M\n` +
1425         `• السعر > 5$\n` +
1426         `• Risk/Reward > 1:1.5\n` +
1427         `• الحد الأدنى للفرص: 65 نقطة\n\n` +
1428         `📊 *نظام المتابعة:*\n` +
1429         `• SQLite لقاعدة البيانات\n` +
1430         `• Cache لمدة 5 دقائق\n` +
1431         `• Rate Limiting لمنع السبام\n` +
1432         `• Backtesting لتقييم الاستراتيجية`;
1433     bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
1434 });
1435 
1436 // ===== /بدء =====
1437 bot.onText(/\/start|\/بدء/, (msg) => {
1438     const chatId = msg.chat.id;
1439     const status = botActive ? '🟢 يعمل' : '🔴 متوقف';
1440     const timeframes = {
1441         '5د': { minutes: 5, label: '5 دقائق' },
1442         '15د': { minutes: 15, label: 'ربع ساعة' },
1443         '30د': { minutes: 30, label: 'نصف ساعة' },
1444         'ساعة': { minutes: 60, label: 'ساعة' },
1445         '4س': { minutes: 240, label: '4 ساعات' }
1446     };
1447     const message =
1448         `🏠 *القائمة الرئيسية*\n━━━━━━━━━━━━━━━━━━\n` +
1449         `📊 *حالة البوت:* ${status}\n` +
1450         `⏰ *الإطار الزمني:* ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}\n` +
1451         `━━━━━━━━━━━━━━━━━━\n` +
1452         `📋 *الأوامر:*\n` +
1453         `/سوبر_فرص - أفضل 5 فرص (نظام 100 نقطة)\n` +
1454         `/تحليل [الرمز] - تحليل متقدم\n` +
1455         `/اخبار [الرمز] - تحليل معنويات الأخبار\n` +
1456         `/جاب - قائمة الـ Gaps\n` +
1457         `/فلتر [القيمة] - فلترة الأسهم\n` +
1458         `/تسجيل [الرمز] [الدخول] [الخروج]\n` +
1459         `/تقرير_ذاتي 1411 - التقارير\n` +
1460         `/مراجعة 1411 - مراجعة سريعة\n` +
1461         `/تطهير [الرمز] - نسبة التطهير\n` +
1462         `/احصائيات - إحصائيات الإشارات\n` +
1463         `/باك_تست - اختبار تاريخي\n` +
1464         `━━━━━━━━━━━━━━━━━━\n` +
1465         `⚙️ *الإعدادات:*\n` +
1466         `✅ /تشغيل - تشغيل البوت\n` +
1467         `🔄 /ايقاف - إيقاف البوت\n` +
1468         `⏰ /توقيت - تغيير الإطار الزمني\n` +
1469         `━━━━━━━━━━━━━━━━━━\n` +
1470         `📚 /شرح_المؤشرات - شرح المؤشرات\n` +
1471         `💡 /مساعدة - للمساعدة`;
1472     bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
1473 });
1474 
1475 // ===== /مساعدة =====
1476 bot.onText(/\/مساعدة/, (msg) => {
1477     bot.emit('text', { chat: { id: msg.chat.id }, text: '/start' });
1478 });
1479 
1480 // ===== مسح الفرص المنتهية =====
1481 setInterval(() => {
1482     db.all('SELECT * FROM opportunities WHERE status = ?', ['منتهية'], (err, rows) => {
1483         if (err || rows.length === 0) return;
1484         const now = Date.now();
1485         const expiredThreshold = 30 * 60 * 1000;
1486         for (const row of rows) {
1487             if ((now - row.expiryTime) > expiredThreshold) {
1488                 db.run('DELETE FROM opportunities WHERE id = ?', [row.id]);
1489             }
1490         }
1491     });
1492 }, 5 * 60 * 1000);
1493 
1494 // ===== مراقبة الأداء =====
1495 setInterval(() => {
1496     db.get('SELECT COUNT(*) as count FROM performance WHERE timestamp > ?', [new Date(Date.now() - 3600000).toISOString()], (err, row) => {
1497         if (err) return;
1498         if (row.count > 1000) {
1499             logError(`تحذير: عدد العمليات مرتفع (${row.count}) في الساعة الماضية`);
1500         }
1501     });
1502 }, 5 * 60 * 1000);
1503 
1504 // ===== تحديث حالة الإشارات كل 10 دقائق =====
1505 setInterval(() => {
1506     const symbols = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD'];
1507     for (const symbol of symbols) {
1508         (async () => {
1509             try {
1510                 const response = await axios.get(
1511                     `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
1512                     { timeout: 5000 }
1513                 );
1514                 const data = response.data.chart.result[0];
1515                 if (data) {
1516                     const quote = data.indicators.quote[0];
1517                     const lastPrice = quote.close[quote.close.length - 1];
1518                     if (lastPrice) {
1519                         await updateSignalStatus(symbol, lastPrice);
1520                     }
1521                 }
1522             } catch (error) { /* ignore */ }
1523         })();
1524     }
1525 }, 10 * 60 * 1000);
1526 
1527 // ===== Rate Limiting Cleanup =====
1528 setInterval(() => {
1529     const now = Date.now();
1530     for (const chatId in rateLimit.requests) {
1531         rateLimit.requests[chatId] = rateLimit.requests[chatId].filter(t => now - t < rateLimit.window);
1532         if (rateLimit.requests[chatId].length === 0) {
1533             delete rateLimit.requests[chatId];
1534         }
1535     }
1536 }, 60000);
1537 
1538 // ===== إغلاق قاعدة البيانات عند الخروج =====
1539 process.on('SIGINT', () => {
1540     db.close();
1541     process.exit(0);
1542 });
1543 
1544 process.on('SIGTERM', () => {
1545     db.close();
1546     process.exit(0);
1547 });
1548 
1549 // ===== تشغيل البوت =====
1550 console.log('✅ بوت التداول المتطور يعمل...');
1551 console.log(`📊 قيد التشغيل على الإطار الزمني: ${timeframes[selectedTimeframe]?.label || '30 دقيقة'}`);
1552 console.log(`📈 عدد الأسهم في القائمة: 20`);
1553 console.log(`🔄 تحديث الإشارات كل 10 دقائق`);
1554 console.log(`🗑️ تنظيف الفرص المنتهية كل 5 دقائق`);
1555 console.log(`📊 مراقبة الأداء كل 5 دقائق`);
1556 console.log(`⏳ Rate Limiting: ${rateLimit.maxRequests} طلب لكل ${rateLimit.window/1000} ثانية`);
1557 
1558 // ===== المتغيرات العامة =====
1559 let botActive = true;
1560 let selectedTimeframe = '30د';
1561 const timeframes = {
1562     '5د': { minutes: 5, label: '5 دقائق' },
1563     '15د': { minutes: 15, label: 'ربع ساعة' },
1564     '30د': { minutes: 30, label: 'نصف ساعة' },
1565     'ساعة': { minutes: 60, label: 'ساعة' },
1566     '4س': { minutes: 240, label: '4 ساعات' }
1567 };
1568 
1569 console.log('✅ بوت التداول المتطور يعمل...');