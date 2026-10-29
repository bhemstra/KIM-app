import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble } from '../js/assembler.js';
import { disassemble } from '../js/disasm.js';

const bytesOf = (src) => assemble(src).segments.flatMap((s) => s.bytes);

test('adresseringsmodi', () => {
  const r = assemble(`
        .ORG $0200
START   LDA #$12
        LDA $12
        LDA $12,X
        LDA $1234
        LDA $1234,X
        LDA $1234,Y
        LDA ($12,X)
        LDA ($12),Y
        LDX $12,Y
        JMP ($1234)
        ASL A
        ASL
        BNE START
  `);
  assert.equal(r.start, 0x200);
  assert.deepEqual(r.segments[0].bytes, [
    0xA9, 0x12, 0xA5, 0x12, 0xB5, 0x12, 0xAD, 0x34, 0x12, 0xBD, 0x34, 0x12,
    0xB9, 0x34, 0x12, 0xA1, 0x12, 0xB1, 0x12, 0xB6, 0x12, 0x6C, 0x34, 0x12,
    0x0A, 0x0A, 0xD0, 0xE4,
  ]);
});

test('voorwaartse verwijzingen, zero-page labels en directives', () => {
  const b = bytesOf(`
SCANDS = $1F1F
        *= $0300
        JSR SCANDS
        LDA VAR      ; VAR ligt in de zero page -> 2 bytes
        BEQ DONE
        .BYTE 1, $FF, "AB"
DONE:   RTS
        .WORD DONE, <DONE, >DONE
        .ORG $10
VAR     .BYTE 0
  `);
  assert.deepEqual(b, [0x20, 0x1F, 0x1F, 0xA5, 0x10, 0xF0, 0x04, 1, 0xFF, 0x41, 0x42, 0x60, 0x0B, 0x03, 0x0B, 0x00, 0x03, 0x00, 0]);
});

test('fouten worden gemeld met regelnummer', () => {
  assert.throws(() => assemble('  LDA ONBEKEND'), /regel 1/);
  assert.throws(() => assemble('  XYZ #1'), /onbekende instructie/);
  assert.throws(() => assemble('  STA #1'), /niet mogelijk/);
});

test('disassembler', () => {
  const mem = [0xB1, 0x12, 0xD0, 0xFE, 0x6C, 0xFA, 0x17];
  const peek = (a) => mem[a] ?? 0;
  assert.equal(disassemble(peek, 0).text, 'LDA ($12),Y');
  assert.equal(disassemble(peek, 2).text, 'BNE $0002');
  assert.equal(disassemble(peek, 4).text, 'JMP ($17FA)');
});
