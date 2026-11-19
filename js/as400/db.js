// De "schijf" van het systeem: bibliotheken met objecten (bestanden, programma's),
// gebruikersprofielen, berichtenwachtrijen, spoolbestanden en systeemwaarden.
// Alles is gewone JSON, zodat het in localStorage bewaard kan worden.
import { CpfError } from './cl.js';

export const SYSTEM_NAME = 'SIM400';

export const objKey = (name, type) => `${name}|${type}`;

const today = () => new Date().toISOString();

function srcLines(text) {
  return text.replace(/^\n/, '').trimEnd().split('\n').map((data, i) => ({
    seq: String(i + 1).padStart(4, '0') + '.00',
    data: data.trimEnd(),
  }));
}

export function newObject(name, type, attr, text = '', extra = {}) {
  return { name, type, attr, text, created: today(), owner: extra.owner || 'QSECOFR', ...extra };
}

// Fysiek bestand met velden (zoals CREATE TABLE of DDS het maakt)
export function newDataFile(name, fields, text = '', rows = [], keys = []) {
  return newObject(name, '*FILE', 'PF', text, { fields, rows, src: false, keys });
}

export function newSourceFile(name, text = '') {
  return newObject(name, '*FILE', 'PF', text, { src: true, rcdlen: 92, members: {} });
}

export function newMember(type, text, source = '') {
  return { type, text, changed: today(), lines: source ? srcLines(source) : [] };
}

const DEMO_HALLO = `
/*  HALLO: een eerste CL-programma                                 */
             PGM
             DCL        VAR(&USER) TYPE(*CHAR) LEN(10)
             DCL        VAR(&DATUM) TYPE(*CHAR) LEN(6)
             RTVJOBA    USER(&USER)
             RTVSYSVAL  SYSVAL(QDATE) RTNVAR(&DATUM)
             SNDPGMMSG  MSG('Hallo' *BCAT &USER *TCAT ', vandaag is +
                          het' *BCAT %SST(&DATUM 1 2) *CAT '-' +
                          *CAT %SST(&DATUM 3 2) *CAT '-' *CAT +
                          %SST(&DATUM 5 2))
             ENDPGM
`;

const DEMO_RAAD = `
/*  RAAD: raad een getal tussen 1 en 100                           */
             PGM
             DCL        VAR(&GEHEIM) TYPE(*DEC) LEN(5 0)
             DCL        VAR(&GOK) TYPE(*CHAR) LEN(3)
             DCL        VAR(&GETAL) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&POGING) TYPE(*DEC) LEN(3 0) VALUE(0)
             DCL        VAR(&TEKST) TYPE(*CHAR) LEN(60)
             DCL        VAR(&TIJD) TYPE(*CHAR) LEN(6)

/*  Een "willekeurig" getal uit de seconden en minuten van de klok */
             RTVSYSVAL  SYSVAL(QTIME) RTNVAR(&TIJD)
             CHGVAR     VAR(&GEHEIM) VALUE(%SST(&TIJD 3 4))
             DOWHILE    COND(&GEHEIM *GT 100)
               CHGVAR     VAR(&GEHEIM) VALUE(&GEHEIM - 100)
             ENDDO
             IF         COND(&GEHEIM *EQ 0) THEN(CHGVAR VAR(&GEHEIM) +
                          VALUE(42))
             CHGVAR     VAR(&TEKST) VALUE('Ik denk aan een getal +
                          van 1 tot 100. Raad maar!')

 VRAAG:      SNDUSRMSG  MSG(&TEKST) MSGRPY(&GOK)
             CHGVAR     VAR(&POGING) VALUE(&POGING + 1)
             CHGVAR     VAR(&GETAL) VALUE(&GOK)
             MONMSG     MSGID(CPF0000 CPD0000 MCH0000) EXEC(DO)
               CHGVAR     VAR(&TEKST) VALUE('Dat is geen getal. +
                            Probeer het nog eens.')
               GOTO       CMDLBL(VRAAG)
             ENDDO
             SELECT
             WHEN       COND(&GETAL *LT &GEHEIM) THEN(CHGVAR +
                          VAR(&TEKST) VALUE(%TRIM(&GOK) *BCAT 'is te +
                          laag. Nog een keer?'))
             WHEN       COND(&GETAL *GT &GEHEIM) THEN(CHGVAR +
                          VAR(&TEKST) VALUE(%TRIM(&GOK) *BCAT 'is te +
                          hoog. Nog een keer?'))
             OTHERWISE  CMD(DO)
               SNDPGMMSG  MSG('Goed geraden! Het was' *BCAT +
                            %TRIM(&GOK) *TCAT '. Aantal pogingen:' +
                            *BCAT %CHAR(&POGING) *TCAT '.')
               RETURN
             ENDDO
             ENDSELECT
             GOTO       CMDLBL(VRAAG)
             ENDPGM
`;

