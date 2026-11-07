import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, evalExpr, parseQual, CpfError } from '../js/as400/cl.js';
import { compileCL, runProgram, splitStatements } from '../js/as400/clpgm.js';
import { SqlEngine } from '../js/as400/sql.js';
import { factoryState } from '../js/as400/db.js';
import { Session, createSystem } from '../js/as400/session.js';
import { formatCL } from '../js/as400/seu.js';
import { COMMANDS } from '../js/as400/commands.js';

// Vaste klok: 7 november 2026, 14:35:42
const clock = () => new Date(2026, 10, 7, 14, 35, 42);

function signedOn(user = 'QSECOFR', state = null) {
  const sys = createSystem(state, { clock });
  const s = new Session(sys);
  s.aid('ENTER', { user, pwd: user });
  return s;
}

const cmd = (s, c, key = 'ENTER') => s.aid(key, { cmd: c });
const text = (s) => s.screen().toString();
const msg = (s) => s.message?.text || '';

// ---------- CL ----------

test('CL-opdrachten ontleden', () => {
  const c = parseCommand("lbl: qsys/crtlib lib(proef) text('Mijn bieb') *TEST");
  assert.equal(c.label, 'LBL');
  assert.equal(c.lib, 'QSYS');
  assert.equal(c.name, 'CRTLIB');
  assert.deepEqual(c.params, [{ kw: 'LIB', raw: 'proef' }, { kw: 'TEXT', raw: "'Mijn bieb'" }, { kw: null, raw: '*TEST' }]);
  assert.deepEqual(parseQual('demo/klanten'), { lib: 'DEMO', obj: 'KLANTEN' });
  assert.deepEqual(parseQual('KLANTEN'), { lib: '*LIBL', obj: 'KLANTEN' });
  assert.throws(() => parseCommand("SNDMSG MSG('open"), CpfError);
});

test('CL-expressies', () => {
  const vars = { '&A': 'Kim       ', '&N': 5, '&L': '1' };
  const ev = (e) => evalExpr(e, (n) => vars[n]);
  assert.equal(ev("'Hallo' *BCAT &A *TCAT '!'"), 'Hallo Kim!');
  assert.equal(ev('&N * 2 + 1'), 11);
  assert.equal(ev('(&N *GT 3) *AND &L'), '1');
  assert.equal(ev('*NOT (&N = 5)'), '0');
  assert.equal(ev("%SST('ABCDEF' 2 3)"), 'BCD');
  assert.equal(ev("%TRIM('  x  ') || 'y'"), 'xy');
  assert.equal(ev("&A *EQ 'Kim'"), '1'); // spaties aan het eind tellen niet
});

test('doorlopende regels met + en -', () => {
  const st = splitStatements([
    "SNDPGMMSG MSG('een +",
    "     twee') /* commentaar */",
    "CHGVAR VAR(&X) VALUE('a-",
    " b')",
  ]);
  assert.equal(st[0].text, "SNDPGMMSG MSG('een twee')");
  assert.equal(st[1].text, "CHGVAR VAR(&X) VALUE('a b')");
});

test('compileerfouten worden gevonden', () => {
  const r = compileCL([
    'PGM',
    'CHGVAR &X 1',
    'DOWHILE COND(1 = 1)',
    'FOO BAR(1)',
    'GOTO NERGENS',
    'ENDPGM',
  ], (n) => !!COMMANDS[n]);
  const ids = r.errors.map((e) => e.id);
  assert.ok(ids.includes('CPD0727'), 'niet-gedeclareerde variabele');
  assert.ok(ids.includes('CPD0030'), 'onbekende opdracht');
  assert.ok(ids.includes('CPD0715'), 'onbekend label');
  assert.ok(ids.includes('CPD0723'), 'ENDDO ontbreekt');
});

