// Gebruikersinterface van de PDP-11-emulator (pdp11.html)
import { PDP11, o6, CR } from './pdp11.js';
import { assemble, formatListing } from './pdp11-asm.js';
import { disassemble, REG_NAMES } from './pdp11-disasm.js';
import { parseAbsoluteLoader, toAbsoluteLoader } from './pdp11-files.js';
import { textToCard, ROWS, charToHollerith } from './pdp11-cards.js';
import { SAMPLES_PDP11, SAMPLE_CARDS } from './pdp11-samples.js';

const $ = (id) => document.getElementById(id);
const m = new PDP11();
window.machine = m; // handig voor experimenten in de console

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('pdp11.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('pdp11.' + key, JSON.stringify(value)); } catch { /* niet beschikbaar */ }
  },
};

const parseOct = (s) => {
  const t = String(s).trim();
  return /^[0-7]{1,6}$/.test(t) ? parseInt(t, 8) & 0xFFFF : null;
};

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ---------- Frontpaneel ----------

const GROUPS = [[15], [14, 13, 12], [11, 10, 9], [8, 7, 6], [5, 4, 3], [2, 1, 0]];
const lampEls = { addr: [], data: [] };
const switchEls = [];

function buildBits(container, make) {
  GROUPS.forEach((g, gi) => {
    const grp = document.createElement('div');
    grp.className = `grp g${gi % 2}`;
    for (const bit of g) {
      const cell = document.createElement('div');
      cell.className = 'bit';
      cell.appendChild(make(bit));
      const n = document.createElement('span');
      n.className = 'bitno';
      n.textContent = bit;
      cell.appendChild(n);
      grp.appendChild(cell);
    }
    container.appendChild(grp);
  });
}

function buildPanel() {
  for (const kind of ['addr', 'data']) {
    buildBits($(`${kind}-lamps`), (bit) => {
      const l = document.createElement('span');
      l.className = 'lamp';
      lampEls[kind][bit] = l;
      return l;
    });
  }
  buildBits($('switches'), (bit) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw';
    b.setAttribute('aria-label', `Schakelaar ${bit}`);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => setSR(m.sr ^ (1 << bit)));
    switchEls[bit] = b;
    return b;
  });

  $('sr-oct').addEventListener('input', (e) => {
    const v = parseOct(e.target.value);
    if (v !== null) setSR(v, true);
  });
  $('sr-oct').addEventListener('blur', () => { $('sr-oct').value = o6(m.sr); });

  const action = (id, fn) => $(id).addEventListener('click', () => { fn(); updatePanelMsg(); });
  action('ctl-load', () => m.loadAddress());
  action('ctl-exam', () => m.panelExamine());
  action('ctl-dep', () => m.panelDeposit());
  action('ctl-start', () => m.panelStart());
  action('ctl-cont', () => m.panelContinue());
  $('ctl-halt').addEventListener('click', () => {
    const on = !m.haltSwitch;
    m.setHaltSwitch(on);
    $('ctl-halt').setAttribute('aria-pressed', String(on));
    updatePanelMsg();
  });
}

function setSR(v, fromInput) {
  m.sr = v & 0xFFFF;
  for (let i = 0; i < 16; i++) {
    const on = !!(m.sr & (1 << i));
    switchEls[i].classList.toggle('up', on);
    switchEls[i].setAttribute('aria-pressed', String(on));
  }
  if (!fromInput) $('sr-oct').value = o6(m.sr);
}

const RUNNING_MSG = 'De processor loopt: LOAD ADRS, EXAM en DEP werken alleen als hij stilstaat (zet ENABLE/HALT op HALT).';

function updatePanelMsg() {
  let text = '';
  if (!m.cpu.halted) text = RUNNING_MSG;
  else if (m.panel.error) text = m.panel.error;
  $('panel-msg').textContent = text;
}

const shownLamps = { addr: new Array(16).fill(-1), data: new Array(16).fill(-1) };

