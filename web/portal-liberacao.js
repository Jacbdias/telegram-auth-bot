// POST /api/portal/hotmart-liberado
//
// O admin liberou no portal uma compra que a lista de bloqueados tinha
// retido (falso positivo). O portal manda o payload da Hotmart guardado e o
// bot processa o evento de novo: a consulta à lista agora responde
// "liberada" e os grupos são liberados normalmente.
//
// Assinado com TELEGRAM_ATENDIMENTO_SECRET (HMAC-SHA256 de
// `${timestamp}.${corpo}`), timestamp com no máximo 5 minutos de diferença.
// Precisa do corpo cru, por isso o router é montado antes do bodyParser.

const crypto = require('crypto');
const express = require('express');
const defaultLogger = require('../shared/logger');
const { createHotmartProcessor } = require('./hotmart-processor');
const { signBody } = require('./portal-bloqueio');

const JANELA_SEGUNDOS = 5 * 60;

function assinaturaValida(secret, timestamp, assinatura, corpoCru, agoraMs = Date.now()) {
  if (!secret || !timestamp || !assinatura) return false;
  if (!/^\d{1,10}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(assinatura)) return false;
  if (Math.abs(Math.floor(agoraMs / 1000) - Number(timestamp)) > JANELA_SEGUNDOS) return false;

  const esperada = Buffer.from(signBody(secret, timestamp, corpoCru), 'hex');
  return crypto.timingSafeEqual(Buffer.from(assinatura, 'hex'), esperada);
}

function createPortalLiberacaoRouter({
  env = process.env,
  logger = defaultLogger,
  processHotmartEvent = createHotmartProcessor().processHotmartEvent,
  now = () => Date.now()
} = {}) {
  const router = express.Router();
  router.use(express.raw({ type: '*/*', limit: '2mb' }));

  router.post('/', async (req, res) => {
    const secret = env.TELEGRAM_ATENDIMENTO_SECRET;
    if (!secret) {
      return res.status(503).json({ success: false, reason: 'SEM_SEGREDO' });
    }

    const corpoCru = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    if (!assinaturaValida(secret, req.get('x-fdb-timestamp'), req.get('x-fdb-signature'), corpoCru, now())) {
      logger.warn('portal_liberacao_recusada', { motivo: 'assinatura' });
      return res.status(401).json({ success: false, reason: 'UNAUTHORIZED' });
    }

    let payload;
    try {
      payload = JSON.parse(corpoCru);
    } catch (_error) {
      return res.status(400).json({ success: false, reason: 'JSON_INVALIDO' });
    }

    try {
      const result = await processHotmartEvent(payload);
      logger.info('portal_liberacao_processada', {
        action: result?.action || null,
        reason: result?.reason || null
      });
      if (result?.ignored) {
        return res.status(409).json({ success: false, reason: result.reason || 'IGNORADO' });
      }
      return res.json({ success: true, action: result?.action || null });
    } catch (error) {
      logger.error('portal_liberacao_erro', { error: error.message });
      return res.status(error.statusCode || 500).json({ success: false, reason: 'ERRO' });
    }
  });

  return router;
}

module.exports = { createPortalLiberacaoRouter, assinaturaValida };
