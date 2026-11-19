import test from 'node:test';
import assert from 'node:assert/strict';
import { PDP11, ADDR, CR } from '../js/pdp11.js';
import { FLAG_N, FLAG_Z, FLAG_V, FLAG_C } from '../js/pdp11-cpu.js';
import { assemble, AsmError } from '../js/pdp11-asm.js';
import { disassemble } from '../js/pdp11-disasm.js';
import { parseAbsoluteLoader, toAbsoluteLoader } from '../js/pdp11-files.js';
import { textToCard, charToHollerith, hollerithToChar, compress } from '../js/pdp11-cards.js';
import { SAMPLES_PDP11, SAMPLE_CARDS } from '../js/pdp11-samples.js';

function machine() {
  const m = new PDP11();
  m.out = '';
  m.onTTYOutput = (s) => { m.out += s; };
  return m;
}

function load(m, src) {
  const r = assemble(src);
  for (const s of r.segments) s.bytes.forEach((b, i) => m.poke(s.start + i, b));
  return r;
}

// Assembleer `body` op adres 1000 (met stack), draai tot HALT en geef de machine terug
function exec(body, us = 100000) {
  const m = machine();
  const r = load(m, `\t. = 1000\nSTART:\tMOV\t#START,SP\n${body}\n\tHALT\n\t.END START`);
  m.out = '';
  m.go(r.start);
  m.run(us);
  assert.equal(m.cpu.halted, true, 'programma moet stoppen');
  return m;
}

const cc = (m) => m.cpu.psw & 0xF;
const flags = (s) => [...s].reduce((v, f) => v | { N: FLAG_N, Z: FLAG_Z, V: FLAG_V, C: FLAG_C }[f], 0);

// ---------- CPU ----------

test('ADD en SUB zetten V en C goed', () => {
  let m = exec('MOV #77777,R0\nADD #1,R0');
  assert.equal(m.cpu.r[0], 0o100000);
  assert.equal(cc(m), flags('NV'));
  m = exec('MOV #177777,R0\nADD #1,R0');
  assert.equal(m.cpu.r[0], 0);
  assert.equal(cc(m), flags('ZC'));
  m = exec('MOV #100000,R0\nSUB #1,R0');
  assert.equal(m.cpu.r[0], 0o77777);
  assert.equal(cc(m), flags('V'));
  m = exec('CLR R0\nSUB #1,R0');
  assert.equal(m.cpu.r[0], 0o177777);
  assert.equal(cc(m), flags('NC'));
});

test('CMP rekent bron min bestemming', () => {
  let m = exec('MOV #5,R0\nCMP R0,#7');
  assert.equal(cc(m), flags('NC'));
  m = exec('MOV #100000,R0\nCMP R0,#1');
  assert.equal(cc(m), flags('V'));
  m = exec('CMPB #200,#1');
  assert.equal(cc(m), flags('V'));
});

test('MOVB naar een register breidt het teken uit', () => {
  const m = exec('MOV #177777,R1\nMOVB #200,R0\nMOVB #5,R1\nMOV #123456,R2\nBISB #1,R2');
  assert.equal(m.cpu.r[0], 0o177600);
  assert.equal(m.cpu.r[1], 5);
  assert.equal(m.cpu.r[2], 0o123457);
});

test('byte-autoincrement telt 1 op, behalve bij SP en PC', () => {
  const m = exec('MOV #2000,R1\nMOVB (R1)+,R0\nMOV SP,R3\nTSTB (SP)+\nSUB SP,R3');
  assert.equal(m.cpu.r[1], 0o2001);
  assert.equal(m.cpu.r[3], 0o177776); // SP ging 2 omhoog
});

