// Kleine twee-pass 6502-assembler.
//
// Ondersteunt:
//   labels (LABEL of LABEL:), constanten (NAAM = waarde of NAAM .EQU waarde)
//   .ORG / *=, .BYTE / .DB, .WORD / .DW, .TEXT / .ASC ("tekst")
//   getallen: $hex, %binair, decimaal, 'c'   operatoren: + - * / & | ^ < (lo) > (hi)
//   commentaar na ;
import { ASM, MODE_SIZE } from './opcodes.js';

export class AsmError extends Error {
  constructor(line, msg) {
    super(`regel ${line}: ${msg}`);
    this.line = line;
  }
}

const BRANCHES = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);

// Expressie-evaluator. Geeft undefined terug als een symbool (nog) onbekend is.
function evaluate(expr, symbols, pc, lineNo) {
  const s = expr.trim();
  let i = 0;
  let unknown = false;

  const peekCh = () => { while (s[i] === ' ' || s[i] === '\t') i++; return s[i]; };

  function primary() {
    const c = peekCh();
    if (c === '<') { i++; return primary() & 0xFF; }
    if (c === '>') { i++; return (primary() >> 8) & 0xFF; }
    if (c === '-') { i++; return -primary(); }
    if (c === '(') {
      i++;
      const v = sum();
      if (peekCh() !== ')') throw new AsmError(lineNo, `')' verwacht in "${s}"`);
      i++;
      return v;
    }
    if (c === '$') {
      const m = /^\$[0-9a-fA-F]+/.exec(s.slice(i));
      if (!m) throw new AsmError(lineNo, `ongeldig hexgetal in "${s}"`);
      i += m[0].length;
      return parseInt(m[0].slice(1), 16);
    }
    if (c === '%') {
      const m = /^%[01]+/.exec(s.slice(i));
      if (!m) throw new AsmError(lineNo, `ongeldig binair getal in "${s}"`);
      i += m[0].length;
      return parseInt(m[0].slice(1), 2);
    }
    if (c === "'") {
      const ch = s[i + 1];
      i += s[i + 2] === "'" ? 3 : 2;
      return ch.charCodeAt(0);
    }
    if (c === '*') { i++; return pc; }
    let m = /^[0-9]+/.exec(s.slice(i));
    if (m) { i += m[0].length; return parseInt(m[0], 10); }
    m = /^[A-Za-z_.][A-Za-z0-9_.]*/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      const name = m[0].toUpperCase();
      if (name in symbols) return symbols[name];
      unknown = true;
      return 0;
    }
    throw new AsmError(lineNo, `kan "${s}" niet lezen`);
  }

  function product() {
    let v = primary();
    for (;;) {
      const c = peekCh();
      if (c === '*') { i++; v *= primary(); } else if (c === '/') { i++; v = Math.trunc(v / primary()); } else return v;
    }
  }

  function sum() {
    let v = product();
    for (;;) {
      const c = peekCh();
      if (c === '+') { i++; v += product(); } else if (c === '-') { i++; v -= product(); } else if (c === '&') { i++; v &= product(); } else if (c === '|') { i++; v |= product(); } else if (c === '^') { i++; v ^= product(); } else return v;
    }
  }

  const v = sum();
  if (peekCh() !== undefined) throw new AsmError(lineNo, `onverwachte tekst in "${s}"`);
  return unknown ? undefined : v;
}

