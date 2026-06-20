const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===== التوكنات =====
const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });
const userId = '709023711';

// ===== مسار حفظ الصفقات =====
const TRADES_FILE = path.join(__dirname, 'trades.json');

// ===== تحميل الصفقات =====
function loadTrades() {
    try {
        if (fs.existsSync(TRADES_FILE)) {
            return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
        }
        return [];
    } catch (error) {
        return [];
    }
}

function saveTrades(trades) {
    try {
        fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
        return true;
    } catch (error) {
        return false;
    }
}

// ===== قائمة الأسهم =====
const watchlist = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD', 'INTC', 'NFLX'];

// ===== حساب التطهير =====
function calculatePurificationRatio(symbol) {
    const forbidden = ['BAC', 'JPM', 'C', 'WFC', 'GS', 'MS', 'V', 'MA', 'KO', 'PEP'];
    if (forbidden.includes(symbol)) {
        return { percentage: 100, isForbidden: true, reason: 'نشاط محرم' };
    }
    const rates = { 'AAPL': 0.5, 'MSFT': 0.8, 'GOOGL': 1.2, 'AMZN': 0.3, 'TSLA': 0.0, 'META': 0.5, 'NVDA': 0.2 };
    return { percentage: rates[symbol] || 0.5, isForbidden: false, reason: 'نشاط مختلط' };
}

