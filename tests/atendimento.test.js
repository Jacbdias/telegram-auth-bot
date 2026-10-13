const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createAtendimento,
  createStateStore,
  buildInlineKeyboard,
  isEnabled,
  isServiceMessage,
  ATENDIMENTO_BUTTON,
  HANDOFF_FAILURE_MESSAGE,
  HANDOFF_FAILURE_INTERVAL_MS,
  HUMAN_STATE_TTL_MS,
  MAX_QUEUED_MESSAGES,
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

function privateMessage(text, telegramId = TELEGRAM_ID, messageId = 42) {
  return {
    message_id: messageId,
    chat: { id: telegramId, type: 'private' },
    from: { id: telegramId, first_name: 'Davi' },
    text
  };
}

function photoMessage(telegramId = TELEGRAM_ID, messageId = 77) {
  return {
    message_id: messageId,
    chat: { id: telegramId, type: 'private' },
    from: { id: telegramId, first_name: 'Davi' },
    photo: [{ file_id: 'AgACAgEAAx', file_unique_id: 'AQAD', width: 90, height: 90 }],
    caption: 'segue o comprovante'
  };
}

function callbackQuery(data, chatType = 'private', telegramId = TELEGRAM_ID) {
  return {
    id: 'cb-1',
    data,
    from: { id: telegramId, first_name: 'Davi' },
    message: { message_id: 500, chat: { id: telegramId, type: chatType } }
  };
}

function okResponse(body) {
  return { status: 200, body: JSON.stringify(body) };
}

// Captura o que o logger escreve, para provar o que entra e o que não entra.
async function captureLogs(fn) {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));

  try {
    await fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }

  return lines;
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

test('chave desligada: /start sem botão e nada vai ao portal', async () => {
  const h = setup({ enabled: false });

  assert.equal(h.atd.enabled, false);

  // bot/index.js monta o teclado do /start exatamente assim.
  const keyboardNaoVerificado = { inline_keyboard: [[VERIFY_BUTTON, ...h.atd.startButtons()]] };
  assert.deepEqual(keyboardNaoVerificado, { inline_keyboard: [[VERIFY_BUTTON]] });

  // E quem já está verificado continua recebendo a mensagem sem o botão.
  assert.equal(h.atd.startKeyboard(), null);

  await h.atd.handleMessage(privateMessage('quero falar com um atendente'));
  await h.atd.handleMessage(photoMessage());
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

// --- texto livre vai sempre ao portal ---------------------------------------

test('texto livre sem estado guardado vai ao portal', async () => {
  const h = setup();

  const resultado = await h.atd.handleMessage(privateMessage('acabei de comprar'));

  assert.equal(resultado.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.texto, 'acabei de comprar');
  assert.equal(h.calls[0].payload.tipo, 'texto');
  assert.equal(h.calls[0].payload.estado, null);
  assert.equal(h.calls[0].payload.estadoAtualizadoEm, null);
});

test('mensagemId vai na chamada', async () => {
  const h = setup();

  await h.atd.handleMessage(privateMessage('oi', TELEGRAM_ID, 12345));

  assert.equal(h.calls[0].payload.mensagemId, 12345);
});

test('comandos não vão ao portal', async () => {
  const h = setup();
  h.atd.state.save(TELEGRAM_ID, { estado: 'humano' });

  for (const comando of ['/start', '/meuscanais', '/atendimento', '/revogar alguem@email.com', '/sync']) {
    const resultado = await h.atd.handleMessage(privateMessage(comando));
    assert.equal(resultado.skipped, 'command', `${comando} não deveria ir ao portal`);
  }

  assert.equal(h.calls.length, 0);
  assert.equal(h.sends.length, 0);
});

test('mensagem de serviço do Telegram não vai ao portal', async () => {
  const h = setup();

  assert.equal(isServiceMessage({ pinned_message: { message_id: 1 } }), true);
  assert.equal(isServiceMessage({ photo: [] }), false);

  const resultado = await h.atd.handleMessage({
    message_id: 9,
    chat: { id: TELEGRAM_ID, type: 'private' },
    from: { id: TELEGRAM_ID, first_name: 'Davi' },
    pinned_message: { message_id: 8 }
  });

  assert.equal(resultado.skipped, 'service_message');
  assert.equal(h.calls.length, 0);
});

test('foto vai com tipo nao_suportado, sem conteúdo, e a resposta é entregue', async () => {
  const h = setup({
    portal: () => okResponse({
      mensagens: [{ html: 'Não consigo ler anexos por aqui. Pode escrever em texto?' }]
    })
  });

  await h.atd.handleMessage(photoMessage(TELEGRAM_ID, 77));

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.tipo, 'nao_suportado');
  assert.equal(h.calls[0].payload.mensagemId, 77);
  assert.equal(h.calls[0].payload.texto, null);
  // Nem a legenda da foto vai junto.
  assert.equal(h.calls[0].body.includes('comprovante'), false);

  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].message, 'Não consigo ler anexos por aqui. Pode escrever em texto?');
});

