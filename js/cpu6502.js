// MOS 6502 CPU-kern (NMOS), inclusief decimale modus.
// De CPU praat met de buitenwereld via bus.read(addr) en bus.write(addr, value).

import { OPCODES } from './opcodes.js';

export const FLAG_C = 0x01;
export const FLAG_Z = 0x02;
export const FLAG_I = 0x04;
export const FLAG_D = 0x08;
export const FLAG_B = 0x10;
export const FLAG_U = 0x20;
export const FLAG_V = 0x40;
export const FLAG_N = 0x80;

export class CPU6502 {
  constructor(bus) {
    this.bus = bus;
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.s = 0xFD;
    this.p = FLAG_U | FLAG_I;
    this.pc = 0;
    this.cycles = 0; // totaal aantal uitgevoerde klokcycli
    this.nmiPending = false;
    this.irqLine = false; // niveau-gevoelig; door de bus beheerd
    this.lastOpcodeIllegal = false;
  }

  reset() {
    this.s = (this.s - 3) & 0xFF;
    this.p |= FLAG_I;
    this.pc = this.read16(0xFFFC);
    this.cycles += 7;
  }

  nmi() { this.nmiPending = true; }

  read(addr) { return this.bus.read(addr & 0xFFFF); }
  write(addr, v) { this.bus.write(addr & 0xFFFF, v & 0xFF); }
  read16(addr) { return this.read(addr) | (this.read(addr + 1) << 8); }

  push(v) { this.write(0x100 | this.s, v); this.s = (this.s - 1) & 0xFF; }
  pull() { this.s = (this.s + 1) & 0xFF; return this.read(0x100 | this.s); }

  setNZ(v) {
    this.p = (this.p & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | (v === 0 ? FLAG_Z : 0);
    return v;
  }

  setFlag(f, on) { if (on) this.p |= f; else this.p &= ~f; }

  interrupt(vector, brk) {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xFF);
    this.push((this.p | FLAG_U | (brk ? FLAG_B : 0)) & ~(brk ? 0 : FLAG_B));
    this.p |= FLAG_I;
    this.pc = this.read16(vector);
    this.cycles += 7;
  }

  // Bepaalt het effectieve adres; geeft extra cycli via this.pageCross door.
  addr(mode) {
    let lo, hi, base, a;
    switch (mode) {
      case 'zp': return this.read(this.pc++);
      case 'zpx': return (this.read(this.pc++) + this.x) & 0xFF;
      case 'zpy': return (this.read(this.pc++) + this.y) & 0xFF;
      case 'abs': a = this.read16(this.pc); this.pc += 2; return a;
      case 'abx':
        base = this.read16(this.pc); this.pc += 2;
        a = (base + this.x) & 0xFFFF;
        this.pageCross = (base & 0xFF00) !== (a & 0xFF00);
        return a;
      case 'aby':
        base = this.read16(this.pc); this.pc += 2;
        a = (base + this.y) & 0xFFFF;
        this.pageCross = (base & 0xFF00) !== (a & 0xFF00);
        return a;
      case 'ind':
        base = this.read16(this.pc); this.pc += 2;
        // NMOS-bug: geen paginaovergang bij JMP ($xxFF)
        lo = this.read(base);
        hi = this.read((base & 0xFF00) | ((base + 1) & 0xFF));
        return lo | (hi << 8);
      case 'izx':
        base = (this.read(this.pc++) + this.x) & 0xFF;
        return this.read(base) | (this.read((base + 1) & 0xFF) << 8);
      case 'izy':
        base = this.read(this.pc++);
        a = this.read(base) | (this.read((base + 1) & 0xFF) << 8);
        this.pageCross = (a & 0xFF00) !== ((a + this.y) & 0xFF00);
        return (a + this.y) & 0xFFFF;
      default: throw new Error('onbekende modus ' + mode);
    }
  }