function run(src, args = [], answers = []) {
  const p = compileCL(src.split('\n'));
  assert.deepEqual(p.errors, []);
  const execed = [];
  const env = {
    exec: (t) => { execed.push(t); return {}; },
    jobAttr: (k) => (k === 'USER' ? 'KIM' : ''),
    sysval: () => '071126',
    *call() { return []; },
  };
  const g = runProgram(p, args, env);
  const prompts = [];
  let step = g.next();
  while (!step.done) {
    prompts.push(step.value.inquiry ?? step.value.info);
    step = g.next(answers.shift());
  }
  return { msgs: step.value.map((m) => m.text), prompts, execed };
}

test('CL-programma: lussen, SELECT, MONMSG en parameters', () => {
  const r = run(`
             PGM        PARM(&TOT)
             DCL        VAR(&TOT) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&I) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&SOM) TYPE(*DEC) LEN(5 0) VALUE(0)
             DCL        VAR(&N) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&T) TYPE(*CHAR) LEN(10)
             DOFOR      VAR(&I) FROM(1) TO(&TOT)
               IF         COND(&I *EQ 3) THEN(ITERATE)
               CHGVAR     VAR(&SOM) VALUE(&SOM + &I)
             ENDDO
             SELECT
             WHEN       COND(&SOM *GT 100) THEN(CHGVAR &T 'groot')
             OTHERWISE  CMD(CHGVAR &T 'klein')
             ENDSELECT
             CHGVAR     VAR(&N) VALUE('abc')
             MONMSG     MSGID(CPD0000) EXEC(CHGVAR &N 99)
             SNDPGMMSG  MSG(%CHAR(&SOM) *BCAT %TRIM(&T) *BCAT %CHAR(&N))
             CRTLIB     LIB(&T)
             ENDPGM`, [10]);
  assert.deepEqual(r.msgs, ['52 klein 99']); // 1+2+4+5+...+10 = 52
  assert.deepEqual(r.execed, ["CRTLIB LIB('klein')"]);
});

test('CL-programma: SNDUSRMSG wacht op een antwoord', () => {
  const r = run(`
             PGM
             DCL        VAR(&ANTW) TYPE(*CHAR) LEN(1)
 VRAAG:      SNDUSRMSG  MSG('Doorgaan?') VALUES(J N) MSGRPY(&ANTW)
             IF         COND(&ANTW *EQ 'N') THEN(RETURN)
             SNDPGMMSG  MSG('Verder')
             ENDPGM`, [], ['x', 'j']);
  assert.deepEqual(r.prompts, ['Doorgaan? (J N)', 'Doorgaan? (J N)']);
  assert.deepEqual(r.msgs, ['Verder']);
});

// ---------- SQL ----------

function sqlEngine() {
  const st = factoryState();
  const env = {
    getTable(s, n) {
      const o = st.libs[s || 'DEMO']?.objs[`${n}|*FILE`];
      if (!o) throw new CpfError('SQL0204', `${n} not found.`);
      return { obj: o, lib: s || 'DEMO' };
    },
    createTable(s, n, fields, rows) {
      st.libs[s || 'DEMO'].objs[`${n}|*FILE`] = { name: n, fields, rows };
      return s || 'DEMO';
    },
  };
  return new SqlEngine(env);
}

test('SQL: SELECT met join, groeperen en sorteren', () => {
  const e = sqlEngine();
  const r = e.run(`SELECT k.PLAATS, COUNT(*) AS N, SUM(o.AANTAL * a.PRIJS) AS BEDRAG
                   FROM DEMO/ORDERS o JOIN KLANTEN k ON k.KLNR = o.KLNR
                   JOIN DEMO.ARTIKELEN a ON a.ARTNR = o.ARTNR
                   GROUP BY k.PLAATS ORDER BY BEDRAG DESC`);
  assert.deepEqual(r.columns.map((c) => c.name), ['PLAATS', 'N', 'BEDRAG']);
  assert.deepEqual(r.rows[0], ['Scheveningen', 2, 2630]);
  const r2 = e.run("SELECT NAAM FROM KLANTEN WHERE KLNR NOT IN (SELECT KLNR FROM ORDERS) AND NAAM LIKE '%n%' ORDER BY 1");
  assert.deepEqual(r2.rows.map((x) => x[0]), ['Boekhandel Het Woord', 'Fietsenmaker Jansen', 'Tuincentrum De Linde']);
});