function renderPanel() {
  const l = m.lamps();
  for (const kind of ['addr', 'data']) {
    for (let i = 0; i < 16; i++) {
      // Gloeilampjes: een beetje gammacorrectie zodat half-aan zichtbaar is
      const v = Math.round(Math.pow(l[kind][i], 0.6) * 20) / 20;
      if (shownLamps[kind][i] !== v) {
        lampEls[kind][i].style.setProperty('--b', v);
        shownLamps[kind][i] = v;
      }
    }
  }
  const halted = m.cpu.halted;
  const addr = halted ? m.panel.addr : m.cpu.r[7];
  const data = halted ? m.panel.data : m.dr;
  $('addr-oct').value = o6(addr);
  $('data-oct').value = o6(data);
  $('lamp-run').classList.toggle('on', !halted);
  $('lamp-wait').classList.toggle('on', !halted && m.cpu.waiting);
  $('lamp-halt').classList.toggle('on', halted);
  $('tty-mode').textContent = halted ? 'console-ODT (processor staat stil)' : 'programma loopt';
  if (halted && $('panel-msg').textContent === RUNNING_MSG) $('panel-msg').textContent = '';
}

// ---------- Terminal ----------

let ttyText = '';
let ttyDirty = true;

function ttyWrite(s) {
  for (const ch of s) {
    if (ch === '\r' || ch === '\x07' || ch === '\0' || ch === '\x7F') continue;
    if (ch === '\b') { ttyText = ttyText.slice(0, -1); continue; }
    ttyText += ch;
  }
  if (ttyText.length > 30000) ttyText = ttyText.slice(-24000);
  ttyDirty = true;
}

function renderTerminal() {
  const t = $('terminal');
  const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 4;
  t.textContent = ttyText;
  const cur = document.createElement('span');
  cur.className = 'cursor';
  cur.textContent = ' ';
  t.appendChild(cur);
  if (atBottom) t.scrollTop = t.scrollHeight;
  ttyDirty = false;
}

function type(ch) { m.typeKey(ch); }

function initTerminal() {
  m.onTTYOutput = ttyWrite;
  const t = $('terminal');
  t.addEventListener('keydown', (e) => {
    if (e.metaKey || e.altKey) return;
    let ch = null;
    if (e.ctrlKey) {
      if (e.key.length === 1 && /[a-z@\[\\\]^_]/i.test(e.key)) ch = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 0x1F);
    } else if (e.key === 'Enter') ch = e.shiftKey ? '\n' : '\r';
    else if (e.key === 'Backspace') ch = '\x7F';
    else if (e.key === 'Escape') ch = '\x1B';
    else if (e.key === 'Tab') ch = '\t';
    else if (e.key.length === 1) ch = e.key;
    if (ch === null) return;
    e.preventDefault();
    type(ch);
  });
  t.addEventListener('paste', (e) => {
    e.preventDefault();
    for (const ch of e.clipboardData.getData('text')) type(ch === '\n' ? '\r' : ch);
  });
  const inp = $('tty-input');
  inp.addEventListener('input', () => {
    for (const ch of inp.value) type(ch);
    inp.value = '';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); type(e.shiftKey ? '\n' : '\r'); }
    else if (e.key === 'Backspace' && inp.value === '') { e.preventDefault(); type('\x7F'); }
  });
  $('btn-tty-lf').addEventListener('click', () => type('\n'));
  $('btn-tty-clear').addEventListener('click', () => { ttyText = ''; ttyDirty = true; });
}

// ---------- Tabs ----------

let activeTab = 'asm';
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-body').forEach((x) => x.classList.toggle('active', x.dataset.tab === activeTab));
    if (activeTab === 'dbg') renderDebugger();
    if (activeTab === 'cards') renderCards();
  });
});

// ---------- Assembler ----------

function loadSegments(segments) {
  for (const s of segments) s.bytes.forEach((b, i) => m.poke(s.start + i, b));
}

