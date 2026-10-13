// Atendimento automático do Fatos da Bolsa dentro do bot do Telegram.
//
// O bot continua sendo o único que fala com o Telegram: este módulo só leva a
// mensagem até a rota do portal (POST /api/telegram/atendimento) e devolve a
// resposta pronta. Tudo aqui é isolado de propósito — verificação de
// identidade, /meuscanais, chat_join_request, comandos de admin e webhook da
// Hotmart não passam por este arquivo.
//
// Regras que não podem ser quebradas:
// • ATENDIMENTO_ENABLED desligada ou ausente => nada é registrado e o bot se
//   comporta exatamente como antes deste arquivo existir.
// • Só responde em conversa privada.
// • Toda chamada ao portal tem timeout, fica em try/catch e nunca relança erro.
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
const STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MIN_CALL_INTERVAL_MS = 2000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CALLBACK_DATA_BYTES = 64;

const ATENDIMENTO_BUTTON = Object.freeze({
  text: '💬 Atendimento',
  callback_data: `${CALLBACK_PREFIX}${MENU_OPCAO_ID}`
});

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

// Estado em memória, por telegramId, com expiração de 30 minutos. Perder o
// estado num reinício só faz a conversa recomeçar do menu.
function createStateStore({ ttlMs = STATE_TTL_MS, now = Date.now } = {}) {
  const states = new Map();

  function get(telegramId) {
    const key = String(telegramId);
    const entry = states.get(key);

    if (!entry) {
      return null;
    }

    if (now() - entry.updatedAt > ttlMs) {
      states.delete(key);
      return null;
    }

    return entry;
  }

  return {
    get,
    save(telegramId, { estado = null, estadoAtualizadoEm = null } = {}) {
      states.set(String(telegramId), { estado, estadoAtualizadoEm, updatedAt: now() });
    },
    clear(telegramId) {
      states.delete(String(telegramId));
    },
    cleanup() {
      const limit = now();
      for (const [key, entry] of states.entries()) {
        if (limit - entry.updatedAt > ttlMs) {
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
  const inFlight = new Set();
  const lastCallAt = new Map();

  const cleanupInterval = enabled && startCleanup
    ? setInterval(() => state.cleanup(), STATE_CLEANUP_INTERVAL_MS)
    : null;

  if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  async function sendUnavailable(chatId) {
    try {
      await safeSendMessage(chatId, unavailableMessage, {}, 1, 'atendimento_unavailable');
    } catch (error) {
      logger.error('atendimento_send_error', {
        telegram_id: maskTelegramId(chatId),
        context: 'unavailable',
        error: error?.message
      });
    }
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

  async function callPortal(payload, { telegramId, opcaoId }) {
    const url = env?.PORTAL_ATENDIMENTO_URL || DEFAULT_PORTAL_URL;
    const secret = env?.TELEGRAM_ATENDIMENTO_SECRET || '';
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(now() / 1000).toString();
    const startedAt = Date.now();

    const logBase = { telegram_id: maskTelegramId(telegramId), opcao_id: opcaoId ?? null };

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

  async function handleTurn({ chatId, telegramId, nome, texto = null, opcaoId = null }) {
    const key = String(telegramId);

    // Toques repetidos no mesmo botão são ignorados enquanto a chamada
    // anterior não volta.
    if (inFlight.has(key)) {
      logger.info('atendimento_call_skipped', {
        telegram_id: maskTelegramId(telegramId),
        opcao_id: opcaoId,
        reason: 'in_flight'
      });
      return { ok: false, skipped: 'in_flight' };
    }

    const last = lastCallAt.get(key);

    if (last !== undefined && now() - last < MIN_CALL_INTERVAL_MS) {
      logger.info('atendimento_call_skipped', {
        telegram_id: maskTelegramId(telegramId),
        opcao_id: opcaoId,
        reason: 'rate_limited'
      });
      return { ok: false, skipped: 'rate_limited' };
    }

    inFlight.add(key);
    lastCallAt.set(key, now());

    try {
      const stored = state.get(key);
      const payload = {
        telegramId: key,
        nome: nome ? String(nome) : null,
        estado: stored?.estado ?? null,
        estadoAtualizadoEm: stored?.estadoAtualizadoEm ?? null,
        email: await resolveEmail(telegramId)
      };

      if (opcaoId !== null && opcaoId !== undefined) {
        payload.opcaoId = String(opcaoId);
      } else {
        payload.texto = String(texto ?? '');
      }

      const result = await callPortal(payload, { telegramId, opcaoId });

      if (!result.ok) {
        await sendUnavailable(chatId);
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
        opcao_id: opcaoId,
        error: error?.message
      });
      await sendUnavailable(chatId);
      return { ok: false };
    } finally {
      inFlight.delete(key);
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

  async function handleCommand(msg) {
    if (!enabled || !isPrivate(msg?.chat)) {
      return { ok: false, skipped: 'disabled_or_not_private' };
    }

    return handleTurn({
      chatId: msg.chat.id,
      telegramId: msg.chat.id,
      nome: msg?.from?.first_name,
      opcaoId: MENU_OPCAO_ID
    });
  }

  // Texto livre só entra quando a pessoa está em atendimento (estado guardado
  // há menos de 30 minutos). Sem estado ativo, segue sem resposta, como hoje.
  async function handleMessage(msg) {
    if (!enabled || !isPrivate(msg?.chat)) {
      return { ok: false, skipped: 'disabled_or_not_private' };
    }

    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';

    if (!text || text.startsWith('/')) {
      return { ok: false, skipped: 'not_free_text' };
    }

    if (!state.get(msg.chat.id)) {
      return { ok: false, skipped: 'no_active_state' };
    }

    return handleTurn({
      chatId: msg.chat.id,
      telegramId: msg.chat.id,
      nome: msg?.from?.first_name,
      texto: text
    });
  }

  async function handleCallbackQuery(query) {
    const data = String(query?.data ?? '');

    // Os outros callbacks (verify_identity e os demais) não passam por aqui.
    if (!enabled || !data.startsWith(CALLBACK_PREFIX)) {
      return { ok: false, skipped: 'not_atendimento' };
    }

    try {
      const chat = query?.message?.chat;

      if (!isPrivate(chat)) {
        return { ok: false, skipped: 'not_private' };
      }

      const opcaoId = data.slice(CALLBACK_PREFIX.length).trim() || MENU_OPCAO_ID;

      return await handleTurn({
        chatId: chat.id,
        telegramId: chat.id,
        nome: query?.from?.first_name,
        opcaoId
      });
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
  normalizeAcao,
  ATENDIMENTO_BUTTON,
  CALLBACK_PREFIX,
  MENU_OPCAO_ID,
  DEFAULT_PORTAL_URL,
  REQUEST_TIMEOUT_MS,
  STATE_TTL_MS,
  MIN_CALL_INTERVAL_MS
};
