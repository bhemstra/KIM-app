// PDP-11 processor, zoals de PDP-11/40 zonder geheugenbeheer (MMU):
// de volledige basisinstructieset plus EIS (MUL, DIV, ASH, ASHC), XOR, SOB,
// SXT, MARK en RTT. Alle getallen zijn 16 bit; adressen ook (de I/O-pagina
// ligt op 160000-177777).
//
// De bus levert read16/write16/read8/write8 en gooit een CpuTrap(4) bij een
// niet-bestaand adres. Verder: interruptRequest() -> apparaat met level,
// vector en ack(), resetDevices(), en optioneel onHalt(reden).

export const FLAG_C = 1, FLAG_V = 2, FLAG_Z = 4, FLAG_N = 8, FLAG_T = 0x10;

export class CpuTrap {
  constructor(vector, reason) {
    this.vector = vector;
    this.reason = reason;
  }
}

// Trapvectoren
export const VEC = { BUS: 0o4, ILLEGAL: 0o10, BPT: 0o14, IOT: 0o20, EMT: 0o30, TRAP: 0o34 };

const sx8 = (v) => (v & 0x80 ? v | 0xFF00 : v & 0xFF);
const s16 = (v) => (v & 0x8000 ? v - 0x10000 : v);

export class CPU11 {
  constructor(bus) {
    this.bus = bus;
    this.r = new Uint16Array(8);
    this.psw = 0;
    this.halted = true;
    this.waiting = false;
    this.haltReason = '';
    this.instructions = 0;
    this.rtiTrace = false;
  }

  reset() {
    this.psw = 0;
    this.waiting = false;
    this.rtiTrace = false;
  }

  halt(reason) {
    this.halted = true;
    this.waiting = false;
    this.haltReason = reason;
    if (this.bus.onHalt) this.bus.onHalt(reason);
  }

  // ---------- Geheugen ----------

  rw(a) {
    if (a & 1) throw new CpuTrap(VEC.BUS, 'woord op oneven adres');
    return this.bus.read16(a);
  }

  ww(a, v) {
    if (a & 1) throw new CpuTrap(VEC.BUS, 'woord op oneven adres');
    this.bus.write16(a, v & 0xFFFF);
  }

  fetch() {
    const v = this.rw(this.r[7]);
    this.r[7] = (this.r[7] + 2) & 0xFFFF;
    return v;
  }

  push(v) {
    this.r[6] = (this.r[6] - 2) & 0xFFFF;
    this.ww(this.r[6], v);
  }

  pop() {
    const v = this.rw(this.r[6]);
    this.r[6] = (this.r[6] + 2) & 0xFFFF;
    return v;
  }

  // Effectief adres. Registers worden gecodeerd als negatief getal (~reg).
  ea(mode, reg, byte) {
    const r = this.r;
    switch (mode) {
      case 0: return ~reg;
      case 1: return r[reg];
      case 2: {
        const a = r[reg];
        r[reg] = (a + (byte && reg < 6 ? 1 : 2)) & 0xFFFF;
        return a;
      }
      case 3: {
        const a = r[reg];
        r[reg] = (a + 2) & 0xFFFF;
        return this.rw(a);
      }
      case 4:
        r[reg] = (r[reg] - (byte && reg < 6 ? 1 : 2)) & 0xFFFF;
        return r[reg];
      case 5:
        r[reg] = (r[reg] - 2) & 0xFFFF;
        return this.rw(r[reg]);
      case 6: {
        const x = this.fetch();
        return (x + r[reg]) & 0xFFFF;
      }
      default: {
        const x = this.fetch();
        return this.rw((x + r[reg]) & 0xFFFF);
      }
    }
  }

  ld(a, byte) {
    if (a < 0) return byte ? this.r[~a] & 0xFF : this.r[~a];
    return byte ? this.bus.read8(a) : this.rw(a);
  }

  st(a, byte, v) {
    if (a < 0) {
      const n = ~a;
      this.r[n] = byte ? (this.r[n] & 0xFF00) | (v & 0xFF) : v & 0xFFFF;
    } else if (byte) this.bus.write8(a, v & 0xFF);
    else this.ww(a, v);
  }

  setCC(n, z, v, c) {
    this.psw = (this.psw & ~0xF) | (n ? FLAG_N : 0) | (z ? FLAG_Z : 0) | (v ? FLAG_V : 0) | (c ? FLAG_C : 0);
  }

  // N en Z volgens het resultaat, V gewist, C blijft
  setNZ(v, byte) {
    const sign = byte ? 0x80 : 0x8000;
    const mask = byte ? 0xFF : 0xFFFF;
    this.psw = (this.psw & ~(FLAG_N | FLAG_Z | FLAG_V)) | (v & sign ? FLAG_N : 0) | ((v & mask) === 0 ? FLAG_Z : 0);
  }