function assembleAndLoad() {
  const msg = $('asm-msg');
  try {
    const r = assemble($('source').value);
    loadSegments(r.segments);
    $('listing').textContent = formatListing(r.listing);
    const total = r.segments.reduce((n, s) => n + s.bytes.length, 0);
    const ranges = r.segments.map((s) => `${o6(s.start)}–${o6(s.start + s.bytes.length - 1)}`).join(', ');
    if (r.start !== null && m.cpu.halted) { m.panel.addr = r.start; m.panel.last = null; }
    setMsg(msg, `${total} bytes geladen (${ranges}).${r.start !== null ? ` Start: ${o6(r.start)}G` : ''}`, 'ok');
    return r;
  } catch (err) {
    setMsg(msg, err.message, 'err');
    if (err.line) selectLine($('source'), err.line);
    return null;
  }
}

function selectLine(ta, line) {
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
}

function startAt(addr) {
  if (m.cpu.halted) ttyWrite('\n');
  m.go(addr);
}

function initAssembler() {
  const sel = $('sample');
  SAMPLES_PDP11.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  const showDesc = () => { $('sample-desc').textContent = SAMPLES_PDP11[sel.value].description; };
  sel.addEventListener('change', showDesc);
  sel.value = store.get('sample', 0);
  if (!SAMPLES_PDP11[sel.value]) sel.value = 0;
  showDesc();
  $('source').value = store.get('source', SAMPLES_PDP11[sel.value].source);

  $('btn-load-sample').addEventListener('click', () => {
    const s = SAMPLES_PDP11[sel.value];
    $('source').value = s.source;
    store.set('source', s.source);
    store.set('sample', Number(sel.value));
    setMsg($('asm-msg'), '');
    if (s.cards && !m.cr.hopper.length) {
      if (!$('card-text').value.trim()) $('card-text').value = SAMPLE_CARDS;
      loadCardsFromText();
      setMsg($('asm-msg'), 'Er liggen voorbeeldkaarten in de kaartlezer (tab Ponskaarten).', 'ok');
    }
  });
  let saveTimer;
  $('source').addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('source', $('source').value), 400);
  });
  $('source').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
    }
  });
  $('btn-assemble').addEventListener('click', assembleAndLoad);
  $('btn-run').addEventListener('click', () => {
    const r = assembleAndLoad();
    if (!r) return;
    if (r.start === null) { setMsg($('asm-msg'), 'Geen startadres: zet het achter .END, bijvoorbeeld .END START', 'err'); return; }
    startAt(r.start);
  });
}

// ---------- Debugger ----------

let breakpoints = new Set();

function pswString(p) {
  const f = (bit, ch) => (p & bit ? ch : '.');
  return `pri ${(p >> 5) & 7}  ${f(0x10, 'T')}${f(8, 'N')}${f(4, 'Z')}${f(2, 'V')}${f(1, 'C')}`;
}

function renderDebugger() {
  const c = m.cpu;
  const rows = REG_NAMES.map((n, i) => [n, o6(c.r[i])]);
  rows.push(['PSW', `${o6(c.psw)}  ${pswString(c.psw)}`]);
  rows.push(['Instructies', c.instructions.toLocaleString('nl-NL')]);
  $('regs').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const peekWord = (a) => m.peekWord(a);
  let addr = c.r[7];
  const lines = [];
  for (let i = 0; i < 14; i++) {
    const d = disassemble(peekWord, addr);
    const words = d.words.map(o6).join(' ').padEnd(20);
    const mark = addr === c.r[7] ? '<span class="cur">&gt;</span>' : ' ';
    const bp = breakpoints.has(addr) ? '*' : ' ';
    lines.push(`${mark}${bp}${o6(addr)}  ${words} ${d.text}`);
    addr = (addr + d.size) & 0xFFFF;
  }
  $('disasm').innerHTML = lines.join('\n');

  const start = (parseOct($('mem-addr').value) ?? 0) & 0xFFF0;
  const out = [];
  for (let r = 0; r < 16; r++) {
    const a = (start + r * 16) & 0xFFFF;
    let words = '';
    let asc = '';
    for (let i = 0; i < 8; i++) {
      const w = m.peekWord((a + 2 * i) & 0xFFFF);
      words += (w === null ? '------' : o6(w)) + ' ';
      for (const b of w === null ? [0, 0] : [w & 0xFF, w >> 8]) asc += b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.';
    }
    out.push(`${o6(a)}  ${words} ${asc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`);
  }
  $('memdump').innerHTML = out.join('\n');

  $('btn-pause').textContent = c.halted ? 'Doorgaan' : 'Halt';
  let state;
  if (c.halted) state = `Processor staat stil (${c.haltReason || 'na aanzetten'})`;
  else if (c.waiting) state = 'WAIT: wacht op een interrupt';
  else state = 'Loopt';
  if (c.lastTrap && !c.halted) state += ` · laatste trap: ${c.lastTrap}`;
  setMsg($('dbg-state'), state);
}

