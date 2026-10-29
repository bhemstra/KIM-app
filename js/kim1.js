// De KIM-1 machine: geheugenindeling, twee 6530 RRIOT-chips, LED-display,
// keypad, SST-schakelaar, en een ingebouwde ("high level") monitor die de
// belangrijkste routines uit de originele KIM-ROM nabootst.
//
// Geheugenkaart (de KIM decodeert alleen A0-A12, dus 8K wordt gespiegeld):
//   $0000-$03FF  1K RAM
//   $0400-$13FF  optioneel uitbreidingsgeheugen
//   $1700-$173F  6530-003 I/O (vrij voor de gebruiker: PA=$1700, PB=$1702)
//   $1740-$177F  6530-002 I/O (display/keypad/TTY)
//   $1780-$17FF  RAM in de 6530's (o.a. interruptvectoren $17FA-$17FF)
//   $1800-$1FFF  ROM (monitor)
//   $2000-$DFFF  optioneel uitbreidingsgeheugen

import { CPU6502, FLAG_N, FLAG_Z } from './cpu6502.js';

// Zero-page locaties die de KIM-monitor gebruikt
export const Z = {
  PCL: 0xEF, PCH: 0xF0, PREG: 0xF1, SPUSER: 0xF2,
  ACC: 0xF3, YREG: 0xF4, XREG: 0xF5,
  INH: 0xF9, POINTL: 0xFA, POINTH: 0xFB,
};

// Tapeparameters in de 6530-RAM
export const TAPE = { SAL: 0x17F5, SAH: 0x17F6, EAL: 0x17F7, EAH: 0x17F8, ID: 0x17F9 };

// Bekende ROM-ingangen
export const ROM_ENTRY = {
  DUMPT: 0x1800, LOADT: 0x1873,
  SAVE: 0x1C00, NMIT: 0x1C1C, IRQT: 0x1C1F, RST: 0x1C22, START: 0x1C4F,
  PRTPNT: 0x1E1E, CRLF: 0x1E2F, PRTBYT: 0x1E3B, GETCH: 0x1E5A,
  OUTSP: 0x1E9E, OUTCH: 0x1EA0, DELAY: 0x1ED4, DEHALF: 0x1EEB,
  AK: 0x1EFE, SCAND: 0x1F19, SCANDS: 0x1F1F, KEYIN: 0x1F40,
  INCPT: 0x1F63, GETKEY: 0x1F6A, GETBYT: 0x1F9D, TABLE: 0x1FE7,
};

// Segmentpatronen voor 0-F (bit0=a ... bit6=g), zoals in de KIM-ROM
export const SEGMENT_TABLE = [
  0xBF, 0x86, 0xDB, 0xCF, 0xE6, 0xED, 0xFD, 0x87,
  0xFF, 0xEF, 0xF7, 0xFC, 0xB9, 0xDE, 0xF9, 0xF1,
];

// Keypadcodes zoals GETKEY ze teruggeeft
export const KEY = { AD: 0x10, DA: 0x11, PLUS: 0x12, GO: 0x13, PC: 0x14, NONE: 0x15 };

// 6530 RRIOT: twee 8-bit poorten met richtingsregisters plus een interval-timer.
class RIOT {
  constructor(machine, inputA, inputB) {
    this.m = machine;
    this.inputA = inputA; // () => byte op de pinnen van poort A (niet-aangestuurd = 1)
    this.inputB = inputB;
    this.reset();
  }

  reset() {
    this.pa = 0; this.padd = 0; this.pb = 0; this.pbdd = 0;
    this.timerStart = 0; this.timerInit = 0xFF; this.timerDiv = 1024;
    this.timerIrq = false;
  }

  // Effectieve uitgang van poort B: niet-aangestuurde pinnen lezen als 1
  outB() { return ((this.pb & this.pbdd) | (~this.pbdd & 0xFF)) & 0xFF; }

  timerElapsed() { return this.m.cpu.cycles - this.timerStart; }

  timedOut() {
    return this.timerElapsed() >= (this.timerInit + 1) * this.timerDiv;
  }

  timerValue() {
    const e = this.timerElapsed();
    const ticks = Math.floor(e / this.timerDiv);
    if (ticks <= this.timerInit) return this.timerInit - ticks;
    // Na het doorlopen van nul telt de timer per klokcyclus verder
    const after = e - (this.timerInit + 1) * this.timerDiv;
    return (0xFF - after) & 0xFF;
  }

