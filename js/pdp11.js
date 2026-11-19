// PDP-11/40-systeem: 56 KB geheugen, I/O-pagina, frontpaneel en console-ODT.
//
// Apparaten (adressen octaal):
//   177776        PSW
//   177570        schakelregister (lezen) / displayregister (schrijven)
//   177560-177566 DL11 consoleterminal       vector 060/064, BR4
//   177546        KW11-L netfrequentieklok   vector 100, BR6
//   177550-177556 PC11 ponsbandlezer/-ponser vector 070/074, BR4
//   177160-177164 CR11 ponskaartlezer        vector 230, BR6

import { CPU11, CpuTrap, VEC } from './pdp11-cpu.js';
import { compress } from './pdp11-cards.js';

export const IO_PAGE = 0o160000;
export const MEM_BYTES = IO_PAGE; // 56 KB

export const ADDR = {
  PSW: 0o177776, SWR: 0o177570, DR: 0o177570,
  RCSR: 0o177560, RBUF: 0o177562, XCSR: 0o177564, XBUF: 0o177566,
  LKS: 0o177546,
  PRS: 0o177550, PRB: 0o177552, PPS: 0o177554, PPB: 0o177556,
  CRS: 0o177160, CRB1: 0o177162, CRB2: 0o177164,
};

export const o6 = (v) => (v & 0xFFFF).toString(8).padStart(6, '0');

const BUS_CYCLE_US = 0.9; // geheugencyclus van de 11/40
const BASE_US = 0.3;

// ---------- Apparaten ----------

// Basis voor een apparaat dat een interrupt kan aanvragen
class Device {
  constructor(m, level, vector) {
    this.m = m;
    this.level = level;
    this.vector = vector;
    this.req = false;
  }
  ack() { this.req = false; }
}

class DL11Receiver extends Device {
  constructor(m) { super(m, 4, 0o60); this.input = []; this.reset(); }
  reset() { this.csr = 0; this.buf = 0; this.req = false; this.readyAt = 0; }
  next() { return !(this.csr & 0x80) && this.input.length ? Math.max(this.readyAt, this.m.time) : Infinity; }
  fire(t) {
    if (this.csr & 0x80 || !this.input.length || t < this.readyAt) return;
    this.buf = this.input.shift() & 0xFF;
    this.csr |= 0x80;
    if (this.csr & 0x40) this.req = true;
  }
  read(a, side) {
    if (a === ADDR.RCSR) return this.csr;
    if (side) {
      this.csr &= ~0x80;
      this.req = false;
      this.readyAt = this.m.time + this.m.charTime;
    }
    return this.buf;
  }
  write(a, v) {
    if (a !== ADDR.RCSR) return;
    const ie = v & 0x40;
    if (ie && !(this.csr & 0x40) && this.csr & 0x80) this.req = true;
    if (!ie) this.req = false;
    this.csr = (this.csr & 0x80) | ie;
  }
}

class DL11Transmitter extends Device {
  constructor(m) { super(m, 4, 0o64); this.reset(); }
  reset() { this.csr = 0x80; this.buf = 0; this.req = false; this.doneAt = Infinity; }
  next() { return this.doneAt; }
  fire(t) {
    if (t < this.doneAt) return;
    this.doneAt = Infinity;
    this.m.ttyOut(this.buf & 0x7F);
    this.csr |= 0x80;
    if (this.csr & 0x40) this.req = true;
  }
  read(a) { return a === ADDR.XCSR ? this.csr : 0; }
  write(a, v) {
    if (a === ADDR.XCSR) {
      const ie = v & 0x40;
      if (ie && !(this.csr & 0x40) && this.csr & 0x80) this.req = true;
      if (!ie) this.req = false;
      this.csr = (this.csr & 0x80) | ie;
    } else {
      this.buf = v & 0xFF;
      this.csr &= ~0x80;
      this.req = false;
      this.doneAt = this.m.time + this.m.charTime;
    }
  }
}

