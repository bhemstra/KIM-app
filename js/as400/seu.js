// SEU, de Source Entry Utility: regels bewerken met regelcommando's in het
// volgnummer (I, D, C, M, A, B, R en de blokvormen DD, CC, MM).
import { CpfError, parseCommand } from './cl.js';
import { Panel, fkeys, dots } from './panels.js';

const W = 71; // zichtbare breedte van een regel
const DATA_COL = 9;
const FIRST = 3;
const ROWS = 18;
const NEW_SEQ = "'''''''";

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

// Zet een opdracht uit de prompter in de gebruikelijke CL-opmaak:
// label in kolom 2, opdracht in kolom 14, parameters vanaf kolom 25.
export function formatCL(label, cmd) {
  const c = parseCommand(cmd);
  const name = (c.lib ? c.lib + '/' : '') + c.name;
  const parts = c.params.map((p) => (p.kw ? `${p.kw}(${p.raw})` : p.raw));
  const lines = [];
  let line = (label ? ` ${label}:` : '').padEnd(13) + name.padEnd(10) + ' ';
  const indent = ' '.repeat(26);
  let first = true;
  for (const part of parts) {
    let piece = part;
    while (piece) {
      const room = 69 - line.length;
      if (piece.length + (first ? 0 : 1) <= room) {
        line += (first ? '' : ' ') + piece;
        piece = '';
      } else if (piece.length > 69 - indent.length) {
        // Te lang voor één regel: afbreken (een '+' haalt de spaties
        // aan het begin van de volgende regel weg)
        const cut = Math.max(1, room - 2);
        line += (first ? '' : ' ') + piece.slice(0, cut) + ' +';
        lines.push(line);
        line = indent;
        piece = piece.slice(cut);
        first = true;
        continue;
      } else {
        lines.push(line + ' +');
        line = indent;
        first = true;
        continue;
      }
      first = false;
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

export class SeuPanel extends Panel {
  // o: { lib, file, mbr, member, edit, srcType }
  constructor(o) {
    super();
    this.o = o;
    this.lines = o.member.lines.map((l) => ({ ...l }));
    this.top = 0;
    this.changed = false;
    this.find = '';
    this.cursorLine = null;
  }

  get fn() { return 'PGM-QUOCMD'; }

  draw(scr) {
    const o = this.o;
    scr.text(0, 1, `Columns . . . :    1  ${W}`, 'w');
    scr.text(0, 36, o.edit ? 'Edit' : 'Browse', 'w');
    const lf = `${o.lib}/${o.file}`;
    scr.text(0, 79 - lf.length, lf, 'w');
    scr.text(1, 1, 'SEU==>', 'w');
    scr.field(1, 8, 50, 'seucmd', { value: this.v.seucmd || '' });
    scr.text(1, 79 - o.mbr.length, o.mbr, 'w');
    scr.text(2, 1, 'FMT **  ...+... 1 ...+... 2 ...+... 3 ...+... 4 ...+... 5 ...+... 6 ...+... 7', 'w');

    // Rij 0 is "Beginning of data", daarna de regels, dan "End of data"
    const view = [{ mark: 'begin' }, ...this.lines.map((l, i) => ({ l, i })), { mark: 'end' }];
    if (this.top > view.length - 1) this.top = Math.max(0, view.length - ROWS);
    this.visible = [];
    let cursor = null;
    for (let r = 0; r < ROWS; r++) {
      const it = view[this.top + r];
      if (!it) break;
      const row = FIRST + r;
      if (it.mark === 'begin') {
        if (o.edit) scr.field(row, 0, 7, 'seq.-1', { value: '', underline: false });
        scr.text(row, 8, ' *************** Beginning of data *************************************', 'w');
      } else if (it.mark === 'end') {
        scr.text(row, 8, ' ****************** End of data ****************************************', 'w');
      } else {
        const { l, i } = it;
        const seq = l.fresh ? NEW_SEQ : l.seq;
        if (o.edit) {
          scr.field(row, 0, 7, 'seq.' + i, { value: seq, underline: false });
          scr.field(row, DATA_COL, W, 'dat.' + i, { value: l.data.slice(0, W), upper: false, underline: false });
          if (l.fresh && cursor === null) cursor = 'dat.' + i;
          if (this.cursorLine === i) cursor = 'dat.' + i;
        } else {
          scr.text(row, 0, seq, 'g');
          scr.text(row, DATA_COL, l.data.slice(0, W), 'g');
        }
        this.visible.push(i);
      }
    }
    this.cursorLine = null;
    fkeys(scr, o.edit ? ['F3=Exit   F4=Prompt   F5=Refresh   F9=Retrieve   F10=Cursor   F11=Toggle',
      'F16=Repeat find       F17=Repeat change          F24=More keys']
      : ['F3=Exit   F5=Refresh   F9=Retrieve   F10=Cursor   F12=Cancel', 'F16=Repeat find       F24=More keys']);
    scr.cursor = cursor || 'seucmd';
  }

  renumber() {
    let n = 0;
    for (const l of this.lines) if (!l.fresh) l.seq = String(++n).padStart(4, '0') + '.00';
  }

  // Neemt wat er op het scherm is ingetikt over in de regels
  apply() {
    if (!this.o.edit || !this.visible) return [];
    const cmds = [];
    for (const i of this.visible) {
      const l = this.lines[i];
      const d = this.v['dat.' + i];
      if (d !== undefined) {
        const tail = l.data.length > W ? l.data.slice(W) : '';
        const nd = (tail ? d.padEnd(W) + tail : d).trimEnd();
        if (nd !== l.data) { l.data = nd; this.changed = true; }
      }
      const sv = (this.v['seq.' + i] ?? '').trim();
      const orig = l.fresh ? NEW_SEQ : l.seq;
      if (sv && sv !== orig && sv !== orig.replace(/^0+/, '')) cmds.push({ i, raw: sv.toUpperCase() });
    }
    const top = (this.v['seq.-1'] ?? '').trim();
    if (top) cmds.push({ i: -1, raw: top.toUpperCase() });
    for (const k of Object.keys(this.v)) if (k.startsWith('seq.') || k.startsWith('dat.')) delete this.v[k];
    return cmds;
  }

  lineCommands(cmds) {
    const parsed = [];
    for (const c of cmds) {
      const m = /^(DD|CC|MM|RR|I|D|C|M|A|B|R)(\d*)$/.exec(c.raw);
      if (!m) throw new CpfError('EDT0102', `Line command ${c.raw} not valid.`);
      parsed.push({ i: c.i, op: m[1], n: m[2] ? Number(m[2]) : 1 });
    }
    if (!parsed.length) return;
    const L = this.lines;
    const del = new Set();
    const after = new Map(); // index → nieuwe regels erna
    const before = new Map();
    const addAfter = (i, ls) => after.set(i, [...(after.get(i) || []), ...ls]);
    const blank = () => ({ seq: '', data: '', fresh: true, justAdded: true });
    const copy = (l) => ({ seq: '', data: l.data });

    // Blokken in paren
    const pairs = (op) => {
      const ps = parsed.filter((p) => p.op === op).map((p) => p.i).sort((a, b) => a - b);
      if (ps.length % 2) throw new CpfError('EDT0110', `Block command ${op} not complete.`);
      const out = [];
      for (let k = 0; k < ps.length; k += 2) out.push([ps[k], ps[k + 1]]);
      return out;
    };

    for (const [a, b] of pairs('DD')) for (let i = a; i <= b; i++) del.add(i);
    for (const p of parsed.filter((x) => x.op === 'D')) for (let i = p.i; i < p.i + p.n && i < L.length; i++) del.add(i);
    for (const p of parsed.filter((x) => x.op === 'I')) addAfter(p.i, Array.from({ length: p.n }, blank));
    for (const p of parsed.filter((x) => x.op === 'R')) {
      if (p.i >= 0) addAfter(p.i, Array.from({ length: p.n }, () => copy(L[p.i])));
    }
    for (const [a, b] of pairs('RR')) addAfter(b, L.slice(a, b + 1).map(copy));

    // Kopiëren en verplaatsen naar A (na) of B (voor)
    const src = [];
    for (const p of parsed.filter((x) => x.op === 'C' || x.op === 'M')) {
      for (let i = p.i; i < p.i + p.n && i < L.length; i++) src.push({ i, move: p.op === 'M' });
    }
    for (const op of ['CC', 'MM']) {
      for (const [a, b] of pairs(op)) for (let i = a; i <= b; i++) src.push({ i, move: op === 'MM' });
    }
    const target = parsed.find((x) => x.op === 'A' || x.op === 'B');
    if (src.length && !target) throw new CpfError('EDT0111', 'Target (A or B) required for copy or move.');
    if (target && !src.length) throw new CpfError('EDT0112', 'Copy or move command required for target.');
    if (target) {
      const block = src.sort((a, b) => a.i - b.i).map((x) => copy(L[x.i]));
      for (const x of src) if (x.move) del.add(x.i);
      if (target.op === 'A') addAfter(target.i, block);
      else before.set(target.i, block);
    }

    const out = [...(after.get(-1) || [])];
    L.forEach((l, i) => {
      if (before.has(i)) out.push(...before.get(i));
      if (!del.has(i)) out.push(l);
      if (after.has(i)) out.push(...after.get(i));
    });
    this.lines = out;
    this.changed = true;
  }

  // Ingevoegde regels: getypt → blijft, en er komt een nieuwe lege regel na;
  // leeg gelaten → verdwijnt.
  settleInserts() {
    const out = [];
    let cursorAt = null;
    this.lines.forEach((l, idx) => {
      if (!l.fresh || l.justAdded) { delete l.justAdded; out.push(l); return; }
      if (!l.data.trim()) return;
      out.push({ seq: '', data: l.data });
      const next = this.lines[idx + 1];
      if (!next || !next.fresh) {
        out.push({ seq: '', data: '', fresh: true });
        cursorAt = out.length - 1;
      }
    });
    this.lines = out;
    if (cursorAt !== null) this.keepVisible(cursorAt);
  }

  keepVisible(i) {
    const row = i + 1; // +1 voor "Beginning of data"
    if (row < this.top || row >= this.top + ROWS) this.top = Math.max(0, row - ROWS + 3);
  }

  key(k) {
    const s = this.s;
    if (k === 'F5') {
      for (const key of Object.keys(this.v)) if (key.startsWith('seq.') || key.startsWith('dat.')) delete this.v[key];
      return;
    }
    if (k === 'F12' && this.o.edit) return s.msg('Use F3 to exit; changes are kept until you leave SEU.');
    const cmds = this.apply();
    try {
      this.lineCommands(cmds);
    } catch (e) {
      s.msg(e.text, 'err', e.id);
    }
    this.settleInserts();
    this.renumber();

    switch (k) {
      case 'ENTER': return this.seuCommand();
      case 'ROLLUP': this.top = Math.min(this.top + ROWS - 1, this.lines.length + 1); return;
      case 'ROLLDOWN': this.top = Math.max(0, this.top - (ROWS - 1)); return;
      case 'F16': return this.doFind(this.find);
      case 'F3': return this.exit();
      case 'F12': return s.pop();
      case 'F4': return this.promptLine();
      case 'F10': case 'F11': case 'F17': case 'F24': return s.msg('Function not available in this simulation.');
    }
    return this.std(k);
  }

  seuCommand() {
    const s = this.s;
    const raw = (this.v.seucmd || '').trim();
    if (!raw) return;
    this.v.seucmd = '';
    const [w, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').replace(/^'(.*)'$/, '$1');
    const W1 = w.toUpperCase();
    let m;
    if (W1 === 'T' || W1 === 'TOP') this.top = 0;
    else if (W1 === 'B' || W1 === 'BOTTOM') this.top = Math.max(0, this.lines.length + 2 - ROWS);
    else if (W1 === 'F' || W1 === 'FIND') { this.find = arg; this.doFind(arg); }
    else if (W1 === 'SAVE') { this.save(); s.msg(`Member ${this.o.mbr} saved.`); }
    else if (W1 === 'CAN' || W1 === 'CANCEL') s.pop();
    else if ((m = /^([+-])(\d+)$/.exec(W1))) this.top = Math.max(0, this.top + (m[1] === '+' ? 1 : -1) * Number(m[2]));
    else if (/^\d+$/.test(W1)) this.top = Math.max(0, Number(W1));
    else s.msg(`SEU command ${W1} not valid.`, 'err');
  }

  doFind(str) {
    if (!str) return this.s.msg('No previous find string.');
    const needle = str.toUpperCase();
    const n = this.lines.length;
    const start = Math.max(0, this.top); // top 0 = beginmarkering, dus regel 0 is "na" de top
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (this.lines[i].data.toUpperCase().includes(needle)) {
        this.top = i; // regel i staat dan op de tweede rij
        this.cursorLine = i;
        return this.s.msg(`String ${str} found.`);
      }
    }
    this.s.msg(`String ${str} not found.`);
  }

  promptLine() {
    const s = this.s;
    if (!/^(CLP|CLLE)$/.test(this.o.member.type)) return s.msg(`Prompting not available for type ${this.o.member.type}.`);
    const name = this.cursorName;
    if (/^seq\./.test(name || '')) return s.msg('Position the cursor on the statement, not on the sequence number.');
    const m = /^dat\.(\d+)$/.exec(name || '');
    if (!m) return s.msg('Position the cursor on a statement to prompt.');
    const i = Number(m[1]);
    // Doorlopende regels samennemen
    let j = i;
    let text = this.lines[i].data;
    while (/[+-]\s*$/.test(this.lines[j]?.data || '') && j + 1 < this.lines.length) {
      text = text.replace(/\s*\+\s*$/, ' ').replace(/-\s*$/, '');
      j++;
      text += this.lines[j].data.trim();
    }
    let c;
    try { c = parseCommand(text); } catch (e) { return s.msg(e.text, 'err', e.id); }
    if (!c.name) return s.msg('Type a command name, then press F4.');
    const label = c.label;
    const body = text.replace(/^\s*[A-Za-z@#$][A-Za-z0-9@#$_]*:\s*/, '');
    const ok = s.prompt(body, (cmd) => {
      const formatted = formatCL(label, cmd).map((d) => ({ seq: '', data: d }));
      this.lines.splice(i, j - i + 1, ...formatted);
      this.changed = true;
      this.renumber();
    });
    if (!ok) return;
  }

  save() {
    this.lines = this.lines.filter((l) => !l.fresh);
    this.renumber();
    this.o.member.lines = this.lines.map((l) => ({ seq: l.seq, data: l.data }));
    this.o.member.changed = this.s.sys.now().toISOString();
    this.changed = false;
  }

  exit() {
    const s = this.s;
    if (!this.o.edit) return s.pop();
    s.push(new SeuExitPanel(this));
  }
}

class SeuExitPanel extends Panel {
  constructor(seu) {
    super();
    this.seu = seu;
    this.v = { chg: seu.changed || seu.o.isNew ? 'Y' : 'N', ret: 'N', text: seu.o.member.text };
  }

  draw(scr) {
    scr.center(0, 'Exit', 'w');
    scr.text(2, 1, 'Type choices, press Enter.', 'b');
    const o = this.seu.o;
    const L = (r, label) => scr.text(r, 3, dots(label, 36));
    L(4, 'Change/create member');
    scr.field(4, 41, 1, 'chg', { value: this.v.chg });
    scr.text(4, 53, 'Y=Yes, N=No', 'b');
    L(5, '  Member');
    scr.text(5, 41, pad(o.mbr, 10));
    L(6, '  File');
    scr.text(6, 41, pad(o.file, 10));
    L(7, '    Library');
    scr.text(7, 41, pad(o.lib, 10));
    L(8, '  Text');
    scr.field(8, 41, 38, 'text', { value: this.v.text, upper: false });
    L(10, 'Return to editing');
    scr.field(10, 41, 1, 'ret', { value: this.v.ret });
    scr.text(10, 53, 'Y=Yes, N=No', 'b');
    fkeys(scr, ['F3=Exit   F5=Refresh   F12=Cancel']);
    scr.cursor = 'chg';
  }

  key(k) {
    const s = this.s;
    if (k === 'F12') return s.pop();
    if (k === 'F5') { this.v.chg = 'Y'; this.v.ret = 'N'; return; }
    if (k !== 'ENTER' && k !== 'F3') return this.std(k);
    const chg = (this.v.chg || 'N').toUpperCase();
    const ret = (this.v.ret || 'N').toUpperCase();
    if (!/^[YN]$/.test(chg) || !/^[YN]$/.test(ret)) return s.msg('Value not valid. Type Y or N.', 'err');
    const o = this.seu.o;
    o.member.text = this.v.text ?? o.member.text;
    if (chg === 'Y') {
      this.seu.save();
      if (o.isNew) { o.srcFile.members[o.mbr] = o.member; o.isNew = false; }
    }
    s.pop();
    if (ret === 'Y') return;
    s.pop();
    if (chg === 'Y') s.msg(`Member ${o.mbr} in file ${o.lib}/${o.file} changed with ${this.seu.lines.length} records.`);
    else s.msg(`Member ${o.mbr} in file ${o.lib}/${o.file} not changed.`);
  }
}
