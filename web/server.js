const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./database');
const { bot, validateToken, consumeToken, notifyUserAuthorized, stopBotIntervals } = require('../bot/index');
const hotmartWebhook = require('./hotmart-webhook');
const cache = require('../bot/cache');
const logger = require('../shared/logger');
const metrics = require('../shared/metrics-collector');
const alerts = require('../shared/alerts');
const RateLimiter = require('../shared/rate-limiter');
const { sanitizeEmail } = require('../shared/sanitize');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

logger.startDailyReset();

const healthRateLimiter = new RateLimiter(60 * 1000, 30);
const webhookRateLimiter = new RateLimiter(60 * 1000, 60);
const adminApiRateLimiter = new RateLimiter(60 * 1000, 120);
const adminLoginRateLimiter = new RateLimiter(60 * 1000, 10);

const getRequestIp = (req) =>
  req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

const makeRateLimitMiddleware = (limiter, scope) => (req, res, next) => {
  const ip = getRequestIp(req);
  const result = limiter.isAllowed(ip, req.path);

  if (!result.allowed) {
    logger.warn('rate_limit_exceeded', { scope, ip, retry_after_seconds: result.retryAfterSeconds });
    return res.status(429).json({ error: 'Too many requests', retry_after_seconds: result.retryAfterSeconds });
  }

  return next();
};

// CORS - Permite requisições da Vercel
const cors = require('cors');
app.use(cors({
  origin: '*',
  credentials: true
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path === '/health') {
      return;
    }

    metrics.increment('http_requests');
    if (res.statusCode >= 500) metrics.increment('http_errors');
    logger.info('http_request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start
    });
  });
  next();
});

app.get('/health', makeRateLimitMiddleware(healthRateLimiter, 'health_check'), async (req, res) => {
  const response = {
    status: 'healthy',
    uptime_seconds: Math.floor(process.uptime()),
    database: {
      connected: false,
      response_ms: null,
      pool: db.getPoolStats()
    },
    telegram_bot: {
      polling: Boolean(bot && typeof bot.isPolling === 'function' ? bot.isPolling() : false)
    },
    cache: cache.getStats(),
    circuit_breaker: db.getCircuitBreakerState(),
    version: process.env.APP_VERSION || '1.0.0'
  };

  try {
    response.database.response_ms = await db.healthCheckQuery();
    response.database.connected = true;
    return res.json(response);
  } catch (error) {
    response.status = 'unhealthy';
    response.database.error = error.message;
    return res.status(503).json(response);
  }
});

// Webhook Hotmart (usa body raw, precisa vir antes do bodyParser padrão)
app.use('/api/hotmart/webhook', makeRateLimitMiddleware(webhookRateLimiter, 'webhook_hotmart'));
app.use('/api/hotmart/webhook', hotmartWebhook);