class Clock extends Device {
  constructor(m) { super(m, 6, 0o100); this.csr = 0x80; this.nextTick = 0; }
  reset() { this.csr = 0x80; this.req = false; }
  next() { return this.nextTick; }
  fire(t) {
    if (t < this.nextTick) return;
    this.nextTick += 1e6 / this.m.clockHz;
    if (this.nextTick < t) this.nextTick = t + 1e6 / this.m.clockHz;
    this.csr |= 0x80;
    if (this.csr & 0x40) this.req = true;
  }
  read() { return this.csr; }
  write(a, v) {
    this.csr = (this.csr & v & 0x80) | (v & 0x40);
    if (!(v & 0x40)) this.req = false;
  }
}

class TapeReader extends Device {
  constructor(m) { super(m, 4, 0o70); this.tape = []; this.pos = 0; this.reset(); }
  reset() { this.csr = 0; this.buf = 0; this.req = false; this.doneAt = Infinity; }
  next() { return this.doneAt; }
  status() { return this.pos >= this.tape.length ? 0x8000 : 0; }
  fire(t) {
    if (t < this.doneAt) return;
    this.doneAt = Infinity;
    this.csr &= ~0x800;
    if (this.pos < this.tape.length) {
      this.buf = this.tape[this.pos++];
      this.csr |= 0x80;
    }
    if (this.csr & 0x40) this.req = true;
    this.m.notify('tape');
  }
  read(a, side) {
    if (a === ADDR.PRS) return this.csr | this.status();
    if (side) this.csr &= ~0x80;
    return this.buf;
  }
  write(a, v) {
    if (a !== ADDR.PRS) return;
    const ie = v & 0x40;
    if (ie && !(this.csr & 0x40) && (this.csr & 0x80 || this.status())) this.req = true;
    if (!ie) this.req = false;
    this.csr = (this.csr & ~0x40) | ie;
    if (v & 1) {
      this.csr &= ~0x80;
      if (this.status()) { if (ie) this.req = true; return; }
      this.csr |= 0x800;
      this.doneAt = this.m.time + 3333; // 300 tekens per seconde
    }
  }
}

class TapePunch extends Device {
  constructor(m) { super(m, 4, 0o74); this.output = []; this.reset(); }
  reset() { this.csr = 0x80; this.buf = 0; this.req = false; this.doneAt = Infinity; }
  next() { return this.doneAt; }
  fire(t) {
    if (t < this.doneAt) return;
    this.doneAt = Infinity;
    this.output.push(this.buf);
    this.csr |= 0x80;
    if (this.csr & 0x40) this.req = true;
    this.m.notify('punch');
  }
  read(a) { return a === ADDR.PPS ? this.csr : 0; }
  write(a, v) {
    if (a === ADDR.PPS) {
      const ie = v & 0x40;
      if (ie && !(this.csr & 0x40) && this.csr & 0x80) this.req = true;
      if (!ie) this.req = false;
      this.csr = (this.csr & 0x80) | ie;
    } else {
      this.buf = v & 0xFF;
      this.csr &= ~0x80;
      this.req = false;
      this.doneAt = this.m.time + 20000; // 50 tekens per seconde
    }
  }
}

// CR11-kaartlezer (1200 kaarten per minuut)
export const CR = {
  ERR: 0x8000, CARD_DONE: 0x4000, SUPPLY: 0x2000, TIMERR: 0x0800,
  ONLINE: 0x0400, BUSY: 0x0200, OFFLINE: 0x0100, COL_DONE: 0x0080, IE: 0x0040, READ: 0x0001,
};
const CR_FEED_US = 8000;
const CR_COLUMN_US = 520;

