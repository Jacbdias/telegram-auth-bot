const test = require('node:test');
const assert = require('node:assert');

const { decideJoinRequest } = require('../bot/join-request-policy');

const CHANNELS = [
  { id: 7, name: 'Projeto Trump', chat_id: '-1002441831755' },
  { id: 8, name: 'Milhas', chat_id: '-1001662496741' }
];

const AUTHORIZED = { authorized: true, status: 'active', plan: 'Projeto Trump' };

test('aprova assinante ativo e autorizado num canal do plano dele', () => {
  const decision = decideJoinRequest(AUTHORIZED, CHANNELS, '-1002441831755');

  assert.equal(decision.approve, true);
  assert.equal(decision.reason, 'authorized');
  assert.equal(decision.channel.id, 7);
});

test('aceita chat_id numérico, não só string', () => {
  assert.equal(decideJoinRequest(AUTHORIZED, CHANNELS, -1002441831755).approve, true);
});

test('não aprova quem não está no banco', () => {
  const decision = decideJoinRequest(null, CHANNELS, '-1002441831755');

  assert.equal(decision.approve, false);
  assert.equal(decision.reason, 'unknown_user');
});

test('não aprova autorização revogada', () => {
  const decision = decideJoinRequest(
    { ...AUTHORIZED, authorized: false },
    CHANNELS,
    '-1002441831755'
  );

  assert.equal(decision.approve, false);
  assert.equal(decision.reason, 'not_authorized');
});

test('não aprova assinante inativo ou suspenso', () => {
  for (const status of ['inactive', 'suspended', null, undefined]) {
    const decision = decideJoinRequest({ ...AUTHORIZED, status }, CHANNELS, '-1002441831755');

    assert.equal(decision.approve, false, `status ${status} não deveria aprovar`);
    assert.equal(decision.reason, 'subscriber_not_active');
  }
});

test('não aprova canal fora do plano do usuário', () => {
  const decision = decideJoinRequest(AUTHORIZED, CHANNELS, '-1009999999999');

  assert.equal(decision.approve, false);
  assert.equal(decision.reason, 'channel_not_in_plan');
});

test('não aprova quando o usuário não tem nenhum canal', () => {
  assert.equal(decideJoinRequest(AUTHORIZED, [], '-1002441831755').approve, false);
  assert.equal(decideJoinRequest(AUTHORIZED, null, '-1002441831755').approve, false);
});

test('não aprova sem chat_id', () => {
  assert.equal(decideJoinRequest(AUTHORIZED, CHANNELS, '').reason, 'missing_chat_id');
  assert.equal(decideJoinRequest(AUTHORIZED, CHANNELS, null).reason, 'missing_chat_id');
});

test('ignora espaços em volta do chat_id cadastrado', () => {
  const channels = [{ id: 9, name: 'Com espaço', chat_id: ' -1002441831755 ' }];

  assert.equal(decideJoinRequest(AUTHORIZED, channels, '-1002441831755').approve, true);
});

test('ignora canal sem chat_id cadastrado em vez de quebrar', () => {
  const channels = [{ id: 10, name: 'Sem chat_id', chat_id: null }, ...CHANNELS];

  assert.equal(decideJoinRequest(AUTHORIZED, channels, '-1002441831755').channel.id, 7);
  assert.equal(decideJoinRequest(AUTHORIZED, [{ id: 10, chat_id: null }], '-1002441831755').approve, false);
});