const DEMO_TELLER = `
/*  TELLER: telt de getallen 1 tot en met &TOT bij elkaar op       */
             PGM        PARM(&TOT)
             DCL        VAR(&TOT) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&I) TYPE(*DEC) LEN(3 0)
             DCL        VAR(&SOM) TYPE(*DEC) LEN(7 0) VALUE(0)
             DOFOR      VAR(&I) FROM(1) TO(&TOT)
               CHGVAR     VAR(&SOM) VALUE(&SOM + &I)
             ENDDO
             SNDPGMMSG  MSG('De som van 1 tot en met' *BCAT +
                          %CHAR(&TOT) *BCAT 'is' *BCAT %CHAR(&SOM) +
                          *TCAT '.')
             ENDPGM
`;

const DEMO_KLANTRPT = `
/*  KLANTRPT: zet de klanten uit één plaats in een nieuwe tabel     */
/*  en toont ze. Aanroep: CALL KLANTRPT PARM('Utrecht')              */
             PGM        PARM(&PLAATS)
             DCL        VAR(&PLAATS) TYPE(*CHAR) LEN(20)
             RUNSQL     SQL('DROP TABLE QTEMP/SELECTIE') COMMIT(*NONE)
             MONMSG     MSGID(SQL0000)
             RUNSQL     SQL('CREATE TABLE QTEMP/SELECTIE AS (SELECT * +
                          FROM DEMO/KLANTEN WHERE PLAATS = ''' *TCAT +
                          &PLAATS *TCAT ''') WITH DATA') COMMIT(*NONE)
             RUNQRY     QRY(*NONE) QRYFILE((QTEMP/SELECTIE))
             ENDPGM
`;

const DEMO_LEESMIJ = `
Welkom op SIM400, een nagebootste AS/400.

Probeer bijvoorbeeld:
  WRKACTJOB                  actieve jobs bekijken
  WRKMBRPDM DEMO/QCLSRC      broncode bewerken (optie 2) en compileren (14)
  CALL HALLO                 een CL-programma starten (eerst compileren)
  WRKMBRPDM DEMO/QRPGLESRC   RPG-programma's (free-form RPG IV)
  STRSQL                     interactieve SQL
  RUNQRY *NONE DEMO/KLANTEN  een bestand bekijken
  WRKSPLF                    afdrukken bekijken
`;