class CardReader extends Device {
  constructor(m) {
    super(m, 6, 0o230);
    this.hopper = []; // kaarten die nog gelezen moeten worden
    this.stacker = []; // gelezen kaarten
    this.reset();
  }
  reset() {
    this.csr = 0;
    this.crb1 = 0;
    this.crb2 = 0;
    this.req = false;
    this.card = null; // kaart die nu door de lezer gaat
    this.col = 0;
    this.nextAt = Infinity;
    this.unread = false;
  }
  next() { return this.nextAt; }
  setFlag(bit) {
    this.csr |= bit;
    if (this.csr & CR.IE) this.req = true;
  }
  fire(t) {
    if (t < this.nextAt) return;
    if (this.col < 80) {
      if (this.unread) this.csr |= CR.TIMERR | CR.ERR;
      this.crb1 = this.card.cols[this.col];
      this.crb2 = compress(this.crb1);
      this.col++;
      this.unread = true;
      this.nextAt = t + CR_COLUMN_US;
      this.setFlag(CR.COL_DONE);
    } else {
      this.nextAt = Infinity;
      this.stacker.push(this.card);
      this.card = null;
      this.csr &= ~CR.BUSY;
      this.setFlag(CR.CARD_DONE);
    }
    this.m.notify('cards');
  }
  status() {
    return this.hopper.length || this.card ? CR.ONLINE : CR.OFFLINE | CR.SUPPLY;
  }
  read(a, side) {
    if (a === ADDR.CRS) return (this.csr & ~(CR.ONLINE | CR.OFFLINE | CR.SUPPLY)) | this.status();
    if (side) { this.csr &= ~CR.COL_DONE; this.unread = false; }
    return a === ADDR.CRB1 ? this.crb1 : this.crb2;
  }
  write(a, v) {
    if (a !== ADDR.CRS) return;
    const ie = v & CR.IE;
    if (ie && !(this.csr & CR.IE) && this.csr & (CR.COL_DONE | CR.CARD_DONE | CR.ERR)) this.req = true;
    if (!ie) this.req = false;
    this.csr = (this.csr & ~CR.IE) | ie;
    if (v & CR.READ && !(this.csr & CR.BUSY)) {
      this.csr &= ~(CR.CARD_DONE | CR.COL_DONE | CR.ERR | CR.TIMERR);
      if (!this.hopper.length) { this.setFlag(CR.ERR); return; }
      this.card = this.hopper.shift();
      this.col = 0;
      this.unread = false;
      this.csr |= CR.BUSY;
      this.nextAt = this.m.time + CR_FEED_US;
      this.m.notify('cards');
    }
  }
}

// ---------- Console-ODT (zoals in de PDP-11/23-microcode) ----------

class ODT {
  constructor(m) {
    this.m = m;
    this.reset();
  }

  reset() {
    this.buf = '';
    this.reg = false; // 'R' getikt
    this.regNum = null;
    this.open = null; // { kind: 'mem'|'reg'|'psw', addr }
  }

  out(s) { this.m.ttyText(s); }

  prompt() {
    this.reset();
    this.out('\r\n@');
  }

  value(loc) {
    if (loc.kind === 'reg') return this.m.cpu.r[loc.addr];
    if (loc.kind === 'psw') return this.m.cpu.psw;
    return this.m.examine(loc.addr);
  }

  label(loc) {
    if (loc.kind === 'reg') return `R${loc.addr}`;
    if (loc.kind === 'psw') return 'RS';
    return o6(loc.addr);
  }

  show(loc) {
    this.open = loc;
    this.buf = '';
    const v = this.value(loc);
    this.out(v === null ? '?\r\n@' : `${o6(v)} `);
    if (v === null) this.reset();
  }

  store() {
    if (!this.open || this.buf === '') return;
    const v = parseInt(this.buf, 8) & 0xFFFF;
    const loc = this.open;
    if (loc.kind === 'reg') this.m.cpu.r[loc.addr] = v;
    else if (loc.kind === 'psw') this.m.cpu.psw = v & 0xFF;
    else this.m.deposit(loc.addr, v);
  }