test('outros anexos também viram nao_suportado', async () => {
  const h = setup();

  for (const anexo of ['document', 'audio', 'voice', 'video', 'video_note', 'sticker', 'animation', 'location']) {
    await h.atd.handleMessage({
      message_id: 1,
      chat: { id: TELEGRAM_ID, type: 'private' },
      from: { id: TELEGRAM_ID, first_name: 'Davi' },
      [anexo]: { file_id: 'x' }
    });
  }

  assert.equal(h.calls.length, 8);
  assert.ok(h.calls.every((call) => call.payload.tipo === 'nao_suportado'));
});

// --- fila por pessoa: nenhuma mensagem é descartada -------------------------

test('três mensagens em menos de 1 segundo chegam as três, na ordem, uma de cada vez', async () => {
  let emVoo = 0;
  let maxEmVoo = 0;

  const h = setup({
    portal: async () => {
      emVoo += 1;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      await new Promise((resolve) => setTimeout(resolve, 5));
      emVoo -= 1;
      return okResponse({ mensagens: [] });
    }
  });

  // Sem avançar o relógio: as três chegam no mesmo instante.
  const pendentes = [
    h.atd.handleMessage(privateMessage('primeira', TELEGRAM_ID, 1)),
    h.atd.handleMessage(privateMessage('segunda', TELEGRAM_ID, 2)),
    h.atd.handleMessage(privateMessage('terceira', TELEGRAM_ID, 3))
  ];

  const resultados = await Promise.all(pendentes);

  assert.deepEqual(resultados.map((r) => r.ok), [true, true, true]);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => c.payload.texto), ['primeira', 'segunda', 'terceira']);
  assert.deepEqual(h.calls.map((c) => c.payload.mensagemId), [1, 2, 3]);
  // Uma de cada vez: nunca houve duas chamadas em paralelo.
  assert.equal(maxEmVoo, 1);
});

test('a fila é por pessoa: duas pessoas não esperam uma pela outra', async () => {
  let liberar;
  const pendente = new Promise((resolve) => {
    liberar = resolve;
  });

  const h = setup({
    portal: async (call) => {
      if (call.payload.telegramId === '111') {
        await pendente;
      }
      return okResponse({ mensagens: [] });
    }
  });

  const daPrimeira = h.atd.handleMessage(privateMessage('presa', 111, 1));
  await h.atd.handleMessage(privateMessage('passa direto', 222, 2));

  // A segunda pessoa foi atendida sem esperar a primeira.
  assert.equal(h.calls.length, 2);

  liberar();
  await daPrimeira;
});

test(`acima de ${MAX_QUEUED_MESSAGES} na fila, as excedentes são descartadas e aparecem no log`, async () => {
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

  const pendentes = [];
  let descartadas = 0;

  const linhas = await captureLogs(async () => {
    // A primeira ocupa a chamada; as 20 seguintes esperam; as outras sobram.
    for (let i = 1; i <= MAX_QUEUED_MESSAGES + 3; i += 1) {
      const resultado = h.atd.handleMessage(privateMessage(`mensagem segredo ${i}`, TELEGRAM_ID, i));
      pendentes.push(resultado);
    }

    liberar();
    const resultados = await Promise.all(pendentes);
    descartadas = resultados.filter((r) => r && r.skipped === 'queue_full').length;
  });

  assert.equal(descartadas, 2, 'duas mensagens deveriam sobrar da fila');
  assert.equal(h.calls.length, MAX_QUEUED_MESSAGES + 1);

  const descarte = linhas.filter((linha) => linha.includes('atendimento_queue_full'));
  assert.equal(descarte.length, 2);
  assert.ok(descarte[0].includes('"tipo":"texto"'));
  assert.ok(descarte[0].includes('***4321'), 'o id vai mascarado');
  // Nunca o texto digitado.
  assert.ok(!linhas.some((linha) => linha.includes('segredo')), 'o log não pode ter o texto');
});

// --- resposta do portal -----------------------------------------------------

