// De CL-commando's van het systeem: definities (voor de prompter en de
// controle van parameters) en wat ze doen.
import { CpfError, parseCommand, splitTop, normVal, parseQual, isName } from './cl.js';
import { CL_ONLY, compileCL, runProgram } from './clpgm.js';
import { newDataFile, newSourceFile, newMember, newObject, SYSVAL_TEXT, objKey } from './db.js';
import { SqlEngine } from './sql.js';
import { MenuPanel, MENUS, CmdEntryPanel, TextView, ConfirmPanel, dataPanel, tableLines, wrap } from './panels.js';
import {
  WrkActJobPanel, wrkJobPanel, WrkSysStsPanel, WrkSysValPanel, WrkUsrPrfPanel, WrkSplfPanel,
  DspMsgPanel, ChgPwdPanel, LibListPanel, ObjListPanel, MbrListPanel, WrkCmdPanel, SqlPanel,
} from './work.js';
import { SeuPanel } from './seu.js';

// ---------- Definities ----------

const P = (kw, label, len, o = {}) => ({ kw, label, len, kind: 'name', ...o });
const Q = (kw, label, o = {}) => P(kw, label, 10, { kind: 'qual', ...o });
const C = (kw, label, len, o = {}) => P(kw, label, len, { kind: 'char', ...o });
const TEXT = (dft = '*BLANK') => C('TEXT', "Text 'description'", 50, { dft, vals: [dft, '*BLANK'] });
const OUTPUT = P('OUTPUT', 'Output', 6, { dft: '*', vals: ['*', '*PRINT'], choices: '*, *PRINT' });

export const COMMANDS = {};

function def(name, desc, params, run, o = {}) {
  COMMANDS[name] = { name, desc, params, run, ...o };
}

export const knownCommand = (n) => !!COMMANDS[n];

// ---------- Hulpjes ----------

const ok = (text, id = null) => ({ msgs: [{ text, id }] });
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const lpad = (s, n) => String(s ?? '').padStart(n);

function secofr(ctx, cmd) {
  if (ctx.sys.state.users[ctx.job.user]?.cls !== '*SECOFR') {
    throw new CpfError('CPD0032', `Not authorized to command ${cmd}.`);
  }
}

function view(title, lines, o = {}) {
  return { panel: new TextView(title, lines, { fkeys: ['F3=Exit   F12=Cancel'], ...o }) };
}

function output(ctx, a, title, lines, spoolName, o = {}) {
  if (a.OUTPUT === '*PRINT') {
    ctx.sys.addSpool(ctx.job, spoolName, [`${title}`.padStart(40 + title.length / 2), `${ctx.sys.fmtDate()}  ${ctx.sys.fmtTime()}`, '', ...lines], o.userData || '');
    return ok(`Output written to spooled file ${spoolName}.`);
  }
  return view(title, lines, o);
}

function fileOf(ctx, q, kind) {
  let r;
  try { r = ctx.sys.getObj(q, '*FILE', ctx.job); } catch (e) {
    if (e.id === 'CPF2110') throw e;
    throw new CpfError('CPF9812', `File ${q.obj} in library ${q.lib} not found.`);
  }
  if (kind === 'src' && !r.obj.src) throw new CpfError('CPF7304', `File ${q.obj} in library ${r.lib} is not a source file.`);
  if (kind === 'data' && r.obj.src) throw new CpfError('CPF7304', `File ${q.obj} in library ${r.lib} is a source file.`);
  return r;
}

function memberOf(f, lib, mbr) {
  if (mbr === '*FIRST') {
    const names = Object.keys(f.members).sort();
    if (!names.length) throw new CpfError('CPF3141', `Member *FIRST not found in file ${f.name} in ${lib}.`);
    mbr = names[0];
  }
  const m = f.members[mbr];
  if (!m) throw new CpfError('CPF9815', `Member ${mbr} file ${f.name} in library ${lib} not found.`);
  return { m, name: mbr };
}

function objSize(o) {
  try { return Math.ceil((JSON.stringify(o).length + 2048) / 4096) * 4096; } catch { return 4096; }
}

// Een record zoals DSPPFM het toont: tekst aangevuld, getallen als "zoned"
function recordImage(fields, row) {
  return fields.map((f, i) => {
    const v = row[i];
    if (f.type === 'DECIMAL' || f.type === 'INTEGER') {
      const n = Math.abs(Math.round((v ?? 0) * 10 ** (f.scale || 0)));
      return String(n).padStart(f.len, '0').slice(-f.len);
    }
    return String(v ?? '').padEnd(f.len).slice(0, f.len);
  }).join('');
}

const recLen = (fields) => fields.reduce((a, f) => a + (f.type === 'VARCHAR' ? f.len + 2 : f.len), 0);

// ---------- SQL ----------

export function sqlRun(s, text) {
  const sys = s.sys, job = s.job;
  const env = {
    user: job.user,
    getTable(schema, name) {
      if (schema === 'SYSIBM' && name === 'SYSDUMMY1') {
        return { obj: { name, fields: [{ name: 'IBMREQD', type: 'CHAR', len: 1 }], rows: [['Y']] }, lib: 'SYSIBM' };
      }
      if (schema === 'QSYS2' && name === 'SYSTABLES') {
        const rows = [];
        for (const l of sys.allLibs(job)) {
          for (const o of Object.values(l.objs)) {
            if (o.type === '*FILE' && !o.src) rows.push([o.name, l.name, 'T', o.text, o.fields.length, o.rows.length]);
          }
        }
        return {
          obj: {
            name, rows, fields: [
              { name: 'TABLE_NAME', type: 'CHAR', len: 10 }, { name: 'TABLE_SCHEMA', type: 'CHAR', len: 10 },
              { name: 'TABLE_TYPE', type: 'CHAR', len: 1 }, { name: 'TABLE_TEXT', type: 'CHAR', len: 50 },
              { name: 'COLUMN_COUNT', type: 'INTEGER', len: 5, scale: 0 }, { name: 'NUMBER_ROWS', type: 'INTEGER', len: 9, scale: 0 },
            ],
          },
          lib: 'QSYS2',
        };
      }
      let r = null;
      try { r = sys.findObj({ lib: schema || '*LIBL', obj: name }, '*FILE', job); } catch { r = null; }
      if (!r || r.obj.src) throw new CpfError('SQL0204', `${name} in ${schema || '*LIBL'} type *FILE not found.`);
      return r;
    },
    createTable(schema, name, fields, rows) {
      if (!isName(name) || name.includes('.')) throw new CpfError('SQL0107', `${name} too long or not valid. Maximum length is 10 for a system name.`);
      const lib = sys.targetLib(schema || '*CURLIB', job);
      try { sys.lib(lib, job); } catch { throw new CpfError('SQL0204', `${lib} in *LIBL type *LIB not found.`); }
      if (sys.lib(lib, job).objs[objKey(name, '*FILE')]) throw new CpfError('SQL0601', `${name} in ${lib} type *FILE already exists.`);
      sys.putObj(lib, newDataFile(name, fields, '', rows), job);
      return lib;
    },
    dropTable(schema, name) {
      const r = env.getTable(schema, name);
      if (r.lib === 'SYSIBM' || r.lib === 'QSYS2') throw new CpfError('SQL0551', `Not authorized to object ${name} in ${r.lib} type *FILE.`);
      sys.delObj(r.lib, name, '*FILE', job);
      return { lib: r.lib };
    },
    createSchema(name) {
      try { sys.createLib(name, '*PROD', ''); } catch (e) { throw new CpfError('SQL0601', `${name} in QSYS type *LIB already exists.`); }
    },
    dropSchema(name) {
      try { sys.deleteLib(name); } catch (e) { throw new CpfError('SQL0204', `${name} in QSYS type *LIB not found.`); }
    },
  };
  return new SqlEngine(env).run(text);
}

// ---------- Programma's ----------

export const SIGNOFF = { signoff: true };

export function programGen(s, obj, args) {
  const compiled = compileCL(obj.source || [], knownCommand);
  if (compiled.errors.length) throw new CpfError('CPF0C33', `Program ${obj.name} has errors; compile it again.`);
  const env = {
    exec(text) {
      const r = execCommand(s, text, { inProgram: true });
      if (r?.signoff) throw SIGNOFF;
      for (const m of r?.msgs || []) s.job.log.push({ kind: 'msg', text: m.text, id: m.id });
      return r;
    },
    *call(q, a) {
      const { obj: o } = getProgram(s, q);
      return yield* programGen(s, o, a);
    },
    jobAttr(k) {
      const j = s.job;
      return {
        USER: j.user, JOB: j.name, NBR: String(j.number).padStart(6, '0'), CURLIB: j.curlib || '*NONE',
        TYPE: j.type === 'BCH' ? '0' : '1', DATE: s.sys.sysval('QDATE'), DATFMT: s.sys.state.sysval.QDATFMT,
        USRLIBL: j.usrlibl.join(' '), SYSLIBL: s.sys.state.sysval.QSYSLIBL,
      }[k] ?? '';
    },
    sysval: (n) => s.sys.sysval(n),
    joblog: (e) => s.job.log.push({ kind: 'msg', text: e.text, id: e.id }),
  };
  return runProgram(compiled, args, env);
}

