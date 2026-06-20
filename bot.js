// ===== التقرير الذاتي للمدير (برقم سري) =====
function generateManagerReport(period) {
    const trades = loadTrades();
    const now = new Date();
    let filteredTrades = [];
    
    const periods = {
        'اليوم': 1,
        'الاسبوع': 7,
        'الشهر': 30
    };
    
    const days = periods[period] || 7;
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    
    filteredTrades = trades.filter(t => new Date(t.date) >= cutoff);
    
    if (filteredTrades.length === 0) {
        return { 
            message: `📊 لا توجد صفقات في الفترة ${period}`,
            trades: [],
            strengths: [],
            weaknesses: [],
            recommendations: []
        };
    }
    
    // ===== الإحصائيات الأساسية =====
    const totalProfit = filteredTrades.reduce((sum, t) => sum + t.profit, 0);
    const winCount = filteredTrades.filter(t => t.isProfit).length;
    const lossCount = filteredTrades.filter(t => !t.isProfit).length;
    const winRate = filteredTrades.length > 0 ? (winCount / filteredTrades.length * 100) : 0;
    const avgProfit = filteredTrades.length > 0 ? totalProfit / filteredTrades.length : 0;
    const bestTrade = filteredTrades.length > 0 ? Math.max(...filteredTrades.map(t => t.profit)) : 0;
    const worstTrade = filteredTrades.length > 0 ? Math.min(...filteredTrades.map(t => t.profit)) : 0;
    
    // ===== تحليل نقاط القوة =====
    const strengths = [];
    if (winRate > 60) strengths.push('✅ نسبة نجاح عالية (أكثر من 60%)');
    if (avgProfit > 2) strengths.push('✅ متوسط ربح ممتاز (أكثر من 2%)');
    if (winCount > lossCount * 1.5) strengths.push('✅ تفوق واضح للصفقات الرابحة');
    if (bestTrade > 5) strengths.push('✅ وجود صفقات قوية (ربح > 5%)');
    if (filteredTrades.length > 10) strengths.push('✅ عدد كافٍ من الصفقات للتحليل');
    
    // ===== تحليل نقاط الضعف =====
    const weaknesses = [];
    if (winRate < 50) weaknesses.push('❌ نسبة نجاح منخفضة (أقل من 50%)');
    if (avgProfit < 0.5 && totalProfit > 0) weaknesses.push('❌ متوسط ربح ضعيف');
    if (lossCount > winCount) weaknesses.push('❌ صفقات خاسرة أكثر من الرابحة');
    if (worstTrade < -5) weaknesses.push('❌ خسائر كبيرة (أكثر من 5%)');
    if (filteredTrades.length < 5) weaknesses.push('❌ عدد صفقات قليل للتحليل');
    if (totalProfit < 0) weaknesses.push('❌ الخسائر تفوق الأرباح');
    
    // ===== توصيات للتحسين =====
    const recommendations = [];
    if (winRate < 50) recommendations.push('💡 راجع شروط الدخول في الصفقات');
    if (avgProfit < 1) recommendations.push('💡 حسّن إدارة الأرباح والأهداف');
    if (worstTrade < -5) recommendations.push('💡 شدد وقف الخسارة لحماية رأس المال');
    if (filteredTrades.length < 5) recommendations.push('💡 زد عدد الصفقات للحصول على نتائج دقيقة');
    if (totalProfit < 0) recommendations.push('💡 أعد تقييم الاستراتيجية الحالية');
    if (lossCount > winCount && winRate > 0) recommendations.push('💡 ركز على جودة الصفقات وليس الكمية');
    
    // ===== توزيع الصفقات =====
    const profitDistribution = {
        'خسارة كبيرة (< -5%)': filteredTrades.filter(t => t.profit < -5).length,
        'خسارة صغيرة (-5% - 0%)': filteredTrades.filter(t => t.profit >= -5 && t.profit < 0).length,
        'ربح صغير (0% - 2%)': filteredTrades.filter(t => t.profit >= 0 && t.profit < 2).length,
        'ربح متوسط (2% - 5%)': filteredTrades.filter(t => t.profit >= 2 && t.profit < 5).length,
        'ربح كبير (> 5%)': filteredTrades.filter(t => t.profit >= 5).length
    };
    
    // ===== بناء التقرير =====
    let message = 
        `📊 *التقرير الذاتي للمدير - ${period}*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📈 *الإحصائيات الأساسية:*\n` +
        `• عدد الصفقات: ${filteredTrades.length}\n` +
        `• صفقات رابحة: ${winCount}\n` +
        `• صفقات خاسرة: ${lossCount}\n` +
        `• نسبة النجاح: ${winRate.toFixed(1)}%\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💰 *الأداء المالي:*\n` +
        `• إجمالي الربح: ${totalProfit.toFixed(2)}%\n` +
        `• متوسط الربح: ${avgProfit.toFixed(2)}%\n` +
        `• أفضل صفقة: +${bestTrade.toFixed(2)}%\n` +
        `• أسوأ صفقة: ${worstTrade.toFixed(2)}%\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 *توزيع الصفقات:*\n` +
        `• خسارة كبيرة: ${profitDistribution['خسارة كبيرة (< -5%)']}\n` +
        `• خسارة صغيرة: ${profitDistribution['خسارة صغيرة (-5% - 0%)']}\n` +
        `• ربح صغير: ${profitDistribution['ربح صغير (0% - 2%)']}\n` +
        `• ربح متوسط: ${profitDistribution['ربح متوسط (2% - 5%)']}\n` +
        `• ربح كبير: ${profitDistribution['ربح كبير (> 5%)']}\n` +
        `━━━━━━━━━━━━━━━━━━\n`;
    
    // ===== نقاط القوة =====
    message += `💪 *نقاط القوة:*\n`;
    if (strengths.length > 0) {
        strengths.forEach(s => message += `${s}\n`);
    } else {
        message += `• لا توجد نقاط قوة واضحة حالياً\n`;
    }
    
    // ===== نقاط الضعف =====
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `⚠️ *نقاط الضعف:*\n`;
    if (weaknesses.length > 0) {
        weaknesses.forEach(w => message += `${w}\n`);
    } else {
        message += `• لا توجد نقاط ضعف ملحوظة ✅\n`;
    }
    
    // ===== التوصيات =====
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `💡 *التوصيات والمراجعة:*\n`;
    if (recommendations.length > 0) {
        recommendations.forEach(r => message += `${r}\n`);
    } else {
        message += `• استمر على النهج الحالي ✅\n`;
    }
    
    // ===== تقييم عام =====
    message += `━━━━━━━━━━━━━━━━━━\n`;
    let overall = '';
    if (winRate > 60 && totalProfit > 5) {
        overall = '🌟 *تقييم عام: ممتاز!* استمر على النهج الحالي';
    } else if (winRate > 50 && totalProfit > 0) {
        overall = '✅ *تقييم عام: جيد* مع بعض التحسينات المطلوبة';
    } else if (winRate > 40 && totalProfit > -5) {
        overall = '⚠️ *تقييم عام: يحتاج مراجعة* إعادة تقييم الاستراتيجية';
    } else {
        overall = '❌ *تقييم عام: ضعيف* مراجعة شاملة للاستراتيجية';
    }
    message += overall;
    
    return { 
        message, 
        trades: filteredTrades,
        strengths,
        weaknesses,
        recommendations,
        overall
    };
}