test('SQL: wijzigen en typecontrole', () => {
  const e = sqlEngine();
  assert.equal(e.run("INSERT INTO KLANTEN VALUES (10090, 'Nieuw BV', 'Delft', 10)").count, 1);
  assert.equal(e.run("UPDATE KLANTEN SET SALDO = SALDO * 2 WHERE PLAATS = 'Delft'").message, '1 row updated in KLANTEN in DEMO.');
  assert.deepEqual(e.run('SELECT SALDO FROM KLANTEN WHERE KLNR = 10090').rows, [[20]]);
  assert.throws(() => e.run("INSERT INTO KLANTEN VALUES (1, 'x', 'y', 'geen getal')"), { id: 'SQL0408' });
  assert.throws(() => e.run("INSERT INTO KLANTEN (KLNR) VALUES (123456)"), { id: 'SQL0406' });
  assert.throws(() => e.run("INSERT INTO ARTIKELEN (ARTNR) VALUES ('TE LANG')"), { id: 'SQL0404' });
  assert.throws(() => e.run('SELECT ONBEKEND FROM KLANTEN'), { id: 'SQL0206' });
  assert.equal(e.run('DELETE FROM KLANTEN WHERE KLNR = 1').warn, 'SQL0100');
  e.run("CREATE TABLE UTRECHT AS (SELECT * FROM KLANTEN WHERE PLAATS = 'Utrecht') WITH DATA");
  assert.equal(e.run('SELECT COUNT(*) FROM UTRECHT').rows[0][0], 3);
});

// ---------- Sessie en schermen ----------

test('elk scherm is 24 regels van hoogstens 80 tekens', () => {
  const s = signedOn();
  for (const c of ['WRKACTJOB', 'WRKSYSSTS', 'WRKSPLF', 'DSPMSG', 'WRKOBJPDM DEMO', 'WRKMBRPDM DEMO/QCLSRC',
    'DSPLIBL', 'DSPLIB DEMO', 'WRKSYSVAL', 'WRKUSRPRF', 'STRSQL', 'CALL QCMD', 'DSPFFD DEMO/KLANTEN',
    'RUNQRY *NONE DEMO/ORDERS', 'GO PROGRAM', 'WRKCMD', 'DSPJOB OPTION(*STSA)', 'CHGPWD']) {
    cmd(s, c);
    const scr = s.screen();
    const lines = scr.lines();
    assert.equal(lines.length, 24, c);
    for (const l of lines) assert.ok(l.length === 80, `${c}: regel van ${l.length} tekens`);
    for (const f of scr.fields) assert.ok(f.col + f.len <= 80, `${c}: veld ${f.name} te breed`);
    assert.equal(s.stack.length > 1 || c === 'CHGPWD', true);
    s.aid('F3');
    while (s.stack.length > 1) s.pop();
  }
});

test('aanmelden, fout wachtwoord en afmelden', () => {
  const sys = createSystem(null, { clock });
  const s = new Session(sys);
  assert.match(text(s), /Sign On/);
  s.aid('ENTER', { user: 'qsecofr', pwd: 'fout' });
  assert.equal(msg(s), 'Password not correct for user profile.');
  s.aid('ENTER', { user: 'niemand', pwd: 'x' });
  assert.equal(msg(s), 'User NIEMAND does not exist.');
  s.aid('ENTER', { user: 'qsecofr', pwd: 'qsecofr' });
  assert.match(text(s), /AS\/400 Main Menu/);
  assert.equal(sys.interactive.length, 1);
  cmd(s, '90');
  assert.match(text(s), /Sign On/);
  assert.equal(sys.interactive.length, 0);
});