  // ---------- Traps en interrupts ----------

  trap(vector) {
    try {
      const pc = this.rw(vector);
      const ps = this.rw(vector + 2);
      this.push(this.psw);
      this.push(this.r[7]);
      this.r[7] = pc;
      this.psw = ps;
    } catch (e) {
      if (e instanceof CpuTrap) { this.halt('dubbele busfout (trap met ongeldige stack of vector)'); return; }
      throw e;
    }
  }

  // Eén instructie (of één interrupt) uitvoeren
  step() {
    if (this.halted) return;
    const dev = this.bus.interruptRequest();
    if (dev && dev.level > ((this.psw >> 5) & 7)) {
      dev.ack();
      this.waiting = false;
      this.trap(dev.vector);
      return;
    }
    if (this.waiting) return;

    // Trace: T aan het begin van een instructie geeft een trap erna. Na RTI met T
    // volgt de trap meteen; na RTT pas na de volgende instructie.
    const traced = (this.psw & FLAG_T) !== 0;
    this.rtiTrace = false;
    this.instructions++;
    try {
      this.execute(this.fetch());
    } catch (e) {
      if (!(e instanceof CpuTrap)) throw e;
      this.lastTrap = e.reason;
      this.trap(e.vector);
    }
    if ((traced || this.rtiTrace) && !this.halted) this.trap(VEC.BPT);
  }

  // ---------- Decodering ----------

