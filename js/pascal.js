// Een kleine Pascal-compiler voor de PDP-11, bedoeld om mee te leren.
//
// Hij vertaalt een eenvoudig Pascal (ongeveer Pascal-S van Niklaus Wirth) naar
// leesbare MACRO-11-assembler, met de Pascal-regels als commentaar erbij.
//
// De taal:
//   program, const, type, var, procedure, function (niet genest), recursie
//   typen integer (16 bit), boolean, char en array [a..b] of ...
//   := if-then-else while-do repeat-until for-to/downto-do begin-end
//   + - * div mod and or not = <> < <= > >=
//   write, writeln, read, readln; ord, chr, odd, abs, sqr, succ, pred
//
// Hoe de code werkt:
//   - Een expressie komt in R0. Een tussenresultaat gaat op de stack (MOV R0,-(SP)).
//   - R5 is de framepointer van een procedure: parameters staan op 4(R5), 6(R5) ...,
//     lokale variabelen op -2(R5), -4(R5) ...
//   - Globale variabelen hebben een label V.NAAM, procedures P.NAAM.
//   - Fouten tijdens het draaien (overloop, deling door nul, index buiten de array,
//     stack vol) geven een EMT-trap; de runtime meldt dan de Pascal-regel.

export class PascalError extends Error {
  constructor(line, msg) {
    super(`regel ${line}: ${msg}`);
    this.line = line;
  }
}

const KEYWORDS = new Set([
  'program', 'const', 'type', 'var', 'procedure', 'function', 'begin', 'end',
  'if', 'then', 'else', 'while', 'do', 'repeat', 'until', 'for', 'to', 'downto',
  'div', 'mod', 'and', 'or', 'not', 'array', 'of',
]);

const UNSUPPORTED = {
  real: 'het type real (kommagetallen) kent deze compiler niet; de PDP-11/40 heeft hier geen floating point',
  record: 'records kent deze eenvoudige compiler niet',
  set: 'sets kent deze eenvoudige compiler niet',
  file: 'bestanden kent deze compiler niet; gebruik read en write',
  case: 'case kent deze compiler niet; gebruik if-then-else',
  goto: 'goto kent deze compiler niet',
  with: 'with kent deze compiler niet',
  string: 'het type string kent deze compiler niet; gebruik array [1..n] of char of zet tekst direct in write',
  forward: 'forward kent deze compiler niet',
};

// ---------- Lexer ----------

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const err = (msg) => { throw new PascalError(line, msg); };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{' || (c === '(' && src[i + 1] === '*')) {
      const close = c === '{' ? '}' : '*)';
      const start = line;
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new PascalError(start, `commentaar wordt niet afgesloten met ${close}`);
      for (let k = i; k < j; k++) if (src[k] === '\n') line++;
      i = j + close.length;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (/[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1])) err('kommagetallen (real) kent deze compiler niet');
      const v = Number(src.slice(i, j));
      if (v > 32767) err(`het getal ${src.slice(i, j)} is te groot: een integer gaat tot 32767`);
      toks.push({ t: 'num', v, line });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const low = word.toLowerCase();
      toks.push(KEYWORDS.has(low) ? { t: 'kw', v: low, line } : { t: 'id', v: low, name: word, line });
      i = j;
      continue;
    }
    if (c === "'") {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length || src[j] === '\n') err('tekst wordt niet afgesloten met een \'');
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      for (const ch of s) if (ch.charCodeAt(0) > 126) err(`het teken ${ch} kan de terminal niet tonen`);
      toks.push({ t: 'str', v: s, line });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if ([':=', '<=', '>=', '<>', '..'].includes(two)) { toks.push({ t: 'sym', v: two, line }); i += 2; continue; }
    if ('+-*=<>()[],;:.'.includes(c)) { toks.push({ t: 'sym', v: c, line }); i++; continue; }
    if (c === '/') err('delen gaat met div (geheel deel) en mod (rest); / is voor kommagetallen');
    if (c === '"') err("tekst zet je in Pascal tussen enkele aanhalingstekens: 'zo'");
    err(`onverwacht teken '${c}'`);
  }
  toks.push({ t: 'eof', v: 'einde van het programma', line });
  return toks;
}

// ---------- Typen ----------

const INT = { kind: 'integer' };
const BOOL = { kind: 'boolean' };
const CHAR = { kind: 'char' };

function typeName(t) {
  if (t.kind === 'array') return `array [${t.lo}..${t.hi}] of ${typeName(t.elem)}`;
  return t.kind;
}

function sameType(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'array') return true;
  return a.lo === b.lo && a.hi === b.hi && sameType(a.elem, b.elem);
}

const words = (t) => (t.kind === 'array' ? (t.hi - t.lo + 1) * words(t.elem) : 1);

// Offset ten opzichte van R5, octaal zoals gebruikelijk in MACRO-11
const off = (n) => (n < 0 ? '-' + (-n).toString(8) : n.toString(8));

// Een geldig label: alleen letters en cijfers
const asmName = (id) => id.toUpperCase().replace(/_/g, '.');

// ---------- Compiler ----------

class Compiler {
  constructor(src) {
    this.src = src;
    this.lines = src.split(/\r?\n/);
    this.toks = lex(src);
    this.p = 0;
    this.labels = 0;
    this.code = []; // huidige uitvoer
    this.mainCode = [];
    this.procCode = [];
    this.strings = [];
    this.globalData = [];
    this.globals = new Map();
    this.locals = null; // Map tijdens een procedure
    this.current = null; // procedure/functie die nu vertaald wordt
    this.lastComment = 0;
    this.predefined = new Map([
      ['integer', { kind: 'type', type: INT }],
      ['boolean', { kind: 'type', type: BOOL }],
      ['char', { kind: 'type', type: CHAR }],
      ['true', { kind: 'const', type: BOOL, value: 1 }],
      ['false', { kind: 'const', type: BOOL, value: 0 }],
      ['maxint', { kind: 'const', type: INT, value: 32767 }],
    ]);
  }

  // ---------- Tokens ----------