function initDebugger() {
  $('btn-pause').addEventListener('click', () => {
    if (m.cpu.halted) { ttyWrite('\n'); m.proceed(); } else m.haltNow('Halt in de debugger');
    renderDebugger();
  });
  $('btn-step').addEventListener('click', () => {
    m.stepInstruction();
    renderDebugger();
  });
  $('bp').addEventListener('input', (e) => {
    const v = parseOct(e.target.value);
    breakpoints = v !== null && e.target.value.trim().length >= 1 ? new Set([v & 0xFFFE]) : new Set();
    renderDebugger();
  });
  $('mem-addr').addEventListener('input', renderDebugger);
}

// ---------- Ponskaarten ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const CARD = { x0: 22, dx: 8.7, y0: 52, dy: 22.5, w: 4.2, h: 12 };
let holeEls = []; // [kolom][rij]
let printEls = [];
let colMarker;
let shownCardKey = '';

function svgEl(name, attrs, parent) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function buildCard() {
  const svg = $('card-svg');
  svgEl('path', { d: 'M18 0 H740 V330 H0 V18 Z', class: 'card-bg' }, svg);
  const digits = svgEl('g', { class: 'card-digits' }, svg);
  for (let c = 0; c < 80; c++) {
    const x = CARD.x0 + c * CARD.dx;
    holeEls[c] = [];
    for (let r = 0; r < 12; r++) {
      const y = CARD.y0 + r * CARD.dy;
      const row = ROWS[r];
      if (row >= 0 && row <= 9) {
        const t = svgEl('text', { x: x + CARD.w / 2, y: y + 9.5 }, digits);
        t.textContent = row;
      }
      holeEls[c][r] = svgEl('rect', { x, y, width: CARD.w, height: CARD.h, class: 'hole' }, svg);
    }
    printEls[c] = svgEl('text', { x: x + CARD.w / 2, y: 20, class: 'card-print' }, svg);
  }
  const nums = svgEl('g', { class: 'card-colnums' }, svg);
  for (const c of [1, 10, 20, 30, 40, 50, 60, 70, 80]) {
    const t = svgEl('text', { x: CARD.x0 + (c - 1) * CARD.dx + CARD.w / 2, y: 326 }, nums);
    t.textContent = c;
  }
  colMarker = svgEl('rect', { x: 0, y: 28, width: CARD.dx, height: 290, class: 'col-marker' }, svg);
}

function drawCard(card, column) {
  const key = card ? card.text + '|' + column : '|';
  if (key === shownCardKey) return;
  shownCardKey = key;
  for (let c = 0; c < 80; c++) {
    const v = card ? card.cols[c] : 0;
    for (let r = 0; r < 12; r++) holeEls[c][r].classList.toggle('punched', !!(v & (1 << (11 - r))));
    printEls[c].textContent = card ? (card.text[c] || '') : '';
  }
  if (column > 0 && column <= 80) {
    colMarker.setAttribute('x', CARD.x0 + (column - 1) * CARD.dx - (CARD.dx - CARD.w) / 2);
    colMarker.style.display = '';
  } else colMarker.style.display = 'none';
}

