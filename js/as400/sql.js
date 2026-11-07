// Een kleine SQL-engine in de geest van DB2 for i.
//
// Ondersteund: SELECT (DISTINCT, joins, WHERE, GROUP BY, HAVING, ORDER BY,
// FETCH FIRST n ROWS, subquery's in IN/EXISTS/als waarde), INSERT (VALUES of
// SELECT), UPDATE, DELETE, CREATE TABLE (ook AS (SELECT ...) WITH DATA),
// DROP TABLE, CREATE SCHEMA/COLLECTION en DROP SCHEMA.
// Tabellen schrijf je als BIBL/TABEL (systeemnaamgeving) of BIBL.TABEL.
import { CpfError } from './cl.js';

const sqlErr = (id, text) => new CpfError(id, text);

// ---------- Tokens ----------

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= src.length) throw sqlErr('SQL0010', 'String constant beginning \'' + v.slice(0, 10) + '\' not delimited.');
        if (src[i] === "'") {
          if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
          i++;
          break;
        }
        v += src[i++];
      }
      toks.push({ t: 'str', v });
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) throw sqlErr('SQL0010', 'Delimited name not ended.');
      toks.push({ t: 'id', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]*(E[+-]?[0-9]+)?/i.exec(src.slice(i))[0];
      toks.push({ t: 'num', v: Number(m), text: m });
      i += m.length;
      continue;
    }
    if (/[A-Za-z_@#$]/.test(c)) {
      const m = /^[A-Za-z_@#$][A-Za-z0-9_@#$]*/.exec(src.slice(i))[0];
      toks.push({ t: 'id', v: m.toUpperCase(), kw: true });
      i += m.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<>', '!=', '<=', '>=', '||', '¬='].includes(two)) {
      toks.push({ t: 'op', v: two === '!=' || two === '¬=' ? '<>' : two });
      i += 2;
      continue;
    }
    if ('=<>(),.*/+-;:'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw sqlErr('SQL0007', `Character ${c} not valid in SQL statement.`);
  }
  return toks;
}

const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'FETCH', 'LIMIT',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'ON', 'AND', 'OR', 'NOT', 'AS', 'UNION', 'SET',
  'VALUES', 'INTO', 'ASC', 'DESC', 'WITH', 'OFFSET']);

// ---------- Parser ----------

