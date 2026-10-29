// De Elektor (Elektuur) Junior Computer (1980): een KIM-1-achtige computer met
// een 6532 RIOT en een 1K-monitor in EPROM.
//
// Geheugenkaart (alleen A0-A12 worden gedecodeerd, dus 8K wordt gespiegeld):
//   $0000-$03FF  1K RAM
//   $1A00-$1A7F  RAM in de 6532 (o.a. NMI-vector $1A7A, IRQ-vector $1A7E)
//   $1A80-$1AFF  6532 I/O: PAD=$1A80, PADD=$1A81, PBD=$1A82, PBDD=$1A83, timer
//   $1C00-$1FFF  monitor-EPROM
//
// Het display hangt aan poort A (segmenten, actief laag) en poort B (PB1-PB4
// kiezen via een 74145 het cijfer of de keypadrij), net als bij de KIM-1.
//
// Zonder ROM-dump bootst de emulator de monitor na: de keypadmonitor, de
// hex-editor ($1CB5), de assembler ($1F51), de sprongberekening ($1FD5) en de
// subroutines die programma's aanroepen (SCAND, SCANDS, AK, GETKEY, SHOW, ...).
// Adressen en werking volgen de gepubliceerde monitorlisting van A. Nachtmann.

import { Board, Z, KEY, HEX_SEGMENTS } from './board.js';
import { RIOT } from './riot.js';
import { FLAG_C, FLAG_D, FLAG_I } from './cpu6502.js';

export { Z, KEY };

// Extra zero-page locaties van de Junior-monitor
export const JZ = {
  KEY: 0xE1, BEGADL: 0xE2, BEGADH: 0xE3, ENDADL: 0xE4, ENDADH: 0xE5,
  CURADL: 0xE6, CURADH: 0xE7, CENDL: 0xE8, CENDH: 0xE9,
  MOVADL: 0xEA, MOVADH: 0xEB, TABLEL: 0xEC, TABLEH: 0xED, LABELS: 0xEE,
  BYTES: 0xF6, COUNT: 0xF7, INL: 0xF8,
  TEMP: 0xFC, TEMPX: 0xFD, NIBBLE: 0xFE, MODE: 0xFF,
};

export const VECTORS = { NMIL: 0x1A7A, NMIH: 0x1A7B, IRQL: 0x1A7E, IRQH: 0x1A7F };

export const ROM_ENTRY = {
  SAVE: 0x1C00, RESET: 0x1C1D, START: 0x1C33, STARA: 0x1C38,
  EDITOR: 0x1CB5, SCAN: 0x1D4D, SCANA: 0x1D5C, GETBYT: 0x1D6F,
  SCAND: 0x1D88, SCANDS: 0x1D8E, AK: 0x1DB1, ONEKEY: 0x1DB5,
  SHOW: 0x1DCC, CONVD: 0x1DDF, GETKEY: 0x1DF9, RDINST: 0x1E20,
  FILLWS: 0x1E47, OPLEN: 0x1E5C, LENACC: 0x1E60, UP: 0x1E83, DOWN: 0x1EA6,
  BEGIN: 0x1ED3, ADCEND: 0x1EDC, RECEND: 0x1EEA, NEXT: 0x1EF8,
  LOOK: 0x1F0F, LEN: 0x1F1F, NMI: 0x1F2F, IRQ: 0x1F32, GETLBL: 0x1F35,
  ASSEMB: 0x1F51, BRANCH: 0x1FD5,
};

// Segmentpatronen 0-F zoals de Junior ze uitstuurt (actief laag)
export const LOOK = HEX_SEGMENTS.map((s) => ~s & 0x7F);

// Instructielengte per laagste vier bits van de opcode (tabel LEN in de monitor)
const LEN = [2, 2, 2, 1, 2, 2, 2, 1, 1, 2, 1, 1, 3, 3, 3, 3];

const RIOT_BASE = 0x1A80;