test('enkele operanden: NEG, COM, ADC, SBC, ROR, ROL, ASR, ASL, SWAB, SXT', () => {
  let m = exec('MOV #100000,R0\nNEG R0');
  assert.equal(m.cpu.r[0], 0o100000);
  assert.equal(cc(m), flags('NVC'));
  m = exec('CLR R0\nCOM R0');
  assert.equal(cc(m), flags('NC'));
  m = exec('MOV #177777,R0\nSEC\nADC R0');
  assert.equal(m.cpu.r[0], 0);
  assert.equal(cc(m), flags('ZC'));
  m = exec('CLR R0\nSEC\nSBC R0');
  assert.equal(m.cpu.r[0], 0o177777);
  assert.equal(cc(m), flags('NC'));
  m = exec('MOV #1,R0\nCLC\nROR R0');
  assert.equal(m.cpu.r[0], 0);
  assert.equal(cc(m), flags('ZVC'));
  m = exec('MOV #100000,R0\nSEC\nROL R0');
  assert.equal(m.cpu.r[0], 1);
  assert.equal(cc(m), flags('VC'));
  m = exec('MOV #100001,R0\nASR R0');
  assert.equal(m.cpu.r[0], 0o140000);
  assert.equal(cc(m), flags('NC'));
  m = exec('MOV #40000,R0\nASL R0');
  assert.equal(cc(m), flags('NV'));
  m = exec('MOV #001377,R0\nSWAB R0');
  assert.equal(m.cpu.r[0], 0o177402);
  assert.equal(cc(m), flags(''));
  m = exec('SEN\nSXT R0\nCLN\nSXT R1');
  assert.equal(m.cpu.r[0], 0o177777);
  assert.equal(m.cpu.r[1], 0);
  assert.equal(cc(m), flags('Z'));
});

test('EIS: MUL, DIV, ASH, ASHC', () => {
  let m = exec('MOV #1000.,R0\nMUL #-300.,R0');
  assert.equal(((m.cpu.r[0] << 16) | m.cpu.r[1]) | 0, -300000);
  assert.equal(cc(m), flags('NC'));
  m = exec('MOV #7,R3\nMUL #6,R3');
  assert.equal(m.cpu.r[3], 42);
  m = exec('MOV #1,R2\nMOV #0,R3\nDIV #10.,R2'); // 65536 / 10
  assert.equal(m.cpu.r[2], 6553);
  assert.equal(m.cpu.r[3], 6);
  m = exec('MOV #177777,R2\nMOV #177771,R3\nDIV #2,R2'); // -7 / 2
  assert.equal(m.cpu.r[2], 0o177775);
  assert.equal(m.cpu.r[3], 0o177777);
  m = exec('MOV #1,R2\nCLR R3\nDIV #1,R2');
  assert.equal(cc(m) & FLAG_V, FLAG_V, 'quotient past niet');
  m = exec('CLR R2\nMOV #5,R3\nDIV #0,R2');
  assert.equal(cc(m) & (FLAG_V | FLAG_C), FLAG_V | FLAG_C);
  m = exec('MOV #3,R0\nASH #4,R0\nMOV #-8.,R1\nASH #-2,R1');
  assert.equal(m.cpu.r[0], 0o60);
  assert.equal(m.cpu.r[1], 0o177776);
  m = exec('MOV #40000,R0\nASH #1,R0');
  assert.equal(cc(m), flags('NV'));
  m = exec('MOV #1,R0\nMOV #100000,R1\nASHC #1,R0');
  assert.equal(m.cpu.r[0], 3);
  assert.equal(m.cpu.r[1], 0);
});

test('XOR, SOB, JSR/RTS en MARK', () => {
  let m = exec('MOV #177400,R1\nMOV #012345,R0\nXOR R1,R0');
  assert.equal(m.cpu.r[0], 0o165745);
  m = exec('MOV #5,R1\nCLR R0\n1$:\tINC R0\nSOB R1,1$');
  assert.equal(m.cpu.r[0], 5);
  m = exec('MOV #3,R0\nJSR R5,SUB1\n.WORD 4\nBR KLAAR\nSUB1:\tADD (R5)+,R0\nRTS R5\nKLAAR:');
  assert.equal(m.cpu.r[0], 7);
  // MARK: parameters op de stack opruimen
  m = exec(`MOV R5,-(SP)
	MOV #11,-(SP)
	MOV #22,-(SP)
	MOV #6402,-(SP)		; de instructie MARK 2 zelf
	MOV SP,R5
	JSR PC,SUB2
	BR KLAAR
SUB2:	MOV 4(R5),R0
	ADD 2(R5),R0
	RTS R5			; springt naar MARK 2 op de stack
KLAAR:`);
  assert.equal(m.cpu.r[0], 0o33);
  assert.equal(m.cpu.r[6], 0o1000);
});