// Splits een operand in adresseringsmodus + expressie
function parseOperand(mn, operand) {
  const o = operand.trim();
  if (o === '') return { mode: 'imp', expr: null };
  if (/^A$/i.test(o)) return { mode: 'acc', expr: null };
  if (o[0] === '#') return { mode: 'imm', expr: o.slice(1) };
  let m = /^\((.*),\s*X\s*\)$/i.exec(o);
  if (m) return { mode: 'izx', expr: m[1] };
  m = /^\((.*)\)\s*,\s*Y$/i.exec(o);
  if (m) return { mode: 'izy', expr: m[1] };
  if (mn === 'JMP') {
    m = /^\((.*)\)$/.exec(o);
    if (m) return { mode: 'ind', expr: m[1] };
  }
  m = /^(.*),\s*X$/i.exec(o);
  if (m) return { mode: 'x', expr: m[1] };
  m = /^(.*),\s*Y$/i.exec(o);
  if (m) return { mode: 'y', expr: m[1] };
  return { mode: 'addr', expr: o };
}

// Kiest de definitieve modus (zero page als dat kan) en de grootte
function resolveMode(mn, parsed, value, lineNo) {
  const modes = ASM[mn];
  const zpOk = value !== undefined && value >= 0 && value <= 0xFF;
  let mode = parsed.mode;
  if (BRANCHES.has(mn)) {
    if (mode !== 'addr') throw new AsmError(lineNo, `${mn} verwacht een adres`);
    return 'rel';
  }
  if (mode === 'acc' && !modes.acc) throw new AsmError(lineNo, `${mn} A bestaat niet`);
  if (mode === 'imp' && !modes.imp && modes.acc) mode = 'acc';
  if (mode === 'addr') mode = zpOk && modes.zp !== undefined ? 'zp' : 'abs';
  else if (mode === 'x') mode = zpOk && modes.zpx !== undefined ? 'zpx' : 'abx';
  else if (mode === 'y') mode = zpOk && modes.zpy !== undefined ? 'zpy' : 'aby';
  if (modes[mode] === undefined) {
    // Bijv. LDX abs,Y bestaat wel als aby maar niet als zpy
    const fallback = { zp: 'abs', zpx: 'abx', zpy: 'aby' }[mode];
    if (fallback && modes[fallback] !== undefined) return fallback;
    throw new AsmError(lineNo, `adresseringsmodus niet mogelijk voor ${mn}`);
  }
  return mode;
}

function splitArgs(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"') { q = ch; continue; }
    if (ch === "'" && line[i + 2] === "'") { i += 2; continue; }
    if (ch === ';') return line.slice(0, i);
  }
  return line;
}

// Assembleert broncode. Resultaat: { segments: [{start, bytes}], symbols, start, listing }
export function assemble(source) {
  const lines = source.split(/\r?\n/);
  const symbols = {};
  // Herhaal tot alle labels stabiel zijn, dan een laatste pass met foutcontrole
  let prev = '';
  for (let pass = 0; pass < 20; pass++) {
    runPass(lines, symbols, false);
    const now = JSON.stringify(symbols);
    if (now === prev) break;
    prev = now;
  }
  return runPass(lines, symbols, true);
}

