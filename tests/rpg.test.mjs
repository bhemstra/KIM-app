import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRPG, runRPG, numToChar } from '../js/as400/rpg.js';
import { factoryState } from '../js/as400/db.js';
import { SqlEngine } from '../js/as400/sql.js';
import { Session, createSystem } from '../js/as400/session.js';

// Een programma compileren en draaien tegen de demobestanden
function run(src, { args = [], answers = [], state = factoryState() } = {}) {
  const find = (n) => state.libs.DEMO.objs[`${n}|*FILE`] || null;
  const c = compileRPG(src.trim().split('\n'), { fileInfo: find });
  assert.deepEqual(c.errors, [], 'compileerfouten');
  const out = { shown: [], spool: {}, state };
  const env = {
    name: 'TEST',
    openFile: (n) => (find(n) ? { obj: find(n), lib: 'DEMO' } : null),
    spool: (f, lines) => { out.spool[f] = (out.spool[f] || []).concat(lines); },
    today: () => '2026-11-19',
    timestamp: () => '2026-11-19-12.00.00.000000',
    exec: (t) => { (out.cmds ||= []).push(t); return {}; },
    *call(q, a) { (out.calls ||= []).push([q.obj, a]); return []; },
  };
  const g = runRPG(c.prog, args, env);
  let step = g.next();
  while (!step.done) {
    out.shown.push(step.value.inquiry ?? step.value.info);
    step = g.next(answers.shift());
  }
  return out;
}

const errorsOf = (src) => compileRPG(src.trim().split('\n'), { fileInfo: (n) => factoryState().libs.DEMO.objs[`${n}|*FILE`] || null }).errors;

test('rekenen: packed kapt af, EVAL(H) rondt af, overloop geeft een fout', () => {
  const r = run(`
**free
dcl-s a packed(5:2);
dcl-s b packed(5:2);
dcl-s c packed(3:0);
a = 10 / 3;
eval(h) b = 10 / 3 + 0.005;
dsply (%char(a) + ' ' + %char(b) + ' ' + %char(-0.5) + ' ' + %char(%dec('12.345' : 5 : 2)));
monitor;
  c = 999 + 1;
on-error 103;
  dsply 'te groot';
endmon;
`);
  assert.equal(r.shown[0], 'DSPLY  3.33 3.34 -.5 12.34\nDSPLY  te groot');
});

test('teksten: vaste lengte, %TRIM, %SUBST (ook als doel), %SCAN, %EDITC', () => {
  const r = run(`
**free
dcl-s t char(10) inz('abc');
dcl-s v varchar(20);
dcl-s bedrag packed(9:2) inz(-1234.5);
v = t + '|';
dsply v;
dsply (%trim(t) + '|' + %subst('ABCDEF' : 2 : 3) + %char(%scan('C' : 'ABCDEF')));
%subst(t : 2 : 1) = 'X';
dsply t;
dsply ('[' + %editc(bedrag : 'J') + '] [' + %editc(bedrag : 'X') + ']');
dsply (%upper('aap') + %xlate('ab' : 'xy' : 'abc') + %char(%len(t)));
`);
  assert.deepEqual(r.shown[0].split('\n'), [
    'DSPLY  abc       |',
    'DSPLY  abc|BCD3',
    'DSPLY  aXc',
    'DSPLY  [    1,234.50-] [000123450]',
    'DSPLY  AAPxyc10',
  ]);
});

test('lussen, SELECT, LEAVE/ITER, arrays en subroutines', () => {
  const r = run(`
**free
dcl-s i int(10);
dcl-s som int(10) inz(0);
dcl-s arr int(10) dim(5);
dcl-s s varchar(20);
for i = 1 to 10;
  if i = 3;
    iter;
  endif;
  if i > 6;
    leave;
  endif;
  som += i;
endfor;
for i = %elem(arr) downto 1;
  arr(i) = i * i;
endfor;
i = 0;
dou i >= 3;
  i += 1;
  select;
  when i = 1;
    s += 'een ';
  when i = 2;
    s += 'twee ';
  other;
    exsr drie;
  endsl;
enddo;
dsply (%char(som) + ' ' + %char(arr(4)) + ' ' + s);
begsr drie;
  s += 'drie';
endsr;
`);
  assert.equal(r.shown[0], 'DSPLY  18 16 een twee drie'); // 1+2+4+5+6
});

test('procedures met parameters: CONST, VALUE en terugschrijven', () => {
  const r = run(`
**free
dcl-s x packed(5:0) inz(10);
dcl-s y packed(5:0);
y = kwadraat(x);
verhoog(x);
dsply (%char(x) + ' ' + %char(y) + ' ' + %char(kwadraat(3)));

dcl-proc kwadraat;
  dcl-pi *n packed(9:0);
    n packed(5:0) const;
  end-pi;
  return n * n;
end-proc;

dcl-proc verhoog;
  dcl-pi *n;
    n packed(5:0);
  end-pi;
  n += 1;
end-proc;
`);
  assert.equal(r.shown[0], 'DSPLY  11 100 9');
});

