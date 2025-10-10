const express = require('express');
const defaultDb = require('./database');
const passwordUtils = require('./passwords');

// Função auxiliar para remover usuário dos grupos do Telegram
async function removeUserFromTelegramGroups(telegramId, plan) {
  try {
    const TelegramBot = require('node-telegram-bot-api');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const bot = new TelegramBot(token);
    
    const allChannels = await defaultDb.getAllChannels();
    
    // Filtra canais do plano do usuário
    const userChannels = allChannels.filter(
      ch => ch.plan === plan || ch.plan === 'all'
    );
    
    for (const channel of userChannels) {
      try {
        await bot.banChatMember(channel.chat_id, telegramId);
        await bot.unbanChatMember(channel.chat_id, telegramId);
        console.log(`✅ Removido do canal: ${channel.name}`);
        await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
      } catch (error) {
        console.log(`⚠️ Não foi possível remover do canal ${channel.name}: ${error.message}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Erro ao remover usuário dos grupos:', error);
    return false;
  }
}

function createAdminRouter({ db = defaultDb, passwords = passwordUtils } = {}) {
  const router = express.Router();
  const { hashPassword, verifyPassword } = passwords;
  const supportUsername = process.env.SUPPORT_USERNAME || '@suportefatosdabolsa';

  // Usuários de fallback (para compatibilidade)
  const fallbackUsers = {
    admin: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
    jacbdias: process.env.JACBDIAS_ADMIN_PASSWORD || 'suaSenhaForte123'
  };

  async function ensureFallbackAdmin(username, password) {
    const existing = await db.getAdminUserByUsername(username);

    if (existing) {
      return existing;
    }

    const passwordHash = await hashPassword(password);
    return db.createAdminUser(username, passwordHash);
  }

  // Middleware de autenticação com usuário e senha
  const adminAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autorizado' });
    }

    const credentials = authHeader.replace('Bearer ', '');
    const separatorIndex = credentials.indexOf(':');

    if (separatorIndex === -1) {
      return res.status(401).json({ error: 'Formato de credenciais inválido' });
    }

    const username = credentials.slice(0, separatorIndex);
    const password = credentials.slice(separatorIndex + 1);

    try {
      const adminUser = await db.getAdminUserByUsername(username);

      if (adminUser) {
        const matches = await verifyPassword(password, adminUser.password_hash);

        if (matches) {
          req.user = { id: adminUser.id, username: adminUser.username };
          await db.touchAdminLastLogin(adminUser.id);
          return next();
        }

        return res.status(401).json({ error: 'Credenciais inválidas' });
      }

      if (fallbackUsers[username] && fallbackUsers[username] === password) {
        const created = await ensureFallbackAdmin(username, password);
        req.user = { id: created.id, username: created.username };
        await db.touchAdminLastLogin(created.id);
        return next();
      }

      return res.status(401).json({ error: 'Credenciais inválidas' });
    } catch (error) {
      console.error('Erro na autenticação de admin:', error);
      return res.status(500).json({ error: 'Erro na autenticação' });
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

  // ============== ADMIN USERS ==============

  const sanitizeAdmin = (admin) => ({
    id: admin.id,
    username: admin.username,
    created_at: admin.created_at,
    updated_at: admin.updated_at,
    last_login: admin.last_login
  });

  // Listar admins
  router.get('/admins', adminAuth, async (req, res) => {
    try {
      const admins = await db.listAdminUsers();
      res.json(admins.map(sanitizeAdmin));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Criar novo admin
  router.post('/admins', adminAuth, async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Informe usuário e senha' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres' });
      }

      const existing = await db.getAdminUserByUsername(username);

      if (existing) {
        return res.status(409).json({ error: 'Usuário já cadastrado' });
      }

      const passwordHash = await hashPassword(password);
      const admin = await db.createAdminUser(username, passwordHash);

      res.status(201).json({ success: true, admin: sanitizeAdmin(admin) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Atualizar senha do admin
  router.put('/admins/:id', adminAuth, async (req, res) => {
    try {
      const { password } = req.body;
      const { id } = req.params;

      if (!password) {
        return res.status(400).json({ error: 'Informe a nova senha' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 8 caracteres' });
      }

      const passwordHash = await hashPassword(password);
      const updated = await db.updateAdminUserPassword(id, passwordHash);

      if (!updated) {
        return res.status(404).json({ error: 'Administrador não encontrado' });
      }

      res.json({ success: true, admin: sanitizeAdmin(updated) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remover admin
  router.delete('/admins/:id', adminAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const adminId = parseInt(id, 10);

      if (Number.isNaN(adminId)) {
        return res.status(400).json({ error: 'ID inválido' });
      }

      if (req.user && req.user.id === adminId) {
        return res.status(400).json({ error: 'Você não pode remover o usuário atualmente logado' });
      }

      const totalAdmins = await db.countAdminUsers();

      if (totalAdmins <= 1) {
        return res.status(400).json({ error: 'Não é possível remover o último administrador' });
      }

      await db.deleteAdminUser(adminId);
      res.json({ success: true });
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
      const subscriberId = req.params.id;
      const subscriber = await db.getSubscriberById(subscriberId);

      if (!subscriber) {
        return res.status(404).json({ error: 'Assinante não encontrado' });
      }

      const authorizedUser = await db.getUserBySubscriberId(subscriberId);
      let removedFromChannels = 0;
      const failedChannels = [];
      let notifiedUser = false;
      let telegramRemovalSkipped = false;

      if (authorizedUser?.telegram_id) {
        const token = process.env.TELEGRAM_BOT_TOKEN;

        if (token) {
          const TelegramBot = require('node-telegram-bot-api');
          const bot = new TelegramBot(token, { polling: false });
          const channels = await db.getUserChannels(subscriber.plan);

          try {
            for (const channel of channels) {
              try {
                await bot.banChatMember(channel.chat_id, authorizedUser.telegram_id);
                await bot.unbanChatMember(channel.chat_id, authorizedUser.telegram_id);
                removedFromChannels++;
              } catch (error) {
                failedChannels.push({
                  channel: channel.name,
                  error: error.message
                });
              }

              await new Promise((resolve) => setTimeout(resolve, 500));
            }

            try {
              await bot.sendMessage(
                authorizedUser.telegram_id,
                `⚠️ Seu acesso aos canais exclusivos foi revogado. Caso haja algum engano, entre em contato com o suporte: ${supportUsername}`
              );
              notifiedUser = true;
            } catch (error) {
              // Usuário pode ter bloqueado o bot — não interrompe o fluxo
            }
          } finally {
            if (typeof bot.close === 'function') {
              try {
                await bot.close();
              } catch (closeError) {
                // Ignora erros ao encerrar o bot auxiliar
              }
            }
          }
        } else {
          telegramRemovalSkipped = true;
        }
      }

      await db.revokeUserAccess(subscriberId);

      res.json({
        success: true,
        message: 'Assinante removido e acesso revogado',
        removedFromChannels,
        failedChannels,
        notifiedUser,
        telegramRemovalSkipped
      });
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

  // Enviar mensagem para canais do Telegram
  router.post('/broadcast', adminAuth, async (req, res) => {
    const { channelIds, message, parseMode, disableNotification } = req.body;

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um canal.' });
    }

    const text = typeof message === 'string' ? message.trim() : '';

    if (!text) {
      return res.status(400).json({ error: 'Informe a mensagem que deseja enviar.' });
    }

    const numericIds = channelIds.map((id) => Number(id));

    if (numericIds.some((id) => Number.isNaN(id))) {
      return res.status(400).json({ error: 'Lista de canais inválida.' });
    }

    const allowedParseModes = ['Markdown', 'MarkdownV2', 'HTML'];
    let selectedParseMode = null;

    if (parseMode) {
      if (!allowedParseModes.includes(parseMode)) {
        return res.status(400).json({ error: 'Formato de mensagem inválido.' });
      }

      selectedParseMode = parseMode;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      return res.status(500).json({ error: 'Token do bot não configurado.' });
    }

    try {
      const channels = await db.getAllChannels();
      const channelMap = new Map(channels.map((channel) => [Number(channel.id), channel]));
      const failed = [];
      const targets = [];

      numericIds.forEach((id) => {
        const channel = channelMap.get(id);

        if (!channel) {
          failed.push({ id, reason: 'Canal não encontrado' });
          return;
        }

        if (!channel.active) {
          failed.push({
            id: channel.id,
            name: channel.name,
            chat_id: channel.chat_id,
            reason: 'Canal inativo'
          });
          return;
        }

        targets.push(channel);
      });

      if (targets.length === 0) {
        return res.status(400).json({ error: 'Nenhum canal ativo disponível para envio.' });
      }

      const TelegramBot = require('node-telegram-bot-api');
      const bot = new TelegramBot(token, { polling: false });

      const sent = [];

      for (let index = 0; index < targets.length; index += 1) {
        const channel = targets[index];

        try {
          const options = { disable_notification: Boolean(disableNotification) };

          if (selectedParseMode) {
            options.parse_mode = selectedParseMode;
          }

          await bot.sendMessage(channel.chat_id, text, options);

          sent.push({
            id: channel.id,
            name: channel.name,
            chat_id: channel.chat_id
          });
        } catch (error) {
          failed.push({
            id: channel.id,
            name: channel.name,
            chat_id: channel.chat_id,
            reason: error.message
          });
        }

        if (index < targets.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }

      if (typeof bot.close === 'function') {
        try {
          await bot.close();
        } catch (closeError) {
          console.warn('Não foi possível encerrar instância auxiliar do bot:', closeError.message);
        }
      }

      res.json({
        success: failed.length === 0,
        sent,
        failed
      });
    } catch (error) {
      console.error('Erro ao enviar mensagem para canais:', error);
      res.status(500).json({ error: 'Erro ao enviar mensagem para os canais.' });
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

// Importação em massa de assinantes com sincronização automática
router.post('/subscribers/import', adminAuth, async (req, res) => {
  try {
    const { subscribers } = req.body; // Array de assinantes do CSV

    const results = {
      success: 0,
      errors: 0,
      skipped: 0,
      removed: 0,
      details: []
    };

    // 1. Busca todos os assinantes atuais no banco
    const currentSubscribers = await db.getAllSubscribers();
    const csvEmails = new Set(subscribers.map(s => s.email?.toLowerCase().trim()).filter(Boolean));
    
    // 2. Identifica quem deve ser removido (está no banco mas não está no CSV)
    const subscribersToRemove = currentSubscribers.filter(
      sub => sub.email && !csvEmails.has(sub.email.toLowerCase().trim())
    );

    // 3. Processa o CSV (adiciona/atualiza) - SÍNCRONO
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

    // 4. Se houver remoções, processa em BACKGROUND
    if (subscribersToRemove.length > 0) {
      // Responde imediatamente ao usuário
      res.json({
        success: true,
        results,
        removalsInProgress: subscribersToRemove.length,
        message: `✅ Importação concluída! ${subscribersToRemove.length} usuário(s) sendo removido(s) em background. Isso pode levar alguns minutos.`
      });

      // Processa remoções em background (não espera terminar)
      (async () => {
        const BATCH_SIZE = 10; // Processa 10 por vez
        const DELAY_BETWEEN_BATCHES = 2000; // 2 segundos entre lotes
        
        let removedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < subscribersToRemove.length; i += BATCH_SIZE) {
          const batch = subscribersToRemove.slice(i, i + BATCH_SIZE);
          
          await Promise.all(batch.map(async (sub) => {
            try {
              await db.revokeUserAccess(sub.id);
              removedCount++;
              console.log(`✅ [${i + removedCount}/${subscribersToRemove.length}] Removido: ${sub.email}`);
            } catch (error) {
              failedCount++;
              console.error(`❌ Erro ao remover ${sub.email}:`, error.message);
            }
          }));

          // Delay entre lotes para respeitar rate limits
          if (i + BATCH_SIZE < subscribersToRemove.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
          }
        }

        console.log(`\n🎉 Processo de remoção concluído!`);
        console.log(`✅ Removidos com sucesso: ${removedCount}`);
        console.log(`❌ Falhas: ${failedCount}`);
      })().catch(error => {
        console.error('❌ Erro fatal no processo de remoção em background:', error);
      });

    } else {
      // Sem remoções, responde normalmente
      res.json({
        success: true,
        results,
        message: '✅ Importação concluída!'
      });
    }

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

  return router;
}

const router = createAdminRouter();

module.exports = router;
module.exports.createAdminRouter = createAdminRouter;