function getProgram(s, q) {
  const r = s.sys.findObj(q, '*PGM', s.job);
  if (!r) throw new CpfError('CPD0170', `Program ${q.obj} in library ${q.lib} not found.`);
  if (r.obj.system) throw new CpfError('CPD0170', `Program ${q.obj} in library ${r.lib} cannot be called in this simulation.`);
  return r;
}

function argValue(raw) {
  raw = raw.trim();
  if (raw.startsWith("'")) return normVal(raw);
  if (/^[+-]?(\d+[.,]?\d*|[.,]\d+)$/.test(raw)) return Number(raw.replace(',', '.'));
  return raw.toUpperCase();
}

// ---------- Uitvoeren ----------

export function bindArgs(def, c) {
  const raw = {};
  let pos = 0;
  for (const p of c.params) {
    if (p.kw) {
      if (!def.params.some((x) => x.kw === p.kw)) throw new CpfError('CPD0043', `Keyword ${p.kw} not valid for this command.`);
      if (p.kw in raw) throw new CpfError('CPD0044', `Keyword ${p.kw} appears more than once.`);
      raw[p.kw] = p.raw;
    } else {
      while (def.params[pos] && def.params[pos].kw in raw) pos++;
      const pd = def.params[pos++];
      if (!pd || pos > (def.pos ?? 3)) throw new CpfError('CPD0003', 'Too many positional parameters specified.');
      raw[pd.kw] = p.raw;
    }
  }
  return raw;
}

