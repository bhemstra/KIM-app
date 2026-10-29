import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Junior, JZ, Z, KEY, LOOK } from '../js/junior.js';
import { HEX_SEGMENTS } from '../js/board.js';
import { assemble } from '../js/assembler.js';
import { SAMPLES_JUNIOR } from '../js/samples-junior.js';

const seg = (h) => HEX_SEGMENTS[h];

function boot(rom) {
  const j = new Junior();
  if (rom) { j.loadRealRom(rom); j.reset(); }
  j.run(20000);
  return j;
}

function load(j, src) {
  const r = assemble(src);
  for (const s of r.segments) s.bytes.forEach((b, i) => j.poke(s.start + i, b));
  return r;
}

// Toets indrukken en loslaten, met wat rekentijd ertussen (nodig voor de echte ROM)
function tap(j, ...codes) {
  for (const c of codes) {
    j.keyDown(c); j.run(30000);
    j.keyUp(c); j.run(30000);
  }
}

function frame(j) {
  j.displayImage();
  j.run(40000);
  return j.displayImage();
}

test('LOOK is de actief-lage segmenttabel van de Junior', () => {
  assert.deepEqual(LOOK, [0x40, 0x79, 0x24, 0x30, 0x19, 0x12, 0x02, 0x78, 0x00, 0x10, 0x08, 0x03, 0x46, 0x21, 0x06, 0x0E]);
});

test('monitor: adres en data intikken', () => {
  const j = boot();
  assert.equal(j.monitorLabel, 'MONITOR AD');
  tap(j, KEY.AD, 0, 2, 0, 0, KEY.DA, 0xA, 9, KEY.PLUS, 4, 2);
  assert.equal(j.peek(0x200), 0xA9);
  assert.equal(j.peek(0x201), 0x42);
  assert.deepEqual(frame(j), [seg(0), seg(2), seg(0), seg(1), seg(4), seg(2)]);
});

test('GO en BRK terug naar de monitor', () => {
  const j = boot();
  load(j, '  .ORG $0200\n  LDA #$42\n  BRK');
  tap(j, KEY.AD, 0, 2, 0, 0, KEY.GO);
  j.run(10000);
  assert.equal(j.monitorLabel, 'MONITOR AD');
  assert.equal(j.z(Z.ACC), 0x42);
  assert.equal(j.point, 0x0204);
});

test('SST stapt per instructie', () => {
  const j = boot();
  load(j, '  .ORG $0200\n  NOP\n  NOP\n  NOP');
  j.sst = true;
  tap(j, KEY.AD, 0, 2, 0, 0, KEY.GO);
  assert.equal(j.point, 0x201);
  tap(j, KEY.GO);
  assert.equal(j.point, 0x202);
});

test('voorbeeldprogramma\'s draaien', () => {
  for (const s of SAMPLES_JUNIOR) assemble(s.source);
  const j = boot();
  load(j, SAMPLES_JUNIOR.find((s) => s.name.startsWith('Lichtkrant')).source);
  j.go(0x200);
  assert.deepEqual(frame(j).slice(0, 5), [0x76, 0x77, 0x38, 0x38, 0x3F]);
});

test('editor: instructies invoegen en wissen, assembler vult labels in', () => {
  const j = boot();
  // BEGAD = $0200, ENDAD = $0300
  j.mem[JZ.BEGADL] = 0x00; j.mem[JZ.BEGADH] = 0x02;
  j.mem[JZ.ENDADL] = 0x00; j.mem[JZ.ENDADH] = 0x03;
  tap(j, KEY.AD, 1, 0xC, 0xB, 5, KEY.GO);
  assert.equal(j.monitorLabel, 'EDITOR');
  // INSERT (AD) labeldefinitie FF 01, daarna INPUT (GO) van NOP en een JMP naar label 01
  tap(j, KEY.AD, 0xF, 0xF, 0, 1, 0, 0);
  tap(j, KEY.GO, 0xE, 0xA);
  tap(j, KEY.GO, 4, 0xC, 0, 1, 0, 0);
  assert.deepEqual([...j.mem.slice(0x200, 0x208)], [0xFF, 0x01, 0x00, 0xEA, 0x4C, 0x01, 0x00, 0x77]);
  // Na de JMP volgt de eindmarkering $77; ASSEMB vult het label in
  j.keysDown.clear();
  j.go(0x1F51);
  j.run(10000);
  assert.deepEqual([...j.mem.slice(0x200, 0x204)], [0xEA, 0x4C, 0x00, 0x02]);
});