test('traps: oneven adres, niet-bestaand geheugen, ongeldige instructie, TRAP en EMT', () => {
  const src = (code) => `
	. = 4
	.WORD H4,0,H10,0
	. = 30
	.WORD H30,0,H34,0
	. = 1000
START:	MOV #START,SP
	${code}
	HALT
H4:	MOV #4,R5
	HALT
H10:	MOV #10,R5
	HALT
H30:	MOV #30,R5
	HALT
H34:	MOV #34,R5
	HALT
	.END START`;
  const vec = (code) => {
    const m = machine();
    const r = load(m, src(code));
    m.go(r.start);
    m.run(10000);
    return m.cpu.r[5];
  };
  assert.equal(vec('MOV #1001,R0\nTST (R0)'), 4);
  assert.equal(vec('TST @#170000'), 4);
  assert.equal(vec('.WORD 7'), 0o10);
  assert.equal(vec('.WORD 075000'), 0o10); // FIS bestaat niet zonder optie
  assert.equal(vec('EMT 5'), 0o30);
  assert.equal(vec('TRAP 1'), 0o34);
});

test('trap zet PSW en PC op de stack; RTI keert terug', () => {
  const m = exec(`
	MOV #H,@#34
	MOV #340,@#36
	SEC
	TRAP 0
	MOV R1,R2
	BR KLAAR
H:	MOV 2(SP),R1		; oude PSW
	MOV @#177776,R3		; PSW in de trap
	RTI
KLAAR:`);
  assert.equal(m.cpu.r[1] & FLAG_C, FLAG_C);
  assert.equal(m.cpu.r[3], 0o340);
  assert.equal(m.cpu.r[6], 0o1000);
});

test('interrupts gaan alleen door boven de processorprioriteit', () => {
  const m = machine();
  const r = load(m, `
	. = 100
	.WORD KLOK,300
	. = 1000
START:	MOV #START,SP
	CLR R0
	MOV #340,@#177776	; prioriteit 7: klok geblokkeerd
	MOV #100,@#177546
	MOV #50000.,R1
1$:	SOB R1,1$
	MOV R0,R4		; nog geen tikken
	CLR @#177776		; prioriteit 0
2$:	WAIT
	CMP R0,#3
	BLO 2$
	HALT
KLOK:	INC R0
	RTI
	.END START`);
  m.go(r.start);
  m.run(200000);
  assert.equal(m.cpu.halted, true);
  assert.equal(m.cpu.r[4], 0);
  assert.equal(m.cpu.r[0], 3);
  assert.ok(m.time > 40000 && m.time < 200000);
});

test('T-bit geeft een trace-trap na elke instructie', () => {
  const m = exec(`
	MOV #T,@#14
	CLR @#16
	CLR R0
	MOV #20,-(SP)		; PSW met T
	MOV #1$,-(SP)
	RTT
1$:	NOP
	NOP
	NOP
	BR KLAAR
T:	INC R0
	CMP R0,#3
	BLO 2$
	BIC #20,2(SP)		; T uit
2$:	RTT
KLAAR:`);
  assert.equal(m.cpu.r[0], 3);
});

// ---------- Assembler en disassembler ----------

test('assembler: adresseermodi en codering', () => {
  const r = assemble(`	. = 1000
A:	MOV	R1,R2
	MOV	(R1)+,@(R2)+
	MOV	-(R3),@-(R4)
	MOV	2(R5),@4(SP)
	MOV	#123,@#177570
	MOV	A,@A
	MOVB	#'A,R0
	.END A`);
  const words = [];
  const b = r.segments[0].bytes;
  for (let i = 0; i < b.length; i += 2) words.push(b[i] | (b[i + 1] << 8));
  assert.deepEqual(words.map((w) => w.toString(8)), [
    '10102', '12132', '14354', '16576', '2', '4',
    '12737', '123', '177570',
    '16777', '177752', '177750',
    '112700', '101',
  ]);
  assert.equal(r.start, 0o1000);
});

test('assembler: getallen, expressies, tekst en lokale labels', () => {
  const r = assemble(`	. = 2000
	.WORD	10, 10., ^B101, ^D99, <1+2>*3, 1+2*3, ^C0, "AB
	.BYTE	'a, 377
	.ASCIZ	/hi/<15>
	.EVEN
X:	BR	1$
1$:	BR	X
Y:	BR	1$
1$:	.WORD	.`);
  const b = r.segments[0].bytes;
  const w = (i) => b[2 * i] | (b[2 * i + 1] << 8);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(w), [8, 10, 5, 99, 9, 9, 0xFFFF, 0x4241]);
  assert.deepEqual(b.slice(16, 22), [97, 255, 104, 105, 13, 0]);
  assert.equal(r.symbols.get('X'), 0o2026);
  assert.equal(w(11), 0o400);
  assert.equal(w(12), 0o776);
  assert.equal(w(13), 0o400);
  assert.equal(w(14), 0o2034);
});

