// Draait Klaus Dormann's 6502 functional test als het binaire bestand beschikbaar is:
//   KLAUS_BIN=/pad/naar/6502_functional_test.bin npm test
// (Het bestand zelf zit niet in deze repository.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CPU6502 } from '../js/cpu6502.js';

const bin = process.env.KLAUS_BIN;

test('Klaus Dormann 6502 functional test', { skip: !bin || !existsSync(bin) }, () => {
  const mem = new Uint8Array(readFileSync(bin));
  const cpu = new CPU6502({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.pc = 0x0400;
  let prev = -1;
  for (let i = 0; i < 100_000_000; i++) {
    if (cpu.pc === prev) break; // vastgelopen op "jmp *"
    prev = cpu.pc;
    cpu.step();
  }
  assert.equal(cpu.pc.toString(16), '3469', 'test moet eindigen op het succesadres $3469');
});
