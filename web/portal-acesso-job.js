// Conferência diária com o portal: quem não renovou sai dos grupos.
//
// O bot só remove alguém quando chega um evento da Hotmart. Sem evento
// (compra pela Kiwify ou Eduzz, cadastro manual, ajuste feito no admin do
// portal, evento que não chegou), a pessoa ficava nos grupos para sempre.
//
// Uma vez por dia este job manda ao portal os assinantes com Telegram
// vinculado e os planos que eles têm aqui. O portal responde, para cada um,
// quais planos já não têm acesso correspondente lá (venceu, cancelou, foi
// reembolsado). O bot remove SÓ esses planos, com a remoção por plano que já
// existe (`deactivateSubscriberByEmail(email, { plan })`).
//
// Segurança:
//   - TELEGRAM_SYNC_MODO=simular (padrão): só lista e avisa no chat de
//     alertas. Para remover de verdade: TELEGRAM_SYNC_MODO=remover.
//   - TELEGRAM_SYNC_MAX_REMOCOES (padrão 30): execução que fosse remover mais
//     planos que isto não remove nenhum e avisa. Protege contra erro em massa.
//   - Portal fora do ar ou resposta estranha: não remove ninguém.
//   - Renda Turbinada, Mentoria e Projeto Trump nunca são removidos aqui (o
//     portal não gerencia esses planos).

const crypto = require('crypto');
const defaultDb = require('./database');
const defaultLogger = require('../shared/logger');
const defaultAlerts = require('../shared/alerts');
const { createPostJson } = require('./portal-http');

const DEFAULT_URL = 'https://portal.fatosdabolsa.com.br/api/telegram/acesso';
const LOTE = 200;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Primeira passada 10 min depois do boot (o job do fim do período roda em 1).
const DEFAULT_START_DELAY_MS = 10 * 60 * 1000;
const MAX_LISTADOS_NO_ALERTA = 25;

function signBody(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret ?? '')).update(`${timestamp}.${body}`).digest('hex');
}