  get tok() { return this.toks[this.p]; }
  next() { return this.toks[this.p++]; }
  err(msg, line = this.tok.line) { throw new PascalError(line, msg); }
  isSym(s) { return this.tok.t === 'sym' && this.tok.v === s; }
  isKw(k) { return this.tok.t === 'kw' && this.tok.v === k; }
  shown(t = this.tok) {
    if (t.t === 'eof') return 'het einde van het programma';
    if (t.t === 'str') return `'${t.v}'`;
    return `"${t.name || t.v}"`;
  }
  sym(s, hint) {
    if (!this.isSym(s)) {
      if (s === ';' && this.p > 0) this.err(`${hint || `';' verwacht`} (na ${this.shown(this.toks[this.p - 1])})`, this.toks[this.p - 1].line);
      this.err(hint || `'${s}' verwacht in plaats van ${this.shown()}`);
    }
    return this.next();
  }
  kw(k, hint) {
    if (!this.isKw(k)) this.err(hint || `${k} verwacht in plaats van ${this.shown()}`);
    return this.next();
  }
  ident(what = 'een naam') {
    const t = this.tok;
    if (t.t !== 'id') {
      if (t.t === 'kw') this.err(`${t.v} is een gereserveerd woord en kan geen naam zijn`);
      this.err(`${what} verwacht in plaats van ${this.shown()}`);
    }
    if (UNSUPPORTED[t.v] && !this.lookup(t.v)) this.err(UNSUPPORTED[t.v]);
    return this.next();
  }

  // ---------- Uitvoer ----------

  emit(op, args = '', comment = '') {
    let s = `\t${op}`;
    if (args) s += `\t${args}`;
    if (comment) s += `${args.length < 8 ? '\t\t' : '\t'}; ${comment}`;
    this.code.push(s);
  }
  label(l) { this.code.push(`${l}:`); }
  newLabel() { return `L${++this.labels}`; }
  comment(text) { this.code.push(`; ${text}`); }

  // Zet de Pascal-regel als commentaar in de code en onthoud het regelnummer
  mark(line) {
    if (line !== this.lastComment) {
      this.code.push('');
      this.comment(`[${line}] ${this.lines[line - 1].trim()}`);
      this.lastComment = line;
    }
    this.emit('MOV', `#${line}.,R.LIN`);
  }

  // Spring naar `target` als R0 = 0 (onwaar). JMP kan overal heen, een branch maar 128 woorden.
  jumpIfFalse(target) {
    const skip = this.newLabel();
    this.emit('TST', 'R0');
    this.emit('BNE', skip);
    this.emit('JMP', target, 'onwaar');
    this.label(skip);
  }

  // ---------- Symbolen ----------

  lookup(name) {
    if (this.locals && this.locals.has(name)) return this.locals.get(name);
    if (this.globals.has(name)) return this.globals.get(name);
    return this.predefined.get(name);
  }

  declare(tok, entry) {
    const scope = this.locals || this.globals;
    if (scope.has(tok.v)) this.err(`${tok.name} is al eerder gedeclareerd`, tok.line);
    if (!this.locals && ['write', 'writeln', 'read', 'readln'].includes(tok.v)) this.err(`${tok.name} is een ingebouwde procedure`, tok.line);
    scope.set(tok.v, entry);
  }

  // ---------- Declaraties ----------

  constant() {
    let neg = false;
    if (this.isSym('-') || this.isSym('+')) neg = this.next().v === '-';
    const t = this.tok;
    if (t.t === 'num') { this.next(); return { type: INT, value: neg ? -t.v : t.v }; }
    if (t.t === 'str') {
      if (t.v.length !== 1 || neg) this.err('een constante tekst moet precies één teken zijn');
      this.next();
      return { type: CHAR, value: t.v.charCodeAt(0) };
    }
    if (t.t === 'id') {
      const e = this.lookup(t.v);
      if (!e || e.kind !== 'const') this.err(`${t.name} is geen constante`);
      this.next();
      if (neg && e.type !== INT) this.err('alleen een getal kan negatief zijn');
      return { type: e.type, value: neg ? -e.value : e.value };
    }
    this.err(`constante verwacht in plaats van ${this.shown()}`);
  }

  typeSpec() {
    if (this.isKw('array')) {
      this.next();
      this.sym('[', "'[' verwacht na array");
      const lo = this.constant();
      this.sym('..', "'..' verwacht tussen de grenzen, bijvoorbeeld [1..10]");
      const hi = this.constant();
      if (lo.type !== hi.type || lo.type === BOOL) this.err('de grenzen van een array zijn twee getallen of twee tekens');
      if (hi.value < lo.value) this.err('de bovengrens van de array is kleiner dan de ondergrens');
      if (hi.value - lo.value >= 8000) this.err('deze array is te groot voor het geheugen');
      if (this.isSym(',')) this.err('meerdimensionale arrays kent deze compiler niet; gebruik array [..] of array [..] of ...');
      this.sym(']');
      this.kw('of', "of verwacht, bijvoorbeeld array [1..10] of integer");
      const elem = this.typeSpec();
      return { kind: 'array', lo: lo.value, hi: hi.value, index: lo.type, elem };
    }
    const t = this.ident('een type (integer, boolean, char of array)');
    const e = this.lookup(t.v);
    if (!e || e.kind !== 'type') this.err(`${t.name} is geen type`, t.line);
    return e.type;
  }

  constDecls() {
    this.next();
    do {
      const name = this.ident();
      this.sym('=', "'=' verwacht: een constante declareer je als NAAM = waarde;");
      const c = this.constant();
      this.declare(name, { kind: 'const', ...c });
      this.sym(';');
    } while (this.tok.t === 'id');
  }

  typeDecls() {
    this.next();
    do {
      const name = this.ident();
      this.sym('=', "'=' verwacht: een type declareer je als NAAM = type;");
      this.declare(name, { kind: 'type', type: this.typeSpec() });
      this.sym(';');
    } while (this.tok.t === 'id');
  }

  varDecls() {
    this.next();
    do {
      const names = [this.ident()];
      while (this.isSym(',')) { this.next(); names.push(this.ident()); }
      if (this.isSym('=')) this.err("bij var gebruik je ':' en een type, bijvoorbeeld x: integer;");
      this.sym(':', "':' verwacht, bijvoorbeeld x, y: integer;");
      const type = this.typeSpec();
      for (const n of names) {
        if (this.locals) {
          this.frameSize += 2 * words(type);
          this.declare(n, { kind: 'var', type, where: 'local', offset: -this.frameSize });
        } else {
          const label = `V.${asmName(n.v)}`;
          this.declare(n, { kind: 'var', type, where: 'global', label });
          this.globalData.push(type.kind === 'array' ? `${label}:\t.BLKW\t${words(type)}.\t; ${n.name}: ${typeName(type)}` : `${label}:\t.WORD\t0\t; ${n.name}: ${typeName(type)}`);
        }
      }
      this.sym(';');
    } while (this.tok.t === 'id');
  }