  adc(v) {
    const c = this.p & FLAG_C;
    if (this.p & FLAG_D) {
      let lo = (this.a & 0x0F) + (v & 0x0F) + c;
      let hi = (this.a & 0xF0) + (v & 0xF0);
      if (lo > 9) { lo += 6; }
      if (lo > 0x0F) { hi += 0x10; }
      // Z wordt op NMOS uit het binaire resultaat bepaald, N en V uit het tussenresultaat
      const bin = (this.a + v + c) & 0xFF;
      this.setFlag(FLAG_Z, bin === 0);
      this.setFlag(FLAG_N, hi & 0x80);
      this.setFlag(FLAG_V, (~(this.a ^ v) & (this.a ^ hi)) & 0x80);
      if (hi > 0x90) hi += 0x60;
      this.setFlag(FLAG_C, hi > 0xFF);
      this.a = ((hi & 0xF0) | (lo & 0x0F)) & 0xFF;
    } else {
      const r = this.a + v + c;
      this.setFlag(FLAG_C, r > 0xFF);
      this.setFlag(FLAG_V, (~(this.a ^ v) & (this.a ^ r)) & 0x80);
      this.a = this.setNZ(r & 0xFF);
    }
  }

  sbc(v) {
    const borrow = (this.p & FLAG_C) ? 0 : 1;
    const r = this.a - v - borrow;
    // Vlaggen zijn op de NMOS 6502 ook in decimale modus die van de binaire bewerking
    this.setFlag(FLAG_C, r >= 0);
    this.setFlag(FLAG_V, ((this.a ^ v) & (this.a ^ r)) & 0x80);
    this.setNZ(r & 0xFF);
    if (this.p & FLAG_D) {
      let lo = (this.a & 0x0F) - (v & 0x0F) - borrow;
      let hi = (this.a & 0xF0) - (v & 0xF0);
      if (lo < 0) { lo -= 6; hi -= 0x10; }
      if (hi < 0) hi -= 0x60;
      this.a = ((hi & 0xF0) | (lo & 0x0F)) & 0xFF;
    } else {
      this.a = r & 0xFF;
    }
  }

  compare(reg, v) {
    const r = reg - v;
    this.setFlag(FLAG_C, r >= 0);
    this.setNZ(r & 0xFF);
  }

  branch(cond) {
    const off = this.read(this.pc++);
    if (cond) {
      const target = (this.pc + (off < 0x80 ? off : off - 0x100)) & 0xFFFF;
      this.cycles += ((target & 0xFF00) !== (this.pc & 0xFF00)) ? 2 : 1;
      this.pc = target;
    }
  }

  // Lees-wijzig-schrijf hulpfunctie voor geheugen of accumulator
  rmw(mode, fn) {
    if (mode === 'acc') { this.a = fn(this.a); return; }
    const a = this.addr(mode);
    const v = this.read(a);
    this.write(a, v); // NMOS schrijft de oude waarde eerst terug
    this.write(a, fn(v));
  }

