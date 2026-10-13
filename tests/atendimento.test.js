const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createAtendimento,
  createStateStore,
  buildInlineKeyboard,
  isEnabled,
  ATENDIMENTO_BUTTON,
  MIN_CALL_INTERVAL_MS,
  STATE_TTL_MS
} = require('../bot/atendimento');

const SECRET = 'segredo-de-teste-do-atendimento';
const CLOCK_START = 1_700_000_000_000; // timestamp fixo: 1700000000
const TELEGRAM_ID = 987654321;
const VERIFY_BUTTON = { text: '🔐 Verificar Identidade', callback_data: 'verify_identity' };

// Monta um atendimento com todas as dependências falsas: nenhum teste toca no
// Telegram, no banco ou na rede.
function setup({ enabled = true, env = {}, portal = null, user = null } = {}) {
  const calls = [];
  const sends = [];
  const answered = [];
  const acoes = [];
  let clock = CLOCK_START;

  const atd = createAtendimento({
    bot: {
      answerCallbackQuery: async (id) => {
        answered.push(id);
      }
    },
    safeSendMessage: async (chatId, message, options = {}, retries, context) => {
      sends.push({ chatId, message, options, retries, context });
      return { message_id: sends.length };
    },
    getUser: async () => user,
    sendUserChannels: async (chatId) => {
      acoes.push({ acao: 'meuscanais', chatId });
    },
    sendVerificationPrompt: async (chatId, nome) => {
      acoes.push({ acao: 'verificar', chatId, nome });
    },
    postJson: async (url, options) => {
      const call = { url, ...options, payload: JSON.parse(options.body) };
      calls.push(call);

      if (typeof portal === 'function') {
        return portal(call, calls.length);
      }

      return { status: 200, body: JSON.stringify({ mensagens: [] }) };
    },
    env: {
      ...(enabled ? { ATENDIMENTO_ENABLED: 'true' } : {}),
      TELEGRAM_ATENDIMENTO_SECRET: SECRET,
      SUPPORT_USERNAME: '@suportefatosdabolsa',
      ...env
    },
    now: () => clock,
    startCleanup: false
  });

  return {
    atd,
    calls,
    sends,
    answered,
    acoes,
    advance(ms) {
      clock += ms;
    }
  };
}

function privateMessage(text, telegramId = TELEGRAM_ID) {
  return {
    chat: { id: telegramId, type: 'private' },
    from: { id: telegramId, first_name: 'Davi' },
    text
  };
}

function callbackQuery(data, chatType = 'private', telegramId = TELEGRAM_ID) {
  return {
    id: 'cb-1',
    data,
    from: { id: telegramId, first_name: 'Davi' },
    message: { chat: { id: telegramId, type: chatType } }
  };
}

function okResponse(body) {
  return { status: 200, body: JSON.stringify(body) };
}

// --- chave de liga e desliga ------------------------------------------------

test('isEnabled só liga com true/1', () => {
  assert.equal(isEnabled({}), false);
  assert.equal(isEnabled({ ATENDIMENTO_ENABLED: 'false' }), false);
  assert.equal(isEnabled({ ATENDIMENTO_ENABLED: '' }), false);
  assert.equal(isEnabled({ ATENDIMENTO_ENABLED: 'true' }), true);
  assert.equal(isEnabled({ ATENDIMENTO_ENABLED: 'TRUE' }), true);
  assert.equal(isEnabled({ ATENDIMENTO_ENABLED: '1' }), true);
});

