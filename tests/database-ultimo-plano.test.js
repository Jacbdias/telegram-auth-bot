// Remoção do ÚLTIMO plano de um assinante (reembolso da Hotmart, fim do
// período, conferência com o portal). O UPDATE apaga o plano antes da
// revogação; antes da correção a revogação lia o plano já vazio, não
// selecionava canal nenhum e a pessoa continuava nos grupos.
//
// `pg` e `node-telegram-bot-api` são trocados por versões de mentira antes de
// carregar o database.js: nenhuma conexão de verdade é aberta.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const LITE = 'Close Friends LITE';
const VIP3 = 'CF VIP - FATOS DA BOLSA 3';

const estado = {
  planoDoCadastro: LITE,
  banidos: [],
  recusar: new Set()
};

const CANAIS = [
  { id: 1, name: 'Atualizações LITE', chat_id: '-100', plan: LITE, active: true },
  { id: 2, name: 'Atualizações VIP', chat_id: '-200', plan: VIP3, active: true },
  { id: 3, name: 'Milhas', chat_id: '-300', plan: VIP3, active: true }
];

async function responder(sql, params = []) {
  const texto = String(sql);
  if (/FROM subscribers\s+WHERE email = \$1/.test(texto)) {
    return {
      rows: [{ id: 1, name: 'Fulano', email: params[0], phone: null, plan: estado.planoDoCadastro, status: 'active', origin: 'hotmart' }]
    };
  }
  if (/FROM authorized_users\s+WHERE subscriber_id = \$1/.test(texto)) {
    return { rows: [{ telegram_id: '555' }] };
  }
  if (/UPDATE subscribers\s+SET plan = \$1/.test(texto)) {
    estado.planoDoCadastro = params[0];
    return { rows: [{ id: 1, name: 'Fulano', email: 'x', phone: null, plan: params[0], status: params[1], origin: 'hotmart' }] };
  }
  if (/SELECT au\.subscriber_id, s\.plan/.test(texto)) {
    return { rows: [{ subscriber_id: 1, plan: estado.planoDoCadastro }] };
  }
  if (/SELECT \* FROM channels/.test(texto)) {
    return { rows: CANAIS };
  }
  return { rows: [], rowCount: 0 };
}

class FakePool {
  on() {}
  async query(sql, params) {
    return responder(sql, params);
  }
  async connect() {
    return { query: (sql, params) => responder(sql, params), release() {} };
  }
}

class FakeBot {
  async banChatMember(chatId, userId) {
    if (estado.recusar.has(chatId)) throw new Error('ETELEGRAM: 400 Bad Request: not enough rights');
    estado.banidos.push({ chatId, userId });
  }
  async unbanChatMember() {}
  async revokeChatInviteLink() {}
}

const falsos = { pg: { Pool: FakePool }, 'node-telegram-bot-api': FakeBot };
const loadOriginal = Module._load;
Module._load = function load(pedido, ...resto) {
  if (Object.prototype.hasOwnProperty.call(falsos, pedido)) return falsos[pedido];
  return loadOriginal.call(this, pedido, ...resto);
};

process.env.DATABASE_URL = 'postgres://teste:teste@127.0.0.1:1/teste';
process.env.TELEGRAM_BOT_TOKEN = '123:teste';

const db = require('../web/database');

test.beforeEach(() => {
  estado.banidos = [];
  estado.recusar = new Set();
});

test('último plano removido: a pessoa sai dos canais desse plano', async () => {
  estado.planoDoCadastro = LITE;

  const r = await db.deactivateSubscriberByEmail('fulano@x.com', { plan: LITE });

  assert.equal(r.planRevoked, true);
  assert.equal(r.plan, '');
  assert.deepEqual(estado.banidos, [{ chatId: '-100', userId: '555' }]);
  assert.deepEqual(r.telegram, [{ telegram_id: '555', channels_processed: 1, failures: [] }]);
});

test('ainda sobra plano: sai só dos canais do plano tirado', async () => {
  estado.planoDoCadastro = `${LITE}, ${VIP3}`;

  const r = await db.deactivateSubscriberByEmail('fulano@x.com', { plan: VIP3 });

  assert.equal(r.plan, LITE);
  assert.deepEqual(
    estado.banidos.map((b) => b.chatId),
    ['-200', '-300']
  );
  assert.equal(r.telegram[0].channels_processed, 2);
});

test('Telegram recusa: o retorno traz a falha do canal', async () => {
  estado.planoDoCadastro = VIP3;
  estado.recusar = new Set(['-300']);

  const r = await db.deactivateSubscriberByEmail('fulano@x.com', { plan: VIP3 });

  assert.deepEqual(estado.banidos.map((b) => b.chatId), ['-200']);
  assert.equal(r.telegram[0].failures.length, 1);
  assert.equal(r.telegram[0].failures[0].channel, 'Milhas');
});