test('BRANCH berekent de sprongafstand', () => {
  const j = boot();
  j.go(0x1FD5);
  j.run(1000);
  assert.equal(j.monitorLabel, 'BRANCH');
  tap(j, 1, 0, 0, 8);
  assert.equal(j.z(Z.INH), 0xF6); // van $10 naar $08: -10
});

// Vergelijking met de echte monitor-EPROM (niet meegeleverd):
//   JUNIOR_ROM=/pad/naar/monitor.bin npm test
const romPath = process.env.JUNIOR_ROM;
test('zelfde gedrag als de originele monitor-ROM', { skip: !romPath || !existsSync(romPath) }, () => {
  const rom = new Uint8Array(readFileSync(romPath));
  const keys = [KEY.AD, 0, 2, 0, 0, KEY.DA, 0xA, 9, KEY.PLUS, 4, 2, KEY.PLUS, 0, 0, KEY.AD, 0, 2, 0, 1];
  const results = [];
  for (const r of [null, rom]) {
    const j = boot(r);
    tap(j, ...keys);
    results.push({ mem: [...j.mem.slice(0x200, 0x203)], img: frame(j), point: j.point });
  }
  assert.deepEqual(results[0], results[1]);

  // Editor op beide machines
  const ed = [];
  for (const r of [null, rom]) {
    const j = boot(r);
    j.mem[JZ.BEGADL] = 0x00; j.mem[JZ.BEGADH] = 0x02;
    j.mem[JZ.ENDADL] = 0x00; j.mem[JZ.ENDADH] = 0x03;
    tap(j, KEY.AD, 1, 0xC, 0xB, 5, KEY.GO);
    tap(j, KEY.AD, 0xA, 9, 0x4, 0x2); // insert LDA #$42
    tap(j, KEY.GO, 0x8, 0xD, 0x0, 0x0, 0x0, 0x3); // input STA $0300
    tap(j, KEY.GO, 0xE, 0xA); // input NOP
    tap(j, KEY.PC, 0x8, 0xD, 0x0, 0x0); // search 8D 00
    tap(j, KEY.DA); // delete de STA
    tap(j, KEY.PLUS, 3); // skip, daarna een ongeldige toets: EEEEEE
    ed.push({ mem: [...j.mem.slice(0x200, 0x208)], img: frame(j), zp: [...j.mem.slice(0xE1, 0x100)] });
  }
  assert.deepEqual(ed[0].mem, ed[1].mem);
  assert.deepEqual(ed[0].img, ed[1].img);
  assert.deepEqual(ed[0].zp.slice(0, 9), ed[1].zp.slice(0, 9));
});

test('assembler, BRANCH en SCANDS gelijk aan de originele monitor-ROM', { skip: !romPath || !existsSync(romPath) }, () => {
  const rom = new Uint8Array(readFileSync(romPath));
  const out = [];
  for (const r of [null, rom]) {
    const j = boot(r);
    j.mem[JZ.BEGADL] = 0x00; j.mem[JZ.BEGADH] = 0x02;
    j.mem[JZ.ENDADL] = 0x00; j.mem[JZ.ENDADH] = 0x03;
    tap(j, KEY.AD, 1, 0xC, 0xB, 5, KEY.GO);
    tap(j, KEY.AD, 0xF, 0xF, 0, 1, 0, 0); // label 01
    tap(j, KEY.GO, 0xE, 0xA);
    tap(j, KEY.GO, 0xD, 0, 0, 1); // BNE label 01
    tap(j, KEY.GO, 2, 0, 0, 1, 0, 0); // JSR label 01
    j.reset(); j.run(20000);
    tap(j, KEY.AD, 1, 0xF, 5, 1, KEY.GO);
    const asm = [...j.mem.slice(0x200, 0x208)];
    j.reset(); j.run(20000);
    tap(j, KEY.AD, 1, 0xF, 0xD, 5, KEY.GO, 2, 0, 1, 0);
    const br = [j.z(Z.POINTH), j.z(Z.POINTL), j.z(Z.INH)];
    j.reset(); j.run(20000);
    load(j, SAMPLES_JUNIOR.find((s) => s.name.startsWith('Teller')).source);
    tap(j, KEY.AD, 0, 2, 0, 0, KEY.GO);
    j.run(300000);
    out.push({ asm, br, img: frame(j).map((v) => v !== 0) });
  }
  assert.deepEqual(out[0], out[1]);
  assert.deepEqual(out[0].asm.slice(0, 7), [0xEA, 0xD0, 0xFD, 0x20, 0x00, 0x02, 0x77]);
});
