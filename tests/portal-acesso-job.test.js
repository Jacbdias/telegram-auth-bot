// Conferência diária com o portal: modo simular, modo remover, trava do
// limite, portal fora do ar e plano que o bot não mandou.
const test = require('node:test');
const assert = require('node:assert/strict');

const { runPortalAcessoJob, signBody } = require('../web/portal-acesso-job');
const { createSilentLogger } = require('./helpers/fake-db');

const SEGREDO = 'segredo-de-teste';
const VIP3 = 'CF VIP - FATOS DA BOLSA 3';
const RT = 'Canal Renda Turbinada';
const LITE = 'Close Friends LITE';

const SAIU = { planRevoked: true, telegram: [{ telegram_id: '9', channels_processed: 2, failures: [] }] };

function fakeDb(assinantes, resposta = () => SAIU) {
  const removidos = [];
  return {
    removidos,
    async listTelegramLinkedSubscribers() {
      return assinantes;
    },
    async deactivateSubscriberByEmail(email, { plan }) {
      removidos.push({ email, plan });
      const r = resposta(email, plan);
      if (r instanceof Error) throw r;
      return r && { email, ...r };
    }
  };
}

function portal(responder) {
  const pedidos = [];
  return {
    pedidos,
    postJson: async (url, opts) => {
      pedidos.push({ url, opts, corpo: JSON.parse(opts.body) });
      return responder(JSON.parse(opts.body), opts);
    }
  };
}

const alertas = () => {
  const lista = [];
  return { lista, send: async (tipo, msg) => lista.push({ tipo, msg }) };
};

const respostaVencidos = (corpo) => ({
  status: 200,
  body: JSON.stringify({
    resultados: corpo.assinantes.map((a) => ({
      email: a.email,
      revogar: a.email.startsWith('vencido') ? a.planos.filter((p) => p !== RT) : [],
      motivo: 'OK'
    }))
  })
});

const ASSINANTES = [
  { id: 1, email: 'Vencido@x.com', plan: `${RT}, ${VIP3}` },
  { id: 2, email: 'emdia@x.com', plan: VIP3 },
  { id: 3, email: 'vencido.lite@x.com', plan: LITE }
];

test('modo simular (padrão): lista e avisa, não remove ninguém', async () => {
  const db = fakeDb(ASSINANTES);
  const p = portal(respostaVencidos);
  const a = alertas();

  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: a,
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO },
    postJson: p.postJson,
    now: () => 1_800_000_000_000
  });

  assert.equal(resumo.modo, 'simular');
  assert.equal(resumo.conferidos, 3);
  assert.deepEqual(resumo.remocoes, [
    { email: 'vencido@x.com', plano: VIP3 },
    { email: 'vencido.lite@x.com', plano: LITE }
  ]);
  assert.equal(db.removidos.length, 0);
  assert.match(a.lista[0].msg, /Modo simular: 2 planos seriam removidos/);
  assert.match(a.lista[0].msg, /vencido@x\.com/);

  // Chamada assinada, e-mails em minúsculo, planos separados.
  const { opts, corpo } = p.pedidos[0];
  assert.equal(opts.headers['x-fdb-signature'], signBody(SEGREDO, '1800000000', opts.body));
  assert.deepEqual(corpo.assinantes[0], { email: 'vencido@x.com', planos: [RT, VIP3] });
});

test('modo remover: remove só o plano revogado, nunca o que ficou', async () => {
  const db = fakeDb(ASSINANTES);
  const p = portal(respostaVencidos);

  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: alertas(),
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover' },
    postJson: p.postJson
  });

  assert.equal(resumo.removidos, 2);
  assert.deepEqual(db.removidos, [
    { email: 'vencido@x.com', plan: VIP3 },
    { email: 'vencido.lite@x.com', plan: LITE }
  ]);
});

