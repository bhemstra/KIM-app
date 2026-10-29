// Gebruikersinterface, gedeeld door de KIM-1 en de Junior Computer.
import { KEY } from './board.js';
import { assemble } from './assembler.js';
import { disassemble, h2, h4 } from './disasm.js';
import { toPaperTape, parsePaperTape, parseIntelHex } from './fileformats.js';

const $ = (id) => document.getElementById(id);

// Gezet door startApp()
let kim; // de machine (KIM1 of Junior)
let cfg; // { name, storePrefix, samples, romNames, resetLabel }
let SAMPLES;
let ROM_NAMES;

// ---------- Opslag (alleen gemak; alles werkt ook zonder) ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(cfg.storePrefix + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(cfg.storePrefix + key, JSON.stringify(value)); } catch { /* niet beschikbaar */ }
  },
};

// ---------- Display ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const segEls = [];

function buildDisplay() {
  const svg = $('display');
  const W = 34, H = 62, T = 7;
  const hseg = (y) => {
    const x1 = T / 2 + 1, x2 = W - T / 2 - 1, d = T / 2;
    return `${x1},${y} ${x1 + d},${y - d} ${x2 - d},${y - d} ${x2},${y} ${x2 - d},${y + d} ${x1 + d},${y + d}`;
  };
  const vseg = (x, y1, y2) => {
    const d = T / 2;
    return `${x},${y1} ${x + d},${y1 + d} ${x + d},${y2 - d} ${x},${y2} ${x - d},${y2 - d} ${x - d},${y1 + d}`;
  };
  const shapes = [
    hseg(T / 2), // a
    vseg(W - T / 2, T / 2 + 1, H / 2 - 1), // b
    vseg(W - T / 2, H / 2 + 1, H - T / 2 - 1), // c
    hseg(H - T / 2), // d
    vseg(T / 2, H / 2 + 1, H - T / 2 - 1), // e
    vseg(T / 2, T / 2 + 1, H / 2 - 1), // f
    hseg(H / 2), // g
  ];
  for (let d = 0; d < 6; d++) {
    const g = document.createElementNS(SVG_NS, 'g');
    const x = 14 + d * 52 + (d >= 4 ? 8 : 0);
    g.setAttribute('transform', `translate(${x} 9) skewX(-6)`);
    const segs = [];
    for (const pts of shapes) {
      const p = document.createElementNS(SVG_NS, 'polygon');
      p.setAttribute('points', pts);
      p.setAttribute('class', 'seg');
      g.appendChild(p);
      segs.push(p);
    }
    svg.appendChild(g);
    segEls.push(segs);
  }
}

let shownImage = [];
function renderDisplay(img) {
  for (let d = 0; d < 6; d++) {
    if (shownImage[d] === img[d]) continue;
    for (let s = 0; s < 7; s++) segEls[d][s].classList.toggle('on', !!(img[d] & (1 << s)));
  }
  shownImage = img.slice();
}

// ---------- Keypad ----------

const layout = () => [
  ['GO', 'ST', cfg.resetLabel, null],
  ['AD', 'DA', 'PC', '+'],
  ['C', 'D', 'E', 'F'],
  ['8', '9', 'A', 'B'],
  ['4', '5', '6', '7'],
  ['0', '1', '2', '3'],
];
const LABEL_CODE = { AD: KEY.AD, DA: KEY.DA, '+': KEY.PLUS, GO: KEY.GO, PC: KEY.PC };
const KB_HINT = { AD: 'Q', DA: 'W', '+': 'spc', GO: 'G', PC: 'P', ST: 'Esc', RS: 'R', RST: 'R' };
const keyButtons = new Map(); // label -> button
const MIN_HOLD_MS = 70;
const pressedAt = new Map();

function labelCode(label) {
  return label in LABEL_CODE ? LABEL_CODE[label] : parseInt(label, 16);
}

function press(label) {
  const btn = keyButtons.get(label);
  if (btn) btn.classList.add('down');
  if (label === 'ST') { kim.stop(); return; }
  if (label === cfg.resetLabel) { kim.reset(); paused = false; return; }
  pressedAt.set(label, performance.now());
  kim.keyDown(labelCode(label));
}

