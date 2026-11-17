// Lista de bloqueados do portal: o bot consulta antes de liberar grupos, não
// corta ninguém pelo reembolso de compra retida, e libera quando o portal
// manda a liberação assinada.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createHotmartProcessor } = require('../web/hotmart-processor');
const { createConsultaBloqueio, extractDadosBloqueio, signBody } = require('../web/portal-bloqueio');
const { createPortalLiberacaoRouter } = require('../web/portal-liberacao');
const { createFakeDb, createSilentLogger, silentMetrics, noopCache } = require('./helpers/fake-db');

const LITE = 'Close Friends LITE';
const PRODUTO_LITE = 5060609;
const SEGREDO = 'segredo-de-teste';

function compra({ email = 'hevertonbt@msn.com', transacao = 'HP-1', cpf = '10777195747' } = {}) {
  return {
    id: 'evt-approved',
    event: 'PURCHASE_APPROVED',
    version: '2.0.0',
    data: {
      product: { id: PRODUTO_LITE, name: LITE },
      buyer: { email, name: 'Heverton Barbosa Teodoro', checkout_phone: '27999677049', document: cpf },
      purchase: { transaction: transacao, status: 'APPROVED', offer: { code: 'of-1' } },
      subscription: { status: 'ACTIVE', subscriber: { code: 'SUB1', email } }
    }
  };
}

function reembolso({ email, transacao = 'HP-1' }) {
  return {
    id: 'evt-refund',
    event: 'PURCHASE_REFUNDED',
    version: '2.0.0',
    data: {
      product: { id: PRODUTO_LITE, name: LITE },
      buyer: { email, name: 'Heverton Barbosa Teodoro' },
      purchase: { transaction: transacao, status: 'REFUNDED' },
      subscription: { status: 'ACTIVE', subscriber: { code: 'SUB1', email } }
    }
  };
}

function processador(db, resposta) {
  const chamadas = [];
  const { processHotmartEvent } = createHotmartProcessor({
    db,
    cache: noopCache,
    logger: createSilentLogger(),
    metrics: silentMetrics,
    planMapping: '',
    defaultPlan: null,
    consultarBloqueio: async (dados) => {
      chamadas.push(dados);
      return { bloqueado: false, retida: false, liberada: false, disponivel: true, ...resposta };
    }
  });
  return { processHotmartEvent, chamadas };
}

test('compra de bloqueado: não libera grupos e manda os dados de conferência ao portal', async () => {
  const db = createFakeDb({});
  const { processHotmartEvent, chamadas } = processador(db, { bloqueado: true });

  const result = await processHotmartEvent(compra());

  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'BLOQUEADO');
  assert.equal(db.state.subscribers.length, 0);
  assert.deepEqual(chamadas[0], {
    transacao: 'HP-1',
    email: 'hevertonbt@msn.com',
    telefone: '27999677049',
    cpf: '10777195747',
    nome: 'Heverton Barbosa Teodoro'
  });
});

test('compra liberada pelo admin (ou sem bloqueio): ativa normalmente', async () => {
  const db = createFakeDb({});
  const { processHotmartEvent } = processador(db, { liberada: true });

  const result = await processHotmartEvent(compra());

  assert.equal(result.action, 'activated');
  assert.equal(db.state.subscribers.length, 1);
});

test('reembolso de compra retida no portal: não corta o assinante (homônimo)', async () => {
  const email = 'homonimo@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: LITE }] });
  const { processHotmartEvent } = processador(db, { retida: true });

  const result = await processHotmartEvent(reembolso({ email }));

  assert.equal(result.reason, 'COMPRA_RETIDA');
  assert.equal(db.state.revocations.length, 0);
  assert.equal(db.state.subscribers[0].plan, LITE);
});

test('reembolso comum continua cortando', async () => {
  const email = 'reembolsou@email.com';
  const db = createFakeDb({ subscribers: [{ email, plan: LITE }] });
  const { processHotmartEvent } = processador(db, {});

  const result = await processHotmartEvent(reembolso({ email }));

  assert.equal(result.action, 'deactivated');
  assert.equal(db.state.revocations.length, 1);
});