export function factoryState() {
  const libs = {};
  const lib = (name, text, type = '*PROD') => (libs[name] = { name, text, type, created: today(), objs: {} });
  const put = (l, o) => { libs[l].objs[objKey(o.name, o.type)] = o; return o; };

  lib('QGPL', 'General Purpose Library');
  lib('QUSRSYS', 'System Library for Users');
  lib('DEMO', 'Demonstratiebibliotheek', '*TEST');

  put('QGPL', newSourceFile('QCLSRC', 'Source for CL programs'));
  put('QGPL', newSourceFile('QDDSSRC', 'Source for DDS'));

  const klanten = newDataFile('KLANTEN', [
    { name: 'KLNR', type: 'DECIMAL', len: 5, scale: 0, heading: 'Klantnummer' },
    { name: 'NAAM', type: 'CHAR', len: 25, heading: 'Naam' },
    { name: 'PLAATS', type: 'CHAR', len: 20, heading: 'Plaats' },
    { name: 'SALDO', type: 'DECIMAL', len: 9, scale: 2, heading: 'Saldo' },
  ], 'Klanten', [
    [10010, 'Bakkerij De Korenaar', 'Utrecht', 1250.5],
    [10020, 'Fietsenmaker Jansen', 'Zwolle', -310.0],
    [10030, 'Hotel Zeezicht', 'Scheveningen', 18450.75],
    [10040, 'Boekhandel Het Woord', 'Utrecht', 0],
    [10050, 'Garage Van Dijk', 'Eindhoven', 7320.2],
    [10060, 'Kaashandel Gouda BV', 'Gouda', 2999.99],
    [10070, 'Drukkerij Pers & Co', 'Haarlem', 512.4],
    [10080, 'Tuincentrum De Linde', 'Utrecht', 64.0],
  ], ['KLNR']);
  put('DEMO', klanten);

  put('DEMO', newDataFile('ARTIKELEN', [
    { name: 'ARTNR', type: 'CHAR', len: 6, heading: 'Artikel' },
    { name: 'OMSCHR', type: 'CHAR', len: 30, heading: 'Omschrijving' },
    { name: 'PRIJS', type: 'DECIMAL', len: 7, scale: 2, heading: 'Prijs' },
    { name: 'VOORRAAD', type: 'DECIMAL', len: 5, scale: 0, heading: 'Voorraad' },
  ], 'Artikelen', [
    ['A100', 'Lintcassette printer', 12.5, 40],
    ['A200', 'Kettingpapier 2000 vel', 34.95, 12],
    ['A300', 'Diskette 8 inch', 9.75, 150],
    ['A400', 'Twinax-kabel 10 m', 45.0, 6],
    ['A500', 'Terminal 5251', 2495.0, 1],
  ], ['ARTNR']));

  put('DEMO', newDataFile('ORDERS', [
    { name: 'ORDNR', type: 'DECIMAL', len: 7, scale: 0, heading: 'Order' },
    { name: 'KLNR', type: 'DECIMAL', len: 5, scale: 0, heading: 'Klant' },
    { name: 'ARTNR', type: 'CHAR', len: 6, heading: 'Artikel' },
    { name: 'AANTAL', type: 'DECIMAL', len: 5, scale: 0, heading: 'Aantal' },
    { name: 'DATUM', type: 'DATE', len: 10, heading: 'Datum' },
  ], 'Orders', [
    [1000001, 10010, 'A100', 2, '1994-03-14'],
    [1000002, 10030, 'A500', 1, '1994-03-15'],
    [1000003, 10030, 'A400', 3, '1994-03-15'],
    [1000004, 10050, 'A200', 5, '1994-04-02'],
    [1000005, 10010, 'A300', 20, '1994-04-11'],
    [1000006, 10060, 'A100', 1, '1994-05-01'],
  ], ['ORDNR']));

  const src = put('DEMO', newSourceFile('QCLSRC', 'Broncode van CL-programma\'s'));
  src.members.HALLO = newMember('CLP', 'Hallo, wereld', DEMO_HALLO);
  src.members.RAAD = newMember('CLP', 'Raad het getal', DEMO_RAAD);
  src.members.TELLER = newMember('CLP', 'Optellen met DOFOR', DEMO_TELLER);
  src.members.KLANTRPT = newMember('CLLE', 'Klanten per plaats (SQL)', DEMO_KLANTRPT);

  const txt = put('DEMO', newSourceFile('QTXTSRC', 'Tekstbestanden'));
  txt.members.LEESMIJ = newMember('TXT', 'Lees mij eerst', DEMO_LEESMIJ);

  addRpgDemo(libs.DEMO);

  return {
    version: 1,
    libs,
    users: {
      QSECOFR: { pwd: 'QSECOFR', cls: '*SECOFR', text: 'Security Officer', inlmnu: 'MAIN', inlpgm: '*NONE', curlib: 'DEMO' },
      GAST: { pwd: 'GAST', cls: '*USER', text: 'Gastgebruiker', inlmnu: 'MAIN', inlpgm: '*NONE', curlib: 'DEMO' },
    },
    msgq: {
      QSECOFR: [{ text: 'Welkom op SIM400. Typ GO MAIN voor het hoofdmenu of WRKACTJOB voor de actieve jobs.', from: 'QSYS', time: today() }],
      GAST: [],
    },
    spool: [],
    sysval: {
      QSRLNBR: '10A4F2B',
      QMODEL: '170',
      QSECURITY: '40',
      QDATFMT: 'DMY',
      QDATSEP: '-',
      QTIMSEP: ':',
      QCCSID: '65535',
      QLANGID: 'NLD',
      QCNTRYID: 'NL',
      QSYSLIBL: 'QSYS QSYS2 QHLPSYS QUSRSYS',
      QUSRLIBL: 'QGPL QTEMP',
      QMAXSIGN: '3',
      QPWDLVL: '0',
      QSTRUPPGM: 'QSTRUP QSYS',
      QIPLDATTIM: '*NONE',
    },
    rpgDemo: true,
    nextJob: 123456,
    nextSpl: 1,
  };
}

