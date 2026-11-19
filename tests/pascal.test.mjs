import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePascal, PascalError } from '../js/pascal.js';
import { assemble } from '../js/pdp11-asm.js';
import { PDP11 } from '../js/pdp11.js';
import { PASCAL_SAMPLES } from '../js/pascal-samples.js';

// Compileer, draai en geef de uitvoer van de terminal terug (zonder de ODT-regels)
function run(src, input = '', us = 5e6) {
  const r = assemble(compilePascal(src));
  const m = new PDP11();
  let out = '';
  m.onTTYOutput = (s) => { out += s; };
  for (const s of r.segments) s.bytes.forEach((b, i) => m.poke(s.start + i, b));
  out = '';
  m.go(r.start);
  m.run(100000);
  for (const ch of input) m.typeKey(ch);
  m.run(us);
  assert.equal(m.cpu.halted, true, 'programma moet klaar zijn');
  return out.replace(/\r\n\d{6}\r\n@$/, '').replace(/Programma klaar\.$/, '').replace(/\r\n/g, '\n');
}

const body = (s, decl = 'var i, j, k: integer; b: boolean; c: char;') => `program t; ${decl} begin ${s} end.`;

test('rekenen met integers', () => {
  assert.equal(run(body('writeln(1 + 2 * 3, (1 + 2) * 3, 7 div 2, 7 mod 2, -7 div 2, -7 mod 2, -(3 - 5))')), '7931-3-12\n\n');
  assert.equal(run(body("i := 100; j := 7; writeln(i div j, ' ', i mod j, ' ', abs(-5), ' ', sqr(9), ' ', succ(4), ' ', pred(4))")), '14 2 5 81 5 3\n\n');
  assert.equal(run(body("i := -32767 - 1; writeln(i, ' ', maxint)")), '-32768 32767\n\n');
});

test('vergelijkingen en booleans', () => {
  assert.equal(run(body("writeln(1 < 2, ' ', 2 <= 1, ' ', 3 = 3, ' ', 3 <> 3, ' ', 'a' < 'b', ' ', true and false, ' ', true or false, ' ', not true, ' ', odd(7))")),
    'TRUE FALSE TRUE FALSE TRUE FALSE TRUE FALSE TRUE\n\n');
  assert.equal(run(body("i := -5; b := (i < 0) and (i > -10); writeln(b)")), 'TRUE\n\n');
});

test('tekens en breedte', () => {
  assert.equal(run(body("c := 'x'; writeln(c, ord(c):4, chr(65):3, 'ab':4, true:5, '|')")), 'x 120  A  ab TRUE|\n\n');
  assert.equal(run(body("writeln('it''s')")), "it's\n\n");
});

test('if, while, repeat en for', () => {
  assert.equal(run(body("for i := 1 to 5 do write(i); writeln; for i := 3 downto 1 do write(i); writeln")), '12345\n321\n\n');
  assert.equal(run(body("i := 0; while i < 3 do begin write(i); i := i + 1 end; repeat i := i - 1 until i = 0; write(i)")), '0120\n');
  assert.equal(run(body("for i := 1 to 0 do write('x'); write('.'); for i := 32766 to maxint do write('y')")), '.yy\n');
  assert.equal(run(body("for i := 1 to 4 do if odd(i) then write('o') else write('e')")), 'oeoe\n');
  assert.equal(run(body("for c := 'a' to 'e' do write(c)")), 'abcde\n');
});

test('procedures, functies, var-parameters en recursie', () => {
  const src = `program p;
var x, y: integer;
procedure swap(var a, b: integer);
var t: integer;
begin t := a; a := b; b := t end;
function fib(n: integer): integer;
begin if n < 2 then fib := n else fib := fib(n - 1) + fib(n - 2) end;
function som(a, b, c: integer): integer;
begin som := a * 100 + b * 10 + c end;
begin
  x := 1; y := 2; swap(x, y); writeln(x, y);
  writeln(fib(15), ' ', som(1, 2, 3))
end.`;
  assert.equal(run(src), '21\n610 123\n\n');
});

test('arrays: globaal, lokaal, als var-parameter en met char-index', () => {
  const src = `program a;
type rij = array [1..5] of integer;
var r: rij; i: integer; tel: array ['a'..'e'] of integer; c: char;
procedure dubbel(var q: rij);
var k: integer;
begin for k := 1 to 5 do q[k] := q[k] * 2 end;
function lokaal: integer;
var l: array [0..3] of integer; k, s: integer;
begin
  for k := 0 to 3 do l[k] := k * k;
  s := 0;
  for k := 0 to 3 do s := s + l[k];
  lokaal := s
end;
begin
  for i := 1 to 5 do r[i] := i;
  dubbel(r);
  for i := 1 to 5 do write(r[i]:3);
  writeln;
  for c := 'a' to 'e' do tel[c] := ord(c) - 96;
  writeln(tel['c'], ' ', lokaal)
end.`;
  assert.equal(run(src), '  2  4  6  8 10\n3 14\n\n');
});

