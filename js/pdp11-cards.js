// Ponskaarten: DEC 029-code (Hollerith). Een kaart heeft 80 kolommen en
// 12 rijen: 12, 11, 0, 1, 2 ... 9. Per kolom een 12-bit patroon zoals de
// CR11 het in CRB1 geeft: bit 11 = rij 12, bit 10 = rij 11, bit 9 = rij 0,
// bit 8 = rij 1 ... bit 0 = rij 9.

export const ROWS = [12, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const rowBit = (row) => (row === 12 ? 1 << 11 : row === 11 ? 1 << 10 : 1 << (9 - row));
const punch = (...rows) => rows.reduce((v, row) => v | rowBit(row), 0);

const CODE = new Map();
CODE.set(' ', 0);
for (let d = 0; d <= 9; d++) CODE.set(String(d), punch(d));
'ABCDEFGHI'.split('').forEach((ch, i) => CODE.set(ch, punch(12, i + 1)));
'JKLMNOPQR'.split('').forEach((ch, i) => CODE.set(ch, punch(11, i + 1)));
'STUVWXYZ'.split('').forEach((ch, i) => CODE.set(ch, punch(0, i + 2)));
CODE.set('&', punch(12));
CODE.set('-', punch(11));
CODE.set('/', punch(0, 1));
[['[', 12, 2], ['.', 12, 3], ['<', 12, 4], ['(', 12, 5], ['+', 12, 6], ['!', 12, 7],
  [']', 11, 2], ['$', 11, 3], ['*', 11, 4], [')', 11, 5], [';', 11, 6], ['^', 11, 7],
  ['\\', 0, 2], [',', 0, 3], ['%', 0, 4], ['_', 0, 5], ['>', 0, 6], ['?', 0, 7]]
  .forEach(([ch, zone, n]) => CODE.set(ch, punch(zone, 8, n)));
[[':', 2], ['#', 3], ['@', 4], ["'", 5], ['=', 6], ['"', 7]].forEach(([ch, n]) => CODE.set(ch, punch(8, n)));

const CHAR = new Map([...CODE].map(([ch, v]) => [v, ch]));

// Hollerith-patroon van een teken (kleine letters worden hoofdletters).
// Onbekende tekens: undefined.
export function charToHollerith(ch) {
  return CODE.get(ch.toUpperCase());
}

export function hollerithToChar(v) {
  return CHAR.get(v);
}

// Een regel tekst als kaart: 80 kolommen, aangevuld met spaties
export function textToCard(text) {
  const cols = new Array(80).fill(0);
  [...text.slice(0, 80)].forEach((ch, i) => { cols[i] = charToHollerith(ch) ?? 0; });
  return { text: text.slice(0, 80).toUpperCase(), cols };
}

// Gecomprimeerde code zoals CRB2: bit 7 = rij 12, 6 = 11, 5 = 0, 4 = 9,
// 3 = 8, bits 2-0 = nummer van de gepunchte rij 1-7 (0 = geen).
export function compress(v) {
  let c = 0;
  if (v & rowBit(12)) c |= 0x80;
  if (v & rowBit(11)) c |= 0x40;
  if (v & rowBit(0)) c |= 0x20;
  if (v & rowBit(9)) c |= 0x10;
  if (v & rowBit(8)) c |= 0x08;
  for (let n = 1; n <= 7; n++) if (v & rowBit(n)) c |= n;
  return c;
}

// Tekens die op een kaart passen, voor de uitleg
export const CARD_CHARSET = [...CODE.keys()].join('');
