// /limpar_sem_plano: lista antes, remove só o que listou, respeita admin e
// conta apagada, e a confirmação expira.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLimpezaSemPlano, dividirMensagem, gruposUnicos } = require('../bot/limpeza-sem-plano');
const { expandirPlanosLegados } = require('../web/planos-legados');
const { createSilentLogger } = require('./helpers/fake-db');

const CANAIS = [
  { name: 'Atualizações CF VIP', chat_id: '-1', plan: 'CF VIP - FATOS DA BOLSA 1', active: true },
  { name: 'Atualizações CF VIP', chat_id: '-1', plan: 'CF VIP - FATOS DA BOLSA 3', active: true },
  { name: 'Atualizações CF LITE', chat_id: '-2', plan: 'Close Friends LITE', active: true },
  { name: 'Desativado', chat_id: '-9', plan: 'Close Friends LITE', active: false }
];

function cenario({ membros, erros = {}, recusar = new Set(), relogio = { t: 0 } }) {
  const banidos = [];
  const bot = {
    async getChatMember(chat, user) {
      const chave = `${chat}:${user}`;
      if (erros[chave]) throw new Error(erros[chave]);
      return { status: membros[chave] || 'left' };
    },
    async banChatMember(chat, user) {
      if (recusar.has(`${chat}:${user}`)) throw new Error('ETELEGRAM: 400 Bad Request: not enough rights');
      banidos.push(`${chat}:${user}`);
    },
    async unbanChatMember() {}
  };
  const db = {
    pool: {
      async query() {
        return {
          rows: [
            { email: 'a@x.com', telegram_id: '11' },
            { email: 'b@x.com', telegram_id: '22' },
            { email: 'c@x.com', telegram_id: '33' }
          ]
        };
      }
    },
    async getAllChannels() {
      return CANAIS;
    }
  };
  const limpeza = createLimpezaSemPlano({
    db,
    bot,
    logger: createSilentLogger(),
    pausaMs: 0,
    now: () => relogio.t,
    esperar: async () => {}
  });
  return { limpeza, banidos, relogio };
}

test('conferir lista quem está no grupo e não remove ninguém', async () => {
  const { limpeza, banidos } = cenario({
    membros: { '-1:11': 'member', '-2:11': 'left', '-2:22': 'restricted', '-1:33': 'administrator' },
    erros: { '-1:22': 'ETELEGRAM: 400 Bad Request: PARTICIPANT_ID_INVALID', '-2:33': 'ETELEGRAM: 429 Too Many Requests' }
  });

  const r = await limpeza.conferir();

  assert.equal(r.candidatos, 3);
  assert.deepEqual(
    r.presentes.map((p) => [p.email, p.grupos.map((g) => g.nome)]),
    [
      ['a@x.com', ['Atualizações CF VIP']],
      ['b@x.com', ['Atualizações CF LITE']]
    ]
  );
  assert.deepEqual(r.admins, [{ email: 'c@x.com', grupo: 'Atualizações CF VIP' }]);
  // Conta apagada não é erro; limite do Telegram é.
  assert.deepEqual(r.erros.map((e) => e.email), ['c@x.com']);
  assert.equal(banidos.length, 0);

  const texto = limpeza.textoConferencia(r);
  assert.match(texto, /2 pessoas/);
  assert.match(texto, /\/limpar_sem_plano confirmar/);
  assert.match(texto, /Administradores, não mexi/);
});

test('confirmar remove exatamente o que foi listado e informa recusa', async () => {
  const { limpeza, banidos } = cenario({
    membros: { '-1:11': 'member', '-2:22': 'member' },
    recusar: new Set(['-2:22'])
  });

  await limpeza.conferir();
  const r = await limpeza.remover();

  assert.deepEqual(banidos, ['-1:11']);
  assert.deepEqual(r.ok, [{ email: 'a@x.com', grupos: ['Atualizações CF VIP'] }]);
  assert.equal(r.falhas[0].email, 'b@x.com');
  assert.match(limpeza.textoRemocao(r), /O Telegram recusou \(1\)/);

  // A lista é usada uma vez só.
  assert.equal((await limpeza.remover()).semLista, true);
});

test('confirmar sem lista, ou com lista de mais de 30 minutos, não remove', async () => {
  const { limpeza, banidos, relogio } = cenario({ membros: { '-1:11': 'member' } });

  assert.equal((await limpeza.remover()).semLista, true);

  await limpeza.conferir();
  relogio.t = 31 * 60 * 1000;
  assert.equal((await limpeza.remover()).semLista, true);
  assert.equal(banidos.length, 0);
});

test('grupo aparece uma vez mesmo em vários planos; canal desativado fica de fora', () => {
  assert.deepEqual(gruposUnicos(CANAIS).map((g) => g.chat_id), ['-1', '-2']);
});

test('mensagem longa é dividida por linha', () => {
  const texto = Array.from({ length: 300 }, (_, i) => `• pessoa${i}@exemplo.com → Atualizações CF VIP`).join('\n');
  const partes = dividirMensagem(texto);
  assert.ok(partes.length > 1);
  assert.ok(partes.every((p) => p.length <= 3800));
  assert.equal(partes.join('\n'), texto);
});

test('nome antigo de plano vira os planos atuais', () => {
  assert.deepEqual(expandirPlanosLegados('FATOS DA BOLSA - CLOSE FRIENDS VIP'), [
    'CF VIP - FATOS DA BOLSA 1',
    'CF VIP - FATOS DA BOLSA 2',
    'CF VIP - FATOS DA BOLSA 3'
  ]);
  assert.deepEqual(expandirPlanosLegados(' fatos da bolsa -  close friends lite , Projeto Trump'), [
    'Close Friends LITE',
    'Projeto Trump'
  ]);
  assert.deepEqual(expandirPlanosLegados(''), []);
});

test('remoção com nome antigo de plano acha os canais', () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://teste:teste@127.0.0.1:1/teste';
  const { selectChannelsToRemove } = require('../web/database');
  const canais = [
    { name: 'Atualizações CF VIP', chat_id: '-1', plan: 'CF VIP - FATOS DA BOLSA 1', active: true },
    { name: 'Bate-Papo 1', chat_id: '-11', plan: 'CF VIP - FATOS DA BOLSA 1', active: true },
    { name: 'Bate-Papo 3', chat_id: '-13', plan: 'CF VIP - FATOS DA BOLSA 3', active: true },
    { name: 'Atualizações CF LITE', chat_id: '-2', plan: 'Close Friends LITE', active: true }
  ];

  const lite = selectChannelsToRemove({
    allChannels: canais,
    planListForChannels: ['FATOS DA BOLSA - CLOSE FRIENDS LITE'],
    includeAllChannels: false
  });
  assert.deepEqual(lite.map((c) => c.chat_id), ['-2']);

  const vip = selectChannelsToRemove({
    allChannels: canais,
    planListForChannels: ['FATOS DA BOLSA - CLOSE FRIENDS VIP'],
    includeAllChannels: false
  });
  assert.deepEqual(vip.map((c) => c.chat_id), ['-1', '-11', '-13']);
});