  // Voert één instructie uit (of behandelt een interrupt) en geeft het aantal cycli terug.
  step() {
    const start = this.cycles;
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xFFFA, false);
      return this.cycles - start;
    }
    if (this.irqLine && !(this.p & FLAG_I)) {
      this.interrupt(0xFFFE, false);
      return this.cycles - start;
    }

    const opcode = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    const op = OPCODES[opcode];
    if (!op) {
      // Ongedocumenteerde opcode: als NOP van 1 byte behandelen
      this.lastOpcodeIllegal = true;
      this.cycles += 2;
      return 2;
    }
    this.lastOpcodeIllegal = false;
    this.pageCross = false;
    const mode = op.mode;
    let v;
    this.cycles += op.cycles;

    switch (op.mn) {
      case 'LDA': this.a = this.setNZ(mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode))); if (this.pageCross) this.cycles++; break;
      case 'LDX': this.x = this.setNZ(mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode))); if (this.pageCross) this.cycles++; break;
      case 'LDY': this.y = this.setNZ(mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode))); if (this.pageCross) this.cycles++; break;
      case 'STA': this.write(this.addr(mode), this.a); break;
      case 'STX': this.write(this.addr(mode), this.x); break;
      case 'STY': this.write(this.addr(mode), this.y); break;

      case 'ADC': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.adc(v); break;
      case 'SBC': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.sbc(v); break;
      case 'AND': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.a = this.setNZ(this.a & v); break;
      case 'ORA': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.a = this.setNZ(this.a | v); break;
      case 'EOR': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.a = this.setNZ(this.a ^ v); break;
      case 'CMP': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); if (this.pageCross) this.cycles++; this.compare(this.a, v); break;
      case 'CPX': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); this.compare(this.x, v); break;
      case 'CPY': v = mode === 'imm' ? this.read(this.pc++) : this.read(this.addr(mode)); this.compare(this.y, v); break;
      case 'BIT':
        v = this.read(this.addr(mode));
        this.p = (this.p & ~(FLAG_N | FLAG_V | FLAG_Z)) | (v & 0xC0) | ((this.a & v) === 0 ? FLAG_Z : 0);
        break;

      case 'ASL': this.rmw(mode, (x) => { this.setFlag(FLAG_C, x & 0x80); return this.setNZ((x << 1) & 0xFF); }); break;
      case 'LSR': this.rmw(mode, (x) => { this.setFlag(FLAG_C, x & 1); return this.setNZ(x >> 1); }); break;
      case 'ROL': this.rmw(mode, (x) => { const c = this.p & FLAG_C; this.setFlag(FLAG_C, x & 0x80); return this.setNZ(((x << 1) | c) & 0xFF); }); break;
      case 'ROR': this.rmw(mode, (x) => { const c = this.p & FLAG_C; this.setFlag(FLAG_C, x & 1); return this.setNZ((x >> 1) | (c << 7)); }); break;
      case 'INC': this.rmw(mode, (x) => this.setNZ((x + 1) & 0xFF)); break;
      case 'DEC': this.rmw(mode, (x) => this.setNZ((x - 1) & 0xFF)); break;

      case 'INX': this.x = this.setNZ((this.x + 1) & 0xFF); break;
      case 'INY': this.y = this.setNZ((this.y + 1) & 0xFF); break;
      case 'DEX': this.x = this.setNZ((this.x - 1) & 0xFF); break;
      case 'DEY': this.y = this.setNZ((this.y - 1) & 0xFF); break;
      case 'TAX': this.x = this.setNZ(this.a); break;
      case 'TAY': this.y = this.setNZ(this.a); break;
      case 'TXA': this.a = this.setNZ(this.x); break;
      case 'TYA': this.a = this.setNZ(this.y); break;
      case 'TSX': this.x = this.setNZ(this.s); break;
      case 'TXS': this.s = this.x; break;

      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.p | FLAG_B | FLAG_U); break;
      case 'PLA': this.a = this.setNZ(this.pull()); break;
      case 'PLP': this.p = (this.pull() & ~FLAG_B) | FLAG_U; break;

      case 'CLC': this.p &= ~FLAG_C; break;
      case 'SEC': this.p |= FLAG_C; break;
      case 'CLI': this.p &= ~FLAG_I; break;
      case 'SEI': this.p |= FLAG_I; break;
      case 'CLD': this.p &= ~FLAG_D; break;
      case 'SED': this.p |= FLAG_D; break;
      case 'CLV': this.p &= ~FLAG_V; break;

      case 'BCC': this.branch(!(this.p & FLAG_C)); break;
      case 'BCS': this.branch(this.p & FLAG_C); break;
      case 'BNE': this.branch(!(this.p & FLAG_Z)); break;
      case 'BEQ': this.branch(this.p & FLAG_Z); break;
      case 'BPL': this.branch(!(this.p & FLAG_N)); break;
      case 'BMI': this.branch(this.p & FLAG_N); break;
      case 'BVC': this.branch(!(this.p & FLAG_V)); break;
      case 'BVS': this.branch(this.p & FLAG_V); break;

      case 'JMP': this.pc = this.addr(mode); break;
      case 'JSR': {
        const target = this.read16(this.pc);
        const ret = (this.pc + 1) & 0xFFFF;
        this.push(ret >> 8);
        this.push(ret & 0xFF);
        this.pc = target;
        break;
      }
      case 'RTS': this.pc = ((this.pull() | (this.pull() << 8)) + 1) & 0xFFFF; break;
      case 'RTI':
        this.p = (this.pull() & ~FLAG_B) | FLAG_U;
        this.pc = this.pull() | (this.pull() << 8);
        break;
      case 'BRK':
        this.pc = (this.pc + 1) & 0xFFFF;
        this.cycles -= 7; // interrupt() telt de cycli
        this.interrupt(0xFFFE, true);
        break;
      case 'NOP': break;
      default: throw new Error('niet geïmplementeerd: ' + op.mn);
    }
    this.pc &= 0xFFFF;
    return this.cycles - start;
  }
}
