// Free-form RPG IV (ILE RPG, **FREE): ontleden, controleren en uitvoeren.
//
// Ondersteund: DCL-S, DCL-C, DCL-F (DISK met KEYED/USAGE, PRINTER), DCL-DS,
// DCL-PR (ook EXTPGM, bijv. QCMDEXC), DCL-PI, DCL-PROC, BEGSR/EXSR,
// IF/ELSEIF/ELSE, DOW, DOU, FOR, SELECT/WHEN/OTHER, LEAVE, ITER, RETURN,
// MONITOR/ON-ERROR, DSPLY, CLEAR/RESET, EVAL(H), += -= *= /=, bestands-
// opdrachten (READ, READP, READE, READPE, CHAIN, SETLL, SETGT, WRITE,
// UPDATE, DELETE, OPEN, CLOSE) en de gangbare ingebouwde functies.
//
// De uitvoering is een generator: een DSPLY met antwoord geeft
// { inquiry: tekst } terug en gaat verder met het antwoord.
import { CpfError } from './cl.js';

// Een fout tijdens het uitvoeren, met de statuscode die ON-ERROR gebruikt
function rpgErr(id, text, status = 9999) {
  const e = new CpfError(id, text);
  e.status = status;
  return e;
}

class CompileError extends Error {
  constructor(id, text, line) {
    super(text);
    this.id = id;
    this.line = line;
  }
}

// ---------- Tokens ----------