test('assembler: duidelijke foutmeldingen met regelnummer', () => {
  const fails = (src, re) => {
    assert.throws(() => assemble(src), (e) => e instanceof AsmError && re.test(e.message));
  };
  fails('\tMOV R0', /2 operanden/);
  fails('\tFOO R1,R2', /onbekende instructie FOO/);
  fails('\tMOV #9,R0', /geen octaal getal/);
  fails('\tBR X', /onbekend symbool X/);
  fails('\t.BYTE 1\n\tCLR R0', /regel 2: instructie op een oneven adres/);
  fails('A:\tCLR R0\nA:\tCLR R1', /dubbel/);
  fails('\t. = 1000\n\tBR X\n\t.BLKW 200\nX:\tHALT', /te ver weg/);
  fails('\tJMP R0', /register/);
});

test('disassembler leest terug wat de assembler maakt', () => {
  const m = machine();
  load(m, `	. = 1000
	MOV	#123,@#177570
	JSR	PC,@10(R1)
	SOB	R2,.
	ASHC	#-3,R2
	TRAP	17
	BNE	.+4`);
  const texts = [];
  let a = 0o1000;
  for (let i = 0; i < 6; i++) {
    const d = disassemble((x) => m.peekWord(x), a);
    texts.push(d.text.replace(/\s+/g, ' '));
    a += d.size;
  }
  assert.deepEqual(texts, [
    'MOV #000123,@#177570', 'JSR PC,@000010(R1)', 'SOB R2,001012', 'ASHC #177775,R2', 'TRAP 17', 'BNE 001026',
  ]);
});

// ---------- Terminal, ODT en frontpaneel ----------

test('console-ODT: openen, wijzigen, LF, registers en G', () => {
  const m = machine();
  const type = (s) => { for (const ch of s) m.typeKey(ch); };
  type('1000/');
  assert.match(m.out, /1000\/000000 $/);
  type('12700\n');
  type('5\r');
  assert.equal(m.peekWord(0o1000), 0o12700);
  assert.equal(m.peekWord(0o1002), 5);
  m.poke(0o1004, 0); m.poke(0o1005, 0); // HALT
  type('R3/');
  type('17\r');
  assert.equal(m.cpu.r[3], 0o17);
  m.out = '';
  type('1000G');
  m.run(1000);
  assert.equal(m.cpu.r[0], 5);
  assert.match(m.out, /G\r\n\r\n001006\r\n@$/);
  type('X');
  assert.match(m.out, /\?\r\n@$/);
});

test('terminal: uitvoer met baudrate en invoer via het toetsenbord', () => {
  const m = machine();
  m.charTime = 1000;
  const r = load(m, `	. = 1000
START:	TSTB	@#177560
	BPL	START
	MOVB	@#177562,R0
1$:	TSTB	@#177564
	BPL	1$
	MOVB	R0,@#177566
	BR	START
	.END START`);
  m.go(r.start);
  m.out = '';
  for (const ch of 'abc') m.typeKey(ch);
  m.run(1500);
  assert.equal(m.out.length, 1, 'tekens komen niet sneller dan de baudrate');
  m.run(10000);
  assert.equal(m.out, 'abc');
});

test('frontpaneel: LOAD ADRS, DEP, EXAM, START en HALT/CONT', () => {
  const m = machine();
  const program = [0o5000, 0o5200, 0o10037, 0o177570, 0o13701, 0o177570, 0o77101, 0o771];
  m.sr = 0o1000; m.loadAddress();
  for (const w of program) { m.sr = w; m.panelDeposit(); }
  assert.equal(m.peekWord(0o1016), 0o771);
  m.sr = 0o1000; m.loadAddress();
  m.panelExamine();
  assert.equal(m.panel.data, 0o5000);
  m.panelExamine();
  assert.equal(m.panel.addr, 0o1002);
  assert.equal(m.panel.data, 0o5200);
  m.sr = 0o1000; m.loadAddress();
  m.sr = 0o100; // korte wachttijd
  m.panelStart();
  m.run(50000);
  assert.ok(m.dr > 10, 'het programma telt op de lampjes');
  m.setHaltSwitch(true);
  assert.equal(m.cpu.halted, true);
  const n = m.cpu.instructions;
  m.panelContinue(); // één instructie
  assert.equal(m.cpu.instructions, n + 1);
  assert.equal(m.cpu.halted, true);
  m.sr = 0o177700; m.loadAddress(); m.panelExamine();
  assert.equal(m.panel.data, m.cpu.r[0]);
  m.setHaltSwitch(false);
  m.panelContinue();
  assert.equal(m.cpu.halted, false);
});

