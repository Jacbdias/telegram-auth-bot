const express = require('express');
const defaultDb = require('./database');
const passwordUtils = require('./passwords');

function createAdminRouter({ db = defaultDb, passwords = passwordUtils } = {}) {
  const router = express.Router();
  const { hashPassword, verifyPassword } = passwords;

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

codex/add-admin-user-registration-s4zf1j
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

  return router;
}

const router = createAdminRouter();

module.exports = router;
module.exports.createAdminRouter = createAdminRouter;
