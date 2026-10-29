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

import { Board, Z, KEY } from './board.js';
import { RIOT } from './riot.js';

export { Z, KEY };

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

export class KIM1 extends Board {
  constructor() {
    super({ romStart: 0x1800, romSize: 0x800 });
    this.ttyInput = [];
    this.onTTYOutput = null; // (string) => void
    this.onMonitorEnter = null;
    this.onTapeChange = null;
    this.tapes = []; // { id, start, data: number[] }

    // PA7 = TTY-ingang (rust = 1); bij lijn 3 betekent PA0=1 "keypad-modus"
    this.riot002 = new RIOT(this, { inputA: () => this.keypadInput() });
    this.riot003 = new RIOT(this);
    this.riots = [this.riot002, this.riot003];
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

  keypadRiot() { return this.riot002; }

  // Segmenten zijn actief hoog op poort A
  displayPorts() {
    const r = this.riot002;
    return r.pa & r.padd & 0x7F;
  }

  // ---------- Keypad ----------

  powerOn() {
    this.mem.fill(0);
    // Gemak: de NMI- en IRQ-vectoren wijzen al naar de monitor ($1C00),
    // zodat ST, SST en BRK meteen werken. Op een echte KIM moest je dit intikken.
    this.mem[0x17FA] = 0x00; this.mem[0x17FB] = 0x1C;
    this.mem[0x17FE] = 0x00; this.mem[0x17FF] = 0x1C;
    this.mem[Z.SPUSER] = 0xFF;
    this.reset();
  }

  // ---------- Nagebootste monitor ----------

  get monitorLabel() { return 'MONITOR ' + this.monitorMode; }

  // Na het laden van een programma: adres tonen in de monitor
  showAddress(addr) {
    this.point = addr;
    this.monitorMode = 'AD';
  }

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

  // ---------- ROM-routines ----------

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
        this.saveRegisters();
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
        c.a = this.firstKey();
        this.setNZ(c.a);
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
    c.a = this.anyKeyMask();
    c.x = 7; c.y = 7;
    this.setNZ(c.a); // AK eindigt met EOR #$FF: Z/N volgen A
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
}