function normParam(pd, r) {
  const bad = (why = '') => new CpfError('CPD0084', `Value '${String(r).trim()}' for parameter ${pd.kw} not valid.${why}`);
  switch (pd.kind) {
    case 'qual': {
      const q = parseQual(r, pd.dftLib || '*LIBL');
      const okObj = (pd.vals || []).includes(q.obj) || isName(q.obj) || (pd.generic && /^[A-Z@#$][A-Z0-9@#$_.]{0,8}\*$/.test(q.obj));
      if (!okObj || q.obj.length > 10) throw bad();
      if (!(['*LIBL', '*CURLIB', '*ALL', '*USRLIBL'].includes(q.lib) || isName(q.lib))) throw bad();
      return q;
    }
    case 'char': {
      const v = normVal(r);
      if (v === '*BLANK' && !(pd.vals || []).length) return '';
      if (v.length > pd.len) throw new CpfError('CPD0074', `Value for parameter ${pd.kw} exceeds ${pd.len} characters.`);
      return v === '*BLANK' ? '' : v;
    }
    case 'dec': {
      const v = normVal(r);
      if ((pd.vals || []).includes(v)) return v;
      const n = Number(v.replace(',', '.'));
      if (Number.isNaN(n) || v === '') throw new CpfError('CPD0085', `Value '${v}' for parameter ${pd.kw} not a valid number.`);
      return n;
    }
    case 'cmd':
    case 'raw':
      return r;
    case 'list':
      return splitTop(r).map(normVal);
    default: {
      const v = normVal(r);
      if ((pd.vals || []).includes(v)) return v;
      if (pd.anyValue) return v;
      if (pd.generic && /^[A-Z@#$][A-Z0-9@#$_.]{0,8}\*$/.test(v)) return v;
      if (v.startsWith('*') || !isName(v) || v.length > pd.len) {
        throw bad(pd.vals ? ` Valid values: ${pd.vals.join(', ')}.` : '');
      }
      return v;
    }
  }
}

export function execCommand(s, text, opts = {}) {
  const c = parseCommand(text);
  if (!c.name) return null;
  const def = COMMANDS[c.name];
  if (!def || (c.lib && !['QSYS', '*LIBL', '*SYSTEM'].includes(c.lib))) {
    if (CL_ONLY.has(c.name)) throw new CpfError('CPD0031', `Command ${c.name} not allowed in this setting.`);
    throw new CpfError('CPD0030', `Command ${c.name} in library ${c.lib || '*LIBL'} not found.`);
  }
  const raw = bindArgs(def, c);
  const a = {};
  for (const pd of def.params) {
    let r = raw[pd.kw];
    if (r === undefined || r === '') {
      if (pd.req) throw new CpfError('CPD0071', `Value for parameter ${pd.kw} required.`);
      r = pd.dft;
      if (r === undefined) { a[pd.kw] = undefined; continue; }
    }
    a[pd.kw] = normParam(pd, r);
  }
  const ctx = { s, sys: s.sys, job: s.job, batch: !!opts.batch, inProgram: !!opts.inProgram };
  return def.run(ctx, a, raw) || null;
}

// ---------- Commando's: sessie en jobs ----------

def('SIGNOFF', 'Sign Off', [
  P('LOG', 'Job log', 7, { dft: '*NOLIST', vals: ['*NOLIST', '*LIST'] }),
], (ctx, a) => ({ signoff: true, log: a.LOG }));

def('GO', 'Go to Menu', [
  Q('MENU', 'Menu', { req: true, vals: ['*ALL'] }),
], (ctx, a) => {
  const m = a.MENU.obj;
  if (m === 'MAJOR') return { panel: new WrkCmdPanel(COMMANDS) };
  if (!MENUS[m]) throw new CpfError('CPF6AC7', `Menu ${m} in library ${a.MENU.lib} not found.`);
  return { panel: new MenuPanel(m) };
});

def('CALL', 'Call Program', [
  Q('PGM', 'Program', { req: true }),
  P('PARM', 'Parameters', 50, { kind: 'raw', lower: true, choices: '' }),
], (ctx, a) => {
  if (a.PGM.obj === 'QCMD') {
    if (ctx.batch) throw new CpfError('CPF0001', 'QCMD cannot be called in a batch job.');
    return { panel: new CmdEntryPanel() };
  }
  const { obj } = getProgram(ctx.s, a.PGM);
  const args = a.PARM ? splitTop(a.PARM).map(argValue) : [];
  return { program: programGen(ctx.s, obj, args), programName: obj.name };
});

def('WRKACTJOB', 'Work with Active Jobs', [
  P('SBS', 'Subsystem', 10, { dft: '*ALL', vals: ['*ALL'] }),
], () => ({ panel: new WrkActJobPanel() }));

const jobOptions = ['*SELECT', '*STSA', '*DFNA', '*PGMSTK', '*SPLF', '*JOBLOG', '*LIBL'];
const wrkJob = (ctx, a) => {
  const s = ctx.s, sys = ctx.sys, j = ctx.job;
  switch (a.OPTION) {
    case '*STSA': return view('Display Job Status Attributes', [
      `Job:   ${pad(j.name, 10)}  User:   ${pad(j.user, 10)}  Number:   ${String(j.number).padStart(6, '0')}`, '',
      `Status of job . . . . . . . . . . . . . . . :   ACTIVE`,
      `Current user profile  . . . . . . . . . . . :   ${j.user}`,
      `Job user identity . . . . . . . . . . . . . :   ${j.user}`,
      `Entered system:`,
      `  Date  . . . . . . . . . . . . . . . . . . :   ${sys.fmtDate(j.started)}`,
      `  Time  . . . . . . . . . . . . . . . . . . :   ${sys.fmtTime(j.started)}`,
      `Started:`,
      `  Date  . . . . . . . . . . . . . . . . . . :   ${sys.fmtDate(j.started)}`,
      `  Time  . . . . . . . . . . . . . . . . . . :   ${sys.fmtTime(j.started)}`,
      `Subsystem . . . . . . . . . . . . . . . . . :   QINTER`,
      `  Subsystem pool ID . . . . . . . . . . . . :     2`,
      `Type of job . . . . . . . . . . . . . . . . :   INTER`,
    ]);
    case '*DFNA': return view('Display Job Definition Attributes', [
      `Job:   ${pad(j.name, 10)}  User:   ${pad(j.user, 10)}  Number:   ${String(j.number).padStart(6, '0')}`, '',
      `Job description . . . . . . . . . . . . . . :   QDFTJOBD`,
      `  Library . . . . . . . . . . . . . . . . . :     QGPL`,
      `Job queue . . . . . . . . . . . . . . . . . :   *NONE`,
      `Job priority (on job queue) . . . . . . . . :   5`,
      `Output priority (on output queue) . . . . . :   5`,
      `Date format . . . . . . . . . . . . . . . . :   *${sys.state.sysval.QDATFMT}`,
      `Date separator  . . . . . . . . . . . . . . :   ${sys.state.sysval.QDATSEP}`,
      `Time separator  . . . . . . . . . . . . . . :   ${sys.state.sysval.QTIMSEP}`,
      `Coded character set identifier  . . . . . . :   ${sys.state.sysval.QCCSID}`,
      `Language identifier . . . . . . . . . . . . :   ${sys.state.sysval.QLANGID}`,
      `Country or region identifier  . . . . . . . :   ${sys.state.sysval.QCNTRYID}`,
    ]);
    case '*PGMSTK': {
      const lines = ['Program                  Library      Request level', ''];
      lines.push(`${pad('QCMD', 25)}${pad('QSYS', 13)}1`);
      for (const p of s.stack) if (p.fn) lines.push(`${pad(p.fn.replace(/^[A-Z]+-/, ''), 25)}${pad('QSYS', 13)}`);
      return view('Display Call Stack', lines);
    }
    case '*SPLF': return { panel: new WrkSplfPanel(j.user) };
    case '*JOBLOG': return execCommand(s, 'DSPJOBLOG');
    case '*LIBL': return execCommand(s, 'DSPLIBL');
    default:
      if (ctx.batch) return null;
      return { panel: wrkJobPanel(s) };
  }
};
def('WRKJOB', 'Work with Job', [P('JOB', 'Job name', 10, { dft: '*', vals: ['*'] }), P('OPTION', 'Option', 8, { dft: '*SELECT', vals: jobOptions })], wrkJob);
def('DSPJOB', 'Display Job', [P('JOB', 'Job name', 10, { dft: '*', vals: ['*'] }), P('OPTION', 'Option', 8, { dft: '*SELECT', vals: jobOptions })], wrkJob);

def('DSPJOBLOG', 'Display Job Log', [OUTPUT], (ctx, a) => {
  const j = ctx.job;
  const lines = [];
  for (const e of j.log) {
    if (e.kind === 'cmd') lines.push({ text: '>  ' + e.text, attr: 'w' });
    else wrap(e.text, 74).forEach((l, i) => lines.push({ text: (i ? '      ' : '    ') + l, attr: 'g' }));
  }
  if (a.OUTPUT === '*PRINT') return output(ctx, a, 'Job Log', lines.map((l) => l.text), 'QPJOBLOG');
  return {
    panel: new TextView('Display Job Log', lines, {
      head(scr, r) {
        scr.text(r, 1, `Job . . :   ${pad(j.name, 10)}     User . . :   ${pad(j.user, 10)}     Number . . . :   ${String(j.number).padStart(6, '0')}`);
        return r + 2;
      },
      fkeys: ['F3=Exit   F5=Refresh   F10=Display detailed messages   F12=Cancel', 'F16=Job menu   F24=More keys'],
      fn: 'CMD-DSPJOBLOG',
    }),
  };
});

def('WRKSYSSTS', 'Work with System Status', [], () => ({ panel: new WrkSysStsPanel() }));

def('WRKSYSVAL', 'Work with System Values', [
  P('SYSVAL', 'System value', 10, { dft: '*ALL', vals: ['*ALL'] }),
], () => ({ panel: new WrkSysValPanel() }));

def('DSPSYSVAL', 'Display System Value', [P('SYSVAL', 'System value', 10, { req: true })], (ctx, a) => {
  const v = ctx.sys.sysval(a.SYSVAL);
  return view('Display System Value', [
    `System value  . . . . . :   ${a.SYSVAL}`,
    `Description . . . . . . :   ${SYSVAL_TEXT[a.SYSVAL] || ''}`, '',
    `${pad(SYSVAL_TEXT[a.SYSVAL] || 'Value', 24)} :   ${v}`,
  ]);
});

def('CHGSYSVAL', 'Change System Value', [
  P('SYSVAL', 'System value', 10, { req: true }),
  C('VALUE', 'New value', 50, { req: true }),
], (ctx, a) => {
  secofr(ctx, 'CHGSYSVAL');
  const n = a.SYSVAL, v = a.VALUE.trim() === '' && n.endsWith('SEP') ? ' ' : a.VALUE.trim().toUpperCase();
  const okVals = {
    QDATFMT: ['YMD', 'MDY', 'DMY', 'JUL'],
    QDATSEP: ['/', '-', '.', ',', ' '],
    QTIMSEP: [':', '.', ',', ' '],
  };
  if (n === 'QDATE' || n === 'QTIME') throw new CpfError('CPF1030', 'Changing the system date or time is not possible in this simulation.');
  if (!(n in ctx.sys.state.sysval)) throw new CpfError('CPF1028', `System value ${n} not valid.`);
  if (okVals[n]) {
    if (!okVals[n].includes(v)) throw new CpfError('CPF1076', `Value '${v}' for system value ${n} not valid.`);
  } else if (n === 'QMAXSIGN') {
    if (!/^\d{1,2}$/.test(v) && v !== '*NOMAX') throw new CpfError('CPF1076', `Value '${v}' for system value ${n} not valid.`);
  } else if (n === 'QUSRLIBL') {
    for (const l of v.split(/\s+/).filter(Boolean)) if (!ctx.sys.libExists(l, ctx.job)) throw new CpfError('CPF2110', `Library ${l} not found.`);
  } else throw new CpfError('CPF1030', `System value ${n} cannot be changed in this simulation.`);
  ctx.sys.state.sysval[n] = v;
  return ok(`System value ${n} changed.`, 'CPC1E05');
});

def('PWRDWNSYS', 'Power Down System', [
  P('OPTION', 'How to end', 7, { dft: '*CNTRLD', vals: ['*CNTRLD', '*IMMED'] }),
  P('DELAY', 'Controlled end delay time', 5, { kind: 'dec', dft: 3600, vals: ['*NOLIMIT'] }),
  P('RESTART', 'Restart after power down', 4, { dft: '*NO', vals: ['*NO', '*YES'] }),
], (ctx, a) => {
  secofr(ctx, 'PWRDWNSYS');
  if (ctx.batch) { ctx.s.powerDown(a.RESTART === '*YES'); return null; }
  return {
    panel: new ConfirmPanel({
      title: 'Confirm Power Down System',
      key: 'F16',
      intro: [`Press F16 to confirm your choice for ${a.OPTION} power down. System operations`,
        'will end. Press F12=Cancel to return and cancel your choice for power down.'],
      items: [],
      action: () => ctx.s.powerDown(a.RESTART === '*YES'),
    }),
  };
});

def('CHGPWD', 'Change Password', [], () => ({ panel: new ChgPwdPanel() }));

// ---------- Gebruikers en berichten ----------

def('WRKUSRPRF', 'Work with User Profiles', [
  P('USRPRF', 'User profile', 10, { dft: '*ALL', vals: ['*ALL'] }),
], () => ({ panel: new WrkUsrPrfPanel() }));

def('DSPUSRPRF', 'Display User Profile', [P('USRPRF', 'User profile', 10, { req: true })], (ctx, a) => {
  const u = ctx.sys.state.users[a.USRPRF];
  if (!u) throw new CpfError('CPF2204', `User profile ${a.USRPRF} not found.`);
  return view('Display User Profile - Basic', [
    `User profile  . . . . . . . . . . . . . . . :   ${a.USRPRF}`, '',
    `Previous sign-on  . . . . . . . . . . . . . :   ${ctx.sys.fmtDate()}  ${ctx.sys.fmtTime()}`,
    `Status  . . . . . . . . . . . . . . . . . . :   *ENABLED`,
    `User class  . . . . . . . . . . . . . . . . :   ${u.cls}`,
    `Special authority . . . . . . . . . . . . . :   ${u.cls === '*SECOFR' ? '*ALLOBJ  *SECADM  *JOBCTL' : '*NONE'}`,
    `Current library . . . . . . . . . . . . . . :   ${u.curlib}`,
    `Initial program to call . . . . . . . . . . :   ${u.inlpgm}`,
    `Initial menu  . . . . . . . . . . . . . . . :   ${u.inlmnu}`,
    `  Library . . . . . . . . . . . . . . . . . :     *LIBL`,
    `Text  . . . . . . . . . . . . . . . . . . . :   ${u.text}`,
  ]);
});

def('CRTUSRPRF', 'Create User Profile', [
  P('USRPRF', 'User profile', 10, { req: true }),
  P('PASSWORD', 'User password', 10, { dft: '*USRPRF', vals: ['*USRPRF', '*NONE'] }),
  P('USRCLS', 'User class', 8, { dft: '*USER', vals: ['*USER', '*PGMR', '*SYSOPR', '*SECADM', '*SECOFR'] }),
  P('CURLIB', 'Current library', 10, { dft: '*CRTDFT', vals: ['*CRTDFT'] }),
  P('INLPGM', 'Initial program to call', 10, { dft: '*NONE', vals: ['*NONE'] }),
  P('INLMNU', 'Initial menu', 10, { dft: 'MAIN', vals: ['MAIN', '*SIGNOFF'] }),
  TEXT(),
], (ctx, a) => {
  secofr(ctx, 'CRTUSRPRF');
  const u = a.USRPRF;
  if (ctx.sys.state.users[u]) throw new CpfError('CPF2214', `User profile ${u} already exists.`);
  ctx.sys.state.users[u] = {
    pwd: a.PASSWORD === '*USRPRF' ? u : a.PASSWORD === '*NONE' ? '\u0000' : a.PASSWORD,
    cls: a.USRCLS, text: a.TEXT, inlmnu: a.INLMNU, inlpgm: a.INLPGM, curlib: a.CURLIB,
  };
  ctx.sys.state.msgq[u] = [];
  return ok(`User profile ${u} created.`, 'CPC2205');
});

def('DLTUSRPRF', 'Delete User Profile', [P('USRPRF', 'User profile', 10, { req: true })], (ctx, a) => {
  secofr(ctx, 'DLTUSRPRF');
  const u = a.USRPRF;
  if (!ctx.sys.state.users[u]) throw new CpfError('CPF2204', `User profile ${u} not found.`);
  if (u === 'QSECOFR' || u === ctx.job.user) throw new CpfError('CPF2225', `User profile ${u} cannot be deleted.`);
  if (ctx.sys.interactive.some((j) => j.user === u)) throw new CpfError('CPF2225', `User profile ${u} is signed on and cannot be deleted.`);
  delete ctx.sys.state.users[u];
  delete ctx.sys.state.msgq[u];
  return ok(`User profile ${u} deleted.`, 'CPC2191');
});

def('SNDMSG', 'Send Message', [
  C('MSG', 'Message text', 512, { req: true }),
  P('TOUSR', 'To user profile', 10, { dft: '*SYSOPR', vals: ['*SYSOPR', '*ALLACT', '*REQUESTER'] }),
], (ctx, a) => {
  const sys = ctx.sys;
  let to;
  if (a.TOUSR === '*SYSOPR') to = ['QSYSOPR'];
  else if (a.TOUSR === '*ALLACT') to = [...new Set(sys.interactive.map((j) => j.user))];
  else if (a.TOUSR === '*REQUESTER') to = [ctx.job.user];
  else {
    if (!sys.state.users[a.TOUSR]) throw new CpfError('CPF2204', `User profile ${a.TOUSR} not found.`);
    to = [a.TOUSR];
  }
  for (const u of to) sys.sendMsg(u, a.MSG, ctx.job.user);
  return ok(`Message sent to ${to.join(', ')}.`);
});

def('DSPMSG', 'Display Messages', [
  P('MSGQ', 'Message queue', 10, { dft: '*USRPRF', vals: ['*USRPRF', '*SYSOPR', '*WRKSTN'] }),
], (ctx, a) => {
  const q = a.MSGQ === '*USRPRF' || a.MSGQ === '*WRKSTN' ? ctx.job.user : a.MSGQ === '*SYSOPR' ? 'QSYSOPR' : a.MSGQ;
  return { panel: new DspMsgPanel(q) };
});

// ---------- Bibliotheken ----------

def('CRTLIB', 'Create Library', [
  P('LIB', 'Library', 10, { req: true }),
  P('TYPE', 'Library type', 5, { dft: '*PROD', vals: ['*PROD', '*TEST'] }),
  TEXT(),
], (ctx, a) => {
  ctx.sys.createLib(a.LIB, a.TYPE, a.TEXT);
  return ok(`Library ${a.LIB} created.`, 'CPC2102');
});

def('DLTLIB', 'Delete Library', [P('LIB', 'Library', 10, { req: true })], (ctx, a) => {
  if (ctx.sys.libList(ctx.job).some((l) => l.name === a.LIB && l.type === 'CUR')) {
    ctx.job.curlib = null;
  }
  ctx.sys.deleteLib(a.LIB);
  return ok(`Library ${a.LIB} deleted.`, 'CPC2194');
});

def('DSPLIB', 'Display Library', [
  P('LIB', 'Library', 10, { dft: '*LIBL', vals: ['*LIBL', '*CURLIB', '*USRLIBL'] }),
  OUTPUT,
], (ctx, a) => {
  const sys = ctx.sys;
  const names = a.LIB === '*LIBL' ? sys.libList(ctx.job).map((l) => l.name)
    : a.LIB === '*USRLIBL' ? ctx.job.usrlibl
      : [a.LIB === '*CURLIB' ? (ctx.job.curlib || 'QGPL') : a.LIB];
  const lines = [];
  for (const n of names) {
    const lib = sys.lib(n, ctx.job);
    const objs = Object.values(lib.objs).sort((x, y) => (x.name + x.type).localeCompare(y.name + y.type));
    lines.push(`Library . . . . . . :   ${pad(n, 10)}        Number of objects . . . :   ${lpad(objs.length, 6)}`);
    lines.push(`Type  . . . . . . . :   ${pad(lib.type === '*TEST' ? 'TEST' : 'PROD', 10)}        Library ASP number  . . :        1`);
    lines.push(`Create authority  . :   *SYSVAL`);
    lines.push(`Text description  . :   ${lib.text}`, '');
    lines.push({ text: 'Object      Type      Attribute             Size  Text', attr: 'w' });
    for (const o of objs) {
      const attr = o.type === '*FILE' ? (o.src ? 'PF-SRC' : 'PF-DTA') : o.attr;
      lines.push(`${pad(o.name, 12)}${pad(o.type, 10)}${pad(attr, 12)}${lpad(objSize(o), 14)}  ${o.text}`);
    }
    if (!objs.length) lines.push('  (No objects in library)');
    lines.push('');
  }
  return output(ctx, a, 'Display Library', lines.map((l) => (typeof l === 'string' ? l : l.text)), 'QPDSPLIB', { fn: 'CMD-DSPLIB' });
});

def('WRKLIB', 'Work with Libraries', [
  P('LIB', 'Library', 10, { dft: '*ALL', vals: ['*ALL', '*LIBL'], generic: true }),
], (ctx, a) => ({ panel: new LibListPanel({ pdm: false, list: a.LIB }) }));

def('WRKLIBPDM', 'Work with Libraries using PDM', [
  P('LIB', 'Library', 10, { dft: '*LIBL', vals: ['*LIBL', '*ALL'], generic: true, choices: '*LIBL, *ALL, name, generic*' }),
], (ctx, a) => ({ panel: new LibListPanel({ pdm: true, list: a.LIB }) }));

def('DSPLIBL', 'Display Library List', [OUTPUT], (ctx, a) => {
  const sys = ctx.sys;
  const lines = sys.libList(ctx.job).map((l) => `${pad(l.name, 12)}${pad(l.type, 7)}${pad('', 12)}${sys.lib(l.name, ctx.job).text}`);
  if (a.OUTPUT === '*PRINT') return output(ctx, a, 'Library List', lines, 'QPRTLIBL');
  return {
    panel: new TextView('Display Library List', lines, {
      head(scr, r) {
        scr.text(r, 1, 'Type options, press Enter.', 'b');
        scr.text(r + 1, 3, '5=Display objects in library', 'b');
        return r + 3;
      },
      colHead: 'Library     Type   Device      Text',
      fkeys: ['F3=Exit   F12=Cancel   F17=Top   F18=Bottom'],
      fn: 'CMD-DSPLIBL',
    }),
  };
});

def('ADDLIBLE', 'Add Library List Entry', [
  P('LIB', 'Library', 10, { req: true }),
  P('POSITION', 'Library list position', 6, { dft: '*FIRST', vals: ['*FIRST', '*LAST'] }),
], (ctx, a) => {
  const j = ctx.job;
  if (!ctx.sys.libExists(a.LIB, j)) throw new CpfError('CPF2110', `Library ${a.LIB} not found.`);
  if (ctx.sys.libList(j).some((l) => l.name === a.LIB)) throw new CpfError('CPF2103', `Library ${a.LIB} already exists in library list.`);
  if (a.POSITION === '*LAST') j.usrlibl.push(a.LIB); else j.usrlibl.unshift(a.LIB);
  return ok(`Library ${a.LIB} added to library list.`, 'CPC2196');
});

def('RMVLIBLE', 'Remove Library List Entry', [P('LIB', 'Library', 10, { req: true })], (ctx, a) => {
  const j = ctx.job;
  if (!j.usrlibl.includes(a.LIB)) throw new CpfError('CPF2104', `Library ${a.LIB} not removed from the library list.`);
  j.usrlibl = j.usrlibl.filter((l) => l !== a.LIB);
  return ok(`Library ${a.LIB} removed from library list.`, 'CPC2197');
});

def('CHGCURLIB', 'Change Current Library', [
  P('CURLIB', 'Current library', 10, { req: true, vals: ['*CRTDFT'] }),
], (ctx, a) => {
  if (a.CURLIB === '*CRTDFT') { ctx.job.curlib = null; return ok('Current library changed to *CRTDFT.'); }
  if (!ctx.sys.libExists(a.CURLIB, ctx.job) || a.CURLIB === 'QTEMP') throw new CpfError('CPF2110', `Library ${a.CURLIB} not found.`);
  ctx.job.curlib = a.CURLIB;
  ctx.job.usrlibl = ctx.job.usrlibl.filter((l) => l !== a.CURLIB);
  return ok(`Current library changed to ${a.CURLIB}.`, 'CPC2198');
});

// ---------- Objecten ----------

const OBJTYPES = ['*ALL', '*FILE', '*PGM', '*LIB', '*CMD', '*USRPRF', '*OUTQ'];

def('WRKOBJ', 'Work with Objects', [
  Q('OBJ', 'Object', { req: true, vals: ['*ALL'], generic: true, choices: 'Name, generic*, *ALL' }),
  P('OBJTYPE', 'Object type', 7, { dft: '*ALL', vals: OBJTYPES }),
], (ctx, a) => ({ panel: new ObjListPanel({ pdm: false, lib: a.OBJ.lib, obj: a.OBJ.obj, type: a.OBJTYPE }) }));

def('WRKOBJPDM', 'Work with Objects using PDM', [
  P('LIB', 'Library', 10, { dft: '*CURLIB', vals: ['*CURLIB'] }),
  P('OBJ', 'Object', 10, { dft: '*ALL', vals: ['*ALL'], generic: true }),
  P('OBJTYPE', 'Object type', 7, { dft: '*ALL', vals: OBJTYPES }),
], (ctx, a) => {
  const lib = a.LIB === '*CURLIB' ? ctx.job.curlib || 'QGPL' : a.LIB;
  ctx.sys.lib(lib, ctx.job);
  return { panel: new ObjListPanel({ pdm: true, lib, obj: a.OBJ, type: a.OBJTYPE }) };
});

def('DSPOBJD', 'Display Object Description', [
  Q('OBJ', 'Object', { req: true }),
  P('OBJTYPE', 'Object type', 7, { req: true, vals: OBJTYPES.slice(1) }),
  OUTPUT,
], (ctx, a) => {
  const { obj: o, lib } = ctx.sys.getObj(a.OBJ, a.OBJTYPE, ctx.job);
  const d = new Date(o.created);
  const attr = o.type === '*FILE' ? (o.src ? 'PF' : 'PF') : o.attr;
  return output(ctx, a, 'Display Object Description - Basic', [
    `Object  . . . . . . . :   ${pad(o.name, 10)}     Attribute . . . . . :   ${attr}`,
    `  Library . . . . . . :     ${pad(lib, 10)}   Owner . . . . . . . :   ${o.owner || 'QSYS'}`,
    `Library ASP device  . :   *SYSBAS`,
    `Type  . . . . . . . . :   ${o.type}`, '',
    `User-defined information:`,
    `  Attribute . . . . . . . . . . . . . . . . :   ${o.type === '*FILE' ? (o.src ? 'Source physical file' : 'Data physical file') : o.attr || '*NONE'}`,
    `  Text  . . . . . . . . . . . . . . . . . . :   ${o.text}`, '',
    `Creation information:`,
    `  Creation date/time  . . . . . . . . . . . :   ${ctx.sys.fmtDate(d)}  ${ctx.sys.fmtTime(d)}`,
    `  Created by user . . . . . . . . . . . . . :   ${o.owner || 'QSYS'}`,
    `  System created on . . . . . . . . . . . . :   ${ctx.sys.name}`,
    `  Object size . . . . . . . . . . . . . . . :   ${objSize(o)}`,
  ], 'QPRTOBJD');
});

function deleteObj(ctx, lib, name, type) {
  if (type === '*LIB') { ctx.sys.deleteLib(name); return; }
  if (type === '*USRPRF') { execCommand(ctx.s, `DLTUSRPRF ${name}`); return; }
  ctx.sys.delObj(lib, name, type, ctx.job);
}

def('DLTOBJ', 'Delete Object', [
  Q('OBJ', 'Object', { req: true }),
  P('OBJTYPE', 'Object type', 7, { req: true, vals: OBJTYPES.slice(1) }),
], (ctx, a) => {
  const { lib } = ctx.sys.getObj(a.OBJ, a.OBJTYPE, ctx.job);
  deleteObj(ctx, lib, a.OBJ.obj, a.OBJTYPE);
  return ok(`Object ${a.OBJ.obj} in ${lib} type ${a.OBJTYPE} deleted.`, 'CPC2191');
});

def('DLTF', 'Delete File', [Q('FILE', 'File', { req: true })], (ctx, a) => {
  const { lib } = fileOf(ctx, a.FILE);
  ctx.sys.delObj(lib, a.FILE.obj, '*FILE', ctx.job);
  return ok(`File ${a.FILE.obj} in library ${lib} deleted.`, 'CPC2191');
});

def('DLTPGM', 'Delete Program', [Q('PGM', 'Program', { req: true })], (ctx, a) => {
  const { lib } = ctx.sys.getObj(a.PGM, '*PGM', ctx.job);
  ctx.sys.delObj(lib, a.PGM.obj, '*PGM', ctx.job);
  return ok(`Program ${a.PGM.obj} in library ${lib} deleted.`, 'CPC2191');
});

def('RNMOBJ', 'Rename Object', [
  Q('OBJ', 'Object', { req: true }),
  P('OBJTYPE', 'Object type', 7, { req: true, vals: ['*FILE', '*PGM'] }),
  P('NEWOBJ', 'New object', 10, { req: true }),
], (ctx, a) => {
  const { obj, lib } = ctx.sys.getObj(a.OBJ, a.OBJTYPE, ctx.job);
  const l = ctx.sys.lib(lib, ctx.job);
  if (l.objs[objKey(a.NEWOBJ, a.OBJTYPE)]) throw new CpfError('CPF2112', `Object ${a.NEWOBJ} in ${lib} type ${a.OBJTYPE} already exists.`);
  delete l.objs[objKey(obj.name, a.OBJTYPE)];
  obj.name = a.NEWOBJ;
  l.objs[objKey(a.NEWOBJ, a.OBJTYPE)] = obj;
  return ok(`Object ${a.OBJ.obj} in ${lib} type ${a.OBJTYPE} renamed ${a.NEWOBJ}.`, 'CPC2192');
});

// ---------- Bestanden ----------

def('CRTPF', 'Create Physical File', [
  Q('FILE', 'File', { req: true, dftLib: '*CURLIB' }),
  P('RCDLEN', 'Record length, if no DDS', 5, { kind: 'dec' }),
  TEXT(),
], (ctx, a) => {
  if (!a.RCDLEN) throw new CpfError('CPF7302', 'DDS source is not supported in this simulation. Specify RCDLEN, or use SQL CREATE TABLE.');
  const lib = ctx.sys.targetLib(a.FILE.lib, ctx.job);
  ctx.sys.putObj(lib, newDataFile(a.FILE.obj, [{ name: a.FILE.obj, type: 'CHAR', len: a.RCDLEN, heading: a.FILE.obj }], a.TEXT), ctx.job);
  return ok(`File ${a.FILE.obj} created in library ${lib}.`, 'CPC7301');
});

def('CRTSRCPF', 'Create Source Physical File', [
  Q('FILE', 'File', { req: true, dftLib: '*CURLIB' }),
  P('RCDLEN', 'Record length', 5, { kind: 'dec', dft: 92 }),
  TEXT(),
], (ctx, a) => {
  const lib = ctx.sys.targetLib(a.FILE.lib, ctx.job);
  const f = newSourceFile(a.FILE.obj, a.TEXT);
  f.rcdlen = a.RCDLEN;
  ctx.sys.putObj(lib, f, ctx.job);
  return ok(`File ${a.FILE.obj} created in library ${lib}.`, 'CPC7301');
});

const SRCTYPES = ['CLP', 'CLLE', 'TXT', 'SQL', 'RPGLE', 'CBLLE', 'PF', 'LF', 'DSPF'];

def('ADDPFM', 'Add Physical File Member', [
  Q('FILE', 'Physical file', { req: true }),
  P('MBR', 'Member', 10, { req: true }),
  TEXT(),
  P('SRCTYPE', 'Source type', 10, { dft: '*NONE', vals: ['*NONE', ...SRCTYPES] }),
], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE);
  if (!f.src) throw new CpfError('CPF7306', `Member ${a.MBR} not added. A data file in this simulation has one member.`);
  if (f.members[a.MBR]) throw new CpfError('CPF5812', `Member ${a.MBR} already exists in file ${f.name} in library ${lib}.`);
  f.members[a.MBR] = newMember(a.SRCTYPE === '*NONE' ? 'TXT' : a.SRCTYPE, a.TEXT);
  return ok(`Member ${a.MBR} added to file ${f.name} in ${lib}.`, 'CPC7305');
});

def('RMVM', 'Remove Member', [
  Q('FILE', 'Database file', { req: true }),
  P('MBR', 'Member', 10, { req: true }),
], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE, 'src');
  if (!f.members[a.MBR]) throw new CpfError('CPF7301', `Member ${a.MBR} not found in file ${f.name} in ${lib}.`);
  delete f.members[a.MBR];
  return ok(`Member ${a.MBR} removed from file ${f.name} in ${lib}.`, 'CPC7309');
});