  procDecl() {
    const isFunc = this.next().v === 'function';
    const name = this.ident(isFunc ? 'de naam van de functie' : 'de naam van de procedure');
    const params = [];
    if (this.isSym('(')) {
      this.next();
      for (;;) {
        let byRef = false;
        if (this.isKw('var')) { this.next(); byRef = true; }
        const names = [this.ident('de naam van een parameter')];
        while (this.isSym(',')) { this.next(); names.push(this.ident()); }
        this.sym(':', "':' en een type verwacht, bijvoorbeeld (n: integer)");
        if (this.isKw('array')) this.err('geef een array-parameter een eigen type: type rij = array [1..10] of integer; en dan (var a: rij)');
        const tt = this.ident('een type');
        const te = this.lookup(tt.v);
        if (!te || te.kind !== 'type') this.err(`${tt.name} is geen type`, tt.line);
        if (te.type.kind === 'array' && !byRef) this.err('een array kan alleen als var-parameter worden doorgegeven', tt.line);
        for (const n of names) params.push({ tok: n, type: te.type, byRef });
        if (this.isSym(';')) { this.next(); continue; }
        break;
      }
      this.sym(')');
    }
    let result = null;
    if (isFunc) {
      this.sym(':', "een functie heeft een resultaattype: function naam(...): integer;");
      result = this.typeSpec();
      if (result.kind === 'array') this.err('een functie kan geen array opleveren');
    }
    this.sym(';');
    const entry = { kind: isFunc ? 'func' : 'proc', params, result, label: `P.${asmName(name.v)}`, name: name.name };
    this.declare(name, entry);

    // Lokale scope
    this.locals = new Map();
    this.current = entry;
    this.frameSize = isFunc ? 2 : 0; // -2(R5) = resultaat van de functie
    params.forEach((pr, i) => {
      this.declare(pr.tok, { kind: 'var', type: pr.type, where: pr.byRef ? 'varparam' : 'param', offset: 4 + 2 * (params.length - 1 - i) });
    });
    for (;;) {
      if (this.isKw('const')) this.constDecls();
      else if (this.isKw('type')) this.typeDecls();
      else if (this.isKw('var')) this.varDecls();
      else if (this.isKw('procedure') || this.isKw('function')) this.err('een procedure binnen een procedure kent deze compiler niet; zet alle procedures bovenaan het programma');
      else break;
    }

    this.code = this.procCode;
    this.code.push('');
    this.comment(`---------- ${isFunc ? 'function' : 'procedure'} ${name.name} ----------`);
    for (const [n, e] of this.locals) {
      if (e.kind !== 'var') continue;
      const where = e.where === 'local' ? 'lokaal' : e.where === 'param' ? 'parameter' : 'var-parameter (adres)';
      this.comment(`  ${n.padEnd(10)} ${off(e.offset).padStart(4)}(R5)  ${where}, ${typeName(e.type)}`);
    }
    if (isFunc) this.comment(`  ${'resultaat'.padEnd(10)}   -2(R5)`);
    this.comment('  (offsets octaal; 0(R5) = oude R5, 2(R5) = terugkeeradres)');
    this.label(entry.label);
    this.emit('MOV', 'R5,-(SP)', 'oude framepointer bewaren');
    this.emit('MOV', 'SP,R5', 'nieuw frame');
    if (this.frameSize) {
      this.emit('SUB', `#${this.frameSize}.,SP`, 'ruimte voor lokale variabelen');
      this.emit('MOV', 'SP,R0', 'en die op 0 zetten');
      this.emit('MOV', `#${this.frameSize / 2}.,R1`);
      this.label('1$');
      this.emit('CLR', '(R0)+');
      this.emit('SOB', 'R1,1$');
    }
    this.emit('CMP', 'SP,#R.END+100', 'is er nog stackruimte?');
    this.emit('BHI', '.+4');
    this.emit('EMT', '4', 'nee: stack vol');

    this.kw('begin', `begin verwacht in plaats van ${this.shown()}`);
    this.statementList('end');
    this.kw('end');
    this.sym(';', `';' verwacht na het einde van ${name.name}`);

    this.lastComment = 0;
    this.code.push('');
    if (isFunc) this.emit('MOV', '-2(R5),R0', 'resultaat in R0');
    this.emit('MOV', 'R5,SP', 'lokale variabelen weg');
    this.emit('MOV', '(SP)+,R5', 'framepointer terug');
    this.emit('RTS', 'PC');
    this.locals = null;
    this.current = null;
  }

  // ---------- Programma ----------

  program() {
    let title = 'PASCAL';
    if (this.isKw('program')) {
      this.next();
      title = this.ident('de naam van het programma').name;
      if (this.isSym('(')) { // program naam(input, output);
        this.next();
        while (!this.isSym(')')) { if (this.tok.t === 'eof') this.err("')' verwacht"); this.next(); }
        this.next();
      }
      this.sym(';');
    }
    for (;;) {
      if (this.isKw('const')) this.constDecls();
      else if (this.isKw('type')) this.typeDecls();
      else if (this.isKw('var')) this.varDecls();
      else if (this.isKw('procedure') || this.isKw('function')) this.procDecl();
      else break;
    }
    this.code = this.mainCode;
    this.kw('begin', `begin verwacht in plaats van ${this.shown()}`);
    this.statementList('end');
    this.kw('end');
    if (!this.isSym('.')) this.err("een programma eindigt met 'end.' (met een punt)");
    this.next();
    if (this.tok.t !== 'eof') this.err('na end. hoort niets meer te staan');
    return this.assemble(title);
  }

  statementList(endKw) {
    this.statement();
    for (;;) {
      if (this.isSym(';')) { this.next(); this.statement(); continue; }
      if (this.isKw(endKw)) return;
      if (this.tok.t === 'eof') this.err(`${endKw} ontbreekt`);
      if (this.isKw('else')) this.err("vóór else hoort geen ';' te staan");
      this.err(`';' verwacht tussen twee opdrachten (na ${this.shown(this.toks[this.p - 1])})`, this.toks[this.p - 1].line);
    }
  }

  // ---------- Opdrachten ----------