test('lampjes gloeien naar verhouding van de tijd dat een bit aan is', () => {
  const m = machine();
  const r = load(m, `	. = 1000
START:	MOV	#1,@#177570
	MOV	#3,@#177570
	BR	START
	.END START`);
  m.go(r.start);
  m.lamps();
  m.run(20000);
  const l = m.lamps();
  assert.ok(l.data[0] > 0.95);
  assert.ok(l.data[1] > 0.2 && l.data[1] < 0.8);
  assert.equal(l.data[2], 0);
});

test('breekpunt stopt de processor', () => {
  const m = machine();
  const r = load(m, `	. = 1000
START:	CLR	R0
1$:	INC	R0
	BR	1$
	.END START`);
  m.go(r.start);
  assert.equal(m.run(10000, new Set([0o1002])), 'breakpoint');
  assert.equal(m.cpu.r[7], 0o1002);
  m.proceed();
  assert.equal(m.run(10000, new Set([0o1002])), 'breakpoint');
  assert.equal(m.cpu.r[0], 1);
});

// ---------- Ponskaarten ----------

test('Hollerith: DEC 029-code', () => {
  const rows = (...r) => r.reduce((v, row) => v | (row === 12 ? 0o4000 : row === 11 ? 0o2000 : 1 << (9 - row)), 0);
  assert.equal(charToHollerith('A'), rows(12, 1));
  assert.equal(charToHollerith('j'), rows(11, 1));
  assert.equal(charToHollerith('S'), rows(0, 2));
  assert.equal(charToHollerith('0'), rows(0));
  assert.equal(charToHollerith('.'), rows(12, 8, 3));
  assert.equal(charToHollerith('='), rows(8, 6));
  assert.equal(hollerithToChar(rows(11, 8, 4)), '*');
  assert.equal(compress(rows(12, 1)), 0o201);
  assert.equal(compress(rows(0, 8, 2)), 0o52);
  const card = textToCard('hallo');
  assert.equal(card.text, 'HALLO');
  assert.equal(card.cols.length, 80);
  assert.equal(card.cols[79], 0);
});

test('kaartlezer: kolommen, kaart klaar, lege bak en timing error', () => {
  const m = machine();
  m.loadCards([textToCard('AB')]);
  assert.equal(m.ioRead(ADDR.CRS, false) & CR.ONLINE, CR.ONLINE);
  m.halted = false;
  m.cpu.halted = false;
  m.write16(ADDR.CRS, CR.READ);
  m.time += 10000; m.pollDevices();
  assert.ok(m.ioRead(ADDR.CRS, true) & CR.COL_DONE);
  assert.equal(m.read16(ADDR.CRB1), charToHollerith('A'));
  assert.equal(m.ioRead(ADDR.CRS, true) & CR.COL_DONE, 0);
  // Kolommen niet uitlezen: timing error
  for (let i = 0; i < 100; i++) { m.time += 600; m.pollDevices(); }
  const s = m.ioRead(ADDR.CRS, true);
  assert.ok(s & CR.CARD_DONE);
  assert.ok(s & CR.TIMERR && s & CR.ERR);
  assert.ok(s & CR.SUPPLY, 'bak is nu leeg');
  assert.equal(m.cr.stacker.length, 1);
  m.write16(ADDR.CRS, CR.READ);
  assert.ok(m.ioRead(ADDR.CRS, true) & CR.ERR, 'lezen met lege bak geeft een fout');
});

test('kaartlezer met interrupts', () => {
  const m = machine();
  m.loadCards(['12', '3'].map(textToCard));
  const r = load(m, `	. = 230
	.WORD	CRINT,340
	. = 1000
START:	MOV	#START,SP
	CLR	R0		; kolommen
	CLR	R1		; kaarten
	MOV	#101,@#177160	; READ met interrupts
1$:	WAIT
	CMP	R1,#2
	BLO	1$
	HALT
CRINT:	BIT	#40000,@#177160	; kaart klaar?
	BNE	2$
	TST	@#177162	; kolom lezen
	INC	R0
	RTI
2$:	INC	R1
	BIT	#20000,@#177160	; bak leeg?
	BNE	3$
	MOV	#101,@#177160	; volgende kaart
3$:	RTI
	.END START`);
  m.go(r.start);
  m.run(1e6);
  assert.equal(m.cpu.halted, true);
  assert.equal(m.cpu.r[1], 2);
  assert.equal(m.cpu.r[0], 160);
});