function cursorCard() {
  const ta = $('card-text');
  const before = ta.value.slice(0, ta.selectionStart);
  const lineNo = before.split('\n').length;
  const line = ta.value.split('\n')[lineNo - 1] || '';
  return { lineNo, line };
}

function renderCards() {
  const cr = m.cr;
  let caption;
  if (cr.card) {
    drawCard(cr.card, cr.col);
    caption = `In de lezer: kolom ${cr.col} van 80`;
  } else {
    const { lineNo, line } = cursorCard();
    drawCard(textToCard(line), 0);
    caption = `Voorbeeld van regel ${lineNo} (de kaart onder de cursor)`;
  }
  $('card-caption').textContent = caption;
  const err = cr.csr & CR.ERR ? ' · lezer meldt een fout' : '';
  setMsg($('card-msg'), `In de kaartenbak: ${cr.hopper.length} · gelezen: ${cr.stacker.length}${err}`, cr.csr & CR.ERR ? 'err' : '');
}

function loadCardsFromText() {
  const lines = $('card-text').value.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) { setMsg($('card-msg'), 'Er staan geen kaarten in het tekstvak.', 'err'); return; }
  const unknown = new Set();
  for (const l of lines) for (const ch of l.slice(0, 80)) if (charToHollerith(ch) === undefined) unknown.add(ch);
  m.loadCards(lines.map(textToCard));
  store.set('cards', $('card-text').value);
  if (unknown.size) setMsg($('card-msg'), `Niet te ponsen (blijft blanco): ${[...unknown].join(' ')}`, 'err');
}

function initCards() {
  buildCard();
  $('card-text').value = store.get('cards', SAMPLE_CARDS);
  $('btn-cards-load').addEventListener('click', () => { loadCardsFromText(); renderCards(); });
  $('btn-cards-clear').addEventListener('click', () => { m.clearCards(); renderCards(); });
  for (const ev of ['input', 'click', 'keyup', 'select']) $('card-text').addEventListener(ev, () => { if (!m.cr.card) renderCards(); });
  $('card-text').addEventListener('input', () => store.set('cards', $('card-text').value));
  $('card-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('card-text').value = (await file.text()).replace(/\t/g, '        ');
    e.target.value = '';
    renderCards();
  });
}

// ---------- Bestanden ----------

function download(name, data, type) {
  const tauri = window.__TAURI__;
  if (tauri) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    tauri.core.invoke('save_file', { name, data: Array.from(bytes) })
      .then((saved) => { if (saved) setMsg($('io-msg'), `${name} opgeslagen.`, 'ok'); })
      .catch((err) => setMsg($('io-msg'), `Opslaan mislukt: ${err}`, 'err'));
    return;
  }
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readRange() {
  const from = parseOct($('save-from').value);
  const to = parseOct($('save-to').value);
  if (from === null || to === null || to < from || to >= 0o160000) { setMsg($('io-msg'), 'Ongeldig adresbereik (octaal, onder 160000).', 'err'); return null; }
  const bytes = [];
  for (let a = from; a <= to; a++) bytes.push(m.peek(a));
  return { from, bytes };
}

function renderTapeState() {
  const p = m.ptr;
  $('tape-state').textContent = p.tape.length ? `Lezer: ${p.pos} van ${p.tape.length} tekens gelezen` : 'Geen band in de lezer';
  $('punch-state').textContent = `Ponser: ${m.ptp.output.length} tekens geponst`;
}

