// Eenvoudige 6502-disassembler.
import { OPCODES, MODE_SIZE } from './opcodes.js';

const h2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

// Geeft { addr, size, bytes, text } terug voor de instructie op `addr`.
export function disassemble(peek, addr) {
  const opcode = peek(addr);
  const op = OPCODES[opcode];
  if (!op) return { addr, size: 1, bytes: [opcode], text: `.BYTE $${h2(opcode)}` };
  const size = MODE_SIZE[op.mode];
  const bytes = [];
  for (let i = 0; i < size; i++) bytes.push(peek((addr + i) & 0xFFFF));
  const b1 = bytes[1];
  const w = bytes[1] | (bytes[2] << 8);
  let arg;
  switch (op.mode) {
    case 'imp': arg = ''; break;
    case 'acc': arg = 'A'; break;
    case 'imm': arg = `#$${h2(b1)}`; break;
    case 'zp': arg = `$${h2(b1)}`; break;
    case 'zpx': arg = `$${h2(b1)},X`; break;
    case 'zpy': arg = `$${h2(b1)},Y`; break;
    case 'abs': arg = `$${h4(w)}`; break;
    case 'abx': arg = `$${h4(w)},X`; break;
    case 'aby': arg = `$${h4(w)},Y`; break;
    case 'ind': arg = `($${h4(w)})`; break;
    case 'izx': arg = `($${h2(b1)},X)`; break;
    case 'izy': arg = `($${h2(b1)}),Y`; break;
    case 'rel': arg = `$${h4((addr + 2 + (b1 < 0x80 ? b1 : b1 - 256)) & 0xFFFF)}`; break;
  }
  return { addr, size, bytes, text: arg ? `${op.mn} ${arg}` : op.mn };
}

export { h2, h4 };