test('consulta: assina com o segredo do atendimento e lê a resposta do portal', async () => {
  const pedidos = [];
  const consultar = createConsultaBloqueio({
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO },
    logger: createSilentLogger(),
    alerts: { send: async () => {} },
    now: () => 1_800_000_000_000,
    postJson: async (url, opts) => {
      pedidos.push({ url, opts });
      return { status: 200, body: JSON.stringify({ bloqueado: true, retida: false, liberada: false, disponivel: true }) };
    }
  });

  const resposta = await consultar({ email: 'a@b.com' });

  assert.equal(resposta.bloqueado, true);
  assert.equal(pedidos[0].url, 'https://portal.fatosdabolsa.com.br/api/telegram/bloqueio');
  const { headers, body } = pedidos[0].opts;
  assert.equal(headers['x-fdb-timestamp'], '1800000000');
  assert.equal(headers['x-fdb-signature'], signBody(SEGREDO, '1800000000', body));
});

test('consulta: portal fora do ar tenta de novo, segue sem bloquear e avisa', async () => {
  let tentativas = 0;
  const alertas = [];
  const logger = createSilentLogger();
  const consultar = createConsultaBloqueio({
    env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO },
    logger,
    alerts: { send: async (tipo) => alertas.push(tipo) },
    postJson: async () => {
      tentativas += 1;
      throw new Error('timeout');
    }
  });

  const resposta = await consultar({ email: 'a@b.com' });

  assert.equal(tentativas, 2);
  assert.equal(resposta.bloqueado, false);
  assert.equal(resposta.disponivel, false);
  assert.deepEqual(alertas, ['BLOQUEIO_PORTAL_INDISPONIVEL']);
  assert.equal(logger.find('bloqueio_portal_indisponivel').length, 1);
});

test('consulta: sem segredo não chama a rede', async () => {
  let chamou = false;
  const consultar = createConsultaBloqueio({
    env: {},
    logger: createSilentLogger(),
    postJson: async () => {
      chamou = true;
    }
  });

  const resposta = await consultar({ email: 'a@b.com' });
  assert.equal(chamou, false);
  assert.equal(resposta.bloqueado, false);
});

test('extractDadosBloqueio aceita CPF numérico e sem transação', () => {
  const dados = extractDadosBloqueio(
    { data: { buyer: { document: 10777195747 } } },
    { email: 'a@b.com', phone: '', rawName: '' }
  );
  assert.equal(dados.cpf, '10777195747');
  assert.equal(dados.transacao, null);
});

// ─── Rota de liberação ────────────────────────────────────────────────────

function iniciar(processHotmartEvent) {
  const app = express();
  app.use(
    '/api/portal/hotmart-liberado',
    createPortalLiberacaoRouter({
      env: { TELEGRAM_ATENDIMENTO_SECRET: SEGREDO },
      logger: createSilentLogger(),
      processHotmartEvent
    })
  );
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function enviar(server, body, { assinatura, timestamp } = {}) {
  const corpo = JSON.stringify(body);
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/portal/hotmart-liberado',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(corpo),
          'x-fdb-timestamp': ts,
          'x-fdb-signature': assinatura ?? signBody(SEGREDO, ts, corpo)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data || 'null') }));
      }
    );
    req.on('error', reject);
    req.end(corpo);
  });
}

test('liberação assinada pelo portal reprocessa o evento', async (t) => {
  const recebidos = [];
  const server = await iniciar(async (payload) => {
    recebidos.push(payload);
    return { action: 'activated' };
  });
  t.after(() => server.close());

  const res = await enviar(server, compra());
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, action: 'activated' });
  assert.equal(recebidos[0].data.purchase.transaction, 'HP-1');
});

test('liberação com assinatura errada ou velha: 401 e nada processado', async (t) => {
  let chamou = false;
  const server = await iniciar(async () => {
    chamou = true;
    return {};
  });
  t.after(() => server.close());

  assert.equal((await enviar(server, compra(), { assinatura: 'a'.repeat(64) })).status, 401);
  const velho = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await enviar(server, compra(), { timestamp: velho })).status, 401);
  assert.equal(chamou, false);
});

test('liberação que o processador ainda ignora vira 409 (o portal mostra que falhou)', async (t) => {
  const server = await iniciar(async () => ({ ignored: true, reason: 'BLOQUEADO' }));
  t.after(() => server.close());

  const res = await enviar(server, compra());
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'BLOQUEADO');
});
