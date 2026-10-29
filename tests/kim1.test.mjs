import test from 'node:test';
import assert from 'node:assert/strict';
import { KIM1, KEY, Z, SEGMENT_TABLE } from '../js/kim1.js';
import { assemble } from '../js/assembler.js';
import { SAMPLES } from '../js/samples.js';

const seg = (h) => SEGMENT_TABLE[h] & 0x7F;

function load(kim, src) {
  const r = assemble(src);
  for (const s of r.segments) s.bytes.forEach((b, i) => kim.poke(s.start + i, b));
  return r;
}

function press(kim, ...codes) {
  for (const c of codes) { kim.keyDown(c); kim.keyUp(c); }
}

test('na reset staat de monitor klaar', () => {
  const kim = new KIM1();
  kim.run(1000);
  assert.equal(kim.halted, true);
  assert.equal(kim.monitorMode, 'AD');
});

test('AD/DA/+ invoer via het keypad', () => {
  const kim = new KIM1();
  kim.run(1000);
  press(kim, KEY.AD, 0, 2, 0, 0, KEY.DA, 0xA, 9, KEY.PLUS, 4, 2);
  assert.equal(kim.peek(0x200), 0xA9);
  assert.equal(kim.peek(0x201), 0x42);
  assert.equal(kim.point, 0x201);
  assert.deepEqual(kim.displayImage(), [seg(0), seg(2), seg(0), seg(1), seg(4), seg(2)]);
});

test('GO voert een programma uit, BRK keert terug naar de monitor', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, SAMPLES[0].source);
  kim.poke(0x10, 0x25);
  kim.poke(0x11, 0x17);
  press(kim, KEY.AD, 0, 2, 0, 0, KEY.GO);
  assert.equal(kim.halted, false);
  kim.run(10000);
  assert.equal(kim.halted, true);
  assert.equal(kim.peek(0x12), 0x3C);
  assert.equal(kim.peek(Z.ACC), 0x3C);
  assert.equal(kim.point, 0x020A); // BRK op $0208, +2
});

test('SST: stap voor stap uitvoeren', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, SAMPLES[0].source);
  kim.sst = true;
  kim.go(0x200);
  kim.run(1000);
  assert.equal(kim.point, 0x201);
  press(kim, KEY.PC, KEY.GO);
  kim.run(1000);
  assert.equal(kim.point, 0x202);
});

test('ST onderbreekt een lopend programma', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, '  .ORG $300\nLOOP JMP LOOP');
  kim.go(0x300);
  kim.run(5000);
  assert.equal(kim.halted, false);
  kim.stop();
  kim.run(1000);
  assert.equal(kim.halted, true);
  assert.equal(kim.point, 0x300);
});

test('teller via SCANDS verschijnt op het display', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, SAMPLES[1].source);
  kim.go(0x200);
  kim.displayImage();
  kim.run(200000);
  const img = kim.displayImage();
  assert.equal(img[0], seg(0));
  assert.notDeepEqual(img, [0, 0, 0, 0, 0, 0]);
  assert.ok(kim.peek(0xF9) > 0);
});

test('lichtkrant stuurt de segmenten direct aan', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, SAMPLES[3].source);
  kim.go(0x200);
  kim.displayImage();
  kim.run(16000);
  assert.deepEqual(kim.displayImage(), [0x76, 0x77, 0x38, 0x38, 0x3F, 0x00]); // "HALLO "
});

test('raad het getal: HI/LO/JA', () => {
  const kim = new KIM1();
  kim.run(1000);
  load(kim, SAMPLES[4].source);
  kim.go(0x200);
  const tap = (k) => { kim.keyDown(k); kim.run(20000); kim.keyUp(k); kim.run(20000); };
  kim.run(50000);
  tap(KEY.PLUS); // start
  const secret = kim.peek(0xE6);
  const guess = (n) => { tap(n >> 4); tap(n & 0x0F); };
  guess(0x99);
  if (secret !== 0x99) assert.equal(kim.peek(0xE3), 0x76); // H
  guess(0x00);
  if (secret !== 0x00) assert.equal(kim.peek(0xE3), 0x38); // L
  guess(secret);
  assert.equal(kim.peek(0xE3), 0x1E); // J
  assert.equal(kim.peek(0xE8), 3);
});

test('teletype-uitvoer en invoer', () => {
  const kim = new KIM1();
  kim.run(1000);
  let out = '';
  kim.onTTYOutput = (s) => { out += s; };
  load(kim, SAMPLES[5].source);
  kim.go(0x200);
  kim.run(2_000_000);
  assert.match(out, /HALLO, HIER IS DE KIM-1!/);
  kim.ttyInput.push('X');
  kim.run(100000);
  assert.ok(out.endsWith('X'));
});

test('6530 timer telt af', () => {
  const kim = new KIM1();
  kim.write(0x1747, 10); // :1024
  kim.cpu.cycles += 1024 * 3 + 5;
  assert.equal(kim.read(0x1746), 7);
  assert.equal(kim.read(0x1747) & 0x80, 0);
  kim.cpu.cycles += 1024 * 10;
  assert.equal(kim.read(0x1747) & 0x80, 0x80);
});

test('virtuele cassette: DUMPT en LOADT', () => {
  const kim = new KIM1();
  kim.run(1000);
  for (let i = 0; i < 4; i++) kim.poke(0x300 + i, 0x10 + i);
  kim.poke(0x17F5, 0x00); kim.poke(0x17F6, 0x03);
  kim.poke(0x17F7, 0x04); kim.poke(0x17F8, 0x03);
  kim.poke(0x17F9, 0x42);
  kim.go(0x1800);
  kim.run(100000);
  assert.equal(kim.tapes.length, 1);
  for (let i = 0; i < 4; i++) kim.poke(0x300 + i, 0);
  kim.go(0x1873);
  kim.run(100000);
  assert.equal(kim.point, 0x0000);
  assert.equal(kim.peek(0x303), 0x13);
});

test('geheugen: spiegeling en uitbreiding', () => {
  const kim = new KIM1();
  kim.poke(0x2010, 0x55);
  assert.equal(kim.peek(0x0010), 0x55); // gespiegeld zonder uitbreiding
  assert.equal(kim.peek(0xFFFC), 0x22); // resetvector uit de ROM
  kim.expanded = true;
  kim.poke(0x2010, 0x66);
  assert.equal(kim.peek(0x0010), 0x55);
  assert.equal(kim.peek(0x2010), 0x66);
  kim.poke(0x0800, 0x77);
  assert.equal(kim.peek(0x0800), 0x77);
});
