// Het systeem: schijfinhoud (state), bibliotheeklijst, objecten zoeken,
// spoolbestanden, berichten en de (gesimuleerde) actieve jobs.
import { CpfError } from './cl.js';
import { factoryState, objKey, VIRTUAL_LIBS, SYSTEM_NAME, newObject } from './db.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Achtergrondjobs, zodat WRKACTJOB er als een echt systeem uitziet
const BACKGROUND = [
  ['QBATCH', 'QSYS', [['QBATCH', 'QSYS', 'SBS', '', 'DEQW']]],
  ['QCMN', 'QSYS', [['QCMN', 'QSYS', 'SBS', '', 'DEQW']]],
  ['QCTL', 'QSYS', [['QCTL', 'QSYS', 'SBS', '', 'DEQW'], ['QSYSSCD', 'QPGMR', 'BCH', 'PGM-QEZSCNEP', 'EVTW']]],
  ['QINTER', 'QSYS', [['QINTER', 'QSYS', 'SBS', '', 'DEQW']]],
  ['QSERVER', 'QSYS', [['QSERVER', 'QSYS', 'SBS', '', 'DEQW'], ['QPWFSERVSD', 'QUSER', 'BCH', '', 'SELW'], ['QPWFSERVSO', 'QUSER', 'PJ', '', 'PSRW'], ['QZDASOINIT', 'QUSER', 'PJ', '', 'PSRW']]],
  ['QSPL', 'QSYS', [['QSPL', 'QSYS', 'SBS', '', 'DEQW'], ['PRT01', 'QSPLJOB', 'WTR', '', 'EVTW']]],
  ['QSYSWRK', 'QSYS', [['QSYSWRK', 'QSYS', 'SBS', '', 'DEQW'], ['QZHBHTTP', 'QTMHHTTP', 'BCH', 'PGM-QZHBMAIN', 'SIGW'], ['QTCPIP', 'QTCP', 'BCH', '', 'DEQW'], ['QTCPMONITR', 'QTCP', 'BCH', '', 'DEQW']]],
  ['QUSRWRK', 'QSYS', [['QUSRWRK', 'QSYS', 'SBS', '', 'DEQW'], ['QZSCSRVS', 'QUSER', 'PJ', '', 'PSRW'], ['QZRCSRVS', 'QUSER', 'PJ', '', 'PSRW']]],
];

export class System {
  constructor(state, opts = {}) {
    this.state = state || factoryState();
    this.saveFn = opts.save || null;
    this.commands = opts.commands || {};
    this.clock = opts.clock || (() => new Date());
    this.ipled = this.clock();
    this.statsStart = this.clock();
    this.interactive = []; // jobs van ingelogde gebruikers
    this.ended = new Set(); // beëindigde achtergrondjobs
    let n = 0;
    this.background = BACKGROUND.map(([sbs, user, jobs]) => ({
      sbs, user,
      jobs: jobs.map(([name, u, type, fn, sts]) => ({ name, user: u, type, fn, sts, number: 100000 + 37 * n++ })),
    }));
  }

  save() {
    try { this.saveFn?.(this.state); } catch { /* opslag niet beschikbaar */ }
  }

  get name() { return SYSTEM_NAME; }
  now() { return this.clock(); }

  // ---------- Datum en tijd in het formaat van het systeem ----------

