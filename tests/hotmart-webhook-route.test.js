const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const HOTTOK = 'hottok-de-teste-do-bot';

// O router lê HOTMART_WEBHOOK_SECRET no require.
process.env.HOTMART_WEBHOOK_SECRET = HOTTOK;

const hotmartWebhook = require('../web/hotmart-webhook');

function startServer() {
  const app = express();
  app.use('/api/hotmart/webhook', hotmartWebhook);

  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(server, { hottok, body }) {
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: '/api/hotmart/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(hottok === undefined ? {} : { 'X-Hotmart-Hottok': hottok })
        }
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_error) {
            parsed = null;
          }
          resolve({ status: response.statusCode, body: parsed });
        });
      }
    );

    request.on('error', reject);
    request.end(payload);
  });
}

test('hottok: o certo passa e o errado recebe 401', async (t) => {
  const server = await startServer();

  t.after(async () => {
    hotmartWebhook.stopWebhookRetryInterval();
    await new Promise((resolve) => server.close(resolve));
  });

  // Evento ignorado de propósito: prova que o hottok passou sem precisar de
  // banco (UPDATE_SUBSCRIPTION_CHARGE_DATE responde 202 e só registra).
  const ignoravel = {
    id: 'evt-1',
    event: 'UPDATE_SUBSCRIPTION_CHARGE_DATE',
    data: { subscriber: { email: 'alguem@email.com' }, subscription: { status: 'ACTIVE' } }
  };

  const certo = await post(server, { hottok: HOTTOK, body: ignoravel });
  assert.equal(certo.status, 202);
  assert.equal(certo.body.success, true);
  assert.equal(certo.body.reason, 'event_ignored');

  const errado = await post(server, { hottok: 'hottok-errado', body: ignoravel });
  assert.equal(errado.status, 401);
  assert.equal(errado.body.success, false);

  // Hottok de tamanho diferente também é 401 (sem estourar).
  const curto = await post(server, { hottok: 'x', body: ignoravel });
  assert.equal(curto.status, 401);

  const longo = await post(server, { hottok: `${HOTTOK}-extra`, body: ignoravel });
  assert.equal(longo.status, 401);

  // Sem hottok cai na verificação de assinatura HMAC, que também recusa.
  const semHottok = await post(server, { body: ignoravel });
  assert.equal(semHottok.status, 401);
});