  step(loc, dir) {
    if (loc.kind === 'reg') return { kind: 'reg', addr: (loc.addr + dir) & 7 };
    if (loc.kind === 'psw') return loc;
    return { kind: 'mem', addr: (loc.addr + 2 * dir) & 0xFFFE };
  }

  error() {
    this.out('?');
    this.prompt();
  }

  input(ch) {
    const c = ch.toUpperCase();
    if (c === '\b' || c === '\x7F') {
      if (this.buf) { this.buf = this.buf.slice(0, -1); this.out('\b'); }
      return;
    }
    if (/[0-7]/.test(c)) {
      if (this.reg) {
        this.out(c);
        this.reg = false;
        this.regNum = Number(c);
        return;
      }
      if (this.buf.length < 6) { this.buf += c; this.out(c); }
      return;
    }
    if (this.open) {
      if (c === '\r') { this.store(); this.prompt(); return; }
      if (c === '\n' || c === '^' || c === '@') {
        this.store();
        const loc = this.open;
        let nxt;
        if (c === '@') {
          const v = this.value(loc);
          nxt = { kind: 'mem', addr: v & 0xFFFE };
        } else nxt = this.step(loc, c === '^' ? -1 : 1);
        this.out(c === '\n' ? '' : c);
        this.out(`\r\n${this.label(nxt)}/`);
        this.show(nxt);
        return;
      }
      this.error();
      return;
    }
    switch (c) {
      case 'R': case '$':
        this.out('R');
        this.reg = true;
        this.regNum = null;
        return;
      case 'S':
        if (this.reg) { this.out('S'); this.reg = false; this.regNum = 'S'; return; }
        this.error();
        return;
      case '/': {
        this.out('/');
        let loc;
        if (this.regNum === 'S') loc = { kind: 'psw', addr: 0 };
        else if (this.regNum !== null && this.regNum !== undefined) loc = { kind: 'reg', addr: this.regNum };
        else if (this.buf) loc = { kind: 'mem', addr: parseInt(this.buf, 8) & 0xFFFE };
        else loc = { kind: 'mem', addr: this.lastAddr ?? 0 };
        this.regNum = null;
        if (loc.kind === 'mem') this.lastAddr = loc.addr;
        this.show(loc);
        return;
      }
      case 'G': {
        this.out('G\r\n');
        const addr = this.buf ? parseInt(this.buf, 8) & 0xFFFE : 0;
        this.reset();
        this.m.go(addr);
        return;
      }
      case 'P':
        this.out('P\r\n');
        this.reset();
        this.m.proceed();
        return;
      case '\r':
        this.prompt();
        return;
      case '\n':
        return;
      default:
        this.error();
    }
  }
}

// ---------- De machine ----------

export class PDP11 {
  constructor() {
    this.mem = new Uint16Array(MEM_BYTES / 2);
    this.cpu = new CPU11(this);
    this.time = 0; // microseconden
    this.speed = 1;
    this.clockHz = 50;
    this.charTime = 1042; // 9600 baud
    this.sr = 0; // schakelaars
    this.dr = 0; // displayregister
    this.busAccesses = 0;

    this.rcv = new DL11Receiver(this);
    this.xmt = new DL11Transmitter(this);
    this.clock = new Clock(this);
    this.ptr = new TapeReader(this);
    this.ptp = new TapePunch(this);
    this.cr = new CardReader(this);
    // Volgorde = prioriteit binnen een niveau (positie op de bus)
    this.devices = [this.clock, this.cr, this.rcv, this.xmt, this.ptr, this.ptp];

    this.odt = new ODT(this);
    this.onTTYOutput = null; // (tekst) => void
    this.onChange = null; // (wat) => void: 'cards', 'tape', 'punch'

    // Frontpaneel
    this.panel = { addr: 0, data: 0, last: null, error: '' };
    this.haltSwitch = false;

    // Lampjes: gemiddelde helderheid over de laatste beeldverversing
    this.lampAcc = new Float64Array(32);
    this.lampSamples = 0;
    this.sampleCountdown = 0;

    this.powerOn();
  }

