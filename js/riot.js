// RIOT-chips: de 6530 (KIM-1) en de 6532 (Junior Computer).
// Beide hebben twee 8-bit poorten met richtingsregisters en een interval-timer.
//
// Registerdecodering (A0-A4 van het adres binnen het I/O-blok):
//   A2=0: A1A0 = 0 poort A, 1 richting A, 2 poort B, 3 richting B
//   A2=1, schrijven: timer starten (A1A0 = deler 1/8/64/1024, A3 = IRQ aan)
//         (6532: alleen als A4=1; met A4=0 is het de PA7-flankdetectie)
//   A2=1, lezen:     A0=0 timerwaarde (A3 = IRQ aan), A0=1 vlaggen (bit 7 = timer)

export class RIOT {
  constructor(machine, { variant = '6530', inputA = () => 0xFF, inputB = () => 0xFF } = {}) {
    this.m = machine;
    this.variant = variant;
    this.inputA = inputA; // () => byte op de pinnen van poort A (niet-aangestuurd = 1)
    this.inputB = inputB;
    this.reset();
  }

  reset() {
    this.pa = 0; this.padd = 0; this.pb = 0; this.pbdd = 0;
    this.timerStart = 0; this.timerInit = 0xFF; this.timerDiv = 1024;
    this.timerIrq = false;
    this.flagAck = false; // timervlag gewist door de timer te lezen
    this.edgeIrq = false;
    this.edgePositive = false;
  }

  // Effectieve uitgangen: niet-aangestuurde pinnen lezen als 1
  outA() { return ((this.pa & this.padd) | (~this.padd & 0xFF)) & 0xFF; }
  outB() { return ((this.pb & this.pbdd) | (~this.pbdd & 0xFF)) & 0xFF; }

  timerElapsed() { return this.m.cpu.cycles - this.timerStart; }

  timedOut() {
    return this.timerElapsed() >= (this.timerInit + 1) * this.timerDiv;
  }

  timerFlag() { return this.timedOut() && !this.flagAck; }

  // IRQ-uitgang (alleen bij de 6532 op de Junior aangesloten)
  irqActive() { return this.timerIrq && this.timerFlag(); }

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
      if (reg & 0x01) return this.timerFlag() ? 0x80 : 0;
      if (!peek) {
        this.timerIrq = !!(reg & 0x08);
        if (this.timedOut()) this.flagAck = true;
      }
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
      if (this.variant === '6532' && !(reg & 0x10)) {
        this.edgePositive = !!(reg & 0x01);
        this.edgeIrq = !!(reg & 0x02);
        return;
      }
      this.timerInit = v;
      this.timerDiv = [1, 8, 64, 1024][reg & 0x03];
      this.timerIrq = !!(reg & 0x08);
      this.timerStart = this.m.cpu.cycles;
      this.flagAck = false;
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