  read(reg, peek = false) {
    if (reg & 0x04) {
      if (reg & 0x01) {
        // Statusregister: bit 7 = timer verlopen
        return this.timedOut() ? 0x80 : 0;
      }
      if (!peek) this.timerIrq = !!(reg & 0x08);
      return this.timerValue();
    }
    switch (reg & 0x03) {
      case 0: return ((this.pa & this.padd) | (this.inputA() & ~this.padd)) & 0xFF;
      case 1: return this.padd;
      case 2: return ((this.pb & this.pbdd) | (this.inputB() & ~this.pbdd)) & 0xFF;
      default: return this.pbdd;
    }
  }

  write(reg, v) {
    if (reg & 0x04) {
      this.timerInit = v;
      this.timerDiv = [1, 8, 64, 1024][reg & 0x03];
      this.timerIrq = !!(reg & 0x08);
      this.timerStart = this.m.cpu.cycles;
      return;
    }
    switch (reg & 0x03) {
      case 0: this.pa = v; break;
      case 1: this.padd = v; break;
      case 2: this.pb = v; break;
      default: this.pbdd = v; break;
    }
  }
}

export class KIM1 {
  constructor() {
    this.mem = new Uint8Array(0x10000);
    this.rom = new Uint8Array(0x800); // $1800-$1FFF
    this.cpu = new CPU6502(this);
    this.expanded = false;
    this.realRom = false; // true = een echte KIM-ROM is geladen, geen HLE-monitor
    this.sst = false;
    this.speed = 1; // veelvoud van 1 MHz

    this.keysDown = new Set(); // keypadcodes 0x00-0x14 die nu ingedrukt zijn
    this.ttyInput = [];
    this.onTTYOutput = null; // (string) => void
    this.onMonitorEnter = null;
    this.onTapeChange = null;
    this.tapes = []; // { id, start, data: number[] }

    // Display: per segment opgetelde "aan"-cycli sinds de laatste weergave
    this.segAcc = new Float64Array(6 * 7);
    this.dispLast = 0;
    this.dispDigit = -1;
    this.dispSegs = 0;
    this.lastFrameCycles = 0;
    this.lastImage = new Array(6).fill(0);

    this.riot002 = new RIOT(this, () => this.keypadInput(), () => 0xFF);
    this.riot003 = new RIOT(this, () => 0xFF, () => 0xFF);

    this.halted = false; // CPU staat stil in de HLE-monitor
    this.monitorMode = 'AD';
    this.buildHleRom();
    this.powerOn();
  }

  // ---------- ROM ----------

  buildHleRom() {
    const r = this.rom;
    r.fill(0x00);
    const put = (addr, bytes) => bytes.forEach((b, i) => { r[addr - 0x1800 + i] = b; });
    for (const addr of Object.values(ROM_ENTRY)) put(addr, [0x60]); // RTS, voor de disassembler
    put(ROM_ENTRY.NMIT, [0x6C, 0xFA, 0x17]); // JMP ($17FA)
    put(ROM_ENTRY.IRQT, [0x6C, 0xFE, 0x17]); // JMP ($17FE)
    put(ROM_ENTRY.TABLE, SEGMENT_TABLE);
    put(0x1FFA, [0x1C, 0x1C, 0x22, 0x1C, 0x1F, 0x1C]);
  }

  loadRealRom(bytes) {
    if (bytes.length !== 0x800) throw new Error('ROM moet 2048 bytes zijn ($1800-$1FFF)');
    this.rom.set(bytes);
    this.realRom = true;
  }

  useHleRom() {
    this.realRom = false;
    this.buildHleRom();
  }

  // ---------- Bus ----------