  powerOn() {
    this.mem.fill(0);
    this.cpu.r.fill(0);
    this.resetDevices();
    this.cpu.reset();
    this.cpu.halted = true;
    this.panel = { addr: 0, data: 0, last: null, error: '' };
    this.dr = 0;
    this.odt.reset();
    this.ttyText('\r\n@');
  }

  notify(what) { if (this.onChange) this.onChange(what); }

  ttyOut(code) {
    if (this.onTTYOutput) this.onTTYOutput(String.fromCharCode(code));
  }

  ttyText(s) {
    if (this.onTTYOutput) this.onTTYOutput(s);
  }

  // Toets van de terminal: naar de ODT als de CPU stilstaat, anders naar de DL11
  typeKey(ch) {
    if (this.cpu.halted) this.odt.input(ch);
    else this.rcv.input.push(ch.charCodeAt(0) & 0x7F);
  }

  // ---------- Bus ----------

  read16(a) {
    this.busAccesses++;
    if (a < IO_PAGE) return this.mem[a >> 1];
    return this.ioRead(a, true);
  }

  write16(a, v) {
    this.busAccesses++;
    if (a < IO_PAGE) { this.mem[a >> 1] = v; return; }
    this.ioWrite(a, v);
  }

  read8(a) {
    this.busAccesses++;
    if (a < IO_PAGE) {
      const w = this.mem[a >> 1];
      return a & 1 ? w >> 8 : w & 0xFF;
    }
    const w = this.ioRead(a & 0xFFFE, true);
    return a & 1 ? w >> 8 : w & 0xFF;
  }

  write8(a, v) {
    this.busAccesses++;
    if (a < IO_PAGE) {
      const i = a >> 1;
      this.mem[i] = a & 1 ? (this.mem[i] & 0xFF) | (v << 8) : (this.mem[i] & 0xFF00) | v;
      return;
    }
    const e = a & 0xFFFE;
    const cur = this.ioRead(e, false);
    this.ioWrite(e, a & 1 ? (cur & 0xFF) | (v << 8) : (cur & 0xFF00) | v);
  }

  deviceAt(a) {
    if (a === ADDR.RCSR || a === ADDR.RBUF) return this.rcv;
    if (a === ADDR.XCSR || a === ADDR.XBUF) return this.xmt;
    if (a === ADDR.LKS) return this.clock;
    if (a === ADDR.PRS || a === ADDR.PRB) return this.ptr;
    if (a === ADDR.PPS || a === ADDR.PPB) return this.ptp;
    if (a === ADDR.CRS || a === ADDR.CRB1 || a === ADDR.CRB2) return this.cr;
    return null;
  }

  ioRead(a, side) {
    this.ioTouched = true;
    if (a === ADDR.PSW) return this.cpu.psw;
    if (a === ADDR.SWR) return this.sr;
    const dev = this.deviceAt(a);
    if (!dev) throw new CpuTrap(VEC.BUS, `geen apparaat op ${o6(a)}`);
    return dev.read(a, side);
  }

  ioWrite(a, v) {
    this.ioTouched = true;
    if (a === ADDR.PSW) { this.cpu.psw = (v & 0xEF) | (this.cpu.psw & 0x10); return; }
    if (a === ADDR.DR) { this.dr = v; return; }
    const dev = this.deviceAt(a);
    if (!dev) throw new CpuTrap(VEC.BUS, `geen apparaat op ${o6(a)}`);
    dev.write(a, v);
  }

  interruptRequest() {
    let best = null;
    for (const d of this.devices) if (d.req && (!best || d.level > best.level)) best = d;
    return best;
  }

  resetDevices() {
    for (const d of this.devices) d.reset();
  }

  onHalt() {
    const p = this.panel;
    p.addr = this.cpu.r[7];
    p.data = this.cpu.r[0];
    p.last = null;
    this.odt.out(`\r\n${o6(this.cpu.r[7])}`);
    this.odt.prompt();
  }