def('CLRPFM', 'Clear Physical File Member', [
  Q('FILE', 'Physical file', { req: true }),
  P('MBR', 'Member', 10, { dft: '*FIRST', vals: ['*FIRST'] }),
], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE);
  if (f.src) {
    const { m, name } = memberOf(f, lib, a.MBR);
    m.lines = [];
    return ok(`Member ${name} file ${f.name} in ${lib} cleared.`, 'CPC3101');
  }
  f.rows.splice(0);
  return ok(`Member ${f.name} file ${f.name} in ${lib} cleared.`, 'CPC3101');
});

def('DSPPFM', 'Display Physical File Member', [
  Q('FILE', 'File', { req: true }),
  P('MBR', 'Member', 10, { dft: '*FIRST', vals: ['*FIRST'] }),
], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE);
  let lines, mbr;
  if (f.src) {
    const r = memberOf(f, lib, a.MBR);
    mbr = r.name;
    const date = new Date(r.m.changed);
    const dt = String(date.getFullYear() % 100).padStart(2, '0') + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0');
    lines = r.m.lines.map((l) => l.seq.replace('.', '') + dt + l.data);
  } else {
    mbr = f.name;
    lines = f.rows.map((row) => recordImage(f.fields, row));
  }
  return {
    panel: new TextView('Display Physical File Member', lines, {
      head(scr, r) {
        scr.text(r, 1, `File  . . . . . . :   ${pad(f.name, 10)}          Library  . . . . :   ${lib}`);
        scr.text(r + 1, 1, `Member  . . . . . :   ${pad(mbr, 10)}          Record . . . . . :   ${this.top + 1}`);
        return r + 2;
      },
      control: true,
      ruler: true,
      endMark: '                        ****** END OF DATA ******',
      fkeys: ['F3=Exit   F12=Cancel   F19=Left   F20=Right   F24=More keys'],
      fn: 'CMD-DSPPFM',
    }),
  };
});