  statement() {
    const t = this.tok;
    if (t.t === 'kw') {
      switch (t.v) {
        case 'begin': this.next(); this.statementList('end'); this.next(); return;
        case 'if': return this.ifStmt();
        case 'while': return this.whileStmt();
        case 'repeat': return this.repeatStmt();
        case 'for': return this.forStmt();
        case 'end': case 'until': case 'else': return; // lege opdracht
        default: this.err(`een opdracht kan niet beginnen met ${t.v}`);
      }
    }
    if (t.t === 'id') {
      const e = this.lookup(t.v);
      if (!e) {
        if (['write', 'writeln', 'read', 'readln'].includes(t.v)) return this.ioStmt();
        if (UNSUPPORTED[t.v]) this.err(UNSUPPORTED[t.v]);
        this.err(`onbekende naam ${t.name}: declareer hem eerst onder var`);
      }
      if (e.kind === 'proc') { this.mark(t.line); this.next(); this.call(e); return; }
      if (e.kind === 'var' || (e.kind === 'func' && e === this.current)) return this.assignment();
      if (e.kind === 'func') this.err(`${t.name} is een functie; gebruik de uitkomst, bijvoorbeeld x := ${t.name}(...)`);
      this.err(`aan ${t.name} kun je niets toekennen (het is een ${e.kind === 'const' ? 'constante' : 'type'})`);
    }
    if (t.t === 'eof' || this.isSym(';')) return;
    this.err(`opdracht verwacht in plaats van ${this.shown()}`);
  }

  assignment() {
    const t = this.tok;
    this.mark(t.line);
    const e = this.lookup(t.v);
    if (e.kind === 'func') {
      this.next();
      this.sym(':=', `':=' verwacht: het resultaat van een functie geef je met ${t.name} := ...`);
      const type = this.expression();
      this.check(type, e.result, `het resultaat van ${t.name}`);
      this.emit('MOV', 'R0,-2(R5)', `resultaat van ${t.name}`);
      return;
    }
    const target = this.variable();
    if (!this.isSym(':=')) {
      if (this.isSym('=')) this.err("toekennen gaat met ':=' (= is vergelijken)");
      this.err(`':=' verwacht na ${t.name}`);
    }
    this.next();
    if (target.type.kind === 'array') this.err('een hele array in één keer toekennen kan niet; doe het element voor element');
    if (target.indexed) this.emit('MOV', 'R0,-(SP)', 'adres van het element bewaren');
    const type = this.expression();
    this.check(type, target.type, t.name);
    if (target.indexed) {
      this.emit('MOV', '(SP)+,R1');
      this.emit('MOV', 'R0,(R1)', `${t.name}[...] := R0`);
    } else this.emit('MOV', `R0,${target.operand}`, `${t.name} := R0`);
  }

  check(got, want, what) {
    if (!sameType(got, want)) {
      let hint = '';
      if (want === CHAR && got === INT) hint = ' (gebruik chr(...))';
      if (want === INT && got === CHAR) hint = ' (gebruik ord(...))';
      this.err(`${what} is ${typeName(want)}, maar de waarde is ${typeName(got)}${hint}`);
    }
  }

  ifStmt() {
    this.mark(this.next().line);
    const els = this.newLabel();
    this.condition('if');
    this.kw('then', `then verwacht na de voorwaarde van if`);
    this.jumpIfFalse(els);
    this.statement();
    if (this.isKw('else')) {
      this.next();
      const end = this.newLabel();
      this.emit('JMP', end, 'else overslaan');
      this.label(els);
      this.statement();
      this.label(end);
    } else this.label(els);
  }

  whileStmt() {
    const line = this.next().line;
    const top = this.newLabel(), end = this.newLabel();
    this.label(top);
    this.mark(line);
    this.condition('while');
    this.kw('do', 'do verwacht na de voorwaarde van while');
    this.jumpIfFalse(end);
    this.statement();
    this.emit('JMP', top, 'terug naar de voorwaarde');
    this.label(end);
  }

  repeatStmt() {
    this.next();
    const top = this.newLabel();
    this.label(top);
    this.statementList('until');
    const line = this.next().line;
    this.mark(line);
    this.condition('until');
    this.jumpIfFalse(top);
  }

  condition(what) {
    const type = this.expression();
    if (type !== BOOL) this.err(`de voorwaarde van ${what} moet waar of onwaar zijn (boolean), niet ${typeName(type)}`);
  }

  forStmt() {
    const line = this.next().line;
    this.mark(line);
    const vt = this.ident('de naam van de tellervariabele');
    const e = this.lookup(vt.v);
    if (!e || e.kind !== 'var') this.err(`${vt.name} is geen variabele`, vt.line);
    if (e.type.kind === 'array' || e.type === BOOL) this.err('de teller van een for-lus is een integer of char', vt.line);
    const v = this.access(e);
    this.sym(':=', "':=' verwacht, bijvoorbeeld for i := 1 to 10 do");
    this.check(this.expression(), e.type, `de beginwaarde van ${vt.name}`);
    this.emit('MOV', `R0,${v}`, `${vt.name} := beginwaarde`);
    let down = false;
    if (this.isKw('downto')) down = true;
    else if (!this.isKw('to')) this.err('to of downto verwacht');
    this.next();
    this.check(this.expression(), e.type, `de eindwaarde van ${vt.name}`);
    this.kw('do', 'do verwacht na de eindwaarde');
    this.emit('MOV', 'R0,-(SP)', 'eindwaarde op de stack');
    const top = this.newLabel(), end = this.newLabel(), body = this.newLabel(), step = this.newLabel();
    this.label(top);
    this.emit('CMP', `${v},(SP)`, `${vt.name} ${down ? '<' : '>'} eindwaarde?`);
    this.emit(down ? 'BGE' : 'BLE', body);
    this.emit('JMP', end, 'ja: klaar');
    this.label(body);
    this.statement();
    this.emit('CMP', `${v},(SP)`, 'laatste keer geweest?');
    this.emit('BNE', step);
    this.emit('JMP', end);
    this.label(step);
    this.emit(down ? 'DEC' : 'INC', v, `volgende ${vt.name}`);
    this.emit('JMP', top);
    this.label(end);
    this.emit('TST', '(SP)+', 'eindwaarde van de stack');
  }

  // Operand voor een eenvoudige variabele (geen array-element)
  access(e) {
    switch (e.where) {
      case 'global': return e.label;
      case 'local': case 'param': return `${off(e.offset)}(R5)`;
      default: return `@${off(e.offset)}(R5)`;
    }
  }

