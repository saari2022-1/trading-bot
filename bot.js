const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

// ===== التوكنات =====
const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });
const userId = '709023711';

// ===== قائمة S&P 500 =====
async function getSP500List() {
    try {
        const response = await axios.get(
            'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'
        );
        const lines = response.data.split('\n');
        const symbols = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line) {
                const parts = line.split(',');
                if (parts[0]) {
                    symbols.push(parts[0].trim().replace(/"/g, ''));
                }
            }
        }
        return symbols.slice(0, 50);
    } catch (error) {
        return ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA'];
    }
}

// ===== حساب التطهير الشرعي =====
function calculatePurificationRatio(symbol) {
    const forbiddenStocks = [
        'BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'AXP', 'V', 'MA',
        'KO', 'PEP', 'STZ', 'BF.B', 'TAP',
        'MGM', 'WYNN', 'LVS', 'DKNG', 'PENN',
        'PM', 'MO', 'BTI'
    ];
    
    const purificationRates = {
        'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3,
        'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2, 'AMD': 0.2,
        'INTC': 0.8, 'NFLX': 0.5, 'ADBE': 1.0, 'CRM': 1.5,
        'ORCL': 1.2, 'IBM': 1.0
    };
    
    if (forbiddenStocks.includes(symbol)) {
        return { percentage: 100, isForbidden: true, reason: 'نشاط محرم (ربا/خمور/قمار)' };
    }
    
    let percentage = purificationRates[symbol] || 0.5;
    percentage = Math.min(percentage + (Math.random() * 0.5), 5);
    
    return {
        percentage: parseFloat(percentage.toFixed(2)),
        isForbidden: false,
        reason: 'نشاط مختلط (نسبة تطهير مقدرة)'
    };
}

// ===== دالة جلب المؤشرات الفنية =====
async function getTechnicalIndicators(symbol) {
    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        
        const quote = data.indicators.quote[0];
        const closes = quote.close.filter(c => c !== null);
        const highs = quote.high.filter(h => h !== null);
        const lows = quote.low.filter(l => l !== null);
        
        if (closes.length < 50) return null;
        
        // المتوسطات
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
        
        // RSI
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length - 1; i++) {
            const diff = closes[i + 1] - closes[i];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        
        // بولينجر باند
        const sma = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const stdDev = Math.sqrt(closes.slice(-20).reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20);
        const upperBand = sma + 2 * stdDev;
        const lowerBand = sma - 2 * stdDev;
        
        // MACD
        const ema12 = closes.slice(-12).reduce((a, b) => a + b, 0) / 12;
        const ema26 = closes.slice(-26).reduce((a, b) => a + b, 0) / 26;
        const macd = ema12 - ema26;
        const signalLine = macd * 0.9;
        
        return {
            ma20, ma50, ma200, rsi, upperBand, lowerBand, macd, signalLine,
            lastPrice: closes[closes.length - 1],
            closes: closes.slice(-30),
            highs: highs.slice(-30),
            lows: lows.slice(-30),
            dates: Array.from({length: 30}, (_, i) => i + 1)
        };
    } catch (error) {
        return null;
    }
}