def('DSPFD', 'Display File Description', [Q('FILE', 'File', { req: true }), OUTPUT], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE);
  const d = new Date(f.created);
  const n = f.src ? Object.keys(f.members).length : 1;
  const recs = f.src ? Object.values(f.members).reduce((x, m) => x + m.lines.length, 0) : f.rows.length;
  return output(ctx, a, 'Display Spooled File', [
    `File  . . . . . . . . . . . . . . . . . . . :   FILE        ${f.name}`,
    `  Library . . . . . . . . . . . . . . . . . :               ${lib}`,
    `Type of information . . . . . . . . . . . . :   TYPEINF     *ALL`,
    `File attributes . . . . . . . . . . . . . . :   FILEATR     *ALL`,
    `System  . . . . . . . . . . . . . . . . . . :   SYSTEM      *LCL`,
    '',
    `File Description Header`,
    `  File  . . . . . . . . . . . . . . . . . . :   FILE        ${f.name}`,
    `  Library . . . . . . . . . . . . . . . . . :               ${lib}`,
    `  Type of file  . . . . . . . . . . . . . . :               Physical`,
    `  File type . . . . . . . . . . . . . . . . :   FILETYPE    ${f.src ? '*SRC' : '*DATA'}`,
    `  Creation date . . . . . . . . . . . . . . :               ${ctx.sys.fmtDate(d)}`,
    `  Text 'description'  . . . . . . . . . . . :   TEXT        ${f.text}`,
    '',
    `Data Base File Attributes`,
    `  Externally described file . . . . . . . . :               ${f.src || f.fields.length > 1 || f.fields[0]?.name !== f.name ? 'Yes' : 'No'}`,
    `  Number of fields  . . . . . . . . . . . . :               ${f.src ? 3 : f.fields.length}`,
    `  Record length . . . . . . . . . . . . . . :               ${f.src ? f.rcdlen : recLen(f.fields)}`,
    `  Maximum number of members . . . . . . . . :   MAXMBRS     ${f.src ? '*NOMAX' : 1}`,
    `  Current number of members . . . . . . . . :               ${n}`,
    `  Total number of records . . . . . . . . . :               ${recs}`,
  ], 'QPDSPFD');
});