class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.p = 0;
  }
  peek(o = 0) { return this.toks[this.p + o]; }
  isKw(v, o = 0) { const t = this.peek(o); return t && t.t === 'id' && t.kw && t.v === v; }
  isOp(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }
  acceptKw(v) { if (this.isKw(v)) { this.p++; return true; } return false; }
  acceptOp(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  bad() {
    const t = this.peek();
    if (!t) return sqlErr('SQL0104', 'Statement not complete.');
    return sqlErr('SQL0104', `Token ${t.t === 'str' ? "'" + t.v + "'" : t.v} was not valid.`);
  }
  kw(v) { if (!this.acceptKw(v)) throw this.bad(); }
  op(v) { if (!this.acceptOp(v)) throw this.bad(); }
  ident() {
    const t = this.peek();
    if (!t || t.t !== 'id') throw this.bad();
    this.p++;
    return t.v;
  }
  num() {
    const t = this.peek();
    if (!t || t.t !== 'num') throw this.bad();
    this.p++;
    return t.v;
  }
  end() {
    this.acceptOp(';');
    if (this.p < this.toks.length) throw this.bad();
  }

  statement() {
    let st;
    if (this.isKw('SELECT') || this.isOp('(')) st = this.select();
    else if (this.acceptKw('INSERT')) st = this.insert();
    else if (this.acceptKw('UPDATE')) st = this.update();
    else if (this.acceptKw('DELETE')) st = this.del();
    else if (this.acceptKw('CREATE')) st = this.create();
    else if (this.acceptKw('DROP')) st = this.drop();
    else throw this.bad();
    this.end();
    return st;
  }

  tableName() {
    const a = this.ident();
    if (this.acceptOp('/') || this.acceptOp('.')) return { schema: a, name: this.ident() };
    return { schema: null, name: a };
  }

  select() {
    if (this.acceptOp('(')) { const s = this.select(); this.op(')'); return s; }
    this.kw('SELECT');
    const st = { type: 'select', distinct: false, items: [], from: [], where: null, group: [], having: null, order: [], limit: null };
    if (this.acceptKw('DISTINCT')) st.distinct = true;
    else this.acceptKw('ALL');
    do {
      if (this.acceptOp('*')) { st.items.push({ star: true }); continue; }
      if (this.peek()?.t === 'id' && this.isOp('.', 1) && this.isOp('*', 2)) {
        const q = this.ident(); this.p += 2;
        st.items.push({ star: true, qual: q });
        continue;
      }
      const start = this.p;
      const e = this.expr();
      const text = this.toks.slice(start, this.p).map(tokText).join(' ');
      let alias = null;
      if (this.acceptKw('AS')) alias = this.ident();
      else if (this.peek()?.t === 'id' && !RESERVED.has(this.peek().v)) alias = this.ident();
      st.items.push({ expr: e, alias, text });
    } while (this.acceptOp(','));
    if (this.acceptKw('FROM')) {
      st.from.push(this.tableRef());
      for (;;) {
        if (this.acceptOp(',')) { st.from.push(this.tableRef()); continue; }
        let kind = null;
        if (this.acceptKw('JOIN')) kind = 'inner';
        else if (this.isKw('INNER')) { this.p++; this.kw('JOIN'); kind = 'inner'; }
        else if (this.isKw('LEFT')) { this.p++; this.acceptKw('OUTER'); this.kw('JOIN'); kind = 'left'; }
        else if (this.isKw('CROSS')) { this.p++; this.kw('JOIN'); st.from.push(this.tableRef()); continue; }
        if (!kind) break;
        const ref = this.tableRef();
        this.kw('ON');
        ref.join = kind;
        ref.on = this.expr();
        st.from.push(ref);
      }
    }
    if (this.acceptKw('WHERE')) st.where = this.expr();
    if (this.acceptKw('GROUP')) {
      this.kw('BY');
      do st.group.push(this.expr()); while (this.acceptOp(','));
    }
    if (this.acceptKw('HAVING')) st.having = this.expr();
    if (this.acceptKw('ORDER')) {
      this.kw('BY');
      do {
        const e = this.expr();
        let desc = false;
        if (this.acceptKw('DESC')) desc = true; else this.acceptKw('ASC');
        st.order.push({ expr: e, desc });
      } while (this.acceptOp(','));
    }
    if (this.acceptKw('FETCH')) {
      if (!this.acceptKw('FIRST')) this.kw('NEXT');
      st.limit = this.peek()?.t === 'num' ? this.num() : 1;
      if (!this.acceptKw('ROWS')) this.kw('ROW');
      this.kw('ONLY');
    } else if (this.acceptKw('LIMIT')) st.limit = this.num();
    return st;
  }

  tableRef() {
    const t = this.tableName();
    let alias = null;
    if (this.acceptKw('AS')) alias = this.ident();
    else if (this.peek()?.t === 'id' && !RESERVED.has(this.peek().v)) alias = this.ident();
    return { ...t, alias: alias || t.name };
  }

  insert() {
    this.kw('INTO');
    const table = this.tableName();
    let cols = null;
    if (this.isOp('(') && !this.isKw('SELECT', 1)) {
      this.p++;
      cols = [];
      do cols.push(this.ident()); while (this.acceptOp(','));
      this.op(')');
    }
    if (this.acceptKw('VALUES')) {
      const rows = [];
      do {
        if (this.acceptOp('(')) {
          const r = [];
          do r.push(this.expr()); while (this.acceptOp(','));
          this.op(')');
          rows.push(r);
        } else rows.push([this.expr()]);
      } while (this.acceptOp(','));
      return { type: 'insert', table, cols, rows };
    }
    return { type: 'insert', table, cols, select: this.select() };
  }

  update() {
    const table = this.tableName();
    let alias = table.name;
    if (this.acceptKw('AS')) alias = this.ident();
    else if (this.peek()?.t === 'id' && !this.isKw('SET')) alias = this.ident();
    this.kw('SET');
    const sets = [];
    do {
      const col = this.ident();
      this.op('=');
      sets.push({ col, expr: this.expr() });
    } while (this.acceptOp(','));
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { type: 'update', table: { ...table, alias }, sets, where };
  }

  del() {
    this.kw('FROM');
    const table = this.tableName();
    let alias = table.name;
    if (this.acceptKw('AS')) alias = this.ident();
    else if (this.peek()?.t === 'id' && !this.isKw('WHERE')) alias = this.ident();
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { type: 'delete', table: { ...table, alias }, where };
  }

  create() {
    this.acceptKw('OR') && this.kw('REPLACE');
    if (this.acceptKw('SCHEMA') || this.acceptKw('COLLECTION')) return { type: 'createschema', name: this.ident() };
    this.kw('TABLE');
    const table = this.tableName();
    if (this.acceptKw('AS')) {
      this.op('(');
      const select = this.select();
      this.op(')');
      let data = false;
      if (this.acceptKw('WITH')) {
        if (this.acceptKw('NO')) data = false; else data = true;
        this.kw('DATA');
      }
      return { type: 'create', table, select, data };
    }
    this.op('(');
    const cols = [];
    do {
      if (this.isKw('PRIMARY') || this.isKw('CONSTRAINT') || this.isKw('UNIQUE')) {
        // Beperkingen worden geaccepteerd maar niet afgedwongen
        let depth = 0;
        while (this.peek() && !(depth === 0 && (this.isOp(',') || this.isOp(')')))) {
          if (this.isOp('(')) depth++;
          if (this.isOp(')')) depth--;
          this.p++;
        }
        continue;
      }
      const name = this.ident();
      cols.push({ name, ...this.dataType() });
      for (;;) {
        if (this.acceptKw('NOT')) { this.kw('NULL'); cols.at(-1).notnull = true; continue; }
        if (this.acceptKw('NULL')) continue;
        if (this.acceptKw('DEFAULT')) { cols.at(-1).dft = this.primary(); continue; }
        if (this.acceptKw('PRIMARY')) { this.kw('KEY'); cols.at(-1).notnull = true; continue; }
        break;
      }
    } while (this.acceptOp(','));
    this.op(')');
    return { type: 'create', table, cols };
  }

  dataType() {
    const t = this.ident();
    const args = [];
    if (this.acceptOp('(')) {
      do args.push(this.num()); while (this.acceptOp(','));
      this.op(')');
    }
    switch (t) {
      case 'CHAR': case 'CHARACTER': return { type: 'CHAR', len: args[0] ?? 1 };
      case 'VARCHAR': return { type: 'VARCHAR', len: args[0] ?? 1 };
      case 'DECIMAL': case 'DEC': case 'NUMERIC':
        return { type: 'DECIMAL', len: args[0] ?? 5, scale: args[1] ?? 0 };
      case 'INTEGER': case 'INT': return { type: 'INTEGER', len: 10, scale: 0 };
      case 'SMALLINT': return { type: 'INTEGER', len: 5, scale: 0 };
      case 'BIGINT': return { type: 'INTEGER', len: 19, scale: 0 };
      case 'DATE': return { type: 'DATE', len: 10 };
      case 'TIME': return { type: 'TIME', len: 8 };
      case 'TIMESTAMP': return { type: 'TIMESTAMP', len: 26 };
      default: throw sqlErr('SQL0104', `Token ${t} was not valid.`);
    }
  }

  drop() {
    if (this.acceptKw('SCHEMA') || this.acceptKw('COLLECTION')) return { type: 'dropschema', name: this.ident() };
    this.kw('TABLE');
    return { type: 'drop', table: this.tableName() };
  }

  // Expressies: OR < AND < NOT < predicaat < + - || < * / < unair
  expr() {
    let l = this.and();
    while (this.acceptKw('OR')) l = { k: 'or', l, r: this.and() };
    return l;
  }
  and() {
    let l = this.not();
    while (this.acceptKw('AND')) l = { k: 'and', l, r: this.not() };
    return l;
  }
  not() {
    if (this.acceptKw('NOT')) return { k: 'not', e: this.not() };
    return this.pred();
  }
  pred() {
    if (this.acceptKw('EXISTS')) {
      this.op('(');
      const q = this.select();
      this.op(')');
      return { k: 'exists', q };
    }
    const l = this.add();
    const t = this.peek();
    if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      this.p++;
      return { k: 'cmp', op: t.v, l, r: this.add() };
    }
    if (this.acceptKw('IS')) {
      const neg = this.acceptKw('NOT');
      this.kw('NULL');
      return { k: 'isnull', e: l, neg };
    }
    const neg = this.acceptKw('NOT');
    if (this.acceptKw('LIKE')) return { k: 'like', e: l, pat: this.add(), neg };
    if (this.acceptKw('BETWEEN')) {
      const lo = this.add();
      this.kw('AND');
      return { k: 'between', e: l, lo, hi: this.add(), neg };
    }
    if (this.acceptKw('IN')) {
      this.op('(');
      if (this.isKw('SELECT')) {
        const q = this.select();
        this.op(')');
        return { k: 'in', e: l, q, neg };
      }
      const list = [];
      do list.push(this.expr()); while (this.acceptOp(','));
      this.op(')');
      return { k: 'in', e: l, list, neg };
    }
    if (neg) throw this.bad();
    return l;
  }
  add() {
    let l = this.mul();
    for (;;) {
      if (this.acceptOp('+')) l = { k: 'bin', op: '+', l, r: this.mul() };
      else if (this.acceptOp('-')) l = { k: 'bin', op: '-', l, r: this.mul() };
      else if (this.acceptOp('||') || this.acceptKw('CONCAT')) l = { k: 'bin', op: '||', l, r: this.mul() };
      else return l;
    }
  }
  mul() {
    let l = this.unary();
    for (;;) {
      if (this.acceptOp('*')) l = { k: 'bin', op: '*', l, r: this.unary() };
      else if (this.acceptOp('/')) l = { k: 'bin', op: '/', l, r: this.unary() };
      else return l;
    }
  }
  unary() {
    if (this.acceptOp('-')) return { k: 'neg', e: this.unary() };
    if (this.acceptOp('+')) return this.unary();
    return this.primary();
  }
  primary() {
    const t = this.peek();
    if (!t) throw this.bad();
    if (t.t === 'num') { this.p++; return { k: 'lit', v: t.v, text: t.text }; }
    if (t.t === 'str') { this.p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'op' && t.v === '(') {
      this.p++;
      if (this.isKw('SELECT')) {
        const q = this.select();
        this.op(')');
        return { k: 'subq', q };
      }
      const e = this.expr();
      this.op(')');
      return e;
    }
    if (t.t !== 'id') throw this.bad();
    this.p++;
    const v = t.v;
    if (t.kw) {
      if (v === 'NULL') return { k: 'lit', v: null };
      if (v === 'CASE') return this.caseExpr();
      if (v === 'CURRENT') {
        const w = this.ident();
        if (w === 'DATE') return { k: 'special', v: 'DATE' };
        if (w === 'TIME') return { k: 'special', v: 'TIME' };
        if (w === 'TIMESTAMP') return { k: 'special', v: 'TIMESTAMP' };
        if (w === 'USER' || w === 'SERVER' || w === 'SCHEMA') return { k: 'special', v: w };
        throw this.bad();
      }
      if (v === 'CURRENT_DATE') return { k: 'special', v: 'DATE' };
      if (v === 'CURRENT_TIME') return { k: 'special', v: 'TIME' };
      if (v === 'CURRENT_TIMESTAMP') return { k: 'special', v: 'TIMESTAMP' };
      if ((v === 'USER' || v === 'SESSION_USER') && !this.isOp('(')) return { k: 'special', v: 'USER' };
    }
    if (this.acceptOp('(')) {
      if (this.acceptOp('*')) { this.op(')'); return { k: 'fn', name: v, star: true, args: [] }; }
      const distinct = this.acceptKw('DISTINCT');
      const args = [];
      if (!this.isOp(')')) do args.push(this.expr()); while (this.acceptOp(','));
      this.op(')');
      return { k: 'fn', name: v, args, distinct };
    }
    if (this.acceptOp('.')) return { k: 'col', qual: v, name: this.ident() };
    return { k: 'col', qual: null, name: v };
  }
  caseExpr() {
    let subject = null;
    if (!this.isKw('WHEN')) subject = this.expr();
    const whens = [];
    while (this.acceptKw('WHEN')) {
      const w = this.expr();
      this.kw('THEN');
      whens.push({ w, then: this.expr() });
    }
    const els = this.acceptKw('ELSE') ? this.expr() : null;
    this.kw('END');
    return { k: 'case', subject, whens, els };
  }
}

