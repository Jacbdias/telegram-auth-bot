const express = require('express');
const defaultDb = require('./database');
const passwordUtils = require('./passwords');
const cache = require('../bot/cache');
const logger = require('../shared/logger');
const metricsCollector = require('../shared/metrics-collector');
const webhookQueue = require('../shared/webhook-queue');

function createAdminRouter({
  db = defaultDb,
  passwords = passwordUtils,
  loginRateLimiter = null,
  getBotPollingStatus = () => false
} = {}) {
  const router = express.Router();
  const { hashPassword, verifyPassword } = passwords;
  const supportUsername = process.env.SUPPORT_USERNAME || '@suportefatosdabolsa';
  const MAX_BROADCAST_MEDIA_SIZE = 7 * 1024 * 1024; // 7MB
  const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ]);

  // Usuários de fallback (para compatibilidade)
  const fallbackUsers = {
    admin: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',
    jacbdias: process.env.JACBDIAS_ADMIN_PASSWORD || 'suaSenhaForte123'
  };

  const parseBoolean = (value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return ['true', '1', 'yes', 'on'].includes(normalized);
    }

    return false;
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
    if (req.path === '/stats' && loginRateLimiter) {
      const sourceIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      const rate = loginRateLimiter.isAllowed(sourceIp);

      if (!rate.allowed) {
        logger.warn('rate_limit_exceeded', { scope: 'admin_login', ip: sourceIp, retry_after_seconds: rate.retryAfterSeconds });
        return res.status(429).json({ error: 'Too many requests', retry_after_seconds: rate.retryAfterSeconds });
      }
    }

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
          logger.info('admin_login', { admin_id: adminUser.id, username: adminUser.username });
          return next();
        }

        return res.status(401).json({ error: 'Credenciais inválidas' });
      }

      if (fallbackUsers[username] && fallbackUsers[username] === password) {
        const created = await ensureFallbackAdmin(username, password);
        req.user = { id: created.id, username: created.username };
        await db.touchAdminLastLogin(created.id);
        logger.info('admin_login', { admin_id: created.id, username: created.username, fallback_user: true });
        return next();
      }

      return res.status(401).json({ error: 'Credenciais inválidas' });
    } catch (error) {
      console.error('Erro na autenticação de admin:', error);
      return res.status(500).json({ error: 'Erro na autenticação' });
    }
  };

  // ============== DASHBOARD ==============

  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  };

  router.get('/bootstrap', adminAuth, async (req, res) => {
    try {
      const limit = Math.min(parsePositiveInt(req.query.limit, 200), 500);
      const page = parsePositiveInt(req.query.page, 1);
      const offset = (page - 1) * limit;

      const [stats, subscribers, channels, recentLogs] = await Promise.all([
        db.getStats(),
        db.getAllSubscribers({ limit, offset }),
        db.getAllChannels({ limit: 500 }),
        db.getAuthorizationLogs()
      ]);

      res.json({
        stats,
        subscribers,
        channels,
        recentLogs,
        pagination: { page, limit }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Estatísticas gerais
  router.get('/stats', adminAuth, async (req, res) => {
    try {
      const stats = await db.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/metrics', adminAuth, async (req, res) => {
    const cacheStats = cache.getStats();
    const payload = {
      current: {
        uptime_seconds: Math.floor(process.uptime()),
        memory_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        cache: cacheStats,
        pool: db.getPoolStats(),
        circuit_breaker: db.getCircuitBreakerState()
      },
      hourly: metricsCollector.getHourly(24),
      daily: metricsCollector.getDaily(30)
    };

    return res.json(payload);
  });

  router.get('/webhook-queue', adminAuth, (req, res) => {
    res.json(webhookQueue.getStatus());
  });

  router.post('/webhook-queue/retry', adminAuth, (req, res) => {
    const retried = webhookQueue.retryDeadLetter();
    res.json({ success: true, retried });
  });

  router.delete('/webhook-queue/dead-letter', adminAuth, (req, res) => {
    const cleared = webhookQueue.clearDeadLetter();
    res.json({ success: true, cleared });
  });

  router.delete('/webhook-queue/queued', adminAuth, (req, res) => {
    const cleared = webhookQueue.clearQueue();
    res.json({ success: true, cleared });
  });

  router.post('/webhook-queue/prune-stale', adminAuth, (req, res) => {
    const requestedMaxAge = Number(req.body?.maxAgeMs || req.query?.maxAgeMs || 0);
    const moved = webhookQueue.moveStaleToDeadLetter(
      Number.isFinite(requestedMaxAge) && requestedMaxAge > 0 ? requestedMaxAge : undefined
    );
    res.json({ success: true, moved, status: webhookQueue.getStatus() });
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
      const limit = Math.min(parsePositiveInt(req.query.limit, 200), 500);
      const page = parsePositiveInt(req.query.page, 1);
      const offset = (page - 1) * limit;
      const search = req.query.search || '';
      const subscribers = await db.getAllSubscribers({ limit, offset, search });
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
      const limit = Math.min(parsePositiveInt(req.query.limit, 500), 500);
      const channels = await db.getAllChannels({ limit });
      res.json(channels);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Criar novo canal
  router.post('/channels', adminAuth, async (req, res) => {
    try {
      const { name, chat_id, description, plan, order_index, creates_join_request } = req.body;
      const joinRequest = parseBoolean(creates_join_request);
      const result = await db.createChannel(
        name,
        chat_id,
        description,
        plan,
        order_index,
        joinRequest
      );
      cache.invalidate('channels:required');
      res.json({ success: true, channel: result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Atualizar canal
  router.put('/channels/:id', adminAuth, async (req, res) => {
    try {
      const { name, chat_id, description, plan, order_index, active, creates_join_request } = req.body;
      const joinRequest = parseBoolean(creates_join_request);
      const isActive = parseBoolean(active);
      await db.updateChannel(
        req.params.id,
        name,
        chat_id,
        description,
        plan,
        order_index,
        isActive,
        joinRequest
      );
      cache.invalidate('channels:required');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remover canal
  router.delete('/channels/:id', adminAuth, async (req, res) => {
    try {
      await db.deleteChannel(req.params.id);
      cache.invalidate('channels:required');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Enviar mensagem para canais do Telegram
  router.post('/broadcast', adminAuth, async (req, res) => {
    const { channelIds: rawChannelIds, message, parseMode, disableNotification, media } = req.body;

    const parseChannelIds = (rawValue) => {
      if (Array.isArray(rawValue)) {
        return rawValue;
      }

      if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
          const parsed = JSON.parse(rawValue);

          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch (error) {
          const parts = rawValue
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

          if (parts.length > 0) {
            return parts;
          }
        }
      }

      return [];
    };

    const channelIds = parseChannelIds(rawChannelIds);

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um canal.' });
    }

    let text = typeof message === 'string' ? message.trim() : '';
    const originalText = text;

    const sanitizeBoolean = (value) => {
      if (typeof value === 'boolean') {
        return value;
      }

      if (typeof value === 'string') {
        return value === 'true' || value === '1';
      }

      if (typeof value === 'number') {
        return value !== 0;
      }

      return false;
    };

    let mediaPayload = null;

    if (media && typeof media === 'object') {
      const { data, type, name, size } = media;

      if (!data || typeof data !== 'string') {
        return res.status(400).json({ error: 'Arquivo de imagem inválido.' });
      }

      const cleanedData = (data.includes(',') ? data.split(',').pop() : data).trim();

      if (!cleanedData) {
        return res.status(400).json({ error: 'Não foi possível processar a imagem enviada.' });
      }

      const normalizedData = cleanedData.replace(/\s+/g, '');

      let buffer;

      try {
        buffer = Buffer.from(normalizedData, 'base64');
      } catch (error) {
        return res.status(400).json({ error: 'Não foi possível processar a imagem enviada.' });
      }

      if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'Arquivo de imagem vazio.' });
      }

      if (buffer.length > MAX_BROADCAST_MEDIA_SIZE) {
        return res.status(413).json({ error: 'A imagem deve ter no máximo 7MB.' });
      }

      if (type && !ALLOWED_IMAGE_MIME_TYPES.has(type)) {
        return res.status(415).json({ error: 'Formato de imagem não suportado. Use JPG, PNG, GIF ou WEBP.' });
      }

      const numericSize =
        typeof size === 'number'
          ? size
          : (typeof size === 'string' && size.trim() ? Number(size) : null);

      if (typeof numericSize === 'number' && !Number.isNaN(numericSize) && numericSize > MAX_BROADCAST_MEDIA_SIZE) {
        return res.status(413).json({ error: 'A imagem selecionada ultrapassa o limite permitido.' });
      }

      mediaPayload = {
        buffer,
        name: typeof name === 'string' && name ? name : 'broadcast-image',
        type: typeof type === 'string' && type ? type : undefined
      };
    }

    if (!text && !mediaPayload) {
      return res.status(400).json({ error: 'Informe a mensagem que deseja enviar ou selecione uma imagem.' });
    }

    const numericIds = channelIds.map((id) => Number(id));

    if (numericIds.some((id) => Number.isNaN(id))) {
      return res.status(400).json({ error: 'Lista de canais inválida.' });
    }

    const disableNotificationFlag = sanitizeBoolean(disableNotification);

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

    const markdownV2Selected = selectedParseMode === 'MarkdownV2';

    const isMarkdownV2ParseError = (error) => {
      if (!error || typeof error !== 'object') {
        return false;
      }

      if (error.code !== 'ETELEGRAM') {
        return false;
      }

      const description =
        (error.response &&
          error.response.body &&
          typeof error.response.body.description === 'string' &&
          error.response.body.description) ||
        (typeof error.message === 'string' ? error.message : '');

      const errorCode =
        error.response &&
        error.response.body &&
        typeof error.response.body.error_code === 'number'
          ? error.response.body.error_code
          : null;

      if (errorCode !== 400) {
        return false;
      }

      return description.toLowerCase().includes('parse');
    };

    const withoutParseMode = (options) => {
      if (!options || typeof options !== 'object') {
        return {};
      }

      const clone = { ...options };
      delete clone.parse_mode;
      return clone;
    };

    const normalizeBoldForTelegramMarkdown = (value) => {
      if (!value || typeof value !== 'string') {
        return value;
      }

      return value.replace(/(?<!\\)\*\*([^*\n]+?)(?<!\\)\*\*/g, '*$1*');
    };

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

      const markdownSelected =
        selectedParseMode === 'Markdown' || selectedParseMode === 'MarkdownV2';

      if (markdownSelected && text) {
        text = normalizeBoldForTelegramMarkdown(text);
      }

      for (let index = 0; index < targets.length; index += 1) {
        const channel = targets[index];

        try {
          const channelWarnings = [];

          if (mediaPayload) {
            const captionTooLong = Boolean(text) && text.length > 1024;
            const photoOptions = { disable_notification: disableNotificationFlag };

            if (text && !captionTooLong) {
              photoOptions.caption = text;

              if (selectedParseMode) {
                photoOptions.parse_mode = selectedParseMode;
              }
            }

            const fileOptions = {};

            if (mediaPayload.name) {
              fileOptions.filename = mediaPayload.name;
            }

            if (mediaPayload.type) {
              fileOptions.contentType = mediaPayload.type;
            }

            try {
              if (Object.keys(fileOptions).length > 0) {
                await bot.sendPhoto(channel.chat_id, mediaPayload.buffer, photoOptions, fileOptions);
              } else {
                await bot.sendPhoto(channel.chat_id, mediaPayload.buffer, photoOptions);
              }
            } catch (photoError) {
              if (markdownV2Selected && isMarkdownV2ParseError(photoError)) {
                const fallbackOptions = withoutParseMode(photoOptions);

                if (markdownSelected && originalText && !captionTooLong) {
                  fallbackOptions.caption = originalText;
                }

                if (Object.keys(fileOptions).length > 0) {
                  await bot.sendPhoto(channel.chat_id, mediaPayload.buffer, fallbackOptions, fileOptions);
                } else {
                  await bot.sendPhoto(channel.chat_id, mediaPayload.buffer, fallbackOptions);
                }

                channelWarnings.push('A legenda foi enviada sem formatação Markdown V2 por conter caracteres não escapados.');
              } else {
                throw photoError;
              }
            }

            if (text && captionTooLong) {
              const messageOptions = { disable_notification: disableNotificationFlag };

              if (selectedParseMode) {
                messageOptions.parse_mode = selectedParseMode;
              }

              try {
                await bot.sendMessage(channel.chat_id, text, messageOptions);
              } catch (messageError) {
                if (markdownV2Selected && isMarkdownV2ParseError(messageError)) {
                  const fallbackMessageOptions = withoutParseMode(messageOptions);
                  await bot.sendMessage(
                    channel.chat_id,
                    markdownSelected && originalText ? originalText : text,
                    fallbackMessageOptions
                  );
                  channelWarnings.push('A mensagem complementar foi enviada sem formatação Markdown V2 por conter caracteres não escapados.');
                } else {
                  throw messageError;
                }
              }
            }
          } else if (text) {
            const options = { disable_notification: disableNotificationFlag };

            if (selectedParseMode) {
              options.parse_mode = selectedParseMode;
            }

            try {
              await bot.sendMessage(channel.chat_id, text, options);
            } catch (messageError) {
              if (markdownV2Selected && isMarkdownV2ParseError(messageError)) {
                const fallbackOptions = withoutParseMode(options);
                await bot.sendMessage(
                  channel.chat_id,
                  markdownSelected && originalText ? originalText : text,
                  fallbackOptions
                );
                channelWarnings.push('Mensagem enviada sem formatação Markdown V2 por conter caracteres não escapados.');
              } else {
                throw messageError;
              }
            }
          }

          const payload = {
            id: channel.id,
            name: channel.name,
            chat_id: channel.chat_id
          };

          if (channelWarnings.length > 0) {
            payload.warnings = channelWarnings;
          }

          sent.push(payload);
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
    const currentSubscribers = await db.getAllSubscribers({ limit: 5000, offset: 0 });
    const csvEmails = new Set(subscribers.map(s => s.email?.toLowerCase().trim()).filter(Boolean));
    const existingSubscribers = await db.getSubscribersByEmails([...csvEmails]);
    const existingByEmail = new Map(existingSubscribers.map((item) => [item.email, item]));
    
    // 2. Identifica quem deve ser removido (está no banco mas não está no CSV)
    const subscribersToRemove = currentSubscribers.filter((sub) => {
      if (!sub.email) {
        return false;
      }

      if ((sub.origin || '').toLowerCase() === 'hotmart') {
        return false;
      }

      return !csvEmails.has(sub.email.toLowerCase().trim());
    });

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
        const normalizedEmail = (sub.email || '').toLowerCase().trim();
        const existing = existingByEmail.get(normalizedEmail) || null;
        
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
          if (normalizedEmail) {
            existingByEmail.set(normalizedEmail, { email: normalizedEmail });
          }
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
      const bot = token ? new TelegramBot(token, { polling: false }) : null;

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

      let removedCount = 0;
      let errors = [];

      for (const user of inactiveUsers) {
        try {
          await db.revokeAuthorization(user.telegram_id);
          removedCount++;
        } catch (error) {
          errors.push(`Erro ao revogar ${user.telegram_id}: ${error.message}`);
          continue;
        }

        if (bot) {
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
        }
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