// ---------- Bestanden ----------

test('absolute loader: heen en terug', () => {
  const segs = [{ start: 0o1000, bytes: Array.from({ length: 600 }, (_, i) => i & 0xFF) }, { start: 0o4000, bytes: [1, 2, 3] }];
  const lda = toAbsoluteLoader(segs, 0o1000);
  const r = parseAbsoluteLoader(lda);
  assert.equal(r.start, 0o1000);
  const flat = r.segments.flatMap((s) => s.bytes.map((b, i) => [s.start + i, b]));
  assert.deepEqual(flat, segs.flatMap((s) => s.bytes.map((b, i) => [s.start + i, b])));
  const bad = lda.slice();
  bad[12] ^= 1;
  assert.throws(() => parseAbsoluteLoader(bad), /controlegetal/);
  assert.equal(parseAbsoluteLoader(toAbsoluteLoader(segs, null)).start, null);
});

test('ponsbandlezer leest een band teken voor teken', () => {
  const m = machine();
  m.loadTape([0o101, 0o102]);
  const r = load(m, `	. = 1000
START:	MOV	#2000,R1
1$:	INC	@#177550	; lees een teken
2$:	TST	@#177550
	BMI	9$		; geen band meer
	TSTB	@#177550
	BPL	2$
	MOVB	@#177552,(R1)+
	BR	1$
9$:	HALT
	.END START`);
  m.go(r.start);
  m.run(100000);
  assert.equal(m.cpu.halted, true);
  assert.equal(m.peek(0o2000), 0o101);
  assert.equal(m.peek(0o2001), 0o102);
});

// ---------- Voorbeeldprogramma's ----------

test('alle voorbeelden assembleren', () => {
  for (const s of SAMPLES_PDP11) assert.doesNotThrow(() => assemble(s.source), s.name);
});

function runSample(name, { input = '', us = 2e6, cards = false } = {}) {
  const s = SAMPLES_PDP11.find((x) => x.name.startsWith(name));
  const m = machine();
  const r = load(m, s.source);
  if (cards) m.loadCards(SAMPLE_CARDS.split('\n').map(textToCard));
  m.out = '';
  m.go(r.start);
  m.run(100000);
  for (const ch of input) m.typeKey(ch);
  m.run(us);
  return m;
}

test('voorbeeld: hallo wereld', () => {
  const m = runSample('Hallo');
  assert.match(m.out, /^Hallo, wereld!/);
  assert.equal(m.cpu.halted, true);
});

test('voorbeeld: looplicht beweegt over de lampjes', () => {
  const m = runSample('Looplicht', { us: 3e5 });
  assert.ok(m.dr > 1 && (m.dr & (m.dr - 1)) === 0, 'precies één lampje aan');
});

test('voorbeeld: typmachine maakt hoofdletters', () => {
  const m = runSample('Typmachine', { input: 'Pdp-11\r' });
  assert.match(m.out, /PDP-11\r\n$/);
});

test('voorbeeld: klok telt seconden', () => {
  const m = runSample('Klok', { us: 2.05e6 });
  assert.match(m.out, /00:00:01\r\n00:00:02\r\n$/);
  assert.equal(m.dr, 2);
});

test('voorbeeld: 168 priemgetallen onder de 1000', () => {
  const m = runSample('Priem', { us: 5e6 });
  const nums = m.out.match(/\d+/g).map(Number).filter((n) => n < 1000);
  assert.equal(m.cpu.halted, true);
  assert.equal(nums.length, 168);
  assert.equal(nums[nums.length - 1], 997);
});

test('voorbeeld: TRAP-systeemaanroepen', () => {
  const m = runSample('Systeem', { input: 'Ada\r' });
  assert.match(m.out, /Hoe heet je\? Ada\r\nHallo, Ada! /);
});

test('voorbeeld: ponskaarten lezen', () => {
  const m = runSample('Ponskaarten', { cards: true });
  const lines = SAMPLE_CARDS.split('\n');
  for (const l of lines) assert.ok(m.out.includes(l.toUpperCase() + '\r\n'), l);
  assert.match(m.out, /KAARTENBAK LEEG/);
  assert.equal(m.cpu.r[0], lines.length);
});
