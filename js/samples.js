// Voorbeeldprogramma's (zelf geschreven) voor de ingebouwde assembler.

export const SAMPLES = [
  {
    name: 'Optellen (BRK terug naar monitor)',
    description: 'Telt de bytes op $0010 en $0011 op en zet het resultaat in $0012. '
      + 'Vul eerst $0010 en $0011 in via AD/DA, start met 0200 GO. '
      + 'BRK springt terug naar de monitor; kijk daarna op $0012.',
    source: `; Optellen: $0012 = $0010 + $0011
        .ORG $0200
START   CLD             ; binair rekenen
        CLC
        LDA $10
        ADC $11
        STA $12
        BRK             ; via $17FE/$17FF terug naar de monitor
`,
  },
  {
    name: 'Teller (SCANDS)',
    description: 'Een decimale teller op het display, via de ROM-routine SCANDS. '
      + 'Stop met ST, ga verder met PC en GO.',
    source: `; Decimale teller met de monitorroutine SCANDS
SCANDS  = $1F1F         ; toont POINTH POINTL INH
INH     = $F9
POINTL  = $FA
POINTH  = $FB
CNT     = $00

        .ORG $0200
START   LDA #0
        STA INH
        STA POINTL
        STA POINTH
LOOP    LDA #16         ; zo vaak het display verversen per stap
        STA CNT
SHOW    JSR SCANDS
        DEC CNT
        BNE SHOW
        SED             ; decimale modus: 0099 + 1 = 0100
        CLC
        LDA INH
        ADC #1
        STA INH
        LDA POINTL
        ADC #0
        STA POINTL
        LDA POINTH
        ADC #0
        STA POINTH
        CLD
        JMP LOOP
`,
  },
  {
    name: 'Toetsen tonen (GETKEY)',
    description: 'Laat de code van de laatst ingedrukte toets zien (rechts) en '
      + 'telt het aantal toetsaanslagen (midden). Probeer ook AD, DA, + , GO en PC.',
    source: `; Toont de code van elke toets en telt de aanslagen
SCANDS  = $1F1F
GETKEY  = $1F6A         ; A = toetscode, of $15 als er niets is ingedrukt
INH     = $F9
POINTL  = $FA
POINTH  = $FB

        .ORG $0200
START   LDA #0
        STA INH
        STA POINTL
        STA POINTH
LOOP    JSR SCANDS
        JSR GETKEY
        CMP #$15
        BEQ LOOP        ; geen toets
        STA INH
        SED
        CLC
        LDA POINTL
        ADC #1
        STA POINTL
        CLD
WAIT    JSR SCANDS      ; wachten tot de toets los is
        JSR GETKEY
        CMP #$15
        BNE WAIT
        JMP LOOP
`,
  },
  {
    name: 'Lichtkrant (segmenten direct aansturen)',
    description: 'Stuurt het display rechtstreeks aan via de 6530-poorten '
      + '(SAD/SBD), zonder ROM-routines. Laat "HALLO 6502" voorbij schuiven.',
    source: `; Lichtkrant: multiplext het display zelf via de 6530-002
SAD     = $1740         ; poort A: segmenten (bit0=a ... bit6=g)
PADD    = $1741
SBD     = $1742         ; poort B: PB1-PB4 kiezen het cijfer (via de 74145)
PBDD    = $1743
OFFS    = $00           ; begin van het zichtbare stuk tekst
CNT     = $01
PTR     = $02
DLY     = $03
LEN     = 11            ; lengte van de tekst (zonder de herhaling)

        .ORG $0200
START   LDA #$7F
        STA PADD        ; PA0-PA6 als uitgang
        LDA #$1E
        STA PBDD        ; PB1-PB4 als uitgang
        LDA #0
        STA OFFS
NEXT    LDA #40         ; zo vaak verversen voordat de tekst schuift
        STA CNT
REFR    LDA OFFS
        STA PTR
        LDY #$08        ; SBD-waarde voor het meest linkse cijfer
DIGIT   LDA #0
        STA SAD         ; donker tijdens het wisselen
        STY SBD
        LDX PTR
        LDA MSG,X
        STA SAD
        LDA #80         ; even laten branden
        STA DLY
WAITD   DEC DLY
        BNE WAITD
        INC PTR
        INY
        INY
        CPY #$14        ; na zes cijfers klaar
        BNE DIGIT
        LDA #0
        STA SAD
        DEC CNT
        BNE REFR
        INC OFFS
        LDA OFFS
        CMP #LEN
        BNE NEXT
        LDA #0
        STA OFFS
        JMP NEXT

; H     A     L     L     O     _     6     5     0     2     _   + herhaling
MSG     .BYTE $76, $77, $38, $38, $3F, $00, $7D, $6D, $3F, $5B, $00
        .BYTE $76, $77, $38, $38, $3F, $00
`,
  },
  {
    name: 'Raad het getal (spel)',
    description: 'De KIM kiest een getal van 00 tot 99. Druk een toets om te '
      + 'beginnen en typ dan steeds twee cijfers. Het display zegt HI (te hoog), '
      + 'LO (te laag) of JA, met rechts het aantal pogingen.',
    source: `; Raad het getal: eigen displayroutine + GETKEY
SAD     = $1740
PADD    = $1741
SBD     = $1742
PBDD    = $1743
GETKEY  = $1F6A
TABLE   = $1FE7         ; segmenttabel 0-F in de ROM

DISP    = $E0           ; 6 bytes: segmenten per cijfer
SECRET  = $E6
GUESS   = $E7
TRIES   = $E8
NDIG    = $E9
TMP     = $EA
RND     = $EB
DLY     = $EC

        .ORG $0200
START   LDA #$1E
        STA PBDD
NEWGAME LDA #0
        STA TRIES
        LDX #5
CLR     LDA #$40        ; streepje
        STA DISP,X
        DEX
        BPL CLR
WAIT1   JSR SHOW        ; wachten op een toets; ondertussen loopt RND
        JSR RNDSTEP
        JSR GETKEY
        CMP #$15
        BEQ WAIT1
        LDA RND
        STA SECRET
        JSR RELEASE

GUESSLP LDA #0
        STA GUESS
        STA NDIG
        STA DISP
        STA DISP+1
READ    JSR SHOW
        JSR GETKEY
        CMP #10
        BCS READ        ; alleen 0-9 (en $15 = geen toets)
        STA TMP
        LDA GUESS       ; GUESS = GUESS * 16 + cijfer (BCD)
        ASL A
        ASL A
        ASL A
        ASL A
        ORA TMP
        STA GUESS
        LDX TMP
        LDA TABLE,X
        AND #$7F
        LDX NDIG
        STA DISP,X
        INC NDIG
        JSR RELEASE
        LDA NDIG
        CMP #2
        BNE READ

        SED             ; pogingen tellen (decimaal)
        CLC
        LDA TRIES
        ADC #1
        STA TRIES
        CLD
        AND #$0F
        TAX
        LDA TABLE,X
        AND #$7F
        STA DISP+5
        LDA GUESS
        CMP SECRET
        BEQ FOUND
        BCC LOW
        LDA #$76        ; H
        STA DISP+3
        LDA #$06        ; I
        STA DISP+4
        JMP GUESSLP
LOW     LDA #$38        ; L
        STA DISP+3
        LDA #$3F        ; O
        STA DISP+4
        JMP GUESSLP
FOUND   LDA #$1E        ; J
        STA DISP+3
        LDA #$77        ; A
        STA DISP+4
WAITNEW JSR SHOW
        JSR GETKEY
        CMP #$15
        BEQ WAITNEW
        JSR RELEASE
        JMP NEWGAME

; Volgende willekeurige BCD-waarde 00-99
RNDSTEP SED
        CLC
        LDA RND
        ADC #1
        STA RND
        CLD
        RTS

; Wachten tot alle toetsen los zijn
RELEASE JSR SHOW
        JSR GETKEY
        CMP #$15
        BNE RELEASE
        RTS

; Zet DISP één keer op het display (alle zes cijfers)
SHOW    LDA #$7F
        STA PADD
        LDY #0
        LDX #$08
SHOW1   LDA #0
        STA SAD
        STX SBD
        LDA DISP,Y
        STA SAD
        LDA #80
        STA DLY
SHOW2   DEC DLY
        BNE SHOW2
        INX
        INX
        INY
        CPY #6
        BNE SHOW1
        LDA #0
        STA SAD
        STA PADD        ; poort A weer als ingang voor het keypad
        RTS
`,
  },
  {
    name: 'Teletype: hallo (OUTCH/GETCH)',
    description: 'Schrijft een tekst naar de terminal en echoot daarna alles wat '
      + 'je typt. Klik in de terminal om te typen.',
    source: `; Tekst naar de teletype-terminal
OUTCH   = $1EA0
CRLF    = $1E2F
GETCH   = $1E5A         ; wacht op een teken (en echoot het)
IDX     = $00

        .ORG $0200
START   JSR CRLF
        LDA #0
        STA IDX
PRINT   LDX IDX
        LDA TEXT,X
        BEQ ECHO
        JSR OUTCH
        INC IDX
        JMP PRINT
ECHO    JSR GETCH
        CMP #$0D        ; Enter: nieuwe regel
        BNE ECHO
        JSR CRLF
        JMP ECHO

TEXT    .TEXT "HALLO, HIER IS DE KIM-1! TYP MAAR IETS..."
        .BYTE $0D, $0A, 0
`,
  },
];