function tokText(t) {
  if (t.t === 'str') return "'" + t.v + "'";
  if (t.t === 'num') return t.text ?? String(t.v);
  return t.v;
}

// ---------- Uitvoeren ----------

const AGG = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

function hasAgg(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.k === 'fn' && AGG.has(e.name)) return true;
  if (e.k === 'subq' || e.k === 'exists') return false;
  return Object.values(e).some((v) => (Array.isArray(v) ? v.some(hasAgg) : hasAgg(v)));
}

const pad = (n, w) => String(n).padStart(w, '0');

function nowParts() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`,
    time: `${pad(d.getHours(), 2)}.${pad(d.getMinutes(), 2)}.${pad(d.getSeconds(), 2)}`,
    ts: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}-${pad(d.getHours(), 2)}.${pad(d.getMinutes(), 2)}.${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}000`,
  };
}

const isNum = (v) => typeof v === 'number';

function cmpVals(a, b) {
  if (a === null || b === null) return null;
  if (isNum(a) && !isNum(b)) {
    const n = Number(String(b).trim());
    if (String(b).trim() === '' || Number.isNaN(n)) throw sqlErr('SQL0401', 'Comparison operator not compatible with its operands.');
    b = n;
  } else if (!isNum(a) && isNum(b)) {
    const n = Number(String(a).trim());
    if (String(a).trim() === '' || Number.isNaN(n)) throw sqlErr('SQL0401', 'Comparison operator not compatible with its operands.');
    a = n;
  }
  if (!isNum(a)) { a = String(a).trimEnd(); b = String(b).trimEnd(); }
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortCmp(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // NULL komt in DB2 achteraan
  if (b === null) return -1;
  return cmpVals(a, b);
}

function likeRe(pat) {
  let re = '';
  for (const c of String(pat).trimEnd()) {
    if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export class SqlEngine {
  // env: { getTable(schema, name) → {obj, lib}, createTable(schema, name, fields, rows) → lib,
  //        dropTable(schema, name) → lib, createSchema(name), dropSchema(name), user, changed() }
  constructor(env) {
    this.env = env;
  }

  run(text) {
    const st = new Parser(text).statement();
    switch (st.type) {
      case 'select': return { type: 'select', ...this.select(st, null) };
      case 'insert': return this.insert(st);
      case 'update': return this.update(st);
      case 'delete': return this.del(st);
      case 'create': return this.create(st);
      case 'drop': {
        const r = this.env.dropTable(st.table.schema, st.table.name);
        return { type: 'ddl', message: `Table ${st.table.name} in ${r.lib} dropped.` };
      }
      case 'createschema':
        this.env.createSchema(st.name);
        return { type: 'ddl', message: `Schema ${st.name} created.` };
      case 'dropschema':
        this.env.dropSchema(st.name);
        return { type: 'ddl', message: `Schema ${st.name} dropped.` };
    }
    throw sqlErr('SQL0084', 'SQL statement not allowed.');
  }

  // Een rij-context: lijst van bronnen [{alias, fields, row}] plus een buitenste context
  resolve(ctx, e) {
    for (let c = ctx; c; c = c.outer) {
      const hits = [];
      for (const s of c.srcs) {
        if (e.qual && s.alias !== e.qual && s.name !== e.qual) continue;
        const i = s.fields.findIndex((f) => f.name === e.name);
        if (i >= 0) hits.push({ s, i });
      }
      if (hits.length > 1) throw sqlErr('SQL0203', `Name ${e.name} is ambiguous.`);
      if (hits.length === 1) return hits[0];
    }
    throw sqlErr('SQL0206', `Column or global variable ${e.name} not found.`);
  }

  ev(e, ctx) {
    switch (e.k) {
      case 'lit': return e.v;
      case 'col': {
        const h = this.resolve(ctx, e);
        return h.s.row ? h.s.row[h.i] ?? null : null;
      }
      case 'special': {
        const n = nowParts();
        if (e.v === 'DATE') return n.date;
        if (e.v === 'TIME') return n.time;
        if (e.v === 'TIMESTAMP') return n.ts;
        if (e.v === 'SERVER') return 'SIM400';
        return this.env.user || 'QSECOFR';
      }
      case 'neg': { const v = this.ev(e.e, ctx); return v === null ? null : -this.num(v); }
      case 'bin': {
        const a = this.ev(e.l, ctx), b = this.ev(e.r, ctx);
        if (a === null || b === null) return null;
        if (e.op === '||') return String(isNum(a) ? a : a) + String(b);
        const x = this.num(a), y = this.num(b);
        if (e.op === '+') return x + y;
        if (e.op === '-') return x - y;
        if (e.op === '*') return x * y;
        if (y === 0) throw sqlErr('SQL0802', 'Data conversion or data mapping error: division by zero.');
        return x / y;
      }
      case 'cmp': {
        const c = cmpVals(this.ev(e.l, ctx), this.ev(e.r, ctx));
        if (c === null) return null;
        return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[e.op];
      }
      case 'and': {
        const a = this.ev(e.l, ctx);
        if (a === false) return false;
        const b = this.ev(e.r, ctx);
        if (b === false) return false;
        return a === null || b === null ? null : true;
      }
      case 'or': {
        const a = this.ev(e.l, ctx);
        if (a === true) return true;
        const b = this.ev(e.r, ctx);
        if (b === true) return true;
        return a === null || b === null ? null : false;
      }
      case 'not': { const v = this.ev(e.e, ctx); return v === null ? null : !v; }
      case 'isnull': { const v = this.ev(e.e, ctx) === null; return e.neg ? !v : v; }
      case 'like': {
        const v = this.ev(e.e, ctx), p = this.ev(e.pat, ctx);
        if (v === null || p === null) return null;
        const r = likeRe(p).test(String(v).trimEnd());
        return e.neg ? !r : r;
      }
      case 'between': {
        const v = this.ev(e.e, ctx);
        const a = cmpVals(v, this.ev(e.lo, ctx)), b = cmpVals(v, this.ev(e.hi, ctx));
        if (a === null || b === null) return null;
        const r = a >= 0 && b <= 0;
        return e.neg ? !r : r;
      }
      case 'in': {
        const v = this.ev(e.e, ctx);
        if (v === null) return null;
        const list = e.q ? this.select(e.q, ctx).rows.map((r) => r[0]) : e.list.map((x) => this.ev(x, ctx));
        let unknown = false;
        for (const x of list) {
          const c = cmpVals(v, x);
          if (c === 0) return !e.neg;
          if (c === null) unknown = true;
        }
        return unknown ? null : !!e.neg;
      }
      case 'exists': return this.select(e.q, ctx).rows.length > 0;
      case 'subq': {
        const r = this.select(e.q, ctx).rows;
        if (r.length > 1) throw sqlErr('SQL0811', 'Result of SELECT more than one row.');
        return r.length ? r[0][0] : null;
      }
      case 'case': {
        for (const w of e.whens) {
          const hit = e.subject ? cmpVals(this.ev(e.subject, ctx), this.ev(w.w, ctx)) === 0 : this.ev(w.w, ctx) === true;
          if (hit) return this.ev(w.then, ctx);
        }
        return e.els ? this.ev(e.els, ctx) : null;
      }
      case 'fn': return this.fn(e, ctx);
    }
    throw sqlErr('SQL0104', 'Expression not valid.');
  }

  num(v) {
    if (isNum(v)) return v;
    const n = Number(String(v).trim());
    if (String(v).trim() === '' || Number.isNaN(n)) throw sqlErr('SQL0420', `Character in CAST argument not valid: '${String(v).trim()}'.`);
    return n;
  }

  fn(e, ctx) {
    const name = e.name;
    if (AGG.has(name)) {
      const group = ctx.group;
      if (!group) throw sqlErr('SQL0120', `Use of column function ${name} not valid.`);
      if (e.star) return group.length;
      let vals = group.map((g) => this.ev(e.args[0], g)).filter((v) => v !== null);
      if (e.distinct) vals = [...new Map(vals.map((v) => [isNum(v) ? 'n' + v : 's' + String(v).trimEnd(), v])).values()];
      if (name === 'COUNT') return vals.length;
      if (!vals.length) return null;
      if (name === 'SUM') return vals.reduce((a, b) => a + this.num(b), 0);
      if (name === 'AVG') return vals.reduce((a, b) => a + this.num(b), 0) / vals.length;
      if (name === 'MIN') return vals.reduce((a, b) => (cmpVals(a, b) <= 0 ? a : b));
      return vals.reduce((a, b) => (cmpVals(a, b) >= 0 ? a : b));
    }
    const a = e.args.map((x) => this.ev(x, ctx));
    const s = (i) => (a[i] === null || a[i] === undefined ? null : String(a[i]));
    const nullIn = a.some((v) => v === null);
    switch (name) {
      case 'UPPER': case 'UCASE': return nullIn ? null : s(0).toUpperCase();
      case 'LOWER': case 'LCASE': return nullIn ? null : s(0).toLowerCase();
      case 'TRIM': case 'STRIP': return nullIn ? null : s(0).trim();
      case 'LTRIM': return nullIn ? null : s(0).trimStart();
      case 'RTRIM': return nullIn ? null : s(0).trimEnd();
      case 'LENGTH': return nullIn ? null : s(0).length;
      case 'SUBSTR': case 'SUBSTRING': {
        if (nullIn) return null;
        const start = this.num(a[1]) - 1;
        return a.length > 2 ? s(0).substr(start, this.num(a[2])) : s(0).slice(start);
      }
      case 'LEFT': return nullIn ? null : s(0).slice(0, this.num(a[1]));
      case 'RIGHT': return nullIn ? null : s(0).slice(-this.num(a[1]));
      case 'CONCAT': return nullIn ? null : s(0) + s(1);
      case 'COALESCE': case 'IFNULL': case 'VALUE': return a.find((v) => v !== null) ?? null;
      case 'ABS': return nullIn ? null : Math.abs(this.num(a[0]));
      case 'ROUND': {
        if (nullIn) return null;
        const f = 10 ** (a.length > 1 ? this.num(a[1]) : 0);
        return Math.round(this.num(a[0]) * f) / f;
      }
      case 'INT': case 'INTEGER': return nullIn ? null : Math.trunc(this.num(a[0]));
      case 'DEC': case 'DECIMAL': {
        if (nullIn) return null;
        const f = 10 ** (a.length > 2 ? this.num(a[2]) : 0);
        return Math.round(this.num(a[0]) * f) / f;
      }
      case 'CHAR': case 'VARCHAR': return nullIn ? null : String(a[0]);
      case 'MOD': return nullIn ? null : this.num(a[0]) % this.num(a[1]);
      case 'POSITION': case 'LOCATE': return nullIn ? null : s(1).indexOf(s(0)) + 1;
      case 'REPLACE': return nullIn ? null : s(0).split(s(1)).join(s(2));
      case 'YEAR': return nullIn ? null : Number(s(0).slice(0, 4));
      case 'MONTH': return nullIn ? null : Number(s(0).slice(5, 7));
      case 'DAY': return nullIn ? null : Number(s(0).slice(8, 10));
      case 'DATE': return nullIn ? null : s(0).slice(0, 10);
      case 'DIGITS': return nullIn ? null : String(Math.abs(Math.trunc(this.num(a[0])))).padStart(10, '0');
    }
    throw sqlErr('SQL0204', `${name} in *LIBL type *N not found.`);
  }

  source(ref) {
    const { obj, lib } = this.env.getTable(ref.schema, ref.name);
    return { alias: ref.alias || ref.name, name: ref.name, lib, obj, fields: obj.fields, rows: obj.rows };
  }

  select(st, outer) {
    // 1. Bronnen en joins
    const srcs = st.from.map((r) => ({ ...this.source(r), ref: r }));
    let tuples = [[]];
    srcs.forEach((s, si) => {
      const next = [];
      for (const t of tuples) {
        let matched = false;
        for (const row of s.rows) {
          const cand = [...t, row];
          if (s.ref.on) {
            const ctx = this.ctxFor(srcs.slice(0, si + 1), cand, outer);
            if (this.ev(s.ref.on, ctx) !== true) continue;
          }
          matched = true;
          next.push(cand);
        }
        if (!matched && s.ref.join === 'left') next.push([...t, null]);
      }
      tuples = next;
    });
    let ctxs = tuples.map((t) => this.ctxFor(srcs, t, outer));

    // 2. WHERE
    if (st.where) ctxs = ctxs.filter((c) => this.ev(st.where, c) === true);

    // 3. Kolommen bepalen
    const items = [];
    for (const it of st.items) {
      if (it.star) {
        for (const s of srcs) {
          if (it.qual && s.alias !== it.qual && s.name !== it.qual) continue;
          s.fields.forEach((f) => items.push({ expr: { k: 'col', qual: s.alias, name: f.name }, name: f.name, field: f }));
        }
        if (it.qual && !srcs.some((s) => s.alias === it.qual || s.name === it.qual)) {
          throw sqlErr('SQL0107', `${it.qual}.* not valid.`);
        }
      } else {
        let field = null;
        if (it.expr.k === 'col') {
          const h = this.resolve(this.ctxFor(srcs, srcs.map(() => null), outer), it.expr);
          field = h.s.fields[h.i];
        }
        items.push({ expr: it.expr, name: it.alias || (it.expr.k === 'col' ? it.expr.name : it.text), field });
      }
    }

    // 4. Groeperen
    const grouped = st.group.length > 0 || items.some((i) => hasAgg(i.expr)) || hasAgg(st.having);
    let units;
    if (grouped) {
      const groups = new Map();
      for (const c of ctxs) {
        const key = JSON.stringify(st.group.map((g) => {
          const v = this.ev(g, c);
          return typeof v === 'string' ? v.trimEnd() : v;
        }));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      if (!groups.size && !st.group.length) groups.set('[]', []);
      units = [...groups.values()].map((g) => {
        const base = g[0] || this.ctxFor(srcs, srcs.map(() => null), outer);
        return { ...base, group: g };
      });
      if (st.having) units = units.filter((u) => this.ev(st.having, u) === true);
    } else units = ctxs;

    // 5. Projectie
    let out = units.map((u) => ({ u, row: items.map((i) => this.ev(i.expr, u)) }));
    if (st.distinct) {
      const seen = new Set();
      out = out.filter((o) => {
        const k = JSON.stringify(o.row.map((v) => (typeof v === 'string' ? v.trimEnd() : v)));
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // 6. Sorteren
    if (st.order.length) {
      const keyOf = (o, ord) => {
        const e = ord.expr;
        if (e.k === 'lit' && isNum(e.v)) return o.row[e.v - 1];
        if (e.k === 'col' && !e.qual) {
          const i = items.findIndex((it) => it.name === e.name);
          if (i >= 0) return o.row[i];
        }
        return this.ev(e, o.u);
      };
      const keyed = out.map((o) => ({ o, keys: st.order.map((ord) => keyOf(o, ord)) }));
      keyed.sort((a, b) => {
        for (let i = 0; i < st.order.length; i++) {
          const c = sortCmp(a.keys[i], b.keys[i]);
          if (c) return st.order[i].desc ? -c : c;
        }
        return 0;
      });
      out = keyed.map((k) => k.o);
    }
    if (st.limit !== null) out = out.slice(0, st.limit);

    const rows = out.map((o) => o.row);
    const columns = items.map((it, ci) => describe(it, rows.map((r) => r[ci])));
    return { columns, rows };
  }

  ctxFor(srcs, tuple, outer) {
    return { srcs: srcs.map((s, i) => ({ alias: s.alias, name: s.name, fields: s.fields, row: tuple[i] ?? null })), outer };
  }

  coerce(f, v) {
    if (v === null || v === undefined) {
      if (f.notnull) throw sqlErr('SQL0407', `Null values not allowed in column or variable ${f.name}.`);
      return null;
    }
    switch (f.type) {
      case 'CHAR': case 'VARCHAR': {
        const s = isNum(v) ? String(v) : String(v);
        const t = f.type === 'CHAR' ? s.trimEnd() : s;
        if (t.length > f.len) throw sqlErr('SQL0404', `Value for column or variable ${f.name} too long.`);
        return t;
      }
      case 'DECIMAL': case 'INTEGER': {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (Number.isNaN(n) || (typeof v === 'string' && !v.trim())) {
          throw sqlErr('SQL0408', `Value for column or variable ${f.name} not compatible.`);
        }
        const scale = f.scale || 0;
        const r = Math.round(n * 10 ** scale) / 10 ** scale;
        if (Math.abs(r) >= 10 ** (f.len - scale)) throw sqlErr('SQL0406', `Conversion error on assignment to column ${f.name}.`);
        return r;
      }
      case 'DATE': {
        const s = String(v).trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) {
          throw sqlErr('SQL0180', `Syntax of date, time, or timestamp value not valid.`);
        }
        return s;
      }
      default: return String(v);
    }
  }

  insert(st) {
    const { obj, lib } = this.env.getTable(st.table.schema, st.table.name);
    const fields = obj.fields;
    const cols = st.cols ? st.cols.map((c) => {
      const i = fields.findIndex((f) => f.name === c);
      if (i < 0) throw sqlErr('SQL0206', `Column ${c} not in table ${obj.name} in ${lib}.`);
      return i;
    }) : fields.map((_, i) => i);
    const valueRows = st.select ? this.select(st.select, null).rows : st.rows.map((r) => r.map((e) => this.ev(e, null)));
    const newRows = valueRows.map((vals) => {
      if (vals.length !== cols.length) throw sqlErr('SQL0117', 'Statement contains wrong number of values.');
      const row = fields.map((f) => (f.dft !== undefined ? this.ev(f.dft, null) : f.notnull ? (f.type === 'CHAR' || f.type === 'VARCHAR' ? '' : 0) : null));
      cols.forEach((ci, k) => { row[ci] = vals[k]; });
      return row.map((v, i) => this.coerce(fields[i], v));
    });
    obj.rows.push(...newRows);
    this.env.changed?.();
    const n = newRows.length;
    return { type: 'count', count: n, message: `${n} row${n === 1 ? '' : 's'} inserted in ${obj.name} in ${lib}.` };
  }

  update(st) {
    const { obj, lib } = this.env.getTable(st.table.schema, st.table.name);
    const src = [{ alias: st.table.alias, name: obj.name, fields: obj.fields }];
    const sets = st.sets.map((s) => {
      const i = obj.fields.findIndex((f) => f.name === s.col);
      if (i < 0) throw sqlErr('SQL0206', `Column ${s.col} not in table ${obj.name} in ${lib}.`);
      return { i, expr: s.expr };
    });
    let n = 0;
    const updated = obj.rows.map((row) => {
      const ctx = this.ctxFor(src, [row], null);
      if (st.where && this.ev(st.where, ctx) !== true) return row;
      n++;
      const copy = row.slice();
      for (const s of sets) copy[s.i] = this.coerce(obj.fields[s.i], this.ev(s.expr, ctx));
      return copy;
    });
    if (!n) return { type: 'count', count: 0, message: 'Row not found for UPDATE.', warn: 'SQL0100' };
    obj.rows.splice(0, obj.rows.length, ...updated);
    this.env.changed?.();
    return { type: 'count', count: n, message: `${n} row${n === 1 ? '' : 's'} updated in ${obj.name} in ${lib}.` };
  }

  del(st) {
    const { obj, lib } = this.env.getTable(st.table.schema, st.table.name);
    const src = [{ alias: st.table.alias, name: obj.name, fields: obj.fields }];
    const keep = obj.rows.filter((row) => st.where && this.ev(st.where, this.ctxFor(src, [row], null)) !== true);
    const n = obj.rows.length - keep.length;
    if (!n) return { type: 'count', count: 0, message: 'Row not found for DELETE.', warn: 'SQL0100' };
    obj.rows.splice(0, obj.rows.length, ...keep);
    this.env.changed?.();
    return { type: 'count', count: n, message: `${n} row${n === 1 ? '' : 's'} deleted from ${obj.name} in ${lib}.` };
  }

  create(st) {
    let fields, rows = [];
    if (st.select) {
      const r = this.select(st.select, null);
      fields = r.columns.map((c) => ({ name: c.name.replace(/[^A-Z0-9_@#$]/g, '').slice(0, 10) || 'COL', type: c.type, len: c.len, scale: c.scale, heading: c.heading }));
      if (st.data) rows = r.rows;
    } else {
      fields = st.cols.map((c) => ({ ...c, heading: c.name }));
      const names = new Set();
      for (const f of fields) {
        if (names.has(f.name)) throw sqlErr('SQL0612', `${f.name} is a duplicate column name.`);
        names.add(f.name);
      }
    }
    const lib = this.env.createTable(st.table.schema, st.table.name, fields, rows);
    return { type: 'ddl', message: `Table ${st.table.name} created in ${lib}.` };
  }
}

// Type en breedte van een resultaatkolom
function describe(item, vals) {
  if (item.field) return { ...item.field, name: item.name, heading: item.name };
  const nn = vals.filter((v) => v !== null);
  if (nn.length && nn.every(isNum)) {
    const scale = Math.min(9, Math.max(0, ...nn.map((v) => (String(v).split('.')[1] || '').length)));
    const intLen = Math.max(1, ...nn.map((v) => String(Math.trunc(Math.abs(v))).length));
    return { name: item.name, heading: item.name, type: 'DECIMAL', len: Math.min(31, intLen + scale + 2), scale };
  }
  return { name: item.name, heading: item.name, type: 'CHAR', len: Math.max(1, ...nn.map((v) => String(v).length)) };
}

// Een waarde als tekst, zoals DB2 hem toont
export function fmtValue(v, col) {
  if (v === null || v === undefined) return '-';
  if (col && (col.type === 'DECIMAL' || col.type === 'INTEGER') && isNum(v)) {
    const s = (col.scale ? v.toFixed(col.scale) : String(Math.round(v))).replace(/^(-?)0\./, '$1.');
    return s;
  }
  if (isNum(v)) return String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

export function colWidth(col, rows, ci) {
  const vals = rows.map((r) => fmtValue(r[ci], col).length);
  const lenW = col.type === 'DECIMAL' || col.type === 'INTEGER' ? col.len + (col.scale ? 2 : 1) : col.len;
  return Math.min(60, Math.max(String(col.heading || col.name).length, lenW || 1, ...vals));
}

export const isNumericCol = (c) => c.type === 'DECIMAL' || c.type === 'INTEGER';