function release(label) {
  const btn = keyButtons.get(label);
  const t = pressedAt.get(label);
  const wait = t === undefined ? 0 : Math.max(0, MIN_HOLD_MS - (performance.now() - t));
  setTimeout(() => {
    if (btn) btn.classList.remove('down');
    if (label === 'ST' || label === cfg.resetLabel) return;
    pressedAt.delete(label);
    kim.keyUp(labelCode(label));
  }, wait);
}

function buildKeypad() {
  const pad = $('keypad');
  for (const row of layout()) {
    for (const label of row) {
      const b = document.createElement('button');
      b.type = 'button';
      if (!label) { b.className = 'empty'; b.tabIndex = -1; pad.appendChild(b); continue; }
      b.textContent = label;
      if (label.length > 1 || label === '+') b.className = 'fn';
      if (KB_HINT[label]) {
        const k = document.createElement('span');
        k.className = 'kb';
        k.textContent = KB_HINT[label];
        b.appendChild(k);
      }
      b.setAttribute('aria-label', label);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); press(label); });
      b.addEventListener('pointerup', () => release(label));
      b.addEventListener('pointercancel', () => release(label));
      b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(label); } });
      b.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); release(label); } });
      keyButtons.set(label, b);
      pad.appendChild(b);
    }
  }
}

function keyLabelFor(e) {
  const k = e.key;
  if (e.shiftKey && k.toLowerCase() === 'a') return 'AD';
  if (e.shiftKey && k.toLowerCase() === 'd') return 'DA';
  if (/^[0-9a-fA-F]$/.test(k)) return k.toUpperCase();
  switch (k.toLowerCase()) {
    case 'q': return 'AD';
    case 'w': return 'DA';
    case '+': case '=': case ' ': return '+';
    case 'g': case 'enter': return 'GO';
    case 'p': return 'PC';
    case 's': case 'escape': return 'ST';
    case 'r': return cfg.resetLabel;
    default: return null;
  }
}

const heldKeys = new Map(); // event.code -> label

function isTyping(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.id === 'terminal');
}

document.addEventListener('keydown', (e) => {
  if (isTyping(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === 't' && !e.repeat) { setSst(!kim.sst); e.preventDefault(); return; }
  const label = keyLabelFor(e);
  if (!label) return;
  e.preventDefault();
  if (e.repeat || heldKeys.has(e.code)) return;
  heldKeys.set(e.code, label);
  press(label);
});

document.addEventListener('keyup', (e) => {
  const label = heldKeys.get(e.code);
  if (!label) return;
  heldKeys.delete(e.code);
  release(label);
});

window.addEventListener('blur', () => {
  for (const label of heldKeys.values()) release(label);
  heldKeys.clear();
});

// ---------- SST ----------

function setSst(on) {
  kim.sst = on;
  $('sst').checked = on;
  $('sst-state').textContent = on ? 'AAN' : 'UIT';
  saveSettings();
}

// ---------- Tabs ----------

let activeTab = 'asm';
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-body').forEach((x) => x.classList.toggle('active', x.dataset.tab === activeTab));
    if (activeTab === 'dbg') renderDebugger();
    if (activeTab === 'tty' && !matchMedia('(pointer: coarse)').matches) $('terminal').focus();
  });
});

// ---------- Assembler ----------

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

function loadSegments(segments) {
  for (const s of segments) s.bytes.forEach((b, i) => kim.poke(s.start + i, b));
}

