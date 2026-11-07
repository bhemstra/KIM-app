// De werkschermen: WRKACTJOB, WRKSYSSTS, WRKSPLF, DSPMSG, PDM-lijsten,
// WRKCMD, CHGPWD en interactieve SQL (STRSQL).
import { CpfError, clString } from './cl.js';
import { Panel, ListPanel, TextView, MenuPanel, ConfirmPanel, head, fkeys, more, wrap, dataPanel } from './panels.js';
import { SYSVAL_TEXT } from './db.js';

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const lpad = (s, n) => String(s ?? '').padStart(n).slice(-n);

// Simpel "nep"-toeval dat per verversing verandert
function jitter(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

// Generieke naam (ABC*) of *ALL
export function nameMatch(pattern, name) {
  if (!pattern || pattern === '*ALL') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

// ---------- WRKACTJOB ----------

export class WrkActJobPanel extends ListPanel {
  constructor() {
    super();
    this.seed = 1;
    this.since = null;
  }

  get fn() { return 'CMD-WRKACTJOB'; }
  title() { return 'Work with Active Jobs'; }

  drawHead(scr) {
    const s = this.s;
    this.since ??= s.sys.now();
    const n = this.items().filter((i) => i.type !== 'SBS').length;
    const cpu = (2 + jitter(this.seed) * 9).toFixed(1);
    scr.text(2, 1, `CPU %:  ${lpad(cpu, 6)}     Elapsed time:   ${elapsed(s.sys.now() - this.since)}     Active jobs:  ${lpad(n + 187, 5)}`);
    return 4;
  }

  optLines() {
    return ['2=Change   3=Hold   4=End   5=Work with   6=Release   7=Display message',
      '8=Work with spooled files   13=Disconnect ...'];
  }

  colHead() { return 'Opt  Subsystem/Job  User        Type  CPU %  Function        Status'; }

  items() {
    const sys = this.s.sys;
    const out = [];
    let k = 0;
    for (const sb of sys.background) {
      out.push({ name: sb.sbs, user: sb.user, type: 'SBS', fn: '', sts: 'DEQW', indent: 0, sbs: true, number: sb.jobs[0].number });
      for (const j of sb.jobs.slice(1)) {
        if (sys.ended.has(j.name)) continue;
        out.push({ ...j, indent: 2, cpu: jitter(this.seed * 7 + k++) < 0.2 ? (jitter(k) * 2).toFixed(1) : '.0' });
      }
      if (sb.sbs === 'QINTER') {
        for (const j of sys.interactive) {
          const own = j === this.s.job;
          out.push({ name: j.name, user: j.user, type: 'INT', fn: own ? this.s.jobFunction() : 'MNU-MAIN', sts: own ? 'RUN' : 'DSPW', indent: 2, own, job: j, number: j.number, cpu: own ? (0.1 + jitter(this.seed) * 0.6).toFixed(1).replace(/^0/, '') : '.0' });
        }
      }
    }
    return out;
  }

  fmt(it) {
    const cpu = it.sbs ? '.0' : it.cpu ?? '.0';
    return `${pad(' '.repeat(it.indent) + it.name, 15)}${pad(it.user, 12)}${pad(it.type, 5)}${lpad(cpu, 6)}  ${pad(it.fn, 16)}${it.sts}`;
  }

  refresh() { this.seed++; }

  fkey(k) {
    if (k === 'F10') { this.since = this.s.sys.now(); return true; }
    if (k === 'F11' || k === 'F7' || k === 'F23') { this.s.msg('Function not available in this simulation.'); return true; }
    return false;
  }

  get opts() {
    const s = this.s;
    const id = (it) => `${String(it.number).padStart(6, '0')}/${it.user}/${it.name}`;
    return {
      4: (it) => {
        if (it.own) return s.msg('Use SIGNOFF to end your own job.');
        if (it.sbs) throw new CpfError('CPF1317', `No response from subsystem ${it.name}: ending a subsystem is not allowed here.`);
        if (s.sys.state.users[s.job.user].cls !== '*SECOFR') throw new CpfError('CPF1334', `Not authorized to end job ${id(it)}.`);
        s.sys.ended.add(it.name);
        s.msg(`Job ${id(it)} ended.`);
      },
      5: (it) => {
        if (it.own) return s.run('WRKJOB', { quiet: true });
        s.push(new TextView('Display Job Status Attributes', [
          `Job:   ${pad(it.name, 10)}  User:   ${pad(it.user, 10)}  Number:   ${String(it.number).padStart(6, '0')}`, '',
          `Status of job . . . . . . . . . . . . . . . :   ACTIVE`,
          `Entered system:`,
          `  Date  . . . . . . . . . . . . . . . . . . :   ${s.sys.fmtDate(s.sys.ipled)}`,
          `  Time  . . . . . . . . . . . . . . . . . . :   ${s.sys.fmtTime(s.sys.ipled)}`,
          `Subsystem . . . . . . . . . . . . . . . . . :   ${this.sbsOf(it)}`,
          `Type of job . . . . . . . . . . . . . . . . :   ${it.type}`,
          `Current function  . . . . . . . . . . . . . :   ${it.fn || '*NONE'}`,
          `Status  . . . . . . . . . . . . . . . . . . :   ${it.sts}`,
        ], { fkeys: ['F3=Exit   F5=Refresh   F12=Cancel'] }));
      },
      8: (it) => {
        if (it.own) return s.run('WRKSPLF', { quiet: true });
        s.msg(`No spooled output files for job ${id(it)}.`);
      },
      2: () => s.msg('Option 2 is not available in this simulation.'),
      3: () => s.msg('Option 3 is not available in this simulation.'),
      6: () => s.msg('Option 6 is not available in this simulation.'),
      7: (it) => s.msg(`No messages for job ${id(it)}.`),
      13: () => s.msg('Option 13 is not available in this simulation.'),
    };
  }

  sbsOf(it) {
    for (const sb of this.s.sys.background) if (sb.jobs.some((j) => j.name === it.name)) return sb.sbs;
    return 'QINTER';
  }

  keyLines() {
    return ['F3=Exit   F5=Refresh   F7=Find   F10=Restart statistics', 'F11=Display elapsed data   F12=Cancel   F23=More options   F24=More keys'];
  }
}

// ---------- WRKJOB ----------

export function wrkJobPanel(s) {
  const j = s.job;
  return new MenuPanel('WRKJOB', {
    title: 'Work with Job',
    noId: true,
    info(scr, sess, r) {
      scr.text(r, 1, `Job:   ${pad(j.name, 10)}     User:   ${pad(j.user, 10)}     Number:   ${String(j.number).padStart(6, '0')}`);
      return r + 2;
    },
    opts: [
      [1, 'Display job status attributes', 'DSPJOB OPTION(*STSA)'],
      [2, 'Display job definition attributes', 'DSPJOB OPTION(*DFNA)'],
      [4, 'Work with spooled files', 'WRKSPLF'],
      [10, 'Display job log', 'DSPJOBLOG'],
      [11, 'Display call stack', 'DSPJOB OPTION(*PGMSTK)'],
      [13, 'Display library list', 'DSPLIBL'],
    ],
  });
}

// ---------- WRKSYSSTS ----------

export class WrkSysStsPanel extends Panel {
  constructor() {
    super();
    this.hasCmd = true;
    this.seed = 3;
    this.since = null;
  }

  get fn() { return 'CMD-WRKSYSSTS'; }

  draw(scr) {
    const s = this.s, sys = s.sys;
    this.since ??= sys.now();
    head(scr, s, 'Work with System Status');
    const j = (k) => jitter(this.seed * 13 + k);
    const asp = 1006; // GB
    const used = 38.2 + (sys.diskBytes() / 1e6) * 2;
    const jobs = 190 + sys.interactive.length + sys.background.reduce((a, b) => a + b.jobs.length, 0);
    const L = (r, a, b) => { scr.text(r, 1, a); if (b) scr.text(r, 44, b); };
    L(2, `% CPU used  . . . . . . . :   ${lpad((1.5 + j(1) * 6).toFixed(1), 9)}`, 'Auxiliary storage:');
    L(3, `Elapsed time  . . . . . . :   ${lpad(elapsed(sys.now() - this.since), 9)}`, `  System ASP . . . . . :  ${lpad(asp, 7)} G`);
    L(4, `Jobs in system  . . . . . :   ${lpad(jobs, 9)}`, `  % system ASP used . :  ${lpad(used.toFixed(4), 9)}`);
    L(5, `% perm addresses  . . . . :   ${lpad('.007', 9)}`, `  Total  . . . . . . . :  ${lpad(asp, 7)} G`);
    L(6, `% temp addresses  . . . . :   ${lpad('.010', 9)}`, `  Current unprotect  . :  ${lpad(5642 + Math.round(j(2) * 40), 7)} M`);
    L(7, '', `  Maximum unprotect  . :  ${lpad(6012, 7)} M`);
    scr.text(9, 1, 'Type changes (if allowed), press Enter.', 'b');
    scr.text(11, 1, 'System     Pool    Reserved    Max   -----DB-----  ---Non-DB---', 'w');
    scr.text(12, 1, ' Pool    Size (M)  Size (M)  Active  Fault  Pages  Fault  Pages', 'w');
    const pools = [[1, 1450.43, 254.86, '+++++'], [2, 5821.29, 7.54, '195'], [3, 511.33, 0, '20'], [4, 2042.04, 0, '100']];
    pools.forEach(([n, size, res, act], i) => {
      const f = (k) => (j(10 + i * 4 + k) * (i === 1 ? 3 : 0.4)).toFixed(1).replace(/^0/, '');
      scr.text(13 + i, 1, `${lpad(n, 5)}   ${lpad(size.toFixed(2), 10)}${lpad(res ? res.toFixed(2) : '.00', 10)}${lpad(act, 8)}${lpad(f(0), 7)}${lpad(f(1), 7)}${lpad(f(2), 7)}${lpad(f(3), 7)}`);
    });
    more(scr, 17, false);
    this.cmdLine(scr, 19, 'Command');
    fkeys(scr, ['F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F10=Restart   F12=Cancel',
      'F19=Extended system status         F24=More keys']);
    scr.cursor = 'cmd';
  }

  key(k) {
    if (k === 'F5') { this.seed++; return; }
    if (k === 'F10') { this.since = this.s.sys.now(); this.seed++; return; }
    if (k === 'F19') return this.s.msg('Extended system status is not available in this simulation.');
    return this.std(k);
  }
}

// ---------- WRKSYSVAL ----------

export class WrkSysValPanel extends ListPanel {
  get fn() { return 'CMD-WRKSYSVAL'; }
  title() { return 'Work with System Values'; }
  optLines() { return ['2=Change   5=Display']; }
  colHead() { return 'Opt  System Value  Current value         Description'; }
  items() { return Object.keys(SYSVAL_TEXT).sort(); }
  fmt(n) { return `${pad(n, 14)}${pad(this.s.sys.sysval(n), 22)}${SYSVAL_TEXT[n]}`; }
  get opts() {
    const s = this.s;
    return {
      2: (n) => s.prompt(`CHGSYSVAL SYSVAL(${n}) VALUE(${clString(s.sys.sysval(n))})`),
      5: (n) => s.run(`DSPSYSVAL SYSVAL(${n})`, { quiet: true }),
    };
  }
}

// ---------- WRKUSRPRF ----------

export class WrkUsrPrfPanel extends ListPanel {
  get fn() { return 'CMD-WRKUSRPRF'; }
  title() { return 'Work with User Profiles'; }
  optLines() { return ['1=Create   4=Delete   5=Display']; }
  colHead() { return 'Opt  User Profile  Class       Text'; }
  items() { return Object.keys(this.s.sys.state.users).sort(); }
  fmt(u) {
    const p = this.s.sys.state.users[u];
    return `${pad(u, 14)}${pad(p.cls, 12)}${p.text}`;
  }
  keyLines() { return ['F3=Exit   F5=Refresh   F6=Create   F12=Cancel']; }
  fkey(k) {
    if (k === 'F6') { this.s.prompt('CRTUSRPRF'); return true; }
    return false;
  }
  get opts() {
    const s = this.s;
    return {
      1: (u) => s.prompt(`CRTUSRPRF USRPRF(${u})`),
      4: (u) => s.push(new ConfirmPanel({
        title: 'Confirm Delete of User Profiles',
        intro: ['Press Enter to confirm your choices for 4=Delete.', 'Press F12=Cancel to return to change your choices.'],
        colHead: 'User Profile',
        items: [u],
        action: () => s.run(`DLTUSRPRF USRPRF(${u})`, { quiet: true }),
      })),
      5: (u) => s.run(`DSPUSRPRF USRPRF(${u})`, { quiet: true }),
    };
  }
}

// ---------- WRKSPLF ----------

export class WrkSplfPanel extends ListPanel {
  constructor(user) {
    super();
    this.user = user;
  }

  get fn() { return 'CMD-WRKSPLF'; }
  title() { return 'Work with All Spooled Files'; }
  optLines() {
    return ['1=Send   2=Change   3=Hold   4=Delete   5=Display   6=Release   7=Messages',
      '8=Attributes        9=Work with printing status'];
  }
  colHead() { return 'Opt  File        User        Queue       User Data   Sts   Pages  Copies'; }
  items() {
    return this.s.sys.state.spool.filter((x) => this.user === '*ALL' || x.user === this.user);
  }
  fmt(f) {
    return `${pad(f.file, 12)}${pad(f.user, 12)}${pad(f.outq, 12)}${pad(f.userData, 12)}${pad(f.status, 4)}${lpad(f.pages, 6)}${lpad(1, 7)}`;
  }
  keyLines() { return ['F3=Exit   F10=View 4   F11=View 2   F12=Cancel   F22=Printers   F24=More keys']; }

  get opts() {
    const s = this.s, sys = s.sys;
    const del = (f) => { sys.state.spool = sys.state.spool.filter((x) => x !== f); };
    return {
      3: (f) => { f.status = 'HLD'; },
      4: (f) => s.push(new ConfirmPanel({
        title: 'Confirm Delete of Spooled Files',
        intro: ['Press Enter to confirm your choices for 4=Delete.', 'Press F12=Cancel to return to change your choices.'],
        colHead: 'Opt  File        User        Queue       User Data',
        items: [`4  ${pad(f.file, 12)}${pad(f.user, 12)}${pad(f.outq, 12)}${f.userData}`],
        action: () => { del(f); s.msg(`Spooled file ${f.file} number ${f.splnbr} deleted.`); },
      })),
      5: (f) => s.push(splfView(s, f)),
      6: (f) => { f.status = 'RDY'; },
      1: () => s.msg('There is no printer attached to this simulated system.'),
      2: () => s.msg('Option 2 is not available in this simulation.'),
      7: (f) => s.msg(`No messages for spooled file ${f.file}.`),
      8: (f) => s.push(new TextView('Work with Spooled File Attributes', [
        `Job . . . . . . . . . :   ${f.job}`,
        `  User  . . . . . . . :     ${f.user}`,
        `  Number  . . . . . . :     ${String(f.jobnbr).padStart(6, '0')}`,
        `Spooled file  . . . . :   ${f.file}`,
        `  Number  . . . . . . :     ${f.splnbr}`, '',
        `Status  . . . . . . . . . . . . . . . . :   ${f.status === 'HLD' ? 'HELD' : 'READY'}`,
        `Output queue  . . . . . . . . . . . . . :   ${f.outq}`,
        `  Library . . . . . . . . . . . . . . . :     QUSRSYS`,
        `User data . . . . . . . . . . . . . . . :   ${f.userData}`,
        `Total pages . . . . . . . . . . . . . . :   ${f.pages}`,
        `Total records . . . . . . . . . . . . . :   ${f.lines.length}`,
        `Date file opened  . . . . . . . . . . . :   ${s.sys.fmtDate(new Date(f.created))}`,
        `Time file opened  . . . . . . . . . . . :   ${s.sys.fmtTime(new Date(f.created))}`,
      ], { fkeys: ['F3=Exit   F12=Cancel'] })),
      9: () => s.msg('Option 9 is not available in this simulation.'),
    };
  }
}

export function splfView(s, f) {
  return new TextView('Display Spooled File', f.lines, {
    head(scr, r) {
      scr.text(r, 1, `File  . . . . . :   ${pad(f.file, 10)}`);
      scr.text(r, 50, `Page/Line   1/${Math.min(f.lines.length, 1)}`);
      return r + 1;
    },
    control: true,
    endMark: '                                   Bottom of data',
    fkeys: ['F3=Exit   F12=Cancel   F19=Left   F20=Right   F24=More keys'],
    fn: 'CMD-DSPSPLF',
  });
}

// ---------- DSPMSG ----------

export class DspMsgPanel extends Panel {
  constructor(user) {
    super();
    this.user = user;
    this.top = 0;
  }

  get fn() { return 'CMD-DSPMSG'; }

  msgs() {
    const q = this.s.sys.state.msgq;
    if (!q[this.user]) q[this.user] = [];
    return q[this.user];
  }

  lines() {
    const out = [];
    for (const m of [...this.msgs()].reverse()) {
      wrap(m.text, 74).forEach((l, i) => out.push({ text: (i ? '    ' : '  ') + l, attr: 'w' }));
      const d = new Date(m.time);
      out.push({ text: `    From  . . . :   ${pad(m.from, 10)}   ${this.s.sys.fmtDate(d)}   ${this.s.sys.fmtTime(d)}`, attr: 'g' });
    }
    return out;
  }

  draw(scr) {
    const s = this.s;
    head(scr, s, 'Display Messages');
    scr.text(2, 1, `Queue . . . . . :   ${pad(this.user, 10)}            Program . . . . :   *DSPMSG`);
    scr.text(3, 1, '  Library . . . :     QUSRSYS                 Library . . . :');
    scr.text(4, 1, 'Severity  . . . :   00                      Delivery  . . . :   *HOLD');
    scr.text(6, 1, 'Type reply (if required), press Enter.', 'b');
    const lines = this.lines();
    const page = 12;
    if (!lines.length) scr.text(8, 3, '(No messages available)');
    lines.slice(this.top, this.top + page).forEach((l, i) => scr.text(8 + i, 1, l.text, l.attr));
    more(scr, 20, this.top + page < lines.length);
    fkeys(scr, ['F3=Exit   F11=Remove a message   F12=Cancel', 'F13=Remove all   F16=Remove all except unanswered   F24=More keys']);
    for (const m of this.msgs()) m.unread = false;
  }

  key(k) {
    const n = this.lines().length;
    if (k === 'ROLLUP') { if (this.top + 12 < n) this.top += 12; else this.s.msg('You have reached the bottom of the list.'); return; }
    if (k === 'ROLLDOWN') { this.top = Math.max(0, this.top - 12); return; }
    if (k === 'F13' || k === 'F16' || k === 'F11') {
      const q = this.msgs();
      if (k === 'F11') q.pop(); else q.splice(0);
      this.top = 0;
      return;
    }
    if (k === 'F5' || k === 'ENTER') return k === 'ENTER' ? this.s.pop() : undefined;
    return this.std(k);
  }
}

// ---------- CHGPWD ----------

export class ChgPwdPanel extends Panel {
  get fn() { return 'CMD-CHGPWD'; }

  draw(scr) {
    const s = this.s;
    head(scr, s, 'Change Password', { sys: false });
    const u = s.sys.state.users[s.job.user];
    scr.text(2, 1, `Password last changed . . . . . . . . . . :   ${s.sys.fmtDate(new Date(u.pwdChanged || s.sys.ipled))}`);
    scr.text(4, 1, 'Type choices, press Enter.', 'b');
    scr.text(6, 3, dots2('Current password', 40));
    scr.field(6, 45, 10, 'cur', { hidden: true });
    scr.text(8, 3, dots2('New password', 40));
    scr.field(8, 45, 10, 'new', { hidden: true });
    scr.text(10, 3, dots2('New password (to verify)', 40));
    scr.field(10, 45, 10, 'ver', { hidden: true });
    fkeys(scr, ['F3=Exit   F12=Cancel']);
    scr.cursor = 'cur';
  }

  key(k) {
    if (k !== 'ENTER') return this.std(k);
    const s = this.s;
    const u = s.sys.state.users[s.job.user];
    const cur = (this.v.cur || '').trim().toUpperCase();
    const nw = (this.v.new || '').trim().toUpperCase();
    const ver = (this.v.ver || '').trim().toUpperCase();
    this.v = {};
    if (cur !== u.pwd) return s.msg('Password not correct.', 'err', 'CPF2362');
    if (!nw || !/^[A-Z0-9@#$_]{1,10}$/.test(nw)) return s.msg('New password not valid.', 'err', 'CPF2363');
    if (nw !== ver) return s.msg('New password and verify password must be the same.', 'err', 'CPF2364');
    if (nw === cur) return s.msg('New password same as current password.', 'err', 'CPF2365');
    u.pwd = nw;
    u.pwdChanged = s.sys.now().toISOString();
    s.pop();
    s.msg('Password changed successfully.');
  }
}

function dots2(t, w) {
  let s = t + ' ';
  while (s.length < w) s += s.length % 2 ? '.' : ' ';
  return s;
}

// ---------- Bibliotheken ----------

export class LibListPanel extends ListPanel {
  constructor(o) {
    super();
    this.o = o; // { pdm, list: '*LIBL' | '*ALL' | patroon }
  }

  get fn() { return this.o.pdm ? 'CMD-WRKLIBPDM' : 'CMD-WRKLIB'; }
  title() { return this.o.pdm ? 'Work with Libraries Using PDM' : 'Work with Libraries'; }
  drawHead(scr) {
    scr.text(2, 1, `List type . . . . . . . :   ${this.o.list}`);
    return 4;
  }
  optLines() {
    return this.o.pdm ? ['2=Change   3=Copy   4=Delete   5=Display   7=Rename', '8=Display description   9=Save   10=Restore   12=Work with ...']
      : ['1=Create   4=Delete   5=Display   8=Display description   12=Work with objects'];
  }
  colHead() { return 'Opt  Library     Type        Text'; }
  items() {
    const s = this.s;
    if (this.o.list === '*LIBL') {
      return s.sys.libList(s.job).map((l) => ({ ...s.sys.lib(l.name, s.job), name: l.name }));
    }
    return s.sys.allLibs(s.job).filter((l) => nameMatch(this.o.list, l.name));
  }
  fmt(l) { return `${pad(l.name, 12)}${pad(l.type === '*TEST' ? '*TEST' : '*PROD', 12)}${l.text}`; }
  keyLines() {
    return this.o.pdm ? ['F3=Exit          F4=Prompt             F5=Refresh            F6=Create',
      'F9=Retrieve      F10=Command entry     F23=More options      F24=More keys']
      : ['F3=Exit   F4=Prompt   F5=Refresh   F6=Create   F9=Retrieve   F12=Cancel'];
  }
  fkey(k) {
    if (k === 'F6') { this.s.prompt('CRTLIB'); return true; }
    if (k === 'F10' && this.o.pdm) { this.s.run('CALL QCMD', { quiet: true }); return true; }
    return false;
  }
  get opts() {
    const s = this.s;
    return {
      1: () => s.prompt('CRTLIB'),
      4: (l) => s.push(new ConfirmPanel({
        title: 'Confirm Delete of Libraries',
        intro: ['Press Enter to confirm your choices for 4=Delete.', 'Press F12=Cancel to return to change your choices.'],
        colHead: 'Library     Text',
        items: [`${pad(l.name, 12)}${l.text}`],
        action: () => s.run(`DLTLIB LIB(${l.name})`, { quiet: true }),
      })),
      5: (l) => s.run(`DSPLIB LIB(${l.name})`, { quiet: true }),
      8: (l) => s.run(`DSPOBJD OBJ(QSYS/${l.name}) OBJTYPE(*LIB)`, { quiet: true }),
      12: (l) => s.run(`WRKOBJPDM LIB(${l.name})`, { quiet: true }),
      2: () => s.msg('Option 2 is not available in this simulation.'),
      3: () => s.msg('Option 3 is not available in this simulation.'),
      7: () => s.msg('Option 7 is not available in this simulation.'),
      9: () => s.msg('There is no tape drive attached to this simulated system.'),
      10: () => s.msg('There is no tape drive attached to this simulated system.'),
    };
  }
}

// ---------- Objecten ----------

export class ObjListPanel extends ListPanel {
  constructor(o) {
    super();
    this.o = o; // { pdm, lib, obj (patroon), type }
  }

  get fn() { return this.o.pdm ? 'CMD-WRKOBJPDM' : 'CMD-WRKOBJ'; }
  title() { return this.o.pdm ? 'Work with Objects Using PDM' : 'Work with Objects'; }
  drawHead(scr) {
    if (this.o.pdm) {
      scr.text(2, 1, `Library . . . . .   ${pad(this.o.lib, 10)}`);
      return 4;
    }
    return 2;
  }
  optLines() {
    return this.o.pdm ? ['2=Change   3=Copy   4=Delete   5=Display   7=Rename   8=Display description',
      '9=Save   10=Restore   11=Move ...   12=Work with   16=Run']
      : ['2=Edit authority   3=Copy   4=Delete   5=Display authority   7=Rename', '8=Display description   13=Change description'];
  }
  colHead() {
    return this.o.pdm ? 'Opt  Object      Type        Attribute   Text' : 'Opt  Object      Type        Library     Attribute   Text';
  }
  items() {
    const s = this.s, sys = s.sys;
    const libs = this.o.pdm ? [this.o.lib] : sys.searchLibs(this.o.lib === '*ALL' ? '*LIBL' : this.o.lib, s.job);
    const out = [];
    const libNames = this.o.lib === '*ALL' ? sys.allLibs(s.job).map((l) => l.name) : libs;
    for (const ln of libNames) {
      let lib;
      try { lib = sys.lib(ln, s.job); } catch { continue; }
      const objs = Object.values(lib.objs).filter((o) => nameMatch(this.o.obj, o.name) && (this.o.type === '*ALL' || o.type === this.o.type));
      objs.sort((a, b) => (a.name + a.type).localeCompare(b.name + b.type));
      for (const o of objs) out.push({ o, lib: ln });
    }
    return out;
  }
  fmt({ o, lib }) {
    const attr = o.type === '*FILE' ? (o.src ? 'PF-SRC' : 'PF-DTA') : o.attr;
    return this.o.pdm ? `${pad(o.name, 12)}${pad(o.type, 12)}${pad(attr, 12)}${o.text}`
      : `${pad(o.name, 12)}${pad(o.type, 12)}${pad(lib, 12)}${pad(attr, 12)}${o.text}`;
  }
  keyLines() {
    return this.o.pdm ? ['F3=Exit          F4=Prompt             F5=Refresh            F6=Create',
      'F9=Retrieve      F10=Command entry     F23=More options      F24=More keys']
      : ['F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F11=Display names and types', 'F12=Cancel   F16=Repeat position to   F17=Position to   F24=More keys'];
  }
  fkey(k) {
    if (k === 'F6' && this.o.pdm) { this.s.prompt(`CRTSRCPF FILE(${this.o.lib}/QCLSRC)`); return true; }
    if (k === 'F10' && this.o.pdm) { this.s.run('CALL QCMD', { quiet: true }); return true; }
    return false;
  }
  get opts() {
    const s = this.s;
    const na = (n) => () => s.msg(`Option ${n} is not available in this simulation.`);
    return {
      4: ({ o, lib }) => s.push(new ConfirmPanel({
        title: 'Confirm Delete of Objects',
        intro: ['Press Enter to confirm your choices for 4=Delete.', 'Press F12=Cancel to return to change your choices.'],
        colHead: 'Object      Type        Library',
        items: [`${pad(o.name, 12)}${pad(o.type, 12)}${lib}`],
        action: () => s.run(`DLTOBJ OBJ(${lib}/${o.name}) OBJTYPE(${o.type})`, { quiet: true }),
      })),
      5: ({ o, lib }) => {
        if (o.type === '*FILE' && o.src) return s.run(`WRKMBRPDM FILE(${lib}/${o.name})`, { quiet: true });
        if (o.type === '*FILE') return s.run(`RUNQRY QRY(*NONE) QRYFILE((${lib}/${o.name}))`, { quiet: true });
        if (o.type === '*LIB') return s.run(`DSPLIB LIB(${o.name})`, { quiet: true });
        return s.run(`DSPOBJD OBJ(${lib}/${o.name}) OBJTYPE(${o.type})`, { quiet: true });
      },
      8: ({ o, lib }) => s.run(`DSPOBJD OBJ(${lib}/${o.name}) OBJTYPE(${o.type})`, { quiet: true }),
      12: ({ o, lib }) => {
        if (o.type === '*FILE' && o.src) return s.run(`WRKMBRPDM FILE(${lib}/${o.name})`, { quiet: true });
        if (o.type === '*FILE') return s.run(`DSPPFM FILE(${lib}/${o.name})`, { quiet: true });
        if (o.type === '*LIB') return s.run(`WRKOBJPDM LIB(${o.name})`, { quiet: true });
        throw new CpfError('PDM0001', `Option 12 not valid for object type ${o.type}.`);
      },
      16: ({ o, lib }) => {
        if (o.type !== '*PGM') throw new CpfError('PDM0002', `Option 16 not valid for object type ${o.type}.`);
        return s.run(`CALL PGM(${lib}/${o.name})`, { quiet: true });
      },
      2: na(2), 3: na(3), 7: na(7), 9: na(9), 10: na(10), 11: na(11), 13: na(13),
    };
  }
}

// ---------- Members (PDM) ----------

export class MbrListPanel extends ListPanel {
  constructor(lib, file) {
    super();
    this.lib = lib;
    this.file = file;
  }

  get fn() { return 'CMD-WRKMBRPDM'; }
  title() { return 'Work with Members Using PDM'; }
  srcFile() {
    const r = this.s.sys.findObj({ lib: this.lib, obj: this.file }, '*FILE', this.s.job);
    return r?.obj;
  }
  drawHead(scr) {
    scr.text(2, 1, `File  . . . . . .   ${pad(this.file, 10)}`);
    scr.text(3, 1, `  Library . . . .     ${pad(this.lib, 10)}`);
    return 5;
  }
  optLines() {
    return ['2=Edit         3=Copy  4=Delete 5=Display       6=Print     7=Rename',
      '8=Display description  9=Save  13=Change text  14=Compile  15=Create module...'];
  }
  colHead() { return 'Opt  Member      Type        Text'; }
  items() {
    const f = this.srcFile();
    if (!f) return [];
    return Object.keys(f.members).sort().map((name) => ({ name, m: f.members[name] }));
  }
  fmt({ name, m }) { return `${pad(name, 12)}${pad(m.type, 12)}${m.text}`; }
  keyLines() {
    return ['F3=Exit          F4=Prompt             F5=Refresh            F6=Create',
      'F9=Retrieve      F10=Command entry     F23=More options      F24=More keys'];
  }
  fkey(k) {
    if (k === 'F6') { this.s.prompt(`STRSEU SRCFILE(${this.lib}/${this.file})`); return true; }
    if (k === 'F10') { this.s.run('CALL QCMD', { quiet: true }); return true; }
    return false;
  }
  get opts() {
    const s = this.s;
    const q = `${this.lib}/${this.file}`;
    const na = (n) => () => s.msg(`Option ${n} is not available in this simulation.`);
    return {
      2: ({ name }) => s.run(`STRSEU SRCFILE(${q}) SRCMBR(${name}) OPTION(2)`, { quiet: true }),
      5: ({ name }) => s.run(`STRSEU SRCFILE(${q}) SRCMBR(${name}) OPTION(5)`, { quiet: true }),
      4: ({ name, m }) => s.push(new ConfirmPanel({
        title: 'Confirm Delete of Members',
        intro: ['Press Enter to confirm your choices for 4=Delete.', 'Press F12=Cancel to return to change your choices.'],
        colHead: 'Member      Type        Text',
        items: [`${pad(name, 12)}${pad(m.type, 12)}${m.text}`],
        action: () => s.run(`RMVM FILE(${q}) MBR(${name})`, { quiet: true }),
      })),
      6: ({ name }) => {
        const f = this.srcFile();
        const lines = f.members[name].lines.map((l) => `${l.seq}  ${l.data}`);
        s.sys.addSpool(s.job, this.file, [`Source member ${name} in file ${q}`, '', ...lines], name);
        s.msg(`Member ${name} printed to spooled file ${this.file}.`);
      },
      14: ({ name, m }) => {
        const cmd = m.type === 'CLP' ? 'CRTCLPGM' : m.type === 'CLLE' ? 'CRTBNDCL' : null;
        if (!cmd) throw new CpfError('PDM0003', `Option 14 not valid for member type ${m.type}.`);
        s.run(`${cmd} PGM(${this.lib}/${name}) SRCFILE(${q}) SRCMBR(${name})`, { quiet: true });
      },
      3: na(3), 7: na(7), 8: na(8), 9: na(9), 13: na(13), 15: na(15),
    };
  }
}

// ---------- WRKCMD ----------

export class WrkCmdPanel extends ListPanel {
  constructor(commands, pattern = '*ALL') {
    super();
    this.commands = commands;
    this.pattern = pattern;
  }

  get fn() { return 'CMD-WRKCMD'; }
  title() { return 'Work with Commands'; }
  optLines() { return ['1=Select (prompt)   5=Display description']; }
  colHead() { return 'Opt  Command     Library     Text'; }
  items() { return Object.keys(this.commands).filter((c) => nameMatch(this.pattern, c)).sort(); }
  fmt(c) { return `${pad(c, 12)}${pad('QSYS', 12)}${this.commands[c].desc}`; }
  get opts() {
    const s = this.s;
    return {
      1: (c) => s.prompt(c),
      5: (c) => s.run(`DSPCMD CMD(${c})`, { quiet: true }),
    };
  }
}

// ---------- Interactieve SQL ----------

export class SqlPanel extends Panel {
  constructor() {
    super();
    this.hist = [];
    this.stmts = [];
    this.ret = -1;
    this.back = 0;
  }

  get fn() { return 'CMD-STRSQL'; }

  draw(scr) {
    scr.center(0, 'Enter SQL Statements', 'w');
    scr.text(2, 1, 'Type SQL statement, press Enter.', 'b');
    const page = 12;
    const maxBack = Math.max(0, this.hist.length - page);
    this.back = Math.min(this.back, maxBack);
    const start = Math.max(0, this.hist.length - page - this.back);
    this.hist.slice(start, start + page).forEach((l, i) => scr.text(3 + i, 1, l.text.slice(0, 78), l.attr));
    scr.text(15, 1, '===>');
    for (let i = 0; i < 4; i++) scr.field(15 + i, 6, 73, 'sql.' + i, { value: this.v['sql.' + i] || '', upper: false, underline: false });
    more(scr, 20, this.back > 0);
    fkeys(scr, ['F3=Exit    F4=Prompt    F6=Insert line    F9=Retrieve    F10=Copy line',
      'F12=Cancel    F13=Services    F24=More keys']);
    scr.cursor = 'sql.0';
  }

  key(k) {
    const s = this.s;
    if (k === 'ROLLDOWN') { this.back += 12; return; }
    if (k === 'ROLLUP') { this.back = Math.max(0, this.back - 12); return; }
    if (k === 'F9') {
      if (!this.stmts.length) return;
      this.ret = this.ret <= 0 ? this.stmts.length - 1 : this.ret - 1;
      const t = this.stmts[this.ret];
      for (let i = 0; i < 4; i++) this.v['sql.' + i] = t.slice(i * 73, (i + 1) * 73);
      return;
    }
    if (k === 'F4' || k === 'F13' || k === 'F6' || k === 'F10') return s.msg('Function not available in this simulation.');
    if (k !== 'ENTER') return this.std(k);
    const text = [0, 1, 2, 3].map((i) => this.v['sql.' + i] || '').join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.stmts.push(text);
    this.ret = -1;
    this.back = 0;
    for (const l of wrap(text, 74)) this.hist.push({ text: '  > ' + l, attr: 'w' });
    try {
      const r = s.sql(text);
      for (let i = 0; i < 4; i++) this.v['sql.' + i] = '';
      if (r.type === 'select') {
        const msg = `SELECT statement run complete.`;
        this.hist.push({ text: '    ' + msg, attr: 'g' });
        s.push(dataPanel('Display Data', r.columns, r.rows, { fn: 'CMD-STRSQL', exitPops: true }));
        return;
      }
      this.hist.push({ text: '    ' + r.message, attr: 'g' });
      s.msg(r.message);
    } catch (e) {
      if (!(e instanceof CpfError)) throw e;
      this.hist.push({ text: '    ' + e.text, attr: 'w' });
      s.msg(e.text, 'err', e.id);
    }
  }
}