test('acima do limite: ninguém é removido e o alerta avisa', async () => {
  const db = fakeDb(ASSINANTES);
  const a = alertas();

  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: a,
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover', TELEGRAM_SYNC_MAX_REMOCOES: '1' },
    postJson: portal(respostaVencidos).postJson
  });

  assert.equal(resumo.abortado, 'ACIMA_DO_LIMITE');
  assert.equal(db.removidos.length, 0);
  assert.match(a.lista[0].msg, /Ninguém foi removido/);
});

test('portal fora do ar: ninguém é removido', async () => {
  const db = fakeDb(ASSINANTES);
  const a = alertas();

  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: a,
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover' },
    postJson: async () => ({ status: 503, body: '{}' })
  });

  assert.equal(resumo.abortado, 'PORTAL_FALHOU');
  assert.equal(db.removidos.length, 0);
  assert.equal(a.lista[0].tipo, 'SYNC_TELEGRAM_PORTAL');
});

test('plano que o bot não mandou nunca é removido', async () => {
  const db = fakeDb([{ id: 1, email: 'a@x.com', plan: LITE }]);
  await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: alertas(),
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover' },
    postJson: async () => ({
      status: 200,
      body: JSON.stringify({ resultados: [{ email: 'a@x.com', revogar: ['Projeto Trump', LITE], motivo: 'OK' }] })
    })
  });
  assert.deepEqual(db.removidos, [{ email: 'a@x.com', plan: LITE }]);
});

test('lotes de 200', async () => {
  const muitos = Array.from({ length: 450 }, (_, i) => ({ id: i, email: `p${i}@x.com`, plan: LITE }));
  const p = portal((corpo) => ({
    status: 200,
    body: JSON.stringify({ resultados: corpo.assinantes.map((a) => ({ email: a.email, revogar: [], motivo: 'OK' })) })
  }));

  const resumo = await runPortalAcessoJob({
    db: fakeDb(muitos),
    logger: createSilentLogger(),
    alerts: alertas(),
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO },
    postJson: p.postJson
  });

  assert.deepEqual(p.pedidos.map((x) => x.corpo.assinantes.length), [200, 200, 50]);
  assert.equal(resumo.conferidos, 450);
});

test('sem segredo: não chama o portal', async () => {
  let chamou = false;
  const resumo = await runPortalAcessoJob({
    db: fakeDb(ASSINANTES),
    logger: createSilentLogger(),
    alerts: alertas(),
    env: {},
    postJson: async () => {
      chamou = true;
    }
  });
  assert.equal(chamou, false);
  assert.equal(resumo.abortado, 'SEM_SEGREDO');
});

test('relatório separa removidos, recusados pelo Telegram e não removidos', async () => {
  const assinantes = [
    { id: 1, email: 'vencido.ok@x.com', plan: VIP3 },
    { id: 2, email: 'vencido.recusa@x.com', plan: VIP3 },
    { id: 3, email: 'vencido.erro@x.com', plan: LITE },
    { id: 4, email: 'vencido.semcanal@x.com', plan: LITE }
  ];
  const db = fakeDb(assinantes, (email) => {
    if (email === 'vencido.recusa@x.com') {
      return {
        planRevoked: true,
        telegram: [
          {
            telegram_id: '7',
            channels_processed: 2,
            failures: [
              { scope: 'invite_link', error: 'INVITE_HASH_EXPIRED' },
              { scope: 'channel', channel: 'Milhas', error: 'not enough rights' }
            ]
          }
        ]
      };
    }
    if (email === 'vencido.erro@x.com') return new Error('banco caiu');
    if (email === 'vencido.semcanal@x.com') return { planRevoked: true, telegram: [{ telegram_id: '8', channels_processed: 0, failures: [] }] };
    return SAIU;
  });
  const a = alertas();

  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: a,
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover' },
    postJson: portal(respostaVencidos).postJson
  });

  assert.equal(resumo.removidos, 1);
  assert.deepEqual(resumo.ok, [{ email: 'vencido.ok@x.com', plano: VIP3, canais: 2 }]);
  assert.deepEqual(
    resumo.recusados.map((r) => [r.email, r.detalhe]),
    [
      ['vencido.recusa@x.com', 'Milhas: not enough rights'],
      ['vencido.semcanal@x.com', 'nenhum canal encontrado para o plano']
    ]
  );
  assert.deepEqual(resumo.falhas.map((r) => [r.email, r.error]), [['vencido.erro@x.com', 'banco caiu']]);

  const msg = a.lista[0].msg;
  assert.match(msg, /✅ \*Removidos dos grupos \(1\)\*\n• vencido\.ok@x\.com → CF VIP - FATOS DA BOLSA 3 \(2 canais\)/);
  assert.match(msg, /⚠️ \*Saíram do cadastro, mas o Telegram não confirmou \(2\)\*/);
  assert.match(msg, /vencido\.recusa@x\.com → CF VIP - FATOS DA BOLSA 3: Milhas: not enough rights/);
  assert.match(msg, /❌ \*Não removidos \(1\)\*/);
  assert.match(msg, /vencido\.erro@x\.com → Close Friends LITE: banco caiu/);
  // Erro de convite antigo não conta como recusa.
  assert.doesNotMatch(msg, /INVITE_HASH_EXPIRED/);
});