function assembleAndLoad() {
  const msg = $('asm-msg');
  try {
    const r = assemble($('source').value);
    loadSegments(r.segments);
    const total = r.segments.reduce((n, s) => n + s.bytes.length, 0);
    const ranges = r.segments.map((s) => `$${h4(s.start)}–$${h4(s.start + s.bytes.length - 1)}`).join(', ');
    if (kim.halted) kim.showAddress(r.start);
    setMsg(msg, `${total} bytes geladen (${ranges}). Start: AD ${h4(r.start)} GO`, 'ok');
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

function initAssembler() {
  const sel = $('sample');
  SAMPLES.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = s.name;
    sel.appendChild(o);
  });
  const showDesc = () => { $('sample-desc').textContent = SAMPLES[sel.value].description; };
  sel.addEventListener('change', showDesc);
  sel.value = store.get('sample', 1);
  if (!SAMPLES[sel.value]) sel.value = 0;
  showDesc();
  $('source').value = store.get('source', SAMPLES[sel.value].source);

  $('btn-load-sample').addEventListener('click', () => {
    $('source').value = SAMPLES[sel.value].source;
    store.set('source', $('source').value);
    store.set('sample', Number(sel.value));
    setMsg($('asm-msg'), '');
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
      const s = ta.selectionStart;
      ta.setRangeText('\t', s, ta.selectionEnd, 'end');
    }
  });
  $('btn-assemble').addEventListener('click', assembleAndLoad);
  $('btn-run').addEventListener('click', () => {
    const r = assembleAndLoad();
    if (r) { paused = false; kim.go(r.start); }
  });
}

// ---------- Debugger ----------

let paused = false;
let breakpoints = new Set();

function flagString(p) {
  return 'NV-BDIZC'.split('').map((f, i) => (p & (0x80 >> i) ? f : f === '-' ? '-' : '.')).join('');
}

function renderDebugger() {
  const c = kim.cpu;
  const inMonitor = kim.halted && !kim.realRom;
  $('regs').innerHTML = [
    ['PC', h4(c.pc)], ['A', h2(c.a)], ['X', h2(c.x)], ['Y', h2(c.y)],
    ['S', h2(c.s)], ['P', `${h2(c.p)}  ${flagString(c.p)}`], ['Cycli', c.cycles.toLocaleString('nl-NL')],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const peek = (a) => kim.peek(a);
  let addr = inMonitor ? kim.point : c.pc;
  const lines = [];
  if (inMonitor) lines.push('; monitor actief, vanaf POINT:');
  for (let i = 0; i < 14; i++) {
    const d = disassemble(peek, addr);
    const bytes = d.bytes.map(h2).join(' ').padEnd(9);
    const mark = !inMonitor && addr === c.pc ? '<span class="cur">&gt;</span>' : ' ';
    const bp = breakpoints.has(addr) ? '*' : ' ';
    const rom = !kim.realRom && kim.isRomAddress(addr) ? ROM_NAMES[addr & 0x1FFF] : null;
    lines.push(`${mark}${bp}${h4(addr)}  ${bytes} ${rom ? `<span class="cur">; ${rom} (ingebouwde monitorroutine)</span>` : d.text}`);
    addr = (addr + d.size) & 0xFFFF;
  }
  $('disasm').innerHTML = lines.join('\n');

  const start = (parseInt($('mem-addr').value, 16) || 0) & 0xFFF0;
  const rows = [];
  for (let r = 0; r < 16; r++) {
    const a = (start + r * 16) & 0xFFFF;
    let hexPart = '';
    let asc = '';
    for (let i = 0; i < 16; i++) {
      const v = kim.peek((a + i) & 0xFFFF);
      hexPart += h2(v) + (i === 7 ? '  ' : ' ');
      asc += v >= 0x20 && v < 0x7F ? String.fromCharCode(v) : '.';
    }
    rows.push(`${h4(a)}  ${hexPart} ${asc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`);
  }
  $('memdump').innerHTML = rows.join('\n');

  $('btn-pause').textContent = paused ? 'Doorgaan' : 'Pauze';
  setMsg($('dbg-state'), paused ? 'CPU gepauzeerd' : inMonitor ? 'In de monitor (wacht op toetsen)' : 'Loopt');
}

function initDebugger() {
  $('btn-pause').addEventListener('click', () => { paused = !paused; renderDebugger(); });
  $('btn-step').addEventListener('click', () => {
    paused = true;
    kim.stepInstruction();
    renderDebugger();
  });
  $('bp').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 16);
    breakpoints = e.target.value.length === 4 && !Number.isNaN(v) ? new Set([v]) : new Set();
    renderDebugger();
  });
  $('mem-addr').addEventListener('input', renderDebugger);
}

// ---------- Terminal ----------

let ttyText = '';
let ttyDirty = true;

