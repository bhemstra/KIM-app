// Generieke 5250-schermen: menu's, lijsten met opties, tekstweergave, de
// prompter (F4), aanmelden, berichten en bevestigingen.
import { Screen, COLS } from './screen.js';
import { CpfError, parseCommand, parseQual, normVal, quote } from './cl.js';
import { fmtValue, colWidth, isNumericCol } from './sql.js';

export { Screen };

// ---------- Hulpjes voor de opmaak ----------

export function head(scr, s, title, o = {}) {
  scr.center(0, title, 'w');
  if (o.menu) scr.text(0, 1, o.menu, 'w');
  if (o.sysLine) {
    scr.text(1, 60, `System:   ${s.sys.name}`, 'w');
  } else if (o.sys !== false) {
    scr.text(0, 79 - s.sys.name.length, s.sys.name, 'w');
    if (o.date !== false) {
      const t = `${s.sys.fmtDate()}  ${s.sys.fmtTime()}`;
      scr.text(1, 79 - t.length, t, 'w');
    }
  }
}

export function fkeys(scr, lines) {
  lines.forEach((l, i) => scr.text(21 + i, 1, l, 'b'));
}

export function more(scr, row, isMore) {
  const t = isMore ? 'More...' : 'Bottom';
  scr.text(row, 79 - t.length, t, 'w');
}

// "Library . . . . . . . . ." tot een vaste breedte
export function dots(text, width) {
  let s = text;
  if (s.length < width) s += ' ';
  while (s.length < width) s += s.length % 2 === width % 2 ? '.' : ' ';
  return s.slice(0, width);
}