  // Leest een variabele (met eventuele index). Bij een element staat het adres in R0.
  variable() {
    const t = this.next();
    const e = this.lookup(t.v);
    if (!e || e.kind !== 'var') this.err(`${t.name} is geen variabele`, t.line);
    if (!this.isSym('[')) return { type: e.type, operand: this.access(e), indexed: false, entry: e };
    if (e.type.kind !== 'array') this.err(`${t.name} is geen array`);
    let type = e.type;
    this.addressOf(e);
    while (this.isSym('[')) {
      if (type.kind !== 'array') this.err(`${t.name} heeft hier niet zoveel indexen`);
      this.next();
      this.emit('MOV', 'R0,-(SP)', 'beginadres bewaren');
      const it = this.expression();
      if (!sameType(it, type.index)) this.err(`de index van ${t.name} moet ${typeName(type.index)} zijn`);
      if (this.isSym(',')) this.err('schrijf a[i][j] in plaats van a[i,j]');
      this.sym(']');
      this.emit('CMP', `R0,#${type.lo}.`, 'index binnen de grenzen?');
      this.emit('BGE', '.+4');
      this.emit('EMT', '3', 'nee: te klein');
      this.emit('CMP', `R0,#${type.hi}.`);
      this.emit('BLE', '.+4');
      this.emit('EMT', '3', 'nee: te groot');
      if (type.lo !== 0) this.emit('SUB', `#${type.lo}.,R0`);
      const size = 2 * words(type.elem);
      if (size === 2) this.emit('ASL', 'R0', 'maal 2: een element is een woord');
      else {
        this.emit('MOV', 'R0,R1');
        this.emit('MUL', `#${size}.,R1`, 'maal de grootte van een element');
        this.emit('MOV', 'R1,R0');
      }
      this.emit('ADD', '(SP)+,R0', `adres van ${t.name}[...]`);
      type = type.elem;
    }
    return { type, indexed: true, entry: e };
  }

  // Adres van (het begin van) een variabele in R0
  addressOf(e) {
    switch (e.where) {
      case 'global': this.emit('MOV', `#${e.label},R0`); break;
      case 'local': case 'param':
        this.emit('MOV', 'R5,R0');
        this.emit('ADD', `#${off(e.offset)},R0`);
        break;
      default: this.emit('MOV', `${off(e.offset)}(R5),R0`, 'adres uit de var-parameter');
    }
  }

  // Aanroep van een procedure of functie; de naam is al gelezen
  call(e) {
    const args = [];
    if (this.isSym('(')) {
      this.next();
      for (;;) {
        args.push(this.tok);
        const pr = e.params[args.length - 1];
        if (!pr) this.err(`${e.name} heeft maar ${e.params.length} parameter${e.params.length === 1 ? '' : 's'}`);
        if (pr.byRef) {
          if (this.tok.t !== 'id' || this.lookup(this.tok.v)?.kind !== 'var') this.err(`parameter ${pr.tok.name} is een var-parameter: geef een variabele mee`);
          const name = this.tok.name;
          const target = this.variable();
          if (!target.indexed) this.addressOf(target.entry);
          this.check(target.type, pr.type, `parameter ${pr.tok.name}`);
          this.emit('MOV', 'R0,-(SP)', `adres van ${name} als parameter`);
        } else {
          this.check(this.expression(), pr.type, `parameter ${pr.tok.name}`);
          this.emit('MOV', 'R0,-(SP)', `parameter ${pr.tok.name}`);
        }
        if (this.isSym(',')) { this.next(); continue; }
        break;
      }
      this.sym(')', `')' of ',' verwacht in de aanroep van ${e.name}`);
    }
    if (args.length < e.params.length) this.err(`${e.name} verwacht ${e.params.length} parameter${e.params.length === 1 ? '' : 's'}, niet ${args.length}`);
    this.emit('JSR', `PC,${e.label}`, `roep ${e.name} aan`);
    if (args.length) this.emit('ADD', `#${2 * args.length}.,SP`, 'parameters van de stack');
  }

  // ---------- Invoer en uitvoer ----------

  stringLabel(s) {
    const label = `S${this.strings.length + 1}`;
    const delim = ['/', '"', '|', '!', '#', '%', '&', '*', '+', '='].find((d) => !s.includes(d));
    const body = s.length === 0 ? '0' : delim ? `${delim}${s}${delim}` : null;
    if (s.length === 0) this.strings.push(`${label}:\t.BYTE\t0`);
    else if (body) this.strings.push(`${label}:\t.ASCIZ\t${body}`);
    else this.strings.push(`${label}:\t.BYTE\t${[...s].map((c) => c.charCodeAt(0).toString(8)).join(',')},0`);
    return label;
  }

  ioStmt() {
    const t = this.next();
    this.mark(t.line);
    const name = t.v;
    if (name === 'write' || name === 'writeln') {
      if (this.isSym('(')) {
        this.next();
        for (;;) {
          this.writeArg();
          if (this.isSym(',')) { this.next(); continue; }
          break;
        }
        this.sym(')', `')' of ',' verwacht in ${name}`);
      } else if (name === 'write') this.err("write heeft iets nodig om af te drukken: write('tekst')");
      if (name === 'writeln') this.emit('JSR', 'PC,R.CRLF', 'nieuwe regel');
      return;
    }
    // read / readln
    if (this.isSym('(')) {
      this.next();
      for (;;) {
        if (this.tok.t !== 'id' || this.lookup(this.tok.v)?.kind !== 'var') this.err(`${name} leest in een variabele, bijvoorbeeld ${name}(x)`);
        const vname = this.tok.name;
        const target = this.variable();
        if (target.type !== INT && target.type !== CHAR) this.err(`${name} kan alleen een integer of char lezen`);
        if (target.indexed) this.emit('MOV', 'R0,-(SP)');
        this.emit('JSR', `PC,${target.type === INT ? 'R.RINT' : 'R.RCHR'}`, `lees ${target.type === INT ? 'een getal' : 'een teken'}`);
        if (target.indexed) { this.emit('MOV', '(SP)+,R1'); this.emit('MOV', 'R0,(R1)', `in ${vname}[...]`); }
        else this.emit('MOV', `R0,${target.operand}`, `in ${vname}`);
        if (this.isSym(',')) { this.next(); continue; }
        break;
      }
      this.sym(')');
    }
    if (name === 'readln') this.emit('JSR', 'PC,R.RLN', 'rest van de regel overslaan');
  }

