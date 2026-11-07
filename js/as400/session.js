// Een interactieve sessie op een 5250-scherm: de stapel schermen, de
// toetsen (Enter, F1–F24, Roll), opdrachten uitvoeren en programma's laten
// lopen. Hier komt alles samen; as400-main.js tekent alleen.
import { CpfError, parseCommand } from './cl.js';
import { System } from './system.js';
import { Screen } from './screen.js';
import { SignOnPanel, MenuPanel, MENUS, CmdEntryPanel, PromptPanel, InquiryPanel, PowerOffPanel, IplPanel, TextView } from './panels.js';
import { COMMANDS, execCommand, bindArgs, sqlRun, SIGNOFF } from './commands.js';
import { WrkCmdPanel } from './work.js';

export function createSystem(state, opts = {}) {
  return new System(state, { ...opts, commands: COMMANDS });
}

export class Session {
  constructor(sys, opts = {}) {
    this.sys = sys;
    this.device = opts.device || 'QPADEV0001';
    this.stack = [];
    this.message = null;
    this.job = null;
    this.retrieveIdx = -1;
    this.lastScreen = null;
    this.toSignOn();
  }

  // ---------- De stapel schermen ----------

  top() { return this.stack.at(-1); }

  push(p) {
    p.s = this;
    this.stack.push(p);
    return p;
  }

  pop(o = {}) {
    const p = this.stack.pop();
    if (!this.stack.length) {
      if (this.job) this.signOff();
      else this.toSignOn();
      return p;
    }
    if (p?.onReturn && !o.silent) {
      const r = p.onReturn;
      p.onReturn = null;
      r();
    }
    return p;
  }

  // F3: terug naar het dichtstbijzijnde menu (of verder een wachtend programma)
  exit() {
    if (this.top()?.isMenu) return this.pop();
    while (this.stack.length && !this.top().isMenu) {
      const p = this.stack.pop();
      if (p.onReturn) {
        const r = p.onReturn;
        p.onReturn = null;
        if (!this.stack.length) return this.signOff();
        return r();
      }
    }
    if (!this.stack.length) this.signOff();
  }

  toSignOn() {
    this.stack = [];
    this.push(new SignOnPanel());
  }

  // ---------- Scherm en toetsen ----------

  screen() {
    const scr = new Screen();
    const p = this.top();
    if (p) p.draw(scr);
    if (this.message) scr.text(23, 1, this.message.text.slice(0, 78), 'w');
    this.lastScreen = scr;
    return scr;
  }

  // key: 'ENTER', 'F1'..'F24', 'ROLLUP', 'ROLLDOWN', 'HELP'
  // values: { veldnaam: waarde }, cursor: naam van het veld met de cursor
  aid(key, values = {}, cursor = null) {
    const p = this.top();
    if (!p) return;
    const scr = this.screen();
    this.message = null;
    for (const [name, val] of Object.entries(values)) {
      const f = scr.getField(name);
      if (!f) continue;
      p.v[name] = f.upper ? String(val).toUpperCase() : String(val);
    }
    p.cursorName = cursor;
    try {
      p.key(key);
    } catch (e) {
      if (e === SIGNOFF) { this.signOff(); }
      else if (e instanceof CpfError) this.fail(e);
      else {
        console.error(e);
        this.message = { text: `Internal error: ${e.message}`, type: 'err' };
      }
    }
    this.sys.save();
  }

  // Tekst op regel 24
  msg(text, type = 'info', id = null) {
    this.message = { text, type, id };
  }

  fail(e) {
    this.job?.log.push({ kind: 'msg', text: e.text, id: e.id });
    this.message = { text: e.text, type: 'err', id: e.id };
  }

  help() {
    const p = this.top();
    const lines = [
      'Help',
      '',
      'Keys on this display:',
      '  Enter      Process the information on the display.',
      '  F1         Help (this information).',
      '  F3         Exit: return to the menu.',
      '  F4         Prompt: show the parameters of the command on the command line.',
      '  F9         Retrieve: show the previous command again.',
      '  F12        Cancel: return to the previous display.',
      '  Page Down  Roll up: show the next page of a list.',
      '  Page Up    Roll down: show the previous page of a list.',
      '',
      'Type a command on the command line and press Enter, or type a command',
      'name and press F4 to be prompted for its parameters. GO MAIN shows the',
      'main menu. WRKCMD lists all commands of this simulated system.',
    ];
    if (p?.helpText) lines.push('', ...p.helpText);
    this.push(new TextView('Help', lines, { fkeys: ['F3=Exit help   F12=Cancel'] }));
  }

  // ---------- Opdrachten ----------

  retrieve() {
    const h = this.job?.history || [];
    if (!h.length) return '';
    this.retrieveIdx = this.retrieveIdx <= 0 ? h.length - 1 : this.retrieveIdx - 1;
    return h[this.retrieveIdx];
  }

  // Voert een opdracht uit zoals vanaf de opdrachtregel. Geeft false bij een fout.
  run(text, opts = {}) {
    text = String(text).trim();
    if (!text) return true;
    if (text.startsWith('?')) return this.prompt(text.slice(1).trim());
    if (!this.job) return false;
    if (!opts.quiet) this.job.history.push(text);
    this.retrieveIdx = -1;
    this.job.log.push({ kind: 'cmd', text });
    let res;
    try {
      res = execCommand(this, text, { interactive: true });
    } catch (e) {
      if (e === SIGNOFF) { this.signOff(); return true; }
      if (!(e instanceof CpfError)) throw e;
      this.fail(e);
      return false;
    }
    return this.handle(res);
  }