test('plano que já não estava no cadastro conta como não removido', async () => {
  const db = fakeDb([{ id: 1, email: 'vencido@x.com', plan: VIP3 }], () => ({ planRevoked: false, telegram: [] }));
  const resumo = await runPortalAcessoJob({
    db,
    logger: createSilentLogger(),
    alerts: alertas(),
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO, TELEGRAM_SYNC_MODO: 'remover' },
    postJson: portal(respostaVencidos).postJson
  });
  assert.equal(resumo.removidos, 0);
  assert.equal(resumo.falhas[0].error, 'o plano já não estava no cadastro');
});

// ─── Canal compartilhado na remoção por plano ─────────────────────────────
// database.js abre o pool do Postgres no require: um DATABASE_URL de mentira
// basta, nenhuma consulta é feita por selectChannelsToRemove.
test('remoção por plano não tira de canal compartilhado com plano que ficou', () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://teste:teste@127.0.0.1:1/teste';
  const { selectChannelsToRemove } = require('../web/database');
  const canais = [
    { name: 'Canal - Renda Turbinada', chat_id: '-1', plan: 'Canal Renda Turbinada', active: true },
    { name: 'Canal - Renda Turbinada', chat_id: '-1', plan: 'Mentoria Renda Turbinada', active: true },
    { name: 'Mentoria Renda Turbinada', chat_id: '-2', plan: 'Mentoria Renda Turbinada', active: true },
    { name: 'Atualizações CF VIP', chat_id: '-3', plan: VIP3, active: true },
    { name: 'Milhas', chat_id: '-4', plan: VIP3, active: true },
    { name: 'Milhas', chat_id: '-4', plan: 'CF VIP - FATOS DA BOLSA 1', active: true }
  ];

  // Perdeu o Canal RT mas ficou com a Mentoria: não sai do canal compartilhado.
  const rt = selectChannelsToRemove({
    allChannels: canais,
    planListForChannels: ['Canal Renda Turbinada'],
    includeAllChannels: false,
    keptPlanList: ['Mentoria Renda Turbinada']
  });
  assert.deepEqual(rt, []);

  // Perdeu o VIP 3 e não tem outro VIP: sai dos dois canais do VIP 3.
  const vip = selectChannelsToRemove({
    allChannels: canais,
    planListForChannels: [VIP3],
    includeAllChannels: false,
    keptPlanList: [RT]
  });
  assert.deepEqual(vip.map((c) => c.chat_id), ['-3', '-4']);

  // Perdeu o VIP 3 mas tem o VIP 1: o Milhas (compartilhado) fica.
  const vip1 = selectChannelsToRemove({
    allChannels: canais,
    planListForChannels: [VIP3],
    includeAllChannels: false,
    keptPlanList: ['CF VIP - FATOS DA BOLSA 1']
  });
  assert.deepEqual(vip1.map((c) => c.chat_id), ['-3']);
});
