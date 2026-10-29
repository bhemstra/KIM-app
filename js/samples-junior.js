// Voorbeeldprogramma's voor de Junior Computer (zelf geschreven).

export const SAMPLES_JUNIOR = [
  {
    name: 'Optellen (BRK terug naar monitor)',
    description: 'Telt de bytes op $0010 en $0011 op en zet het resultaat in $0012. '
      + 'Vul eerst $0010 en $0011 in via AD/DA, start met 0200 GO. '
      + 'BRK springt via de IRQ-vector ($1A7E) terug naar de monitor.',
    source: `; Optellen: $0012 = $0010 + $0011
        .ORG $0200
START   CLD             ; binair rekenen
        CLC
        LDA $10
        ADC $11
        STA $12
        BRK             ; via $1A7E/$1A7F naar SAVE ($1C00)
`,
  },
  {
    name: 'Teller (SCANDS)',
    description: 'Een decimale teller op het display, via de monitorroutine SCANDS. '
      + 'Stop met ST, ga verder met PC en GO.',
    source: `; Decimale teller met de monitorroutine SCANDS
SCANDS  = $1D8E         ; toont POINTH POINTL INH (aantal bytes in BYTES)
INH     = $F9
POINTL  = $FA
POINTH  = $FB
BYTES   = $F6
CNT     = $00

        .ORG $0200
START   LDA #3
        STA BYTES       ; alle drie de bytes tonen
        LDA #0
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
      + 'telt het aantal toetsaanslagen (midden).',
    source: `; Toont de code van elke toets en telt de aanslagen
SCANDS  = $1D8E
GETKEY  = $1DF9         ; A = toetscode, of $15 als er niets is ingedrukt
INH     = $F9
POINTL  = $FA
POINTH  = $FB
BYTES   = $F6

        .ORG $0200
START   LDA #3
        STA BYTES
        LDA #0
        STA INH
        STA POINTL
        STA POINTH
LOOP    JSR SCANDS      ; laat poort A als ingang achter, klaar voor GETKEY
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
    description: 'Stuurt het display rechtstreeks aan via de 6532 (PAD/PBD). '
      + 'Let op: bij de Junior zijn de segmenten actief laag.',
    source: `; Lichtkrant: multiplext het display zelf via de 6532
PAD     = $1A80         ; poort A: segmenten, actief laag (0 = aan)
PADD    = $1A81
PBD     = $1A82         ; poort B: PB1-PB4 kiezen het cijfer (via de 74145)
PBDD    = $1A83
OFFS    = $00
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
        LDY #$08        ; PBD-waarde voor het meest linkse cijfer
DIGIT   LDA #$FF
        STA PAD         ; donker tijdens het wisselen
        STY PBD
        LDX PTR
        LDA MSG,X
        EOR #$FF        ; actief hoog -> actief laag
        STA PAD
        LDA #80         ; even laten branden
        STA DLY
WAITD   DEC DLY
        BNE WAITD
        INC PTR
        INY
        INY
        CPY #$14        ; na zes cijfers klaar
        BNE DIGIT
        LDA #$FF
        STA PAD
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
    name: 'Knipperen met de timer (6532)',
    description: 'Gebruikt de interval-timer van de 6532 (deler 1024) om elke halve '
      + 'seconde een teller op het display op te hogen.',
    source: `; Timer van de 6532: ongeveer elke 0,5 s de teller ophogen
SCANDS  = $1D8E
CLK1024 = $1AF7         ; timer schrijven, deler 1024, geen IRQ
RDFLAG  = $1AD5         ; bit 7 = timer verlopen
INH     = $F9
POINTL  = $FA
POINTH  = $FB
BYTES   = $F6
TICKS   = $00

        .ORG $0200
START   LDA #1
        STA BYTES       ; alleen POINTH tonen
        LDA #0
        STA POINTH
NEXT    LDA #2          ; 2 x 250 x 1024 us = ongeveer 0,5 s
        STA TICKS
ARM     LDA #250
        STA CLK1024
WAIT    JSR SCANDS
        BIT RDFLAG
        BPL WAIT        ; timer nog niet verlopen
        DEC TICKS
        BNE ARM
        SED
        CLC
        LDA POINTH
        ADC #1
        STA POINTH
        CLD
        JMP NEXT
`,
  },
];