function ttyWrite(s) {
  for (const ch of s) {
    if (ch === '\r' || ch === '\x07' || ch === '\0') continue;
    if (ch === '\b' || ch === '\x7F') { ttyText = ttyText.slice(0, -1); continue; }
    ttyText += ch;
  }
  if (ttyText.length > 20000) ttyText = ttyText.slice(-16000);
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

function initTerminal() {
  if (!kim.ttyInput) return;
  kim.onTTYOutput = ttyWrite;
  const t = $('terminal');
  t.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let ch = null;
    if (e.key === 'Enter') ch = '\r';
    else if (e.key === 'Backspace') ch = '\b';
    else if (e.key === 'Escape') ch = '\x1B';
    else if (e.key.length === 1) ch = e.key;
    if (ch === null) return;
    e.preventDefault();
    kim.ttyInput.push(ch);
  });
  t.addEventListener('paste', (e) => {
    e.preventDefault();
    for (const ch of e.clipboardData.getData('text')) kim.ttyInput.push(ch === '\n' ? '\r' : ch);
  });
  // Invoerveld: nodig op telefoons, waar een <pre> geen toetsenbord oproept
  const inp = $('tty-input');
  inp.addEventListener('input', () => {
    for (const ch of inp.value) kim.ttyInput.push(ch);
    inp.value = '';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); kim.ttyInput.push('\r'); }
    else if (e.key === 'Backspace' && inp.value === '') { e.preventDefault(); kim.ttyInput.push('\b'); }
  });
  $('btn-tty-clear').addEventListener('click', () => { ttyText = ''; ttyDirty = true; });
}

// ---------- Bestanden & tape ----------

function download(name, data, type) {
  // In de desktop-app (Tauri) via het opslagvenster van het systeem
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
  const from = parseInt($('save-from').value, 16);
  const to = parseInt($('save-to').value, 16);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) { setMsg($('io-msg'), 'Ongeldig adresbereik.', 'err'); return null; }
  const bytes = [];
  for (let a = from; a <= to; a++) bytes.push(kim.peek(a));
  return { from, bytes };
}

function renderTapes() {
  const ul = $('tapes');
  ul.innerHTML = '';
  if (!kim.tapes.length) {
    ul.innerHTML = '<li class="hint">De cassette is leeg.</li>';
    return;
  }
  kim.tapes.forEach((t, i) => {
    const li = document.createElement('li');
    li.textContent = `ID ${h2(t.id)}  $${h4(t.start)}–$${h4((t.start + t.data.length - 1) & 0xFFFF)} (${t.data.length} bytes)`;
    const save = document.createElement('button');
    save.textContent = '.ptp';
    save.addEventListener('click', () => download(`kim-tape-${h2(t.id)}.ptp`, toPaperTape(t.start, t.data), 'text/plain'));
    const del = document.createElement('button');
    del.textContent = 'Wissen';
    del.addEventListener('click', () => { kim.tapes.splice(i, 1); tapesChanged(); });
    li.append(save, del);
    ul.appendChild(li);
  });
}

function tapesChanged() {
  store.set('tapes', kim.tapes);
  renderTapes();
}

function initFiles() {
  if (kim.tapes) {
    kim.tapes = store.get('tapes', []);
    kim.onTapeChange = tapesChanged;
    renderTapes();
  }

  $('file-load').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    try {
      let segments;
      if (ext === 'bin' || ext === 'rom') {
        const start = parseInt($('bin-addr').value, 16) || 0;
        segments = [{ start, bytes: [...new Uint8Array(await file.arrayBuffer())] }];
      } else {
        const text = await file.text();
        segments = text.trimStart().startsWith(':') ? parseIntelHex(text) : parsePaperTape(text);
      }
      loadSegments(segments);
      const total = segments.reduce((n, s) => n + s.bytes.length, 0);
      if (kim.halted) kim.showAddress(segments[0].start);
      setMsg($('io-msg'), `${file.name}: ${total} bytes geladen vanaf $${h4(segments[0].start)}.`, 'ok');
    } catch (err) {
      setMsg($('io-msg'), `Kan ${file.name} niet laden: ${err.message}`, 'err');
    }
    e.target.value = '';
  });
  $('btn-save-ptp').addEventListener('click', () => {
    const r = readRange();
    if (r) download(`kim-${h4(r.from)}.ptp`, toPaperTape(r.from, r.bytes), 'text/plain');
  });
  $('btn-save-bin').addEventListener('click', () => {
    const r = readRange();
    if (r) download(`kim-${h4(r.from)}.bin`, new Uint8Array(r.bytes), 'application/octet-stream');
  });
}