const HYPHEN_KW = /^(DCL-(?:SUBF|PROC|DS|PR|PI|S|C|F)|END-(?:DS|PR|PI|PROC)|CTL-OPT|ON-ERROR|ON-EXIT)(?![A-Za-z0-9_#@$-])/i;

// Na deze sleutelwoorden is '*' het begin van een speciale waarde (*N, *START …)
const SPEC_AFTER = new Set(['DCL-PI', 'DCL-PR', 'SETLL', 'SETGT', 'DSPLY', 'IF', 'ELSEIF', 'DOW', 'DOU', 'WHEN',
  'RETURN', 'AND', 'OR', 'NOT', 'ON-ERROR', 'CHAIN', 'DELETE', 'READE', 'READPE', 'EVAL', 'CLEAR', 'TO', 'BY', 'DOWNTO']);

export function tokenize(lines) {
  const toks = [];
  lines.forEach((raw, line) => {
    const text = typeof raw === 'string' ? raw : raw.data;
    if (line === 0 && /^\s*\*\*FREE\s*$/i.test(text)) return;
    let i = 0;
    const push = (t) => {
      t.line = line;
      t.sp = i === 0 || /\s/.test(text[i - 1] || ' ');
      toks.push(t);
    };
    while (i < text.length) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && text[i + 1] === '/') break;
      if (c === "'") {
        let v = '';
        let j = i + 1;
        for (;;) {
          if (j >= text.length) throw new CompileError('RNF0203', 'A character literal is not ended.', line);
          if (text[j] === "'") {
            if (text[j + 1] === "'") { v += "'"; j += 2; continue; }
            j++;
            break;
          }
          v += text[j++];
        }
        push({ t: 'str', v });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        const m = /^[0-9]*\.?[0-9]*/.exec(text.slice(i))[0];
        push({ t: 'num', v: Number(m), text: m });
        i += m.length;
        continue;
      }
      const hk = HYPHEN_KW.exec(text.slice(i));
      if (hk) {
        push({ t: 'id', v: hk[1].toUpperCase() });
        i += hk[1].length;
        continue;
      }
      if (/[A-Za-z_#@$]/.test(c)) {
        const m = /^[A-Za-z_#@$][A-Za-z0-9_#@$]*/.exec(text.slice(i))[0];
        push({ t: 'id', v: m.toUpperCase() });
        i += m.length;
        continue;
      }
      if (c === '%' && /[A-Za-z]/.test(text[i + 1] || '')) {
        const m = /^%[A-Za-z]+/.exec(text.slice(i))[0];
        push({ t: 'bif', v: m.toUpperCase() });
        i += m.length;
        continue;
      }
      if (c === '*' && /[A-Za-z]/.test(text[i + 1] || '')) {
        const prev = toks.at(-1);
        const operand = prev && prev.line === line && (prev.t === 'id' || prev.t === 'num' || prev.t === 'str' || (prev.t === 'op' && prev.v === ')'));
        if (!operand || (prev.t === 'id' && SPEC_AFTER.has(prev.v))) {
          const m = /^\*[A-Za-z0-9]+/.exec(text.slice(i))[0];
          push({ t: 'spec', v: m.slice(1).toUpperCase() });
          i += m.length;
          continue;
        }
      }
      const three = text.slice(i, i + 3);
      const two = text.slice(i, i + 2);
      if (three === '**=') { push({ t: 'op', v: '**=' }); i += 3; continue; }
      if (['**', '+=', '-=', '*=', '/=', '<>', '<=', '>='].includes(two)) { push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/=<>():;.'.includes(c)) { push({ t: 'op', v: c }); i++; continue; }
      throw new CompileError('RNF0201', `Character '${c}' is not valid.`, line);
    }
  });
  // In opdrachten opdelen bij ';'
  const stmts = [];
  let cur = [];
  for (const t of toks) {
    if (t.t === 'op' && t.v === ';') {
      if (cur.length) stmts.push({ toks: cur, line: cur[0].line });
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) stmts.push({ toks: cur, line: cur[0].line, unterminated: true });
  return stmts;
}

// ---------- Parser voor één opdracht ----------

class TP {
  constructor(st) {
    this.toks = st.toks;
    this.line = st.line;
    this.p = 0;
  }
  peek(o = 0) { return this.toks[this.p + o]; }
  atEnd() { return this.p >= this.toks.length; }
  isOp(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }
  isId(v, o = 0) { const t = this.peek(o); return t && t.t === 'id' && t.v === v; }
  acceptOp(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  acceptId(v) { if (this.isId(v)) { this.p++; return true; } return false; }
  err(text, id = 'RNF5347') { return new CompileError(id, text, this.line); }
  bad() {
    const t = this.peek();
    return this.err(t ? `Token ${t.t === 'str' ? "'" + t.v + "'" : (t.t === 'spec' ? '*' : '') + t.v} is not valid here.` : 'The statement is not complete.');
  }
  op(v) { if (!this.acceptOp(v)) throw this.bad(); }
  id() {
    const t = this.peek();
    if (!t || t.t !== 'id') throw this.bad();
    this.p++;
    return t.v;
  }
  end() { if (!this.atEnd()) throw this.bad(); }

  // Operatie-uitbreiding direct achter het sleutelwoord: EVAL(H), CHAIN(E)
  extender() {
    const t = this.peek(), n = this.peek(1), c = this.peek(2);
    if (t && t.t === 'op' && t.v === '(' && !t.sp && n?.t === 'id' && /^[EHNMRT]+$/.test(n.v) && c?.t === 'op' && c.v === ')') {
      this.p += 3;
      return n.v;
    }
    return '';
  }

  // Expressies: OR < AND < NOT < vergelijking < + - < * / < ** < unair
  expr() {
    let l = this.and();
    while (this.acceptId('OR')) l = { k: 'or', l, r: this.and(), line: this.line };
    return l;
  }
  and() {
    let l = this.not();
    while (this.acceptId('AND')) l = { k: 'and', l, r: this.not(), line: this.line };
    return l;
  }
  not() {
    if (this.acceptId('NOT')) return { k: 'not', e: this.not(), line: this.line };
    return this.cmp();
  }
  cmp() {
    const l = this.add();
    const t = this.peek();
    if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      this.p++;
      return { k: 'cmp', op: t.v, l, r: this.add(), line: this.line };
    }
    return l;
  }
  add() {
    let l = this.mul();
    for (;;) {
      if (this.acceptOp('+')) l = { k: 'bin', op: '+', l, r: this.mul(), line: this.line };
      else if (this.acceptOp('-')) l = { k: 'bin', op: '-', l, r: this.mul(), line: this.line };
      else return l;
    }
  }
  mul() {
    let l = this.pow();
    for (;;) {
      if (this.acceptOp('*')) l = { k: 'bin', op: '*', l, r: this.pow(), line: this.line };
      else if (this.acceptOp('/')) l = { k: 'bin', op: '/', l, r: this.pow(), line: this.line };
      else return l;
    }
  }
  pow() {
    const l = this.unary();
    if (this.acceptOp('**')) return { k: 'bin', op: '**', l, r: this.pow(), line: this.line };
    return l;
  }
  unary() {
    if (this.acceptOp('-')) return { k: 'neg', e: this.unary(), line: this.line };
    if (this.acceptOp('+')) return this.unary();
    return this.primary();
  }
  args() {
    const out = [];
    if (this.acceptOp(')')) return out;
    do out.push(this.expr()); while (this.acceptOp(':'));
    this.op(')');
    return out;
  }
  primary() {
    const t = this.peek();
    if (!t) throw this.err('An operand is expected.');
    this.p++;
    if (t.t === 'num') return { k: 'num', v: t.v, text: t.text, line: this.line };
    if (t.t === 'str') return { k: 'str', v: t.v, line: this.line };
    if (t.t === 'spec') return { k: 'spec', v: t.v, line: this.line };
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.op(')');
      return e;
    }
    if (t.t === 'bif') {
      this.op('(');
      return { k: 'bif', name: t.v, args: this.args(), line: this.line };
    }
    if (t.t === 'id') {
      let args = null;
      if (this.acceptOp('(')) args = this.args();
      let sub = null;
      if (this.acceptOp('.')) sub = this.id();
      return { k: 'ref', name: t.v, args, sub, line: this.line };
    }
    this.p--;
    throw this.bad();
  }
}

// ---------- Datatypen ----------

const DEFAULT_LEN = { int: 10, uns: 10 };

function parseType(tp) {
  const t = tp.peek();
  if (!t || t.t !== 'id') return null;
  const nums = () => {
    const out = [];
    if (tp.acceptOp('(')) {
      do {
        const n = tp.peek();
        if (n?.t === 'num') { out.push(n.v); tp.p++; } else if (n?.t === 'spec' || n?.t === 'id') { out.push(n.v); tp.p++; } else throw tp.bad();
      } while (tp.acceptOp(':'));
      tp.op(')');
    }
    return out;
  };
  switch (t.v) {
    case 'CHAR': { tp.p++; const [n] = nums(); return { type: 'char', len: n || 1 }; }
    case 'VARCHAR': { tp.p++; const [n] = nums(); return { type: 'varchar', len: n || 1 }; }
    case 'PACKED': case 'ZONED': case 'BINDEC': {
      tp.p++;
      const [p, s] = nums();
      if (!p || p > 63) throw tp.err(`The number of digits for ${t.v} is not valid.`, 'RNF3305');
      return { type: 'packed', len: p, scale: s || 0, zoned: t.v === 'ZONED' };
    }
    case 'INT': case 'UNS': {
      tp.p++;
      const [n] = nums();
      const bytes = n || DEFAULT_LEN.int;
      const digits = { 3: 3, 5: 5, 10: 10, 20: 20 }[bytes];
      if (!digits) throw tp.err(`The length ${bytes} is not valid for ${t.v}. Use 3, 5, 10 or 20.`, 'RNF3305');
      return { type: 'int', len: digits, scale: 0, uns: t.v === 'UNS' };
    }
    case 'IND': tp.p++; return { type: 'ind', len: 1 };
    case 'DATE': tp.p++; nums(); return { type: 'date', len: 10 };
    case 'TIME': tp.p++; nums(); return { type: 'char', len: 8 };
    case 'TIMESTAMP': tp.p++; nums(); return { type: 'char', len: 26 };
    case 'LIKE': {
      tp.p++;
      tp.op('(');
      const n = tp.id();
      tp.op(')');
      return { like: n };
    }
    case 'POINTER': throw tp.err('Pointers are not supported in this simulation.', 'RNF3305');
    default: return null;
  }
}

// Sleutelwoorden na een declaratie: INZ(...), DIM(n), CONST, VALUE, ...
function parseKeywords(tp) {
  const kw = {};
  while (!tp.atEnd()) {
    const t = tp.peek();
    if (t.t !== 'id') throw tp.bad();
    tp.p++;
    if (tp.isOp('(')) {
      tp.p++;
      if (t.v === 'INZ' || t.v === 'CONST' || t.v === 'EXTPGM' || t.v === 'EXTPROC') {
        kw[t.v] = tp.isOp(')') ? true : tp.expr();
        tp.op(')');
      } else if (t.v === 'USAGE') {
        const u = [];
        do {
          const s = tp.peek();
          if (s?.t !== 'spec') throw tp.bad();
          u.push(s.v);
          tp.p++;
        } while (tp.acceptOp(':'));
        tp.op(')');
        kw.USAGE = u;
      } else {
        const vals = [];
        let depth = 1;
        while (depth > 0) {
          const s = tp.peek();
          if (!s) throw tp.err('A closing parenthesis is missing.');
          tp.p++;
          if (s.t === 'op' && s.v === '(') depth++;
          else if (s.t === 'op' && s.v === ')') depth--;
          if (depth > 0) vals.push(s);
        }
        kw[t.v] = vals;
      }
    } else kw[t.v] = true;
  }
  return kw;
}

const OPCODES = new Set(['IF', 'ELSEIF', 'ELSE', 'ENDIF', 'DOW', 'DOU', 'ENDDO', 'FOR', 'ENDFOR', 'SELECT', 'WHEN',
  'OTHER', 'ENDSL', 'LEAVE', 'ITER', 'RETURN', 'DSPLY', 'READ', 'READP', 'READE', 'READPE', 'CHAIN', 'SETLL',
  'SETGT', 'WRITE', 'UPDATE', 'DELETE', 'OPEN', 'CLOSE', 'CLEAR', 'RESET', 'EVAL', 'CALLP', 'EXSR', 'BEGSR',
  'ENDSR', 'LEAVESR', 'MONITOR', 'ON-ERROR', 'ENDMON', 'EVALR']);

// ---------- Het hele programma ontleden ----------

export function compileRPG(lines, opts = {}) {
  const errors = [];
  let stmts;
  try {
    stmts = tokenize(lines);
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    return { errors: [{ line: e.line, id: e.id, text: e.message }] };
  }
  const fileInfo = opts.fileInfo || (() => null);
  const prog = {
    globals: {}, // naam → definitie
    files: {},
    procs: {},
    protos: {},
    subrs: {},
    entry: null, // parameters van het programma (DCL-PI *N)
    main: [],
  };
  let pos = 0;
  const err = (e) => errors.push({ line: e.line ?? 0, id: e.id || 'RNF5347', text: e.message });

  const declareVar = (scope, name, def, line) => {
    if (scope[name]) throw new CompileError('RNF2120', `The name ${name} is defined more than once.`, line);
    scope[name] = def;
  };

  function parseDcl(st, scope, inProc) {
    const tp = new TP(st);
    const kw = tp.id();
    switch (kw) {
      case 'CTL-OPT':
        return;
      case 'DCL-S': {
        const name = tp.id();
        const ty = parseType(tp);
        if (!ty) throw tp.err(`A data type is expected for ${name}.`, 'RNF3305');
        const k = parseKeywords(tp);
        declareVar(scope, name, { ...ty, kind: 'var', inz: k.INZ, dim: k.DIM ? Number(k.DIM[0]?.v) : 0, line: st.line }, st.line);
        return;
      }
      case 'DCL-C': {
        const name = tp.id();
        let val;
        if (tp.acceptId('CONST')) {
          tp.op('(');
          val = tp.expr();
          tp.op(')');
        } else val = tp.expr();
        tp.end();
        declareVar(scope, name, { kind: 'const', expr: val, line: st.line }, st.line);
        return;
      }
      case 'DCL-F': {
        if (inProc) throw tp.err('DCL-F inside a procedure is not supported in this simulation.', 'RNF3305');
        const name = tp.id();
        const k = parseKeywords(tp);
        const printer = !!k.PRINTER;
        const usage = new Set(k.USAGE || (printer ? ['OUTPUT'] : ['INPUT']));
        if (usage.has('UPDATE')) usage.add('INPUT');
        const f = { name, keyed: !!k.KEYED, usage, printer, line: st.line };
        if (printer) {
          f.len = k.PRINTER?.[0]?.v || 132;
        } else {
          const info = fileInfo(name);
          if (!info) throw new CompileError('RNF2120', `File ${name} is not found in the library list.`, st.line);
          if (info.src) throw new CompileError('RNF2120', `File ${name} is a source file; it cannot be used as a data file.`, st.line);
          f.fields = info.fields;
          f.keys = info.keys || [];
          if (f.keyed && !f.keys.length) throw new CompileError('RNF2109', `File ${name} has no key fields; remove KEYED or define a primary key.`, st.line);
          for (const fd of info.fields) {
            if (!prog.globals[fd.name]) prog.globals[fd.name] = { ...fieldDef(fd), kind: 'var', fileField: name, line: st.line };
          }
        }
        if (prog.files[name]) throw new CompileError('RNF2120', `File ${name} is defined more than once.`, st.line);
        prog.files[name] = f;
        return;
      }
      case 'DCL-DS': {
        const name = tp.id();
        const k = parseKeywords(tp);
        const ds = { kind: 'ds', qualified: !!k.QUALIFIED, subs: [], line: st.line };
        declareVar(scope, name, ds, st.line);
        for (;;) {
          const s = stmts[pos++];
          if (!s) throw new CompileError('RNF5182', `END-DS is missing for data structure ${name}.`, st.line);
          const sp = new TP(s);
          if (sp.acceptId('END-DS')) break;
          sp.acceptId('DCL-SUBF');
          const sub = sp.id();
          const ty = parseType(sp);
          if (!ty) throw sp.err(`A data type is expected for subfield ${sub}.`, 'RNF3305');
          const sk = parseKeywords(sp);
          ds.subs.push(sub);
          const key = ds.qualified ? `${name}.${sub}` : sub;
          declareVar(scope, key, { ...ty, kind: 'var', inz: sk.INZ, ds: name, line: s.line }, s.line);
        }
        return;
      }
      case 'DCL-PR':
      case 'DCL-PI': {
        const nameTok = tp.peek();
        let name;
        if (nameTok?.t === 'spec' && nameTok.v === 'N') { tp.p++; name = '*N'; } else name = tp.id();
        const ret = parseType(tp);
        const k = parseKeywords(tp);
        const params = [];
        const end = kw === 'DCL-PR' ? 'END-PR' : 'END-PI';
        for (;;) {
          const s = stmts[pos++];
          if (!s) throw new CompileError('RNF5182', `${end} is missing.`, st.line);
          const sp = new TP(s);
          if (sp.acceptId(end)) break;
          const pt = sp.peek();
          let pname;
          if (pt?.t === 'spec' && pt.v === 'N') { sp.p++; pname = '*N'; } else pname = sp.id();
          const ty = parseType(sp);
          if (!ty) throw sp.err(`A data type is expected for parameter ${pname}.`, 'RNF3305');
          const pk = parseKeywords(sp);
          params.push({ name: pname, ...ty, byValue: !!pk.VALUE, isConst: !!pk.CONST, line: s.line });
        }
        if (kw === 'DCL-PR') {
          let extpgm = null;
          if (k.EXTPGM) extpgm = k.EXTPGM === true ? name : k.EXTPGM.v;
          prog.protos[name] = { name, ret, params, extpgm: extpgm ? String(extpgm).toUpperCase().trim() : null, line: st.line };
        } else return { pi: true, name, ret, params };
        return;
      }
      default:
        throw tp.err(`${kw} is not a declaration.`);
    }
  }

  // Leest opdrachten tot een van de afsluiters; geeft [opdrachten, afsluiter]
  function block(enders, scope, inProc) {
    const out = [];
    while (pos < stmts.length) {
      const st = stmts[pos];
      const first = st.toks[0];
      const w = first.t === 'id' ? first.v : '';
      if (enders.includes(w)) {
        pos++;
        return [out, st];
      }
      pos++;
      try {
        const s = statement(st, scope, inProc);
        if (s) out.push(s);
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        err(e);
      }
    }
    return [out, null];
  }

  function need(st, what, start) {
    if (!st) throw new CompileError('RNF5182', `${what} is missing for the ${start.toks[0].v} on line ${start.line + 1}.`, start.line);
  }

  function statement(st, scope, inProc) {
    if (st.unterminated) throw new CompileError('RNF0257', 'A semicolon (;) is missing at the end of the statement.', st.line);
    const tp = new TP(st);
    const first = tp.peek();
    const w = first.t === 'id' ? first.v : '';
    if (['DCL-S', 'DCL-C', 'DCL-F', 'DCL-DS', 'DCL-PR', 'DCL-PI', 'CTL-OPT'].includes(w)) {
      const r = parseDcl(st, scope, inProc);
      if (r?.pi) {
        if (inProc) return { k: 'pi', ...r };
        if (prog.entry) throw new CompileError('RNF2120', 'The program interface is defined more than once.', st.line);
        prog.entry = r;
        for (const p of r.params) declareVar(prog.globals, p.name, { ...p, kind: 'var', param: true }, st.line);
      }
      return null;
    }
    if (w && !OPCODES.has(w) && !(tp.isOp('=', 1) || tp.isOp('(', 1) || tp.isOp('.', 1) || ['+=', '-=', '*=', '/=', '**='].some((o) => tp.isOp(o, 1)) || tp.toks.length === 1)) {
      throw tp.err(`${w} is not a valid operation code.`, 'RNF5347');
    }
    const line = st.line;
    if (['ENDIF', 'ENDDO', 'ENDFOR', 'ENDSL', 'ENDMON', 'ELSE', 'ELSEIF', 'WHEN', 'OTHER', 'ON-ERROR', 'ENDSR'].includes(w)) {
      throw new CompileError('RNF5182', `${w} does not match an earlier operation.`, line);
    }
    tp.p++;
    switch (w) {
      case 'IF': {
        const branches = [{ cond: tp.expr(), body: null }];
        tp.end();
        let elseBody = null;
        for (;;) {
          const [body, endSt] = block(['ELSEIF', 'ELSE', 'ENDIF'], scope, inProc);
          need(endSt, 'ENDIF', st);
          if (elseBody === 'pending') elseBody = body;
          else branches.at(-1).body = body;
          const ew = endSt.toks[0].v;
          if (ew === 'ENDIF') break;
          if (ew === 'ELSEIF') {
            const ep = new TP(endSt);
            ep.p++;
            branches.push({ cond: ep.expr(), body: null });
            ep.end();
          } else elseBody = 'pending';
        }
        return { k: 'if', branches, elseBody: elseBody === 'pending' ? [] : elseBody, line };
      }
      case 'DOW':
      case 'DOU': {
        const cond = tp.expr();
        tp.end();
        const [body, endSt] = block(['ENDDO'], scope, inProc);
        need(endSt, 'ENDDO', st);
        return { k: w === 'DOW' ? 'dow' : 'dou', cond, body, line };
      }
      case 'FOR': {
        const v = tp.primary();
        tp.op('=');
        const from = tp.expr();
        let to = null, by = null, down = false;
        if (tp.acceptId('TO')) to = tp.expr();
        else if (tp.acceptId('DOWNTO')) { to = tp.expr(); down = true; }
        if (tp.acceptId('BY')) by = tp.expr();
        if (tp.acceptId('TO')) to = tp.expr();
        else if (tp.acceptId('DOWNTO')) { to = tp.expr(); down = true; }
        tp.end();
        const [body, endSt] = block(['ENDFOR'], scope, inProc);
        need(endSt, 'ENDFOR', st);
        return { k: 'for', v, from, to, by, down, body, line };
      }
      case 'SELECT': {
        tp.end();
        const whens = [];
        let other = null;
        // Eerst een WHEN of OTHER
        const firstSt = stmts[pos];
        if (!firstSt || !['WHEN', 'OTHER', 'ENDSL'].includes(firstSt.toks[0].v)) {
          throw new CompileError('RNF5347', 'WHEN or OTHER is expected after SELECT.', line);
        }
        pos++;
        let cur = firstSt;
        for (;;) {
          const cw = cur.toks[0].v;
          if (cw === 'ENDSL') break;
          const cp = new TP(cur);
          cp.p++;
          const cond = cw === 'WHEN' ? cp.expr() : null;
          cp.end();
          const [body, endSt] = block(['WHEN', 'OTHER', 'ENDSL'], scope, inProc);
          need(endSt, 'ENDSL', st);
          if (cw === 'WHEN') whens.push({ cond, body });
          else other = body;
          cur = endSt;
        }
        return { k: 'select', whens, other, line };
      }
      case 'MONITOR': {
        tp.end();
        const [body, e1] = block(['ON-ERROR', 'ENDMON'], scope, inProc);
        need(e1, 'ENDMON', st);
        const handlers = [];
        let cur = e1;
        while (cur.toks[0].v === 'ON-ERROR') {
          const cp = new TP(cur);
          cp.p++;
          const codes = [];
          while (!cp.atEnd()) {
            const t = cp.peek();
            cp.p++;
            if (t.t === 'num') codes.push(t.v);
            else if (t.t === 'spec') codes.push('*' + t.v);
            else if (!(t.t === 'op' && t.v === ':')) throw cp.bad();
          }
          const [hb, next] = block(['ON-ERROR', 'ENDMON'], scope, inProc);
          need(next, 'ENDMON', st);
          handlers.push({ codes, body: hb });
          cur = next;
        }
        return { k: 'monitor', body, handlers, line };
      }
      case 'BEGSR': {
        if (inProc) throw new CompileError('RNF3305', 'Subroutines inside procedures are not supported in this simulation.', line);
        const name = tp.id();
        tp.end();
        const [body, endSt] = block(['ENDSR'], scope, inProc);
        need(endSt, 'ENDSR', st);
        if (prog.subrs[name]) throw new CompileError('RNF2120', `Subroutine ${name} is defined more than once.`, line);
        prog.subrs[name] = body;
        return null;
      }
      case 'LEAVE': case 'ITER': case 'LEAVESR':
        tp.end();
        return { k: w.toLowerCase(), line };
      case 'RETURN': {
        const e = tp.atEnd() ? null : tp.expr();
        tp.end();
        return { k: 'return', e, line };
      }
      case 'EXSR': {
        const name = tp.id();
        tp.end();
        return { k: 'exsr', name, line };
      }
      case 'DSPLY': {
        tp.extender();
        const ops = [];
        while (!tp.atEnd()) ops.push(tp.unary());
        return { k: 'dsply', msg: ops[0] || { k: 'str', v: '' }, resp: ops[2] || null, line };
      }
      case 'CLEAR': case 'RESET': {
        const target = tp.primary();
        tp.end();
        return { k: 'clear', target, line };
      }
      case 'READ': case 'READP': case 'CHAIN': case 'READE': case 'READPE': case 'SETLL': case 'SETGT':
      case 'WRITE': case 'UPDATE': case 'DELETE': case 'OPEN': case 'CLOSE': {
        tp.extender();
        let key = null;
        if (['CHAIN', 'READE', 'READPE', 'SETLL', 'SETGT', 'DELETE'].includes(w) && tp.toks.length - tp.p >= 2) {
          if (tp.peek().t === 'spec') {
            key = { special: tp.peek().v };
            tp.p++;
          } else if (tp.isOp('(')) {
            tp.p++;
            key = [];
            do key.push(tp.expr()); while (tp.acceptOp(':'));
            tp.op(')');
          } else key = [tp.unary()];
        }
        const file = tp.id();
        let data = null;
        if (!tp.atEnd() && (w === 'WRITE' || w === 'UPDATE')) data = tp.primary();
        tp.end();
        return { k: 'fileop', op: w, file, key, data, line };
      }
      case 'CALLP': {
        tp.extender();
        const c = tp.primary();
        tp.end();
        if (c.k !== 'ref') throw tp.err('A procedure call is expected after CALLP.');
        return { k: 'call', call: c, line };
      }
      case 'EVAL': case 'EVALR': {
        const ext = tp.extender();
        return assign(tp, ext.includes('H'), w === 'EVALR');
      }
      default: {
        tp.p = 0;
        return assign(tp, false, false);
      }
    }
  }

  function assign(tp, half, right) {
    const target = tp.primary();
    if (tp.atEnd()) {
      if (target.k === 'ref') return { k: 'call', call: target, line: tp.line };
      throw tp.err('An assignment is expected.');
    }
    const t = tp.peek();
    if (t.t !== 'op' || !['=', '+=', '-=', '*=', '/=', '**='].includes(t.v)) throw tp.err('An assignment operator (=) is expected.');
    tp.p++;
    const e = tp.expr();
    tp.end();
    if (!(target.k === 'ref' || (target.k === 'spec' && target.v === 'INLR') || (target.k === 'bif' && target.name === '%SUBST'))) {
      throw tp.err('The target of the assignment is not valid.');
    }
    return { k: 'assign', target, op: t.v, e, half, right, line: tp.line };
  }

  // Hoofdniveau: declaraties, hoofdcode, subroutines en procedures
  while (pos < stmts.length) {
    const st = stmts[pos];
    const w = st.toks[0].t === 'id' ? st.toks[0].v : '';
    if (w === 'DCL-PROC') {
      pos++;
      try {
        const tp = new TP(st);
        tp.p++;
        const name = tp.id();
        const proc = { name, locals: {}, pi: null, body: [], line: st.line };
        if (prog.procs[name]) throw new CompileError('RNF2120', `Procedure ${name} is defined more than once.`, st.line);
        prog.procs[name] = proc;
        const [body, endSt] = block(['END-PROC'], proc.locals, true);
        need(endSt, 'END-PROC', st);
        for (const s of body) {
          if (s.k === 'pi') {
            proc.pi = s;
            for (const p of s.params) declareVar(proc.locals, p.name, { ...p, kind: 'var', param: true }, s.line);
          } else proc.body.push(s);
        }
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        err(e);
      }
      continue;
    }
    if (['ENDIF', 'ENDDO', 'ENDFOR', 'ENDSL', 'ENDMON', 'ELSE', 'ELSEIF', 'WHEN', 'OTHER', 'ON-ERROR', 'ENDSR', 'END-PROC'].includes(w)) {
      pos++;
      err(new CompileError('RNF5182', `${w} does not match an earlier operation.`, st.line));
      continue;
    }
    const [body] = block(['DCL-PROC'], prog.globals, false);
    prog.main.push(...body);
    if (pos < stmts.length && stmts[pos - 1]?.toks[0].v === 'DCL-PROC') pos--;
  }

  // LIKE(...) oplossen
  const resolveLike = (scope) => {
    for (const [n, d] of Object.entries(scope)) {
      if (d.like) {
        const src = scope[d.like] || prog.globals[d.like];
        if (!src || src.like) { errors.push({ line: d.line ?? 0, id: 'RNF7030', text: `The name ${d.like} in LIKE for ${n} is not defined.` }); continue; }
        const { like, ...rest } = d;
        scope[n] = { ...src, ...rest, kind: 'var', type: src.type, len: src.len, scale: src.scale };
      }
    }
  };
  resolveLike(prog.globals);
  for (const p of Object.values(prog.procs)) resolveLike(p.locals);

  check(prog, errors);
  errors.sort((a, b) => a.line - b.line);
  return { prog, errors };
}

function fieldDef(fd) {
  switch (fd.type) {
    case 'CHAR': return { type: 'char', len: fd.len };
    case 'VARCHAR': return { type: 'varchar', len: fd.len };
    case 'DECIMAL': return { type: 'packed', len: fd.len, scale: fd.scale || 0 };
    case 'INTEGER': return { type: 'int', len: fd.len <= 5 ? 5 : fd.len <= 10 ? 10 : 20, scale: 0 };
    case 'DATE': return { type: 'date', len: 10 };
    default: return { type: 'char', len: fd.len || 26 };
  }
}

// ---------- Controle bij het compileren ----------

const BIFS = new Set(['%TRIM', '%TRIML', '%TRIMR', '%SUBST', '%LEN', '%CHAR', '%DEC', '%DECH', '%INT', '%INTH',
  '%ABS', '%REM', '%DIV', '%SCAN', '%SCANRPL', '%XLATE', '%UPPER', '%LOWER', '%EOF', '%FOUND', '%ELEM', '%SIZE',
  '%EDITC', '%DATE', '%TIMESTAMP', '%MAX', '%MIN', '%PARMS', '%REPLACE', '%CHECK']);
const FILE_BIFS = new Set(['%EOF', '%FOUND']);

function check(prog, errors) {
  const add = (line, id, text) => errors.push({ line, id, text });
  const known = (name, scope) => !!(scope?.[name] || prog.globals[name] || prog.procs[name] || prog.protos[name] || prog.files[name]);

  function expr(e, scope) {
    if (!e || typeof e !== 'object') return;
    switch (e.k) {
      case 'ref': {
        const key = e.sub ? `${e.name}.${e.sub}` : e.name;
        if (!known(key, scope) && !known(e.name, scope)) add(e.line, 'RNF7030', `The name or indicator ${key} is not defined.`);
        for (const a of e.args || []) expr(a, scope);
        return;
      }
      case 'bif':
        if (!BIFS.has(e.name)) add(e.line, 'RNF7020', `The built-in function ${e.name} is not supported in this simulation.`);
        if (FILE_BIFS.has(e.name)) {
          const a = e.args[0];
          if (a && (a.k !== 'ref' || !prog.files[a.name])) add(e.line, 'RNF7030', `${e.name} needs a file name.`);
          return;
        }
        if (e.name === '%ELEM' || e.name === '%SIZE') return;
        for (const a of e.args) expr(a, scope);
        return;
      case 'spec':
        if (!['ON', 'OFF', 'BLANK', 'BLANKS', 'ZERO', 'ZEROS', 'HIVAL', 'LOVAL', 'INLR', 'NULL', 'OMIT', 'START', 'END', 'ISO'].includes(e.v)) {
          add(e.line, 'RNF0637', `The special value *${e.v} is not valid.`);
        }
        return;
      default:
        for (const v of Object.values(e)) {
          if (Array.isArray(v)) v.forEach((x) => expr(x, scope));
          else if (v && typeof v === 'object' && v.k) expr(v, scope);
        }
    }
  }

  function stmts(list, scope) {
    for (const s of list) {
      switch (s.k) {
        case 'if':
          for (const b of s.branches) { expr(b.cond, scope); stmts(b.body, scope); }
          stmts(s.elseBody || [], scope);
          break;
        case 'dow': case 'dou': expr(s.cond, scope); stmts(s.body, scope); break;
        case 'for': expr(s.v, scope); expr(s.from, scope); expr(s.to, scope); expr(s.by, scope); stmts(s.body, scope); break;
        case 'select':
          for (const w of s.whens) { expr(w.cond, scope); stmts(w.body, scope); }
          stmts(s.other || [], scope);
          break;
        case 'monitor':
          stmts(s.body, scope);
          for (const h of s.handlers) stmts(h.body, scope);
          break;
        case 'exsr':
          if (!prog.subrs[s.name]) add(s.line, 'RNF7030', `Subroutine ${s.name} is not defined.`);
          if (scope) add(s.line, 'RNF3305', 'EXSR inside a procedure is not supported in this simulation.');
          break;
        case 'fileop': {
          const f = prog.files[s.file];
          if (!f) { add(s.line, 'RNF7030', `File ${s.file} is not defined.`); break; }
          const needs = { WRITE: 'OUTPUT', UPDATE: 'UPDATE', DELETE: 'DELETE', READ: 'INPUT', READP: 'INPUT', READE: 'INPUT', READPE: 'INPUT', CHAIN: 'INPUT', SETLL: 'INPUT', SETGT: 'INPUT' }[s.op];
          if (f.printer && s.op !== 'WRITE' && s.op !== 'OPEN' && s.op !== 'CLOSE') add(s.line, 'RNF7086', `Operation ${s.op} is not valid for printer file ${s.file}.`);
          else if (needs && !f.printer && !f.usage.has(needs)) add(s.line, 'RNF7086', `Operation ${s.op} needs USAGE(*${needs}) on file ${s.file}.`);
          if (['CHAIN', 'READE', 'READPE'].includes(s.op) && !f.keyed) add(s.line, 'RNF7086', `Operation ${s.op} needs a KEYED file; add KEYED to DCL-F ${s.file}.`);
          if (Array.isArray(s.key)) {
            if (!f.keyed) add(s.line, 'RNF7086', `A key is not allowed for ${s.op} on a file without KEYED.`);
            else if (s.key.length > f.keys.length) add(s.line, 'RNF7086', `Too many key values for file ${s.file} (${f.keys.length} key field(s)).`);
            s.key.forEach((k) => expr(k, scope));
          }
          if (s.data) expr(s.data, scope);
          if (f.printer && s.op === 'WRITE' && !s.data) add(s.line, 'RNF7086', `WRITE to printer file ${s.file} needs a field with the line to print.`);
          break;
        }
        default:
          for (const v of Object.values(s)) {
            if (v && typeof v === 'object' && v.k) expr(v, scope);
          }
      }
    }
  }

  stmts(prog.main, null);
  for (const b of Object.values(prog.subrs)) stmts(b, null);
  for (const p of Object.values(prog.procs)) stmts(p.body, p.locals);
}

// ---------- Uitvoeren ----------

class Signal {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }
}

const isNum = (v) => typeof v === 'number';
const isNumType = (d) => d && (d.type === 'packed' || d.type === 'int');

function round10(v) {
  return Math.round(v * 1e9) / 1e9;
}

export function numToChar(v, scale) {
  if (scale === undefined || scale === null) {
    const r = round10(v);
    let s = String(Math.abs(r));
    if (s.startsWith('0.')) s = s.slice(1);
    return (r < 0 ? '-' : '') + s;
  }
  let s = Math.abs(v).toFixed(scale);
  if (scale > 0 && s.startsWith('0.')) s = s.slice(1);
  return (v < 0 && Number(s) !== 0 ? '-' : '') + s;
}

function editc(v, code, len, scale) {
  code = String(code).toUpperCase();
  const neg = v < 0;
  const abs = Math.abs(v);
  if (code === 'X') return Math.round(abs * 10 ** scale).toString().padStart(len, '0').slice(-len);
  const commas = '12ABJKNO'.includes(code);
  const blankZero = '24BDKM'.includes(code);
  const intDigits = len - scale;
  let [ip, fp] = abs.toFixed(scale).split('.');
  if (ip === '0' && scale > 0) ip = '';
  if (commas) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let s = scale > 0 ? `${ip}.${fp}` : ip || '0';
  if (code === 'Z') s = Math.trunc(abs) ? String(Math.trunc(abs)) : '';
  if (abs === 0 && blankZero) s = '';
  let sign = '';
  if ('JKLM'.includes(code)) sign = neg ? '-' : ' ';
  else if ('ABCD'.includes(code)) sign = neg ? 'CR' : '  ';
  const width = intDigits + (commas ? Math.floor((intDigits - 1) / 3) : 0) + (scale > 0 ? scale + 1 : 0);
  return s.padStart(width) + sign;
}

export function* runRPG(prog, args, env) {
  const name = env.name || 'PGM';
  const globals = new Map();
  const files = {};
  const pending = []; // DSPLY-regels die nog getoond moeten worden
  let lastFile = null;
  let steps = 0;
  let inlr = '0';

  const fail = (id, text, status, line) => {
    const e = rpgErr(id, text, status);
    e.line = line;
    return e;
  };

  // ----- Waarden -----

  const dft = (d) => {
    switch (d.type) {
      case 'char': return ''.padEnd(d.len);
      case 'varchar': return '';
      case 'ind': return '0';
      case 'date': return '0001-01-01';
      default: return 0;
    }
  };

  function coerce(d, v, half, line, name2 = '') {
    if (v && typeof v === 'object' && (v.hival || v.loval)) {
      if (isNumType(d)) return (v.hival ? 1 : -1) * (10 ** (d.len - (d.scale || 0)) - 10 ** -(d.scale || 0));
      if (d.type === 'char') return (v.hival ? '￿' : '\u0000').repeat(d.len);
      return v.hival ? '￿' : '';
    }
    switch (d.type) {
      case 'char':
      case 'varchar': {
        if (isNum(v)) throw fail('RNX0100', `A numeric value cannot be assigned to character field ${name2}. Use %CHAR.`, 100, line);
        if (typeof v === 'boolean') v = v ? '1' : '0';
        const s = String(v);
        if (d.type === 'varchar') return s.slice(0, d.len);
        return s.slice(0, d.len).padEnd(d.len);
      }
      case 'ind':
        if (typeof v === 'boolean') return v ? '1' : '0';
        if (v === '1' || v === '0') return v;
        if (isNum(v)) return v ? '1' : '0';
        return String(v).trim() === '1' ? '1' : '0';
      case 'date': {
        const s = String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fail('RNX0112', `Date value '${s}' is not valid for ${name2}.`, 112, line);
        return s;
      }
      default: {
        if (typeof v === 'boolean') v = v ? 1 : 0;
        if (!isNum(v)) {
          if (typeof v === 'string' && v.trim() === '' && v.length === 0) return 0;
          throw fail('RNX0100', `A character value cannot be assigned to numeric field ${name2}. Use %DEC or %INT.`, 100, line);
        }
        const scale = d.scale || 0;
        const f = 10 ** scale;
        let n = half ? Math.round(round10(v * f)) / f : Math.trunc(round10(v * f)) / f;
        if (d.type === 'int') {
          n = half ? Math.round(v) : Math.trunc(round10(v));
          const lim = { 3: 128, 5: 32768, 10: 2147483648, 20: 9223372036854775808 }[d.len] || 2147483648;
          if (d.uns ? n < 0 || n >= lim * 2 : n < -lim || n >= lim) throw fail('RNX0103', `The target for a numeric operation is too small to hold the result (${name2}).`, 103, line);
          return n;
        }
        if (Math.abs(n) >= 10 ** (d.len - scale)) throw fail('RNX0103', `The target for a numeric operation is too small to hold the result (${name2}).`, 103, line);
        return n === 0 ? 0 : n;
      }
    }
  }

  function makeVar(d, frameLookup) {
    const v = { d, val: null };
    const init = () => {
      if (d.inz !== undefined && d.inz !== true) return coerce(d, evalConst(d.inz, frameLookup), false, d.line, '');
      return dft(d);
    };
    if (d.dim) v.val = Array.from({ length: d.dim }, init);
    else v.val = init();
    return v;
  }

  // Eenvoudige expressies voor INZ en DCL-C (geen procedures)
  function evalConst(e, lookup) {
    const g = ev(e, { lookup });
    const r = g.next();
    if (!r.done) throw fail('RNX0100', 'Initial value is not a constant.', 100, e.line);
    return r.value;
  }

  // ----- Variabelen opzoeken -----

  const consts = {};
  function globalLookup(n) {
    if (globals.has(n)) return globals.get(n);
    if (n in consts) return { d: { kind: 'const' }, val: consts[n] };
    return null;
  }

  for (const [n, d] of Object.entries(prog.globals)) {
    if (d.kind === 'const') consts[n] = evalConst(d.expr, globalLookup);
  }
  for (const [n, d] of Object.entries(prog.globals)) {
    if (d.kind === 'var') globals.set(n, makeVar(d, globalLookup));
    else if (d.kind === 'ds') globals.set(n, { d, val: null });
  }

  function dsValue(dsName, scope) {
    const ds = scope(dsName).d;
    return ds.subs.map((s) => {
      const v = scope(ds.qualified ? `${dsName}.${s}` : s);
      if (isNumType(v.d)) return Math.round(Math.abs(v.val) * 10 ** (v.d.scale || 0)).toString().padStart(v.d.len, '0');
      return v.d.type === 'varchar' ? v.val.padEnd(v.d.len) : String(v.val);
    }).join('');
  }

  // ----- Bestanden openen -----

  for (const f of Object.values(prog.files)) {
    const st = { def: f, eof: false, found: false, curRow: null, pos: 0, positioned: true, lines: [], open: true };
    if (!f.printer) {
      const r = env.openFile(f.name);
      if (!r) throw rpgErr('RNX1216', `Error opening file ${f.name}: file not found in the library list.`, 1216);
      st.obj = r.obj;
      st.lib = r.lib;
      st.keyIdx = (f.keys || []).map((k) => r.obj.fields.findIndex((fd) => fd.name === k));
    }
    files[f.name] = st;
  }

  const cmpKeyVal = (a, b) => {
    if (a === null || a === undefined) a = '';
    if (b === null || b === undefined) b = '';
    if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
    const x = String(a).trimEnd(), y = String(b).trimEnd();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const rowKey = (st, row) => st.keyIdx.map((i) => row[i]);
  const cmpKey = (k1, k2) => {
    for (let i = 0; i < Math.min(k1.length, k2.length); i++) {
      const c = cmpKeyVal(k1[i], k2[i]);
      if (c) return c;
    }
    return 0;
  };
  const list = (st) => {
    if (!st.def.keyed) return st.obj.rows;
    return st.obj.rows.map((r, i) => ({ r, i })).sort((a, b) => cmpKey(rowKey(st, a.r), rowKey(st, b.r)) || a.i - b.i).map((x) => x.r);
  };

  function loadRow(st, row) {
    st.obj.fields.forEach((fd, i) => {
      const v = globals.get(fd.name);
      if (!v) return;
      const val = row[i];
      v.val = val === null || val === undefined ? dft(v.d) : coerce(v.d, val, false, 0, fd.name);
    });
  }

  function buildRow(st, line) {
    return st.obj.fields.map((fd) => {
      const v = globals.get(fd.name);
      const val = v ? v.val : null;
      if (fd.type === 'CHAR') return String(val ?? '').trimEnd();
      if (fd.type === 'DECIMAL' || fd.type === 'INTEGER') {
        if (Math.abs(val) >= 10 ** (fd.len - (fd.scale || 0))) throw fail('RNX1022', `Value for field ${fd.name} does not fit in the file field.`, 1022, line);
        return val;
      }
      return val;
    });
  }

  function* fileop(s, scope) {
    const st = files[s.file];
    lastFile = st;
    let key = null;
    if (Array.isArray(s.key)) {
      key = [];
      for (const k of s.key) key.push(yield* ev(k, scope));
    }
    const L = st.def.printer ? null : list(st);
    const nextIndex = () => (st.positioned ? st.pos : (st.curRow ? L.indexOf(st.curRow) + 1 : st.pos));
    switch (s.op) {
      case 'OPEN': st.open = true; return;
      case 'CLOSE':
        if (st.def.printer) flushPrinter(st);
        st.open = false;
        return;
      case 'SETLL':
      case 'SETGT': {
        if (s.key?.special) {
          const sp = s.key.special;
          st.pos = (sp === 'START' || sp === 'LOVAL') ? 0 : L.length;
        } else {
          const gt = s.op === 'SETGT';
          let i = 0;
          while (i < L.length && (gt ? cmpKey(rowKey(st, L[i]), key) <= 0 : cmpKey(rowKey(st, L[i]), key) < 0)) i++;
          st.pos = i;
          st.found = i < L.length && cmpKey(rowKey(st, L[i]), key) === 0;
        }
        st.positioned = true;
        st.eof = false;
        st.curRow = null;
        return;
      }
      case 'READ':
      case 'READE': {
        const i = nextIndex();
        const row = L[i];
        if (!row || (s.op === 'READE' && key && cmpKey(rowKey(st, row), key) !== 0)) {
          st.eof = true;
          st.curRow = null;
          st.pos = L.length;
          st.positioned = true;
          return;
        }
        st.eof = false;
        st.curRow = row;
        st.positioned = false;
        loadRow(st, row);
        return;
      }
      case 'READP':
      case 'READPE': {
        const i = (st.positioned ? st.pos : (st.curRow ? L.indexOf(st.curRow) : st.pos)) - 1;
        const row = i >= 0 ? L[i] : null;
        if (!row || (s.op === 'READPE' && key && cmpKey(rowKey(st, row), key) !== 0)) {
          st.eof = true;
          st.curRow = null;
          st.pos = 0;
          st.positioned = true;
          return;
        }
        st.eof = false;
        st.curRow = row;
        st.positioned = false;
        loadRow(st, row);
        return;
      }
      case 'CHAIN': {
        const row = L.find((r) => cmpKey(rowKey(st, r), key) === 0);
        st.found = !!row;
        if (row) {
          st.curRow = row;
          st.positioned = false;
          st.eof = false;
          loadRow(st, row);
        } else st.curRow = null;
        return;
      }
      case 'WRITE': {
        if (st.def.printer) {
          const v = yield* ev(s.data, scope);
          st.lines.push(String(isNum(v) ? numToChar(v) : v).slice(0, st.def.len).trimEnd());
          return;
        }
        const row = buildRow(st, s.line);
        if (st.def.keys?.length && st.keyIdx.every((i) => i >= 0)) {
          const k = rowKey(st, row);
          if (st.obj.rows.some((r) => cmpKey(rowKey(st, r), k) === 0)) {
            throw fail('RNX1021', `Duplicate key on WRITE to file ${s.file}.`, 1021, s.line);
          }
        }
        st.obj.rows.push(row);
        env.changed?.();
        return;
      }
      case 'UPDATE': {
        if (!st.curRow || !st.obj.rows.includes(st.curRow)) throw fail('RNX1221', `UPDATE on file ${s.file} without a prior successful READ or CHAIN.`, 1221, s.line);
        const row = buildRow(st, s.line);
        row.forEach((v, i) => { st.curRow[i] = v; });
        env.changed?.();
        return;
      }
      case 'DELETE': {
        let row = st.curRow;
        if (key) {
          row = L.find((r) => cmpKey(rowKey(st, r), key) === 0);
          st.found = !!row;
          if (!row) return;
        }
        if (!row || !st.obj.rows.includes(row)) throw fail('RNX1221', `DELETE on file ${s.file} without a prior successful READ or CHAIN.`, 1221, s.line);
        const idx = L.indexOf(row);
        st.obj.rows.splice(st.obj.rows.indexOf(row), 1);
        st.curRow = null;
        st.pos = idx;
        st.positioned = true;
        env.changed?.();
      }
    }
  }

  function flushPrinter(st) {
    if (st.lines.length) env.spool(st.def.name, st.lines.splice(0), name);
  }

  // ----- Expressies -----

  function resolve(scope, n) {
    const v = scope.lookup(n);
    if (!v) throw fail('RNX0100', `The name ${n} is not defined.`, 100, 0);
    return v;
  }

  function refVar(scope, e) {
    const key = e.sub ? `${e.name}.${e.sub}` : e.name;
    return scope.lookup(key);
  }

  function* indexOf(scope, e, v) {
    const i = yield* ev(e.args[0], scope);
    if (!isNum(i) || i < 1 || i > v.d.dim || Math.trunc(i) !== i) {
      throw fail('RNX0121', `Array index ${i} is not valid for ${e.name} (1 to ${v.d.dim}).`, 121, e.line);
    }
    return i - 1;
  }

  function* ev(e, scope) {
    if (++steps > 2000000) throw fail('RNX9999', 'Program ended: too many operations (endless loop?).', 9999, e.line);
    switch (e.k) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 'spec':
        switch (e.v) {
          case 'ON': return '1';
          case 'OFF': return '0';
          case 'BLANK': case 'BLANKS': return '';
          case 'ZERO': case 'ZEROS': return 0;
          case 'HIVAL': return { hival: true };
          case 'LOVAL': return { loval: true };
          case 'INLR': return inlr;
          default: throw fail('RNX0100', `Special value *${e.v} not valid here.`, 100, e.line);
        }
      case 'ref': {
        const v = refVar(scope, e);
        if (v && v.d.kind !== 'ds') {
          if (v.d.dim) {
            if (!e.args) return v.val.slice();
            return v.val[yield* indexOf(scope, e, v)];
          }
          if (e.args) throw fail('RNX0100', `${e.name} is not an array or procedure.`, 100, e.line);
          return v.val;
        }
        if (v && v.d.kind === 'ds') return dsValue(e.name, scope.lookup);
        return yield* callNamed(e, scope);
      }
      case 'neg': {
        const v = yield* ev(e.e, scope);
        if (!isNum(v)) throw fail('RNX0100', 'Minus sign used with a character value.', 100, e.line);
        return -v;
      }
      case 'not': return !truthy(yield* ev(e.e, scope));
      case 'and': return truthy(yield* ev(e.l, scope)) && truthy(yield* ev(e.r, scope));
      case 'or': return truthy(yield* ev(e.l, scope)) || truthy(yield* ev(e.r, scope));
      case 'cmp': {
        const a = yield* ev(e.l, scope), b = yield* ev(e.r, scope);
        const c = compare(a, b, e.line);
        return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[e.op];
      }
      case 'bin': {
        const a = yield* ev(e.l, scope), b = yield* ev(e.r, scope);
        if (e.op === '+' && !isNum(a) && !isNum(b)) return String(a) + String(b);
        if (!isNum(a) || !isNum(b)) {
          throw fail('RNX0100', `Operands of ${e.op} are not compatible (character and numeric). Use %CHAR or %DEC.`, 100, e.line);
        }
        switch (e.op) {
          case '+': return round10(a + b);
          case '-': return round10(a - b);
          case '*': return round10(a * b);
          case '/':
            if (b === 0) throw fail('RNX0102', 'Attempt to divide by zero.', 102, e.line);
            return a / b;
          default: return a ** b;
        }
      }
      case 'bif': return yield* bif(e, scope);
    }
    throw fail('RNX0100', 'Expression not valid.', 100, e.line);
  }

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (v === '1') return true;
    if (v === '0') return false;
    if (isNum(v)) return v !== 0;
    return String(v).trim() === '1';
  }

  function compare(a, b, line) {
    if (a && typeof a === 'object') return a.hival ? 1 : -1;
    if (b && typeof b === 'object') return b.hival ? -1 : 1;
    if (typeof a === 'boolean') a = a ? '1' : '0';
    if (typeof b === 'boolean') b = b ? '1' : '0';
    if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
    if (isNum(a) !== isNum(b)) {
      if (a === '' || b === '') return isNum(a) ? (a === 0 ? 0 : 1) : (b === 0 ? 0 : -1);
      throw fail('RNX0100', 'Comparison of a character and a numeric value is not allowed.', 100, line);
    }
    const x = String(a).trimEnd(), y = String(b).trimEnd();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // Schaal (aantal decimalen) van een expressie, als die bekend is
  function scaleOf(e, scope) {
    if (e.k === 'ref') {
      const v = refVar(scope, e);
      if (v && isNumType(v.d)) return { scale: v.d.scale || 0, len: v.d.len };
    }
    if (e.k === 'bif' && (e.name === '%DEC' || e.name === '%DECH') && e.args.length === 3) {
      return { scale: e.args[2].v, len: e.args[1].v };
    }
    return null;
  }

  function* bif(e, scope) {
    const a = [];
    const lazy = new Set(['%EOF', '%FOUND', '%ELEM', '%SIZE', '%PARMS']);
    if (!lazy.has(e.name)) for (const x of e.args) a.push(yield* ev(x, scope));
    const s = (i) => {
      const v = a[i];
      if (isNum(v)) throw fail('RNX0100', `${e.name} needs a character value.`, 100, e.line);
      return typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? '');
    };
    const n = (i) => {
      if (!isNum(a[i])) throw fail('RNX0100', `${e.name} needs a numeric value.`, 100, e.line);
      return a[i];
    };
    switch (e.name) {
      case '%TRIM': return a.length > 1 ? trimChars(s(0), s(1), true, true) : s(0).trim();
      case '%TRIML': return a.length > 1 ? trimChars(s(0), s(1), true, false) : s(0).trimStart();
      case '%TRIMR': return a.length > 1 ? trimChars(s(0), s(1), false, true) : s(0).trimEnd();
      case '%SUBST': {
        const str = s(0), start = n(1);
        const len = a.length > 2 ? n(2) : str.length - start + 1;
        if (start < 1 || len < 0 || start - 1 + len > str.length) throw fail('RNX0100', `Length or start position is out of range for %SUBST (start ${start}, length ${len}, string length ${str.length}).`, 100, e.line);
        return str.substr(start - 1, len);
      }
      case '%LEN': {
        const x = e.args[0];
        if (isNum(a[0])) { const sc = scaleOf(x, scope); return sc ? sc.len : String(Math.trunc(Math.abs(a[0]))).length; }
        return s(0).length;
      }
      case '%CHAR': {
        const v = a[0];
        if (isNum(v)) { const sc = scaleOf(e.args[0], scope); return numToChar(v, sc ? sc.scale : undefined); }
        if (typeof v === 'boolean') return v ? '1' : '0';
        return String(v);
      }
      case '%DEC':
      case '%DECH':
      case '%INT':
      case '%INTH': {
        let v = a[0];
        if (!isNum(v)) {
          const t = String(v).trim().replace(',', '.');
          if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) throw fail('RNX0105', `A character representation of a numeric value is in error: '${String(v).trim()}'.`, 105, e.line);
          v = Number(t);
        }
        const half = e.name.endsWith('H');
        if (e.name.startsWith('%INT')) return half ? Math.round(v) : Math.trunc(v);
        if (a.length >= 3) return coerce({ type: 'packed', len: n(1), scale: n(2) }, v, half, e.line, e.name);
        return half ? Math.round(v) : v;
      }
      case '%ABS': return Math.abs(n(0));
      case '%REM': if (n(1) === 0) throw fail('RNX0102', 'Attempt to divide by zero.', 102, e.line); return Math.trunc(n(0)) % Math.trunc(n(1));
      case '%DIV': if (n(1) === 0) throw fail('RNX0102', 'Attempt to divide by zero.', 102, e.line); return Math.trunc(Math.trunc(n(0)) / Math.trunc(n(1)));
      case '%SCAN': {
        const start = a.length > 2 ? n(2) : 1;
        const i = s(1).indexOf(s(0), start - 1);
        return i + 1;
      }
      case '%SCANRPL': return s(2).split(s(0)).join(s(1));
      case '%REPLACE': {
        const repl = s(0), src = s(1);
        const start = a.length > 2 ? n(2) : 1;
        const len = a.length > 3 ? n(3) : repl.length;
        return src.slice(0, start - 1) + repl + src.slice(start - 1 + len);
      }
      case '%XLATE': {
        const from = s(0), to = s(1);
        return [...s(2)].map((c) => { const i = from.indexOf(c); return i >= 0 && i < to.length ? to[i] : c; }).join('');
      }
      case '%CHECK': {
        const ok = s(0), str = s(1);
        for (let i = (a.length > 2 ? n(2) : 1) - 1; i < str.length; i++) if (!ok.includes(str[i])) return i + 1;
        return 0;
      }
      case '%UPPER': return s(0).toUpperCase();
      case '%LOWER': return s(0).toLowerCase();
      case '%EOF':
      case '%FOUND': {
        const st = e.args.length ? files[e.args[0].name] : lastFile;
        if (!st) return false;
        return e.name === '%EOF' ? st.eof : st.found;
      }
      case '%ELEM': {
        const v = refVar(scope, e.args[0]);
        return v?.d.dim || 0;
      }
      case '%SIZE': {
        const v = refVar(scope, e.args[0]);
        if (!v) return 0;
        if (v.d.type === 'packed') return Math.floor(v.d.len / 2) + 1;
        if (v.d.type === 'int') return { 3: 1, 5: 2, 10: 4, 20: 8 }[v.d.len];
        return v.d.len;
      }
      case '%PARMS': return scope.parms ?? args.length;
      case '%EDITC': {
        const sc = scaleOf(e.args[0], scope) || { scale: 0, len: Math.max(1, String(Math.trunc(Math.abs(n(0)))).length) };
        return editc(n(0), s(1), sc.len, sc.scale);
      }
      case '%DATE': {
        if (!a.length) return env.today();
        const v = a[0];
        const t = isNum(v) ? String(v).padStart(8, '0').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : String(v).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw fail('RNX0112', `Date value '${t}' is not valid.`, 112, e.line);
        return t;
      }
      case '%TIMESTAMP': return env.timestamp();
      case '%MAX': return a.reduce((x, y) => (compare(x, y, e.line) >= 0 ? x : y));
      case '%MIN': return a.reduce((x, y) => (compare(x, y, e.line) <= 0 ? x : y));
    }
    throw fail('RNX0100', `Built-in function ${e.name} not supported.`, 100, e.line);
  }

  function trimChars(str, chars, left, right) {
    let i = 0, j = str.length;
    if (left) while (i < j && chars.includes(str[i])) i++;
    if (right) while (j > i && chars.includes(str[j - 1])) j--;
    return str.slice(i, j);
  }

  // ----- Procedures en programma's aanroepen -----

  function* callNamed(e, scope) {
    const proc = prog.procs[e.name];
    if (proc) return yield* callProc(proc, e, scope);
    const pr = prog.protos[e.name];
    if (pr && pr.extpgm) return yield* callPgm(pr, e, scope);
    if (pr && prog.procs[pr.name]) return yield* callProc(prog.procs[pr.name], e, scope);
    throw fail('RNX0100', `${e.name} is not defined.`, 100, e.line);
  }

  function* callPgm(pr, e, scope) {
    const vals = [];
    for (const x of e.args || []) vals.push(yield* ev(x, scope));
    flushDisplay();
    if (pr.extpgm === 'QCMDEXC') {
      const cmd = String(vals[0] ?? '').trim();
      const r = env.exec(cmd);
      if (r?.panel) yield { panel: r.panel };
      if (r?.program) yield* r.program;
      return 0;
    }
    yield* env.call({ lib: '*LIBL', obj: pr.extpgm }, vals.map((v) => (typeof v === 'boolean' ? (v ? '1' : '0') : v)));
    return 0;
  }

  function* callProc(proc, e, scope) {
    const params = proc.pi?.params || [];
    const argNodes = e.args || [];
    if (argNodes.length > params.length) throw fail('RNX0100', `Too many parameters for procedure ${proc.name}.`, 100, e.line);
    const vals = [];
    for (const x of argNodes) vals.push(yield* ev(x, scope));
    const locals = new Map();
    const lookup = (n) => locals.get(n) || globalLookup(n);
    const frame = { lookup, parms: argNodes.length };
    for (const [n, d] of Object.entries(proc.locals)) {
      if (d.kind === 'const') locals.set(n, { d, val: evalConst(d.expr, lookup) });
    }
    for (const [n, d] of Object.entries(proc.locals)) {
      if (d.kind === 'var' && !d.param) locals.set(n, makeVar(d, lookup));
      else if (d.kind === 'ds') locals.set(n, { d, val: null });
    }
    params.forEach((p, i) => {
      const v = { d: p, val: dft(p) };
      if (i < vals.length) v.val = coerce(p, vals[i], false, e.line, p.name);
      locals.set(p.name, v);
    });
    let ret = null;
    try {
      yield* exec(proc.body, frame);
    } catch (sig) {
      if (!(sig instanceof Signal) || sig.kind !== 'return') throw sig;
      ret = sig.value;
    }
    // Parameters zonder CONST of VALUE worden teruggeschreven
    params.forEach((p, i) => {
      const node = argNodes[i];
      if (!node || p.byValue || p.isConst || node.k !== 'ref') return;
      const target = refVar(scope, node);
      if (!target || target.d.kind === 'ds') return;
      if (target.d.dim && node.args) return; // arrayelementen: eenvoudig gehouden
      if (!target.d.dim) target.val = coerce(target.d, locals.get(p.name).val, false, e.line, node.name);
    });
    if (proc.pi?.ret) {
      if (ret === null) return dft(proc.pi.ret);
      return coerce(proc.pi.ret, ret, false, e.line, proc.name);
    }
    return ret;
  }

  // ----- Opdrachten -----

  function* setTarget(t, value, s, scope, op) {
    if (t.k === 'spec') { inlr = truthy(value) ? '1' : '0'; return; }
    if (t.k === 'bif') {
      const inner = t.args[0];
      const v = refVar(scope, inner);
      if (!v || !(v.d.type === 'char' || v.d.type === 'varchar')) throw fail('RNX0100', '%SUBST as target needs a character field.', 100, s.line);
      const start = yield* ev(t.args[1], scope);
      const cur = v.val;
      const len = t.args[2] ? yield* ev(t.args[2], scope) : cur.length - start + 1;
      const piece = String(value).slice(0, len).padEnd(len);
      v.val = coerce(v.d, cur.slice(0, start - 1) + piece + cur.slice(start - 1 + len), false, s.line, inner.name);
      return;
    }
    const v = refVar(scope, t);
    if (!v) throw fail('RNX0100', `${t.name} is not a variable.`, 100, s.line);
    if (v.d.kind === 'const') throw fail('RNX0100', `${t.name} is a constant and cannot be changed.`, 100, s.line);
    if (v.d.kind === 'ds') {
      const str = String(value);
      let p = 0;
      for (const sub of v.d.subs) {
        const sv = scope.lookup(v.d.qualified ? `${t.name}.${sub}` : sub);
        const piece = str.substr(p, sv.d.len).padEnd(sv.d.len);
        p += sv.d.len;
        if (isNumType(sv.d)) {
          const digits = piece.trim();
          sv.val = /^-?\d+$/.test(digits) ? Number(digits) / 10 ** (sv.d.scale || 0) : 0;
        } else sv.val = coerce(sv.d, piece, false, s.line, sub);
      }
      return;
    }
    if (v.d.dim) {
      if (!t.args) {
        for (let i = 0; i < v.val.length; i++) v.val[i] = coerce(v.d, op ? combine(v.val[i], value, op, s) : value, s.half, s.line, t.name);
        return;
      }
      const i = yield* indexOf(scope, t, v);
      v.val[i] = coerce(v.d, op ? combine(v.val[i], value, op, s) : value, s.half, s.line, t.name);
      return;
    }
    v.val = coerce(v.d, op ? combine(v.val, value, op, s) : value, s.half, s.line, t.name);
  }

  function combine(cur, value, op, s) {
    if (op === '+' && !isNum(cur) && !isNum(value)) return cur + value;
    if (!isNum(cur) || !isNum(value)) throw fail('RNX0100', `Operands of ${op}= are not compatible.`, 100, s.line);
    switch (op) {
      case '+': return round10(cur + value);
      case '-': return round10(cur - value);
      case '*': return round10(cur * value);
      case '/':
        if (value === 0) throw fail('RNX0102', 'Attempt to divide by zero.', 102, s.line);
        return cur / value;
      default: return cur ** value;
    }
  }

  function flushDisplay() {
    return pending.length ? pending.splice(0) : null;
  }

  const display = (v) => (isNum(v) ? numToChar(v) : typeof v === 'boolean' ? (v ? '1' : '0') : String(v).trimEnd());

  function* exec(list, scope) {
    for (const s of list) {
      if (++steps > 2000000) throw fail('RNX9999', 'Program ended: too many operations (endless loop?).', 9999, s.line);
      try {
        yield* execOne(s, scope);
      } catch (e) {
        if (e instanceof CpfError && e.line === undefined) e.line = s.line;
        throw e;
      }
    }
  }

  function* execOne(s, scope) {
    switch (s.k) {
      case 'assign': {
        const value = yield* ev(s.e, scope);
        const op = s.op === '=' ? null : s.op.slice(0, -1);
        if (s.right && !op && typeof value === 'string') {
          const v = refVar(scope, s.target);
          if (v && v.d.type === 'char') { v.val = value.slice(-v.d.len).padStart(v.d.len); return; }
        }
        yield* setTarget(s.target, value, s, scope, op);
        return;
      }
      case 'call':
        yield* callNamed(s.call, scope);
        return;
      case 'if':
        for (const b of s.branches) {
          if (truthy(yield* ev(b.cond, scope))) { yield* exec(b.body, scope); return; }
        }
        yield* exec(s.elseBody || [], scope);
        return;
      case 'dow':
      case 'dou':
        for (let first = true; ; first = false) {
          if (s.k === 'dow' && !truthy(yield* ev(s.cond, scope))) break;
          if (s.k === 'dou' && !first && truthy(yield* ev(s.cond, scope))) break;
          try {
            yield* exec(s.body, scope);
          } catch (sig) {
            if (!(sig instanceof Signal)) throw sig;
            if (sig.kind === 'leave') break;
            if (sig.kind !== 'iter') throw sig;
          }
        }
        return;
      case 'for': {
        const by = s.by ? yield* ev(s.by, scope) : 1;
        yield* setTarget(s.v, yield* ev(s.from, scope), s, scope, null);
        for (;;) {
          const cur = yield* ev(s.v, scope);
          if (s.to) {
            const to = yield* ev(s.to, scope);
            if (s.down ? cur < to : cur > to) break;
          }
          try {
            yield* exec(s.body, scope);
          } catch (sig) {
            if (!(sig instanceof Signal)) throw sig;
            if (sig.kind === 'leave') break;
            if (sig.kind !== 'iter') throw sig;
          }
          yield* setTarget(s.v, (yield* ev(s.v, scope)) + (s.down ? -by : by), s, scope, null);
        }
        return;
      }
      case 'select':
        for (const w of s.whens) {
          if (truthy(yield* ev(w.cond, scope))) { yield* exec(w.body, scope); return; }
        }
        if (s.other) yield* exec(s.other, scope);
        return;
      case 'monitor':
        try {
          yield* exec(s.body, scope);
        } catch (e) {
          if (!(e instanceof CpfError)) throw e;
          const st = e.status ?? 9999;
          const h = s.handlers.find((x) => !x.codes.length || x.codes.some((c) => c === '*ALL' || c === '*PROGRAM' && st < 1000
            || c === '*FILE' && st >= 1000 || c === st));
          if (!h) throw e;
          env.joblog?.(e);
          yield* exec(h.body, scope);
        }
        return;
      case 'leave': throw new Signal('leave');
      case 'iter': throw new Signal('iter');
      case 'leavesr': throw new Signal('leavesr');
      case 'return': throw new Signal('return', s.e ? yield* ev(s.e, scope) : null);
      case 'exsr':
        try {
          yield* exec(prog.subrs[s.name], scope);
        } catch (sig) {
          if (!(sig instanceof Signal) || sig.kind !== 'leavesr') throw sig;
        }
        return;
      case 'dsply': {
        const msg = display(yield* ev(s.msg, scope));
        if (!s.resp) {
          pending.push('DSPLY  ' + msg);
          if (env.batch) env.joblog?.({ text: 'DSPLY  ' + msg });
          return;
        }
        if (env.batch) throw fail('RNX0333', 'DSPLY with a response is not allowed in a batch job.', 333, s.line);
        const before = flushDisplay() || [];
        const reply = yield { inquiry: [...before, 'DSPLY  ' + msg].join('\n') };
        const v = refVar(scope, s.resp);
        if (!v) throw fail('RNX0100', 'The response field of DSPLY is not a variable.', 100, s.line);
        let r = String(reply ?? '');
        if (isNumType(v.d)) {
          const t = r.trim().replace(',', '.');
          r = t === '' ? 0 : Number(t);
          if (Number.isNaN(r)) throw fail('RNX0105', `A character representation of a numeric value is in error: '${t}'.`, 105, s.line);
        }
        yield* setTarget(s.resp, r, s, scope, null);
        return;
      }
      case 'clear': {
        const t = s.target;
        if (t.k === 'ref' && prog.files[t.name]) {
          for (const fd of files[t.name].obj?.fields || []) {
            const v = globals.get(fd.name);
            if (v) v.val = dft(v.d);
          }
          return;
        }
        const v = refVar(scope, t);
        if (!v) throw fail('RNX0100', `${t.name} cannot be cleared.`, 100, s.line);
        if (v.d.kind === 'ds') {
          for (const sub of v.d.subs) {
            const sv = scope.lookup(v.d.qualified ? `${t.name}.${sub}` : sub);
            sv.val = dft(sv.d);
          }
          return;
        }
        if (v.d.dim) v.val = v.val.map(() => dft(v.d));
        else v.val = dft(v.d);
        return;
      }
      case 'fileop':
        yield* fileop(s, scope);
    }
  }

  // ----- Start -----

  const main = { lookup: globalLookup, parms: args.length };
  (prog.entry?.params || []).forEach((p, i) => {
    if (i < args.length) {
      let v = args[i];
      if (isNumType(p) && typeof v === 'string') {
        const t = v.trim();
        v = /^[+-]?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
      }
      globals.get(p.name).val = coerce(p, v, false, 0, p.name);
    }
  });

  try {
    yield* exec(prog.main, main);
  } catch (e) {
    if (e instanceof Signal) {
      if (e.kind !== 'return') throw fail('RNX0100', `${e.kind.toUpperCase()} is not inside a loop or subroutine.`, 100, 0);
    } else {
      for (const st of Object.values(files)) if (st.def.printer) flushPrinter(st);
      if (e instanceof CpfError) {
        const where = e.line !== undefined ? ` (program ${name}, statement ${env.seq ? env.seq(e.line) : e.line + 1})` : '';
        if (!e.text.includes('(program ')) e.text = e.message = `${e.text}${where}`;
      }
      throw e;
    }
  }
  for (const st of Object.values(files)) if (st.def.printer) flushPrinter(st);
  const rest = flushDisplay();
  if (rest && !env.batch) yield { info: rest.join('\n') };
  return [];
}