function initFiles() {
  $('file-load').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      let segments, start = null, how;
      try {
        ({ segments, start } = parseAbsoluteLoader(bytes));
        how = 'absolute loader';
      } catch (err) {
        const at = parseOct($('bin-addr').value) ?? 0o1000;
        if (at + bytes.length > 0o160000) throw new Error('past niet in het geheugen');
        segments = [{ start: at, bytes: Array.from(bytes) }];
        how = `ruwe bytes (geen absolute-loaderformaat: ${err.message})`;
      }
      loadSegments(segments);
      const total = segments.reduce((n, s) => n + s.bytes.length, 0);
      if (start !== null && m.cpu.halted) m.panel.addr = start;
      setMsg($('io-msg'), `${file.name}: ${total} bytes geladen als ${how}.${start !== null ? ` Start: ${o6(start)}G` : ''}`, 'ok');
    } catch (err) {
      setMsg($('io-msg'), `Kan ${file.name} niet laden: ${err.message}`, 'err');
    }
    e.target.value = '';
  });
  $('btn-save-lda').addEventListener('click', () => {
    const r = readRange();
    if (!r) return;
    const start = parseOct($('save-start').value);
    download(`pdp11-${o6(r.from)}.lda`, toAbsoluteLoader([{ start: r.from, bytes: r.bytes }], start), 'application/octet-stream');
  });
  $('btn-save-bin').addEventListener('click', () => {
    const r = readRange();
    if (r) download(`pdp11-${o6(r.from)}.bin`, new Uint8Array(r.bytes), 'application/octet-stream');
  });
  $('tape-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    m.loadTape(new Uint8Array(await file.arrayBuffer()));
    setMsg($('io-msg'), `${file.name} ligt in de ponsbandlezer.`, 'ok');
    e.target.value = '';
  });
  $('btn-punch-save').addEventListener('click', () => download('ponsband.bin', new Uint8Array(m.ptp.output), 'application/octet-stream'));
  $('btn-punch-clear').addEventListener('click', () => { m.ptp.output = []; renderTapeState(); });
  renderTapeState();
}

// ---------- Instellingen ----------

function saveSettings() {
  store.set('settings', { speed: m.speed, baud: m.charTime, hz: m.clockHz });
}

function initSettings() {
  const s = store.get('settings', {});
  m.speed = s.speed || 1;
  m.charTime = s.baud || 1042;
  m.clockHz = s.hz || 50;
  $('speed').value = String(m.speed);
  $('baud').value = String(m.charTime);
  $('clock-hz').value = String(m.clockHz);
  if (!$('speed').value) { $('speed').value = '1'; m.speed = 1; }
  if (!$('baud').value) { $('baud').value = '1042'; m.charTime = 1042; }
  $('speed').addEventListener('change', (e) => { m.speed = Number(e.target.value); saveSettings(); });
  $('baud').addEventListener('change', (e) => { m.charTime = Number(e.target.value); saveSettings(); });
  $('clock-hz').addEventListener('change', (e) => { m.clockHz = Number(e.target.value); saveSettings(); });
  $('btn-poweron').addEventListener('click', () => {
    const btn = $('btn-poweron');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Nogmaals klikken om het geheugen te wissen';
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Uit- en aanzetten (geheugen wissen)'; }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Uit- en aanzetten (geheugen wissen)';
    ttyText = '';
    m.powerOn();
    setMsg($('set-msg'), 'Geheugen gewist, PDP-11 opnieuw aangezet.', 'ok');
  });
}

// ---------- Hoofdlus ----------

let cardsDirty = true;
let tapeDirty = true;
m.onChange = (what) => {
  if (what === 'cards') cardsDirty = true;
  else tapeDirty = true;
};

let last = performance.now();
let lastDbg = 0;

function frame(now) {
  const dt = Math.min(now - last, 50);
  last = now;
  const reason = m.run(dt * 1000 * m.speed, breakpoints);
  if ((reason === 'breakpoint' || reason === 'halt') && activeTab === 'dbg') renderDebugger();
  renderPanel();
  if (activeTab === 'dbg' && now - lastDbg > 150) { renderDebugger(); lastDbg = now; }
  if (ttyDirty) renderTerminal();
  if (cardsDirty && activeTab === 'cards') { renderCards(); cardsDirty = false; }
  if (tapeDirty && activeTab === 'io') { renderTapeState(); tapeDirty = false; }
  requestAnimationFrame(frame);
}

buildPanel();
setSR(0);
initTerminal();
ttyWrite('@');
initAssembler();
initDebugger();
initCards();
initFiles();
initSettings();
requestAnimationFrame(frame);