export class Junior extends Board {
  constructor() {
    super({ romStart: 0x1C00, romSize: 0x400 });
    this.riot = new RIOT(this, { variant: '6532', inputA: () => this.keypadInput() });
    this.riots = [this.riot];
    this.irqRiot = this.riot; // de IRQ-uitgang van de 6532 hangt aan de IRQ van de 6502
    this.task = null; // nagebootste monitortaak die op toetsen wacht
    this.taskKind = null;
    this.taskDisplay = 'scand';
    this.buildHleRom();
    this.powerOn();
  }

  // ---------- ROM ----------

  buildHleRom() {
    const r = this.rom;
    r.fill(0x00); // BRK: onbekende ingangen keren via de IRQ-vector terug naar de monitor
    const put = (addr, bytes) => bytes.forEach((b, i) => { r[addr - 0x1C00 + i] = b; });
    for (const addr of Object.values(ROM_ENTRY)) put(addr, [0x60]); // RTS, voor de disassembler
    put(ROM_ENTRY.LOOK, LOOK);
    put(ROM_ENTRY.LEN, LEN);
    put(ROM_ENTRY.NMI, [0x6C, 0x7A, 0x1A]); // JMP ($1A7A)
    put(ROM_ENTRY.IRQ, [0x6C, 0x7E, 0x1A]); // JMP ($1A7E)
    put(0x1FFA, [0x2F, 0x1F, 0x1D, 0x1C, 0x32, 0x1F]);
  }

  // ---------- Bus ----------

  isRam(addr) {
    if (addr >= 0x2000 && addr < 0xE000) return this.expanded;
    const a = addr & 0x1FFF;
    return a < 0x0400 || (this.expanded && a < 0x1A00) || (a >= 0x1A00 && a < 0x1A80);
  }