test('chave desligada: /start sem botão e texto livre sem chamar o portal', async () => {
  const h = setup({ enabled: false });

  assert.equal(h.atd.enabled, false);

  // bot/index.js monta o teclado do /start exatamente assim.
  const keyboardNaoVerificado = { inline_keyboard: [[VERIFY_BUTTON, ...h.atd.startButtons()]] };
  assert.deepEqual(keyboardNaoVerificado, { inline_keyboard: [[VERIFY_BUTTON]] });

  // E quem já está verificado continua recebendo a mensagem sem teclado.
  assert.equal(h.atd.startKeyboard(), null);

  // Estado ativo não muda nada: desligado, ninguém chama o portal.
  h.atd.state.save(TELEGRAM_ID, { estado: 'menu' });

  await h.atd.handleMessage(privateMessage('quero ver minha assinatura'));
  await h.atd.handleCommand(privateMessage('/atendimento'));
  await h.atd.handleCallbackQuery(callbackQuery('atd:menu'));

  assert.equal(h.calls.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal(h.answered.length, 0);
});

test('chave ligada: o botão de atendimento entra no /start', () => {
  const h = setup();

  assert.deepEqual(h.atd.startButtons(), [{ text: '💬 Atendimento', callback_data: 'atd:menu' }]);
  assert.deepEqual(h.atd.startKeyboard(), { inline_keyboard: [[ATENDIMENTO_BUTTON]] });
  assert.deepEqual({ inline_keyboard: [[VERIFY_BUTTON, ...h.atd.startButtons()]] }, {
    inline_keyboard: [[VERIFY_BUTTON, { text: '💬 Atendimento', callback_data: 'atd:menu' }]]
  });
});

// --- assinatura HMAC --------------------------------------------------------

test('assinatura: o HMAC enviado bate com o corpo enviado', async () => {
  const h = setup();

  await h.atd.handleCommand(privateMessage('/atendimento'));

  assert.equal(h.calls.length, 1);
  const call = h.calls[0];

  assert.equal(call.url, 'https://portal.fatosdabolsa.com.br/api/telegram/atendimento');
  assert.equal(call.timeoutMs, 8000);
  assert.equal(call.headers['x-fdb-timestamp'], '1700000000');

  // Recalculado aqui, sem usar o código do bot, sobre o corpo exato enviado.
  const esperado = crypto
    .createHmac('sha256', SECRET)
    .update(`1700000000.${call.body}`)
    .digest('hex');

  assert.equal(call.headers['x-fdb-signature'], esperado);
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.payload.opcaoId, 'menu');
  assert.equal(call.payload.telegramId, String(TELEGRAM_ID));
  assert.equal(call.payload.nome, 'Davi');
});

test('URL do portal vem de PORTAL_ATENDIMENTO_URL quando configurada', async () => {
  const h = setup({ env: { PORTAL_ATENDIMENTO_URL: 'https://staging.exemplo.com/api/telegram/atendimento' } });

  await h.atd.handleCommand(privateMessage('/atendimento'));

  assert.equal(h.calls[0].url, 'https://staging.exemplo.com/api/telegram/atendimento');
});

// --- e-mail -----------------------------------------------------------------

test('e-mail: verificado manda o e-mail do assinante', async () => {
  const h = setup({ user: { authorized: true, email: 'assinante@email.com', plan: 'Projeto Trump' } });

  await h.atd.handleCommand(privateMessage('/atendimento'));

  assert.equal(h.calls[0].payload.email, 'assinante@email.com');
});

test('e-mail: não verificado manda null', async () => {
  const semUsuario = setup({ user: null });
  await semUsuario.atd.handleCommand(privateMessage('/atendimento'));
  assert.equal(semUsuario.calls[0].payload.email, null);

  // Usuário no banco mas com autorização revogada também vai sem e-mail.
  const revogado = setup({ user: { authorized: false, email: 'antigo@email.com' } });
  await revogado.atd.handleCommand(privateMessage('/atendimento'));
  assert.equal(revogado.calls[0].payload.email, null);
});

// --- falha do portal --------------------------------------------------------

for (const cenario of [
  { nome: 'timeout', portal: () => { throw new Error('timeout'); } },
  { nome: '500', portal: () => ({ status: 500, body: 'erro interno' }) },
  { nome: '401', portal: () => ({ status: 401, body: '{"error":"invalid signature"}' }) },
  { nome: 'json inválido', portal: () => ({ status: 200, body: 'não é json' }) }
]) {
  test(`falha do portal (${cenario.nome}): avisa indisponível e responde o callback`, async () => {
    const h = setup({ portal: cenario.portal });

    const resultado = await h.atd.handleCallbackQuery(callbackQuery('atd:status'));

    assert.equal(resultado.ok, false);
    assert.equal(h.sends.length, 1);
    assert.equal(
      h.sends[0].message,
      'O atendimento automático está indisponível agora. Fale com a gente em @suportefatosdabolsa.'
    );
    // O botão não pode ficar "carregando" nem quando o portal falha.
    assert.deepEqual(h.answered, ['cb-1']);
  });
}