  fmtDate(d = this.now()) {
    const sep = this.state.sysval.QDATSEP || '-';
    const dd = pad(d.getDate()), mm = pad(d.getMonth() + 1), yy = pad(d.getFullYear() % 100);
    switch (this.state.sysval.QDATFMT) {
      case 'YMD': return [yy, mm, dd].join(sep);
      case 'MDY': return [mm, dd, yy].join(sep);
      case 'JUL': return yy + sep + pad(Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5), 3);
      default: return [dd, mm, yy].join(sep);
    }
  }

  fmtTime(d = this.now()) {
    const sep = this.state.sysval.QTIMSEP || ':';
    return [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(sep);
  }

  fmtStamp(iso) {
    const d = new Date(iso);
    return `${this.fmtDate(d)}  ${this.fmtTime(d)}`;
  }

  sysval(name) {
    const d = this.now();
    if (name === 'QDATE') return this.fmtDate(d).replace(/\D/g, '');
    if (name === 'QTIME') return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    if (name === 'QYEAR') return pad(d.getFullYear() % 100);
    if (name === 'QMONTH') return pad(d.getMonth() + 1);
    if (name === 'QDAY') return pad(d.getDate());
    if (name in this.state.sysval) return this.state.sysval[name];
    throw new CpfError('CPF1028', `System value ${name} not valid.`);
  }

  // ---------- Bibliotheken en objecten ----------

  libList(job) {
    const out = [];
    for (const l of this.state.sysval.QSYSLIBL.split(/\s+/).filter(Boolean)) out.push({ name: l, type: 'SYS' });
    if (job?.curlib && this.libExists(job.curlib, job)) out.push({ name: job.curlib, type: 'CUR' });
    for (const l of job?.usrlibl || []) if (this.libExists(l, job)) out.push({ name: l, type: 'USR' });
    return out;
  }

  libExists(name, job) {
    return name in VIRTUAL_LIBS || name === 'QTEMP' ? (name !== 'QTEMP' || !!job) : !!this.state.libs[name];
  }

  lib(name, job) {
    if (name === 'QTEMP') {
      if (!job) throw new CpfError('CPF2110', 'Library QTEMP not found.');
      return job.qtemp;
    }
    if (name in VIRTUAL_LIBS) return { name, text: VIRTUAL_LIBS[name], type: '*PROD', objs: this.virtualObjs(name), virtual: true };
    const l = this.state.libs[name];
    if (!l) throw new CpfError('CPF2110', `Library ${name} not found.`);
    return l;
  }

  allLibs(job) {
    const names = ['QSYS', 'QSYS2', 'QHLPSYS', ...Object.keys(this.state.libs).sort()];
    if (job) names.push('QTEMP');
    return names.map((n) => this.lib(n, job));
  }

  virtualObjs(lib) {
    const objs = {};
    if (lib === 'QSYS') {
      const add = (o) => { objs[objKey(o.name, o.type)] = o; };
      for (const [name, def] of Object.entries(this.commands)) {
        add({ name, type: '*CMD', attr: '', text: def.desc, owner: 'QSYS', created: '1994-06-01T00:00:00Z', system: true });
      }
      for (const l of [...Object.keys(this.state.libs), 'QSYS2', 'QHLPSYS']) {
        const lib = l in VIRTUAL_LIBS ? { text: VIRTUAL_LIBS[l], type: '*PROD' } : this.state.libs[l];
        add({ name: l, type: '*LIB', attr: lib.type === '*TEST' ? 'TEST' : 'PROD', text: lib.text, owner: 'QSYS', created: lib.created || '1994-06-01T00:00:00Z', system: true });
      }
      for (const [name, text] of [['QCMD', 'Command entry'], ['QSTRUP', 'Startup program'], ['QEZSCNEP', 'Job scheduler']]) {
        add({ name, type: '*PGM', attr: 'CLP', text, owner: 'QSYS', created: '1994-06-01T00:00:00Z', system: true });
      }
      for (const u of Object.keys(this.state.users)) {
        add({ name: u, type: '*USRPRF', attr: '', text: this.state.users[u].text, owner: 'QSYS', created: '1994-06-01T00:00:00Z', system: true });
      }
      add({ name: 'QPRINT', type: '*OUTQ', attr: '', text: 'Default printer output queue', owner: 'QSYS', created: '1994-06-01T00:00:00Z', system: true });
    }
    return objs;
  }

  // Zoek een object. q = { lib, obj }; lib mag *LIBL of *CURLIB zijn.
  findObj(q, type, job) {
    const libs = this.searchLibs(q.lib, job);
    for (const l of libs) {
      let lib;
      try { lib = this.lib(l, job); } catch { continue; }
      const o = lib.objs[objKey(q.obj, type)];
      if (o) return { obj: o, lib: l };
    }
    return null;
  }

  searchLibs(lib, job) {
    if (!lib || lib === '*LIBL') return this.libList(job).map((l) => l.name);
    if (lib === '*CURLIB') {
      if (!job?.curlib) throw new CpfError('CPF2179', 'Current library not found.');
      return [job.curlib];
    }
    this.lib(lib, job); // controleert of hij bestaat
    return [lib];
  }

  getObj(q, type, job) {
    const r = this.findObj(q, type, job);
    if (!r) {
      if (q.lib && !q.lib.startsWith('*')) this.lib(q.lib, job);
      throw new CpfError('CPF9801', `Object ${q.obj} in library ${q.lib || '*LIBL'} not found.`);
    }
    return r;
  }

  // Bibliotheek om iets nieuws in te maken (*CURLIB → huidige, anders QGPL)
  targetLib(lib, job) {
    if (!lib || lib === '*CURLIB' || lib === '*LIBL') return job?.curlib && this.libExists(job.curlib, job) ? job.curlib : 'QGPL';
    return lib;
  }

  putObj(libName, obj, job) {
    const lib = this.lib(libName, job);
    if (lib.virtual) throw new CpfError('CPF2189', `Not authorized to library ${libName}.`);
    const k = objKey(obj.name, obj.type);
    if (lib.objs[k]) throw new CpfError('CPF5813', `${obj.type === '*FILE' ? 'File' : 'Object'} ${obj.name} in library ${libName} already exists.`);
    lib.objs[k] = obj;
    return obj;
  }

  delObj(libName, name, type, job) {
    const lib = this.lib(libName, job);
    if (lib.virtual) throw new CpfError('CPF2189', `Not authorized to object ${name} in ${libName} type ${type}.`);
    const k = objKey(name, type);
    if (!lib.objs[k]) throw new CpfError('CPF2105', `Object ${name} in ${libName} type ${type} not found.`);
    delete lib.objs[k];
  }

  createLib(name, type, text) {
    if (this.state.libs[name] || name in VIRTUAL_LIBS || name === 'QTEMP') {
      throw new CpfError('CPF2111', `Library ${name} already exists.`);
    }
    this.state.libs[name] = { name, text, type, created: this.now().toISOString(), objs: {} };
  }

  deleteLib(name) {
    if (name in VIRTUAL_LIBS || ['QGPL', 'QUSRSYS', 'QTEMP'].includes(name)) {
      throw new CpfError('CPF2113', `Cannot allocate library ${name}.`);
    }
    if (!this.state.libs[name]) throw new CpfError('CPF2110', `Library ${name} not found.`);
    delete this.state.libs[name];
    for (const j of this.interactive) {
      if (j.curlib === name) j.curlib = null;
      j.usrlibl = j.usrlibl.filter((l) => l !== name);
    }
  }

  // ---------- Jobs ----------

  newJob(user, device) {
    const u = this.state.users[user];
    const number = this.state.nextJob++;
    const job = {
      name: device, user, number, type: 'INT', started: this.now(),
      curlib: u.curlib && u.curlib !== '*CRTDFT' ? u.curlib : null,
      usrlibl: this.state.sysval.QUSRLIBL.split(/\s+/).filter(Boolean),
      qtemp: { name: 'QTEMP', text: '', type: '*TEST', objs: {} },
      log: [], history: [], splnbr: 0, fn: '',
    };
    this.interactive.push(job);
    return job;
  }

  endJob(job) {
    this.interactive = this.interactive.filter((j) => j !== job);
  }

  jobId(job) {
    return `${String(job.number).padStart(6, '0')}/${job.user}/${job.name}`;
  }

  // ---------- Spool ----------

  addSpool(job, file, lines, userData = '') {
    const s = {
      id: this.state.nextSpl++,
      file, user: job.user, job: job.name, jobnbr: job.number, splnbr: ++job.splnbr,
      userData: String(userData).slice(0, 10), status: 'RDY', outq: 'QPRINT',
      pages: Math.max(1, Math.ceil(lines.length / 60)), lines, created: this.now().toISOString(),
    };
    this.state.spool.push(s);
    return s;
  }

  // ---------- Berichten ----------

  sendMsg(user, text, from) {
    if (!this.state.msgq[user]) this.state.msgq[user] = [];
    this.state.msgq[user].push({ text, from, time: this.now().toISOString(), unread: true });
  }

  hasNewMsg(user) {
    return (this.state.msgq[user] || []).some((m) => m.unread);
  }

  // Grootte van de "schijf" in bytes (voor WRKSYSSTS)
  diskBytes() {
    try { return JSON.stringify(this.state).length; } catch { return 0; }
  }

  newDataObj(name, type, attr, text, extra) {
    return newObject(name, type, attr, text, extra);
  }
}