// Middleware
app.use(bodyParser.json({ limit: '15mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Armazena tentativas de verificação (anti-fraude)
const verificationAttempts = new Map();

// Rota principal - Página de verificação
app.get('/verify', (req, res) => {
  const token = req.query.token;
  
  if (!token) {
    return res.status(400).send('Token inválido');
  }

  const tokenData = validateToken(token);
  
  if (!tokenData) {
    return res.sendFile(path.join(__dirname, 'public', 'expired.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota de verificação de dados
app.post('/api/verify', async (req, res) => {
  const { token, email, phone } = req.body;
  const sanitizedEmail = sanitizeEmail(email);
  const sanitizedPhone = typeof phone === 'string' ? phone : '';

  // Validação básica
  if (!token || !sanitizedEmail || !sanitizedPhone) {
    return res.status(400).json({ 
      success: false, 
      message: 'Preencha todos os campos obrigatórios' 
    });
  }

  // Valida formato do email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(sanitizedEmail)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Email inválido' 
    });
  }

  // Normaliza telefone removendo caracteres não numéricos
  const phoneClean = sanitizedPhone.replace(/\D/g, '');
  // Permite telefones internacionais com tamanho variável
  if (phoneClean.length < 6) {
    return res.status(400).json({
      success: false,
      message: 'Telefone inválido. Informe o número completo com DDD/DDI.'
    });
  }

  // Valida token
  const tokenData = validateToken(token);
  
  if (!tokenData) {
    return res.status(401).json({ 
      success: false, 
      message: 'Link expirado ou inválido. Solicite um novo link no bot.' 
    });
  }

  // Anti-fraude: Limita tentativas
  const attempts = verificationAttempts.get(tokenData.telegramId) || 0;
  
  if (attempts >= 5) {
    return res.status(429).json({ 
      success: false, 
      message: 'Muitas tentativas. Entre em contato com o suporte.' 
    });
  }

  try {
    // Verifica no banco de dados
    const subscriber = await db.getSubscriberByEmailAndPhone(sanitizedEmail, phoneClean);

    if (!subscriber) {
      // Incrementa tentativas
      verificationAttempts.set(tokenData.telegramId, attempts + 1);
      
      return res.status(404).json({ 
        success: false, 
        message: 'Dados não encontrados. Verifique se você é um assinante ativo.' 
      });
    }

    // Sucesso! Autoriza usuário
    await db.authorizeUser(tokenData.telegramId, subscriber);

    // Consome o token (impede reutilização)
    consumeToken(token);

    // Limpa tentativas
    verificationAttempts.delete(tokenData.telegramId);

    // Notifica usuário no Telegram
    await notifyUserAuthorized(tokenData.telegramId, subscriber);

    res.json({ 
      success: true, 
      message: 'Verificação concluída! Verifique seu Telegram.',
      plan: subscriber.plan
    });

  } catch (error) {
    console.error('Erro na verificação:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro no servidor. Tente novamente.' 
    });
  }
});

// Rota para verificar status do token (opcional)
app.get('/api/check-token', (req, res) => {
  const token = req.query.token;
  const tokenData = validateToken(token);
  
  res.json({ 
    valid: !!tokenData,
    expiresIn: tokenData ? Math.floor((tokenData.expires - Date.now()) / 1000) : 0
  });
});

// Limpa tentativas antigas a cada hora
const verificationCleanupInterval = setInterval(() => {
  verificationAttempts.clear();
}, 60 * 60 * 1000);

const healthWatchInterval = setInterval(async () => {
  const start = Date.now();
  try {
    const ms = await db.healthCheckQuery();
    if (ms > 5000) {
      alerts.send('HEALTH_DEGRADED', `Health check: banco respondeu em ${ms}ms`, 5 * 60 * 1000);
    }
  } catch (_error) {
    alerts.send('HEALTH_DEGRADED', 'Health check: banco não respondeu', 5 * 60 * 1000);
  } finally {
    metrics.recordLatency('db', Date.now() - start);
  }
}, 60 * 1000);

// Rotas administrativas
const { createAdminRouter } = require('./admin-routes');
app.use('/api/admin', makeRateLimitMiddleware(adminApiRateLimiter, 'admin_api'));
app.use('/api/admin', createAdminRouter({
  loginRateLimiter: adminLoginRateLimiter,
  getBotPollingStatus: () => Boolean(bot && typeof bot.isPolling === 'function' ? bot.isPolling() : false)
}));

const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
});

async function gracefulShutdown(signal) {
  logger.info('shutdown_initiated', { signal });

  server.close(async () => {
    try {
      if (bot && typeof bot.stopPolling === 'function') {
        await bot.stopPolling();
      }

      healthRateLimiter.stop();
      webhookRateLimiter.stop();
      adminApiRateLimiter.stop();
      adminLoginRateLimiter.stop();
      clearInterval(verificationCleanupInterval);
      clearInterval(healthWatchInterval);
      stopBotIntervals();
      if (typeof hotmartWebhook.stopWebhookRetryInterval === 'function') {
        hotmartWebhook.stopWebhookRetryInterval();
      }
      metrics.stop();
      logger.stopDailyReset();
      await db.pool.end();
      logger.info('shutdown_complete', { signal });
      process.exit(0);
    } catch (error) {
      logger.error('shutdown_error', { signal, error: error.message });
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