test('fouten op regel 24, opdracht blijft staan; F9 haalt terug', () => {
  const s = signedOn();
  cmd(s, 'FOO');
  assert.equal(msg(s), 'Command FOO in library *LIBL not found.');
  assert.equal(s.screen().getField('cmd').value, 'FOO');
  cmd(s, 'CRTLIB LIB(PROEF)');
  assert.equal(msg(s), 'Library PROEF created.');
  cmd(s, 'CRTLIB LIB(PROEF)');
  assert.equal(msg(s), 'Library PROEF already exists.');
  s.aid('F9', { cmd: '' });
  assert.equal(s.screen().getField('cmd').value, 'CRTLIB LIB(PROEF)');
});

test('de prompter (F4) bouwt de opdracht op', () => {
  const s = signedOn();
  cmd(s, 'crtlib', 'F4');
  assert.match(text(s), /Create Library \(CRTLIB\)/);
  s.aid('ENTER', { LIB: '', TYPE: '*PROD', TEXT: '*BLANK' });
  assert.equal(msg(s), 'Value for parameter LIB required.');
  s.aid('ENTER', { LIB: 'nieuw', TYPE: '*test', TEXT: 'Mijn bibliotheek' });
  assert.equal(msg(s), 'Library NIEUW created.');
  assert.equal(s.sys.state.libs.NIEUW.type, '*TEST');
  assert.equal(s.sys.state.libs.NIEUW.text, 'Mijn bibliotheek');
  assert.ok(s.job.log.some((e) => e.text === "CRTLIB LIB(NIEUW) TYPE(*TEST) TEXT('Mijn bibliotheek')"));
});

test('PDM: compileren met optie 14 en starten', () => {
  const s = signedOn();
  cmd(s, 'WRKMBRPDM DEMO/QCLSRC');
  const i = s.screen().lines().findIndex((l) => l.includes('HALLO'));
  const opt = s.screen().fields.find((f) => f.row === i).name;
  s.aid('ENTER', { [opt]: '14' });
  assert.equal(msg(s), 'Program HALLO created in library DEMO.');
  s.aid('F3');
  cmd(s, 'CALL HALLO');
  assert.equal(msg(s), 'Hallo QSECOFR, vandaag is het 07-11-26');
  cmd(s, 'CALL TELLER');
  assert.equal(msg(s), 'Program TELLER in library *LIBL not found.');
  // De compileerlijst staat in de spool
  assert.ok(s.sys.state.spool.some((f) => f.file === 'HALLO' && f.lines.some((l) => l.includes('created'))));
});

test('RAAD: het raadspel met de vaste klok (geheim = 3542 - 35*100 = 42)', () => {
  const s = signedOn();
  cmd(s, 'CRTCLPGM RAAD');
  cmd(s, 'CALL RAAD');
  assert.match(text(s), /Ik denk aan een getal van 1 tot 100/);
  s.aid('ENTER', { reply: 'tien' });
  assert.match(text(s), /Dat is geen getal/);
  s.aid('ENTER', { reply: '10' });
  assert.match(text(s), /10 is te laag/);
  s.aid('ENTER', { reply: '50' });
  assert.match(text(s), /50 is te hoog/);
  s.aid('ENTER', { reply: '42' });
  assert.equal(msg(s), 'Goed geraden! Het was 42. Aantal pogingen: 4.');
  assert.match(text(s), /Main Menu/);
});

test('KLANTRPT: SQL vanuit CL en een query in QTEMP', () => {
  const s = signedOn();
  cmd(s, 'CRTBNDCL KLANTRPT');
  cmd(s, "CALL KLANTRPT PARM('Utrecht')");
  const t = text(s);
  assert.match(t, /Display Report/);
  assert.match(t, /Bakkerij De Korenaar/);
  assert.doesNotMatch(t, /Zwolle/);
  s.aid('F3');
  // Tweede keer: DROP TABLE slaagt nu, en de MONMSG hoeft niets op te vangen
  cmd(s, "CALL KLANTRPT PARM('Gouda')");
  assert.match(text(s), /Kaashandel Gouda BV/);
});