  writeArg() {
    const t = this.tok;
    const width = () => {
      if (!this.isSym(':')) { this.emit('CLR', 'R1', 'geen breedte'); return; }
      this.next();
      this.emit('MOV', 'R0,-(SP)');
      if (this.expression() !== INT) this.err('de breedte achter : is een integer');
      if (this.isSym(':')) this.err('kommagetallen kent deze compiler niet; één : met een breedte is genoeg');
      this.emit('MOV', 'R0,R1', 'breedte');
      this.emit('MOV', '(SP)+,R0');
    };
    if (t.t === 'str' && t.v.length !== 1) {
      this.next();
      const label = this.stringLabel(t.v);
      this.emit('MOV', `#${label},R0`, `'${t.v.length > 30 ? t.v.slice(0, 30) + '...' : t.v}'`);
      width();
      this.emit('JSR', 'PC,R.WSTR', 'tekst afdrukken');
      return;
    }
    const type = this.expression();
    width();
    if (type === INT) this.emit('JSR', 'PC,R.WINT', 'getal afdrukken');
    else if (type === CHAR) this.emit('JSR', 'PC,R.WCHR', 'teken afdrukken');
    else if (type === BOOL) this.emit('JSR', 'PC,R.WBOL', 'TRUE of FALSE afdrukken');
    else this.err('een hele array kan write niet afdrukken; doe het element voor element');
  }

  // ---------- Expressies (resultaat in R0) ----------

  expression() {
    let type = this.simpleExpression();
    const ops = { '=': 'BEQ', '<>': 'BNE', '<': 'BLT', '<=': 'BLE', '>': 'BGT', '>=': 'BGE' };
    if (this.tok.t === 'sym' && ops[this.tok.v]) {
      const op = this.next().v;
      this.emit('MOV', 'R0,-(SP)', 'linkerkant bewaren');
      const right = this.simpleExpression();
      if (!sameType(type, right) || type.kind === 'array') this.err(`${typeName(type)} en ${typeName(right)} kun je niet vergelijken`);
      const yes = this.newLabel(), end = this.newLabel();
      this.emit('CMP', '(SP)+,R0', `links ${op} rechts?`);
      this.emit(ops[op], yes);
      this.emit('CLR', 'R0', 'onwaar');
      this.emit('BR', end);
      this.label(yes);
      this.emit('MOV', '#1,R0', 'waar');
      this.label(end);
      type = BOOL;
      if (this.tok.t === 'sym' && ops[this.tok.v]) this.err('twee vergelijkingen achter elkaar: zet haakjes, bijvoorbeeld (a < b) and (b < c)');
    }
    return type;
  }

  simpleExpression() {
    let neg = false;
    if (this.isSym('-') || this.isSym('+')) neg = this.next().v === '-';
    let type = this.term();
    if (neg) {
      if (type !== INT) this.err('alleen een getal kan negatief zijn');
      this.emit('NEG', 'R0');
      this.emit('BVC', '.+4', 'overloop?');
      this.emit('EMT', '1');
    }
    for (;;) {
      let op;
      if (this.isSym('+') || this.isSym('-')) op = this.tok.v;
      else if (this.isKw('or')) op = 'or';
      else return type;
      this.next();
      this.emit('MOV', 'R0,-(SP)', 'linkerkant bewaren');
      const right = this.term();
      if (op === 'or') {
        if (type !== BOOL || right !== BOOL) this.err('or werkt op waar/onwaar (boolean)');
        this.emit('BIS', '(SP)+,R0', 'or');
      } else {
        if (type !== INT || right !== INT) this.err(`${op} werkt op getallen (integer)${type === CHAR || right === CHAR ? '; gebruik ord en chr voor tekens' : ''}`);
        if (op === '+') this.emit('ADD', '(SP)+,R0', 'optellen');
        else {
          this.emit('MOV', 'R0,R1');
          this.emit('MOV', '(SP)+,R0');
          this.emit('SUB', 'R1,R0', 'aftrekken');
        }
        this.emit('BVC', '.+4', 'overloop?');
        this.emit('EMT', '1');
      }
    }
  }

  term() {
    let type = this.factor();
    for (;;) {
      let op;
      if (this.isSym('*')) op = '*';
      else if (this.isKw('div') || this.isKw('mod') || this.isKw('and')) op = this.tok.v;
      else return type;
      this.next();
      this.emit('MOV', 'R0,-(SP)', 'linkerkant bewaren');
      const right = this.factor();
      if (op === 'and') {
        if (type !== BOOL || right !== BOOL) this.err('and werkt op waar/onwaar (boolean)');
        this.emit('COM', 'R0');
        this.emit('BIC', 'R0,(SP)', 'and');
        this.emit('MOV', '(SP)+,R0');
        continue;
      }
      if (type !== INT || right !== INT) this.err(`${op} werkt op getallen (integer)`);
      if (op === '*') {
        this.emit('MOV', '(SP)+,R1');
        this.emit('MUL', 'R0,R1', 'vermenigvuldigen (R1 oneven: 16 bits)');
        this.emit('BCC', '.+4', 'past het in 16 bits?');
        this.emit('EMT', '1');
        this.emit('MOV', 'R1,R0');
      } else {
        this.emit('MOV', 'R0,R2', 'deler');
        this.emit('BNE', '.+4', 'delen door 0?');
        this.emit('EMT', '2');
        this.emit('MOV', '(SP)+,R1', 'deeltal in R0,R1 (32 bits)');
        this.emit('SXT', 'R0');
        this.emit('DIV', 'R2,R0', 'R0 = quotient, R1 = rest');
        this.emit('BVC', '.+4');
        this.emit('EMT', '1');
        if (op === 'mod') this.emit('MOV', 'R1,R0', 'de rest');
      }
    }
  }