def('DSPFFD', 'Display File Field Description', [Q('FILE', 'File', { req: true }), OUTPUT], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE);
  const fields = f.src ? [
    { name: 'SRCSEQ', type: 'DECIMAL', len: 6, scale: 2, heading: 'SRCSEQ' },
    { name: 'SRCDAT', type: 'DECIMAL', len: 6, scale: 0, heading: 'SRCDAT' },
    { name: 'SRCDTA', type: 'CHAR', len: f.rcdlen - 12, heading: 'SRCDTA' },
  ] : f.fields;
  const lines = [
    `File  . . . . . . . . . . . . . . . . . :   ${pad(f.name, 10)}  Library . . . :   ${lib}`,
    `Number of fields  . . . . . . . . . . . :   ${fields.length}`,
    `Record length . . . . . . . . . . . . . :   ${recLen(fields)}`,
    '',
    { text: 'Field      Data        Field  Buffer    Buffer        Field    Column', attr: 'w' },
    { text: '           Type       Length  Length  Position        Usage    Heading', attr: 'w' },
  ];
  let posn = 1;
  for (const fd of fields) {
    const typ = { DECIMAL: 'ZONED', INTEGER: 'BINARY', CHAR: 'CHAR', VARCHAR: 'VARCHAR', DATE: 'DATE', TIME: 'TIME', TIMESTAMP: 'TIMESTAMP' }[fd.type] || fd.type;
    const len = fd.scale !== undefined && (fd.type === 'DECIMAL') ? `${fd.len} ${fd.scale}` : String(fd.len);
    lines.push(`${pad(fd.name, 11)}${pad(typ, 10)}${lpad(len, 7)}${lpad(fd.len, 8)}${lpad(posn, 10)}        Both     ${fd.heading || fd.name}`);
    posn += fd.len;
  }
  return output(ctx, a, 'Display Spooled File', lines.map((l) => (typeof l === 'string' ? l : l.text)), 'QPDSPFFD');
});

def('CPYF', 'Copy File', [
  Q('FROMFILE', 'From file', { req: true }),
  Q('TOFILE', 'To file', { req: true }),
  P('FROMMBR', 'From member', 10, { dft: '*FIRST', vals: ['*FIRST'] }),
  P('TOMBR', 'To member or label', 10, { dft: '*FIRST', vals: ['*FIRST', '*FROMMBR'] }),
  P('MBROPT', 'Replace or add records', 8, { dft: '*NONE', vals: ['*NONE', '*ADD', '*REPLACE'] }),
  P('CRTFILE', 'Create file', 4, { dft: '*NO', vals: ['*NO', '*YES'] }),
], (ctx, a) => {
  const sys = ctx.sys, job = ctx.job;
  const from = fileOf(ctx, a.FROMFILE);
  let to = sys.findObj(a.TOFILE, '*FILE', job);
  if (!to) {
    if (a.CRTFILE !== '*YES') throw new CpfError('CPF2817', `Copy command ended because of error. File ${a.TOFILE.obj} in library ${a.TOFILE.lib} not found.`);
    const lib = sys.targetLib(a.TOFILE.lib === '*LIBL' ? from.lib : a.TOFILE.lib, job);
    const nf = from.obj.src ? newSourceFile(a.TOFILE.obj, from.obj.text)
      : newDataFile(a.TOFILE.obj, from.obj.fields.map((f) => ({ ...f })), from.obj.text);
    sys.putObj(lib, nf, job);
    to = { obj: nf, lib };
  }
  if (from.obj.src !== to.obj.src) throw new CpfError('CPF2817', 'Copy command ended because of error. Source and data files cannot be mixed.');
  if (from.obj.src) {
    const { m, name } = memberOf(from.obj, from.lib, a.FROMMBR);
    const tname = a.TOMBR === '*FIRST' || a.TOMBR === '*FROMMBR' ? name : a.TOMBR;
    const existing = to.obj.members[tname];
    if (existing && existing.lines.length && a.MBROPT === '*NONE') throw new CpfError('CPF2817', `Copy command ended because of error. Member ${tname} already contains data; specify MBROPT(*ADD) or MBROPT(*REPLACE).`);
    const target = existing || (to.obj.members[tname] = newMember(m.type, m.text));
    if (a.MBROPT !== '*ADD') target.lines = [];
    target.lines.push(...m.lines.map((l) => ({ ...l })));
    return ok(`${m.lines.length} records copied from member ${name} to member ${tname}.`, 'CPC2955');
  }
  if (to.obj.fields.length !== from.obj.fields.length) throw new CpfError('CPF2817', 'Copy command ended because of error. Record formats differ.');
  if (to.obj.rows.length && a.MBROPT === '*NONE') throw new CpfError('CPF2817', `Copy command ended because of error. Member ${to.obj.name} already contains data; specify MBROPT(*ADD) or MBROPT(*REPLACE).`);
  if (a.MBROPT === '*REPLACE') to.obj.rows.splice(0);
  to.obj.rows.push(...from.obj.rows.map((r) => r.slice()));
  return ok(`${from.obj.rows.length} records copied from member ${from.obj.name} to member ${to.obj.name}.`, 'CPC2955');
});

