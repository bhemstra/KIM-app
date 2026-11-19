// Twee-pass assembler voor de PDP-11, in de stijl van MACRO-11.
//
// Ondersteunt:
//   labels (LABEL:), lokale labels (1$:), toekenningen (NAAM = expr, . = expr)
//   alle adresseermodi: R  (R)  (R)+  @(R)+  -(R)  @-(R)  X(R)  @X(R)  #n  @#n  label  @label
//   getallen octaal (standaard), decimaal met punt (100.), ^D ^O ^B, 'c, "cc
//   operatoren + - * / & ! (van links naar rechts, zoals MACRO-11), ^C (complement), <...>
//   .WORD .BYTE .ASCII .ASCIZ .EVEN .ODD .BLKW .BLKB .RADIX .END
//   (.TITLE, .SBTTL, .IDENT, .LIST, .NLIST, .ENABL, .DSABL, .GLOBL, .ASECT, .PAGE worden genegeerd)
import { OPS } from './pdp11-disasm.js';

export class AsmError extends Error {
  constructor(line, msg) {
    super(`regel ${line}: ${msg}`);
    this.line = line;
  }
}

const IGNORED = new Set(['.TITLE', '.SBTTL', '.IDENT', '.LIST', '.NLIST', '.ENABL', '.DSABL', '.GLOBL', '.ASECT', '.PAGE', '.CSECT', '.PSECT', '.MCALL']);
const REGISTERS = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7, SP: 6, PC: 7 };
const NAME_START = /[A-Za-z$._]/;
const NAME_CHAR = /[A-Za-z0-9$._]/;
const MEM_TOP = 0o160000;

// Haal commentaar weg, rekening houdend met 'c en "cc
function stripComment(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") i += 1;
    else if (c === '"') i += 2;
    else if (c === ';') return s.slice(0, i);
  }
  return s;
}