test('mensagens vazio: nada é enviado ao usuário', async () => {
  const h = setup({ portal: () => okResponse({ mensagens: [], estado: 'humano' }) });

  const resultado = await h.atd.handleMessage(privateMessage('oi, tem alguém aí?'));

  assert.equal(resultado.ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sends.length, 0);
  assert.equal(h.acoes.length, 0);
});

test('estado "humano" é guardado por 7 dias, não por 30 minutos', async () => {
  const h = setup({
    portal: () => okResponse({ mensagens: [], estado: 'humano', estadoAtualizadoEm: '2026-10-13T12:00:00.000Z' })
  });

  await h.atd.handleMessage(privateMessage('quero falar com alguém'));

  assert.equal(h.atd.state.get(TELEGRAM_ID).estado, 'humano');

  // Muito depois dos 30 minutos do atendimento automático.
  h.advance(STATE_TTL_MS * 2);
  assert.equal(h.atd.state.get(TELEGRAM_ID).estado, 'humano');

  // E a pista ainda volta ao portal na mensagem seguinte.
  await h.atd.handleMessage(privateMessage('alô'));
  assert.equal(h.calls[1].payload.estado, 'humano');
  assert.equal(h.calls[1].payload.estadoAtualizadoEm, '2026-10-13T12:00:00.000Z');

  // Depois de 7 dias sem mensagem nenhuma a pista expira.
  h.advance(HUMAN_STATE_TTL_MS + 1000);
  assert.equal(h.atd.state.get(TELEGRAM_ID), null);
});

test('estado comum continua expirando em 30 minutos', () => {
  let clock = CLOCK_START;
  const state = createStateStore({ now: () => clock });

  state.save(TELEGRAM_ID, { estado: 'menu' });
  clock += STATE_TTL_MS - 1000;
  assert.equal(state.get(TELEGRAM_ID).estado, 'menu');

  clock += 2000;
  assert.equal(state.get(TELEGRAM_ID), null);
});

test('limpeza periódica respeita o prazo de cada estado', () => {
  let clock = CLOCK_START;
  const state = createStateStore({ now: () => clock });

  state.save('111', { estado: 'menu' });
  state.save('222', { estado: 'humano' });
  clock += STATE_TTL_MS + 1;

  state.cleanup();

  assert.equal(state.size, 1);
  assert.equal(state.get('222').estado, 'humano');
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

test('falha no texto livre do atendimento automático avisa indisponível e mantém o estado', async () => {
  const h = setup({ portal: () => { throw new Error('socket hang up'); } });
  h.atd.state.save(TELEGRAM_ID, { estado: 'aguardando_texto', estadoAtualizadoEm: '2026-10-13T00:00:00.000Z' });

  const resultado = await h.atd.handleMessage(privateMessage('acabei de comprar'));

  assert.equal(resultado.ok, false);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].message, /indisponível agora/);
  assert.equal(h.atd.state.get(TELEGRAM_ID).estado, 'aguardando_texto');
});

test('erro com estado "humano": o aviso sai uma vez e não repete em 10 minutos', async () => {
  const h = setup({ portal: () => { throw new Error('ECONNRESET'); } });
  h.atd.state.save(TELEGRAM_ID, { estado: 'humano' });

  await h.atd.handleMessage(privateMessage('primeira'));

  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].message, HANDOFF_FAILURE_MESSAGE);
  assert.equal(h.sends[0].message, 'Não consegui entregar sua mensagem agora. Tente de novo em alguns minutos.');

  // Segunda falha dentro dos 10 minutos: não sai de novo.
  h.advance(HANDOFF_FAILURE_INTERVAL_MS - 1000);
  await h.atd.handleMessage(privateMessage('segunda'));
  await h.atd.handleMessage(privateMessage('terceira'));

  assert.equal(h.sends.length, 1, 'o aviso não pode repetir a cada mensagem');
  assert.equal(h.calls.length, 3, 'mas as três mensagens foram tentadas');

  // Passados os 10 minutos, avisa de novo.
  h.advance(2000);
  await h.atd.handleMessage(privateMessage('quarta'));

  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].message, HANDOFF_FAILURE_MESSAGE);
});