  // ---------- Geheugen voor de gebruikersinterface (zonder bijwerkingen) ----------

  peek(a) {
    a &= 0xFFFF;
    if (a < IO_PAGE) { const w = this.mem[a >> 1]; return a & 1 ? w >> 8 : w & 0xFF; }
    return null;
  }

  poke(a, v) {
    a &= 0xFFFF;
    if (a >= IO_PAGE) return;
    const i = a >> 1;
    this.mem[i] = a & 1 ? (this.mem[i] & 0xFF) | ((v & 0xFF) << 8) : (this.mem[i] & 0xFF00) | (v & 0xFF);
  }

  peekWord(a) {
    a &= 0xFFFE;
    if (a < IO_PAGE) return this.mem[a >> 1];
    try { return this.ioRead(a, false); } catch { return null; }
  }

  // Lezen/schrijven zoals het frontpaneel en de ODT doen. 177700-177707 zijn de registers.
  examine(a) {
    a &= 0xFFFF;
    if (a >= 0o177700 && a <= 0o177707) return this.cpu.r[a & 7];
    return this.peekWord(a);
  }

  deposit(a, v) {
    a &= 0xFFFF;
    if (a >= 0o177700 && a <= 0o177707) { this.cpu.r[a & 7] = v; return true; }
    try { this.write16(a & 0xFFFE, v & 0xFFFF); return true; } catch { return false; }
  }

  // ---------- Starten en stoppen ----------

  go(addr) {
    this.resetDevices();
    this.cpu.reset();
    this.cpu.r[7] = addr & 0xFFFE;
    this.cpu.halted = false;
    this.panel.last = null;
    this.skipBreakpoint = true;
  }

  proceed() {
    this.cpu.halted = false;
    this.cpu.waiting = false;
    this.panel.last = null;
    this.skipBreakpoint = true;
  }

  haltNow(reason = 'gestopt') {
    if (!this.cpu.halted) this.cpu.halt(reason);
  }

  stepInstruction() {
    this.cpu.halted = false;
    this.cpu.waiting = false;
    const before = this.busAccesses;
    this.cpu.step();
    this.time += BASE_US + (this.busAccesses - before) * BUS_CYCLE_US;
    this.pollDevices();
    if (!this.cpu.halted) this.cpu.halted = true;
    this.panel.addr = this.cpu.r[7];
    this.panel.last = null;
  }

  // ---------- Frontpaneel ----------

  panelAdvance() {
    const p = this.panel;
    p.addr = p.addr >= 0o177700 && p.addr <= 0o177707 ? 0o177700 | ((p.addr + 1) & 7) : (p.addr + 2) & 0xFFFF;
  }

  loadAddress() {
    if (!this.cpu.halted) return;
    this.panel.addr = this.sr;
    this.panel.last = 'load';
    this.panel.error = '';
  }

  panelExamine() {
    if (!this.cpu.halted) return;
    const p = this.panel;
    if (p.last === 'exam') this.panelAdvance();
    const v = this.examine(p.addr);
    p.error = v === null ? 'busfout: geen geheugen op dit adres' : '';
    p.data = v ?? 0;
    p.last = 'exam';
  }

  panelDeposit() {
    if (!this.cpu.halted) return;
    const p = this.panel;
    if (p.last === 'dep') this.panelAdvance();
    const ok = this.deposit(p.addr, this.sr);
    p.error = ok ? '' : 'busfout: geen geheugen op dit adres';
    p.data = this.sr;
    p.last = 'dep';
  }

  panelStart() {
    if (!this.cpu.halted) return;
    if (this.haltSwitch) { this.resetDevices(); this.cpu.reset(); return; }
    this.odt.out('\r\n');
    this.go(this.panel.addr);
  }

  panelContinue() {
    if (!this.cpu.halted) return;
    if (this.haltSwitch) {
      this.stepInstruction();
      this.panel.data = this.cpu.r[0];
      return;
    }
    this.odt.out('\r\n');
    this.proceed();
  }