test('SEU: invoegen, regelcommando\'s en bewaren', () => {
  const s = signedOn();
  cmd(s, 'STRSEU DEMO/QCLSRC NIEUW');
  s.aid('ENTER', { 'seq.-1': 'I' });
  const typeLine = (t) => {
    const f = s.screen().fields.filter((x) => x.name.startsWith('dat.')).at(-1);
    s.aid('ENTER', { [f.name]: t });
  };
  typeLine('             PGM');
  typeLine("             SNDPGMMSG MSG('Een')");
  typeLine('             ENDPGM');
  s.aid('ENTER', {}); // lege ingevoegde regel verdwijnt
  const seu = s.top();
  assert.deepEqual(seu.lines.map((l) => l.data.trim()), ['PGM', "SNDPGMMSG MSG('Een')", 'ENDPGM']);
  // Regel 2 kopiëren na regel 2, en dan de kopie wijzigen
  s.aid('ENTER', { 'seq.1': 'C', 'seq.2': 'B' });
  assert.equal(seu.lines.length, 4);
  s.aid('ENTER', { 'dat.2': "             SNDPGMMSG MSG('Twee')" });
  // Regel 1 verwijderen en weer terugzetten kan niet; dus R(epeat) en D(elete)
  s.aid('ENTER', { 'seq.0': 'R' });
  assert.equal(seu.lines.length, 5);
  s.aid('ENTER', { 'seq.1': 'D' });
  assert.deepEqual(seu.lines.map((l) => l.data.trim()), ['PGM', "SNDPGMMSG MSG('Een')", "SNDPGMMSG MSG('Twee')", 'ENDPGM']);
  assert.deepEqual(seu.lines.map((l) => l.seq), ['0001.00', '0002.00', '0003.00', '0004.00']);
  s.aid('F3');
  assert.match(text(s), /Change\/create member/);
  s.aid('ENTER', { chg: 'Y', ret: 'N', text: 'Test' });
  assert.equal(msg(s), 'Member NIEUW in file DEMO/QCLSRC changed with 4 records.');
  cmd(s, 'CRTCLPGM NIEUW');
  cmd(s, 'CALL NIEUW');
  assert.equal(msg(s), 'Twee');
});

test('SEU: F4 prompt een CL-regel en zet hem netjes terug', () => {
  const s = signedOn();
  cmd(s, 'STRSEU DEMO/QCLSRC HALLO');
  const seu = s.top();
  const before = seu.lines.length;
  s.aid('F4', {}, 'dat.2'); // DCL VAR(&USER) ...
  assert.match(text(s), /Declare CL Variable \(DCL\)/);
  s.aid('ENTER', { VAR: '&USER', TYPE: '*CHAR', LEN: '12' });
  assert.equal(seu.lines.length, before);
  assert.equal(seu.lines[2].data, '             DCL        VAR(&USER) TYPE(*CHAR) LEN(12)');
});

test('formatCL breekt lange opdrachten af met +', () => {
  const lines = formatCL('START', "SNDPGMMSG MSG('Dit is een heel lange tekst die echt niet op een enkele regel past, dus moet hij worden afgebroken') MSGTYPE(*INFO)");
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 71));
  assert.ok(lines.slice(0, -1).every((l) => l.endsWith('+')));
  assert.match(lines[0], /^ START: {6}SNDPGMMSG {2}MSG\(/);
  const st = splitStatements(lines);
  assert.equal(st.length, 1);
  assert.match(st[0].text, /afgebroken'\) MSGTYPE\(\*INFO\)$/);
});