  execute(op) {
    const r = this.r;
    const opc = (op >> 12) & 7;

    // Instructies met twee operanden
    if (opc >= 1 && opc <= 6) {
      const byte = (op & 0x8000) !== 0 && opc !== 6;
      const sa = this.ea((op >> 9) & 7, (op >> 6) & 7, byte);
      const s = this.ld(sa, byte);
      const da = this.ea((op >> 3) & 7, op & 7, byte);
      const mask = byte ? 0xFF : 0xFFFF;
      const sign = byte ? 0x80 : 0x8000;
      switch (opc) {
        case 1: // MOV(B)
          this.setNZ(s, byte);
          if (byte && da < 0) r[~da] = sx8(s);
          else this.st(da, byte, s);
          return;
        case 2: { // CMP(B)
          const d = this.ld(da, byte);
          const res = (s - d) & mask;
          this.setCC(res & sign, res === 0, (s ^ d) & (s ^ res) & sign, s < d);
          return;
        }
        case 3: { // BIT(B)
          this.setNZ(s & this.ld(da, byte), byte);
          return;
        }
        case 4: { // BIC(B)
          const res = this.ld(da, byte) & ~s & mask;
          this.st(da, byte, res);
          this.setNZ(res, byte);
          return;
        }
        case 5: { // BIS(B)
          const res = this.ld(da, byte) | s;
          this.st(da, byte, res);
          this.setNZ(res, byte);
          return;
        }
        default: { // ADD / SUB
          const d = this.ld(da, false);
          if (op & 0x8000) {
            const res = (d - s) & 0xFFFF;
            this.st(da, false, res);
            this.setCC(res & 0x8000, res === 0, (s ^ d) & (d ^ res) & 0x8000, d < s);
          } else {
            const sum = d + s;
            const res = sum & 0xFFFF;
            this.st(da, false, res);
            this.setCC(res & 0x8000, res === 0, ~(s ^ d) & (s ^ res) & 0x8000, sum > 0xFFFF);
          }
          return;
        }
      }
    }

    // 07xxxx: EIS, XOR, SOB
    if ((op & 0xF000) === 0x7000) {
      const reg = (op >> 6) & 7;
      const sub = (op >> 9) & 7;
      const m = (op >> 3) & 7, rr = op & 7;
      switch (sub) {
        case 0: { // MUL
          const src = s16(this.ld(this.ea(m, rr, false), false));
          const p = s16(r[reg]) * src;
          if (reg & 1) r[reg] = p & 0xFFFF;
          else { r[reg] = (p >> 16) & 0xFFFF; r[reg | 1] = p & 0xFFFF; }
          this.setCC(p < 0, p === 0, false, p < -32768 || p > 32767);
          return;
        }
        case 1: { // DIV
          const src = s16(this.ld(this.ea(m, rr, false), false));
          if (src === 0) { this.setCC(false, true, true, true); return; }
          const dd = ((r[reg] << 16) | r[reg | 1]) | 0;
          const q = Math.trunc(dd / src);
          if (q > 32767 || q < -32768) { this.setCC(false, false, true, false); return; }
          const rem = dd - q * src;
          r[reg] = q & 0xFFFF;
          r[reg | 1] = rem & 0xFFFF;
          this.setCC(q < 0, q === 0, false, false);
          return;
        }
        case 2: { // ASH
          let cnt = this.ld(this.ea(m, rr, false), false) & 0o77;
          if (cnt & 0o40) cnt -= 64;
          let v = r[reg], c = 0, ov = 0;
          if (cnt > 0) {
            for (let i = 0; i < cnt; i++) {
              c = (v >> 15) & 1;
              const nv = (v << 1) & 0xFFFF;
              if ((nv ^ v) & 0x8000) ov = 1;
              v = nv;
            }
          } else {
            for (let i = 0; i < -cnt; i++) { c = v & 1; v = (v >> 1) | (v & 0x8000); }
          }
          r[reg] = v;
          this.setCC(v & 0x8000, v === 0, ov, c);
          return;
        }
        case 3: { // ASHC
          let cnt = this.ld(this.ea(m, rr, false), false) & 0o77;
          if (cnt & 0o40) cnt -= 64;
          let v = reg & 1 ? ((r[reg] << 16) | r[reg]) >>> 0 : ((r[reg] << 16) | r[reg | 1]) >>> 0;
          let c = 0, ov = 0;
          if (cnt > 0) {
            for (let i = 0; i < cnt; i++) {
              c = v >>> 31;
              const nv = (v << 1) >>> 0;
              if ((nv ^ v) & 0x80000000) ov = 1;
              v = nv;
            }
          } else {
            for (let i = 0; i < -cnt; i++) { c = v & 1; v = ((v >>> 1) | (v & 0x80000000)) >>> 0; }
          }
          if (reg & 1) r[reg] = v & 0xFFFF;
          else { r[reg] = v >>> 16; r[reg | 1] = v & 0xFFFF; }
          this.setCC(v & 0x80000000, v === 0, ov, c);
          return;
        }
        case 4: { // XOR
          const da = this.ea(m, rr, false);
          const res = this.ld(da, false) ^ r[reg];
          this.st(da, false, res);
          this.setNZ(res, false);
          return;
        }
        case 7: // SOB
          r[reg] = (r[reg] - 1) & 0xFFFF;
          if (r[reg] !== 0) r[7] = (r[7] - 2 * (op & 0o77)) & 0xFFFF;
          return;
        default:
          throw new CpuTrap(VEC.ILLEGAL, 'instructie niet aanwezig op de 11/40 (FIS/CIS)');
      }
    }

    if (opc === 7) throw new CpuTrap(VEC.ILLEGAL, 'ongeldige instructie');

    // opc === 0: sprongen, enkele operanden en de rest
    const b15 = (op & 0x8000) !== 0;
    const low = op & 0x7FFF;

    if (low < 0o4000 && (b15 || low >= 0o400)) {
      const psw = this.psw;
      const n = (psw & FLAG_N) !== 0, z = (psw & FLAG_Z) !== 0, v = (psw & FLAG_V) !== 0, c = (psw & FLAG_C) !== 0;
      let take;
      switch (((op >> 8) & 7) | (b15 ? 8 : 0)) {
        case 1: take = true; break; // BR
        case 2: take = !z; break; // BNE
        case 3: take = z; break; // BEQ
        case 4: take = n === v; break; // BGE
        case 5: take = n !== v; break; // BLT
        case 6: take = !z && n === v; break; // BGT
        case 7: take = z || n !== v; break; // BLE
        case 8: take = !n; break; // BPL
        case 9: take = n; break; // BMI
        case 10: take = !c && !z; break; // BHI
        case 11: take = c || z; break; // BLOS
        case 12: take = !v; break; // BVC
        case 13: take = v; break; // BVS
        case 14: take = !c; break; // BCC
        default: take = c; break; // BCS
      }
      if (take) r[7] = (r[7] + 2 * s16(sx8(op & 0xFF))) & 0xFFFF;
      return;
    }

    if (!b15 && low < 0o400) {
      if (op < 0o100) {
        switch (op) {
          case 0: // HALT
            this.halt('HALT-instructie');
            return;
          case 1: this.waiting = true; return; // WAIT
          case 2: case 6: // RTI, RTT
            r[7] = this.pop();
            this.psw = this.pop();
            this.rtiTrace = op === 2 && (this.psw & FLAG_T) !== 0;
            return;
          case 3: throw new CpuTrap(VEC.BPT, 'BPT');
          case 4: throw new CpuTrap(VEC.IOT, 'IOT');
          case 5: this.bus.resetDevices(); return; // RESET
          default: throw new CpuTrap(VEC.ILLEGAL, 'ongeldige instructie');
        }
      }
      if (op < 0o200) { // JMP
        if ((op & 0o70) === 0) throw new CpuTrap(VEC.ILLEGAL, 'JMP naar een register');
        r[7] = this.ea((op >> 3) & 7, op & 7, false);
        return;
      }
      if (op < 0o210) { // RTS
        const reg = op & 7;
        r[7] = r[reg];
        r[reg] = this.pop();
        return;
      }
      if (op < 0o240) throw new CpuTrap(VEC.ILLEGAL, 'instructie niet aanwezig op de 11/40 (SPL)');
      if (op < 0o300) { // CLx / SEx
        if (op & 0o20) this.psw |= op & 0xF;
        else this.psw &= ~(op & 0xF);
        return;
      }
      // SWAB
      const da = this.ea((op >> 3) & 7, op & 7, false);
      const d = this.ld(da, false);
      const res = ((d >> 8) | (d << 8)) & 0xFFFF;
      this.st(da, false, res);
      this.setCC(res & 0x80, (res & 0xFF) === 0, false, false);
      return;
    }

    if (!b15 && low < 0o5000) { // JSR
      if ((op & 0o70) === 0) throw new CpuTrap(VEC.ILLEGAL, 'JSR naar een register');
      const reg = (op >> 6) & 7;
      const dst = this.ea((op >> 3) & 7, op & 7, false);
      this.push(r[reg]);
      r[reg] = r[7];
      r[7] = dst;
      return;
    }

    if (b15 && low >= 0o4000 && low < 0o5000) { // EMT / TRAP
      throw new CpuTrap(low < 0o4400 ? VEC.EMT : VEC.TRAP, low < 0o4400 ? 'EMT' : 'TRAP');
    }

    if (low >= 0o5000 && low < 0o7000) {
      const group = (op >> 6) & 0o77;
      const m = (op >> 3) & 7, rr = op & 7;
      if (group >= 0o64) {
        if (b15) throw new CpuTrap(VEC.ILLEGAL, 'instructie niet aanwezig op de 11/40');
        switch (group) {
          case 0o64: // MARK
            r[6] = (r[7] + 2 * (op & 0o77)) & 0xFFFF;
            r[7] = r[5];
            r[5] = this.pop();
            return;
          case 0o65: { // MFPI (zonder MMU: zelfde adresruimte)
            const v = this.ld(this.ea(m, rr, false), false);
            this.push(v);
            this.setNZ(v, false);
            return;
          }
          case 0o66: { // MTPI
            const v = this.pop();
            this.st(this.ea(m, rr, false), false, v);
            this.setNZ(v, false);
            return;
          }
          default: { // SXT
            const n = (this.psw & FLAG_N) !== 0;
            this.st(this.ea(m, rr, false), false, n ? 0xFFFF : 0);
            this.setCC(n, !n, false, (this.psw & FLAG_C) !== 0);
            return;
          }
        }
      }
      const byte = b15;
      const mask = byte ? 0xFF : 0xFFFF;
      const sign = byte ? 0x80 : 0x8000;
      const da = this.ea(m, rr, byte);
      const cOld = this.psw & FLAG_C;
      let res, c = cOld !== 0, v = false;
      if (group === 0o50) { // CLR
        this.st(da, byte, 0);
        this.setCC(false, true, false, false);
        return;
      }
      const d = this.ld(da, byte);
      switch (group) {
        case 0o51: res = ~d & mask; c = true; break; // COM
        case 0o52: res = (d + 1) & mask; v = d === sign - 1; break; // INC
        case 0o53: res = (d - 1) & mask; v = d === sign; break; // DEC
        case 0o54: res = -d & mask; v = res === sign; c = res !== 0; break; // NEG
        case 0o55: res = (d + (cOld ? 1 : 0)) & mask; v = d === sign - 1 && !!cOld; c = d === mask && !!cOld; break; // ADC
        case 0o56: res = (d - (cOld ? 1 : 0)) & mask; v = d === sign; c = d === 0 && !!cOld; break; // SBC
        case 0o57: // TST
          this.setCC(d & sign, d === 0, false, false);
          return;
        case 0o60: res = (d >> 1) | (cOld ? sign : 0); c = (d & 1) !== 0; break; // ROR
        case 0o61: res = ((d << 1) | (cOld ? 1 : 0)) & mask; c = (d & sign) !== 0; break; // ROL
        case 0o62: res = (d >> 1) | (d & sign); c = (d & 1) !== 0; break; // ASR
        default: res = (d << 1) & mask; c = (d & sign) !== 0; break; // ASL
      }
      if (group >= 0o60) v = ((res & sign) !== 0) !== c;
      this.st(da, byte, res);
      this.setCC(res & sign, res === 0, v, c);
      return;
    }

    throw new CpuTrap(VEC.ILLEGAL, 'ongeldige instructie');
  }
}