  setHaltSwitch(on) {
    this.haltSwitch = on;
    if (on) this.haltNow('HALT-schakelaar');
  }

  // Helderheid (0-1) van de 16 adres- en 16 datalampjes sinds de vorige aanroep
  lamps() {
    const out = { addr: new Array(16), data: new Array(16) };
    if (this.cpu.halted || this.lampSamples === 0) {
      const a = this.cpu.halted ? this.panel.addr : this.cpu.r[7];
      const d = this.cpu.halted ? this.panel.data : this.dr;
      for (let i = 0; i < 16; i++) { out.addr[i] = (a >> i) & 1; out.data[i] = (d >> i) & 1; }
    } else {
      for (let i = 0; i < 16; i++) {
        out.addr[i] = this.lampAcc[i] / this.lampSamples;
        out.data[i] = this.lampAcc[16 + i] / this.lampSamples;
      }
    }
    this.lampAcc.fill(0);
    this.lampSamples = 0;
    return out;
  }

  sampleLamps() {
    const a = this.cpu.r[7], d = this.dr;
    for (let i = 0; i < 16; i++) {
      this.lampAcc[i] += (a >> i) & 1;
      this.lampAcc[16 + i] += (d >> i) & 1;
    }
    this.lampSamples++;
  }

  // ---------- Uitvoering ----------

  nextEvent() {
    let t = Infinity;
    for (const d of this.devices) { const n = d.next(); if (n < t) t = n; }
    return t;
  }

  pollDevices() {
    for (const d of this.devices) if (d.next() <= this.time) d.fire(this.time);
  }

  // Wordt een interrupt nu geaccepteerd?
  interruptPending() {
    const d = this.interruptRequest();
    return !!d && d.level > ((this.cpu.psw >> 5) & 7);
  }

  // Draai `us` microseconden (emulatietijd). Geeft 'breakpoint', 'halt' of undefined terug.
  run(us, breakpoints) {
    const cpu = this.cpu;
    const end = this.time + us;
    let next = this.nextEvent();
    while (this.time < end) {
      if (this.time >= next) { this.pollDevices(); next = this.nextEvent(); }
      if (cpu.halted) {
        // Apparaten lopen door (bijv. tekens die nog verstuurd worden)
        if (next <= end) { this.time = Math.max(this.time, next); this.pollDevices(); next = this.nextEvent(); }
        else this.time = end;
        continue;
      }
      if (cpu.waiting && !this.interruptPending()) {
        this.time = Math.max(this.time, Math.min(end, next));
        if (--this.sampleCountdown <= 0) { this.sampleCountdown = 16; this.sampleLamps(); }
        continue;
      }
      if (breakpoints && breakpoints.size && !this.skipBreakpoint && breakpoints.has(cpu.r[7])) {
        cpu.halt('breekpunt');
        return 'breakpoint';
      }
      this.skipBreakpoint = false;
      const before = this.busAccesses;
      cpu.step();
      this.time += BASE_US + (this.busAccesses - before) * BUS_CYCLE_US;
      if (--this.sampleCountdown <= 0) { this.sampleCountdown = 16; this.sampleLamps(); }
      if (this.haltSwitch && !cpu.halted) cpu.halt('HALT-schakelaar');
      if (cpu.halted) return 'halt';
      // Een registertoegang kan een nieuw apparaatevenement plannen
      if (this.ioTouched) { this.ioTouched = false; next = this.nextEvent(); }
    }
    return undefined;
  }

  // ---------- Kaarten en ponsband ----------

  loadCards(cards) {
    this.cr.hopper.push(...cards);
    this.notify('cards');
  }

  clearCards() {
    this.cr.hopper = [];
    this.cr.stacker = [];
    this.notify('cards');
  }

  loadTape(bytes) {
    this.ptr.tape = Array.from(bytes);
    this.ptr.pos = 0;
    this.notify('tape');
  }
}
