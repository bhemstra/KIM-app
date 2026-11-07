// CL (Control Language): opdrachten ontleden en expressies uitrekenen.

// Een foutmelding zoals het systeem die stuurt (escape-bericht)
export class CpfError extends Error {
  constructor(id, text) {
    super(text);
    this.id = id;
    this.text = text;
  }
}

export const isName = (s) => /^[A-Z@#$][A-Z0-9@#$_.]{0,9}$/.test(s);

// Splits op spaties op het hoogste niveau; aanhalingstekens en haakjes blijven heel.
export function splitTop(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "'") {
        if (s[i + 1] === "'") { cur += "'"; i++; } else q = false;
      }
      continue;
    }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth < 0) throw new CpfError('CPD0014', 'Closing parenthesis without matching opening parenthesis.');
    }
    if (/\s/.test(c) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (q) throw new CpfError('CPD0013', 'Closing apostrophe missing.');
  if (depth > 0) throw new CpfError('CPD0015', 'Closing parenthesis missing.');
  if (cur) out.push(cur);
  return out;
}

// "LABEL: LIB/CMD KW(waarde) positioneel" → { label, lib, name, params: [{kw, raw}] }
export function parseCommand(str) {
  let s = String(str).trim();
  let label = null;
  const m = /^([A-Za-z@#$][A-Za-z0-9@#$_]{0,9}):\s*/.exec(s);
  if (m) { label = m[1].toUpperCase(); s = s.slice(m[0].length); }
  const toks = splitTop(s);
  if (!toks.length) return { label, lib: null, name: '', params: [] };
  let name = toks[0].toUpperCase();
  let lib = null;
  if (name.includes('/')) [lib, name] = name.split('/');
  const params = toks.slice(1).map((t) => {
    const km = /^([A-Za-z][A-Za-z0-9]*)\(([\s\S]*)\)$/.exec(t);
    if (km) return { kw: km[1].toUpperCase(), raw: km[2].trim() };
    return { kw: null, raw: t };
  });
  return { label, lib, name, params };
}

// Waarde zoals CL die ziet: tussen aanhalingstekens letterlijk, anders hoofdletters
export function normVal(t) {
  t = String(t ?? '').trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t.toUpperCase();
}

export const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Een tekstwaarde zo opschrijven dat CL hem terug kan lezen
export function clString(s) {
  s = String(s);
  if (/^[A-Z@#$*][A-Z0-9@#$_.*]*$/.test(s)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return quote(s);
}

// LIB/OBJ → { lib, obj }; zonder bibliotheek wordt het *LIBL
export function parseQual(t, dftLib = '*LIBL') {
  t = String(t ?? '').trim();
  let q = false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "'") q = !q;
    if (t[i] === '/' && !q) return { lib: normVal(t.slice(0, i)), obj: normVal(t.slice(i + 1)) };
  }
  return { lib: dftLib, obj: normVal(t) };
}

// ---------- Expressies ----------

const REL = { '*EQ': '=', '*NE': '<>', '*GT': '>', '*LT': '<', '*GE': '>=', '*LE': '<=', '*NG': '<=', '*NL': '>=' };
const SYM_REL = ['>=', '<=', '<>', '¬=', '=', '>', '<'];

function tokenizeExpr(s) {
  const toks = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= s.length) throw new CpfError('CPD0013', 'Closing apostrophe missing.');
        if (s[i] === "'") {
          if (s[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += s[i++];
      }
      toks.push({ t: 'str', v });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = /^[0-9]*[.,]?[0-9]*/.exec(s.slice(i))[0];
      toks.push({ t: 'num', v: Number(m.replace(',', '.')) });
      i += m.length;
      continue;
    }
    if (c === '&') {
      const m = /^&[A-Za-z@#$][A-Za-z0-9@#$_]*/.exec(s.slice(i));
      if (!m) throw new CpfError('CPD0702', 'Variable name not valid.');
      toks.push({ t: 'var', v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (c === '%') {
      const m = /^%[A-Za-z]+/.exec(s.slice(i));
      toks.push({ t: 'bif', v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    if (c === '*' && /[A-Za-z]/.test(s[i + 1] || '')) {
      const m = /^\*[A-Za-z0-9]+/.exec(s.slice(i))[0].toUpperCase();
      i += m.length;
      if (REL[m]) toks.push({ t: 'op', v: REL[m] });
      else if (['*CAT', '*BCAT', '*TCAT', '*AND', '*OR', '*NOT'].includes(m)) toks.push({ t: 'op', v: m });
      else toks.push({ t: 'str', v: m }); // speciale waarde zoals *YES
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '||') { toks.push({ t: 'op', v: '*CAT' }); i += 2; continue; }
    if (two === '|>') { toks.push({ t: 'op', v: '*BCAT' }); i += 2; continue; }
    if (two === '|<') { toks.push({ t: 'op', v: '*TCAT' }); i += 2; continue; }
    const rel = SYM_REL.find((r) => s.startsWith(r, i));
    if (rel) { toks.push({ t: 'op', v: rel === '¬=' ? '<>' : rel }); i += rel.length; continue; }
    if ('+-*/'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '&' || c === '|') { toks.push({ t: 'op', v: c === '&' ? '*AND' : '*OR' }); i++; continue; }
    if (c === '¬') { toks.push({ t: 'op', v: '*NOT' }); i++; continue; }
    if (c === '(' || c === ')') { toks.push({ t: c }); i++; continue; }
    const m = /^[A-Za-z@#$][A-Za-z0-9@#$_./]*/.exec(s.slice(i));
    if (m) { toks.push({ t: 'str', v: m[0].toUpperCase() }); i += m[0].length; continue; }
    throw new CpfError('CPD0181', `Character '${c}' not valid in expression.`);
  }
  return toks;
}

const BIN = {
  '*OR': 1, '*AND': 2,
  '=': 4, '<>': 4, '>': 4, '<': 4, '>=': 4, '<=': 4,
  '*CAT': 5, '*BCAT': 5, '*TCAT': 5,
  '+': 6, '-': 6, '*': 7, '/': 7,
};

const truthy = (v) => v === '1' || v === true || v === 1;
const asStr = (v) => (typeof v === 'number' ? fmtNum(v) : String(v));

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9);
}

function asNum(v) {
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim().replace(',', '.'));
  if (String(v).trim() === '' || Number.isNaN(n)) throw new CpfError('CPD0789', `Value '${String(v).trim()}' is not numeric.`);
  return n;
}

function compare(a, b) {
  const numA = typeof a === 'number', numB = typeof b === 'number';
  if (numA || numB) {
    const x = asNum(a), y = asNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = String(a).trimEnd(), y = String(b).trimEnd();
  return x < y ? -1 : x > y ? 1 : 0;
}

// Rekent een CL-expressie uit. getVar(naam) geeft de waarde van &NAAM.
export function evalExpr(src, getVar) {
  const toks = tokenizeExpr(String(src));
  let p = 0;
  const peek = () => toks[p];

  function primary() {
    const t = toks[p++];
    if (!t) throw new CpfError('CPD0186', 'Expression not complete.');
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'var') return getVar(t.v);
    if (t.t === '(') {
      const v = expr(0);
      if (toks[p++]?.t !== ')') throw new CpfError('CPD0015', 'Closing parenthesis missing.');
      return v;
    }
    if (t.t === 'op' && t.v === '-') return -asNum(unary());
    if (t.t === 'op' && t.v === '+') return asNum(unary());
    if (t.t === 'op' && t.v === '*NOT') return truthy(expr(3)) ? '0' : '1';
    if (t.t === 'bif') {
      if (toks[p++]?.t !== '(') throw new CpfError('CPD0186', `Built-in function ${t.v} needs parentheses.`);
      const args = [];
      while (peek() && peek().t !== ')') args.push(expr(0));
      p++;
      return bif(t.v, args);
    }
    throw new CpfError('CPD0186', 'Expression not valid.');
  }
  function unary() { return primary(); }

  function expr(min) {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || BIN[t.v] === undefined || BIN[t.v] <= min) break;
      p++;
      const right = expr(BIN[t.v]);
      left = apply(t.v, left, right);
    }
    return left;
  }

  const v = expr(0);
  if (p < toks.length) throw new CpfError('CPD0186', 'Expression not valid.');
  return v;
}

function apply(op, a, b) {
  switch (op) {
    case '+': return asNum(a) + asNum(b);
    case '-': return asNum(a) - asNum(b);
    case '*': return asNum(a) * asNum(b);
    case '/':
      if (asNum(b) === 0) throw new CpfError('MCH1211', 'Attempt made to divide by zero.');
      return asNum(a) / asNum(b);
    case '*CAT': return asStr(a) + asStr(b);
    case '*BCAT': {
      const l = asStr(a).trimEnd(), r = asStr(b).trimStart();
      return l && r ? l + ' ' + r : l + r;
    }
    case '*TCAT': return asStr(a).trimEnd() + asStr(b).trimStart();
    case '*AND': return truthy(a) && truthy(b) ? '1' : '0';
    case '*OR': return truthy(a) || truthy(b) ? '1' : '0';
    default: {
      const c = compare(a, b);
      const r = { '=': c === 0, '<>': c !== 0, '>': c > 0, '<': c < 0, '>=': c >= 0, '<=': c <= 0 }[op];
      return r ? '1' : '0';
    }
  }
}

function bif(name, args) {
  const s = (i) => asStr(args[i] ?? '');
  switch (name) {
    case '%SST':
    case '%SUBSTRING': {
      const start = asNum(args[1]), len = asNum(args[2]);
      return s(0).padEnd(start - 1 + len).substr(start - 1, len);
    }
    case '%TRIM': return s(0).trim();
    case '%TRIML': return s(0).trimStart();
    case '%TRIMR': return s(0).trimEnd();
    case '%CHAR': return asStr(args[0]).trim();
    case '%DEC': return asNum(args[0]);
    case '%UPPER': return s(0).toUpperCase();
    case '%LOWER': return s(0).toLowerCase();
    case '%LEN': return s(0).length;
    case '%SCAN': {
      const i = s(1).indexOf(s(0).trimEnd());
      return i + 1;
    }
    default: throw new CpfError('CPD0187', `Built-in function ${name} not supported.`);
  }
}

export const isTrue = truthy;
export { asStr, asNum };
