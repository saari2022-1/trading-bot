const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ===== التوكنات =====
const token = '8871928848:AAGuRrN_0IFxcq0sU0JitXhCKPK_1QGNXn0';
const bot = new TelegramBot(token, { polling: true });
const userId = '709023711';

// ===== قائمة الأسهم للمراقبة =====
const watchlist = [
    'AAPL', 'TSLA', 'AMZN', 'MSFT', 'GOOGL', 
    'META', 'NFLX', 'NVDA', 'AMD', 'INTC'
];

// ===== دالة جلب متوسط الحجم =====
async function getAverageVolume(symbol) {
    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1mo`
        );
        const data = response.data.chart.result[0];
        if (!data) return null;
        
        const volumes = data.indicators.quote[0].volume;
        const validVolumes = volumes.filter(v => v !== null && v > 0);
        if (validVolumes.length === 0) return null;
        
        const avgVolume = validVolumes.reduce((a, b) => a + b, 0) / validVolumes.length;
        return avgVolume;
    } catch (error) {
        return null;
    }
}

// ===== الأمر /analyze =====
bot.onText(/\/analyze (.+)/, async (msg, match) => {
    const symbol = match[1].toUpperCase();
    await bot.sendMessage(msg.chat.id, `⏳ جاري تحليل ${symbol}...`);

    try {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
        );
        const data = response.data.chart.result[0];
        if (!data) {
            bot.sendMessage(msg.chat.id, `❌ لم أجد ${symbol}`);
            return;
        }

        const quote = data.indicators.quote[0];
        const lastPrice = quote.close[quote.close.length - 1];
        const openPrice = quote.open[0];
        const highPrice = Math.max(...quote.high);
        const lowPrice = Math.min(...quote.low);
        const change = ((lastPrice - openPrice) / openPrice * 100).toFixed(2);
        const dailyRange = ((highPrice - lowPrice) / lowPrice * 100).toFixed(2);

        const entry = (lastPrice * 0.98).toFixed(2);
        const target1 = (lastPrice * 1.04).toFixed(2);
        const target2 = (lastPrice * 1.08).toFixed(2);
        const target3 = (lastPrice * 1.12).toFixed(2);
        const stopLoss = (lastPrice * 0.95).toFixed(2);

        const message = 
            `📊 تحليل ${symbol}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💰 السعر الحالي: $${lastPrice.toFixed(2)}\n` +
            `📈 التغير: ${change}%\n` +
            `🔺 الأعلى: $${highPrice.toFixed(2)}\n` +
            `🔻 الأدنى: $${lowPrice.toFixed(2)}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🎯 نقاط الدخول:\n` +
            `• الدخول الأول: $${entry}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🚀 نقاط الخروج:\n` +
            `• الهدف الأول: $${target1} (+4%)\n` +
            `• الهدف الثاني: $${target2} (+8%)\n` +
            `• الهدف الثالث: $${target3} (+12%)\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🛑 وقف الخسارة: $${stopLoss} (-5%)\n` +
            `📊 التقلب اليومي: ${dailyRange}%`;

        bot.sendMessage(msg.chat.id, message);
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ خطأ: ${error.message}`);
    }
});

// ===== الأمر /start =====
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        `🚀 مرحباً بك في بوت التحليل الذكي!\n\n` +
        `📊 الأوامر المتاحة:\n` +
        `/analyze [الرمز] - تحليل سهم\n` +
        `/start - بدء البوت\n` +
        `/test - اختبار البوت\n` +
        `/help - المساعدة`
    );
});

// ===== الأمر /test =====
bot.onText(/\/test/, (msg) => {
    bot.sendMessage(msg.chat.id, `✅ البوت يعمل بشكل ممتاز!`);
});

// ===== الأمر /help =====
bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `📚 الأوامر المتاحة:\n\n` +
        `/analyze [الرمز] - تحليل سهم\n` +
        `مثال: /analyze AAPL\n` +
        `/start - بدء البوت\n` +
        `/test - اختبار البوت\n` +
        `/help - عرض المساعدة`
    );
});

// ===== Scanner الذكي =====
async function scanStocks() {
    console.log('🔍 جاري مسح السوق...');
    
    for (const symbol of watchlist) {
        try {
            const response = await axios.get(
                `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
            );
            
            const data = response.data.chart.result[0];
            if (!data) continue;
            
            const quote = data.indicators.quote[0];
            const lastPrice = quote.close[quote.close.length - 1];
            const openPrice = quote.open[0];
            const highPrice = Math.max(...quote.high);
            const lowPrice = Math.min(...quote.low);
            const currentVolume = quote.volume[quote.volume.length - 1] || 0;
            
            const change = ((lastPrice - openPrice) / openPrice * 100);
            const dailyRange = ((highPrice - lowPrice) / lowPrice * 100);
            
            const avgVolume = await getAverageVolume(symbol);
            const volumeRatio = avgVolume ? (currentVolume / avgVolume) : 0;
            
            const isUptrend = change > 1.0;
            const isVolatile = dailyRange > 2.0;
            const isNearHigh = (lastPrice / highPrice) > 0.97;
            const isLiquid = volumeRatio > 1.5;
            const isStrongVolume = currentVolume > 500000;
            
            if (isUptrend && isVolatile && isNearHigh && isLiquid && isStrongVolume) {
                const entry = (lastPrice * 0.98).toFixed(2);
                const target1 = (lastPrice * 1.04).toFixed(2);
                const target2 = (lastPrice * 1.08).toFixed(2);
                const target3 = (lastPrice * 1.12).toFixed(2);
                const stopLoss = (lastPrice * 0.95).toFixed(2);
                
                const alertMessage = 
                    `🔥 *فرصة تداول عالية السيولة!*\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🏢 *الشركة:* ${symbol}\n` +
                    `💰 *السعر الحالي:* $${lastPrice.toFixed(2)}\n` +
                    `📈 *الصعود:* ${change.toFixed(2)}%\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `💧 *تدفق السيولة:*\n` +
                    `• الحجم الحالي: ${(currentVolume/1000000).toFixed(2)}M\n` +
                    `• المتوسط: ${(avgVolume/1000000).toFixed(2)}M\n` +
                    `• نسبة السيولة: ${volumeRatio.toFixed(2)}x\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🎯 *صفقة مقترحة:*\n` +
                    `• الدخول: $${entry}\n` +
                    `• الهدف 1: $${target1} (+4%)\n` +
                    `• الهدف 2: $${target2} (+8%)\n` +
                    `• الهدف 3: $${target3} (+12%)\n` +
                    `🛑 وقف الخسارة: $${stopLoss} (-5%)\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📊 *التقلب:* ${dailyRange.toFixed(2)}%`;
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                await bot.sendMessage(userId, alertMessage, { parse_mode: 'Markdown' });
                console.log(`📩 تم إرسال تنبيه لـ ${symbol}`);
            }
        } catch (error) {
            console.log(`❌ خطأ في ${symbol}: ${error.message}`);
        }
    }
}

// ===== جدولة المسح =====
setInterval(scanStocks, 10 * 60 * 1000);
scanStocks();

console.log('✅ البوت الذكي يعمل...');