test('falha do portal no texto livre não derruba nada e mantém o estado', async () => {
  const h = setup({ portal: () => { throw new Error('socket hang up'); } });
  h.atd.state.save(TELEGRAM_ID, { estado: 'aguardando_texto', estadoAtualizadoEm: '2026-10-13T00:00:00.000Z' });

  const resultado = await h.atd.handleMessage(privateMessage('acabei de comprar'));

  assert.equal(resultado.ok, false);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].message, /indisponível agora/);
  assert.equal(h.atd.state.get(TELEGRAM_ID).estado, 'aguardando_texto');
});

// --- entrega das mensagens --------------------------------------------------

test('mensagens saem em HTML, sem preview, e os botões viram inline_keyboard', async () => {
  const h = setup({
    portal: () => okResponse({
      mensagens: [
        {
          html: 'Escolha uma opção:',
          botoes: [
            { texto: 'Status da assinatura', opcaoId: 'status' },
            { texto: 'Abrir o portal', url: 'https://portal.fatosdabolsa.com.br/login' }
          ]
        },
        { html: 'Segunda mensagem, sem botões.' }
      ],
      estado: 'menu',
      estadoAtualizadoEm: '2026-10-13T12:00:00.000Z'
    })
  });

  await h.atd.handleCallbackQuery(callbackQuery('atd:menu'));

  assert.equal(h.sends.length, 2);

  const primeira = h.sends[0];
  assert.equal(primeira.chatId, TELEGRAM_ID);
  assert.equal(primeira.message, 'Escolha uma opção:');
  assert.equal(primeira.options.parse_mode, 'HTML');
  assert.equal(primeira.options.disable_web_page_preview, true);
  assert.deepEqual(primeira.options.reply_markup, {
    inline_keyboard: [
      [{ text: 'Status da assinatura', callback_data: 'atd:status' }],
      [{ text: 'Abrir o portal', url: 'https://portal.fatosdabolsa.com.br/login' }]
    ]
  });

  assert.equal(h.sends[1].options.reply_markup, undefined);

  // O estado devolvido pelo portal volta na chamada seguinte.
  const guardado = h.atd.state.get(TELEGRAM_ID);
  assert.equal(guardado.estado, 'menu');
  assert.equal(guardado.estadoAtualizadoEm, '2026-10-13T12:00:00.000Z');

  h.advance(MIN_CALL_INTERVAL_MS);
  await h.atd.handleMessage(privateMessage('quero renovar'));

  assert.equal(h.calls[1].payload.estado, 'menu');
  assert.equal(h.calls[1].payload.estadoAtualizadoEm, '2026-10-13T12:00:00.000Z');
  assert.equal(h.calls[1].payload.texto, 'quero renovar');
  assert.equal(h.calls[1].payload.opcaoId, undefined);
});

test('buildInlineKeyboard: opcaoId vira atd:<id>, url vira link e botão inválido é descartado', () => {
  assert.equal(buildInlineKeyboard(null), null);
  assert.equal(buildInlineKeyboard([]), null);
  assert.equal(buildInlineKeyboard([{ texto: 'Sem destino' }]), null);

  assert.deepEqual(buildInlineKeyboard([{ texto: 'Login', opcaoId: 'login' }]), {
    inline_keyboard: [[{ text: 'Login', callback_data: 'atd:login' }]]
  });

  // Lista de linhas já montada pelo portal também funciona.
  assert.deepEqual(
    buildInlineKeyboard([[{ texto: 'A', opcaoId: 'a' }, { texto: 'B', url: 'https://b.com' }]]),
    { inline_keyboard: [[{ text: 'A', callback_data: 'atd:a' }, { text: 'B', url: 'https://b.com' }]] }
  );

  // callback_data acima de 64 bytes quebraria a mensagem inteira no Telegram.
  assert.equal(buildInlineKeyboard([{ texto: 'Longo', opcaoId: 'x'.repeat(70) }]), null);
});