// ---------- RPG-voorbeelden (free-form RPG IV) ----------

const RPG_HALLO = `
**free
// HALLORPG: een eerste programma in free-form RPG IV.
// Aanroep: CALL HALLORPG of CALL HALLORPG PARM('Kim')
dcl-pi *n;
  naam char(20);
end-pi;

if %parms() = 0 or naam = *blanks;
  naam = 'wereld';
endif;
dsply ('Hallo, ' + %trim(naam) + '!');
*inlr = *on;
`;

const RPG_KLANTLST = `
**free
// KLANTLST: klantenlijst naar de spool (QSYSPRT) met totaalsaldo
dcl-f KLANTEN keyed;
dcl-f QSYSPRT printer(80);

dcl-s regel char(80);
dcl-s totaal packed(11:2) inz(0);
dcl-s aantal int(10) inz(0);

regel = 'Klantenlijst van ' + %char(%date());
write QSYSPRT regel;
regel = 'Klant  Naam                     Plaats              ' +
        '        Saldo';
write QSYSPRT regel;

setll *start KLANTEN;
read KLANTEN;
dow not %eof(KLANTEN);
  regel = %editc(KLNR : 'X') + '  ' + NAAM + PLAATS
        + %editc(SALDO : 'J');
  write QSYSPRT regel;
  totaal += SALDO;
  aantal += 1;
  read KLANTEN;
enddo;

regel = 'Totaal';
%subst(regel : 51 : 15) = %editc(totaal : 'J');
write QSYSPRT regel;

dsply (%char(aantal) + ' klanten, totaal saldo '
      + %char(totaal) + '. Zie WRKSPLF.');
*inlr = *on;
`;

const RPG_VOORRAAD = `
**free
// VOORRAAD: voorraad van een artikel ophogen (CHAIN en UPDATE)
dcl-f ARTIKELEN keyed usage(*update);

dcl-s antw char(10);
dcl-s erbij packed(5:0);

dow *on;
  dsply 'Artikelnummer (A100 t/m A500, leeg = stoppen)?' '' antw;
  if antw = *blanks;
    leave;
  endif;

  chain (%upper(%trim(antw))) ARTIKELEN;
  if not %found(ARTIKELEN);
    dsply ('Artikel ' + %trim(antw) + ' bestaat niet.');
    iter;
  endif;

  dsply (%trim(OMSCHR) + ': voorraad ' + %char(VOORRAAD)
        + '. Hoeveel erbij?') '' antw;
  monitor;
    erbij = %dec(antw : 5 : 0);
  on-error;
    dsply 'Dat is geen getal.';
    iter;
  endmon;

  VOORRAAD += erbij;
  update ARTIKELEN;
  dsply ('Nieuwe voorraad van ' + %trim(ARTNR) + ': '
        + %char(VOORRAAD));
enddo;
*inlr = *on;
`;