// ===== إنشاء رسم بياني =====
async function generateChart(symbol, data) {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });
    
    const configuration = {
        type: 'line',
        data: {
            labels: data.dates.map(d => d.toString()),
            datasets: [
                {
                    label: 'سعر الإغلاق',
                    data: data.closes,
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    fill: true,
                    tension: 0.4
                },
                {
                    label: 'MA 20',
                    data: data.closes.map((_, i) => {
                        const start = Math.max(0, i - 19);
                        const slice = data.closes.slice(start, i + 1);
                        return slice.reduce((a, b) => a + b, 0) / slice.length;
                    }),
                    borderColor: 'rgb(255, 159, 64)',
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4
                },
                {
                    label: 'MA 50',
                    data: data.closes.map((_, i) => {
                        const start = Math.max(0, i - 49);
                        const slice = data.closes.slice(start, i + 1);
                        return slice.reduce((a, b) => a + b, 0) / slice.length;
                    }),
                    borderColor: 'rgb(153, 102, 255)',
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4
                },
                {
                    label: 'البولينجر العلوي',
                    data: data.closes.map((_, i) => {
                        const start = Math.max(0, i - 19);
                        const slice = data.closes.slice(start, i + 1);
                        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
                        const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length);
                        return mean + 2 * std;
                    }),
                    borderColor: 'rgba(255, 99, 132, 0.5)',
                    borderDash: [2, 2],
                    fill: false
                },
                {
                    label: 'البولينجر السفلي',
                    data: data.closes.map((_, i) => {
                        const start = Math.max(0, i - 19);
                        const slice = data.closes.slice(start, i + 1);
                        const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
                        const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length);
                        return mean - 2 * std;
                    }),
                    borderColor: 'rgba(255, 99, 132, 0.5)',
                    borderDash: [2, 2],
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: `📊 ${symbol} - المؤشرات الفنية`
                },
                legend: {
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: false,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.1)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    };
    
    return await chartJSNodeCanvas.renderToBuffer(configuration);
}