// --- ações ------------------------------------------------------------------

test('acao "verificar" mostra a mensagem de verificação do /start', async () => {
  const h = setup({ portal: () => okResponse({ mensagens: [{ html: 'Preciso te identificar.' }], acao: 'verificar' }) });

  await h.atd.handleCallbackQuery(callbackQuery('atd:verificar'));

  assert.deepEqual(h.acoes, [{ acao: 'verificar', chatId: TELEGRAM_ID, nome: 'Davi' }]);
  assert.equal(h.sends.length, 1);
});

test('acao "meuscanais" chama a mesma função do comando', async () => {
  const h = setup({ portal: () => okResponse({ mensagens: [], acao: 'meuscanais' }) });

  await h.atd.handleCallbackQuery(callbackQuery('atd:canais'));

  assert.deepEqual(h.acoes, [{ acao: 'meuscanais', chatId: TELEGRAM_ID }]);
});

test('acao desconhecida ou ausente não faz nada', async () => {
  const h = setup({ portal: () => okResponse({ mensagens: [], acao: 'fazer_cafe' }) });

  await h.atd.handleCommand(privateMessage('/atendimento'));

  assert.deepEqual(h.acoes, []);
});

test('erro dentro da ação não derruba o atendimento', async () => {
  const h = setup({ portal: () => okResponse({ mensagens: [], acao: 'meuscanais' }) });
  const atd = createAtendimento({
    bot: { answerCallbackQuery: async () => {} },
    safeSendMessage: async () => ({}),
    getUser: async () => null,
    sendUserChannels: async () => {
      throw new Error('banco fora');
    },
    postJson: async () => okResponse({ mensagens: [], acao: 'meuscanais' }),
    env: { ATENDIMENTO_ENABLED: 'true', TELEGRAM_ATENDIMENTO_SECRET: SECRET },
    startCleanup: false
  });

  const resultado = await atd.handleCommand(privateMessage('/atendimento'));
  assert.equal(resultado.ok, true);
  assert.equal(h.calls.length, 0);
});

// --- texto livre e estado ---------------------------------------------------

test('texto livre sem estado ativo segue sem resposta', async () => {
  const h = setup();

  const resultado = await h.atd.handleMessage(privateMessage('oi'));

  assert.equal(resultado.skipped, 'no_active_state');
  assert.equal(h.calls.length, 0);
  assert.equal(h.sends.length, 0);
});

test('comando não é tratado como texto livre', async () => {
  const h = setup();
  h.atd.state.save(TELEGRAM_ID, { estado: 'menu' });

  const resultado = await h.atd.handleMessage(privateMessage('/meuscanais'));

  assert.equal(resultado.skipped, 'not_free_text');
  assert.equal(h.calls.length, 0);
});

test('mensagem sem texto (foto, sticker) é ignorada', async () => {
  const h = setup();
  h.atd.state.save(TELEGRAM_ID, { estado: 'menu' });

  const resultado = await h.atd.handleMessage({
    chat: { id: TELEGRAM_ID, type: 'private' },
    from: { id: TELEGRAM_ID, first_name: 'Davi' }
  });

  assert.equal(resultado.skipped, 'not_free_text');
  assert.equal(h.calls.length, 0);
});

test('estado expira em 30 minutos e a conversa volta ao menu', () => {
  let clock = CLOCK_START;
  const state = createStateStore({ now: () => clock });

  state.save(TELEGRAM_ID, { estado: 'menu' });
  clock += STATE_TTL_MS - 1000;
  assert.equal(state.get(TELEGRAM_ID).estado, 'menu');

  clock += 2000;
  assert.equal(state.get(TELEGRAM_ID), null);
});

