import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReg, formatChassis, formatKraPin } from '../src/core/vehicle-format.js';

test('reg plates come out in one format', () => {
  for (const input of ['kda123a', 'KDA 123A', 'kda-123-a', ' Kda 123 a ']) assert.equal(formatReg(input), 'KDA 123A', input);
  assert.equal(formatReg('ze4512'), 'ZE 4512');      // trailer
  assert.equal(formatReg('gkb 123a'), 'GKB 123A');   // government
  assert.equal(formatReg('  cd 12 k  '), 'CD 12K');
  assert.equal(formatReg(''), null);
});

test('unusual plates are kept, just tidied', () => {
  assert.equal(formatReg('uap 123x ug'), 'UAP 123X UG');
});

test('chassis numbers lose spaces and dashes', () => {
  assert.equal(formatChassis('jal frr90-pk7001842'), 'JALFRR90PK7001842');
  assert.equal(formatChassis('   '), null);
});

test('KRA PIN must look like A123456789B', () => {
  assert.equal(formatKraPin('a123456789b'), 'A123456789B');
  assert.equal(formatKraPin('P051234567X'), 'P051234567X');
  assert.equal(formatKraPin('A12345678B'), null);
  assert.equal(formatKraPin('123456789'), null);
});