  handle(res) {
    if (!res) return true;
    for (const m of res.msgs || []) this.job.log.push({ kind: 'msg', text: m.text, id: m.id });
    const last = res.msgs?.at(-1);
    if (last) this.message = { text: last.text, type: 'info', id: last.id };
    if (res.signoff) { this.signOff(res.log); return true; }
    if (res.panel) this.push(res.panel);
    if (res.program) this.pump(res.program, undefined, res.programName);
    return true;
  }

  // Prompter (F4 of ?CMD). onDone: alleen de ingevulde opdracht teruggeven.
  prompt(text, onDone = null) {
    if (!text) {
      this.push(new WrkCmdPanel(COMMANDS));
      return true;
    }
    let c;
    try {
      c = parseCommand(text);
    } catch (e) {
      this.fail(e);
      return false;
    }
    const def = COMMANDS[c.name];
    if (!def) {
      this.fail(new CpfError('CPD0030', `Command ${c.name} in library *LIBL not found.`));
      return false;
    }
    let given;
    try {
      given = bindArgs(def, c);
    } catch (e) {
      this.fail(e);
      return false;
    }
    if (!def.params.length && !onDone) return this.run(c.name);
    this.push(new PromptPanel(def, given, onDone));
    return true;
  }

  // ---------- Programma's ----------

  pump(gen, input, name = '') {
    let step;
    const next = (v) => {
      try {
        step = gen.next(v);
        return true;
      } catch (e) {
        if (e === SIGNOFF) { this.signOff(); return false; }
        if (!(e instanceof CpfError)) throw e;
        this.fail(e);
        return false;
      }
    };
    if (!next(input)) return;
    for (;;) {
      if (step.done) {
        const msgs = step.value || [];
        for (const m of msgs) this.job?.log.push({ kind: 'msg', text: m.text, id: m.id });
        if (msgs.length) this.message = { text: msgs.at(-1).text, type: 'info' };
        return;
      }
      const y = step.value;
      if (y.panel) {
        y.panel.onReturn = () => this.pump(gen, undefined, name);
        this.push(y.panel);
        return;
      }
      if (y.inquiry !== undefined || y.info !== undefined) {
        const reply = y.inquiry !== undefined;
        this.push(new InquiryPanel(reply ? y.inquiry : y.info, { reply, upper: y.upper, from: name }, (answer) => {
          if (answer === null) {
            try { gen.return(); } catch { /* al klaar */ }
            this.msg(`Program ${name} ended at user request.`);
            return;
          }
          this.pump(gen, answer, name);
        }));
        return;
      }
      if (!next()) return;
    }
  }

  sql(text) {
    return sqlRun(this, text);
  }

  // Wat de job aan het doen is (voor WRKACTJOB)
  jobFunction() {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i].fn;
      if (f) return f;
    }
    return '';
  }

  // ---------- Aan- en afmelden ----------

  signOn(user, pwd, o = {}) {
    const sys = this.sys;
    const u = sys.state.users[user];
    if (!u) return this.msg(`User ${user} does not exist.`, 'err', 'CPF1120');
    if (u.pwd !== pwd) return this.msg('Password not correct for user profile.', 'err', 'CPF1107');
    if (o.curlib && !sys.state.libs[o.curlib]) return this.msg(`Current library ${o.curlib} not found.`, 'err', 'CPF1110');
    if (o.menu && !MENUS[o.menu] && o.menu !== '*SIGNOFF') return this.msg(`Menu ${o.menu} in library *LIBL not found.`, 'err', 'CPF1115');

    this.job = sys.newJob(user, this.device);
    if (o.curlib) this.job.curlib = o.curlib;
    const j = this.job;
    j.log.push({ kind: 'msg', text: `Job ${sys.jobId(j)} started on ${sys.fmtDate(j.started)} at ${sys.fmtTime(j.started)} in subsystem QINTER in QSYS. Job entered system on ${sys.fmtDate(j.started)} at ${sys.fmtTime(j.started)}.`, id: 'CPF1124' });
    this.stack = [];
    this.message = null;
    const menu = o.menu || u.inlmnu || 'MAIN';
    if (menu !== '*SIGNOFF') this.push(new MenuPanel(MENUS[menu] ? menu : 'MAIN'));
    const pgm = o.pgm || (u.inlpgm !== '*NONE' ? u.inlpgm : '');
    if (pgm === 'QCMD') this.push(new CmdEntryPanel());
    else if (pgm) {
      this.run(`CALL ${pgm}`, { quiet: true });
      if (!this.stack.length) this.signOff();
    }
    if (!this.stack.length) this.signOff();
  }

  signOff(log = '*NOLIST') {
    if (this.job) {
      const j = this.job;
      if (log === '*LIST') {
        this.sys.addSpool(j, 'QPJOBLOG', j.log.map((e) => (e.kind === 'cmd' ? '>  ' : '    ') + e.text), j.name);
      }
      this.sys.endJob(j);
      this.job = null;
    }
    this.sqlPanel = null;
    this.message = null;
    this.toSignOn();
  }

  // ---------- Uit- en aanzetten ----------

  powerDown(restart) {
    for (const j of [...this.sys.interactive]) this.sys.endJob(j);
    this.job = null;
    this.message = null;
    this.stack = [];
    this.sys.save();
    if (restart) this.ipl();
    else this.push(new PowerOffPanel());
  }

  get poweredOff() { return !!this.top()?.poweredOff; }

  ipl() {
    this.stack = [];
    this.message = null;
    this.push(new IplPanel());
  }

  iplDone() {
    this.sys.ipled = this.sys.now();
    this.sys.ended.clear();
    this.toSignOn();
  }

  tick() {
    this.top()?.tick?.();
  }

  // Voor de statusregel onder het scherm
  oia() {
    return {
      mw: !!this.job && this.sys.hasNewMsg(this.job.user),
      user: this.job?.user || '',
      off: this.poweredOff,
    };
  }
}