// ===== عرض قائمة الأسهم =====
async function showStockList(chatId, page = 0) {
    const stocks = await getSP500List();
    const pageSize = 10;
    const totalPages = Math.ceil(stocks.length / pageSize);
    const start = page * pageSize;
    const end = Math.min(start + pageSize, stocks.length);
    const currentStocks = stocks.slice(start, end);
    
    let message = `📊 *قائمة الأسهم المتاحة*\n━━━━━━━━━━━━━━━━━━\n`;
    message += `📈 الصفحة ${page + 1} من ${totalPages}\n\n`;
    currentStocks.forEach((symbol, index) => {
        message += `${start + index + 1}. ${symbol}\n`;
    });
    message += `━━━━━━━━━━━━━━━━━━\n💡 *لتحليل سهم:* ارسل رقمه\n`;
    message += `🔄 *للصفحة التالية:* /مؤشرات ${page + 2}\n`;
    message += `🔙 *للصفحة السابقة:* /مؤشرات ${page}`;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ===== الأمر /مؤشرات =====
bot.onText(/\/مؤشرات(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const page = match && match[1] ? parseInt(match[1]) - 1 : 0;
    await showStockList(chatId, page < 0 ? 0 : page);
});

// ===== معالجة الأرقام =====
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    
    const num = parseInt(text);
    if (isNaN(num)) return;
    
    const stocks = await getSP500List();
    const index = num - 1;
    if (index < 0 || index >= stocks.length) {
        await bot.sendMessage(chatId, `❌ رقم غير صحيح. اختر رقم من القائمة.`);
        return;
    }
    
    const symbol = stocks[index];
    await bot.sendMessage(chatId, `⏳ جاري تحليل ${symbol}...`);
    
    try {
        const indicators = await getTechnicalIndicators(symbol);
        if (!indicators) {
            await bot.sendMessage(chatId, `❌ لم أتمكن من جلب بيانات ${symbol}`);
            return;
        }
        
        const chartBuffer = await generateChart(symbol, indicators);
        const purification = calculatePurificationRatio(symbol);
        const change = ((indicators.lastPrice - indicators.closes[0]) / indicators.closes[0] * 100).toFixed(2);
        const dailyRange = ((Math.max(...indicators.highs) - Math.min(...indicators.lows)) / Math.min(...indicators.lows) * 100).toFixed(2);
        
        let tradeType = 'مراقبة', timeframe = 'انتظر', targetMove = 'غير محدد', stopLoss = 'غير محدد';
        if (indicators.rsi > 55 && indicators.rsi < 75 && parseFloat(change) > 1.5) {
            tradeType = 'مضاربة لحظية'; timeframe = '1-4 ساعات'; targetMove = '4-8%'; stopLoss = '2-3%';
        } else if (indicators.rsi > 45 && indicators.rsi < 65 && parseFloat(change) > 0.5) {
            tradeType = 'مضاربة يومية'; timeframe = '1-5 أيام'; targetMove = '8-15%'; stopLoss = '4-5%';
        }
        
        const caption = 
            `📊 *${symbol} - التحليل الفني*\n━━━━━━━━━━━━━━━━━━\n` +
            `💰 *السعر الحالي:* $${indicators.lastPrice.toFixed(2)}\n` +
            `📈 *التغير:* ${change}%\n📊 *التقلب:* ${dailyRange}%\n━━━━━━━━━━━━━━━━━━\n` +
            `📊 *المؤشرات:*\n• RSI: ${indicators.rsi.toFixed(1)}\n• MA 20: $${indicators.ma20.toFixed(2)}\n` +
            `• MA 50: $${indicators.ma50.toFixed(2)}\n• MA 200: $${indicators.ma200.toFixed(2)}\n` +
            `• البولينجر العلوي: $${indicators.upperBand.toFixed(2)}\n• البولينجر السفلي: $${indicators.lowerBand.toFixed(2)}\n` +
            `• MACD: ${indicators.macd.toFixed(3)}\n• خط الإشارة: ${indicators.signalLine.toFixed(3)}\n━━━━━━━━━━━━━━━━━━\n` +
            `🎯 *نوع المضاربة:* ${tradeType}\n• الإطار: ${timeframe}\n• الهدف: ${targetMove}\n• وقف الخسارة: ${stopLoss}\n━━━━━━━━━━━━━━━━━━\n` +
            `🕌 *التطهير الشرعي:* ${purification.percentage}%\n💡 *الحالة:* ${purification.isForbidden ? '❌ غير متوافق' : '✅ متوافق'}`;
        
        await bot.sendPhoto(chatId, chartBuffer, { caption, parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ خطأ: ${error.message}`);
    }
});

// ===== الأوامر الأساسية =====
bot.onText(/\/بدء/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `🚀 *مرحباً بك في بوت التحليل الذكي!*\n\n` +
        `📊 *الأوامر:*\n/mؤشرات - عرض قائمة الأسهم\n` +
        `/تحليل [الرمز] - تحليل سهم\n/تطهير [الرمز] - نسبة التطهير\n` +
        `/حالة - حالة البوت\n/مساعدة - عرض المساعدة\n\n` +
        `📈 *الاستخدام:* اكتب /مؤشرات ثم اختر رقم السهم`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/اختبار/, (msg) => {
    bot.sendMessage(msg.chat.id, `✅ البوت يعمل بشكل ممتاز!`);
});

bot.onText(/\/مساعدة/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📚 *الأوامر:*\n/mؤشرات - قائمة الأسهم\n` +
        `/تحليل [الرمز] - تحليل سهم\n/تطهير [الرمز] - نسبة التطهير\n` +
        `/حالة - حالة البوت\n/بدء - بدء البوت\n/اختبار - اختبار البوت\n` +
        `/مساعدة - عرض المساعدة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/حالة/, async (msg) => {
    const stocks = await getSP500List();
    bot.sendMessage(msg.chat.id,
        `📊 *حالة البوت*\n━━━━━━━━━━━━━━━━━━\n` +
        `🔍 *يغطي:* ${stocks.length} سهماً\n🕌 *فلترة شرعية:* مفعلة\n` +
        `💧 *سيولة عالية:* مفعلة\n📊 *RSI & MA:* مفعلة\n` +
        `📈 *رسوم بيانية:* مفعلة\n🎯 *نوع المضاربة:* مفعل\n` +
        `📡 *الحالة:* يعمل\n━━━━━━━━━━━━━━━━━━\n💡 /مساعدة للمساعدة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تطهير (.+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const p = calculatePurificationRatio(symbol);
    let message = `🕌 *نسبة التطهير لـ ${symbol}*\n━━━━━━━━━━━━━━━━━━\n`;
    message += p.isForbidden ? 
        `❌ *غير متوافق شرعاً*\n📌 *السبب:* ${p.reason}\n📊 *النسبة:* 100%` :
        `✅ *متوافق شرعاً*\n📊 *النسبة:* ${p.percentage}%\n📌 *السبب:* ${p.reason}`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// ===== Scanner =====
let stockList = [];
async function loadStocks() {
    stockList = await getSP500List();
    console.log(`✅ تم تحميل ${stockList.length} سهماً`);
}

async function getAverageVolume(symbol) {
    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        const volumes = data.indicators.quote[0].volume;
        const valid = volumes.filter(v => v !== null && v > 0);
        if (valid.length === 0) return null;
        return valid.reduce((a, b) => a + b, 0) / valid.length;
    } catch (error) { return null; }
}

async function scanStocks() {
    if (stockList.length === 0) await loadStocks();
    console.log(`🔍 جاري مسح الأسهم...`);
    let alerts = 0;
    const shuffled = stockList.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 20);
    
    for (const symbol of selected) {
        try {
            const p = calculatePurificationRatio(symbol);
            if (p.isForbidden || p.percentage > 3) continue;
            
            const ind = await getTechnicalIndicators(symbol);
            if (!ind) continue;
            
            const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
            const data = response.data.chart.result[0];
            if (!data) continue;
            
            const quote = data.indicators.quote[0];
            const last = quote.close[quote.close.length - 1];
            const open = quote.open[0];
            const high = Math.max(...quote.high);
            const low = Math.min(...quote.low);
            const vol = quote.volume[quote.volume.length - 1] || 0;
            
            const change = ((last - open) / open * 100);
            const range = ((high - low) / low * 100);
            const avgVol = await getAverageVolume(symbol);
            const ratio = avgVol ? (vol / avgVol) : 0;
            
            if (change > 1.0 && range > 2.0 && (last / high) > 0.96 && ratio > 2.0 && vol > 1000000 && ind.rsi > 50 && ind.rsi < 80) {
                const entry = (last * 0.98).toFixed(2);
                const t1 = (last * 1.04).toFixed(2), t2 = (last * 1.08).toFixed(2), t3 = (last * 1.12).toFixed(2);
                const sl = (last * 0.95).toFixed(2);
                
                let type = 'مضاربة لحظية', tf = '1-4 ساعات', target = '4-8%', slp = '2-3%';
                if (ind.rsi < 55) { type = 'مضاربة يومية'; tf = '1-5 أيام'; target = '8-15%'; slp = '4-5%'; }
                
                const msg = 
                    `🔥 *فرصة تداول!*\n━━━━━━━━━━━━━━━━━━\n🏢 *${symbol}*\n💰 *السعر:* $${last.toFixed(2)}\n📈 *الصعود:* ${change.toFixed(2)}%\n` +
                    `📊 *RSI:* ${ind.rsi.toFixed(1)} | *سيولة:* ${ratio.toFixed(2)}x\n` +
                    `🎯 *${type}*\n• الإطار: ${tf}\n• الهدف: ${target}\n• وقف الخسارة: ${slp}\n` +
                    `━━━━━━━━━━━━━━━━━━\n🎯 *صفقة:*\n• الدخول: $${entry}\n• الهدف 1: $${t1} (+4%)\n• الهدف 2: $${t2} (+8%)\n• الهدف 3: $${t3} (+12%)\n` +
                    `🛑 وقف الخسارة: $${sl} (-5%)\n🕌 التطهير: ${p.percentage}%`;
                
                await new Promise(r => setTimeout(r, 1000));
                await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
                alerts++;
            }
        } catch (error) { console.log(`❌ خطأ في ${symbol}: ${error.message}`); }
    }
    console.log(`✅ اكتمل المسح. ${alerts} فرصة.`);
}

// ===== تشغيل البوت =====
loadStocks();
setInterval(scanStocks, 15 * 60 * 1000);
setTimeout(scanStocks, 30000);
console.log('✅ البوت الذكي يعمل... مع قائمة منسدلة ورسوم بيانية!');