// ===== دالة جلب المؤشرات =====
async function getIndicators(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`);
        const data = response.data.chart.result[0];
        if (!data) return null;
        const quote = data.indicators.quote[0];
        const closes = quote.close.filter(c => c !== null);
        if (closes.length < 50) return null;
        
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
        
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length - 1; i++) {
            const diff = closes[i + 1] - closes[i];
            if (diff > 0) gains += diff;
            else losses -= diff;
        }
        const rs = losses === 0 ? 100 : (gains / 14) / (losses / 14);
        const rsi = 100 - (100 / (1 + rs));
        
        // الحجم
        const volumes = quote.volume.filter(v => v !== null && v > 0);
        const avgVolume = volumes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(volumes.slice(-30).length, 30);
        const currentVolume = volumes[volumes.length - 1] || 0;
        const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
        
        return { ma20, ma50, rsi, lastPrice: closes[closes.length - 1], volumeRatio };
    } catch (error) { return null; }
}

// ===== حساب قوة الصفقة =====
function calculateTradeStrength(indicators, change) {
    if (!indicators) return { score: 0, percentage: '0%', recommendation: 'بيانات غير كافية' };
    let score = 0;
    if (indicators.rsi > 55 && indicators.rsi < 75) score += 25;
    else if (indicators.rsi > 45 && indicators.rsi < 55) score += 10;
    if (change > 1.5) score += 25;
    else if (change > 0.5) score += 10;
    if (indicators.lastPrice > indicators.ma20) score += 25;
    if (indicators.lastPrice > indicators.ma50) score += 25;
    const percentage = Math.min(score, 100);
    let recommendation = percentage >= 80 ? '🔥 قوية جداً' : percentage >= 60 ? '✅ جيدة' : percentage >= 40 ? '⚠️ متوسطة' : '❌ ضعيفة';
    return { score, percentage: percentage + '%', recommendation };
}

// ===== تسجيل صفقة =====
function registerTrade(symbol, entryPrice, exitPrice, purification) {
    const trades = loadTrades();
    const profit = ((exitPrice - entryPrice) / entryPrice * 100);
    const isProfit = profit > 0;
    const trade = {
        id: Date.now().toString(),
        symbol, entryPrice, exitPrice, profit, isProfit,
        purification, date: new Date().toISOString(), status: 'CLOSED'
    };
    trades.push(trade);
    saveTrades(trades);
    return trade;
}

// ===== التقرير الذاتي =====
function generateManagerReport(period) {
    const trades = loadTrades();
    const now = new Date();
    const days = period === 'اليوم' ? 1 : period === 'الاسبوع' ? 7 : 30;
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const filtered = trades.filter(t => new Date(t.date) >= cutoff);
    
    if (filtered.length === 0) {
        return { message: `📊 لا توجد صفقات في الفترة ${period}` };
    }
    
    const totalProfit = filtered.reduce((sum, t) => sum + t.profit, 0);
    const winCount = filtered.filter(t => t.isProfit).length;
    const lossCount = filtered.filter(t => !t.isProfit).length;
    const winRate = (winCount / filtered.length * 100);
    const avgProfit = totalProfit / filtered.length;
    const bestTrade = Math.max(...filtered.map(t => t.profit));
    const worstTrade = Math.min(...filtered.map(t => t.profit));
    
    // تحليل نقاط القوة والضعف
    let strengths = [], weaknesses = [], recommendations = [];
    if (winRate > 60) strengths.push('✅ نسبة نجاح عالية');
    if (avgProfit > 1) strengths.push('✅ متوسط ربح جيد');
    if (winCount > lossCount * 1.5) strengths.push('✅ تفوق للرابحة');
    if (winRate < 50) weaknesses.push('❌ نسبة نجاح منخفضة');
    if (worstTrade < -3) weaknesses.push('❌ خسائر كبيرة');
    if (filtered.length < 5) weaknesses.push('❌ عدد صفقات قليل');
    if (winRate < 50) recommendations.push('💡 راجع شروط الدخول');
    if (worstTrade < -3) recommendations.push('💡 شدد وقف الخسارة');
    if (avgProfit < 1 && totalProfit > 0) recommendations.push('💡 حسّن إدارة الأرباح');
    
    let message = 
        `📊 *التقرير الذاتي - ${period}*\n━━━━━━━━━━━━━━━━━━\n` +
        `📈 عدد الصفقات: ${filtered.length}\n` +
        `✅ رابحة: ${winCount}\n❌ خاسرة: ${lossCount}\n` +
        `📊 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💰 إجمالي الربح: ${totalProfit.toFixed(2)}%\n` +
        `📊 متوسط الربح: ${avgProfit.toFixed(2)}%\n` +
        `⭐ أفضل صفقة: +${bestTrade.toFixed(2)}%\n` +
        `💀 أسوأ صفقة: ${worstTrade.toFixed(2)}%\n` +
        `━━━━━━━━━━━━━━━━━━\n`;
    
    if (strengths.length > 0) {
        message += `💪 نقاط القوة:\n${strengths.join('\n')}\n━━━━━━━━━━━━━━━━━━\n`;
    }
    if (weaknesses.length > 0) {
        message += `⚠️ نقاط الضعف:\n${weaknesses.join('\n')}\n━━━━━━━━━━━━━━━━━━\n`;
    }
    if (recommendations.length > 0) {
        message += `💡 التوصيات:\n${recommendations.join('\n')}\n━━━━━━━━━━━━━━━━━━\n`;
    }
    
    message += `💡 التقييم: ${winRate > 60 ? '🌟 ممتاز' : winRate > 40 ? '⚠️ جيد' : '❌ يحتاج مراجعة'}`;
    return { message };
}

// ===== أوامر التقارير الذاتية =====
bot.onText(/\/تقرير_ذاتي (.+)/, (msg, match) => {
    const password = match[1];
    if (password !== '1411' || msg.chat.id.toString() !== userId) {
        bot.sendMessage(msg.chat.id, '⛔ غير مصرح!');
        return;
    }
    bot.sendMessage(msg.chat.id, 
        `📊 *التقارير الذاتية*\n━━━━━━━━━━━━━━━━━━\n` +
        `/تقرير_اليوم 1411 - اليوم\n` +
        `/تقرير_الاسبوع 1411 - الأسبوع\n` +
        `/تقرير_الشهر 1411 - الشهر\n` +
        `/مراجعة 1411 - مراجعة سريعة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/تقرير_اليوم (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
    const report = generateManagerReport('اليوم');
    bot.sendMessage(msg.chat.id, report.message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تقرير_الاسبوع (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
    const report = generateManagerReport('الاسبوع');
    bot.sendMessage(msg.chat.id, report.message, { parse_mode: 'Markdown' });
});

bot.onText(/\/تقرير_الشهر (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
    const report = generateManagerReport('الشهر');
    bot.sendMessage(msg.chat.id, report.message, { parse_mode: 'Markdown' });
});

// ===== مراجعة سريعة =====
bot.onText(/\/مراجعة (.+)/, (msg, match) => {
    if (match[1] !== '1411' || msg.chat.id.toString() !== userId) return;
    const trades = loadTrades();
    if (trades.length === 0) {
        bot.sendMessage(msg.chat.id, '📭 لا توجد صفقات');
        return;
    }
    const last = trades[trades.length - 1];
    const total = trades.reduce((s, t) => s + t.profit, 0);
    const winRate = (trades.filter(t => t.isProfit).length / trades.length * 100);
    bot.sendMessage(msg.chat.id,
        `📋 *مراجعة سريعة*\n━━━━━━━━━━━━━━━━━━\n` +
        `📊 آخر صفقة: ${last.symbol} (${last.profit.toFixed(2)}%)\n` +
        `💰 إجمالي الربح: ${total.toFixed(2)}%\n` +
        `📈 نسبة النجاح: ${winRate.toFixed(1)}%\n` +
        `📊 عدد الصفقات: ${trades.length}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 ${winRate > 60 ? '✅ ممتاز' : '⚠️ يحتاج تحسين'}`,
        { parse_mode: 'Markdown' }
    );
});

// ===== أمر /مؤشرات =====
bot.onText(/\/مؤشرات/, (msg) => {
    let message = `📊 *قائمة الأسهم*\n━━━━━━━━━━━━━━━━━━\n`;
    watchlist.forEach((s, i) => { message += `${i+1}. ${s}\n`; });
    message += `━━━━━━━━━━━━━━━━━━\n💡 ارسل رقم السهم للتحليل`;
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
});

// ===== معالجة الأرقام =====
bot.on('message', async (msg) => {
    const text = msg.text;
    if (!text || text.startsWith('/')) return;
    const num = parseInt(text);
    if (isNaN(num) || num < 1 || num > watchlist.length) return;
    const symbol = watchlist[num - 1];
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
        const data = response.data.chart.result[0];
        if (!data) { bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`); return; }
        const quote = data.indicators.quote[0];
        const last = quote.close[quote.close.length - 1];
        const open = quote.open[0];
        const high = Math.max(...quote.high);
        const low = Math.min(...quote.low);
        const change = ((last - open) / open * 100);
        const dailyRange = ((high - low) / low * 100);
        const ind = await getIndicators(symbol);
        if (!ind) { bot.sendMessage(msg.chat.id, `❌ بيانات غير كافية`); return; }
        const strength = calculateTradeStrength(ind, change);
        const p = calculatePurificationRatio(symbol);
        const entry = (last * 0.98).toFixed(2);
        const t1 = (last * 1.04).toFixed(2);
        const t2 = (last * 1.08).toFixed(2);
        const t3 = (last * 1.12).toFixed(2);
        const sl = (last * 0.95).toFixed(2);
        let messageText = 
            `📊 *${symbol}*\n━━━━━━━━━━━━━━━━━━\n` +
            `💰 السعر: $${last.toFixed(2)}\n📈 التغير: ${change.toFixed(2)}%\n` +
            `📊 التقلب: ${dailyRange.toFixed(2)}%\n` +
            `📊 RSI: ${ind.rsi.toFixed(1)}\n💧 السيولة: ${ind.volumeRatio.toFixed(2)}x\n` +
            `🎯 قوة الصفقة: ${strength.percentage}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🎯 الدخول: $${entry}\n🚀 الهدف 1: $${t1} (+4%)\n` +
            `🚀 الهدف 2: $${t2} (+8%)\n🚀 الهدف 3: $${t3} (+12%)\n` +
            `🛑 وقف الخسارة: $${sl} (-5%)\n━━━━━━━━━━━━━━━━━━\n` +
            `🕌 التطهير: ${p.percentage}% (${p.isForbidden ? '❌' : '✅'})\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `/تسجيل ${symbol} ${entry} ${t1}`;
        bot.sendMessage(msg.chat.id, messageText, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ خطأ: ${error.message}`);
    }
});

// ===== تسجيل صفقة =====
bot.onText(/\/تسجيل (.+?) (.+?) (.+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const entryPrice = parseFloat(match[2]);
    const exitPrice = parseFloat(match[3]);
    if (!symbol || isNaN(entryPrice) || isNaN(exitPrice)) {
        bot.sendMessage(msg.chat.id, '❌ /تسجيل [الرمز] [الدخول] [الخروج]');
        return;
    }
    const p = calculatePurificationRatio(symbol);
    const trade = registerTrade(symbol, entryPrice, exitPrice, p.percentage);
    bot.sendMessage(msg.chat.id, 
        `✅ *تم تسجيل الصفقة!*\n━━━━━━━━━━━━━━━━━━\n` +
        `📊 ${symbol}\n💰 الدخول: $${entryPrice}\n💰 الخروج: $${exitPrice}\n` +
        `📈 الربح: ${trade.profit.toFixed(2)}%\n🕌 التطهير: ${trade.purification}%`,
        { parse_mode: 'Markdown' }
    );
});

// ===== الأوامر الأساسية =====
bot.onText(/\/بدء/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `🚀 *بوت التحليل وإدارة الصفقات!*\n\n` +
        `/مؤشرات - قائمة الأسهم\n` +
        `/تسجيل [الرمز] [الدخول] [الخروج]\n` +
        `/تقرير_ذاتي 1411 - تقارير المدير\n` +
        `/مراجعة 1411 - مراجعة سريعة\n` +
        `/مساعدة - المساعدة`,
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/مساعدة/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📚 *الأوامر:*\n\n` +
        `📊 /مؤشرات - قائمة الأسهم\n` +
        `📝 /تسجيل [الرمز] [الدخول] [الخروج]\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔑 *التقارير الذاتية (برقم سري 1411):*\n` +
        `/تقرير_ذاتي 1411 - قائمة التقارير\n` +
        `/تقرير_اليوم 1411 - تقرير اليوم\n` +
        `/تقرير_الاسبوع 1411 - تقرير الأسبوع\n` +
        `/تقرير_الشهر 1411 - تقرير الشهر\n` +
        `/مراجعة 1411 - مراجعة سريعة\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🕌 /تطهير [الرمز] - نسبة التطهير`,
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

console.log('✅ البوت المتقدم يعمل...');