// ---------- Instellingen ----------

function saveSettings() {
  store.set('settings', { speed: kim.speed, expanded: kim.expanded, sst: kim.sst });
}

function updateRomState() {
  $('rom-state').textContent = kim.realRom ? 'originele ROM (geladen bestand)' : 'ingebouwde nabootsing';
}

function initSettings() {
  const s = store.get('settings', {});
  kim.speed = s.speed || 1;
  kim.expanded = !!s.expanded;
  $('speed').value = String(kim.speed);
  $('expand').checked = kim.expanded;
  $('sst').checked = !!s.sst;
  setSst(!!s.sst);

  const rom = store.get('rom', null);
  if (rom) {
    try {
      kim.loadRealRom(Uint8Array.from(atob(rom), (ch) => ch.charCodeAt(0)));
      kim.reset();
    } catch { /* ongeldige opgeslagen ROM negeren */ }
  }
  updateRomState();

  $('speed').addEventListener('change', (e) => { kim.speed = Number(e.target.value); saveSettings(); });
  $('expand').addEventListener('change', (e) => { kim.expanded = e.target.checked; saveSettings(); });
  $('sst').addEventListener('change', (e) => setSst(e.target.checked));
  $('rom-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      kim.loadRealRom(bytes);
      store.set('rom', btoa(String.fromCharCode(...bytes)));
      kim.reset();
      paused = false;
    } catch (err) {
      setMsg($('set-msg'), err.message, 'err');
    }
    e.target.value = '';
    updateRomState();
  });
  $('btn-rom-hle').addEventListener('click', () => {
    kim.useHleRom();
    store.set('rom', null);
    kim.reset();
    paused = false;
    updateRomState();
  });
  $('btn-poweron').addEventListener('click', () => {
    // Twee keer klikken in plaats van confirm() (werkt niet overal, o.a. in ingesloten pagina's)
    const btn = $('btn-poweron');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Nogmaals klikken om het geheugen te wissen';
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Uit- en aanzetten (geheugen wissen)'; }, 4000);
      return;
    }
    delete btn.dataset.armed;
    btn.textContent = 'Uit- en aanzetten (geheugen wissen)';
    kim.powerOn();
    paused = false;
    setMsg($('set-msg'), `Geheugen gewist, ${cfg.name} opnieuw gestart.`, 'ok');
  });
}

// ---------- Hoofdlus ----------

function renderStatus() {
  const el = $('status');
  let text;
  let running = false;
  if (paused) text = 'PAUZE';
  else if (kim.halted && !kim.realRom) text = kim.monitorLabel;
  else { text = 'LOOPT'; running = true; }
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('running', running);
}

let last = performance.now();
let lastDbg = 0;

function frame(now) {
  const dt = Math.min(now - last, 50);
  last = now;
  if (!paused) {
    const reason = kim.run(Math.round(dt * 1000 * kim.speed), breakpoints);
    if (reason === 'breakpoint') {
      paused = true;
      renderDebugger();
    }
  }
  renderDisplay(kim.displayImage());
  renderStatus();
  if (activeTab === 'dbg' && now - lastDbg > 150) { renderDebugger(); lastDbg = now; }
  if (ttyDirty && activeTab === 'tty') renderTerminal();
  requestAnimationFrame(frame);
}

export function startApp(machine, config) {
  kim = machine;
  cfg = config;
  SAMPLES = config.samples;
  ROM_NAMES = Object.fromEntries(Object.entries(config.romNames).map(([name, addr]) => [addr, name]));
  buildDisplay();
  buildKeypad();
  initAssembler();
  initDebugger();
  initTerminal();
  initFiles();
  initSettings();
  requestAnimationFrame(frame);

  // Handig voor experimenten in de console
  window.machine = kim;
}
