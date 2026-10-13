// Atendimento automático do Fatos da Bolsa dentro do bot do Telegram.
//
// O bot continua sendo o único que recebe as mensagens do Telegram: este
// módulo só leva a mensagem até a rota do portal
// (POST /api/telegram/atendimento) e entrega o que vier de volta. Quando a
// pessoa está falando com um atendente, o portal grava a mensagem, responde
// sem conteúdo e manda a resposta do atendente direto pela Bot API — por isso
// `mensagens: []` é o caso normal e não gera envio nenhum.
//
// Tudo aqui é isolado de propósito — verificação de identidade, /meuscanais,
// chat_join_request, comandos de admin e webhook da Hotmart não passam por
// este arquivo.
//
// Regras que não podem ser quebradas:
// • ATENDIMENTO_ENABLED desligada ou ausente => nada é registrado e o bot se
//   comporta exatamente como antes deste arquivo existir.
// • Só responde em conversa privada.
// • Toda chamada ao portal tem timeout, fica em try/catch e nunca relança erro.
// • Nenhuma mensagem de texto é descartada: as da mesma pessoa entram numa
//   fila e vão ao portal uma depois da outra, na ordem em que chegaram.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../shared/logger');

const DEFAULT_PORTAL_URL = 'https://portal.fatosdabolsa.com.br/api/telegram/atendimento';
const DEFAULT_SUPPORT_USERNAME = '@suportefatosdabolsa';

const CALLBACK_PREFIX = 'atd:';
const MENU_OPCAO_ID = 'menu';
const REQUEST_TIMEOUT_MS = 8000;
const STATE_TTL_MS = 30 * 60 * 1000;
// Estado "humano" é a pista de que existe conversa aberta com um atendente.
// O portal é quem decide; aqui o prazo é longo só para a pista não sumir no
// meio do atendimento.
const HUMAN_STATE = 'humano';
const HUMAN_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// Rede de segurança: ninguém mantém mais de 20 mensagens esperando.
const MAX_QUEUED_MESSAGES = 20;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CALLBACK_DATA_BYTES = 64;

const TIPO_TEXTO = 'texto';
const TIPO_NAO_SUPORTADO = 'nao_suportado';

const HANDOFF_FAILURE_MESSAGE =
  'Não consegui entregar sua mensagem agora. Tente de novo em alguns minutos.';
// Numa conversa com atendente a pessoa manda várias mensagens seguidas; o
// aviso de falha sai uma vez e só volta depois desse intervalo.
const HANDOFF_FAILURE_INTERVAL_MS = 10 * 60 * 1000;

const ATENDIMENTO_BUTTON = Object.freeze({
  text: '💬 Atendimento',
  callback_data: `${CALLBACK_PREFIX}${MENU_OPCAO_ID}`
});

// Mensagens de serviço do Telegram (o chat avisando algo, não a pessoa
// falando). Não são repassadas: não há nada para o atendente ver.
const SERVICE_MESSAGE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed',
  'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message',
  'successful_payment', 'refunded_payment', 'users_shared', 'chat_shared',
  'write_access_allowed', 'connected_website', 'passport_data',
  'proximity_alert_triggered', 'boost_added', 'chat_background_set',
  'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed',
  'forum_topic_reopened', 'general_forum_topic_hidden',
  'general_forum_topic_unhidden', 'giveaway_created', 'giveaway',
  'giveaway_winners', 'giveaway_completed', 'video_chat_scheduled',
  'video_chat_started', 'video_chat_ended', 'video_chat_participants_invited',
  'web_app_data'
];

