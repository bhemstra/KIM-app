// Gemeenschappelijke basis voor 6502-eenbordscomputers met een gemultiplext
// zescijferig LED-display en een hexadecimaal keypad (KIM-1, Junior Computer).
//
// Een subklasse levert: read/write (geheugenkaart), displayPorts(), trap(addr)
// voor de nagebootste monitorroutines, monitorKey()/monitorDisplay() en powerOn().

import { CPU6502, FLAG_N, FLAG_Z } from './cpu6502.js';

// Zero-page locaties die zowel de KIM- als de Junior-monitor gebruikt
export const Z = {
  PCL: 0xEF, PCH: 0xF0, PREG: 0xF1, SPUSER: 0xF2,
  ACC: 0xF3, YREG: 0xF4, XREG: 0xF5,
  INH: 0xF9, POINTL: 0xFA, POINTH: 0xFB,
};

// Keypadcodes zoals GETKEY ze teruggeeft (gelijk op beide machines)
export const KEY = { AD: 0x10, DA: 0x11, PLUS: 0x12, GO: 0x13, PC: 0x14, NONE: 0x15 };

// Segmentpatronen voor 0-F (bit0=a ... bit6=g), actief hoog
export const HEX_SEGMENTS = [
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,
  0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71,
];

export class Board {
  constructor({ romStart, romSize }) {
    this.mem = new Uint8Array(0x10000);
    this.romStart = romStart;
    this.rom = new Uint8Array(romSize);
    this.cpu = new CPU6502(this);
    this.expanded = false;
    this.realRom = false; // true = een echte ROM-dump is geladen, geen nagebootste monitor
    this.sst = false;
    this.speed = 1; // veelvoud van 1 MHz
    this.riots = [];

    this.keysDown = new Set(); // keypadcodes 0x00-0x14 die nu ingedrukt zijn

    // Display: per segment opgetelde "aan"-cycli sinds de laatste weergave
    this.segAcc = new Float64Array(6 * 7);
    this.dispLast = 0;
    this.dispDigit = -1;
    this.dispSegs = 0;
    this.lastFrameCycles = 0;
    this.lastImage = new Array(6).fill(0);

    this.halted = false; // CPU staat stil in de nagebootste monitor
    this.monitorMode = 'AD';
  }

  // ---------- ROM ----------

  loadRealRom(bytes) {
    if (bytes.length !== this.rom.length) {
      throw new Error(`ROM moet ${this.rom.length} bytes zijn ($${this.romStart.toString(16).toUpperCase()}-$1FFF)`);
    }
    this.rom.set(bytes);
    this.realRom = true;
  }

  useHleRom() {
    this.realRom = false;
    this.buildHleRom();
  }

  peek(addr) { return this.read(addr & 0xFFFF, true); }

  // Schrijven vanuit de gebruikersinterface (in ROM-bereik zonder effect)
  poke(addr, v) { this.write(addr & 0xFFFF, v & 0xFF); }

  isRomAddress(addr) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return false;
    return (addr & 0x1FFF) >= this.romStart;
  }

  // Bij SST volgt een NMI na elke instructie buiten $1C00-$1FFF
  isMonitorArea(addr) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return false;
    return (addr & 0x1FFF) >= 0x1C00;
  }

  // ---------- Keypad ----------

  // Lijn die via de 74145-decoder (PB1-PB4) geselecteerd is: 0-2 = keypadrijen, 4-9 = cijfers
  selectedLine() { return (this.keypadRiot().outB() >> 1) & 0x0F; }

  keypadInput() {
    const line = this.selectedLine();
    let v = 0xFF;
    if (line <= 2) {
      for (const k of this.keysDown) {
        if (Math.floor(k / 7) === line) v &= ~(1 << (6 - (k % 7)));
      }
    }
    return v;
  }

  keyDown(code) {
    this.keysDown.add(code);
    if (this.halted && !this.realRom) this.monitorKey(code);
  }

  keyUp(code) {
    this.keysDown.delete(code);
    if (this.halted && !this.realRom && this.monitorKeyUp) this.monitorKeyUp(code);
  }

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

  // RS/RST-toets: reset
  reset() {
    for (const r of this.riots) r.reset();
    this.halted = false;
    this.cpu.irqLine = false;
    this.cpu.reset();
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
    this.dispDigit = line >= 4 && line <= 9 ? line - 4 : -1;
    this.dispSegs = this.displayPorts();
  }

  // Direct segmenten oplichten (gebruikt door de nagebootste routines)
  lightDigits(segs, cyclesPerDigit) {
    this.flushDisplay();
    for (let d = 0; d < 6; d++) {
      for (let s = 0; s < 7; s++) if (segs[d] & (1 << s)) this.segAcc[d * 7 + s] += cyclesPerDigit;
    }
  }

  hexSegs(b) { return [HEX_SEGMENTS[b >> 4], HEX_SEGMENTS[b & 0x0F]]; }

  // Geeft per cijfer een segmentmasker (actief hoog) terug voor de huidige frame.
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

  // ---------- Monitor ----------

  get point() { return this.mem[Z.POINTL] | (this.mem[Z.POINTH] << 8); }
  set point(v) { this.mem[Z.POINTL] = v & 0xFF; this.mem[Z.POINTH] = (v >> 8) & 0xFF; }

  // Ingang na NMI/BRK: registers in de zero page bewaren (zoals SAVE in beide ROM's)
  saveRegisters() {
    const c = this.cpu;
    const m = this.mem;
    m[Z.ACC] = c.a;
    m[Z.PREG] = c.pull();
    m[Z.PCL] = c.pull();
    m[Z.PCH] = c.pull();
    m[Z.YREG] = c.y;
    m[Z.XREG] = c.x;
    m[Z.SPUSER] = c.s;
    this.point = m[Z.PCL] | (m[Z.PCH] << 8);
    c.cycles += 40;
  }

  // GO: registers uit de zero page laden en het programma starten (zoals GOEXEC)
  go(addr) {
    const c = this.cpu;
    this.halted = false;
    if (this.realRom) {
      c.pc = addr & 0xFFFF;
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
  }

  rts() {
    const c = this.cpu;
    c.pc = ((c.pull() | (c.pull() << 8)) + 1) & 0xFFFF;
  }

  setNZ(v) {
    const c = this.cpu;
    c.p = (c.p & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | ((v & 0xFF) === 0 ? FLAG_Z : 0);
  }

  // ---------- Uitvoering ----------

  // Voert ongeveer `budget` cycli uit. Geeft een reden terug als er gestopt werd.
  run(budget, breakpoints) {
    const c = this.cpu;
    const end = c.cycles + budget;
    const irqRiot = this.irqRiot;
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
      if (irqRiot) c.irqLine = irqRiot.irqActive();
      const wasNmi = c.nmiPending;
      c.step();
      if (this.sst && !wasNmi && !this.isMonitorArea(pc)) c.nmi();
    }
    return null;
  }

  // Eén instructie uitvoeren (debugger)
  stepInstruction() {
    if (!this.halted) this.run(1, null);
  }
}
