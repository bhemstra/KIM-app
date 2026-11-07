// CL-programma's: compileren (bron → lijst van opdrachten met sprongen) en
// uitvoeren. De uitvoering is een generator, zodat een programma kan wachten
// op de gebruiker (SNDUSRMSG) of op een scherm dat het opent (bijv. WRKSPLF).
import { CpfError, parseCommand, splitTop, evalExpr, normVal, parseQual, quote, isTrue, asStr, asNum } from './cl.js';

// Opdrachten die alleen in een CL-programma bestaan
export const CL_ONLY = new Set(['PGM', 'ENDPGM', 'DCL', 'CHGVAR', 'IF', 'ELSE', 'DO', 'ENDDO', 'DOWHILE',
  'DOUNTIL', 'DOFOR', 'LEAVE', 'ITERATE', 'GOTO', 'RETURN', 'MONMSG', 'SELECT', 'WHEN', 'OTHERWISE',
  'ENDSELECT', 'SNDPGMMSG', 'SNDUSRMSG', 'RTVJOBA', 'RTVSYSVAL']);

// Haalt commentaar weg (buiten aanhalingstekens) en houdt de regelindeling intact
function stripComments(text) {
  let out = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!q && c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? text.length : j + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end - 1;
      continue;
    }
    if (c === "'") q = !q;
    // Een tekst tussen aanhalingstekens loopt alleen door na een + of -
    if (c === '\n' && !/[+-]\s*$/.test(out.slice(out.lastIndexOf('\n') + 1))) q = false;
    out += c;
  }
  return out;
}

// Bronregels → opdrachten. Een regel die eindigt op + of - loopt door.
export function splitStatements(lines) {
  const clean = stripComments(lines.map((l) => (typeof l === 'string' ? l : l.data)).join('\n')).split('\n');
  const st = [];
  let cur = '';
  let start = -1;
  clean.forEach((raw, i) => {
    let l = raw.trimEnd();
    if (!l.trim() && !cur) return;
    if (start < 0) start = i;
    const cont = /[+-]$/.test(l) && !/^\s*$/.test(l);
    if (cont) {
      const plus = l.endsWith('+');
      l = l.slice(0, -1);
      cur += l + '\u0000' + (plus ? '+' : '-');
      return;
    }
    cur += l;
    // Bij '+' worden de spaties aan het begin van de volgende regel weggelaten
    cur = cur.replace(/\u0000\+\s*/g, '').replace(/\u0000-/g, '');
    if (cur.trim()) st.push({ text: cur.trim(), line: start });
    cur = '';
    start = -1;
  });
  if (cur.trim()) st.push({ text: cur.replace(/\u0000[+-]\s*/g, '').trim(), line: start });
  return st;
}

function param(cmd, kw, pos = -1) {
  const p = cmd.params.find((x) => x.kw === kw);
  if (p) return p.raw;
  if (pos >= 0) {
    const positional = cmd.params.filter((x) => !x.kw);
    if (positional[pos] !== undefined) return positional[pos].raw;
  }
  return undefined;
}

