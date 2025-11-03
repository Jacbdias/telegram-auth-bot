const test = require('node:test');
const assert = require('node:assert/strict');

const { phonesMatch, normalizePhone } = require('../web/phone-utils');

test('normalizePhone remove caracteres não numéricos', () => {
  assert.equal(normalizePhone('+55 (27) 99690-6607'), '5527996906607');
  assert.equal(normalizePhone('  2799 6906 607 '), '27996906607');
  assert.equal(normalizePhone(null), '');
});

test('phonesMatch considera números iguais', () => {
  assert.equal(phonesMatch('27996906607', '27996906607'), true);
});

test('phonesMatch aceita diferenças de DDI e DDD', () => {
  assert.equal(phonesMatch('+55 (27) 99690-6607', '27996906607'), true);
});

test('phonesMatch ignora zeros à esquerda em números cadastrados', () => {
  assert.equal(phonesMatch('+55 27 99690-6607', '027996906607'), true);
});

test('phonesMatch não aceita números totalmente diferentes', () => {
  assert.equal(phonesMatch('5511999999999', '5527996906607'), false);
});