// Splits op komma's buiten <...> en buiten tekenconstanten
function splitArgs(s) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { cur += s.slice(i, i + 2); i += 1; continue; }
    if (c === '"') { cur += s.slice(i, i + 3); i += 2; continue; }
    if (c === '<' || c === '(') depth++;
    if (c === '>' || c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function assemble(src) {
  const lines = src.split(/\r?\n/);
  const symbols = new Map(); // NAAM -> { value, reg }
  let result;
  for (const pass of [1, 2]) result = runPass(pass, lines, symbols);
  return result;
}

function runPass(pass, lines, symbols) {
  let lc = 0;
  let scope = 0;
  let radix = 8;
  let start = null;
  const bytes = new Map();
  const listing = [];
  let lineNo = 0;

  const err = (msg) => { throw new AsmError(lineNo, msg); };

  const localName = (n) => `${n}@${scope}`;

  // ---------- Expressies ----------

  function evaluate(text) {
    const s = text;
    let i = 0;
    let undef = false;
    let isReg = false;
    let terms = 0;

    const ws = () => { while (s[i] === ' ' || s[i] === '\t') i++; };

    function number(base, digits) {
      const m = digits.exec(s.slice(i));
      if (!m) err(`getal verwacht in "${s.trim()}"`);
      i += m[0].length;
      return parseInt(m[0], base);
    }

    function term() {
      ws();
      terms++;
      const c = s[i];
      if (c === undefined) err(`expressie onvolledig: "${s.trim()}"`);
      if (c === '-') { i++; return -term(); }
      if (c === '+') { i++; return term(); }
      if (c === '<') {
        i++;
        const v = expr();
        ws();
        if (s[i] !== '>') err(`'>' verwacht in "${s.trim()}"`);
        i++;
        return v;
      }
      if (c === '^') {
        const k = (s[i + 1] || '').toUpperCase();
        i += 2;
        if (k === 'O') { ws(); return number(8, /^[0-7]+/); }
        if (k === 'D') { ws(); return number(10, /^[0-9]+/); }
        if (k === 'B') { ws(); return number(2, /^[01]+/); }
        if (k === 'X') { ws(); return number(16, /^[0-9A-Fa-f]+/); }
        if (k === 'C') return ~term() & 0xFFFF;
        err(`onbekende operator ^${k}`);
      }
      if (c === "'") {
        if (i + 1 >= s.length) err('teken verwacht na \'');
        const v = s.charCodeAt(i + 1);
        i += 2;
        return v;
      }
      if (c === '"') {
        if (i + 2 >= s.length) err('twee tekens verwacht na "');
        const v = s.charCodeAt(i + 1) | (s.charCodeAt(i + 2) << 8);
        i += 3;
        return v;
      }
      if (c === '%') {
        i++;
        const v = term();
        isReg = true;
        if (v < 0 || v > 7) err('registernummer moet 0-7 zijn');
        return v;
      }
      if (/[0-9]/.test(c)) {
        const m = /^([0-9]+)(\.|\$)?/.exec(s.slice(i));
        i += m[0].length;
        if (m[2] === '$') return symbol(localName(m[1] + '$'), m[0]);
        if (m[2] === '.' || radix === 10) return parseInt(m[1], 10);
        if (/[89]/.test(m[1])) err(`${m[1]} is geen octaal getal (decimaal schrijf je als ${m[1]}.)`);
        return parseInt(m[1], 8);
      }
      if (NAME_START.test(c)) {
        let j = i + 1;
        while (j < s.length && NAME_CHAR.test(s[j])) j++;
        const name = s.slice(i, j).toUpperCase();
        i = j;
        if (name === '.') return lc;
        if (name in REGISTERS) { isReg = true; return REGISTERS[name]; }
        return symbol(name, name);
      }
      err(`onverwacht teken '${c}' in "${s.trim()}"`);
    }

    function symbol(key, shown) {
      const sym = symbols.get(key);
      if (!sym) {
        if (pass === 2) err(`onbekend symbool ${shown}`);
        undef = true;
        return 0;
      }
      if (sym.reg) isReg = true;
      return sym.value;
    }

    function expr() {
      let v = term();
      for (;;) {
        ws();
        const op = s[i];
        if (op === '+' || op === '-' || op === '*' || op === '/' || op === '&' || op === '!') {
          i++;
          const t = term();
          if (op === '+') v += t;
          else if (op === '-') v -= t;
          else if (op === '*') v *= t;
          else if (op === '/') { if (t === 0) { if (!undef) err('deling door nul'); v = 0; } else v = Math.trunc(v / t); }
          else if (op === '&') v &= t;
          else v |= t;
        } else return v;
      }
    }

    const value = expr();
    ws();
    if (i < s.length) err(`onverwacht "${s.slice(i).trim()}" in expressie`);
    return { value: value & 0xFFFF, undef, reg: isReg && terms === 1 };
  }

  const value = (text) => evaluate(text).value;
  const definedValue = (text, what) => {
    const r = evaluate(text);
    if (r.undef) err(`${what} moet al bekend zijn (geen voorwaartse verwijzing)`);
    return r.value;
  };

  // ---------- Uitvoer ----------

  const emitted = [];
  let produced = 0;
  function putByte(v) {
    produced++;
    if (lc >= MEM_TOP) err(`adres ${lc.toString(8)} ligt buiten het geheugen (max. 157777)`);
    if (pass === 2) bytes.set(lc, v & 0xFF);
    lc++;
  }
  function putWord(v) {
    if (lc & 1) err('woord op een oneven adres (gebruik .EVEN)');
    putByte(v);
    putByte((v >> 8) & 0xFF);
    emitted.push(v & 0xFFFF);
  }

  function define(name, val, isLabel) {
    const key = /^\d+\$$/.test(name) ? localName(name) : name.toUpperCase();
    if (key in REGISTERS) err(`${name} is een registernaam`);
    const old = symbols.get(key);
    if (pass === 1) {
      if (old && old.label && isLabel) err(`label ${name} is dubbel gedefinieerd`);
      symbols.set(key, { value: val.value & 0xFFFF, reg: !!val.reg, label: isLabel });
    } else {
      if (isLabel && old && old.value !== (val.value & 0xFFFF)) err(`fase-fout bij label ${name}`);
      symbols.set(key, { ...(old || {}), value: val.value & 0xFFFF, reg: !!val.reg });
    }
  }

  // ---------- Operanden ----------

  function regOf(text) {
    const r = evaluate(text);
    if (!r.reg) err(`register verwacht in plaats van "${text}"`);
    return r.value;
  }

  function operand(text) {
    let s = text.trim();
    if (!s) err('operand ontbreekt');
    let deferred = false;
    if (s[0] === '@') { deferred = true; s = s.slice(1).trim(); }
    let m;
    if (s[0] === '#') return { mode: deferred ? 3 : 2, reg: 7, extra: { expr: s.slice(1), rel: false } };
    if ((m = /^\((.+)\)\s*\+$/.exec(s))) return { mode: deferred ? 3 : 2, reg: regOf(m[1]) };
    if ((m = /^-\s*\((.+)\)$/.exec(s))) return { mode: deferred ? 5 : 4, reg: regOf(m[1]) };
    if ((m = /^\(([^()]+)\)$/.exec(s))) {
      const reg = regOf(m[1]);
      return deferred ? { mode: 7, reg, extra: { expr: '0', rel: false } } : { mode: 1, reg };
    }
    if ((m = /^(.+?)\(([^()]+)\)$/.exec(s))) return { mode: deferred ? 7 : 6, reg: regOf(m[2]), extra: { expr: m[1], rel: false } };
    const r = evaluate(s);
    if (r.reg) return { mode: deferred ? 1 : 0, reg: r.value };
    return { mode: deferred ? 7 : 6, reg: 7, extra: { expr: s, rel: true } };
  }

  const field = (o) => (o.mode << 3) | o.reg;

  function instruction(name, args) {
    const { op, fmt } = OPS[name];
    if (lc & 1) err('instructie op een oneven adres (gebruik .EVEN)');
    const here = lc;
    const want = (n) => { if (args.length !== n || (n > 0 && args.some((a) => a === ''))) err(`${name} verwacht ${n} operand${n === 1 ? '' : 'en'}`); };
    let word = op;
    const ops = [];
    switch (fmt) {
      case 'none':
        if (args.length && args[0] !== '') err(`${name} heeft geen operanden`);
        break;
      case 'dd': {
        want(1);
        const d = operand(args[0]);
        if (name === 'JMP' && d.mode === 0) err('JMP naar een register kan niet');
        word |= field(d); ops.push(d);
        break;
      }
      case 'r': want(1); word |= regOf(args[0]); break;
      case 'rdd': {
        want(2);
        const d = operand(args[1]);
        if (name === 'JSR' && d.mode === 0) err('JSR naar een register kan niet');
        word |= (regOf(args[0]) << 6) | field(d); ops.push(d);
        break;
      }
      case 'ssdd': {
        want(2);
        const s = operand(args[0]);
        const d = operand(args[1]);
        word |= (field(s) << 6) | field(d); ops.push(s, d);
        break;
      }
      case 'ssr': {
        want(2);
        const s = operand(args[0]);
        word |= (regOf(args[1]) << 6) | field(s); ops.push(s);
        break;
      }
      case 'br': {
        want(1);
        const t = evaluate(args[0]);
        if (!t.undef) {
          const diff = t.value - ((here + 2) & 0xFFFF);
          const off = ((diff + 0x8000) & 0xFFFF) - 0x8000;
          if (pass === 2 && (off & 1)) err('sprongdoel ligt op een oneven adres');
          if (pass === 2 && (off < -256 || off > 254)) err(`sprongdoel te ver weg (${off / 2} woorden; maximaal -128..127). Gebruik JMP`);
          word |= (off >> 1) & 0xFF;
        }
        break;
      }
      case 'sob': {
        want(2);
        word |= regOf(args[0]) << 6;
        const t = evaluate(args[1]);
        if (!t.undef) {
          const off = (((here + 2) - t.value) & 0xFFFF) >> 1;
          if (pass === 2 && (off < 0 || off > 63 || t.value > here + 2)) err('SOB kan alleen 0-63 woorden terug springen');
          word |= off & 0o77;
        }
        break;
      }
      case 'n8': {
        const v = args[0] ? value(args[0]) : 0;
        if (v > 0o377) err(`${name}-nummer moet 0-377 zijn`);
        word |= v;
        break;
      }
      default: { // n6: MARK
        want(1);
        const v = value(args[0]);
        if (v > 0o77) err('MARK-getal moet 0-77 zijn');
        word |= v;
      }
    }
    putWord(word);
    for (const o of ops) {
      if (!o.extra) continue;
      const v = value(o.extra.expr);
      putWord(o.extra.rel ? v - ((lc + 2) & 0xFFFF) : v);
    }
  }

  // .ASCII /tekst/<15><12> ...
  function ascii(rest, zero) {
    let i = 0;
    const s = rest;
    for (;;) {
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (i >= s.length || s[i] === ';') break;
      if (s[i] === '<') {
        const j = s.indexOf('>', i);
        if (j < 0) err("'>' ontbreekt");
        putByte(value(s.slice(i + 1, j)));
        i = j + 1;
        continue;
      }
      const delim = s[i];
      const j = s.indexOf(delim, i + 1);
      if (j < 0) err(`afsluitend ${delim} ontbreekt`);
      for (const ch of s.slice(i + 1, j)) putByte(ch.charCodeAt(0));
      i = j + 1;
    }
    if (zero) putByte(0);
  }

  // ---------- Regels ----------

  for (const raw of lines) {
    lineNo++;
    emitted.length = 0;
    produced = 0;
    const lineStart = lc;
    let s = raw;

    // Labels
    let m;
    while ((m = /^\s*([A-Za-z$._][A-Za-z0-9$._]*|\d+\$)\s*::?/.exec(s))) {
      const name = m[1];
      if (name === '.') err('. kan geen label zijn');
      if (!/^\d+\$$/.test(name)) scope++;
      define(name, { value: lc }, true);
      s = s.slice(m[0].length);
    }

    const opm = /^\s*(\.?[A-Za-z][A-Za-z0-9$.]*)/.exec(s);
    const opName = opm ? opm[1].toUpperCase() : '';

    if (opName === '.ASCII' || opName === '.ASCIZ') {
      ascii(s.slice(opm[0].length), opName === '.ASCIZ');
    } else {
      s = stripComment(s);
      if ((m = /^\s*([A-Za-z$._][A-Za-z0-9$._]*)\s*==?(.*)$/.exec(s))) {
        const name = m[1].toUpperCase();
        if (name === '.') {
          const v = definedValue(m[2], 'het nieuwe adres');
          if (v >= MEM_TOP) err(`adres ${v.toString(8)} ligt buiten het geheugen`);
          lc = v;
        } else define(name, evaluate(m[2]), false);
      } else if (opName && OPS[opName]) {
        const rest = s.slice(opm[0].length).trim();
        instruction(opName, rest ? splitArgs(rest) : []);
      } else if (opName.startsWith('.')) {
        const rest = s.slice(opm[0].length).trim();
        switch (opName) {
          case '.WORD':
            for (const a of splitArgs(rest)) putWord(a ? value(a) : 0);
            break;
          case '.BYTE':
            for (const a of splitArgs(rest)) {
              const v = a ? value(a) : 0;
              putByte(v);
            }
            break;
          case '.EVEN': if (lc & 1) lc++; break;
          case '.ODD': if (!(lc & 1)) lc++; break;
          case '.BLKB': lc += rest ? definedValue(rest, 'de lengte') : 1; break;
          case '.BLKW':
            if (lc & 1) err('.BLKW op een oneven adres');
            lc += 2 * (rest ? definedValue(rest, 'de lengte') : 1);
            break;
          case '.RADIX': {
            const r = rest ? parseInt(rest, 10) : 8;
            if (r !== 8 && r !== 10) err('.RADIX 8 of .RADIX 10');
            radix = r;
            break;
          }
          case '.END':
            if (rest) start = value(rest);
            listing.push({ line: lineNo, addr: null, words: [], src: raw });
            return finish();
          default:
            if (!IGNORED.has(opName)) err(`onbekende directive ${opName}`);
        }
      } else if (s.trim()) {
        // "XYZ R0" met een onbekende naam vooraan is vrijwel zeker een tikfout
        if (/^[A-Z]/.test(opName) && !(opName in REGISTERS) && !symbols.has(opName) && /^\s*\S+\s+[^\s+\-*\/&!]/.test(s)) {
          err(`onbekende instructie ${opName}`);
        }
        // Een kale expressie is een .WORD
        for (const a of splitArgs(s.trim())) putWord(a ? value(a) : 0);
      }
    }
    listing.push({ line: lineNo, addr: produced || (lc !== lineStart && /^\s*\.BLK/i.test(raw.replace(/^.*?:\s*/, ''))) ? lineStart : null, words: emitted.slice(), src: raw });
  }
  return finish();

  function finish() {
    const addrs = [...bytes.keys()].sort((a, b) => a - b);
    const segments = [];
    for (const a of addrs) {
      const last = segments[segments.length - 1];
      if (last && last.start + last.bytes.length === a) last.bytes.push(bytes.get(a));
      else segments.push({ start: a, bytes: [bytes.get(a)] });
    }
    const syms = new Map();
    for (const [k, v] of symbols) if (!k.includes('@')) syms.set(k, v.value);
    return { segments, start, symbols: syms, listing };
  }
}

// Listing in octaal, zoals MACRO-11 die maakt
export function formatListing(listing) {
  const o = (v) => v.toString(8).padStart(6, '0');
  return listing.map((l) => {
    const addr = l.addr === null ? '      ' : o(l.addr);
    const w = l.words.slice(0, 3).map(o).join(' ').padEnd(20);
    return `${String(l.line).padStart(4)} ${addr}  ${w} ${l.src}`;
  }).join('\n');
}