const VAR_RE = /^&[A-Z@#$][A-Z0-9@#$_]{0,9}$/;

function parseDcl(cmd) {
  const v = (param(cmd, 'VAR', 0) || '').toUpperCase();
  if (!VAR_RE.test(v)) throw new CpfError('CPD0702', `Variable name ${v || '(none)'} not valid.`);
  const type = (param(cmd, 'TYPE', 1) || '').toUpperCase();
  if (!['*CHAR', '*DEC', '*LGL', '*INT', '*UINT'].includes(type)) throw new CpfError('CPD0745', `Type ${type || '(none)'} not valid for variable ${v}.`);
  const lenRaw = param(cmd, 'LEN', 2);
  const lenParts = lenRaw ? splitTop(lenRaw).map(Number) : [];
  const d = { name: v, type };
  if (type === '*CHAR') d.len = lenParts[0] || 32;
  else if (type === '*DEC') { d.len = lenParts[0] || 15; d.scale = lenParts[1] ?? (lenParts[0] ? 0 : 5); }
  else if (type === '*LGL') d.len = 1;
  else d.len = lenParts[0] || 4;
  const val = param(cmd, 'VALUE', 3);
  d.init = val === undefined ? null : val;
  return d;
}

// Compileert een CL-bronbestand. Geeft { code, vars, parms, errors }.
export function compileCL(lines, knownCommand = () => true) {
  const st = [];
  const errors = [];
  for (const s of splitStatements(lines)) {
    try {
      const c = parseCommand(s.text);
      c.line = s.line;
      c.text = s.text;
      st.push(c);
    } catch (e) {
      errors.push({ line: s.line, id: e.id || 'CPD0000', text: e.message });
    }
  }

  const code = [];
  const vars = {};
  const labels = {};
  const gotos = [];
  const globalMon = [];
  const loops = [];
  let parms = [];
  let pos = 0;
  let lastCmd = null;
  let executable = false;
  let ended = false;

  const err = (c, id, text) => errors.push({ line: c.line, id, text });
  const emit = (op) => { code.push(op); return op; };

  function block(c, ends) {
    while (pos < st.length) {
      const s = st[pos];
      if (ends.includes(s.name)) { pos++; return s; }
      pos++;
      stmt(s);
    }
    err(c, 'CPD0723', `${ends.join(' or ')} missing for ${c.name}.`);
    return null;
  }

  function inner(text, parent) {
    if (text === undefined || text === '') return;
    let c;
    try { c = parseCommand(text); } catch (e) { err(parent, e.id, e.message); return; }
    c.line = parent.line;
    c.text = text;
    stmt(c);
  }

  function loopEnd(loop) {
    for (const j of loop.brk) j.to = code.length;
  }

  function stmt(c) {
    if (c.label) {
      if (labels[c.label] !== undefined) err(c, 'CPD0726', `Label ${c.label} defined more than once.`);
      labels[c.label] = code.length;
    }
    if (!c.name) return;
    if (ended) err(c, 'CPD0710', 'Command after ENDPGM not allowed.');
    const prevCmd = lastCmd;
    lastCmd = null;
    switch (c.name) {
      case 'PGM': {
        const p = param(c, 'PARM', 0);
        parms = p ? splitTop(p).map((x) => x.toUpperCase()) : [];
        return;
      }
      case 'ENDPGM':
        emit({ op: 'ret' });
        ended = true;
        return;
      case 'DCL':
        if (executable) err(c, 'CPD0729', 'DCL command not allowed after executable commands.');
        try {
          const d = parseDcl(c);
          if (vars[d.name]) err(c, 'CPD0725', `Variable ${d.name} declared more than once.`);
          vars[d.name] = d;
        } catch (e) { err(c, e.id, e.message); }
        return;
      case 'IF': {
        executable = true;
        const cond = param(c, 'COND', 0);
        if (!cond) { err(c, 'CPD0071', 'Parameter COND required.'); return; }
        const jf = emit({ op: 'jf', expr: cond, line: c.line });
        inner(param(c, 'THEN', 1), c);
        if (st[pos]?.name === 'ELSE') {
          const e = st[pos++];
          const j = emit({ op: 'jmp' });
          jf.to = code.length;
          if (e.label) labels[e.label] = code.length;
          inner(param(e, 'CMD', 0), e);
          j.to = code.length;
        } else jf.to = code.length;
        return;
      }
      case 'ELSE':
        err(c, 'CPD0718', 'ELSE command not after IF command.');
        return;
      case 'DO':
        block(c, ['ENDDO']);
        return;
      case 'DOWHILE': {
        executable = true;
        const start = code.length;
        const jf = emit({ op: 'jf', expr: param(c, 'COND', 0) || "'0'", line: c.line });
        const loop = { brk: [jf], cont: [] };
        loops.push(loop);
        block(c, ['ENDDO']);
        loops.pop();
        for (const j of loop.cont) j.to = start;
        emit({ op: 'jmp', to: start });
        loopEnd(loop);
        return;
      }
      case 'DOUNTIL': {
        executable = true;
        const start = code.length;
        const loop = { brk: [], cont: [] };
        loops.push(loop);
        block(c, ['ENDDO']);
        loops.pop();
        for (const j of loop.cont) j.to = code.length;
        emit({ op: 'jf', expr: param(c, 'COND', 0) || "'1'", to: start, line: c.line });
        loopEnd(loop);
        return;
      }
      case 'DOFOR': {
        executable = true;
        const v = (param(c, 'VAR', 0) || '').toUpperCase();
        const from = param(c, 'FROM', 1) || '1';
        const to = param(c, 'TO', 2) || '1';
        const by = Number(param(c, 'BY', 3) || 1);
        emit({ op: 'set', var: v, expr: from, line: c.line });
        const start = code.length;
        const jf = emit({ op: 'jf', expr: `(${v} ${by >= 0 ? '*LE' : '*GE'} ${to})`, line: c.line });
        const loop = { brk: [jf], cont: [] };
        loops.push(loop);
        block(c, ['ENDDO']);
        loops.pop();
        for (const j of loop.cont) j.to = code.length;
        emit({ op: 'set', var: v, expr: `${v} + (${by})`, line: c.line });
        emit({ op: 'jmp', to: start });
        loopEnd(loop);
        return;
      }
      case 'LEAVE':
      case 'ITERATE': {
        const loop = loops.at(-1);
        if (!loop) { err(c, 'CPD0730', `${c.name} not inside a DOWHILE, DOUNTIL or DOFOR group.`); return; }
        const j = emit({ op: 'jmp' });
        (c.name === 'LEAVE' ? loop.brk : loop.cont).push(j);
        return;
      }
      case 'SELECT': {
        executable = true;
        const ends = [];
        for (;;) {
          const s = st[pos++];
          if (!s) { err(c, 'CPD0723', 'ENDSELECT missing for SELECT.'); break; }
          if (s.label) labels[s.label] = code.length;
          if (s.name === 'ENDSELECT') break;
          if (s.name === 'WHEN') {
            const jf = emit({ op: 'jf', expr: param(s, 'COND', 0) || "'0'", line: s.line });
            inner(param(s, 'THEN', 1), s);
            ends.push(emit({ op: 'jmp' }));
            jf.to = code.length;
          } else if (s.name === 'OTHERWISE') {
            inner(param(s, 'CMD', 0), s);
          } else err(s, 'CPD0731', `${s.name} not valid inside SELECT group.`);
        }
        for (const j of ends) j.to = code.length;
        return;
      }
      case 'WHEN':
      case 'OTHERWISE':
      case 'ENDSELECT':
      case 'ENDDO':
        err(c, 'CPD0731', `${c.name} command not valid here.`);
        return;
      case 'GOTO': {
        executable = true;
        const l = normVal(param(c, 'CMDLBL', 0) || '');
        gotos.push({ op: emit({ op: 'jmp', line: c.line }), label: l, c });
        return;
      }
      case 'RETURN':
        executable = true;
        emit({ op: 'ret' });
        return;
      case 'MONMSG': {
        const ids = splitTop(param(c, 'MSGID', 0) || '').map((x) => x.toUpperCase());
        const exec = param(c, 'EXEC', 2);
        const target = prevCmd || (!executable ? 'global' : null);
        if (!target) { err(c, 'CPD0717', 'MONMSG command not after a command that can be monitored.'); return; }
        const skip = emit({ op: 'jmp' });
        const mon = { ids, handler: code.length, global: target === 'global' };
        const wasExecutable = executable;
        inner(exec, c);
        if (target === 'global') executable = wasExecutable;
        emit(target === 'global' ? { op: 'resume' } : { op: 'jmp', ref: skip });
        skip.to = code.length;
        if (target === 'global') globalMon.push(mon);
        else {
          if (!exec) mon.handler = null;
          target.mon.push(mon);
          lastCmd = target;
        }
        return;
      }
      default: {
        executable = true;
        if (!CL_ONLY.has(c.name) && !knownCommand(c.name)) {
          err(c, 'CPD0030', `Command ${c.name} in library *LIBL not found.`);
        }
        if (c.name === 'CHGVAR') {
          const v = (param(c, 'VAR', 0) || '').toUpperCase();
          const val = param(c, 'VALUE', 1);
          if (!VAR_RE.test(v)) err(c, 'CPD0702', `Variable name ${v} not valid.`);
          if (val === undefined) err(c, 'CPD0071', 'Parameter VALUE required.');
        }
        lastCmd = emit({ op: 'cmd', cmd: c, line: c.line, mon: [] });
      }
    }
  }

  while (pos < st.length) stmt(st[pos++]);
  if (!ended && st.length) emit({ op: 'ret' });

  // Sprongen naar het einde van een MONMSG-blok wijzen naar de opdracht na de MONMSG
  for (const op of code) if (op.ref) op.to = op.ref.to;
  for (const g of gotos) {
    if (labels[g.label] === undefined) err(g.c, 'CPD0715', `Label ${g.label} not defined.`);
    else g.op.to = labels[g.label];
  }

  // Gebruikte variabelen moeten gedeclareerd zijn
  for (const c of st) {
    const seen = new Set();
    const text = c.text.replace(/'(?:[^']|'')*'/g, "''");
    for (const m of text.matchAll(/&[A-Za-z@#$][A-Za-z0-9@#$_]*/g)) {
      const v = m[0].toUpperCase();
      if (!vars[v] && !seen.has(v)) {
        seen.add(v);
        err(c, 'CPD0727', `Variable ${v} referenced but not declared.`);
      }
    }
  }
  for (const p of parms) if (!vars[p]) errors.push({ line: 0, id: 'CPD0727', text: `Parameter ${p} not declared.` });

  errors.sort((a, b) => a.line - b.line);
  return { code, vars, parms, globalMon, errors };
}

// ---------- Uitvoeren ----------

function initVar(d) {
  const v = { ...d };
  if (d.type === '*CHAR') v.value = ''.padEnd(d.len);
  else if (d.type === '*LGL') v.value = '0';
  else v.value = 0;
  return v;
}

function assign(v, val) {
  if (v.type === '*CHAR') {
    v.value = asStr(val).slice(0, v.len).padEnd(v.len);
  } else if (v.type === '*LGL') {
    v.value = isTrue(val) || String(val).trim() === '1' ? '1' : '0';
  } else {
    let n = asNum(val);
    if (v.type === '*DEC') {
      const f = 10 ** v.scale;
      n = Math.round(n * f) / f;
      if (Math.abs(n) >= 10 ** (v.len - v.scale)) throw new CpfError('MCH1210', `Receiver value too small to hold result (${v.name}).`);
    } else n = Math.trunc(n);
    v.value = n;
  }
}

const monMatch = (ids, err) => {
  const id = err.id || 'CPF9999';
  return ids.some((m) => {
    if (m === id) return true;
    if (/0000$/.test(m)) return id.startsWith(m.slice(0, 3));
    if (/00$/.test(m)) return id.startsWith(m.slice(0, 5));
    return false;
  });
};

// env: {
//   exec(text) → resultaat van een systeemopdracht ({ msgs, panel, program })
//   call(qual, args) → generator van een ander programma
//   jobAttr(name), sysval(name)
// }
// Een yield { inquiry: tekst } wacht op een antwoord; { info: tekst } op Enter;
// { panel } toont een scherm en gaat verder als dat sluit.
export function* runProgram(pgm, args, env) {
  const vars = {};
  for (const d of Object.values(pgm.vars)) vars[d.name] = initVar(d);
  const getVar = (n) => {
    const v = vars[n];
    if (!v) throw new CpfError('CPD0727', `Variable ${n} not declared.`);
    return v.value;
  };
  for (const d of Object.values(pgm.vars)) {
    if (d.init !== null) assign(vars[d.name], evalExpr(d.init, getVar));
  }
  pgm.parms.forEach((p, i) => {
    if (args[i] !== undefined && vars[p]) assign(vars[p], args[i]);
  });

  const toCaller = [];
  let pc = 0;
  let resumeAt = null;
  let steps = 0;

  const val = (raw) => (raw === undefined ? undefined : evalExpr(raw, getVar));
  const setVar = (raw, value) => {
    if (!raw) return;
    const n = raw.trim().toUpperCase();
    if (!vars[n]) throw new CpfError('CPD0727', `Variable ${n} not declared.`);
    assign(vars[n], value);
  };

  // Vervangt variabelen in de parameters van een gewone opdracht
  const substitute = (cmd) => {
    const parts = [cmd.lib ? `${cmd.lib}/${cmd.name}` : cmd.name];
    for (const p of cmd.params) {
      let raw = p.raw;
      const plain = raw.replace(/'(?:[^']|'')*'/g, "''");
      if (/\*B?T?CAT|\|\||\|>|\|<|%[A-Z]+/i.test(plain)) {
        raw = quote(asStr(evalExpr(raw, getVar)));
      } else if (plain.includes('&')) {
        raw = raw.replace(/'(?:[^']|'')*'|&[A-Za-z@#$][A-Za-z0-9@#$_]*/g, (m) => {
          if (m.startsWith("'")) return m;
          const v = vars[m.toUpperCase()];
          if (!v) throw new CpfError('CPD0727', `Variable ${m.toUpperCase()} not declared.`);
          if (v.type === '*CHAR') {
            const s = v.value.trimEnd();
            return /^[A-Z@#$*][A-Z0-9@#$_.*]*$/.test(s) ? s : quote(s);
          }
          return String(v.value);
        });
      }
      parts.push(p.kw ? `${p.kw}(${raw})` : raw);
    }
    return parts.join(' ');
  };

  function* execCmd(c) {
    const p = (kw, pos) => param(c, kw, pos);
    switch (c.name) {
      case 'CHGVAR':
        setVar(p('VAR', 0), val(p('VALUE', 1)));
        return;
      case 'SNDPGMMSG': {
        let text = p('MSG', 0) !== undefined ? asStr(val(p('MSG', 0))) : '';
        const msgid = p('MSGID') ? normVal(p('MSGID')) : null;
        if (msgid && p('MSGDTA') !== undefined) text = asStr(val(p('MSGDTA')));
        const type = normVal(p('MSGTYPE') || '*INFO');
        if (type === '*ESCAPE') throw new CpfError(msgid || 'CPF9898', text.trimEnd());
        toCaller.push({ id: msgid, text: text.trimEnd(), type });
        return;
      }
      case 'SNDUSRMSG': {
        const text = asStr(val(p('MSG', 0)) ?? '').trimEnd();
        const type = normVal(p('MSGTYPE') || '*INQ');
        if (type === '*INFO') { yield { info: text }; return; }
        const valuesRaw = p('VALUES');
        const allowed = valuesRaw ? splitTop(valuesRaw).map((x) => asStr(val(x)).trim().toUpperCase()) : null;
        const dft = p('DFT') !== undefined ? asStr(val(p('DFT'))) : '';
        let reply;
        for (;;) {
          reply = yield { inquiry: text + (allowed ? ` (${allowed.join(' ')})` : ''), upper: !!allowed };
          reply = String(reply ?? '').trim() || dft;
          if (!allowed || allowed.includes(reply.toUpperCase())) break;
        }
        setVar(p('MSGRPY'), allowed ? reply.toUpperCase() : reply);
        return;
      }
      case 'RTVJOBA':
        for (const prm of c.params) if (prm.kw) setVar(prm.raw, env.jobAttr(prm.kw));
        return;
      case 'RTVSYSVAL':
        setVar(p('RTNVAR', 1), env.sysval(normVal(p('SYSVAL', 0))));
        return;
      case 'CALL': {
        const q = parseQual(p('PGM', 0));
        const argRaw = p('PARM', 1);
        const a = argRaw ? splitTop(argRaw).map((x) => val(x)) : [];
        const r = yield* env.call(q, a);
        if (r?.length) toCaller.push(...r.filter((m) => m.type !== '*ESCAPE'));
        return;
      }
      default: {
        const r = env.exec(substitute(c));
        if (r?.panel) yield { panel: r.panel };
        if (r?.program) yield* r.program;
      }
    }
  }

  for (;;) {
    if (++steps > 200000) throw new CpfError('CPF9999', 'Program ended: too many statements (endless loop?).');
    const op = pgm.code[pc];
    if (!op) break;
    switch (op.op) {
      case 'ret': return toCaller;
      case 'jmp': pc = op.to; continue;
      case 'resume': pc = resumeAt ?? pc + 1; continue;
      case 'jf':
        pc = isTrue(val(op.expr)) ? pc + 1 : op.to;
        continue;
      case 'set':
        setVar(op.var, val(op.expr));
        pc++;
        continue;
      case 'cmd':
        try {
          yield* execCmd(op.cmd);
          pc++;
        } catch (e) {
          if (!(e instanceof CpfError)) throw e;
          const m = op.mon.find((x) => monMatch(x.ids, e)) || pgm.globalMon.find((x) => monMatch(x.ids, e));
          if (!m) {
            e.stmt = op.line;
            throw e;
          }
          env.joblog?.(e);
          if (m.global) { resumeAt = pc + 1; pc = m.handler; } else pc = m.handler ?? pc + 1;
        }
        continue;
      default:
        pc++;
    }
  }
  return toCaller;
}
