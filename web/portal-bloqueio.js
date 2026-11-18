// Consulta à lista de bloqueados do portal antes de liberar grupos.
//
// O portal mantém a lista (Admin > Lista de bloqueados): quem compra, vê o
// conteúdo e pede reembolso. Uma compra dessa pessoa fica retida no portal e
// não pode liberar os grupos do Telegram aqui. O portal responde só o que o
// bot precisa decidir:
//
//   bloqueado  compra nova não libera grupos
//   retida     a transação foi retida no portal e não liberada: o reembolso
//              dela não tira o acesso de ninguém (protege homônimo)
//   liberada   o admin liberou a transação (falso positivo)
//   disponivel o portal respondeu
//
// Chamada assinada com o mesmo segredo do atendimento
// (`TELEGRAM_ATENDIMENTO_SECRET`): HMAC-SHA256 sobre `${timestamp}.${corpo}`.
//
// Portal fora do ar: tenta de novo uma vez e depois SEGUE (não bloqueia),
// com log de erro e alerta. Uma compra legítima nunca fica sem acesso porque
// o portal oscilou.

const crypto = require('crypto');
const { createPostJson } = require('./portal-http');
const defaultLogger = require('../shared/logger');
const defaultAlerts = require('../shared/alerts');

const DEFAULT_PORTAL_BLOQUEIO_URL = 'https://portal.fatosdabolsa.com.br/api/telegram/bloqueio';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 16 * 1024;

const SEM_RESPOSTA = Object.freeze({ bloqueado: false, retida: false, liberada: false, disponivel: false });

function signBody(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret ?? '')).update(`${timestamp}.${body}`).digest('hex');
}

const defaultPostJson = createPostJson({ maxResponseBytes: MAX_RESPONSE_BYTES, defaultTimeoutMs: REQUEST_TIMEOUT_MS });

/** Dados de conferência de um payload da Hotmart. */
function extractDadosBloqueio(payload = {}, context = {}) {
  const data = payload.data || payload;
  const purchase = data.purchase || {};
  const buyer = data.buyer || data.customer || {};
  const documento = buyer.document ?? buyer.doc ?? null;

  return {
    transacao: purchase.transaction ? String(purchase.transaction) : null,
    email: context.email || null,
    telefone: context.phone || null,
    cpf: documento !== null && documento !== undefined ? String(documento) : null,
    nome: context.rawName || null
  };
}

function createConsultaBloqueio({
  env = process.env,
  postJson = defaultPostJson,
  logger = defaultLogger,
  alerts = defaultAlerts,
  tentativas = 2,
  now = () => Date.now()
} = {}) {
  let avisouSemSegredo = false;

  return async function consultarBloqueio(dados) {
    const secret = env.TELEGRAM_ATENDIMENTO_SECRET;
    if (!secret) {
      if (!avisouSemSegredo) {
        avisouSemSegredo = true;
        logger.warn('bloqueio_portal_sem_segredo', {});
      }
      return { ...SEM_RESPOSTA };
    }

    const url = env.PORTAL_BLOQUEIO_URL || DEFAULT_PORTAL_BLOQUEIO_URL;
    const body = JSON.stringify(dados || {});
    let ultimoErro = null;

    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const timestamp = Math.floor(now() / 1000).toString();
      try {
        const response = await postJson(url, {
          body,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-fdb-timestamp': timestamp,
            'x-fdb-signature': signBody(secret, timestamp, body)
          },
          timeoutMs: REQUEST_TIMEOUT_MS
        });

        if (response?.status >= 200 && response.status < 300) {
          const parsed = JSON.parse(response.body || '{}');
          return {
            bloqueado: parsed.bloqueado === true,
            retida: parsed.retida === true,
            liberada: parsed.liberada === true,
            disponivel: parsed.disponivel !== false
          };
        }
        ultimoErro = `status_${response?.status ?? 0}`;
      } catch (error) {
        ultimoErro = error?.message || 'erro';
      }
    }

    logger.error('bloqueio_portal_indisponivel', { erro: ultimoErro, transacao: dados?.transacao || null });
    Promise.resolve(
      alerts.send(
        'BLOQUEIO_PORTAL_INDISPONIVEL',
        `Lista de bloqueados do portal não respondeu (${ultimoErro}). Evento da Hotmart processado sem a conferência.`,
        10 * 60 * 1000
      )
    ).catch(() => {});
    return { ...SEM_RESPOSTA };
  };
}

module.exports = {
  createConsultaBloqueio,
  extractDadosBloqueio,
  signBody,
  DEFAULT_PORTAL_BLOQUEIO_URL,
  SEM_RESPOSTA
};