export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/)) {
      if (!w) continue;
      if (line && line.length + 1 + w.length > width) { out.push(line); line = ''; }
      line = line ? line + ' ' + w : w;
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

export function ruler(from, width) {
  let r = '';
  for (let c = from + 1; r.length < width; c++) {
    if (c % 10 === 0) r += String(c / 10 % 10);
    else if (c % 5 === 0) r += '+';
    else r += '.';
  }
  return r;
}

// ---------- Basisklasse ----------

export class Panel {
  constructor() {
    this.v = {}; // ingevulde veldwaarden
    this.s = null; // sessie, gezet bij push()
    this.hasCmd = false;
  }

  draw() {}

  key(k) { this.std(k); }

  std(k) {
    const s = this.s;
    switch (k) {
      case 'F3': return s.exit();
      case 'F12': return s.pop();
      case 'F9':
        if (this.hasCmd) { this.v.cmd = s.retrieve(); return; }
        break;
      case 'F4':
        if (this.hasCmd) { if (s.prompt((this.v.cmd || '').trim())) this.v.cmd = ''; return; }
        break;
      case 'ENTER':
        if (this.hasCmd) { this.runCmd(); return; }
        return;
      case 'ROLLUP':
      case 'ROLLDOWN':
        return s.msg('Roll key not allowed on this display.');
      case 'HELP':
      case 'F1':
        return s.help();
    }
    s.msg('Function key not allowed.');
  }

  runCmd() {
    const c = (this.v.cmd || '').trim();
    if (!c) return false;
    if (this.s.run(c)) this.v.cmd = '';
    return true;
  }

  cmdLine(scr, row, label) {
    if (label) scr.text(row - 1, 1, label);
    scr.text(row, 1, '===>');
    scr.field(row, 6, 73, 'cmd', { value: this.v.cmd || '', upper: false });
  }

  // Naam voor WRKACTJOB (Function-kolom)
  get fn() { return ''; }
}

// ---------- Menu's ----------

export const MENUS = {
  MAIN: {
    title: 'AS/400 Main Menu',
    opts: [
      [1, 'User tasks', 'GO USER'],
      [2, 'Office tasks', null],
      [3, 'General system tasks', 'GO SYSTEM'],
      [4, 'Files, libraries, and folders', 'GO DATA'],
      [5, 'Programming', 'GO PROGRAM'],
      [6, 'Communications', null],
      [7, 'Define or change the system', null],
      [8, 'Problem handling', null],
      [9, 'Display a menu', '?GO'],
      [10, 'Information Assistant options', null],
      [11, 'Client Access/400 tasks', null],
      [90, 'Sign off', 'SIGNOFF'],
    ],
  },
  USER: {
    title: 'User Tasks',
    opts: [
      [1, 'Display or change your job', 'WRKJOB'],
      [2, 'Display messages', 'DSPMSG'],
      [3, 'Send a message', '?SNDMSG'],
      [4, 'Submit a job', '?SBMJOB'],
      [5, 'Work with your spooled output files', 'WRKSPLF'],
      [6, 'Change your password', 'CHGPWD'],
      [7, 'Display your library list', 'DSPLIBL'],
    ],
  },
  SYSTEM: {
    title: 'General System Tasks',
    opts: [
      [1, 'Work with active jobs', 'WRKACTJOB'],
      [2, 'Work with system status', 'WRKSYSSTS'],
      [3, 'Work with system values', 'WRKSYSVAL'],
      [4, 'Work with user profiles', 'WRKUSRPRF'],
      [5, 'Work with spooled files', 'WRKSPLF'],
      [6, 'Power on and off tasks', '?PWRDWNSYS'],
    ],
  },
  DATA: {
    title: 'Files, Libraries, and Folders',
    opts: [
      [1, 'Work with libraries', 'WRKLIB'],
      [2, 'Work with objects', '?WRKOBJ'],
      [3, 'Display library list', 'DSPLIBL'],
      [4, 'Create a library', '?CRTLIB'],
      [5, 'Run a query against a file', '?RUNQRY'],
      [6, 'Display a physical file member', '?DSPPFM'],
    ],
  },
  PROGRAM: {
    title: 'Programming',
    opts: [
      [1, 'Programming Development Manager (PDM)', 'STRPDM'],
      [2, 'Interactive SQL', 'STRSQL'],
      [3, 'Source Entry Utility (SEU)', '?STRSEU'],
      [4, 'Command entry', 'CALL QCMD'],
      [5, 'Create a CL program', '?CRTCLPGM'],
      [6, 'Work with spooled files', 'WRKSPLF'],
    ],
  },
  PDM: {
    title: 'AS/400 Programming Development Manager (PDM)',
    opts: [
      [1, 'Work with libraries', '?WRKLIBPDM'],
      [2, 'Work with objects', '?WRKOBJPDM'],
      [3, 'Work with members', '?WRKMBRPDM'],
      [9, 'Work with user-defined options', null],
    ],
  },
};

export class MenuPanel extends Panel {
  // id uit MENUS, of een eigen definitie { title, opts, info(scr) }
  constructor(id, def = null) {
    super();
    this.id = id;
    this.def = def || MENUS[id];
    this.isMenu = true;
    this.hasCmd = true;
  }

  get fn() { return 'MNU-' + this.id; }

  draw(scr) {
    const s = this.s;
    head(scr, s, this.def.title, { menu: this.def.noId ? null : this.id, sysLine: true });
    let r = 2;
    if (this.def.info) r = this.def.info(scr, s, r);
    scr.text(r, 1, 'Select one of the following:');
    r += 2;
    for (const [n, text] of this.def.opts) {
      if (n === 90) r++;
      scr.text(r++, 5, `${String(n).padStart(3)}. ${text}`);
    }
    this.cmdLine(scr, 19, 'Selection or command');
    fkeys(scr, ['F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel   F13=Information Assistant',
      'F23=Set initial menu']);
    scr.cursor = 'cmd';
  }

  key(k) {
    if (k === 'ENTER') {
      const c = (this.v.cmd || '').trim();
      if (/^\d+$/.test(c)) {
        const o = this.def.opts.find((x) => x[0] === Number(c));
        if (!o) return this.s.msg(`Selection ${c} not valid.`, 'err');
        if (!o[2]) return this.s.msg(`Option ${c} is not available in this simulation.`, 'err');
        if (this.s.run(o[2], { quiet: true })) this.v.cmd = '';
        return;
      }
      return this.runCmd();
    }
    if (k === 'F13') return this.s.msg('Information Assistant is not available in this simulation.');
    if (k === 'F23') {
      const u = this.s.sys.state.users[this.s.job.user];
      u.inlmnu = this.id;
      return this.s.msg(`Initial menu changed to ${this.id}.`);
    }
    return this.std(k);
  }
}

// ---------- Command Entry (CALL QCMD) ----------

export class CmdEntryPanel extends Panel {
  constructor() {
    super();
    this.isMenu = true;
    this.hasCmd = true;
    this.back = 0; // aantal regels teruggescrold
  }

  get fn() { return 'PGM-QCMD'; }

  logLines() {
    const out = [];
    for (const e of this.s.job.log) {
      if (e.kind === 'cmd') out.push({ text: '  > ' + e.text, attr: 'w' });
      else for (const l of wrap(e.text, 74)) out.push({ text: '    ' + l, attr: 'g' });
    }
    return out;
  }

  draw(scr) {
    head(scr, this.s, 'Command Entry', { date: false });
    scr.text(1, 58, 'Request level:   1', 'w');
    scr.text(2, 1, 'Previous commands and messages:');
    const lines = this.logLines();
    const page = 14;
    const maxBack = Math.max(0, lines.length - page);
    this.back = Math.min(this.back, maxBack);
    const start = Math.max(0, lines.length - page - this.back);
    lines.slice(start, start + page).forEach((l, i) => scr.text(3 + i, 1, l.text.slice(0, 78), l.attr));
    more(scr, 17, this.back > 0);
    this.cmdLine(scr, 19, 'Type command, press Enter.');
    fkeys(scr, ['F3=Exit   F4=Prompt   F9=Retrieve   F10=Include detailed messages',
      'F11=Display full      F12=Cancel     F13=Information Assistant  F24=More keys']);
    scr.cursor = 'cmd';
  }

  key(k) {
    if (k === 'ROLLDOWN') { this.back += 14; return; }
    if (k === 'ROLLUP') { this.back = Math.max(0, this.back - 14); return; }
    if (k === 'F10' || k === 'F11') return;
    return this.std(k);
  }
}

// ---------- Lijst met opties (WRKxxx) ----------

export class ListPanel extends Panel {
  constructor() {
    super();
    this.top = 0;
    this.hasCmd = true;
    this.pageSize = 10;
    this.cmdLabel = 'Parameters or command';
  }

  title() { return ''; }
  drawHead() { return 2; }
  optLines() { return []; }
  colHead() { return ''; }
  items() { return []; }
  fmt() { return ''; }
  get opts() { return {}; }
  keyLines() { return ['F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F12=Cancel']; }
  fkey() { return false; }

  draw(scr) {
    head(scr, this.s, this.title());
    let r = this.drawHead(scr);
    const ol = this.optLines();
    if (ol.length) {
      scr.text(r++, 1, 'Type options, press Enter.', 'b');
      for (const l of ol) scr.text(r++, 2, l, 'b');
    }
    r++;
    scr.text(r++, 1, this.colHead(), 'w');
    const last = this.hasCmd ? 16 : 18;
    this.pageSize = Math.max(1, last - r + 1);
    const items = this.items();
    if (this.top >= items.length) this.top = Math.max(0, items.length - this.pageSize);
    const hasOpts = Object.keys(this.opts).length > 0;
    let firstField = null;
    for (let i = 0; i < this.pageSize; i++) {
      const it = items[this.top + i];
      if (!it) break;
      if (hasOpts) {
        scr.field(r + i, 2, 2, 'opt.' + i, { value: this.v['opt.' + i] || '' });
        firstField ??= 'opt.' + i;
      }
      scr.text(r + i, 6, this.fmt(it).slice(0, 73));
    }
    if (!items.length) scr.text(r, 6, this.emptyText || '(No items to display)');
    more(scr, last + 1, this.top + this.pageSize < items.length);
    if (this.hasCmd) this.cmdLine(scr, 19, this.cmdLabel);
    fkeys(scr, this.keyLines());
    scr.cursor = firstField || (this.hasCmd ? 'cmd' : null);
  }

  key(k) {
    const items = this.items();
    if (k === 'ROLLUP') {
      if (this.top + this.pageSize >= items.length) return this.s.msg('You have reached the bottom of the list.');
      this.top += this.pageSize;
      this.clearOpts();
      return;
    }
    if (k === 'ROLLDOWN') {
      if (this.top === 0) return this.s.msg('You have reached the top of the list.');
      this.top = Math.max(0, this.top - this.pageSize);
      this.clearOpts();
      return;
    }
    if (k === 'F5') { this.clearOpts(); this.refresh?.(); return; }
    if (k === 'ENTER') return this.enter(items);
    if (this.fkey(k)) return;
    return this.std(k);
  }

  clearOpts() {
    for (const k of Object.keys(this.v)) if (k.startsWith('opt.')) delete this.v[k];
  }

  enter(items) {
    const sel = [];
    for (let i = 0; i < this.pageSize; i++) {
      const o = (this.v['opt.' + i] || '').trim();
      const it = items[this.top + i];
      if (o && it) sel.push({ o: String(Number(o)) === 'NaN' ? o : String(Number(o)), it, i });
    }
    if (!sel.length) { this.runCmd(); return; }
    const opts = this.opts;
    const bad = sel.find((x) => !opts[x.o]);
    if (bad) return this.s.msg(`Option ${bad.o} not valid.`, 'err');
    this.clearOpts();
    // Achterstevoren, zodat het scherm van de eerste keuze bovenop komt
    for (const x of sel.reverse()) {
      try {
        opts[x.o].call(this, x.it);
      } catch (e) {
        if (!(e instanceof CpfError)) throw e;
        this.s.msg(e.text, 'err', e.id);
      }
    }
  }
}

// ---------- Tekst bekijken (spoolbestanden, DSPxxx, query-resultaten) ----------

export class TextView extends Panel {
  // o: { head(scr, r) → r, control, ruler, colHead, position, fkeys, endMark, fn }
  constructor(title, lines, o = {}) {
    super();
    this.title = title;
    this.lines = lines;
    this.o = o;
    this.top = 0;
    this.col = 0;
    this.lastFind = '';
  }

  get fn() { return this.o.fn || ''; }

  width() {
    return Math.max(this.o.colHead?.length || 0, ...this.lines.map((l) => (typeof l === 'string' ? l : l.text).length));
  }

  draw(scr) {
    head(scr, this.s, this.title, { sys: this.o.sys ?? false });
    let r = 2;
    if (this.o.head) r = this.o.head.call(this, scr, r);
    if (this.o.control) {
      scr.text(r, 1, 'Control . . . . .');
      scr.field(r, 20, 8, 'ctl', { value: this.v.ctl || '' });
      scr.text(r, 40, `Columns . . . . . :   ${this.col + 1} - ${this.col + 78}`);
      r++;
      scr.text(r, 1, 'Find  . . . . . .');
      scr.field(r, 20, 30, 'find', { value: this.v.find ?? this.lastFind, upper: false });
      r++;
    }
    if (this.o.position) {
      scr.text(r, 1, 'Position to line  . . . . .');
      scr.field(r, 30, 6, 'pos', { value: this.v.pos || '' });
      scr.text(r, 40, 'Shift to column  . . . . . .');
      scr.field(r, 70, 4, 'shift', { value: this.v.shift || '' });
      r++;
    }
    if (this.o.ruler) scr.text(r++, 1, (this.o.lineNumbers ? 'Line   ' : '') + ruler(this.col, 78 - (this.o.lineNumbers ? 7 : 0)), 'w');
    if (this.o.colHead !== undefined) {
      scr.text(r++, 1, (this.o.lineNumbers ? '       ' : '') + this.o.colHead.slice(this.col, this.col + (this.o.lineNumbers ? 71 : 78)), 'w');
    }
    const last = 19;
    this.pageSize = last - r + 1;
    const all = this.allLines();
    if (this.top >= all.length) this.top = Math.max(0, all.length - this.pageSize);
    for (let i = 0; i < this.pageSize; i++) {
      const l = all[this.top + i];
      if (l === undefined) break;
      const text = typeof l === 'string' ? l : l.text;
      const attr = typeof l === 'string' ? 'g' : l.attr || 'g';
      if (this.o.lineNumbers && !l.mark) {
        scr.text(r + i, 1, String(this.top + i + 1).padStart(6, '0') + ' ' + text.slice(this.col, this.col + 71), attr);
      } else scr.text(r + i, 1, text.slice(l.mark ? 0 : this.col, (l.mark ? 0 : this.col) + 78), attr);
    }
    more(scr, 20, this.top + this.pageSize < all.length);
    fkeys(scr, this.o.fkeys || ['F3=Exit   F12=Cancel   F19=Left   F20=Right']);
    scr.cursor = this.o.control ? 'ctl' : this.o.position ? 'pos' : null;
  }

  allLines() {
    if (!this.o.endMark) return this.lines;
    return [...this.lines, { text: this.o.endMark, attr: 'w', mark: true }];
  }

  key(k) {
    const n = this.allLines().length;
    switch (k) {
      case 'ROLLUP':
        if (this.top + this.pageSize >= n) return this.s.msg('You have reached the bottom of the information.');
        this.top += this.pageSize;
        return;
      case 'ROLLDOWN':
        if (this.top === 0) return this.s.msg('You have reached the top of the information.');
        this.top = Math.max(0, this.top - this.pageSize);
        return;
      case 'F19':
        this.col = Math.max(0, this.col - 40);
        return;
      case 'F20':
        if (this.col + 78 < this.width()) this.col += 40;
        return;
      case 'F16':
        return this.find(this.lastFind);
      case 'ENTER':
        return this.enter();
      case 'F3':
        if (this.o.exitPops) return this.s.pop();
    }
    return this.std(k);
  }

  enter() {
    const ctl = (this.v.ctl || '').trim().toUpperCase();
    const n = this.allLines().length;
    if (ctl) {
      this.v.ctl = '';
      let m;
      if (ctl === 'T' || ctl === 'TOP') this.top = 0;
      else if (ctl === 'B' || ctl === 'BOT' || ctl === 'BOTTOM') this.top = Math.max(0, n - this.pageSize);
      else if ((m = /^([+-])(\d+)$/.exec(ctl))) this.top = Math.max(0, Math.min(n - 1, this.top + (m[1] === '+' ? 1 : -1) * Number(m[2])));
      else if ((m = /^W([+-]?)(\d+)$/.exec(ctl))) this.col = Math.max(0, m[1] === '-' ? this.col - Number(m[2]) : m[1] === '+' ? this.col + Number(m[2]) : Number(m[2]) - 1);
      else if (/^\d+$/.test(ctl)) this.top = Math.max(0, Math.min(n - 1, Number(ctl) - 1));
      else return this.s.msg(`Control value ${ctl} not valid.`, 'err');
    }
    if (this.o.position) {
      const p = (this.v.pos || '').trim(), sh = (this.v.shift || '').trim();
      this.v.pos = '';
      this.v.shift = '';
      if (/^\d+$/.test(p)) this.top = Math.max(0, Math.min(n - 1, Number(p) - 1));
      if (/^\d+$/.test(sh)) this.col = Math.max(0, Number(sh) - 1);
    }
    if (this.o.control) {
      const f = this.v.find ?? '';
      if (f.trim() && f !== this.lastFind) { this.lastFind = f; return this.find(f); }
      this.lastFind = f;
    }
  }

  find(str) {
    if (!str || !str.trim()) return this.s.msg('Find string not specified.');
    const all = this.allLines();
    const needle = str.trim().toUpperCase();
    for (let i = 1; i <= all.length; i++) {
      const idx = (this.top + i) % all.length;
      const t = typeof all[idx] === 'string' ? all[idx] : all[idx].text;
      if (t.toUpperCase().includes(needle)) {
        this.top = idx;
        return;
      }
    }
    this.s.msg(`String ${str.trim()} not found.`);
  }
}

// Tabelweergave van een query-resultaat (SELECT en RUNQRY)
export function tableLines(columns, rows) {
  const widths = columns.map((c, i) => colWidth(c, rows, i));
  const cell = (t, c, w) => {
    t = t.length > w ? t.slice(0, w) : t;
    return isNumericCol(c) ? t.padStart(w) : t.padEnd(w);
  };
  const header = columns.map((c, i) => cell(String(c.heading || c.name), c, widths[i])).join('  ');
  const lines = rows.map((r) => columns.map((c, i) => cell(fmtValue(r[i], c), c, widths[i])).join('  ').trimEnd());
  return { header, lines, width: header.length };
}

export function dataPanel(title, columns, rows, o = {}) {
  const t = tableLines(columns, rows);
  return new TextView(title, t.lines, {
    head(scr, r) {
      if (o.query) {
        scr.text(r, 1, `Query . . . . . :   ${o.query}`);
        scr.text(r, 40, `Report width . . . . . :   ${String(t.width).padStart(5)}`);
      } else scr.text(r, 40, `Data width . . . . . . :   ${String(t.width).padStart(5)}`);
      return r + 1;
    },
    position: true,
    ruler: true,
    lineNumbers: !!o.query,
    colHead: t.header,
    endMark: '********  End of data  ********',
    fkeys: ['F3=Exit      F12=Cancel      F19=Left      F20=Right      F21=Split'],
    fn: o.fn,
    exitPops: o.exitPops,
  });
}

// ---------- De prompter (F4) ----------

export class PromptPanel extends Panel {
  // def: commandodefinitie; given: { KW: ruwe waarde }; onDone(cmd): alleen
  // de opdracht teruggeven (SEU), anders wordt hij uitgevoerd.
  constructor(def, given = {}, onDone = null) {
    super();
    this.def = def;
    this.onDone = onDone;
    this.given = given;
    this.reset();
  }

  get fn() { return 'CMD-' + this.def.name; }

  reset() {
    this.v = {};
    for (const p of this.def.params) {
      const raw = this.given[p.kw];
      if (p.kind === 'qual') {
        const q = raw !== undefined ? parseQual(raw, p.dftLib || '*LIBL') : null;
        this.v[p.kw + '.obj'] = q ? q.obj : p.dft || '';
        this.v[p.kw + '.lib'] = q ? q.lib : p.dftLib || '*LIBL';
      } else if (raw !== undefined) {
        this.v[p.kw] = p.kind === 'char' ? normVal(raw) : p.kind === 'name' ? raw.toUpperCase() : raw;
      } else this.v[p.kw] = p.dft ?? '';
    }
  }

  draw(scr) {
    scr.center(0, `${this.def.desc} (${this.def.name})`, 'w');
    scr.text(2, 1, 'Type choices, press Enter.');
    let r = 4;
    const LW = 27, FC = 29;
    const fieldLen = (p) => Math.min(p.len, 50);
    for (const p of this.def.params) {
      if (r > 19) break;
      const show = this.v.__kw ? p.kw : p.label;
      scr.text(r, 1, dots(show, LW));
      if (p.kind === 'qual') {
        scr.field(r, FC, p.len, p.kw + '.obj', { value: this.v[p.kw + '.obj'] });
        scr.text(r, FC + p.len + 2, p.choices || 'Name', 'b');
        r++;
        scr.text(r, 1, dots('  Library', LW));
        scr.field(r, FC + 2, 10, p.kw + '.lib', { value: this.v[p.kw + '.lib'] });
        scr.text(r, FC + 14, 'Name, *LIBL, *CURLIB', 'b');
      } else {
        const len = fieldLen(p);
        scr.field(r, FC, len, p.kw, { value: this.v[p.kw], upper: !(p.kind === 'char' || p.kind === 'cmd' || p.kind === 'raw' || p.lower) });
        const ch = p.choices || (p.vals ? p.vals.join(', ') : p.kind === 'dec' ? 'Number' : p.kind === 'name' ? 'Name' : '');
        if (ch && FC + len + 2 + ch.length <= 80) scr.text(r, FC + len + 2, ch, 'b');
      }
      r++;
    }
    more(scr, 20, false);
    fkeys(scr, ['F3=Exit   F4=Prompt   F5=Refresh   F11=Keywords   F12=Cancel',
      'F13=How to use this display        F24=More keys']);
    const first = this.def.params[0];
    scr.cursor = first ? (first.kind === 'qual' ? first.kw + '.obj' : first.kw) : null;
  }

  build() {
    const parts = [this.def.name];
    for (const p of this.def.params) {
      if (p.kind === 'qual') {
        const o = (this.v[p.kw + '.obj'] || '').trim().toUpperCase();
        const l = (this.v[p.kw + '.lib'] || '').trim().toUpperCase();
        if (!o) {
          if (p.req) throw new CpfError('CPD0071', `Value for parameter ${p.kw} required.`);
          continue;
        }
        const dl = p.dftLib || '*LIBL';
        const val = l && l !== dl ? `${l}/${o}` : o;
        if (p.dft && val === p.dft && (!l || l === dl)) continue;
        parts.push(`${p.kw}(${val})`);
        continue;
      }
      let val = String(this.v[p.kw] ?? '').trim();
      if (!val) {
        if (p.req) throw new CpfError('CPD0071', `Value for parameter ${p.kw} required.`);
        continue;
      }
      if (p.dft !== undefined && val.toUpperCase() === String(p.dft).toUpperCase()) continue;
      if (p.kind === 'char' && !/^'[\s\S]*'$/.test(val) && !(val.startsWith('*') && (p.vals || []).includes(val.toUpperCase()))) {
        val = quote(val);
      }
      parts.push(`${p.kw}(${val})`);
    }
    return parts.join(' ');
  }

  key(k) {
    const s = this.s;
    if (k === 'F3' || k === 'F12') return s.pop();
    if (k === 'F5') { this.reset(); return; }
    if (k === 'F11') { this.v.__kw = !this.v.__kw; return; }
    if (k === 'F4') return s.msg('No list of values available for this parameter.');
    if (k !== 'ENTER') return this.std(k);
    let cmd;
    try { cmd = this.build(); } catch (e) { return s.msg(e.text, 'err', e.id); }
    s.pop();
    if (this.onDone) return this.onDone(cmd);
    if (!s.run(cmd)) {
      const m = s.message;
      s.push(this);
      s.message = m;
    }
  }
}

// ---------- Aanmelden ----------

export class SignOnPanel extends Panel {
  constructor() {
    super();
    this.isMenu = true;
  }

  draw(scr) {
    const s = this.s;
    scr.center(0, 'Sign On', 'w');
    scr.text(1, 47, `System  . . . . . :   ${s.sys.name}`);
    scr.text(2, 47, 'Subsystem . . . . :   QINTER');
    scr.text(3, 47, `Display . . . . . :   ${s.device}`);
    const rows = [['User', 'user'], ['Password', 'pwd'], ['Program/procedure', 'pgm'], ['Menu', 'menu'], ['Current library', 'curlib']];
    rows.forEach(([label, name], i) => {
      scr.text(5 + i, 17, dots(label, 34));
      scr.field(5 + i, 53, 10, name, { value: name === 'pwd' ? '' : this.v[name] || '', hidden: name === 'pwd' });
    });
    scr.text(19, 4, 'SIM400 - een nagebootste AS/400. Gebruiker QSECOFR of GAST, wachtwoord', 't');
    scr.text(20, 4, 'gelijk aan de gebruikersnaam.', 't');
    scr.cursor = 'user';
  }

  key(k) {
    if (k !== 'ENTER') {
      if (k === 'F3' || k === 'F12') return this.s.msg('Function key not allowed.');
      return this.std(k);
    }
    const user = (this.v.user || '').trim().toUpperCase();
    const pwd = (this.v.pwd || '').trim().toUpperCase();
    this.v.pwd = '';
    if (!user) return this.s.msg('Enter a user profile name.', 'err');
    this.s.signOn(user, pwd, {
      pgm: (this.v.pgm || '').trim().toUpperCase(),
      menu: (this.v.menu || '').trim().toUpperCase(),
      curlib: (this.v.curlib || '').trim().toUpperCase(),
    });
  }
}

// ---------- Programmaberichten (SNDUSRMSG) ----------

export class InquiryPanel extends Panel {
  constructor(text, opts, done) {
    super();
    this.text = text;
    this.opts = opts; // { reply: bool, upper: bool, from }
    this.done = done; // (antwoord | null bij annuleren)
  }

  get fn() { return 'PGM-' + (this.opts.from || ''); }

  draw(scr) {
    const s = this.s;
    scr.center(0, 'Display Program Messages', 'w');
    const j = s.job;
    const started = j.started;
    let r = 2;
    for (const l of wrap(`Job ${s.sys.jobId(j)} started on ${s.sys.fmtDate(started)} at ${s.sys.fmtTime(started)} in subsystem QINTER in QSYS.`, 78)) scr.text(r++, 1, l);
    r++;
    for (const l of wrap(this.text, 76)) scr.text(r++, 1, l, 'w');
    r++;
    if (this.opts.reply) {
      scr.text(r++, 1, 'Type reply, press Enter.');
      scr.text(r, 3, 'Reply . . .');
      scr.field(r, 16, 60, 'reply', { value: this.v.reply || '', upper: !!this.opts.upper });
      scr.cursor = 'reply';
    } else scr.text(r, 1, 'Press Enter to continue.');
    fkeys(scr, ['F3=Exit   F12=Cancel']);
  }

  key(k) {
    if (k === 'ENTER') {
      this.s.pop({ silent: true });
      this.done(this.opts.reply ? (this.v.reply || '').trim() : '');
      return;
    }
    if (k === 'F3' || k === 'F12') {
      this.s.pop({ silent: true });
      this.done(null);
      return;
    }
    return this.std(k);
  }
}

// ---------- Bevestigen (verwijderen, PWRDWNSYS) ----------

export class ConfirmPanel extends Panel {
  // o: { title, intro: [regels], colHead, items: [regels], key: 'ENTER'|'F16', action() }
  constructor(o) {
    super();
    this.o = o;
  }

  draw(scr) {
    head(scr, this.s, this.o.title, { sys: false });
    let r = 2;
    for (const l of this.o.intro) scr.text(r++, 1, l, 'b');
    r++;
    if (this.o.colHead) scr.text(r++, 1, this.o.colHead, 'w');
    for (const l of this.o.items.slice(0, 18 - r)) scr.text(r++, 3, l);
    fkeys(scr, [this.o.key === 'F16' ? 'F12=Cancel   F16=Confirm' : 'F11=Display names and types   F12=Cancel']);
  }

  key(k) {
    if (k === (this.o.key || 'ENTER')) {
      this.s.pop();
      return this.o.action();
    }
    if (k === 'F12' || k === 'F3') return this.s.pop();
    if (k === 'ENTER') return;
    return this.std(k);
  }
}

// ---------- Systeem uit / IPL ----------

export class PowerOffPanel extends Panel {
  constructor() {
    super();
    this.isMenu = true;
    this.poweredOff = true;
  }

  draw() {}
  key() {}
}

const IPL_STEPS = ['C1001000', 'C1001010', 'C3002010', 'C6004031', 'C6004060', 'C6004065',
  'C9002810', 'C9002830', 'C9002910', 'C9002960', 'C900297C', 'C9002A40'];

export class IplPanel extends Panel {
  constructor() {
    super();
    this.step = 0;
    this.isMenu = true;
  }

  draw(scr) {
    scr.center(4, 'Initial Program Load (IPL) in progress', 'w');
    scr.center(6, `Reference code:  ${IPL_STEPS[Math.min(this.step, IPL_STEPS.length - 1)]}`, 'y');
    const bar = Math.round((this.step / IPL_STEPS.length) * 40);
    scr.center(8, '[' + '#'.repeat(bar) + ' '.repeat(40 - bar) + ']', 'g');
    scr.center(10, 'Licensed Internal Code and operating system are starting.', 'g');
  }

  tick() {
    this.step++;
    if (this.step > IPL_STEPS.length) this.s.iplDone();
  }

  key() {}
}

export const blankScreen = () => new Screen();
export { COLS };