// Aceita 'true' e '1'. Qualquer outro valor (inclusive ausente) mantém o
// atendimento desligado.
function isEnabled(env = process.env) {
  const value = String(env?.ATENDIMENTO_ENABLED ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

// Os logs nunca carregam o texto digitado nem o e-mail; o id vai mascarado.
function maskTelegramId(telegramId) {
  const raw = String(telegramId ?? '');
  return raw.length > 4 ? `***${raw.slice(-4)}` : '***';
}

// hex(HMAC_SHA256(segredo, timestamp + "." + corpo)), calculado sobre o corpo
// exatamente como ele vai ser enviado.
function signBody(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', String(secret ?? ''))
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function isHumanState(estado) {
  return String(estado ?? '').trim().toLowerCase() === HUMAN_STATE;
}

function isServiceMessage(msg) {
  return SERVICE_MESSAGE_KEYS.some((key) => msg?.[key] !== undefined);
}

function buttonLabel(button) {
  return button?.texto ?? button?.text ?? button?.label ?? button?.titulo ?? '';
}

function buttonOpcaoId(button) {
  return button?.opcaoId ?? button?.opcao_id ?? button?.opcao ?? null;
}

function toTelegramButton(button) {
  const text = String(buttonLabel(button) ?? '').trim();

  if (!text) {
    return null;
  }

  if (button?.url) {
    return { text, url: String(button.url) };
  }

  const opcaoId = buttonOpcaoId(button);

  if (opcaoId === null || opcaoId === undefined || String(opcaoId).trim() === '') {
    return null;
  }

  const callbackData = `${CALLBACK_PREFIX}${String(opcaoId).trim()}`;

  // O Telegram recusa callback_data acima de 64 bytes e derrubaria a mensagem
  // inteira; melhor perder o botão do que a resposta.
  if (Buffer.byteLength(callbackData) > MAX_CALLBACK_DATA_BYTES) {
    logger.warn('atendimento_callback_data_too_long', { bytes: Buffer.byteLength(callbackData) });
    return null;
  }

  return { text, callback_data: callbackData };
}

// Aceita tanto uma lista simples de botões (um por linha) quanto uma lista de
// linhas já montada pelo portal.
function buildInlineKeyboard(botoes) {
  if (!Array.isArray(botoes) || botoes.length === 0) {
    return null;
  }

  const rows = [];

  for (const item of botoes) {
    const row = (Array.isArray(item) ? item : [item])
      .map(toTelegramButton)
      .filter(Boolean);

    if (row.length > 0) {
      rows.push(row);
    }
  }

  return rows.length > 0 ? { inline_keyboard: rows } : null;
}

// Estado em memória, por telegramId. O prazo é de 30 minutos no atendimento
// automático e de 7 dias quando o portal devolve estado "humano".
function createStateStore({ ttlMs = STATE_TTL_MS, humanTtlMs = HUMAN_STATE_TTL_MS, now = Date.now } = {}) {
  const states = new Map();

  function expired(entry, at) {
    return at - entry.updatedAt > entry.ttlMs;
  }

  function get(telegramId) {
    const key = String(telegramId);
    const entry = states.get(key);

    if (!entry) {
      return null;
    }

    if (expired(entry, now())) {
      states.delete(key);
      return null;
    }

    return entry;
  }

  return {
    get,
    save(telegramId, { estado = null, estadoAtualizadoEm = null } = {}) {
      states.set(String(telegramId), {
        estado,
        estadoAtualizadoEm,
        updatedAt: now(),
        ttlMs: isHumanState(estado) ? humanTtlMs : ttlMs
      });
    },
    clear(telegramId) {
      states.delete(String(telegramId));
    },
    cleanup() {
      const at = now();
      for (const [key, entry] of states.entries()) {
        if (expired(entry, at)) {
          states.delete(key);
        }
      }
    },
    get size() {
      return states.size;
    }
  };
}

// POST sem dependência externa: funciona em qualquer Node >= 16 e é fácil de
// substituir nos testes.
function defaultPostJson(urlString, { body, headers, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(urlString);
    } catch (error) {
      reject(new Error('invalid_portal_url'));
      return;
    }

    const transport = url.protocol === 'http:' ? http : https;

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers
      },
      (response) => {
        let data = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('response_too_large'));
          }
        });
        response.on('end', () => resolve({ status: response.statusCode, body: data }));
      }
    );

    request.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function normalizeAcao(acao) {
  return String(acao ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

function createAtendimento({
  bot = null,
  safeSendMessage = null,
  getUser = null,
  sendUserChannels = null,
  sendVerificationPrompt = null,
  postJson = defaultPostJson,
  env = process.env,
  now = Date.now,
  startCleanup = true
} = {}) {
  const enabled = isEnabled(env);
  const supportUsername = env?.SUPPORT_USERNAME || DEFAULT_SUPPORT_USERNAME;
  const unavailableMessage =
    `O atendimento automático está indisponível agora. Fale com a gente em ${supportUsername}.`;

  const state = createStateStore({ now });
  // Uma fila por pessoa: nada roda em paralelo para o mesmo telegramId.
  const runners = new Map();
  const handoffFailureAt = new Map();

  function pruneHandoffFailures() {
    const at = now();
    for (const [key, timestamp] of handoffFailureAt.entries()) {
      if (at - timestamp >= HANDOFF_FAILURE_INTERVAL_MS) {
        handoffFailureAt.delete(key);
      }
    }
  }

  const cleanupInterval = enabled && startCleanup
    ? setInterval(() => {
      state.cleanup();
      pruneHandoffFailures();
    }, STATE_CLEANUP_INTERVAL_MS)
    : null;

  if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  // --- fila por pessoa ------------------------------------------------------

  function isBusy(key) {
    const runner = runners.get(key);
    return Boolean(runner && runner.running);
  }

  async function pump(key, runner) {
    runner.running = true;

    try {
      while (runner.items.length > 0) {
        const { job, resolve } = runner.items.shift();
        let result;

        try {
          result = await job();
        } catch (error) {
          // Rede de segurança: a fila não pode parar por causa de uma
          // mensagem, e nada daqui sobe para o handler do Telegram.
          logger.error('atendimento_queue_job_error', {
            telegram_id: maskTelegramId(key),
            error: error?.message
          });
          result = { ok: false, error: true };
        }

        resolve(result);
      }
    } finally {
      runner.running = false;

      if (runner.items.length === 0) {
        runners.delete(key);
      }
    }
  }

  // Devolve a promessa do resultado, ou null quando a fila está cheia.
  function enqueue(key, job) {
    let runner = runners.get(key);

    if (!runner) {
      runner = { items: [], running: false };
      runners.set(key, runner);
    }

    if (runner.items.length >= MAX_QUEUED_MESSAGES) {
      return null;
    }

    const pending = new Promise((resolve) => {
      runner.items.push({ job, resolve });
    });

    if (!runner.running) {
      pump(key, runner);
    }

    return pending;
  }

  // --- envio ----------------------------------------------------------------

  async function sendSafely(chatId, message, context) {
    try {
      await safeSendMessage(chatId, message, {}, 1, context);
    } catch (error) {
      logger.error('atendimento_send_error', {
        telegram_id: maskTelegramId(chatId),
        context,
        error: error?.message
      });
    }
  }

  // Na conversa com atendente o aviso de falha sai uma vez a cada 10 minutos
  // por pessoa; no atendimento automático vale a mensagem de indisponível.
  async function sendFailureNotice(chatId, telegramId, humano) {
    if (!humano) {
      await sendSafely(chatId, unavailableMessage, 'atendimento_unavailable');
      return;
    }

    const key = String(telegramId);
    const last = handoffFailureAt.get(key);

    if (last !== undefined && now() - last < HANDOFF_FAILURE_INTERVAL_MS) {
      logger.info('atendimento_handoff_failure_suppressed', { telegram_id: maskTelegramId(telegramId) });
      return;
    }

    handoffFailureAt.set(key, now());
    await sendSafely(chatId, HANDOFF_FAILURE_MESSAGE, 'atendimento_handoff_failure');
  }

  async function answerCallback(query) {
    if (!query?.id || !bot?.answerCallbackQuery) {
      return;
    }

    try {
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      // O botão só ficaria "carregando"; nada aqui pode derrubar o bot.
      logger.warn('atendimento_answer_callback_error', { error: error?.message });
    }
  }

  // E-mail só para quem está verificado e autorizado. Quem não está vai com
  // email: null.
  async function resolveEmail(telegramId) {
    if (typeof getUser !== 'function') {
      return null;
    }

    try {
      const user = await getUser(telegramId);

      if (user && user.authorized && user.email) {
        return String(user.email);
      }

      return null;
    } catch (error) {
      logger.warn('atendimento_user_lookup_error', {
        telegram_id: maskTelegramId(telegramId),
        error: error?.message
      });
      return null;
    }
  }

  async function callPortal(payload, { telegramId, opcaoId, tipo }) {
    const url = env?.PORTAL_ATENDIMENTO_URL || DEFAULT_PORTAL_URL;
    const secret = env?.TELEGRAM_ATENDIMENTO_SECRET || '';
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now() / 1000).toString();
    const startedAt = Date.now();

    const logBase = {
      telegram_id: maskTelegramId(telegramId),
      tipo: tipo ?? null,
      opcao_id: opcaoId ?? null
    };

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

      const durationMs = Date.now() - startedAt;
      const status = response?.status ?? 0;

      if (status < 200 || status >= 300) {
        logger.warn('atendimento_portal_error', { ...logBase, status, duration_ms: durationMs });
        return { ok: false };
      }

      let data = null;

      try {
        data = response.body ? JSON.parse(response.body) : null;
      } catch (error) {
        logger.warn('atendimento_portal_invalid_json', { ...logBase, status, duration_ms: durationMs });
        return { ok: false };
      }

      logger.info('atendimento_portal_call', { ...logBase, status, duration_ms: durationMs });
      return { ok: true, data };
    } catch (error) {
      logger.warn('atendimento_portal_error', {
        ...logBase,
        status: 0,
        duration_ms: Date.now() - startedAt,
        error: error?.message
      });
      return { ok: false };
    }
  }

  async function runAcao(chatId, acao, nome) {
    const normalized = normalizeAcao(acao);

    if (!normalized) {
      return;
    }

    try {
      if (normalized === 'verificar' && typeof sendVerificationPrompt === 'function') {
        await sendVerificationPrompt(chatId, nome);
        return;
      }

      if (normalized === 'meuscanais' && typeof sendUserChannels === 'function') {
        await sendUserChannels(chatId);
      }
    } catch (error) {
      logger.error('atendimento_acao_error', {
        telegram_id: maskTelegramId(chatId),
        acao: normalized,
        error: error?.message
      });
    }
  }

  // mensagens vazio é o caso normal durante a conversa com o atendente: o
  // portal gravou a mensagem e a resposta vem dele, direto pela Bot API.
  async function deliver(chatId, data, nome) {
    const mensagens = Array.isArray(data?.mensagens) ? data.mensagens : [];

    for (const mensagem of mensagens) {
      const html = String(mensagem?.html ?? mensagem?.texto ?? '').trim();

      if (!html) {
        continue;
      }

      const options = { parse_mode: 'HTML', disable_web_page_preview: true };
      const keyboard = buildInlineKeyboard(mensagem?.botoes);

      if (keyboard) {
        options.reply_markup = keyboard;
      }

      try {
        await safeSendMessage(chatId, html, options, 1, 'atendimento');
      } catch (error) {
        logger.error('atendimento_send_error', {
          telegram_id: maskTelegramId(chatId),
          context: 'mensagem',
          error: error?.message
        });
      }
    }

    await runAcao(chatId, data?.acao, nome);
  }

  async function handleTurn({
    chatId,
    telegramId,
    nome,
    texto = null,
    opcaoId = null,
    tipo = null,
    mensagemId = null
  }) {
    const key = String(telegramId);
    let storedEstado = null;

    try {
      const stored = state.get(key);
      storedEstado = stored?.estado ?? null;

      const payload = {
        telegramId: key,
        nome: nome ? String(nome) : null,
        estado: storedEstado,
        estadoAtualizadoEm: stored?.estadoAtualizadoEm ?? null,
        email: await resolveEmail(telegramId)
      };

      if (opcaoId !== null && opcaoId !== undefined) {
        payload.opcaoId = String(opcaoId);
      } else {
        // mensagemId é o message_id do Telegram: o portal usa para não gravar
        // a mesma mensagem duas vezes.
        payload.mensagemId = mensagemId ?? null;
        payload.tipo = tipo ?? TIPO_TEXTO;
        // Mensagem não suportada vai sem conteúdo, só com o tipo.
        payload.texto = payload.tipo === TIPO_TEXTO ? String(texto ?? '') : null;
      }

      const result = await callPortal(payload, { telegramId, opcaoId, tipo });

      if (!result.ok) {
        await sendFailureNotice(chatId, telegramId, isHumanState(storedEstado));
        return { ok: false };
      }

      state.save(key, {
        estado: result.data?.estado ?? null,
        estadoAtualizadoEm: result.data?.estadoAtualizadoEm ?? null
      });

      await deliver(chatId, result.data, nome);
      return { ok: true };
    } catch (error) {
      // Rede de segurança: nada daqui sobe para o handler do Telegram.
      logger.error('atendimento_turn_error', {
        telegram_id: maskTelegramId(telegramId),
        tipo: tipo ?? null,
        opcao_id: opcaoId,
        error: error?.message
      });
      await sendFailureNotice(chatId, telegramId, isHumanState(storedEstado));
      return { ok: false };
    }
  }

  function isPrivate(chat) {
    return chat?.type === 'private';
  }

  // Botão que o /start acrescenta ao teclado de hoje. Desligado, devolve lista
  // vazia e o teclado sai idêntico ao atual.
  function startButtons() {
    return enabled ? [{ ...ATENDIMENTO_BUTTON }] : [];
  }

  // Teclado para quem já está verificado (hoje a mensagem não tem teclado).
  function startKeyboard() {
    return enabled ? { inline_keyboard: [[{ ...ATENDIMENTO_BUTTON }]] } : null;
  }

  // Toda mensagem entra na fila da pessoa; nenhuma é descartada enquanto
  // couber nas 20 que podem esperar.
  function enqueueMessage(msg, { tipo, texto = null }) {
    const key = String(msg.chat.id);

    const pending = enqueue(key, () => handleTurn({
      chatId: msg.chat.id,
      telegramId: msg.chat.id,
      nome: msg?.from?.first_name,
      texto,
      tipo,
      mensagemId: msg?.message_id ?? null
    }));

    if (!pending) {
      logger.warn('atendimento_queue_full', {
        telegram_id: maskTelegramId(key),
        tipo,
        max_queued: MAX_QUEUED_MESSAGES
      });
      return Promise.resolve({ ok: false, skipped: 'queue_full' });
    }

    return pending;
  }

  async function handleCommand(msg) {
    if (!enabled || !isPrivate(msg?.chat)) {
      return { ok: false, skipped: 'disabled_or_not_private' };
    }

    const key = String(msg.chat.id);

    if (isBusy(key)) {
      logger.info('atendimento_call_skipped', {
        telegram_id: maskTelegramId(key),
        opcao_id: MENU_OPCAO_ID,
        reason: 'in_flight'
      });
      return { ok: false, skipped: 'in_flight' };
    }

    const pending = enqueue(key, () => handleTurn({
      chatId: msg.chat.id,
      telegramId: msg.chat.id,
      nome: msg?.from?.first_name,
      opcaoId: MENU_OPCAO_ID
    }));

    return pending || { ok: false, skipped: 'queue_full' };
  }

  // Texto livre no privado vai sempre ao portal, com ou sem estado guardado:
  // o estado em memória some num reinício e as mensagens de quem está falando
  // com um atendente não podem se perder por causa de um deploy. O portal é
  // quem decide se grava na conversa ou responde o atendimento automático.
  async function handleMessage(msg) {
    if (!enabled || !isPrivate(msg?.chat)) {
      return { ok: false, skipped: 'disabled_or_not_private' };
    }

    if (typeof msg?.text === 'string') {
      const text = msg.text.trim();

      if (!text) {
        return { ok: false, skipped: 'empty_text' };
      }

      // Comandos continuam com os handlers de hoje e não vão ao portal.
      if (text.startsWith('/')) {
        return { ok: false, skipped: 'command' };
      }

      return enqueueMessage(msg, { tipo: TIPO_TEXTO, texto: text });
    }

    if (isServiceMessage(msg)) {
      return { ok: false, skipped: 'service_message' };
    }

    // Foto, documento, áudio, figurinha, vídeo e afins: vão ao portal sem
    // conteúdo, só com o tipo, e o bot entrega a resposta que vier.
    return enqueueMessage(msg, { tipo: TIPO_NAO_SUPORTADO });
  }

  async function handleCallbackQuery(query) {
    const data = String(query?.data ?? '');

    // Os outros callbacks (verify_identity, meus_canais e os demais) não
    // passam por aqui.
    if (!enabled || !data.startsWith(CALLBACK_PREFIX)) {
      return { ok: false, skipped: 'not_atendimento' };
    }

    try {
      const chat = query?.message?.chat;

      if (!isPrivate(chat)) {
        return { ok: false, skipped: 'not_private' };
      }

      const key = String(chat.id);
      const opcaoId = data.slice(CALLBACK_PREFIX.length).trim() || MENU_OPCAO_ID;

      // Toque repetido continua sendo ignorado enquanto a chamada anterior
      // não volta — botão não é mensagem, não há nada para perder.
      if (isBusy(key)) {
        logger.info('atendimento_call_skipped', {
          telegram_id: maskTelegramId(key),
          opcao_id: opcaoId,
          reason: 'in_flight'
        });
        return { ok: false, skipped: 'in_flight' };
      }

      const pending = enqueue(key, () => handleTurn({
        chatId: chat.id,
        telegramId: chat.id,
        nome: query?.from?.first_name,
        opcaoId
      }));

      return (await pending) || { ok: false, skipped: 'queue_full' };
    } finally {
      // Sempre responde, mesmo quando o portal falha, para o botão não ficar
      // "carregando".
      await answerCallback(query);
    }
  }

  function stop() {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }
  }

  return {
    enabled,
    unavailableMessage,
    handoffFailureMessage: HANDOFF_FAILURE_MESSAGE,
    state,
    startButtons,
    startKeyboard,
    handleCommand,
    handleMessage,
    handleCallbackQuery,
    stop
  };
}

module.exports = {
  createAtendimento,
  createStateStore,
  buildInlineKeyboard,
  toTelegramButton,
  signBody,
  maskTelegramId,
  isEnabled,
  isHumanState,
  isServiceMessage,
  normalizeAcao,
  ATENDIMENTO_BUTTON,
  CALLBACK_PREFIX,
  MENU_OPCAO_ID,
  DEFAULT_PORTAL_URL,
  REQUEST_TIMEOUT_MS,
  STATE_TTL_MS,
  HUMAN_STATE,
  HUMAN_STATE_TTL_MS,
  HANDOFF_FAILURE_MESSAGE,
  HANDOFF_FAILURE_INTERVAL_MS,
  MAX_QUEUED_MESSAGES,
  TIPO_TEXTO,
  TIPO_NAO_SUPORTADO
};
