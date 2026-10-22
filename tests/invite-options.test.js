const test = require('node:test');
const assert = require('node:assert');

const { buildInviteOptions } = require('../bot/invite-options');

const expireAt = new Date('2026-10-25T20:00:00Z');
const expectedExpire = Math.floor(expireAt.getTime() / 1000);

test('canal comum recebe link de uso limitado, sem aprovação', () => {
  const options = buildInviteOptions({ creates_join_request: false }, { expireAt, memberLimit: 1 });

  assert.deepStrictEqual(options, { expire_date: expectedExpire, member_limit: 1 });
});

test('canal com aprovação NÃO envia member_limit (Telegram rejeita os dois juntos)', () => {
  const options = buildInviteOptions({ creates_join_request: true }, { expireAt, memberLimit: 1 });

  assert.deepStrictEqual(options, { expire_date: expectedExpire, creates_join_request: true });
  assert.equal('member_limit' in options, false);
});

test('flag ausente é tratada como canal comum', () => {
  const options = buildInviteOptions({}, { expireAt, memberLimit: 1 });

  assert.equal(options.member_limit, 1);
  assert.equal('creates_join_request' in options, false);
});