test('limpeza periódica remove estados vencidos', () => {
  let clock = CLOCK_START;
  const state = createStateStore({ now: () => clock });

  state.save('111', { estado: 'menu' });
  clock += STATE_TTL_MS + 1;
  state.save('222', { estado: 'menu' });

  state.cleanup();

  assert.equal(state.size, 1);
  assert.equal(state.get('222').estado, 'menu');
});

// --- limites ----------------------------------------------------------------

test('no máximo uma chamada ao portal a cada 2 segundos por pessoa', async () => {
  const h = setup();

  await h.atd.handleCommand(privateMessage('/atendimento'));
  assert.equal(h.calls.length, 1);

  h.advance(MIN_CALL_INTERVAL_MS - 1);
  const bloqueado = await h.atd.handleCallbackQuery(callbackQuery('atd:status'));
  assert.equal(bloqueado.skipped, 'rate_limited');
  assert.equal(h.calls.length, 1);
  // Mesmo ignorada, a resposta do callback sai.
  assert.deepEqual(h.answered, ['cb-1']);

  h.advance(2);
  await h.atd.handleCallbackQuery(callbackQuery('atd:status'));
  assert.equal(h.calls.length, 2);
});

test('o limite é por pessoa, não global', async () => {
  const h = setup();

  await h.atd.handleCommand(privateMessage('/atendimento', 111));
  await h.atd.handleCommand(privateMessage('/atendimento', 222));

  assert.equal(h.calls.length, 2);
});

test('toque repetido no mesmo botão é ignorado enquanto a chamada não volta', async () => {
  let liberar;
  const pendente = new Promise((resolve) => {
    liberar = resolve;
  });

  const h = setup({
    portal: async () => {
      await pendente;
      return okResponse({ mensagens: [] });
    }
  });

  const primeiro = h.atd.handleCallbackQuery(callbackQuery('atd:menu'));
  const segundo = await h.atd.handleCallbackQuery(callbackQuery('atd:menu'));

  assert.equal(segundo.skipped, 'in_flight');
  assert.equal(h.calls.length, 1);

  liberar();
  await primeiro;

  assert.equal(h.calls.length, 1);
  // Os dois toques responderam o callback_query.
  assert.deepEqual(h.answered, ['cb-1', 'cb-1']);
});

// --- fora do privado e outros callbacks -------------------------------------

test('mensagem em grupo nunca chama o portal', async () => {
  const h = setup();

  const grupo = {
    chat: { id: -100123, type: 'group' },
    from: { id: TELEGRAM_ID, first_name: 'Davi' },
    text: 'quero ver minha assinatura'
  };
  const canal = { ...grupo, chat: { id: -100456, type: 'channel' } };
  const supergrupo = { ...grupo, chat: { id: -100789, type: 'supergroup' } };

  h.atd.state.save(-100123, { estado: 'menu' });

  for (const msg of [grupo, canal, supergrupo]) {
    assert.equal((await h.atd.handleMessage(msg)).ok, false);
    assert.equal((await h.atd.handleCommand({ ...msg, text: '/atendimento' })).ok, false);
  }

  await h.atd.handleCallbackQuery(callbackQuery('atd:menu', 'supergroup'));

  assert.equal(h.calls.length, 0);
  assert.equal(h.sends.length, 0);
  // O callback em grupo também é respondido, só não chama o portal.
  assert.deepEqual(h.answered, ['cb-1']);
});

test('callbacks de outros fluxos não passam pelo atendimento', async () => {
  const h = setup();

  for (const data of ['verify_identity', 'outro_fluxo', '', undefined]) {
    const resultado = await h.atd.handleCallbackQuery(callbackQuery(data));
    assert.equal(resultado.skipped, 'not_atendimento');
  }

  assert.equal(h.calls.length, 0);
  assert.equal(h.answered.length, 0);
});

test('atd: sem opção cai no menu', async () => {
  const h = setup();

  await h.atd.handleCallbackQuery(callbackQuery('atd:'));

  assert.equal(h.calls[0].payload.opcaoId, 'menu');
});
