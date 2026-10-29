# KIM-1 emulator

Een emulator van de **MOS KIM-1** (1976), de eenbordscomputer waarmee MOS Technology
de 6502-processor introduceerde. Alles draait in de browser: geen installatie, geen
build-stap, geen afhankelijkheden.

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

## Snel proberen

1. Druk **AD**, tik `0200`, druk **DA** en tik `A9` **+** `42` **+** `00`.
2. Druk **AD** `0200` **GO**: het programma laadt `$42` in A en stopt bij de BRK.
3. Kijk op adres `$00F3` (A): daar staat `42`.

Of kies in de assembler een voorbeeld en klik **Laden & starten**.

Toetsenbord: `0–9 A–F` cijfers, `Q` = AD, `W` = DA, spatie/`+` = +, `G`/Enter = GO,
`P` = PC, `Esc`/`S` = ST, `R` = RS, `T` = SST aan/uit.

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
| `js/kim1.js` | KIM-1: geheugen, 6530's, display, keypad, monitor |
| `js/assembler.js`, `js/disasm.js` | assembler en disassembler |
| `js/fileformats.js` | papertape en Intel HEX |
| `js/samples.js` | voorbeeldprogramma's |
| `js/main.js` | gebruikersinterface |