test('array van arrays', () => {
  const src = `program m;
type regel = array [1..3] of integer;
var t: array [1..3] of regel; i, j: integer;
begin
  for i := 1 to 3 do for j := 1 to 3 do t[i][j] := i * j;
  for i := 1 to 3 do begin for j := 1 to 3 do write(t[i][j]:3); writeln end
end.`;
  assert.equal(run(src), '  1  2  3\n  2  4  6\n  3  6  9\n\n');
});

test('read en readln van de terminal', () => {
  const src = body("readln(i, j); writeln(i + j); read(c); readln; writeln(ord(c)); readln(k); writeln(k)");
  assert.equal(run(src, '12 -30\rQ\r9\b7\r'), '12 -30\n-18\nQ\n81\n9\b7\n7\n\n');
});

test('fouten tijdens het draaien met regelnummer', () => {
  assert.match(run('program f;\nvar i: integer;\nbegin\n  i := 300;\n  i := i * i\nend.'), /fout op regel 5: rekenoverloop/);
  assert.match(run('program f;\nvar i: integer;\nbegin\n  i := 0;\n  writeln(5 div i)\nend.'), /fout op regel 5: deling door nul/);
  assert.match(run('program f;\nvar a: array [1..3] of integer; i: integer;\nbegin\n  i := 4;\n  a[i] := 1\nend.'), /fout op regel 5: index buiten/);
  assert.match(run('program f;\nprocedure p;\nbegin\n  p\nend;\nbegin p end.'), /fout op regel 4: stack vol/);
  assert.match(run(body('writeln(chr(200))')), /chr: getal niet tussen 0 en 127/);
});

test('compileerfouten zijn begrijpelijk en hebben een regelnummer', () => {
  const fails = (src, re) => assert.throws(() => compilePascal(src), (e) => e instanceof PascalError && re.test(e.message), `${src} -> ${re}`);
  fails('program x;\nbegin\n  y := 1\nend.', /regel 3: onbekende naam y/);
  fails('program x; var i: integer;\nbegin\n  i = 1\nend.', /toekennen gaat met ':='/);
  fails('program x; var i: integer; begin i := true end.', /i is integer, maar de waarde is boolean/);
  fails("program x; var c: char; begin c := 65 end.", /chr/);
  fails('program x; var i: integer; begin if i then i := 1 end.', /voorwaarde van if moet waar of onwaar/);
  fails('program x; var i: integer;\nbegin\n  i := 1\n  i := 2\nend.', /regel 3: ';' verwacht/);
  fails('program x; var i: integer; begin if i = 1 then i := 2; else i := 3 end.', /vóór else hoort geen ';'/);
  fails('program x; var r: real; begin end.', /real/);
  fails('program x; begin end', /end\./);
  fails('program x; var i: integer; begin i := 40000 end.', /te groot/);
  fails('program x; var i: integer; begin i := 7 / 2 end.', /div/);
  fails('program x; procedure p(a: integer); begin end; begin p(1, 2) end.', /maar 1 parameter/);
  fails('program x; procedure p(var a: integer); begin end; begin p(3) end.', /var-parameter/);
  fails('program x; { nooit dicht\nbegin end.', /commentaar/);
  fails('program x; procedure a; procedure b; begin end; begin end; begin end.', /procedure binnen een procedure/);
});

test('na afloop meldt het programma dat het klaar is', () => {
  const r = assemble(compilePascal("program x;\nbegin\n  writeln('hoi')\nend."));
  const m = new PDP11();
  let out = '';
  m.onTTYOutput = (s) => { out += s; };
  for (const s of r.segments) s.bytes.forEach((b, i) => m.poke(s.start + i, b));
  out = '';
  m.go(r.start);
  m.run(1e6);
  assert.match(out, /^hoi\r\n\r\nProgramma klaar\.\r\n\d{6}\r\n@$/);
});

test('de gegenereerde code bevat de Pascal-regels als commentaar', () => {
  const asm = compilePascal("program x;\nbegin\n  writeln('hoi')\nend.");
  assert.match(asm, /; \[3\] writeln\('hoi'\)/);
  assert.match(asm, /JSR\tPC,R\.WSTR/);
});

test('voorbeelden', () => {
  const out = (name, input) => run(PASCAL_SAMPLES.find((s) => s.name.startsWith(name)).source, input, 2e7);
  assert.match(out('Hallo'), /^Hallo, wereld!/);
  assert.match(out('Tafels'), /\n  10  10  20  30  40  50  60  70  80  90 100\n/);
  assert.match(out('Raad', '42\r50\r70\r66\r'), /Hoger!\nJouw gok: 70\nLager!\nJouw gok: 66\nGoed geraden in 3 beurten!/);
  assert.match(out('Zeef'), /95 priemgetallen tot 500/);
  assert.match(out('Recursie'), / 7! = 5040\n 8! = \n\*\*\* fout op regel 11: rekenoverloop/);
  assert.match(out('Torens'), /Schijf 4 van A naar C[\s\S]*15 zetten/);
  assert.match(out('Sorteren'), /Na: +7 +11 +16 +18 +20 +21 +28 +34 +59 +77 +92 +94/);
});
