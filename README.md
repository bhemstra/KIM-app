# KIM-1, Junior Computer en AS/400

Drie oude computers die in de browser draaien zonder installatie, build-stap of
afhankelijkheden:

- **MOS KIM-1** (1976), de computer waarmee MOS Technology de 6502 introduceerde
  (`index.html`);
- **Elektor/Elektuur Junior Computer** (1980), het bouwproject dat sterk op de
  KIM-1 lijkt (`junior.html`);
- **IBM AS/400** (1988), als simulatie van het systeem achter een 5250-terminal
  (`as400.html`, zie [hieronder](#as400-simulatie)).

![KIM-1: zes LED-cijfers, een hexadecimaal keypad en de SST-schakelaar](docs/screenshot.png)

## Starten

De app gebruikt ES-modules, dus open hem via een (willekeurige) lokale webserver:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Wat zit erin

- **6502-CPU**: alle gedocumenteerde instructies, cyclustelling, NMOS-gedrag
  (decimale modus, `JMP ($xxFF)`-bug). Slaagt voor Klaus Dormann's 6502 functional test.
- **KIM-1-hardware**: 1K RAM, twee 6530 RRIOT's (poorten + timers), RAM op
  `$1780–$17FF`, 8K-adresspiegeling en optioneel uitbreidingsgeheugen.
- **LED-display** dat echt gemultiplext wordt via poort A/B van de 6530-002.
  Programma's die de segmenten zelf aansturen werken dus gewoon.
- **Keypad** (muis, touch of toetsenbord), **ST**, **RS** en de **SST**-schakelaar
  (single step).
- **Monitor**: een eigen nabootsing van de KIM-monitor (AD/DA/+/PC/GO, registers
  bewaren op `$EF–$F5`) en van de veelgebruikte ROM-routines zoals `SCANDS`,
  `GETKEY`, `AK`, `INCPT`, `OUTCH`, `GETCH`, `PRTBYT`, `CRLF` en de tabel `TABLE`.
  Wie een dump van de originele ROM heeft (2 KB, `$1800–$1FFF`) kan die laden onder
  *Instellingen*; dan draait de echte ROM-code.
- **Assembler** met labels, expressies en directives (`.ORG`, `.BYTE`, `.WORD`,
  `.TEXT`), plus voorbeeldprogramma's: teller, toetsen tonen, lichtkrant,
  "raad het getal" en een teletype-demo.
- **Debugger**: registers, disassembly, geheugen, pauze/stap en een breekpunt.
- **Terminal** voor de teletype-routines.
- **Bestanden & cassette**: laden/opslaan als KIM-papertape (`.ptp`), Intel HEX of
  binair; `DUMPT`/`LOADT` (`1800 GO` / `1873 GO`) schrijven naar een virtuele cassette.

## Junior Computer

- **Hardware**: 1K RAM, een 6532 RIOT (128 bytes RAM op `$1A00`, I/O en timer op
  `$1A80`, IRQ naar de 6502), 1K monitor-EPROM op `$1C00–$1FFF`, display met
  actief-lage segmenten, keypad en STEP-schakelaar.
- **Monitor**: nagebootst volgens de gepubliceerde listing van A. Nachtmann:
  keypadmonitor, hex-editor (`1CB5 GO`), assembler (`1F51 GO`), sprongberekening
  (`1FD5 GO`) en subroutines als `SCAND`, `SCANDS`, `AK`, `GETKEY`, `GETBYT` en
  `SHOW`. Met een eigen dump van de EPROM (1 KB) draait de echte monitorcode.
- De tests vergelijken de nagebootste monitor met de originele ROM-code
  (`JUNIOR_ROM=/pad/naar/monitor.bin npm test`): monitor, editor, assembler,
  sprongberekening en `SCANDS` gedragen zich identiek.

De Junior bestaat ook als desktop-app voor Windows en macOS: zie
[`desktop/README.md`](desktop/README.md).

## Snel proberen

1. Druk **AD**, tik `0200`, druk **DA** en tik `A9` **+** `42` **+** `00`.
2. Druk **AD** `0200` **GO**: het programma laadt `$42` in A en stopt bij de BRK.
3. Kijk op adres `$00F3` (A): daar staat `42`.

Of kies in de assembler een voorbeeld en klik **Laden & starten**.

Toetsenbord: `0–9 A–F` cijfers, `Q` = AD, `W` = DA, spatie/`+` = +, `G`/Enter = GO,
`P` = PC, `Esc`/`S` = ST, `R` = RS, `T` = SST aan/uit.

## AS/400-simulatie

De AS/400 is geen emulator van de hardware maar een nabootsing van hoe het
systeem werkt en aanvoelt: OS/400 is van IBM en niet vrij te gebruiken, dus er zit
geen IBM-code in. Meld je aan als `QSECOFR`/`QSECOFR` of `GAST`/`GAST`.

- **5250-scherm** van 24×80 met invoervelden, kleuren, functietoetsen F1–F24,
  Roll Up/Down, een statusregel (met `MW` als er een bericht is) en knoppen voor
  telefoons. Teksten als `F3=Exit` zijn aanklikbaar.
- **Menu's** (MAIN, USER, SYSTEM, DATA, PROGRAM, PDM) en **Command Entry**
  (`CALL QCMD`).
- **58 systeemopdrachten** met de **prompter** (F4) en controle van parameters,
  onder meer `WRKACTJOB`, `WRKSYSSTS`, `WRKJOB`, `DSPJOBLOG`, `WRKSPLF`,
  `SNDMSG`/`DSPMSG`, `CRTLIB`/`DLTLIB`, `ADDLIBLE`, `WRKOBJ`, `DSPOBJD`,
  `CRTPF`, `CRTSRCPF`, `DSPPFM`, `DSPFD`, `DSPFFD`, `CPYF`, `RUNQRY`,
  `CRTUSRPRF`, `WRKSYSVAL`/`CHGSYSVAL`, `SBMJOB` en `PWRDWNSYS` (met IPL).
  `WRKCMD` toont ze allemaal.
- **PDM en SEU**: `WRKLIBPDM`, `WRKOBJPDM`, `WRKMBRPDM` met opties (2 = bewerken,
  14 = compileren, 16 = starten …) en een editor met regelcommando's (`I`, `D`,
  `C`/`M` + `A`/`B`, `R`, `DD`, `CC`, `MM`, `RR`) en F4 om een CL-regel te prompten.
- **CL-programma's**: `CRTCLPGM`/`CRTBNDCL` met een compileerlijst in de spool;
  `DCL`, `CHGVAR`, `IF`/`ELSE`, `DO`, `DOWHILE`, `DOUNTIL`, `DOFOR`, `LEAVE`,
  `ITERATE`, `SELECT`/`WHEN`/`OTHERWISE`, `GOTO`, `MONMSG` (ook `EXEC(DO)` en
  programmabreed), `SNDPGMMSG`, `SNDUSRMSG` (wacht op een antwoord), `RTVJOBA`,
  `RTVSYSVAL`, `CALL` met parameters en ingebouwde functies als `%SST` en `%TRIM`.
- **SQL**: `STRSQL` en `RUNSQL` met SELECT (joins, GROUP BY/HAVING, subquery's,
  CASE, ORDER BY, FETCH FIRST), INSERT, UPDATE, DELETE, CREATE TABLE (ook
  `AS (SELECT …) WITH DATA`), DROP en CREATE SCHEMA, met DB2-achtige meldingen.
- **Demobibliotheek** `DEMO` met tabellen (`KLANTEN`, `ARTIKELEN`, `ORDERS`) en
  CL-voorbeelden: `HALLO`, `RAAD` (raad het getal), `TELLER` en `KLANTRPT` (SQL
  vanuit CL).
- De **schijf** (bibliotheken, broncode, programma's, gebruikers, berichten,
  spool) wordt in `localStorage` bewaard en kan geëxporteerd en geïmporteerd worden.

## Tests

```sh
npm test
# met de 6502 functional test (niet meegeleverd):
KLAUS_BIN=/pad/naar/6502_functional_test.bin npm test
```

## Opbouw

| Bestand | Inhoud |
| --- | --- |
| `js/cpu6502.js` | 6502-kern |
| `js/opcodes.js` | opcodetabel (gedeeld) |
| `js/board.js` | gemeenschappelijke basis: display, keypad, SST, uitvoering |
| `js/riot.js` | 6530 en 6532 RIOT |
| `js/kim1.js` | KIM-1: geheugen, 6530's, monitor |
| `js/junior.js` | Junior Computer: geheugen, 6532, monitor, editor, assembler |
| `js/app.js` | gebruikersinterface (gedeeld); `main.js` en `junior-main.js` starten hem |
| `js/assembler.js`, `js/disasm.js` | assembler en disassembler |
| `js/fileformats.js` | papertape en Intel HEX |
| `js/samples.js`, `js/samples-junior.js` | voorbeeldprogramma's |
| `js/as400/screen.js` | AS/400: het 5250-schermmodel (24×80, velden, kleuren) |
| `js/as400/cl.js`, `js/as400/clpgm.js` | CL ontleden, expressies, compiler en interpreter |
| `js/as400/sql.js` | SQL-engine |
| `js/as400/db.js`, `js/as400/system.js` | schijfinhoud, demogegevens, bibliotheeklijst, jobs, spool |
| `js/as400/commands.js` | de CL-opdrachten en hun parameters |
| `js/as400/panels.js`, `js/as400/work.js`, `js/as400/seu.js` | schermen: menu's, prompter, WRK-lijsten, SQL, SEU |
| `js/as400/session.js` | sessie: schermstapel, toetsen, programma's |
| `js/as400-main.js` | tekent het scherm in de browser (startpunt van `as400.html`) |