  read(addr, peek = false) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return this.mem[addr];
    const a = addr & 0x1FFF;
    if (a < 0x0400) return this.mem[a];
    if (a < 0x1400) return this.expanded ? this.mem[a] : 0xFF;
    if (a < 0x1700) return 0xFF;
    if (a < 0x1740) return this.riot003.read(a & 0x0F, peek);
    if (a < 0x1780) return this.riot002.read(a & 0x0F, peek);
    if (a < 0x1800) return this.mem[a];
    return this.rom[a - 0x1800];
  }

  peek(addr) { return this.read(addr & 0xFFFF, true); }

  write(addr, v) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) { this.mem[addr] = v; return; }
    const a = addr & 0x1FFF;
    if (a < 0x0400) { this.mem[a] = v; return; }
    if (a < 0x1400) { if (this.expanded) this.mem[a] = v; return; }
    if (a < 0x1700) return;
    if (a < 0x1740) { this.riot003.write(a & 0x0F, v); return; }
    if (a < 0x1780) {
      this.flushDisplay();
      this.riot002.write(a & 0x0F, v);
      this.updateDisplayLines();
      return;
    }
    if (a < 0x1800) { this.mem[a] = v; }
    // ROM: schrijven heeft geen effect
  }

  // Schrijven vanuit de gebruikersinterface (ook in ROM-bereik niet)
  poke(addr, v) { this.write(addr & 0xFFFF, v & 0xFF); }

  // ---------- Keypad ----------

  // Rij die via de 74145-decoder (PB1-PB4) geselecteerd is
  selectedLine() { return (this.riot002.outB() >> 1) & 0x0F; }

  keypadInput() {
    const line = this.selectedLine();
    let v = 0xFF; // PA7 = TTY-ingang (rust = 1); bij lijn 3 betekent PA0=1 "keypad-modus"
    if (line <= 2) {
      for (const k of this.keysDown) {
        if (Math.floor(k / 7) === line) v &= ~(1 << (6 - (k % 7)));
      }
    }
    return v;
  }

  keyDown(code) { this.keysDown.add(code); if (this.halted && !this.realRom) this.monitorKey(code); }
  keyUp(code) { this.keysDown.delete(code); }

  // Bitmasker zoals AK dat bepaalt (0 = geen toets)
  anyKeyMask() {
    let m = 0;
    for (const k of this.keysDown) m |= 1 << (6 - (k % 7));
    return m & 0x7F;
  }

  firstKey() {
    let best = KEY.NONE;
    for (const k of this.keysDown) if (k < best) best = k;
    return best;
  }

  // ST-toets: NMI
  stop() {
    if (this.halted) return;
    this.cpu.nmi();
  }

  // RS-toets: reset
  reset() {
    this.riot002.reset();
    this.riot003.reset();
    this.halted = false;
    this.cpu.reset();
  }

  powerOn() {
    this.mem.fill(0);
    // Gemak: de NMI- en IRQ-vectoren wijzen al naar de monitor ($1C00),
    // zodat ST, SST en BRK meteen werken. Op een echte KIM moest je dit intikken.
    this.mem[0x17FA] = 0x00; this.mem[0x17FB] = 0x1C;
    this.mem[0x17FE] = 0x00; this.mem[0x17FF] = 0x1C;
    this.mem[Z.SPUSER] = 0xFF;
    this.reset();
  }

  // ---------- Display ----------

  flushDisplay() {
    const now = this.cpu.cycles;
    const dt = now - this.dispLast;
    if (dt > 0 && this.dispDigit >= 0 && this.dispSegs) {
      for (let s = 0; s < 7; s++) if (this.dispSegs & (1 << s)) this.segAcc[this.dispDigit * 7 + s] += dt;
    }
    this.dispLast = now;
  }

  updateDisplayLines() {
    const line = this.selectedLine();
    const r = this.riot002;
    this.dispDigit = line >= 4 && line <= 9 ? line - 4 : -1;
    this.dispSegs = r.pa & r.padd & 0x7F;
  }

  // Direct segmenten oplichten (gebruikt door de HLE-routines)
  lightDigits(segs, cyclesPerDigit) {
    this.flushDisplay();
    for (let d = 0; d < 6; d++) {
      for (let s = 0; s < 7; s++) if (segs[d] & (1 << s)) this.segAcc[d * 7 + s] += cyclesPerDigit;
    }
  }

  // Geeft per cijfer een segmentmasker terug voor de huidige frame.
  displayImage() {
    if (this.halted && !this.realRom) {
      this.lastImage = this.monitorDisplay();
      this.segAcc.fill(0);
      this.lastFrameCycles = this.cpu.cycles;
      this.dispLast = this.cpu.cycles;
      return this.lastImage;
    }
    this.flushDisplay();
    const frame = this.cpu.cycles - this.lastFrameCycles;
    if (frame <= 0) return this.lastImage; // CPU gepauzeerd: laatste beeld vasthouden
    let max = 0;
    for (let i = 0; i < 42; i++) if (this.segAcc[i] > max) max = this.segAcc[i];
    const img = new Array(6).fill(0);
    // Een segment geldt als "aan" als het een redelijk deel van de tijd brandde
    const threshold = Math.max(frame * 0.01, max * 0.15);
    if (max > 0) {
      for (let d = 0; d < 6; d++) {
        for (let s = 0; s < 7; s++) if (this.segAcc[d * 7 + s] >= threshold) img[d] |= 1 << s;
      }
    }
    this.segAcc.fill(0);
    this.lastFrameCycles = this.cpu.cycles;
    this.lastImage = img;
    return img;
  }

  // ---------- HLE monitor ----------

  get point() { return this.mem[Z.POINTL] | (this.mem[Z.POINTH] << 8); }
  set point(v) { this.mem[Z.POINTL] = v & 0xFF; this.mem[Z.POINTH] = (v >> 8) & 0xFF; }

  hexSegs(b) { return [SEGMENT_TABLE[b >> 4] & 0x7F, SEGMENT_TABLE[b & 0x0F] & 0x7F]; }

  monitorDisplay() {
    const p = this.point;
    return [...this.hexSegs(p >> 8), ...this.hexSegs(p & 0xFF), ...this.hexSegs(this.peek(p))];
  }

  enterMonitor() {
    this.halted = true;
    this.monitorMode = 'AD';
    if (this.onMonitorEnter) this.onMonitorEnter();
  }

  monitorKey(code) {
    if (code < 0x10) {
      if (this.monitorMode === 'AD') {
        this.point = ((this.point << 4) | code) & 0xFFFF;
      } else {
        const p = this.point;
        this.poke(p, ((this.peek(p) << 4) | code) & 0xFF);
      }
      return;
    }
    switch (code) {
      case KEY.AD: this.monitorMode = 'AD'; break;
      case KEY.DA: this.monitorMode = 'DA'; break;
      case KEY.PLUS: this.point = (this.point + 1) & 0xFFFF; break;
      case KEY.PC: this.point = this.mem[Z.PCL] | (this.mem[Z.PCH] << 8); break;
      case KEY.GO: this.go(this.point); break;
    }
  }

  // GO: registers uit de zero page laden en het programma starten (zoals GOEXEC)
  go(addr) {
    const c = this.cpu;
    if (this.realRom) {
      c.pc = addr & 0xFFFF;
      this.halted = false;
      return;
    }
    this.mem[Z.PCL] = addr & 0xFF;
    this.mem[Z.PCH] = (addr >> 8) & 0xFF;
    c.s = this.mem[Z.SPUSER];
    c.p = this.mem[Z.PREG] | 0x20;
    c.a = this.mem[Z.ACC];
    c.x = this.mem[Z.XREG];
    c.y = this.mem[Z.YREG];
    c.pc = addr & 0xFFFF;
    c.cycles += 30;
    this.halted = false;
  }

  // ---------- Uitvoering ----------

  isRomAddress(addr) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return false;
    return (addr & 0x1FFF) >= 0x1800;
  }

  rts() {
    const c = this.cpu;
    c.pc = ((c.pull() | (c.pull() << 8)) + 1) & 0xFFFF;
  }

  ttyOut(str) { if (this.onTTYOutput) this.onTTYOutput(str); }

  hex2(b) { return b.toString(16).toUpperCase().padStart(2, '0'); }

  // Voert een HLE-ROM-routine uit. Geeft false als het adres geen bekende ingang is.
  trap(addr) {
    const c = this.cpu;
    const m = this.mem;
    const E = ROM_ENTRY;
    switch (addr) {
      case E.SAVE: {
        // Ingang na NMI/BRK: registers bewaren en naar de monitor
        m[Z.ACC] = c.a;
        m[Z.PREG] = c.pull();
        m[Z.PCL] = c.pull();
        m[Z.PCH] = c.pull();
        m[Z.YREG] = c.y;
        m[Z.XREG] = c.x;
        m[Z.SPUSER] = c.s;
        this.point = m[Z.PCL] | (m[Z.PCH] << 8);
        c.cycles += 40;
        this.enterMonitor();
        return true;
      }
      case E.RST:
        c.s = 0xFF;
        m[Z.SPUSER] = 0xFF;
        c.p |= 0x04;
        c.p &= ~0x08;
        this.enterMonitor();
        return true;
      case E.START:
        this.enterMonitor();
        return true;
      case E.SCAND:
        m[Z.INH] = this.read(this.point);
        // valt door naar SCANDS
      case E.SCANDS: {
        const segs = [...this.hexSegs(m[Z.POINTH]), ...this.hexSegs(m[Z.POINTL]), ...this.hexSegs(m[Z.INH])];
        this.lightDigits(segs, 640);
        c.cycles += 3900;
        this.akResult();
        this.rts();
        return true;
      }
      case E.AK:
      case E.KEYIN:
        c.cycles += 60;
        this.akResult();
        this.rts();
        return true;
      case E.GETKEY:
        c.a = c.setNZ(this.firstKey());
        c.cycles += 150;
        this.rts();
        return true;
      case E.INCPT:
        this.point = (this.point + 1) & 0xFFFF;
        c.cycles += 15;
        this.rts();
        return true;
      case E.OUTCH:
        this.ttyOut(String.fromCharCode(c.a & 0x7F));
        c.cycles += 10000; // ~ 1 teken bij 110 baud is veel trager; dit is een compromis
        this.rts();
        return true;
      case E.OUTSP:
        this.ttyOut(' ');
        c.cycles += 10000;
        this.rts();
        return true;
      case E.CRLF:
        this.ttyOut('\r\n');
        c.cycles += 20000;
        this.rts();
        return true;
      case E.PRTBYT:
        this.ttyOut(this.hex2(c.a));
        c.cycles += 20000;
        this.rts();
        return true;
      case E.PRTPNT:
        this.ttyOut(this.hex2(m[Z.POINTH]) + this.hex2(m[Z.POINTL]));
        c.cycles += 40000;
        this.rts();
        return true;
      case E.GETCH: {
        if (this.ttyInput.length === 0) { c.cycles += 100; return true; } // wachten
        const ch = this.ttyInput.shift();
        this.ttyOut(String.fromCharCode(ch.charCodeAt(0) & 0x7F)); // de KIM echoot elk teken
        c.a = c.setNZ(ch.charCodeAt(0) & 0x7F);
        c.cycles += 10000;
        this.rts();
        return true;
      }
      case E.GETBYT: {
        if (this.ttyInput.length < 2) { c.cycles += 100; return true; }
        const s = this.ttyInput.splice(0, 2).join('');
        this.ttyOut(s);
        const v = parseInt(s, 16);
        c.a = c.setNZ(Number.isNaN(v) ? 0 : v & 0xFF);
        c.cycles += 20000;
        this.rts();
        return true;
      }
      case E.DELAY:
      case E.DEHALF:
        c.cycles += 4500;
        this.rts();
        return true;
      case E.DUMPT:
        this.dumpTape();
        this.enterMonitor();
        return true;
      case E.LOADT:
        this.loadTape();
        this.enterMonitor();
        return true;
      default:
        return false;
    }
  }

  akResult() {
    const c = this.cpu;
    c.a = c.setNZ(this.anyKeyMask());
    c.x = 7; c.y = 7;
    // AK eindigt met EOR #$FF: Z/N volgen A
    c.p = (c.p & ~(FLAG_N | FLAG_Z)) | (c.a & 0x80) | (c.a === 0 ? FLAG_Z : 0);
  }

  dumpTape() {
    const sa = this.peek(TAPE.SAL) | (this.peek(TAPE.SAH) << 8);
    const ea = this.peek(TAPE.EAL) | (this.peek(TAPE.EAH) << 8);
    const id = this.peek(TAPE.ID);
    const data = [];
    for (let a = sa; a !== ea && data.length < 0x10000; a = (a + 1) & 0xFFFF) data.push(this.peek(a));
    this.tapes.push({ id, start: sa, data });
    this.cpu.cycles += data.length * 600;
    if (this.onTapeChange) this.onTapeChange();
  }

  loadTape() {
    const id = this.peek(TAPE.ID);
    const rec = this.tapes.find((t) => id === 0x00 || id === 0xFF || t.id === id);
    if (!rec) { this.point = 0xFFFF; return; }
    let start = rec.start;
    if (id === 0x00) start = this.peek(TAPE.SAL) | (this.peek(TAPE.SAH) << 8);
    rec.data.forEach((b, i) => this.poke(start + i, b));
    // KIM zet na het laden het eindadres in VEB-gebied; wij tonen 0000 als "gelukt"
    this.cpu.cycles += rec.data.length * 600;
    this.point = 0x0000;
  }

  // Voert ongeveer `budget` cycli uit. Geeft een reden terug als er gestopt werd.
  run(budget, breakpoints) {
    const c = this.cpu;
    const end = c.cycles + budget;
    while (c.cycles < end) {
      if (this.halted) return 'monitor';
      const pc = c.pc;
      if (!c.nmiPending && !this.realRom && this.isRomAddress(pc) && this.trap(pc & 0x1FFF)) {
        continue;
      }
      if (breakpoints && breakpoints.has(pc) && !this.skipBreak) {
        this.skipBreak = true;
        return 'breakpoint';
      }
      this.skipBreak = false;
      const wasNmi = c.nmiPending;
      c.step();
      // SST: na een instructie buiten $1C00-$1FFF volgt een NMI
      if (this.sst && !wasNmi && !this.isMonitorArea(pc)) c.nmi();
    }
    return null;
  }

  isMonitorArea(addr) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return false;
    return (addr & 0x1FFF) >= 0x1C00;
  }

  // Eén instructie uitvoeren (debugger)
  stepInstruction() {
    if (!this.halted) this.run(1, null);
  }
}