// ===== أمر التقرير الذاتي (برقم سري) =====
bot.onText(/\/تقرير_ذاتي (.+)/, (msg, match) => {
    const password = match[1];
    const chatId = msg.chat.id;
    
    // التحقق من الرقم السري
    if (password !== '1411') {
        bot.sendMessage(chatId, '⛔ *رقم سري غير صحيح!* هذا التقرير خاص بالمدير فقط.', { parse_mode: 'Markdown' });
        return;
    }
    
    // التحقق من أن المستخدم هو المدير (أنت)
    if (chatId.toString() !== userId) {
        bot.sendMessage(chatId, '⛔ *غير مصرح لك!* هذا التقرير خاص بالمدير فقط.', { parse_mode: 'Markdown' });
        return;
    }
    
    const message = 
        `📊 *التقارير الذاتية المتاحة*\n━━━━━━━━━━━━━━━━━━\n` +
        `اختر نوع التقرير:\n\n` +
        `1️⃣ /تقرير_اليوم 1411 - تقرير اليوم\n` +
        `2️⃣ /تقرير_الاسبوع 1411 - تقرير الأسبوع\n` +
        `3️⃣ /تقرير_الشهر 1411 - تقرير الشهر\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔑 *الرقم السري:* 1411\n` +
        `💡 *ملاحظة:* هذا التقرير خاص بالمدير فقط`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// ===== تقرير اليوم =====
bot.onText(/\/تقرير_اليوم (.+)/, (msg, match) => {
    const password = match[1];
    const chatId = msg.chat.id;
    
    if (password !== '1411' || chatId.toString() !== userId) {
        bot.sendMessage(chatId, '⛔ *غير مصرح!* الرقم السري غير صحيح.', { parse_mode: 'Markdown' });
        return;
    }
    
    const report = generateManagerReport('اليوم');
    bot.sendMessage(chatId, report.message, { parse_mode: 'Markdown' });
});

// ===== تقرير الأسبوع =====
bot.onText(/\/تقرير_الاسبوع (.+)/, (msg, match) => {
    const password = match[1];
    const chatId = msg.chat.id;
    
    if (password !== '1411' || chatId.toString() !== userId) {
        bot.sendMessage(chatId, '⛔ *غير مصرح!* الرقم السري غير صحيح.', { parse_mode: 'Markdown' });
        return;
    }
    
    const report = generateManagerReport('الاسبوع');
    bot.sendMessage(chatId, report.message, { parse_mode: 'Markdown' });
});

// ===== تقرير الشهر =====
bot.onText(/\/تقرير_الشهر (.+)/, (msg, match) => {
    const password = match[1];
    const chatId = msg.chat.id;
    
    if (password !== '1411' || chatId.toString() !== userId) {
        bot.sendMessage(chatId, '⛔ *غير مصرح!* الرقم السري غير صحيح.', { parse_mode: 'Markdown' });
        return;
    }
    
    const report = generateManagerReport('الشهر');
    bot.sendMessage(chatId, report.message, { parse_mode: 'Markdown' });
});

// ===== أمر إضافي: مراجعة سريعة =====
bot.onText(/\/مراجعة (.+)/, (msg, match) => {
    const password = match[1];
    const chatId = msg.chat.id;
    
    if (password !== '1411' || chatId.toString() !== userId) {
        bot.sendMessage(chatId, '⛔ *غير مصرح!* الرقم السري غير صحيح.', { parse_mode: 'Markdown' });
        return;
    }
    
    const trades = loadTrades();
    if (trades.length === 0) {
        bot.sendMessage(chatId, '📭 لا توجد صفقات مسجلة للمراجعة');
        return;
    }
    
    const lastTrade = trades[trades.length - 1];
    const totalProfit = trades.reduce((sum, t) => sum + t.profit, 0);
    const winRate = (trades.filter(t => t.isProfit).length / trades.length * 100);
    
    let message = 
        `📋 *مراجعة سريعة*\n━━━━━━━━━━━━━━━━━━\n` +
        `📊 *آخر صفقة:*\n` +
        `• ${lastTrade.symbol}\n` +
        `• الربح: ${lastTrade.profit.toFixed(2)}%\n` +
        `• التاريخ: ${new Date(lastTrade.date).toLocaleDateString()}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📊 *إجمالي الأداء:*\n` +
        `• إجمالي الربح: ${totalProfit.toFixed(2)}%\n` +
        `• نسبة النجاح: ${winRate.toFixed(1)}%\n` +
        `• عدد الصفقات: ${trades.length}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💡 التوصية: ${winRate > 60 ? '✅ استمر على النهج' : '⚠️ راجع الاستراتيجية'}`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});
