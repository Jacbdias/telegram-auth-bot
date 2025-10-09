const TelegramBot = require('node-telegram-bot-api');

// Função para processar remoções em lote
async function processRemovals(subscribersToRemove, db, progressCallback) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const bot = token ? new TelegramBot(token, { polling: false }) : null;
  
  const results = {
    success: 0,
    failed: 0,
    errors: []
  };

  const BATCH_SIZE = 10; // Processa 10 por vez
  const DELAY_BETWEEN_BATCHES = 2000; // 2 segundos entre lotes

  for (let i = 0; i < subscribersToRemove.length; i += BATCH_SIZE) {
    const batch = subscribersToRemove.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (sub) => {
      try {
        // Remove do banco e dos grupos
        await db.revokeUserAccess(sub.id);
        results.success++;
        
        // Callback de progresso
        if (progressCallback) {
          progressCallback({
            current: i + results.success,
            total: subscribersToRemove.length,
            email: sub.email
          });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          email: sub.email,
          error: error.message
        });
      }
    }));

    // Delay entre lotes para respeitar rate limits
    if (i + BATCH_SIZE < subscribersToRemove.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
    }
  }

  if (bot && typeof bot.close === 'function') {
    try {
      await bot.close();
    } catch (e) {
      // Ignora erro ao fechar
    }
  }

  return results;
}

module.exports = { processRemovals };