test('bestanden: READ-lus, CHAIN, SETLL/READE en UPDATE', () => {
  const r = run(`
**free
dcl-f KLANTEN keyed;
dcl-f ARTIKELEN keyed usage(*update);
dcl-s n int(10) inz(0);
dcl-s eerste packed(5:0);
setll 10050 KLANTEN;
read KLANTEN;
eerste = KLNR;
dow not %eof(KLANTEN);
  n += 1;
  read KLANTEN;
enddo;
chain 99999 KLANTEN;
if not %found(KLANTEN);
  dsply ('vanaf ' + %char(eerste) + ': ' + %char(n) + ', 99999 niet gevonden');
endif;
chain ('A100') ARTIKELEN;
VOORRAAD -= 2;
update ARTIKELEN;
`);
  assert.equal(r.shown[0], 'DSPLY  vanaf 10050: 4, 99999 niet gevonden');
  assert.equal(r.state.libs.DEMO.objs['ARTIKELEN|*FILE'].rows[0][3], 38);
});

test('bestanden: WRITE met dubbele sleutel en DELETE', () => {
  const state = factoryState();
  const r = run(`
**free
dcl-f ARTIKELEN keyed usage(*update : *output : *delete);
ARTNR = 'A600';
OMSCHR = 'Magneetband';
PRIJS = 19.95;
VOORRAAD = 3;
write ARTIKELEN;
monitor;
  write ARTIKELEN;
on-error 1021;
  dsply 'dubbel';
endmon;
delete ('A200') ARTIKELEN;
`, { state });
  assert.equal(r.shown[0], 'DSPLY  dubbel');
  const rows = state.libs.DEMO.objs['ARTIKELEN|*FILE'].rows;
  assert.deepEqual(rows.map((x) => x[0]), ['A100', 'A300', 'A400', 'A500', 'A600']);
});

test('printerbestand: regels gaan naar de spool', () => {
  const r = run(`
**free
dcl-f QSYSPRT printer(40);
dcl-s regel char(40);
regel = 'eerste regel';
write QSYSPRT regel;
regel = 'tweede';
write QSYSPRT regel;
`);
  assert.deepEqual(r.spool.QSYSPRT, ['eerste regel', 'tweede']);
});

test('DSPLY met antwoord wacht op de gebruiker; programmaparameters', () => {
  const r = run(`
**free
dcl-pi *n;
  wie char(10);
end-pi;
dcl-s antw char(10);
dcl-s getal packed(5:0);
dsply ('Hoi ' + %trim(wie));
dsply 'Getal?' '' getal;
dsply 'Naam?' '' antw;
dsply (%char(getal * 2) + ' ' + %trim(antw));
`, { args: ['Kim'], answers: ['21', 'Bart'] });
  assert.deepEqual(r.shown, ['DSPLY  Hoi Kim\nDSPLY  Getal?', 'DSPLY  Naam?', 'DSPLY  42 Bart']);
});

test('QCMDEXC en andere programma\'s aanroepen via een prototype', () => {
  const r = run(`
**free
dcl-pr qcmdexc extpgm('QCMDEXC');
  cmd char(200) const;
  len packed(15:5) const;
end-pr;
dcl-pr teller extpgm('TELLER');
  n packed(3:0) const;
end-pr;
qcmdexc('CRTLIB LIB(VANRPG)' : 18);
teller(7);
`);
  assert.deepEqual(r.cmds, ['CRTLIB LIB(VANRPG)']);
  assert.deepEqual(r.calls, [['TELLER', [7]]]);
});

test('runtime-fouten melden programma en volgnummer', () => {
  const c = compileRPG(['**free', 'dcl-s i int(10);', 'i = 1 / 0;'], {});
  const g = runRPG(c.prog, [], { name: 'DEEL', seq: (l) => `000${l}.00` });
  assert.throws(() => g.next(), { id: 'RNX0102', message: /divide by zero\. \(program DEEL, statement 0002\.00\)/ });
});

test('compileerfouten', () => {
  const ids = (src) => errorsOf(src).map((e) => e.id + ':' + e.line);
  assert.deepEqual(ids(`
**free
dcl-s x char(5);
y = 1;
`), ['RNF7030:2']);
  assert.match(errorsOf(`
**free
dcl-s x char(5);
if x = 'a';
  x = 'b';
`)[0].text, /ENDIF is missing/);
  const e = errorsOf(`
**free
dcl-f KLANTEN;
chain 1 KLANTEN;
update KLANTEN;
write KLANTEN;
dcl-f ONBEKEND;
x = 1
`).map((x) => x.text);
  assert.ok(e.some((t) => /needs a KEYED file/.test(t)));
  assert.ok(e.some((t) => /UPDATE needs USAGE\(\*UPDATE\)/.test(t)));
  assert.ok(e.some((t) => /WRITE needs USAGE\(\*OUTPUT\)/.test(t)));
  assert.ok(e.some((t) => /ONBEKEND is not found/.test(t)));
  assert.ok(e.some((t) => /semicolon/.test(t)));
});

