// Voorbeeldprogramma's voor de PDP-11 (MACRO-11-notatie, getallen octaal)
import { charToHollerith } from './pdp11-cards.js';

// Vertaaltabel Hollerith -> ASCII voor het kaartlezerprogramma
const TABLE_CHARS = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.,:;+-*/=()<>$@#%&!?\'"[]\\^_';
const cardTable = [...TABLE_CHARS].map((ch) => {
  const h = charToHollerith(ch).toString(8).padStart(6, '0');
  const a = ch.charCodeAt(0).toString(8).padStart(3, '0');
  return `\t.WORD\t${h},${a}\t; ${ch === ' ' ? 'spatie' : ch}`;
}).join('\n');

export const SAMPLES_PDP11 = [
  {
    name: 'Hallo, wereld',
    description: 'Drukt een tekst af op de terminal (DL11) en stopt met HALT. Daarna staat de console-ODT klaar.',
    source: `	.TITLE	HALLO
; Drukt een tekst af op de consoleterminal en stopt.
; De terminal (DL11) heeft een statusregister: bit 7 is 1 als hij
; klaar is voor het volgende teken.
XCSR	= 177564		; status van de zender
XBUF	= 177566		; teken naar de terminal

	. = 1000
START:	MOV	#START,SP	; stack groeit omlaag vanaf 1000
	MOV	#TEKST,R1
1$:	MOVB	(R1)+,R0	; volgend teken
	BEQ	2$		; 0 = einde van de tekst
	JSR	PC,PUTC
	BR	1$
2$:	HALT			; stop; de ODT toont het adres
	BR	START		; P (proceed) begint opnieuw

PUTC:	TSTB	@#XCSR		; bit 7 = klaar?
	BPL	PUTC		; nee: wachten
	MOVB	R0,@#XBUF
	RTS	PC

TEKST:	.ASCIZ	/Hallo, wereld! Groeten van de PDP-11./<15><12>
	.END	START
`,
  },
  {
    name: 'Looplicht',
    description: 'Een lichtje loopt heen en weer over de DATA-lampjes. Met de schakelaars stel je de snelheid in (0 = standaard).',
    source: `	.TITLE	LOOPLICHT
; Een lichtje loopt heen en weer over de DATA-lampjes van het frontpaneel.
; De schakelaars bepalen de wachttijd: hoe hoger het getal, hoe trager.
DR	= 177570		; displayregister (schrijven)
SWR	= 177570		; schakelregister (lezen)

	. = 1000
START:	MOV	#START,SP
	MOV	#1,R0		; het lichtje
LINKS:	JSR	PC,TOON
	ASL	R0		; een plaats naar links
	BPL	LINKS		; tot het bij bit 15 is
RECHTS:	JSR	PC,TOON
	CLC
	ROR	R0		; een plaats naar rechts
	CMP	R0,#1
	BNE	RECHTS
	BR	LINKS

; R0 op de lampjes zetten en even wachten
TOON:	MOV	R0,@#DR
	MOV	@#SWR,R1	; wachttijd uit de schakelaars
	BNE	1$
	MOV	#1000,R1	; standaard als alle schakelaars uit staan
1$:	MOV	#100.,R2
2$:	SOB	R2,2$		; SOB: verlaag en spring als niet 0
	SOB	R1,1$
	RTS	PC
	.END	START
`,
  },
  {
    name: 'Typmachine (interrupts)',
    description: 'Wat je typt komt terug in hoofdletters. Werkt met de toetsenbordinterrupt (vector 60), WAIT en RTI.',
    source: `	.TITLE	TYPMACHINE
; Alles wat je typt komt terug in HOOFDLETTERS. De toetsenbordinterrupt
; (vector 60) zet elk teken in TEKEN; het hoofdprogramma slaapt met WAIT
; tot er een interrupt is geweest.
RCSR	= 177560		; status ontvanger, bit 6 = interrupts aan
RBUF	= 177562		; ontvangen teken
XCSR	= 177564
XBUF	= 177566

	. = 60			; vector van het toetsenbord
	.WORD	KBDINT,200	; nieuwe PC en nieuwe PSW (prioriteit 4)

	. = 1000
START:	MOV	#START,SP
	CLR	TEKEN
	MOV	#WELKOM,R1
	JSR	PC,PUTS
	MOV	#100,@#RCSR	; interrupts van het toetsenbord aan
LUS:	WAIT			; slapen tot er een interrupt komt
	MOV	TEKEN,R0
	BEQ	LUS
	CLR	TEKEN
	CMPB	R0,#'a
	BLO	1$
	CMPB	R0,#'z
	BHI	1$
	BICB	#40,R0		; kleine letter -> hoofdletter
1$:	JSR	PC,PUTC
	CMPB	R0,#15		; na een return ook een linefeed
	BNE	LUS
	MOV	#12,R0
	JSR	PC,PUTC
	BR	LUS

KBDINT:	MOVB	@#RBUF,TEKEN	; lezen wist de klaar-vlag
	RTI			; PC en PSW terug van de stack

PUTC:	TSTB	@#XCSR
	BPL	PUTC
	MOVB	R0,@#XBUF
	RTS	PC

PUTS:	MOVB	(R1)+,R0
	BEQ	1$
	JSR	PC,PUTC
	BR	PUTS
1$:	RTS	PC

TEKEN:	.WORD	0
WELKOM:	.ASCIZ	/Typ maar iets (klik eerst in de terminal):/<15><12>
	.END	START
`,
  },
  {
    name: 'Klok (KW11-L)',
    description: 'De netfrequentieklok geeft 50 interrupts per seconde. Het programma drukt elke seconde de tijd af en zet de seconden op de lampjes.',
    source: `	.TITLE	KLOK
; De netfrequentieklok (KW11-L) geeft een interrupt bij elke periode van
; het lichtnet: 50 per seconde. De interruptroutine telt seconden, minuten
; en uren; het hoofdprogramma drukt de tijd af. DIV splitst in cijfers.
LKS	= 177546		; klokstatus, bit 6 = interrupts aan
DR	= 177570
XCSR	= 177564
XBUF	= 177566
HZ	= 50.			; 60. voor een klok op 60 Hz (zie Instellingen)

	. = 100
	.WORD	KLOKIN,300	; vector 100: PC en PSW (prioriteit 6)

	. = 1000
START:	MOV	#START,SP
	CLR	TIKKEN
	CLR	SEC
	CLR	MIN
	CLR	UUR
	CLR	NIEUW
	MOV	#100,@#LKS	; klokinterrupts aan
LUS:	WAIT
	TST	NIEUW
	BEQ	LUS
	CLR	NIEUW
	MOV	UUR,R0
	JSR	PC,TWEE
	MOV	#':,R0
	JSR	PC,PUTC
	MOV	MIN,R0
	JSR	PC,TWEE
	MOV	#':,R0
	JSR	PC,PUTC
	MOV	SEC,R0
	JSR	PC,TWEE
	MOV	#15,R0
	JSR	PC,PUTC
	MOV	#12,R0
	JSR	PC,PUTC
	BR	LUS

; Interruptroutine: na HZ tikken een seconde verder
KLOKIN:	INC	TIKKEN
	CMP	TIKKEN,#HZ
	BLO	9$
	CLR	TIKKEN
	INC	NIEUW
	INC	SEC
	CMP	SEC,#60.
	BLO	8$
	CLR	SEC
	INC	MIN
	CMP	MIN,#60.
	BLO	8$
	CLR	MIN
	INC	UUR
	CMP	UUR,#24.
	BLO	8$
	CLR	UUR
8$:	MOV	SEC,@#DR	; seconden op de lampjes
9$:	RTI

; R0 (0-99) als twee cijfers afdrukken
TWEE:	MOV	R0,R3		; DIV deelt het registerpaar R2,R3
	CLR	R2
	DIV	#10.,R2		; R2 = tientallen, R3 = eenheden
	MOV	R2,R0
	ADD	#'0,R0
	JSR	PC,PUTC
	MOV	R3,R0
	ADD	#'0,R0
	JSR	PC,PUTC
	RTS	PC

PUTC:	TSTB	@#XCSR
	BPL	PUTC
	MOVB	R0,@#XBUF
	RTS	PC

TIKKEN:	.WORD	0
SEC:	.WORD	0
MIN:	.WORD	0
UUR:	.WORD	0
NIEUW:	.WORD	0
	.END	START
`,
  },
  {
    name: 'Priemgetallen (MUL/DIV)',
    description: 'Drukt alle priemgetallen onder de 1000 af, met MUL, DIV en een recursieve subroutine voor decimale getallen.',
    source: `	.TITLE	PRIEM
; Alle priemgetallen onder de 1000. Een kandidaat is priem als geen
; enkele deler tot en met de wortel er precies in past.
XCSR	= 177564
XBUF	= 177566

	. = 1000
START:	MOV	#START,SP
	MOV	#2,R4		; kandidaat
	CLR	R5		; getallen op deze regel
VOLG:	MOV	#2,R1		; eerste deler
TEST:	MOV	R1,R3
	MUL	R1,R3		; R3 = deler * deler (oneven register: 16 bits)
	CMP	R3,R4
	BHI	PRIEM		; deler^2 > kandidaat: priem
	CLR	R2		; R2,R3 = kandidaat als 32-bit getal
	MOV	R4,R3
	DIV	R1,R2		; R2 = quotient, R3 = rest
	TST	R3
	BEQ	NIET		; past precies: geen priemgetal
	INC	R1
	BR	TEST
PRIEM:	MOV	R4,R0
	JSR	PC,DECOUT
	INC	R5
	CMP	R5,#10.
	BLO	1$
	CLR	R5
	JSR	PC,CRLF
	BR	NIET
1$:	MOV	#40,R0		; spatie
	JSR	PC,PUTC
NIET:	INC	R4
	CMP	R4,#1000.
	BLO	VOLG
	JSR	PC,CRLF
	HALT
	BR	START

; R0 decimaal afdrukken. Recursief: eerst de hogere cijfers.
DECOUT:	MOV	R1,-(SP)
	MOV	R0,R1
	CLR	R0		; R0,R1 = getal
	DIV	#10.,R0		; R0 = getal / 10, R1 = laatste cijfer
	TST	R0
	BEQ	1$
	JSR	PC,DECOUT	; de rest van het getal eerst
1$:	MOV	R1,R0
	ADD	#'0,R0
	JSR	PC,PUTC
	MOV	(SP)+,R1
	RTS	PC

CRLF:	MOV	#15,R0
	JSR	PC,PUTC
	MOV	#12,R0
PUTC:	TSTB	@#XCSR
	BPL	PUTC
	MOVB	R0,@#XBUF
	RTS	PC
	.END	START
`,
  },
  {
    name: 'Systeemaanroepen (TRAP)',
    description: 'Een mini-besturingssysteem: het programma vraagt je naam via TRAP-aanroepen. De TRAP-routine haalt het nummer uit de instructie.',
    source: `	.TITLE	TRAPS
; Een mini-besturingssysteem met drie diensten:
;   TRAP 0   teken in R0 afdrukken
;   TRAP 1   tekst afdrukken (adres in R0, eindigt op 0)
;   TRAP 2   teken lezen in R0
; Bij een TRAP zet de processor PSW en PC op de stack en springt via
; vector 34. Het nummer n zit in de TRAP-instructie zelf, net voor het
; teruggeefadres.
RCSR	= 177560
RBUF	= 177562
XCSR	= 177564
XBUF	= 177566

	. = 34
	.WORD	TRAPIN,0	; vector 34: TRAP

	. = 1000
START:	MOV	#START,SP
	MOV	#VRAAG,R0
	TRAP	1
	MOV	#NAAM,R1
1$:	TRAP	2		; teken lezen
	CMPB	R0,#15		; return?
	BEQ	2$
	TRAP	0		; laten zien
	MOVB	R0,(R1)+
	CMP	R1,#NAAM+40.
	BLO	1$
2$:	CLRB	(R1)
	MOV	#GROET,R0
	TRAP	1
	MOV	#NAAM,R0
	TRAP	1
	MOV	#EIND,R0
	TRAP	1
	HALT
	BR	START

TRAPIN:	MOV	R1,-(SP)
	MOV	2(SP),R1	; teruggeefadres
	MOV	-2(R1),R1	; de TRAP-instructie zelf
	BIC	#177400,R1	; alleen n houden
	CMP	R1,#2
	BHI	9$		; onbekende dienst: negeren
	ASL	R1		; n * 2 = plaats in de tabel
	JSR	PC,@TABEL(R1)
9$:	MOV	(SP)+,R1
	RTI

TABEL:	.WORD	PUTC,PUTS,GETC

PUTC:	TSTB	@#XCSR
	BPL	PUTC
	MOVB	R0,@#XBUF
	RTS	PC

PUTS:	MOV	R2,-(SP)
	MOV	R0,R2
1$:	MOVB	(R2)+,R0
	BEQ	2$
	JSR	PC,PUTC
	BR	1$
2$:	MOV	(SP)+,R2
	RTS	PC

GETC:	TSTB	@#RCSR		; bit 7: teken ontvangen?
	BPL	GETC
	MOVB	@#RBUF,R0
	BIC	#177600,R0	; 7 bits
	RTS	PC

VRAAG:	.ASCIZ	/Hoe heet je? /
GROET:	.ASCIZ	<15><12>/Hallo, /
EIND:	.ASCIZ	/! Leuk dat je een PDP-11 programmeert./<15><12>
	.EVEN
NAAM:	.BLKB	42.
	.END	START
`,
  },
  {
    name: 'Ponskaarten lezen (CR11)',
    description: 'Leest alle kaarten uit de kaartlezer en drukt ze af. Leg eerst kaarten in de lezer (tab Ponskaarten).',
    cards: true,
    source: `	.TITLE	KAARTEN
; Leest alle kaarten uit de kaartlezer (CR11) en drukt ze af.
; Per kolom zet de lezer in CRB1 een 12-bit patroon van de gaatjes:
; rij 12 = bit 11, rij 11 = bit 10, rij 0 = bit 9, rij 1 = bit 8 ...
; rij 9 = bit 0. Er is weinig tijd per kolom, dus het programma bewaart
; eerst alle 80 kolommen en vertaalt ze daarna met een tabel.
CRS	= 177160		; status van de kaartlezer
CRB1	= 177162		; kolom als 12-bit patroon
DR	= 177570
XCSR	= 177564
XBUF	= 177566

	. = 1000
START:	MOV	#START,SP
	CLR	AANTAL
KAART:	BIT	#20000,@#CRS	; bit 13: kaartenbak leeg?
	BNE	KLAAR
	MOV	#KOLOM,R1
	MOV	#1,@#CRS	; READ: volgende kaart invoeren
1$:	MOV	@#CRS,R0
	BMI	FOUT		; bit 15: fout
	BIT	#40000,R0	; bit 14: kaart klaar?
	BNE	2$
	TSTB	R0		; bit 7: kolom klaar?
	BPL	1$
	MOV	@#CRB1,(R1)+	; kolom bewaren (lezen wist bit 7)
	BR	1$

2$:	INC	AANTAL
	MOV	AANTAL,@#DR	; aantal kaarten op de lampjes
	MOV	#KOLOM+160.,R3	; einde van de kaart
3$:	CMP	R3,#KOLOM	; spaties aan het eind overslaan
	BLOS	5$
	TST	-2(R3)
	BNE	4$
	SUB	#2,R3
	BR	3$
4$:	MOV	#KOLOM,R1
6$:	MOV	(R1)+,R0
	JSR	PC,ASCII
	JSR	PC,PUTC
	CMP	R1,R3
	BLO	6$
5$:	JSR	PC,CRLF
	BR	KAART

FOUT:	MOV	#FOUTM,R1
	BR	EINDE
KLAAR:	MOV	#KLAARM,R1
EINDE:	MOVB	(R1)+,R0
	BEQ	1$
	JSR	PC,PUTC
	BR	EINDE
1$:	MOV	AANTAL,R0	; R0 = aantal gelezen kaarten
	HALT
	BR	START

; Hollerith-patroon in R0 -> ASCII-teken in R0 ('?' als onbekend)
ASCII:	MOV	#TABEL,R4
1$:	CMP	R4,#TABEND
	BHIS	2$
	CMP	(R4)+,R0
	BEQ	3$
	TST	(R4)+		; ASCII-code overslaan
	BR	1$
2$:	MOV	#'?,R0
	RTS	PC
3$:	MOV	(R4),R0
	RTS	PC

CRLF:	MOV	#15,R0
	JSR	PC,PUTC
	MOV	#12,R0
PUTC:	TSTB	@#XCSR
	BPL	PUTC
	MOVB	R0,@#XBUF
	RTS	PC

AANTAL:	.WORD	0
KOLOM:	.BLKW	80.
FOUTM:	.ASCIZ	/*** LEESFOUT ***/<15><12>
KLAARM:	.ASCIZ	/*** KAARTENBAK LEEG ***/<15><12>
	.EVEN
; Vertaaltabel volgens de DEC 029-code: patroon, ASCII
TABEL:
${cardTable}
TABEND:
	.END	START
`,
  },
];

export const SAMPLE_CARDS = `HALLO VANAF EEN PONSKAART!
DE PDP-11 LEEST 80 KOLOMMEN PER KAART.
ELKE REGEL HIER IS EEN KAART.
0123456789 +-*/=() $.,;:'"`;