function runPass(lines, symbols, final) {
  let pc = 0x0200;
  let start = null;
  const segments = [];
  let seg = null;
  const listing = [];

  const emit = (bytes) => {
    if (!seg || seg.start + seg.bytes.length !== pc) {
      seg = { start: pc, bytes: [] };
      segments.push(seg);
    }
    for (const b of bytes) seg.bytes.push(b & 0xFF);
    pc = (pc + bytes.length) & 0xFFFF;
  };

  const ev = (expr, lineNo) => {
    const v = evaluate(expr, symbols, pc, lineNo);
    if (v === undefined && final) throw new AsmError(lineNo, `onbekend symbool in "${expr.trim()}"`);
    return v;
  };

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    let line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') return;
    const linePc = pc;

    // Constante: NAAM = expr of NAAM .EQU expr
    let m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=|\.EQU\b|EQU\b)\s*(.+)$/i.exec(line);
    if (m && m[1] !== '*') {
      const v = ev(m[3], lineNo);
      if (v !== undefined) symbols[m[1].toUpperCase()] = v & 0xFFFF;
      return;
    }
    // *= expr
    m = /^\s*\*\s*=\s*(.+)$/.exec(line);
    if (m) { pc = ev(m[1], lineNo) ?? pc; return; }

    // Label: "NAAM:" (ook ingesprongen) of een woord in kolom 1 dat geen mnemonic is
    const withColon = /^\s*([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    const column1 = /^([A-Za-z_][A-Za-z0-9_]*)(\s.*|)$/.exec(line);
    if (withColon) {
      symbols[withColon[1].toUpperCase()] = pc;
      line = withColon[2];
    } else if (column1 && !(column1[1].toUpperCase() in ASM)) {
      symbols[column1[1].toUpperCase()] = pc;
      line = column1[2];
    }
    line = line.trim();
    if (line === '') return;

    m = /^(\.?[A-Za-z]+)\s*(.*)$/.exec(line);
    if (!m) throw new AsmError(lineNo, `kan regel niet lezen: "${line}"`);
    const word = m[1].toUpperCase();
    const rest = m[2];

    switch (word) {
      case '.ORG': case 'ORG':
        pc = ev(rest, lineNo) ?? pc;
        return;
      case '.START':
        start = ev(rest, lineNo);
        return;
      case '.BYTE': case '.DB': case 'DB': case '.BYT': {
        const bytes = [];
        for (const a of splitArgs(rest)) {
          if (a[0] === '"') {
            for (const ch of a.slice(1, -1)) bytes.push(ch.charCodeAt(0));
          } else {
            bytes.push(ev(a, lineNo) ?? 0);
          }
        }
        emit(bytes);
        listing.push({ line: lineNo, addr: linePc, bytes });
        return;
      }
      case '.WORD': case '.DW': case 'DW': {
        const bytes = [];
        for (const a of splitArgs(rest)) { const v = ev(a, lineNo) ?? 0; bytes.push(v & 0xFF, (v >> 8) & 0xFF); }
        emit(bytes);
        listing.push({ line: lineNo, addr: linePc, bytes });
        return;
      }
      case '.TEXT': case '.ASC': case '.ASCII': {
        const t = /^"(.*)"$/.exec(rest.trim());
        if (!t) throw new AsmError(lineNo, '.TEXT verwacht "tekst"');
        const bytes = [...t[1]].map((ch) => ch.charCodeAt(0));
        emit(bytes);
        listing.push({ line: lineNo, addr: linePc, bytes });
        return;
      }
      case '.END': case 'END':
        return;
    }

    if (!(word in ASM)) throw new AsmError(lineNo, `onbekende instructie "${m[1]}"`);
    const parsed = parseOperand(word, rest);
    const value = parsed.expr !== null ? ev(parsed.expr, lineNo) : 0;
    // Onbekende waarde in pass 1: neem absolute adressering aan (veilig voor grootte)
    const mode = resolveMode(word, parsed, value === undefined ? 0x1000 : value, lineNo);
    const op = ASM[word][mode];
    const size = MODE_SIZE[mode];
    const bytes = [op];
    const v = value ?? 0;
    if (mode === 'rel') {
      const off = v - ((pc + 2) & 0xFFFF);
      if (final && (off < -128 || off > 127)) throw new AsmError(lineNo, `sprong te ver (${off} bytes)`);
      bytes.push(off & 0xFF);
    } else if (size === 2) {
      if (final && mode !== 'imm' && (v < 0 || v > 0xFF)) throw new AsmError(lineNo, 'waarde past niet in één byte');
      if (final && mode === 'imm' && (v < -128 || v > 0xFF)) throw new AsmError(lineNo, 'directe waarde past niet in één byte');
      bytes.push(v & 0xFF);
    } else if (size === 3) {
      bytes.push(v & 0xFF, (v >> 8) & 0xFF);
    }
    emit(bytes);
    listing.push({ line: lineNo, addr: linePc, bytes });
  });

  if (start === null || start === undefined) start = segments.length ? segments[0].start : 0x0200;
  return { segments, symbols, start, listing };
}
