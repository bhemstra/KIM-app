// Instructietabel van de PDP-11/40 en een disassembler in MACRO-11-notatie.
import { o6 } from './pdp11.js';

// fmt: none | dd | r | rdd | ssdd | ssr | br | sob | n8 | n6
export const OPS = {};
const def = (fmt, list) => { for (const [name, op] of Object.entries(list)) OPS[name] = { op, fmt }; };

def('none', {
  HALT: 0, WAIT: 1, RTI: 2, BPT: 3, IOT: 4, RESET: 5, RTT: 6,
  NOP: 0o240, CLC: 0o241, CLV: 0o242, CLZ: 0o244, CLN: 0o250, CCC: 0o257,
  SEC: 0o261, SEV: 0o262, SEZ: 0o264, SEN: 0o270, SCC: 0o277,
});
def('dd', {
  JMP: 0o100, SWAB: 0o300, MFPI: 0o6500, MTPI: 0o6600, SXT: 0o6700,
  CLR: 0o5000, COM: 0o5100, INC: 0o5200, DEC: 0o5300, NEG: 0o5400, ADC: 0o5500, SBC: 0o5600, TST: 0o5700,
  ROR: 0o6000, ROL: 0o6100, ASR: 0o6200, ASL: 0o6300,
});
for (const n of ['CLR', 'COM', 'INC', 'DEC', 'NEG', 'ADC', 'SBC', 'TST', 'ROR', 'ROL', 'ASR', 'ASL']) {
  OPS[n + 'B'] = { op: OPS[n].op | 0o100000, fmt: 'dd' };
}
def('r', { RTS: 0o200 });
def('rdd', { JSR: 0o4000, XOR: 0o74000 });
def('ssdd', {
  MOV: 0o10000, CMP: 0o20000, BIT: 0o30000, BIC: 0o40000, BIS: 0o50000, ADD: 0o60000,
  MOVB: 0o110000, CMPB: 0o120000, BITB: 0o130000, BICB: 0o140000, BISB: 0o150000, SUB: 0o160000,
});
def('ssr', { MUL: 0o70000, DIV: 0o71000, ASH: 0o72000, ASHC: 0o73000 });
def('br', {
  BR: 0o400, BNE: 0o1000, BEQ: 0o1400, BGE: 0o2000, BLT: 0o2400, BGT: 0o3000, BLE: 0o3400,
  BPL: 0o100000, BMI: 0o100400, BHI: 0o101000, BLOS: 0o101400, BVC: 0o102000, BVS: 0o102400,
  BCC: 0o103000, BCS: 0o103400, BHIS: 0o103000, BLO: 0o103400,
});
def('sob', { SOB: 0o77000 });
def('n8', { EMT: 0o104000, TRAP: 0o104400 });
def('n6', { MARK: 0o6400 });

// Omgekeerde tabel voor de disassembler (eerste naam wint: BCC boven BHIS)
const BY_FMT = {};
for (const [name, { op, fmt }] of Object.entries(OPS)) {
  if (name === 'BHIS' || name === 'BLO') continue;
  (BY_FMT[fmt] ||= []).push([name, op]);
}
const MASK = { none: 0o177777, dd: 0o177700, r: 0o177770, rdd: 0o177000, ssdd: 0o170000, ssr: 0o177000, br: 0o177400, sob: 0o177000, n8: 0o177400, n6: 0o177700 };
const ORDER = ['none', 'r', 'n6', 'dd', 'br', 'n8', 'sob', 'ssr', 'rdd', 'ssdd'];

export const REG_NAMES = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'SP', 'PC'];

export function decode(op) {
  for (const fmt of ORDER) {
    for (const [name, code] of BY_FMT[fmt]) {
      if ((op & MASK[fmt]) === code) return { name, fmt };
    }
  }
  return null;
}

// Disassembleer de instructie op `addr`. peekWord(a) geeft een woord of null.
export function disassemble(peekWord, addr) {
  const words = [];
  const get = (a) => peekWord(a & 0xFFFF) ?? 0;
  const first = get(addr);
  words.push(first);
  let pos = (addr + 2) & 0xFFFF;

  const operand = (mode, reg) => {
    const R = REG_NAMES[reg];
    if (reg === 7 && mode >= 2 && (mode === 2 || mode === 3 || mode >= 6)) {
      const w = get(pos);
      words.push(w);
      pos = (pos + 2) & 0xFFFF;
      if (mode === 2) return `#${o6(w)}`;
      if (mode === 3) return `@#${o6(w)}`;
      const target = o6((w + pos) & 0xFFFF);
      return mode === 6 ? target : `@${target}`;
    }
    switch (mode) {
      case 0: return R;
      case 1: return `(${R})`;
      case 2: return `(${R})+`;
      case 3: return `@(${R})+`;
      case 4: return `-(${R})`;
      case 5: return `@-(${R})`;
      default: {
        const w = get(pos);
        words.push(w);
        pos = (pos + 2) & 0xFFFF;
        return `${mode === 7 ? '@' : ''}${o6(w)}(${R})`;
      }
    }
  };

  const d = decode(first);
  let text;
  if (!d) text = `.WORD  ${o6(first)}`;
  else {
    const { name, fmt } = d;
    const pad = name.padEnd(6);
    const reg = (first >> 6) & 7;
    switch (fmt) {
      case 'none': text = name; break;
      case 'dd': text = pad + operand((first >> 3) & 7, first & 7); break;
      case 'r': text = pad + REG_NAMES[first & 7]; break;
      case 'rdd': text = `${pad}${REG_NAMES[reg]},${operand((first >> 3) & 7, first & 7)}`; break;
      case 'ssdd': {
        const s = operand((first >> 9) & 7, (first >> 6) & 7);
        text = `${pad}${s},${operand((first >> 3) & 7, first & 7)}`;
        break;
      }
      case 'ssr': text = `${pad}${operand((first >> 3) & 7, first & 7)},${REG_NAMES[reg]}`; break;
      case 'br': {
        const off = first & 0x80 ? (first & 0xFF) - 256 : first & 0xFF;
        text = pad + o6((addr + 2 + 2 * off) & 0xFFFF);
        break;
      }
      case 'sob': text = `${pad}${REG_NAMES[reg]},${o6((addr + 2 - 2 * (first & 0o77)) & 0xFFFF)}`; break;
      case 'n8': text = pad + (first & 0o377).toString(8); break;
      default: text = pad + (first & 0o77).toString(8); break;
    }
  }
  return { text, words, size: words.length * 2 };
}