  factor() {
    const t = this.tok;
    if (t.t === 'num') {
      this.next();
      this.emit('MOV', `#${t.v}.,R0`);
      return INT;
    }
    if (t.t === 'str') {
      if (t.v.length !== 1) this.err(t.v.length ? 'een tekst van meer tekens kan alleen in write staan' : "lege tekst '' kan hier niet");
      this.next();
      const code = t.v.charCodeAt(0);
      this.emit('MOV', `#${code}.,R0`, `'${t.v}'`);
      return CHAR;
    }
    if (this.isSym('(')) {
      this.next();
      const type = this.expression();
      this.sym(')', "')' ontbreekt");
      return type;
    }
    if (this.isKw('not')) {
      this.next();
      if (this.factor() !== BOOL) this.err('not werkt op waar/onwaar (boolean)');
      this.emit('MOV', '#1,R1');
      this.emit('XOR', 'R1,R0', 'not');
      return BOOL;
    }
    if (t.t === 'id') {
      const e = this.lookup(t.v);
      if (!e) {
        if (BUILTIN_FUNCS[t.v]) return this.builtin(t.v);
        if (UNSUPPORTED[t.v]) this.err(UNSUPPORTED[t.v]);
        this.err(`onbekende naam ${t.name}`);
      }
      if (e.kind === 'const') {
        this.next();
        if (e.value === 0) this.emit('CLR', 'R0', t.name);
        else this.emit('MOV', `#${e.value}.,R0`, t.name);
        return e.type;
      }
      if (e.kind === 'var') {
        const v = this.variable();
        if (v.type.kind === 'array') this.err(`gebruik een element van ${t.name}, bijvoorbeeld ${t.name}[1]`);
        if (v.indexed) this.emit('MOV', '(R0),R0', `${t.name}[...]`);
        else this.emit('MOV', `${v.operand},R0`, t.name);
        return v.type;
      }
      if (e.kind === 'func') {
        this.next();
        this.call(e);
        return e.result;
      }
      if (e.kind === 'proc') this.err(`${t.name} is een procedure en levert geen waarde op`);
      this.err(`${t.name} is een type, geen waarde`);
    }
    this.err(`waarde verwacht in plaats van ${this.shown()}`);
  }

  builtin(name) {
    const t = this.next();
    this.sym('(', `'(' verwacht na ${t.name}`);
    const type = this.expression();
    this.sym(')', `')' verwacht na ${t.name}(...`);
    const need = (ok, what) => { if (!ok) this.err(`${t.name} werkt op ${what}, niet op ${typeName(type)}`, t.line); };
    switch (name) {
      case 'ord':
        need(type === CHAR || type === BOOL || type === INT, 'een char of boolean');
        return INT;
      case 'chr':
        need(type === INT, 'een getal');
        this.emit('BIT', '#177600,R0', 'chr: tussen 0 en 127?');
        this.emit('BEQ', '.+4');
        this.emit('EMT', '6');
        return CHAR;
      case 'odd':
        need(type === INT, 'een getal');
        this.emit('BIC', '#177776,R0', 'odd: alleen het laagste bit');
        return BOOL;
      case 'abs':
        need(type === INT, 'een getal');
        this.emit('TST', 'R0');
        this.emit('BPL', '.+10', 'positief: klaar');
        this.emit('NEG', 'R0');
        this.emit('BVC', '.+4');
        this.emit('EMT', '1');
        return INT;
      case 'sqr':
        need(type === INT, 'een getal');
        this.emit('MOV', 'R0,R1');
        this.emit('MUL', 'R0,R1', 'kwadraat');
        this.emit('BCC', '.+4');
        this.emit('EMT', '1');
        this.emit('MOV', 'R1,R0');
        return INT;
      default: // succ, pred
        need(type === INT || type === CHAR, 'een getal of teken');
        this.emit(name === 'succ' ? 'INC' : 'DEC', 'R0');
        this.emit('BVC', '.+4');
        this.emit('EMT', '1');
        return type;
    }
  }

  // ---------- Alles samenvoegen ----------

  assemble(title) {
    const out = [];
    const L = (s = '') => out.push(s);
    L(`\t.TITLE\t${asmName(title).slice(0, 30)}`);
    L(`; Gemaakt door de Pascal-compiler van deze emulator.`);
    L('; Elke Pascal-regel staat als commentaar boven de code die hij oplevert.');
    L('; Expressies komen in R0, tussenresultaten op de stack; R5 is de framepointer.');
    L('');
    L('\t. = 4');
    L('\t.WORD\tR.BUS,0\t\t; busfout');
    L('\t.WORD\tR.BUS,0\t\t; ongeldige instructie');
    L('\t. = 30');
    L('\t.WORD\tR.EMT,0\t\t; EMT: fout tijdens het draaien');
    L('');
    L('\t. = 1000');
    L('START:\tMOV\t#160000,SP\t; stack begint bovenaan het geheugen');
    L('\tMOV\t#D.BEGIN,R0\t; variabelen op 0 zetten');
    L('1$:\tCLR\t(R0)+');
    L('\tCMP\tR0,#R.END');
    L('\tBLO\t1$');
    out.push(...this.mainCode);
    L('');
    L('\tJMP\tR.EXIT\t\t; klaar');
    out.push(...this.procCode);
    L('');
    out.push(RUNTIME);
    L('');
    L('; ---------- Teksten ----------');
    out.push(...this.strings);
    L('');
    L('; ---------- Variabelen ----------');
    L('\t.EVEN');
    L('D.BEGIN:');
    L('R.LIN:\t.WORD\t0\t\t; huidige Pascal-regel');
    L('R.LAST:\t.WORD\t0\t\t; laatst gelezen teken');
    L('R.BUF:\t.BLKB\t8.\t\t; voor het afdrukken van getallen');
    out.push(...this.globalData);
    L('R.END:');
    L('\t.END\tSTART');
    return out.join('\n') + '\n';
  }
}

const BUILTIN_FUNCS = { ord: 1, chr: 1, odd: 1, abs: 1, sqr: 1, succ: 1, pred: 1 };