test('numToChar zoals %CHAR', () => {
  assert.equal(numToChar(0.5, 2), '.50');
  assert.equal(numToChar(-12.5, 2), '-12.50');
  assert.equal(numToChar(0, 2), '.00');
  assert.equal(numToChar(42), '42');
});

test('SQL PRIMARY KEY geeft sleutels en voorkomt dubbele waarden', () => {
  const st = factoryState();
  const env = {
    getTable(s, n) { return { obj: st.libs.DEMO.objs[`${n}|*FILE`], lib: 'DEMO' }; },
    createTable(s, n, fields, rows, keys) {
      st.libs.DEMO.objs[`${n}|*FILE`] = { name: n, fields, rows, keys };
      return 'DEMO';
    },
  };
  const e = new SqlEngine(env);
  e.run('CREATE TABLE T (A INT, B CHAR(5), PRIMARY KEY (A))');
  assert.deepEqual(st.libs.DEMO.objs['T|*FILE'].keys, ['A']);
  e.run("INSERT INTO T VALUES (1, 'x'), (2, 'y')");
  assert.throws(() => e.run("INSERT INTO T VALUES (1, 'z')"), { id: 'SQL0803' });
  assert.throws(() => e.run('UPDATE T SET A = 1'), { id: 'SQL0803' });
});

test('in de sessie: compileren met optie 14, CALL, spool en VOORRAAD', () => {
  const sys = createSystem(null, { clock: () => new Date(2026, 10, 19, 10, 0, 0) });
  const s = new Session(sys);
  s.aid('ENTER', { user: 'QSECOFR', pwd: 'QSECOFR' });
  s.aid('ENTER', { cmd: 'WRKMBRPDM DEMO/QRPGLESRC' });
  const row = s.screen().lines().findIndex((l) => l.includes('KLANTLST'));
  s.aid('ENTER', { [s.screen().fields.find((f) => f.row === row).name]: '14' });
  assert.match(s.message.text, /^Program KLANTLST placed in library DEMO\. 00 highest severity\./);
  s.aid('F3');
  s.aid('ENTER', { cmd: 'CALL KLANTLST' });
  assert.match(s.screen().toString(), /DSPLY 8 klanten, totaal saldo 30287\.84/);
  s.aid('ENTER');
  const lst = sys.state.spool.filter((f) => f.file === 'QSYSPRT').at(-1);
  assert.equal(lst.lines.at(-1), 'Totaal                                                 30,287.84');

  s.aid('ENTER', { cmd: 'CRTBNDRPG VOORRAAD' });
  s.aid('ENTER', { cmd: 'CALL VOORRAAD' });
  s.aid('ENTER', { reply: 'a500' });
  s.aid('ENTER', { reply: '2' });
  assert.match(s.screen().toString(), /Nieuwe voorraad van A500: 3/);
  s.aid('ENTER', { reply: '' });
  assert.equal(sys.state.libs.DEMO.objs['ARTIKELEN|*FILE'].rows[4][3], 3);

  // Een fout in de bron: geen programma, wel een compileerlijst
  sys.state.libs.DEMO.objs['QRPGLESRC|*FILE'].members.HALLORPG.lines.push({ seq: '0099.00', data: 'onbekend = 1;' });
  s.aid('ENTER', { cmd: 'CRTBNDRPG HALLORPG' });
  assert.match(s.message.text, /^Compilation stopped\. Severity 30 errors found in program HALLORPG/);
  assert.ok(sys.state.spool.at(-1).lines.some((l) => l.includes('RNF7030')));
});

test('oude schijven krijgen sleutels en RPG-voorbeelden', () => {
  const old = factoryState();
  delete old.rpgDemo;
  delete old.libs.DEMO.objs['QRPGLESRC|*FILE'];
  for (const n of ['KLANTEN', 'ARTIKELEN', 'ORDERS']) delete old.libs.DEMO.objs[`${n}|*FILE`].keys;
  const sys = createSystem(JSON.parse(JSON.stringify(old)));
  assert.ok(sys.state.libs.DEMO.objs['QRPGLESRC|*FILE'].members.VOORRAAD);
  assert.deepEqual(sys.state.libs.DEMO.objs['KLANTEN|*FILE'].keys, ['KLNR']);
});