test('interactieve SQL', () => {
  const s = signedOn();
  cmd(s, 'STRSQL');
  s.aid('ENTER', { 'sql.0': "select naam, saldo from demo/klanten where saldo < 0" });
  assert.match(text(s), /Display Data/);
  assert.match(text(s), /Fietsenmaker Jansen\s+-310\.00/);
  s.aid('F3');
  assert.match(text(s), /Enter SQL Statements/);
  s.aid('ENTER', { 'sql.0': 'select * from demo/bestaatniet' });
  assert.equal(msg(s), 'BESTAATNIET in DEMO type *FILE not found.');
});

test('SBMJOB: batchjob met bericht als hij klaar is (MW)', () => {
  const s = signedOn();
  cmd(s, 'CRTCLPGM TELLER');
  for (const m of s.sys.state.msgq.QSECOFR) m.unread = false;
  cmd(s, 'SBMJOB CMD(CALL TELLER PARM(4)) JOB(SOM)');
  assert.match(msg(s), /^Job \d{6}\/QSECOFR\/SOM submitted to job queue QBATCH in library QGPL\.$/);
  assert.equal(s.oia().mw, true);
  cmd(s, 'DSPMSG');
  assert.match(text(s), /completed normally/);
  assert.equal(s.oia().mw, false);
});

test('beveiliging: GAST mag het systeem niet uitzetten', () => {
  const s = signedOn('GAST');
  cmd(s, 'PWRDWNSYS');
  assert.equal(msg(s), 'Not authorized to command PWRDWNSYS.');
  cmd(s, 'CRTUSRPRF ANDER');
  assert.equal(msg(s), 'Not authorized to command CRTUSRPRF.');
});

test('PWRDWNSYS RESTART(*YES) doet een IPL', () => {
  const s = signedOn();
  cmd(s, 'PWRDWNSYS OPTION(*IMMED) RESTART(*YES)');
  assert.match(text(s), /Confirm Power Down System/);
  s.aid('F16');
  assert.match(text(s), /IPL/);
  for (let i = 0; i < 30; i++) s.tick();
  assert.match(text(s), /Sign On/);
});

test('de schijf overleeft opslaan en laden als JSON', () => {
  const s = signedOn();
  cmd(s, 'CRTLIB BEWAAR');
  cmd(s, 'CRTCLPGM HALLO');
  cmd(s, "RUNSQL SQL('CREATE TABLE BEWAAR/T (A CHAR(3))') COMMIT(*NONE)");
  cmd(s, "RUNSQL SQL('INSERT INTO BEWAAR/T VALUES (''abc'')') COMMIT(*NONE)");
  const json = JSON.parse(JSON.stringify(s.sys.state));
  const s2 = signedOn('QSECOFR', json);
  cmd(s2, 'CALL HALLO');
  assert.equal(msg(s2), 'Hallo QSECOFR, vandaag is het 07-11-26');
  cmd(s2, 'STRSQL');
  s2.aid('ENTER', { 'sql.0': 'select * from bewaar/t' });
  assert.match(text(s2), /abc/);
});

test('bibliotheeklijst: ADDLIBLE, CHGCURLIB en *LIBL', () => {
  const s = signedOn();
  cmd(s, 'CRTLIB EXTRA');
  cmd(s, "RUNSQL SQL('CREATE TABLE EXTRA/X (A INT)') COMMIT(*NONE)");
  cmd(s, 'DSPPFM X');
  assert.equal(msg(s), 'File X in library *LIBL not found.');
  cmd(s, 'ADDLIBLE EXTRA');
  assert.equal(msg(s), 'Library EXTRA added to library list.');
  cmd(s, 'DSPPFM X');
  assert.match(text(s), /Display Physical File Member/);
  s.aid('F3');
  cmd(s, 'ADDLIBLE EXTRA');
  assert.equal(msg(s), 'Library EXTRA already exists in library list.');
});