function splitPlans(plan) {
  return String(plan || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function modo(env) {
  return String(env.TELEGRAM_SYNC_MODO || 'simular').trim().toLowerCase() === 'remover' ? 'remover' : 'simular';
}

function maxRemocoes(env) {
  const bruto = Number.parseInt(env.TELEGRAM_SYNC_MAX_REMOCOES ?? '', 10);
  return Number.isFinite(bruto) && bruto >= 0 ? bruto : 30;
}

// O alerta usa Markdown do Telegram: escapa o que quebraria a formatação.
function md(texto) {
  return String(texto ?? '').replace(/([_*`\[])/g, '\\$1');
}

async function consultarPortal({ env, postJson, now, assinantes }) {
  const secret = env.TELEGRAM_ATENDIMENTO_SECRET;
  const url = env.PORTAL_ACESSO_URL || DEFAULT_URL;
  const body = JSON.stringify({ assinantes });
  const timestamp = Math.floor(now() / 1000).toString();

  const response = await postJson(url, {
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-fdb-timestamp': timestamp,
      'x-fdb-signature': signBody(secret, timestamp, body)
    },
    timeoutMs: 20000
  });

  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`portal_status_${response?.status ?? 0}`);
  }

  const parsed = JSON.parse(response.body || '{}');
  if (!Array.isArray(parsed.resultados)) {
    throw new Error('portal_resposta_invalida');
  }
  return parsed.resultados;
}

// Erros de convite (link antigo já usado ou expirado) não impedem a saída
// do canal: só conta o que impede tirar a pessoa do grupo.
const ESCOPOS_DE_CANAL = new Set(['channel', 'channels', 'telegram_bot_init', 'revoke']);

/**
 * Lê o retorno de `deactivateSubscriberByEmail` e diz o que aconteceu:
 *   ok        saiu do cadastro e dos canais do plano
 *   recusado  saiu do cadastro, mas o Telegram recusou (ou não havia canal)
 *   falha     o plano não foi tirado do cadastro
 */
function classificarRemocao(registro) {
  if (!registro) return { tipo: 'falha', detalhe: 'assinante não encontrado no bot' };
  if (registro.planRevoked === false) return { tipo: 'falha', detalhe: 'o plano já não estava no cadastro' };

  const contas = Array.isArray(registro.telegram) ? registro.telegram : [];
  if (contas.length === 0) return { tipo: 'recusado', detalhe: 'sem Telegram vinculado' };

  let canais = 0;
  const erros = [];
  for (const conta of contas) {
    canais += Number(conta.channels_processed) || 0;
    for (const f of conta.failures || []) {
      if (!ESCOPOS_DE_CANAL.has(f.scope)) continue;
      erros.push(f.channel ? `${f.channel}: ${f.error}` : String(f.error));
    }
  }

  if (erros.length > 0) return { tipo: 'recusado', detalhe: erros.join('; ') };
  if (canais === 0) return { tipo: 'recusado', detalhe: 'nenhum canal encontrado para o plano' };
  return { tipo: 'ok', canais };
}

function listar(itens, formatar, restante) {
  const linhas = itens.slice(0, restante.n).map(formatar);
  restante.n -= linhas.length;
  if (itens.length > linhas.length) linhas.push(`… e mais ${itens.length - linhas.length}`);
  return linhas;
}

function montarAlerta(resumo, limite) {
  const total = resumo.remocoes.length;

  if (resumo.abortado === 'ACIMA_DO_LIMITE' || resumo.modo !== 'remover') {
    const titulo =
      resumo.abortado === 'ACIMA_DO_LIMITE'
        ? `${total} remoções passam do limite de ${limite}. *Ninguém foi removido.* Confira e, se estiver certo, suba TELEGRAM\\_SYNC\\_MAX\\_REMOCOES.`
        : `Modo simular: ${total} planos seriam removidos. Para remover de verdade, TELEGRAM\\_SYNC\\_MODO=remover.`;
    const linhas = listar(resumo.remocoes, (r) => `• ${md(r.email)} → ${md(r.plano)}`, { n: MAX_LISTADOS_NO_ALERTA });
    return `${titulo}\n\n${linhas.join('\n')}`;
  }

  const restante = { n: MAX_LISTADOS_NO_ALERTA };
  const partes = [`Conferência com o portal: ${total} planos sem acesso.`];

  if (resumo.ok.length > 0) {
    const linhas = listar(
      resumo.ok,
      (r) => `• ${md(r.email)} → ${md(r.plano)} (${r.canais} ${r.canais === 1 ? 'canal' : 'canais'})`,
      restante
    );
    partes.push(`✅ *Removidos dos grupos (${resumo.ok.length})*\n${linhas.join('\n')}`);
  }
  if (resumo.recusados.length > 0) {
    const linhas = listar(resumo.recusados, (r) => `• ${md(r.email)} → ${md(r.plano)}: ${md(r.detalhe)}`, restante);
    partes.push(
      `⚠️ *Saíram do cadastro, mas o Telegram não confirmou (${resumo.recusados.length})*\nConfira e tire à mão.\n${linhas.join('\n')}`
    );
  }
  if (resumo.falhas.length > 0) {
    const linhas = listar(resumo.falhas, (r) => `• ${md(r.email)} → ${md(r.plano)}: ${md(r.error)}`, restante);
    partes.push(`❌ *Não removidos (${resumo.falhas.length})*\nO bot tenta de novo amanhã.\n${linhas.join('\n')}`);
  }

  return partes.join('\n\n');
}

async function runPortalAcessoJob({
  db = defaultDb,
  logger = defaultLogger,
  alerts = defaultAlerts,
  env = process.env,
  postJson = createPostJson({ maxResponseBytes: 2 * 1024 * 1024, defaultTimeoutMs: 20000 }),
  now = () => Date.now()
} = {}) {
  const resumo = {
    modo: modo(env),
    conferidos: 0,
    naoEncontrados: 0,
    remocoes: [],
    removidos: 0,
    ok: [],
    recusados: [],
    falhas: [],
    abortado: null
  };

  if (!env.TELEGRAM_ATENDIMENTO_SECRET) {
    resumo.abortado = 'SEM_SEGREDO';
    logger.warn('portal_acesso_job_sem_segredo', {});
    return resumo;
  }

  let assinantes;
  try {
    assinantes = await db.listTelegramLinkedSubscribers();
  } catch (error) {
    resumo.abortado = 'LISTA_FALHOU';
    logger.error('portal_acesso_job_lista_falhou', { error: error.message });
    return resumo;
  }

  // Um assinante por e-mail, com todos os planos.
  const porEmail = new Map();
  for (const a of assinantes) {
    const email = String(a.email || '').trim().toLowerCase();
    if (!email) continue;
    const planos = porEmail.get(email) || new Set();
    for (const p of splitPlans(a.plan)) planos.add(p);
    porEmail.set(email, planos);
  }
  const entradas = Array.from(porEmail, ([email, planos]) => ({ email, planos: Array.from(planos) }));
  resumo.conferidos = entradas.length;

  // Pergunta tudo ao portal ANTES de remover qualquer coisa: a trava do
  // máximo precisa do total.
  try {
    for (let i = 0; i < entradas.length; i += LOTE) {
      const lote = entradas.slice(i, i + LOTE);
      const resultados = await consultarPortal({ env, postJson, now, assinantes: lote });
      const pedidos = new Map(lote.map((e) => [e.email, new Set(e.planos)]));

      for (const r of resultados) {
        if (r?.motivo === 'NAO_ENCONTRADO') resumo.naoEncontrados++;
        const planosDoBot = pedidos.get(String(r?.email || '').toLowerCase());
        if (!planosDoBot || !Array.isArray(r.revogar)) continue;
        for (const plano of r.revogar) {
          // Só remove plano que o próprio bot mandou para aquele e-mail.
          if (planosDoBot.has(plano)) resumo.remocoes.push({ email: r.email, plano });
        }
      }
    }
  } catch (error) {
    resumo.abortado = 'PORTAL_FALHOU';
    resumo.remocoes = [];
    logger.error('portal_acesso_job_portal_falhou', { error: error.message });
    await Promise.resolve(
      alerts.send('SYNC_TELEGRAM_PORTAL', `Conferência diária com o portal falhou (${md(error.message)}). Ninguém foi removido.`, 6 * 60 * 60 * 1000)
    ).catch(() => {});
    return resumo;
  }

  const limite = maxRemocoes(env);
  if (resumo.remocoes.length > limite) {
    resumo.abortado = 'ACIMA_DO_LIMITE';
    logger.warn('portal_acesso_job_acima_do_limite', { remocoes: resumo.remocoes.length, limite });
  } else if (resumo.modo === 'remover') {
    for (const { email, plano } of resumo.remocoes) {
      let registro;
      try {
        registro = await db.deactivateSubscriberByEmail(email, { plan: plano });
      } catch (error) {
        resumo.falhas.push({ email, plano, error: error.message });
        logger.error('portal_acesso_job_remocao_falhou', { email, plano, error: error.message });
        continue;
      }

      const resultado = classificarRemocao(registro);
      if (resultado.tipo === 'falha') {
        resumo.falhas.push({ email, plano, error: resultado.detalhe });
        logger.error('portal_acesso_job_remocao_falhou', { email, plano, error: resultado.detalhe });
      } else if (resultado.tipo === 'recusado') {
        resumo.recusados.push({ email, plano, detalhe: resultado.detalhe });
        logger.warn('portal_acesso_job_telegram_recusou', { email, plano, detalhe: resultado.detalhe });
      } else {
        resumo.removidos++;
        resumo.ok.push({ email, plano, canais: resultado.canais });
        logger.info('portal_acesso_job_removido', { email, plano, canais: resultado.canais });
      }
    }
  }

  logger.info('portal_acesso_job_concluido', {
    modo: resumo.modo,
    conferidos: resumo.conferidos,
    nao_encontrados: resumo.naoEncontrados,
    remocoes: resumo.remocoes.length,
    removidos: resumo.removidos,
    recusados: resumo.recusados.length,
    falhas: resumo.falhas.length,
    abortado: resumo.abortado
  });

  if (resumo.remocoes.length > 0) {
    await Promise.resolve(alerts.send('SYNC_TELEGRAM_PORTAL', montarAlerta(resumo, limite), 0)).catch(() => {});
  }

  return resumo;
}

let jobInterval = null;
let startTimeout = null;

function startPortalAcessoJob({
  logger = defaultLogger,
  intervalMs = Number(process.env.TELEGRAM_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  startDelayMs = Number(process.env.TELEGRAM_SYNC_START_DELAY_MS || DEFAULT_START_DELAY_MS),
  run = runPortalAcessoJob
} = {}) {
  if (jobInterval) return { alreadyRunning: true };

  const tick = () => {
    run().catch((error) => logger.error('portal_acesso_job_failed', { error: error.message }));
  };

  startTimeout = setTimeout(tick, startDelayMs);
  jobInterval = setInterval(tick, intervalMs);
  logger.info('portal_acesso_job_started', { interval_ms: intervalMs, start_delay_ms: startDelayMs });
  return { alreadyRunning: false };
}

function stopPortalAcessoJob() {
  if (startTimeout) clearTimeout(startTimeout);
  if (jobInterval) clearInterval(jobInterval);
  startTimeout = null;
  jobInterval = null;
}

module.exports = { runPortalAcessoJob, startPortalAcessoJob, stopPortalAcessoJob, signBody, classificarRemocao };