// Runtime-bibliotheek: in- en uitvoer en foutmeldingen
const RUNTIME = `; ========== Runtime-bibliotheek ==========

R.EXIT:	JSR	PC,R.CRLF
R.STOP:	TSTB	@#177564	; wacht tot het laatste teken verstuurd is
	BPL	R.STOP
	HALT			; programma klaar
	BR	R.STOP

; R0 = teken naar de terminal
R.PUTC:	TSTB	@#177564	; terminal klaar?
	BPL	R.PUTC
	MOVB	R0,@#177566
	RTS	PC

R.CRLF:	MOV	#15,R0
	JSR	PC,R.PUTC
	MOV	#12,R0
	BR	R.PUTC

; R1 = gewenste breedte, R2 = lengte: spaties ervoor
R.PAD:	SUB	R2,R1
	BLE	2$
1$:	MOV	#40,R0
	JSR	PC,R.PUTC
	SOB	R1,1$
2$:	RTS	PC

; teken in R0, breedte in R1
R.WCHR:	MOV	R0,-(SP)
	MOV	#1,R2
	JSR	PC,R.PAD
	MOV	(SP)+,R0
	BR	R.PUTC

; tekst (eindigt op 0) op adres R0, breedte in R1
R.WSTR:	MOV	R0,R3
	MOV	R0,R4
	CLR	R2		; lengte tellen
1$:	TSTB	(R4)+
	BEQ	2$
	INC	R2
	BR	1$
2$:	JSR	PC,R.PAD
3$:	MOVB	(R3)+,R0
	BEQ	4$
	JSR	PC,R.PUTC
	BR	3$
4$:	RTS	PC

; boolean in R0 (0 of 1), breedte in R1
R.WBOL:	TST	R0
	BEQ	1$
	MOV	#R.STRU,R0
	BR	R.WSTR
1$:	MOV	#R.SFAL,R0
	BR	R.WSTR

; integer in R0, breedte in R1. Cijfers van achter naar voren met DIV.
R.WINT:	MOV	R1,-(SP)	; breedte bewaren
	MOV	#R.BUF+7,R3
	CLRB	(R3)
	MOV	R0,R4		; teken onthouden
	BPL	1$
	NEG	R0
1$:	MOV	R0,R1		; R0,R1 = getal (32 bits, positief)
	CLR	R0
	DIV	#10.,R0		; R0 = getal / 10, R1 = laatste cijfer
	ADD	#'0,R1
	MOVB	R1,-(R3)
	TST	R0
	BNE	1$
	TST	R4
	BPL	2$
	MOVB	#'-,-(R3)
2$:	MOV	R3,R0
	MOV	(SP)+,R1
	BR	R.WSTR

; wacht op een toets; R0 = teken (zonder echo)
R.KEY:	TSTB	@#177560
	BPL	R.KEY
	MOVB	@#177562,R0
	BIC	#177600,R0
	RTS	PC

; lees een teken met echo; Enter geeft 13
R.RCHR:	JSR	PC,R.KEY
	MOV	R0,R.LAST
	CMP	R0,#15
	BEQ	1$
	JSR	PC,R.PUTC
	MOV	R.LAST,R0
	RTS	PC
1$:	JSR	PC,R.CRLF
	MOV	#15,R0
	RTS	PC

; lees een geheel getal met echo; backspace werkt
R.RINT:	CLR	R3		; waarde
	CLR	R4		; 1 = negatief
	CLR	R2		; aantal cijfers
1$:	JSR	PC,R.KEY
	CMP	R0,#'0
	BLO	3$
	CMP	R0,#'9
	BHI	3$
	MOV	R0,-(SP)	; een cijfer
	JSR	PC,R.PUTC
	MOV	(SP)+,R0
	SUB	#'0,R0
	MUL	#10.,R3
	BCS	9$
	ADD	R0,R3
	BVS	9$
	INC	R2
	BR	1$
3$:	CMP	R0,#'-
	BNE	4$
	TST	R2		; min alleen vooraan
	BNE	1$
	TST	R4
	BNE	1$
	INC	R4
	JSR	PC,R.PUTC
	BR	1$
4$:	CMP	R0,#177		; delete of backspace
	BEQ	5$
	CMP	R0,#10
	BNE	6$
5$:	TST	R2
	BEQ	7$
	DEC	R2
	MOV	R3,R1		; laatste cijfer weg
	CLR	R0
	DIV	#10.,R0
	MOV	R0,R3
	BR	8$
7$:	TST	R4
	BEQ	1$
	CLR	R4
8$:	MOV	#10,R0
	JSR	PC,R.PUTC
	BR	1$
6$:	TST	R2		; nog geen cijfers: wachten
	BEQ	1$
	MOV	R0,R.LAST
	CMP	R0,#15
	BNE	10$
	JSR	PC,R.CRLF
	BR	11$
10$:	JSR	PC,R.PUTC
11$:	MOV	R3,R0
	TST	R4
	BEQ	12$
	NEG	R0
12$:	RTS	PC
9$:	EMT	5		; getal te groot

; readln: sla de rest van de regel over
R.RLN:	CMP	R.LAST,#15
	BEQ	2$
1$:	JSR	PC,R.RCHR
	CMP	R0,#15
	BNE	1$
2$:	CLR	R.LAST
	RTS	PC

; ---------- Fouten tijdens het draaien ----------
R.BUS:	MOV	#R.MBUS,-(SP)
	BR	R.FOUT
R.EMT:	MOV	(SP),R1		; adres na de EMT-instructie
	MOV	-2(R1),R1	; de EMT-instructie zelf
	BIC	#177400,R1	; het foutnummer
	ASL	R1
	MOV	R.MSGS-2(R1),-(SP)
R.FOUT:	JSR	PC,R.CRLF
	MOV	#R.SFOU,R0
	CLR	R1
	JSR	PC,R.WSTR
	MOV	R.LIN,R0
	CLR	R1
	JSR	PC,R.WINT
	MOV	#R.SDUB,R0
	CLR	R1
	JSR	PC,R.WSTR
	MOV	(SP)+,R0
	CLR	R1
	JSR	PC,R.WSTR
	JSR	PC,R.CRLF
	JMP	R.STOP

R.MSGS:	.WORD	R.M1,R.M2,R.M3,R.M4,R.M5,R.M6
R.M1:	.ASCIZ	/rekenoverloop: de uitkomst past niet in een integer (-32768..32767)/
R.M2:	.ASCIZ	/deling door nul/
R.M3:	.ASCIZ	/index buiten de grenzen van de array/
R.M4:	.ASCIZ	/stack vol (oneindige recursie?)/
R.M5:	.ASCIZ	/ingetypt getal te groot/
R.M6:	.ASCIZ	/chr: getal niet tussen 0 en 127/
R.MBUS:	.ASCIZ	/interne fout (busfout of ongeldige instructie)/
R.SFOU:	.ASCIZ	/*** fout op regel /
R.SDUB:	.ASCIZ	/: /
R.STRU:	.ASCIZ	/TRUE/
R.SFAL:	.ASCIZ	/FALSE/`;

// Vertaal Pascal naar MACRO-11. Gooit PascalError bij een fout.
export function compilePascal(src) {
  return new Compiler(src).program();
}
