const express = require('express');
const router = express.Router();
const db = require('./database');

// Middleware de autenticação simples
const adminAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  // Senha simples (MUDE ISSO!)
  const validPassword = 'admin123'; // SUBSTITUA por uma senha forte
  
  if (authHeader === `Bearer ${validPassword}`) {
    next();
  } else {
    res.status(401).json({ error: 'Não autorizado' });
  }
};

// ============== DASHBOARD ==============

// Estatísticas gerais
router.get('/stats', adminAuth, async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== ASSINANTES ==============

// Listar todos os assinantes
router.get('/subscribers', adminAuth, async (req, res) => {
  try {
    const subscribers = await db.getAllSubscribers();
    res.json(subscribers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar assinante por ID
router.get('/subscribers/:id', adminAuth, async (req, res) => {
  try {
    const subscriber = await db.getSubscriberById(req.params.id);
    res.json(subscriber);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar novo assinante
router.post('/subscribers', adminAuth, async (req, res) => {
  try {
    const { name, email, phone, plan } = req.body;
    const result = await db.createSubscriber(name, email, phone, plan);
    res.json({ success: true, subscriber: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar assinante
router.put('/subscribers/:id', adminAuth, async (req, res) => {
  try {
    const { name, email, phone, plan, status } = req.body;
    await db.updateSubscriber(req.params.id, name, email, phone, plan, status);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remover assinante (revoga acesso)
router.delete('/subscribers/:id', adminAuth, async (req, res) => {
  try {
    await db.revokeUserAccess(req.params.id);
    res.json({ success: true, message: 'Assinante removido e acesso revogado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== CANAIS ==============

// Listar todos os canais
router.get('/channels', adminAuth, async (req, res) => {
  try {
    const channels = await db.getAllChannels();
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Criar novo canal
router.post('/channels', adminAuth, async (req, res) => {
  try {
    const { name, chat_id, description, plan, order_index } = req.body;
    const result = await db.createChannel(name, chat_id, description, plan, order_index);
    res.json({ success: true, channel: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar canal
router.put('/channels/:id', adminAuth, async (req, res) => {
  try {
    const { name, chat_id, description, plan, order_index, active } = req.body;
    await db.updateChannel(req.params.id, name, chat_id, description, plan, order_index, active);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remover canal
router.delete('/channels/:id', adminAuth, async (req, res) => {
  try {
    await db.deleteChannel(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== LOGS ==============

// Listar logs de autorização
router.get('/logs', adminAuth, async (req, res) => {
  try {
    const logs = await db.getAuthorizationLogs();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Importação em massa de assinantes
router.post('/subscribers/import', adminAuth, async (req, res) => {
  try {
    const { subscribers } = req.body; // Array de assinantes
    
    const results = {
      success: 0,
      errors: 0,
      skipped: 0,
      details: []
    };

    for (const sub of subscribers) {
      try {
        // Valida dados mínimos
        if (!sub.name || !sub.email || !sub.phone || !sub.plan) {
          results.skipped++;
          results.details.push({
            email: sub.email || 'sem email',
            status: 'skipped',
            reason: 'Dados incompletos'
          });
          continue;
        }

        // Verifica se já existe
        const existing = await db.getSubscriberByEmail(sub.email);
        
        if (existing) {
          // Atualiza existente
          await db.updateSubscriber(
            existing.id,
            sub.name,
            sub.email,
            sub.phone,
            sub.plan,
            sub.status || 'active'
          );
          results.success++;
          results.details.push({
            email: sub.email,
            status: 'updated',
            reason: 'Atualizado'
          });
        } else {
          // Cria novo
          await db.createSubscriber(
            sub.name,
            sub.email,
            sub.phone,
            sub.plan
          );
          results.success++;
          results.details.push({
            email: sub.email,
            status: 'created',
            reason: 'Criado'
          });
        }

      } catch (error) {
        results.errors++;
        results.details.push({
          email: sub.email || 'desconhecido',
          status: 'error',
          reason: error.message
        });
      }
    }

    res.json({
      success: true,
      results
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sincronizar usuários inativos (remove dos grupos)
router.post('/sync', adminAuth, async (req, res) => {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const bot = new TelegramBot(token);

    // Pega todos os usuários inativos que ainda têm autorização
    const result = await db.pool.query(
      `SELECT au.telegram_id, s.name, s.email, s.id as subscriber_id
       FROM authorized_users au
       JOIN subscribers s ON au.subscriber_id = s.id
       WHERE s.status = 'inactive' AND au.authorized = true`
    );

    const inactiveUsers = result.rows;

    if (inactiveUsers.length === 0) {
      return res.json({
        success: true,
        message: 'Nenhum usuário inativo para remover',
        removed: 0
      });
    }

    // Remove de todos os canais
    const allChannels = await db.getAllChannels();
    let removedCount = 0;
    let errors = [];

    for (const user of inactiveUsers) {
      let removedFromChannels = 0;

      for (const channel of allChannels) {
        try {
          await bot.banChatMember(channel.chat_id, user.telegram_id);
          await bot.unbanChatMember(channel.chat_id, user.telegram_id);
          removedFromChannels++;
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          // Usuário pode já não estar no canal
        }
      }

      // Marca como desautorizado no banco
      await db.pool.query(
        'UPDATE authorized_users SET authorized = false WHERE subscriber_id = $1',
        [user.subscriber_id]
      );

      // Registra log
      await db.pool.query(
        `INSERT INTO authorization_logs (telegram_id, subscriber_id, action, timestamp)
         VALUES ($1, $2, 'revoked', NOW())`,
        [user.telegram_id, user.subscriber_id]
      );

      // Notifica usuário
      try {
        await bot.sendMessage(user.telegram_id,
          `⚠️ *Acesso Revogado*\n\n` +
          `Não encontramos uma assinatura ativa vinculada à sua conta.\n\n` +
          `Seu acesso aos canais foi removido.\n\n` +
          `Entre em contato com o suporte se precisar de ajuda.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        // Usuário bloqueou o bot
      }

      removedCount++;
    }

    res.json({
      success: true,
      message: `Sincronização concluída! ${removedCount} usuário(s) removido(s).`,
      removed: removedCount,
      errors: errors
    });

  } catch (error) {
    console.error('Erro na sincronização:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

module.exports = router;