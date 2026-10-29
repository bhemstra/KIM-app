import test from 'node:test';
import assert from 'node:assert/strict';
import { toPaperTape, parsePaperTape, parseIntelHex } from '../js/fileformats.js';

test('papertape heen en terug', () => {
  const bytes = Array.from({ length: 30 }, (_, i) => (i * 7) & 0xFF);
  const tape = toPaperTape(0x0200, bytes);
  assert.ok(tape.startsWith(';180200'));
  assert.ok(tape.trimEnd().endsWith(';0000020002'));
  const segs = parsePaperTape(tape);
  assert.deepEqual(segs.map((s) => s.start), [0x200, 0x218]);
  assert.deepEqual(segs.flatMap((s) => s.bytes), bytes);
});

test('papertape met foute controlesom', () => {
  assert.throws(() => parsePaperTape(';0102001100FF\r\n'), /controlesom/);
});

test('Intel HEX', () => {
  const segs = parseIntelHex(':03020000A942858B\n:00000001FF\n');
  assert.deepEqual(segs, [{ start: 0x200, bytes: [0xA9, 0x42, 0x85] }]);
});
