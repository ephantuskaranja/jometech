import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, formatPhone } from '../src/core/phone.js';

test('normalizes Kenyan numbers to +254', () => {
  for (const input of ['0712345678', '0712 345 678', '712345678', '254712345678', '+254 712-345-678']) {
    assert.equal(normalizePhone(input), '+254712345678', input);
  }
  assert.equal(normalizePhone('0110 123 456'), '+254110123456');
});

test('accepts other countries only with a leading +', () => {
  assert.equal(normalizePhone('+256 772 123456'), '+256772123456');
  assert.equal(normalizePhone('256772123456'), null);
});

test('rejects things that are not phone numbers', () => {
  for (const input of ['', 'abc', '12345', '0812345678', null]) assert.equal(normalizePhone(input), null, String(input));
});

test('formats for display', () => {
  assert.equal(formatPhone('+254712345678'), '0712 345 678');
  assert.equal(formatPhone('+256772123456'), '+256772123456');
});