def('RUNQRY', 'Run Query', [
  P('QRY', 'Query', 10, { dft: '*NONE', vals: ['*NONE'] }),
  P('QRYFILE', 'Query file', 25, { kind: 'raw', req: true, choices: '(library/file)' }),
  P('OUTTYPE', 'Report output type', 8, { dft: '*RUNOPT', vals: ['*RUNOPT', '*DISPLAY', '*PRINTER'] }),
], (ctx, a) => {
  if (a.QRY !== '*NONE') throw new CpfError('QRY2283', `Query definition ${a.QRY} not found. Only QRY(*NONE) is supported.`);
  const inner = a.QRYFILE.replace(/[()]/g, ' ').trim();
  const q = parseQual(splitTop(inner)[0] || '');
  const { obj: f } = fileOf(ctx, q, 'data');
  const cols = f.fields.map((fd) => ({ ...fd, heading: fd.heading || fd.name }));
  if (a.OUTTYPE === '*PRINTER') {
    const t = tableLines(cols, f.rows);
    ctx.sys.addSpool(ctx.job, 'QPQUPRFIL', [t.header, ...t.lines, '', '* * *  E N D  O F  R E P O R T  * * *'], f.name);
    return ok(`Query report for file ${f.name} written to spooled file QPQUPRFIL.`);
  }
  return { panel: dataPanel('Display Report', cols, f.rows, { query: '*NONE', fn: 'CMD-RUNQRY' }) };
});

// ---------- Programmeren ----------

def('STRPDM', 'Start PDM', [], () => ({ panel: new MenuPanel('PDM') }));

def('WRKMBRPDM', 'Work with Members using PDM', [
  Q('FILE', 'File', { req: true, dft: 'QCLSRC' }),
  P('MBR', 'Member', 10, { dft: '*ALL', vals: ['*ALL'], generic: true }),
], (ctx, a) => {
  const { obj: f, lib } = fileOf(ctx, a.FILE, 'src');
  return { panel: new MbrListPanel(lib, f.name) };
});

def('STRSEU', 'Start Source Entry Utility', [
  Q('SRCFILE', 'Source file', { dft: 'QCLSRC' }),
  P('SRCMBR', 'Source member', 10, { dft: '*SELECT', vals: ['*SELECT'] }),
  P('TYPE', 'Source type', 10, { dft: '*SAME', vals: ['*SAME', ...SRCTYPES] }),
  P('OPTION', 'Option', 1, { kind: 'dec', dft: 2, vals: [], choices: '2=Edit, 5=Browse' }),
  C('TEXT', "Text 'description'", 50, { dft: '*BLANK', vals: ['*BLANK'] }),
], (ctx, a) => {
  if (ctx.batch) throw new CpfError('CPF0001', 'STRSEU cannot be used in a batch job.');
  const { obj: f, lib } = fileOf(ctx, a.SRCFILE, 'src');
  if (a.SRCMBR === '*SELECT') return { panel: new MbrListPanel(lib, f.name) };
  if (a.OPTION !== 2 && a.OPTION !== 5) throw new CpfError('EDT0201', `Option ${a.OPTION} not valid. Use 2 (edit) or 5 (browse).`);
  let m = f.members[a.SRCMBR];
  let isNew = false;
  if (!m) {
    if (a.OPTION === 5) throw new CpfError('EDT0221', `Member ${a.SRCMBR} not found in file ${f.name}.`);
    const type = a.TYPE === '*SAME' ? (f.name === 'QCLSRC' ? 'CLP' : 'TXT') : a.TYPE;
    m = newMember(type, a.TEXT === '*BLANK' ? '' : a.TEXT);
    isNew = true;
  } else if (a.TYPE !== '*SAME') m.type = a.TYPE;
  return { panel: new SeuPanel({ lib, file: f.name, mbr: a.SRCMBR, member: m, edit: a.OPTION === 2, isNew, srcFile: f }) };
});

function compileCmd(attr, srcType) {
  return (ctx, a) => {
    const sys = ctx.sys;
    const { obj: f, lib: srcLib } = fileOf(ctx, a.SRCFILE, 'src');
    const mbrName = a.SRCMBR === '*PGM' ? a.PGM.obj : a.SRCMBR;
    const { m } = memberOf(f, srcLib, mbrName);
    const lib = sys.targetLib(a.PGM.lib, ctx.job);
    sys.lib(lib, ctx.job);
    const res = compileCL(m.lines, knownCommand);
    const name = a.PGM.obj;
    // Compileerlijst
    const listing = [
      `  ${attr === 'CLLE' ? 'ILE ' : ''}Control Language                    ${lib}/${name}        ${sys.name}  ${sys.fmtDate()} ${sys.fmtTime()}`,
      `Program . . . . . . . . . . . . . . . . . . :   ${name}`,
      `  Library . . . . . . . . . . . . . . . . . :     ${lib}`,
      `Source file . . . . . . . . . . . . . . . . :   ${f.name}`,
      `  Library . . . . . . . . . . . . . . . . . :     ${srcLib}`,
      `Source member name  . . . . . . . . . . . . :   ${mbrName}`,
      `Source type . . . . . . . . . . . . . . . . :   ${m.type}`,
      '',
      '                           Control Language Source',
      'SEQNBR  *...+... 1 ...+... 2 ...+... 3 ...+... 4 ...+... 5 ...+... 6 ...+... 7',
    ];
    const byLine = new Map();
    for (const e of res.errors) {
      if (!byLine.has(e.line)) byLine.set(e.line, []);
      byLine.get(e.line).push(e);
    }
    m.lines.forEach((l, i) => {
      listing.push(`${l.seq.replace('.', '').padStart(6)}  ${l.data}`);
      for (const e of byLine.get(i) || []) listing.push(`* ${e.id}  30  ${e.text}`);
    });
    listing.push('                        * * * * *   E N D   O F   S O U R C E   * * * * *', '');
    listing.push(`Message summary:  ${res.errors.length} error(s) found.`);
    if (!m.lines.length) res.errors.push({ id: 'CPD0791', text: 'No source statements in member.' });
    if (res.errors.length) {
      listing.push(`Program ${name} not created in library ${lib}.`);
      sys.addSpool(ctx.job, name, listing, name);
      const first = res.errors[0];
      ctx.job.log.push({ kind: 'msg', text: `${first.id}: ${first.text} (statement ${m.lines[first.line]?.seq || ''})`, id: first.id });
      throw new CpfError('CPF0C33', `Program ${name} not created in library ${lib}. See spooled file ${name} for errors.`);
    }
    listing.push(`Program ${name} created in library ${lib}.`);
    sys.addSpool(ctx.job, name, listing, name);
    const l = sys.lib(lib, ctx.job);
    const key = objKey(name, '*PGM');
    if (l.objs[key] && a.REPLACE === '*NO') throw new CpfError('CPF0C32', `Program ${name} in library ${lib} already exists.`);
    const text = a.TEXT === '*SRCMBRTXT' ? m.text : a.TEXT;
    l.objs[key] = newObject(name, '*PGM', attr, text, { owner: ctx.job.user, source: m.lines.map((x) => x.data), srcFile: `${srcLib}/${f.name}`, srcMbr: mbrName });
    return ok(`Program ${name} created in library ${lib}.`, 'CPC0904');
  };
}

const crtParams = [
  Q('PGM', 'Program', { req: true, dftLib: '*CURLIB' }),
  Q('SRCFILE', 'Source file', { dft: 'QCLSRC' }),
  P('SRCMBR', 'Source member', 10, { dft: '*PGM', vals: ['*PGM'] }),
  C('TEXT', "Text 'description'", 50, { dft: '*SRCMBRTXT', vals: ['*SRCMBRTXT', '*BLANK'] }),
  P('REPLACE', 'Replace program', 4, { dft: '*YES', vals: ['*YES', '*NO'] }),
];
def('CRTCLPGM', 'Create CL Program', crtParams, compileCmd('CLP', 'CLP'));
def('CRTBNDCL', 'Create Bound CL Program', crtParams, compileCmd('CLLE', 'CLLE'));

def('STRSQL', 'Start SQL Interactive Session', [
  P('NAMING', 'Naming convention', 4, { dft: '*SYS', vals: ['*SYS', '*SQL'] }),
], (ctx) => {
  if (ctx.batch) throw new CpfError('CPF0001', 'STRSQL cannot be used in a batch job.');
  ctx.s.sqlPanel ??= new SqlPanel();
  ctx.s.sqlPanel.v = {};
  return { panel: ctx.s.sqlPanel };
});

def('RUNSQL', 'Run SQL', [
  C('SQL', 'SQL statement', 5000, { req: true }),
  P('COMMIT', 'Commitment control', 4, { dft: '*CHG', vals: ['*CHG', '*NONE', '*NC', '*CS', '*ALL', '*RR'] }),
  P('NAMING', 'Naming', 4, { dft: '*SYS', vals: ['*SYS', '*SQL'] }),
], (ctx, a) => {
  if (/^\s*SELECT\b/i.test(a.SQL)) throw new CpfError('SQL0084', 'SQL statement not allowed. RUNSQL cannot run a SELECT statement.');
  const r = sqlRun(ctx.s, a.SQL);
  return ok(r.message);
});

def('WRKSPLF', 'Work with Spooled Files', [
  P('SELECT', 'User', 10, { dft: '*CURRENT', vals: ['*CURRENT', '*ALL'] }),
], (ctx, a) => ({ panel: new WrkSplfPanel(a.SELECT === '*CURRENT' ? ctx.job.user : a.SELECT) }));