test('estado "humano" não recebe a mensagem de indisponível do automático', async () => {
  const h = setup({ portal: () => ({ status: 503, body: 'indisponível' }) });
  h.atd.state.save(TELEGRAM_ID, { estado: 'humano' });

  await h.atd.handleMessage(privateMessage('oi'));

  assert.equal(h.sends.length, 1);
  assert.ok(!h.sends[0].message.includes('atendimento automático'));
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

test('a assinatura do texto livre também bate', async () => {
  const h = setup();

  await h.atd.handleMessage(privateMessage('mensagem com acento é çedilha'));

  const call = h.calls[0];
  const esperado = crypto
    .createHmac('sha256', SECRET)
    .update(`${call.headers['x-fdb-timestamp']}.${call.body}`)
    .digest('hex');

  assert.equal(call.headers['x-fdb-signature'], esperado);
  assert.equal(call.headers['content-length'], Buffer.byteLength(call.body));
});

test('URL do portal vem de PORTAL_ATENDIMENTO_URL quando configurada', async () => {
  const h = setup({ env: { PORTAL_ATENDIMENTO_URL: 'https://staging.exemplo.com/api/telegram/atendimento' } });

  await h.atd.handleCommand(privateMessage('/atendimento'));

  assert.equal(h.calls[0].url, 'https://staging.exemplo.com/api/telegram/atendimento');
});

// --- e-mail -----------------------------------------------------------------

test('e-mail: verificado manda o e-mail do assinante', async () => {
  const h = setup({ user: { authorized: true, email: 'assinante@email.com', plan: 'Projeto Trump' } });

  await h.atd.handleMessage(privateMessage('qual é o status da minha assinatura?'));

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

test('o log não leva o texto nem o e-mail', async () => {
  const h = setup({ user: { authorized: true, email: 'assinante@email.com' } });

  const linhas = await captureLogs(async () => {
    await h.atd.handleMessage(privateMessage('meu segredo inconfundível'));
  });

  const chamada = linhas.filter((linha) => linha.includes('atendimento_portal_call'));
  assert.equal(chamada.length, 1);
  assert.ok(chamada[0].includes('"tipo":"texto"'));
  assert.ok(chamada[0].includes('"status":200'));
  assert.ok(chamada[0].includes('duration_ms'));
  assert.ok(chamada[0].includes('***4321'));
  assert.ok(!linhas.some((linha) => linha.includes('inconfundível')));
  assert.ok(!linhas.some((linha) => linha.includes('assinante@email.com')));
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

  await h.atd.handleMessage(privateMessage('quero renovar'));

  assert.equal(h.calls[1].payload.estado, 'menu');
  assert.equal(h.calls[1].payload.estadoAtualizadoEm, '2026-10-13T12:00:00.000Z');
  assert.equal(h.calls[1].payload.texto, 'quero renovar');
  assert.equal(h.calls[1].payload.opcaoId, undefined);
});

test('o toque em botão não leva tipo nem mensagemId', async () => {
  const h = setup();

  await h.atd.handleCallbackQuery(callbackQuery('atd:status'));

  // mensagemId é da mensagem da pessoa; o botão é da mensagem do bot, e
  // reaproveitá-lo faria o portal tratar toques diferentes como repetidos.
  assert.equal(h.calls[0].payload.mensagemId, undefined);
  assert.equal(h.calls[0].payload.tipo, undefined);
  assert.equal(h.calls[0].payload.opcaoId, 'status');
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
});

// --- toques repetidos em botão ----------------------------------------------

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

test('botão tocado durante uma mensagem na fila é ignorado, a mensagem não', async () => {
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

  const daMensagem = h.atd.handleMessage(privateMessage('escrevendo'));
  const doBotao = await h.atd.handleCallbackQuery(callbackQuery('atd:menu'));

  assert.equal(doBotao.skipped, 'in_flight');
  assert.deepEqual(h.answered, ['cb-1']);

  liberar();
  await daMensagem;

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.texto, 'escrevendo');
});

// --- fora do privado e outros callbacks -------------------------------------

test('mensagem em grupo nunca chama o portal', async () => {
  const h = setup();

  const grupo = {
    message_id: 1,
    chat: { id: -100123, type: 'group' },
    from: { id: TELEGRAM_ID, first_name: 'Davi' },
    text: 'quero ver minha assinatura'
  };
  const canal = { ...grupo, chat: { id: -100456, type: 'channel' } };
  const supergrupo = { ...grupo, chat: { id: -100789, type: 'supergroup' } };

  h.atd.state.save(-100123, { estado: 'humano' });

  for (const msg of [grupo, canal, supergrupo]) {
    assert.equal((await h.atd.handleMessage(msg)).ok, false);
    assert.equal((await h.atd.handleMessage({ ...msg, text: undefined, photo: [{ file_id: 'x' }] })).ok, false);
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

  for (const data of ['verify_identity', 'meus_canais', 'outro_fluxo', '', undefined]) {
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