  read(addr, peek = false) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) return this.mem[addr];
    const a = addr & 0x1FFF;
    if (a < 0x0400) return this.mem[a];
    if (a < 0x1A00) return this.expanded ? this.mem[a] : 0xFF;
    if (a < 0x1A80) return this.mem[a];
    if (a < 0x1B00) return this.riot.read(a & 0x1F, peek);
    if (a < 0x1C00) return 0xFF;
    return this.rom[a - 0x1C00];
  }

  write(addr, v) {
    if (this.expanded && addr >= 0x2000 && addr < 0xE000) { this.mem[addr] = v; return; }
    const a = addr & 0x1FFF;
    if (a < 0x0400) { this.mem[a] = v; return; }
    if (a < 0x1A00) { if (this.expanded) this.mem[a] = v; return; }
    if (a < 0x1A80) { this.mem[a] = v; return; }
    if (a < 0x1B00) {
      this.flushDisplay();
      this.riot.write(a & 0x1F, v);
      this.updateDisplayLines();
    }
  }

  keypadRiot() { return this.riot; }

  // Segmenten zijn actief laag: een segment brandt als de pin uitgang is en 0 uitstuurt
  displayPorts() {
    const r = this.riot;
    return ~r.pa & r.padd & 0x7F;
  }

  powerOn() {
    this.mem.fill(0);
    // Gemak: NMI- en IRQ-vector wijzen al naar SAVE ($1C00), zoals de handleiding
    // beginners aanraadt. Op een echte Junior moest je dit zelf intikken.
    this.mem[VECTORS.NMIL] = 0x00; this.mem[VECTORS.NMIH] = 0x1C;
    this.mem[VECTORS.IRQL] = 0x00; this.mem[VECTORS.IRQH] = 0x1C;
    this.reset();
  }

  reset() {
    this.task = null;
    this.taskKind = null;
    super.reset();
  }

  // ---------- Hulpjes voor de zero page ----------

  z(a) { return this.mem[a]; }
  setZ(a, v) { this.mem[a] = v & 0xFF; }
  word(lo) { return this.mem[lo] | (this.mem[lo + 1] << 8); }
  setWord(lo, v) { this.mem[lo] = v & 0xFF; this.mem[lo + 1] = (v >> 8) & 0xFF; }

  get monitorLabel() {
    if (this.taskKind === 'monitor') return 'MONITOR ' + (this.z(JZ.MODE) ? 'AD' : 'DA');
    return { editor: 'EDITOR', branch: 'BRANCH', wait: 'WACHT OP TOETS' }[this.taskKind] || 'MONITOR';
  }

  // Na het laden van een programma: adres tonen in de monitor
  showAddress(addr) {
    this.point = addr;
    if (this.taskKind === 'monitor') this.setZ(JZ.MODE, 3);
  }

  // ---------- Display van de nagebootste monitor ----------

  monitorDisplay() {
    if (this.taskDisplay === 'scand') this.setZ(Z.INH, this.peek(this.point));
    const bytes = this.z(JZ.BYTES);
    const shown = bytes === 1 ? 1 : bytes === 2 ? 2 : 3; // zoals SCANDS met DEY/BEQ
    const buf = [this.z(Z.POINTH), this.z(Z.POINTL), this.z(Z.INH)];
    const img = [];
    for (let i = 0; i < 3; i++) img.push(...(i < shown ? this.hexSegs(buf[i]) : [0, 0]));
    return img;
  }

  // ---------- Taken: monitorcode die op het keypad wacht ----------
  // Een taak is een generator die 'release' (wacht tot alle toetsen los zijn)
  // of 'press' (wacht op een toets) oplevert. Zolang er een taak loopt staat de CPU stil.

  startTask(kind, gen, onDone) {
    this.task = { gen, wait: null, onDone };
    this.taskKind = kind;
    this.halted = true;
    this.advanceTask(undefined);
  }

  advanceTask(value) {
    let v = value;
    for (;;) {
      const t = this.task;
      if (!t) return;
      const r = t.gen.next(v);
      if (r.done) {
        if (this.task === t) { this.task = null; this.taskKind = null; }
        if (t.onDone) t.onDone(r.value);
        return;
      }
      t.wait = r.value;
      if (t.wait === 'release' && this.keysDown.size === 0) { v = undefined; continue; }
      return;
    }
  }

  monitorKey() {
    if (this.task && this.task.wait === 'press') this.advanceTask(this.firstKey());
  }

  monitorKeyUp() {
    if (this.task && this.task.wait === 'release' && this.keysDown.size === 0) this.advanceTask(undefined);
  }

  // SCANA: wacht tot de toetsen los zijn, dan op een nieuwe toets; geeft de toetscode
  * scanA() {
    yield 'release';
    return yield 'press';
  }

  // SCAN: instructie op CURAD in de displaybuffer, lengte in BYTES, dan SCANA
  * scan() {
    const cur = this.word(JZ.CURADL);
    for (let x = 2, y = 0; x >= 0; x--, y++) this.setZ(Z.INH + x, this.read((cur + y) & 0xFFFF));
    this.oplen();
    return yield* this.scanA();
  }

  // GETBYT: twee hextoetsen tot een byte; { a, n } met n=true als het gelukt is
  * getByt() {
    const hi = yield* this.scanA();
    if (hi >= 0x10) return { a: hi, n: false };
    this.setZ(JZ.NIBBLE, hi << 4);
    const lo = yield* this.scanA();
    if (lo >= 0x10) return { a: lo, n: false };
    return { a: lo | this.z(JZ.NIBBLE), n: true };
  }

  // RDINST: een hele instructie intikken in de displaybuffer
  * rdInst() {
    let r = yield* this.getByt();
    if (!r.n) return r;
    this.setZ(Z.POINTH, r.a);
    const len = this.lenAcc(r.a);
    this.setZ(JZ.COUNT, len);
    this.setZ(JZ.TEMPX, len);
    for (const dest of [Z.POINTL, Z.INH]) {
      this.setZ(JZ.COUNT, this.z(JZ.COUNT) - 1);
      if (this.z(JZ.COUNT) === 0) break;
      r = yield* this.getByt();
      if (!r.n) return r;
      this.setZ(dest, r.a);
    }
    return { a: r.a, n: true };
  }

  // De keypadmonitor (START)
  * monitorTask() {
    this.taskDisplay = 'scand';
    for (;;) {
      const key = yield* this.scanA();
      if (key === KEY.GO) return 'go';
      if (key === KEY.AD) this.setZ(JZ.MODE, 3);
      else if (key === KEY.DA) this.setZ(JZ.MODE, 0);
      else if (key === KEY.PLUS) this.point = (this.point + 1) & 0xFFFF;
      else if (key === KEY.PC) { this.setZ(Z.POINTL, this.z(Z.PCL)); this.setZ(Z.POINTH, this.z(Z.PCH)); }
      else if (key < 0x10) {
        this.setZ(JZ.KEY, key);
        if (this.z(JZ.MODE) === 0) {
          const p = this.point;
          this.write(p, ((this.read(p) << 4) | key) & 0xFF);
        } else {
          this.point = ((this.point << 4) | key) & 0xFFFF;
        }
      }
    }
  }

  startMonitor() {
    this.startTask('monitor', this.monitorTask(), () => this.goExec());
  }

  // GOEXEC: registers herstellen en het programma op POINT starten
  goExec() {
    const c = this.cpu;
    c.s = this.z(Z.SPUSER);
    c.p = this.z(Z.PREG) | 0x20;
    c.x = this.z(Z.XREG);
    c.y = this.z(Z.YREG);
    c.a = this.z(Z.ACC);
    c.pc = this.point;
    c.cycles += 30;
    this.halted = false;
  }

  go(addr) {
    this.task = null;
    this.taskKind = null;
    if (this.realRom) { super.go(addr); return; }
    this.point = addr;
    this.goExec();
  }

  // De hex-editor ($1CB5). Toetsen: AD = insert, GO = input, + = skip, DA = delete, PC = search.
  * editorTask() {
    this.taskDisplay = 'scands';
    this.begin();
    this.setWord(JZ.CENDL, (this.word(JZ.BEGADL) + 1) & 0xFFFF);
    this.write(this.word(JZ.CURADL), 0x77);
    let key = yield* this.scan();
    for (;;) {
      let ok = true;
      if (key === KEY.PC) { // SEARCH
        let r = yield* this.getByt();
        if (!r.n) { key = r.a; continue; }
        this.setZ(Z.POINTH, r.a);
        r = yield* this.getByt();
        if (!r.n) { key = r.a; continue; }
        this.setZ(Z.POINTL, r.a);
        this.begin();
        ok = false;
        for (let guard = 0; guard < 0x10000; guard++) {
          const cur = this.word(JZ.CURADL);
          if (this.read(cur) === this.z(Z.POINTH) && this.read((cur + 1) & 0xFFFF) === this.z(Z.POINTL)) { ok = true; break; }
          this.oplen();
          if (!this.next()) break;
        }
      } else if (key === KEY.AD) { // INSERT
        const r = yield* this.rdInst();
        if (!r.n) { key = r.a; continue; }
        this.fillWs();
      } else if (key === KEY.GO) { // INPUT
        const r = yield* this.rdInst();
        if (!r.n) { key = r.a; continue; }
        this.oplen();
        this.next();
        this.setZ(JZ.BYTES, this.z(JZ.TEMPX));
        this.fillWs();
      } else if (key === KEY.PLUS) { // SKIP
        ok = this.next();
      } else if (key === KEY.DA) { // DELETE
        this.up();
        this.recEnd();
      } else {
        ok = false;
      }
      if (!ok) {
        // ERRA: "EEEEEE" zolang de toets is ingedrukt
        this.setZ(Z.POINTH, 0xEE); this.setZ(Z.POINTL, 0xEE); this.setZ(Z.INH, 0xEE);
        this.setZ(JZ.BYTES, 3);
        yield 'release';
      }
      key = yield* this.scan();
    }
  }

  // BRANCH ($1FD5): toont de sprongafstand van bron (links) naar doel (midden)
  * branchTask() {
    this.taskDisplay = 'scands';
    this.cpu.p &= ~FLAG_D;
    for (;;) {
      this.setZ(Z.POINTH, 0); this.setZ(Z.POINTL, 0); this.setZ(Z.INH, 0);
      for (;;) {
        let r = yield* this.getByt();
        if (!r.n) break;
        this.setZ(Z.POINTH, r.a);
        r = yield* this.getByt();
        if (!r.n) break;
        this.setZ(Z.POINTL, r.a);
        this.setZ(Z.INH, this.z(Z.POINTL) - this.z(Z.POINTH) - 2);
      }
    }
  }

  // ---------- Subroutines van de editor en de assembler ----------

  lenAcc(op) {
    let len;
    if (op === 0x00 || op === 0x40 || op === 0x60) len = 1;
    else if (op === 0x20 || (op & 0x1F) === 0x19) len = 3;
    else len = LEN[op & 0x0F];
    this.setZ(JZ.BYTES, len);
    return len;
  }

  oplen() { return this.lenAcc(this.read(this.word(JZ.CURADL))); }

  begin() { this.setWord(JZ.CURADL, this.word(JZ.BEGADL)); }

  adcEnd() { this.setWord(JZ.CENDL, this.word(JZ.CENDL) + this.z(JZ.BYTES)); }

  recEnd() { this.setWord(JZ.CENDL, this.word(JZ.CENDL) - this.z(JZ.BYTES)); }

  // NEXT: CURAD += BYTES; true (N=1) als CURAD nog voor CEND ligt
  next() {
    const cur = (this.word(JZ.CURADL) + this.z(JZ.BYTES)) & 0xFFFF;
    this.setWord(JZ.CURADL, cur);
    const cend = this.word(JZ.CENDL);
    const borrow = (cur & 0xFF) < (cend & 0xFF) ? 1 : 0;
    const hi = ((cur >> 8) - (cend >> 8) - borrow) & 0xFF;
    const c = this.cpu;
    c.a = hi;
    this.setNZ(hi);
    c.p = ((cur >> 8) - (cend >> 8) - borrow) >= 0 ? c.p | FLAG_C : c.p & ~FLAG_C;
    return (hi & 0x80) !== 0;
  }

  // UP: gebied CURAD..CEND BYTES posities omhoog schuiven (instructie wissen)
  up() {
    let mov = this.word(JZ.CURADL);
    const cend = this.word(JZ.CENDL);
    const n = this.z(JZ.BYTES);
    for (let guard = 0; guard < 0x10000; guard++) {
      this.write(mov, this.read((mov + n) & 0xFFFF));
      mov = (mov + 1) & 0xFFFF;
      if (mov === cend) break;
    }
    this.setWord(JZ.MOVADL, mov);
  }

  // DOWN: gebied CURAD..CEND BYTES posities omlaag schuiven (ruimte maken)
  down() {
    let mov = this.word(JZ.CENDL);
    const cur = this.word(JZ.CURADL);
    const n = this.z(JZ.BYTES);
    for (let guard = 0; guard < 0x10000; guard++) {
      this.write((mov + n) & 0xFFFF, this.read(mov));
      if (mov === cur) break;
      mov = (mov - 1) & 0xFFFF;
    }
    this.setWord(JZ.MOVADL, mov);
  }

  // FILLWS: displaybuffer (POINTH, POINTL, INH) op CURAD invoegen
  fillWs() {
    this.down();
    this.adcEnd();
    const cur = this.word(JZ.CURADL);
    for (let x = 2, y = 0; y < this.z(JZ.BYTES); x--, y++) this.write((cur + y) & 0xFFFF, this.z(Z.INH + x));
  }

  // GETLBL: labeladres zoeken; { found, lo, hi }
  getLbl(y) {
    const nr = this.read((this.word(JZ.CURADL) + y) & 0xFFFF);
    const table = this.word(JZ.TABLEL);
    let i = 0xFF;
    for (;;) {
      if (i === this.z(JZ.LABELS)) return { found: false };
      if (nr === this.read((table + i) & 0xFFFF)) {
        return { found: true, hi: this.read((table + i - 1) & 0xFFFF), lo: this.read((table + i - 2) & 0xFFFF) };
      }
      i = (i - 3) & 0xFF;
      if (i === 0) return { found: false };
    }
  }

  // ASSEMB ($1F51): labels (FF nn) verzamelen en JMP/JSR/sprongen invullen
  assemb() {
    this.setWord(JZ.TABLEL, (this.word(JZ.ENDADL) - 0xFF) & 0xFFFF);
    this.setZ(JZ.LABELS, 0xFF);
    this.begin();
    for (let guard = 0; guard < 0x10000; guard++) {
      this.oplen();
      const cur = this.word(JZ.CURADL);
      if (this.read(cur) === 0xFF) {
        const table = this.word(JZ.TABLEL);
        let y = this.z(JZ.LABELS);
        this.write((table + y) & 0xFFFF, this.read((cur + 1) & 0xFFFF)); y = (y - 1) & 0xFF;
        this.write((table + y) & 0xFFFF, cur >> 8); y = (y - 1) & 0xFF;
        this.write((table + y) & 0xFFFF, cur & 0xFF); y = (y - 1) & 0xFF;
        this.setZ(JZ.LABELS, y);
        this.up();
        this.recEnd();
        continue;
      }
      if (!this.next()) break;
    }
    this.begin();
    for (let guard = 0; guard < 0x10000; guard++) {
      this.oplen();
      const cur = this.word(JZ.CURADL);
      const op = this.read(cur);
      if (op === 0x4C || op === 0x20) {
        const l = this.getLbl(1);
        if (l.found) { this.write((cur + 1) & 0xFFFF, l.lo); this.write((cur + 2) & 0xFFFF, l.hi); }
      } else if ((op & 0x1F) === 0x10) {
        const l = this.getLbl(1);
        if (l.found) this.write((cur + 1) & 0xFFFF, (l.lo - (cur & 0xFF) - 2) & 0xFF);
      }
      if (!this.next()) break;
    }
    this.setZ(JZ.BYTES, 3);
  }

  // ---------- Display- en keypadroutines (via de echte poorten) ----------

  // CONVD: één hexcijfer op cijferpositie X tonen
  convd(nibble) {
    const c = this.cpu;
    const seg = LOOK[nibble & 0x0F];
    this.write(RIOT_BASE, seg);
    this.write(RIOT_BASE + 2, c.x);
    c.cycles += 650;
    this.write(RIOT_BASE, 0xFF);
    this.write(RIOT_BASE + 2, 0x06);
    c.y = 0x06;
    c.x = (c.x + 2) & 0xFF;
    c.a = seg;
    c.cycles += 20;
  }

  show(v) {
    const y = this.cpu.y;
    this.convd(v >> 4);
    this.convd(v & 0x0F);
    this.cpu.y = y;
  }

  scands() {
    const c = this.cpu;
    this.write(RIOT_BASE + 1, 0x7F);
    c.x = 0x08;
    const bytes = this.z(JZ.BYTES);
    const shown = bytes === 1 ? 1 : bytes === 2 ? 2 : 3;
    const buf = [this.z(Z.POINTH), this.z(Z.POINTL), this.z(Z.INH)];
    for (let i = 0; i < shown; i++) this.show(buf[i]);
    this.write(RIOT_BASE + 1, 0x00);
    this.oneKey(0, 3);
  }

  // ONEKEY/AK: Y rijen lezen vanaf rij X/2; A = ingedrukte toetsen (0 = geen)
  oneKey(x, rows) {
    const c = this.cpu;
    let a = 0xFF;
    for (let i = 0; i < rows; i++) {
      this.write(RIOT_BASE + 2, x);
      x = (x + 2) & 0xFF;
      a &= this.read(RIOT_BASE);
    }
    this.write(RIOT_BASE + 2, 0x06);
    c.x = x;
    c.y = 0x06;
    c.a = (a | 0x80) ^ 0xFF;
    this.setNZ(c.a);
    c.cycles += 40 * rows;
    return c.a;
  }

  getKey() {
    const c = this.cpu;
    for (let x = 0x21; x !== 0x27; x += 2) {
      const a = this.oneKey(x, 1);
      if (a) {
        let y = 0;
        for (let bit = 0x40; bit && !(a & bit); bit >>= 1) y++;
        const row = (x - 0x21) >> 1;
        c.a = y + 7 * row;
        c.x = 0;
        c.y = y;
        this.setNZ(c.a);
        return;
      }
    }
    c.a = KEY.NONE;
    this.setNZ(c.a);
  }

  // ---------- ROM-routines ----------

  // Taak starten vanuit een programma: na afloop A/vlaggen zetten en RTS
  callTask(gen, result) {
    this.startTask('wait', gen, (r) => {
      result(r);
      this.rts();
      this.halted = false;
    });
  }

  trap(addr) {
    const c = this.cpu;
    const E = ROM_ENTRY;
    switch (addr) {
      case E.SAVE:
        this.saveRegisters();
        this.setZ(JZ.MODE, 1);
        this.startMonitor();
        return true;
      case E.RESET:
        this.write(RIOT_BASE + 3, 0x1E);
        this.setZ(Z.PREG, 0x04);
        this.setZ(JZ.MODE, 3);
        this.setZ(JZ.BYTES, 3);
        c.s = 0xFF;
        this.setZ(Z.SPUSER, 0xFF);
        c.p = (c.p & ~FLAG_D) | FLAG_I;
        this.startMonitor();
        return true;
      case E.START:
      case E.STARA:
        this.startMonitor();
        return true;
      case E.EDITOR:
        this.startTask('editor', this.editorTask(), null);
        return true;
      case E.BRANCH:
        this.startTask('branch', this.branchTask(), null);
        return true;
      case E.ASSEMB:
        c.cycles += 5000;
        this.assemb();
        this.startMonitor();
        return true;
      case E.SCAN:
        this.taskDisplay = 'scands';
        this.callTask(this.scan(), (k) => { c.a = k; this.setNZ(k); });
        return true;
      case E.SCANA:
        this.taskDisplay = 'scands';
        this.callTask(this.scanA(), (k) => { c.a = k; this.setNZ(k); });
        return true;
      case E.GETBYT:
        this.taskDisplay = 'scands';
        this.callTask(this.getByt(), (r) => { c.a = r.a; if (r.n) c.x = 0xFF; this.setNZ(r.n ? 0x80 : 0); });
        return true;
      case E.RDINST:
        this.taskDisplay = 'scands';
        this.callTask(this.rdInst(), (r) => { c.a = r.a; if (r.n) c.x = 0xFF; this.setNZ(r.n ? 0x80 : 0); });
        return true;
      case E.SCAND:
        this.setZ(Z.INH, this.read(this.point));
        this.scands();
        break;
      case E.SCANDS: this.scands(); break;
      case E.AK: this.oneKey(0, 3); break;
      case E.ONEKEY: this.oneKey(c.x, c.y); break;
      case E.SHOW: this.show(c.a); break;
      case E.CONVD: this.convd(c.a); break;
      case E.GETKEY: this.getKey(); c.cycles += 100; break;
      case E.OPLEN: c.y = this.oplen(); break;
      case E.LENACC: c.y = this.lenAcc(c.a); break;
      case E.FILLWS: this.fillWs(); this.setNZ(0); break;
      case E.UP: this.up(); break;
      case E.DOWN: this.down(); break;
      case E.BEGIN: this.begin(); break;
      case E.ADCEND: this.adcEnd(); break;
      case E.RECEND: this.recEnd(); break;
      case E.NEXT: this.next(); break;
      case E.GETLBL: {
        const l = this.getLbl(c.y);
        if (l.found) { c.a = l.lo; c.x = l.hi; c.y = 1; this.setNZ(1); } else this.setNZ(0);
        break;
      }
      default:
        return false;
    }
    c.cycles += 12;
    this.rts();
    return true;
  }
}