def('SBMJOB', 'Submit Job', [
  P('CMD', 'Command to run', 50, { kind: 'cmd', req: true }),
  P('JOB', 'Job name', 10, { dft: '*JOBD', vals: ['*JOBD'] }),
], (ctx, a) => {
  const s = ctx.s, sys = ctx.sys;
  const parent = ctx.job;
  const bjob = {
    ...parent, name: a.JOB === '*JOBD' ? 'QDFTJOBD' : a.JOB, number: sys.state.nextJob++, type: 'BCH',
    started: sys.now(), log: [], history: [], splnbr: 0, usrlibl: [...parent.usrlibl],
    qtemp: { name: 'QTEMP', text: '', type: '*TEST', objs: {} },
  };
  const id = sys.jobId(bjob);
  let okRun = true;
  s.job = bjob;
  try {
    bjob.log.push({ kind: 'cmd', text: a.CMD });
    const r = execCommand(s, a.CMD, { batch: true });
    for (const m of r?.msgs || []) bjob.log.push({ kind: 'msg', text: m.text, id: m.id });
    if (r?.program) {
      let step = r.program.next();
      while (!step.done) {
        if (step.value.inquiry !== undefined) throw new CpfError('CPA0702', 'Inquiry message not allowed in a batch job; job ended.');
        step = r.program.next();
      }
      for (const m of step.value || []) bjob.log.push({ kind: 'msg', text: m.text, id: m.id });
    }
  } catch (e) {
    if (e === SIGNOFF) { /* SIGNOFF in batch: einde job */ } else {
      if (!(e instanceof CpfError)) throw e;
      okRun = false;
      bjob.log.push({ kind: 'msg', text: e.text, id: e.id });
    }
  } finally {
    s.job = parent;
  }
  const when = `on ${sys.fmtDate()} at ${sys.fmtTime()}`;
  if (okRun) sys.sendMsg(parent.user, `Job ${id} completed normally ${when}.`, 'QSYS');
  else {
    sys.addSpool(bjob, 'QPJOBLOG', bjob.log.map((e) => (e.kind === 'cmd' ? '>  ' : '    ') + e.text), bjob.name);
    sys.sendMsg(parent.user, `Job ${id} ended abnormally ${when}.`, 'QSYS');
  }
  return ok(`Job ${id} submitted to job queue QBATCH in library QGPL.`, 'CPC1221');
});

def('DLYJOB', 'Delay Job', [P('DLY', 'Delay time, in seconds', 6, { kind: 'dec', dft: 0 })], () => null);

def('WRKCMD', 'Work with Commands', [
  P('CMD', 'Command', 10, { dft: '*ALL', vals: ['*ALL'], generic: true }),
], (ctx, a) => ({ panel: new WrkCmdPanel(COMMANDS, a.CMD) }));

def('DSPCMD', 'Display Command', [P('CMD', 'Command', 10, { req: true })], (ctx, a) => {
  const d = COMMANDS[a.CMD];
  if (!d) throw new CpfError('CPF9801', `Object ${a.CMD} in library *LIBL not found.`);
  const lines = [
    `Command . . . . . . . :   ${d.name}`,
    `  Library . . . . . . :     QSYS`,
    `Text  . . . . . . . . :   ${d.desc}`, '',
    { text: 'Keyword     Description                          Default / values', attr: 'w' },
  ];
  for (const p of d.params) {
    const v = [p.dft !== undefined ? `Default ${p.dft}` : p.req ? 'Required' : '', p.vals?.length ? p.vals.join(' ') : ''].filter(Boolean).join('; ');
    lines.push(`${pad(p.kw, 12)}${pad(p.label, 37)}${v}`);
  }
  if (!d.params.length) lines.push('(This command has no parameters.)');
  return view('Display Command Information', lines);
});

def('PING', 'Verify TCP/IP Connection', [C('RMTSYS', 'Remote system', 50, { req: true })], (ctx, a) => {
  const host = a.RMTSYS.toUpperCase();
  const local = ['LOCALHOST', 'SIM400', '127.0.0.1', 'LOOPBACK'].includes(host);
  const msgs = [{ text: `Verifying connection to host system ${a.RMTSYS}.` }];
  if (local) {
    for (let i = 0; i < 5; i++) msgs.push({ text: `Reply ${i + 1} from ${a.RMTSYS} took 0 ms. 256 bytes. TTL 64.` });
    msgs.push({ text: 'Round-trip (in milliseconds) min/avg/max = 0/0/0.' });
    msgs.push({ text: 'Connection verification statistics: 5 of 5 successful (100 %).', id: 'TCP3210' });
  } else {
    msgs.push({ text: 'No response from host within 1 seconds for connection verification 1.' });
    msgs.push({ text: 'Connection verification statistics: 0 of 5 successful (0 %).', id: 'TCP3210' });
    msgs.push({ text: 'This simulated system has no network connection.' });
  }
  return { msgs };
});

// ---------- Opdrachten die alleen in een CL-programma werken ----------
// Ze staan hier zodat de prompter (F4 in SEU) ze kent; de CL-interpreter
// voert ze zelf uit.

const pgmOnly = (name) => (ctx) => {
  throw new CpfError('CPD0031', `Command ${name} not allowed in this setting.`);
};
const V = (kw, label, o = {}) => P(kw, label, 11, { kind: 'raw', ...o });
const E = (kw, label, len = 50, o = {}) => P(kw, label, len, { kind: 'raw', lower: true, ...o });

for (const [name, desc, params] of [
  ['PGM', 'Program', [E('PARM', 'Parameter CL variable names', 40)]],
  ['ENDPGM', 'End Program', []],
  ['DCL', 'Declare CL Variable', [V('VAR', 'CL variable name', { req: true }), P('TYPE', 'Type', 5, { req: true, vals: ['*DEC', '*CHAR', '*LGL', '*INT', '*UINT'] }), E('LEN', 'Length', 10, { choices: 'Length, decimal positions' }), E('VALUE', 'Initial value', 50)]],
  ['CHGVAR', 'Change Variable', [V('VAR', 'CL variable name', { req: true }), E('VALUE', 'Value', 50, { req: true })]],
  ['IF', 'If', [E('COND', 'Condition', 50, { req: true }), E('THEN', 'Command', 50)]],
  ['ELSE', 'Else', [E('CMD', 'Command', 50)]],
  ['DO', 'Do Group', []],
  ['ENDDO', 'End Do Group', []],
  ['DOWHILE', 'Do While', [E('COND', 'Condition', 50, { req: true })]],
  ['DOUNTIL', 'Do Until', [E('COND', 'Condition', 50, { req: true })]],
  ['DOFOR', 'Do For', [V('VAR', 'Control variable', { req: true }), E('FROM', 'Initial value', 20, { req: true }), E('TO', 'Final value', 20, { req: true }), E('BY', 'Increment', 10, { dft: '1' })]],
  ['LEAVE', 'Leave Do Group', []],
  ['ITERATE', 'Iterate', []],
  ['SELECT', 'Select', []],
  ['WHEN', 'When', [E('COND', 'Condition', 50, { req: true }), E('THEN', 'Command', 50)]],
  ['OTHERWISE', 'Otherwise', [E('CMD', 'Command', 50)]],
  ['ENDSELECT', 'End Select', []],
  ['GOTO', 'Go To', [P('CMDLBL', 'Command label', 10, { req: true })]],
  ['RETURN', 'Return', []],
  ['MONMSG', 'Monitor Message', [E('MSGID', 'Message identifier', 40, { req: true }), E('CMPDTA', 'Comparison data', 20, { dft: '*NONE' }), E('EXEC', 'Command to execute', 50)]],
  ['SNDPGMMSG', 'Send Program Message', [E('MSG', 'Message text', 50), P('MSGID', 'Message identifier', 7), E('MSGDTA', 'Message data field values', 50), P('MSGTYPE', 'Message type', 7, { dft: '*INFO', vals: ['*INFO', '*COMP', '*DIAG', '*ESCAPE'] })]],
  ['SNDUSRMSG', 'Send User Message', [E('MSG', 'Message text', 50), E('VALUES', 'Valid reply values', 30), E('DFT', 'Default reply value', 20), P('MSGTYPE', 'Message type', 5, { dft: '*INQ', vals: ['*INQ', '*INFO'] }), V('MSGRPY', 'CL var for reply')]],
  ['RTVJOBA', 'Retrieve Job Attributes', [V('JOB', 'CL var for JOB (10)'), V('USER', 'CL var for USER (10)'), V('NBR', 'CL var for NBR (6)'), V('CURLIB', 'CL var for CURLIB (10)'), V('TYPE', 'CL var for TYPE (1)'), V('DATE', 'CL var for DATE (6)')]],
  ['RTVSYSVAL', 'Retrieve System Value', [P('SYSVAL', 'System value', 10, { req: true }), V('RTNVAR', 'CL var for returned value', { req: true })]],
]) {
  def(name, desc, params, pgmOnly(name), { pgmOnly: true, pos: params.length });
}