const RPG_ORDERTOT = `
**free
// ORDERTOT: orderregels met bedrag, berekend in een procedure
dcl-f ORDERS keyed;
dcl-f ARTIKELEN keyed;
dcl-f KLANTEN keyed;

dcl-s totaal packed(11:2) inz(0);
dcl-s bedrag packed(9:2);

read ORDERS;
dow not %eof(ORDERS);
  bedrag = regelBedrag(ARTNR : AANTAL);
  chain KLNR KLANTEN;
  dsply (%char(ORDNR) + ' ' + %trim(NAAM) + ': ' + %char(bedrag));
  totaal += bedrag;
  read ORDERS;
enddo;
dsply ('Totaal van alle orders: ' + %char(totaal));
*inlr = *on;

dcl-proc regelBedrag;
  dcl-pi *n packed(9:2);
    artikel char(6) const;
    stuks packed(5:0) const;
  end-pi;

  chain artikel ARTIKELEN;
  if not %found(ARTIKELEN);
    return 0;
  endif;
  return PRIJS * stuks;
end-proc;
`;

export function addRpgDemo(lib) {
  const k = objKey('QRPGLESRC', '*FILE');
  if (lib.objs[k]) return;
  const f = newSourceFile('QRPGLESRC', 'Broncode van RPG-programma\'s');
  f.rcdlen = 112;
  f.members.HALLORPG = newMember('RPGLE', 'Hallo in RPG', RPG_HALLO);
  f.members.KLANTLST = newMember('RPGLE', 'Klantenlijst naar de spool', RPG_KLANTLST);
  f.members.VOORRAAD = newMember('RPGLE', 'Voorraad ophogen (CHAIN/UPDATE)', RPG_VOORRAAD);
  f.members.ORDERTOT = newMember('RPGLE', 'Orderbedragen met een procedure', RPG_ORDERTOT);
  lib.objs[k] = f;
}

// Schijven uit een eerdere versie aanvullen (sleutels, RPG-voorbeelden)
export function upgradeState(st) {
  const demo = st.libs?.DEMO;
  if (demo) {
    const keys = { KLANTEN: ['KLNR'], ARTIKELEN: ['ARTNR'], ORDERS: ['ORDNR'] };
    for (const [n, k] of Object.entries(keys)) {
      const o = demo.objs[objKey(n, '*FILE')];
      if (o && !o.keys && o.fields?.some((f) => f.name === k[0])) o.keys = k;
    }
    if (!st.rpgDemo) addRpgDemo(demo);
  }
  st.rpgDemo = true;
  return st;
}

export const SYSVAL_TEXT = {
  QDATE: 'System date',
  QTIME: 'Time of day',
  QSRLNBR: 'System serial number',
  QMODEL: 'System model number',
  QSECURITY: 'System security level',
  QDATFMT: 'Date format',
  QDATSEP: 'Date separator',
  QTIMSEP: 'Time separator',
  QCCSID: 'Coded character set identifier',
  QLANGID: 'Language identifier',
  QCNTRYID: 'Country or region identifier',
  QSYSLIBL: 'System part of the library list',
  QUSRLIBL: 'User part of the library list',
  QMAXSIGN: 'Maximum sign-on attempts allowed',
  QPWDLVL: 'Password level',
  QSTRUPPGM: 'Startup program',
  QIPLDATTIM: 'Date and time to automatically IPL',
};

// Systeembibliotheken die niet op de schijf staan maar door het systeem zelf
// worden ingevuld (commando's, systeemprogramma's)
export const VIRTUAL_LIBS = {
  QSYS: 'System Library',
  QSYS2: 'System Library for CPI\'s',
  QHLPSYS: 'Help library',
};

export function validName(n) {
  return /^[A-Z@#$][A-Z0-9@#$_.]{0,9}$/.test(n);
}

export function checkName(n, what = 'Name') {
  if (!validName(n)) throw new CpfError('CPD0078', `${what} '${n}' not valid.`);
  return n;
}
