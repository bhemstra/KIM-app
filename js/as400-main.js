// AS/400-simulatie: tekent het 5250-scherm in de browser en stuurt de
// toetsen door naar de sessie.
import { Session, createSystem } from './as400/session.js';
import { ROWS, COLS } from './as400/screen.js';

const $ = (id) => document.getElementById(id);
const STORE = 'as400.disk';

// ---------- Opslag (alleen gemak; alles werkt ook zonder) ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const st = JSON.parse(raw);
    return validState(st) ? st : null;
  } catch {
    return null;
  }
}

function validState(st) {
  return st && st.version === 1 && st.libs && st.users && st.sysval && Array.isArray(st.spool);
}

function saveState(st) {
  try { localStorage.setItem(STORE, JSON.stringify(st)); } catch { /* niet beschikbaar of vol */ }
}

let sys, session;

function boot(state) {
  sys = createSystem(state, { save: saveState });
  session = new Session(sys);
  render();
}

// ---------- Het scherm tekenen ----------

const term = $('term');
const wrap = $('screen-wrap');
const ATTR_CLASS = { g: 'a-g', w: 'a-w', b: 'a-b', r: 'a-r', t: 'a-t', y: 'a-y', p: 'a-p' };

const attrClass = (a) => (ATTR_CLASS[a[0]] || 'a-g') + (a.includes('R') ? ' rev' : '');

// Teksten als "F3=Exit" of "More..." zijn aanklikbaar
function clickableRanges(text) {
  const out = [];
  for (const m of text.matchAll(/F(\d{1,2})=\S+(?: (?!F\d)\S+)*/g)) {
    out.push({ from: m.index, to: m.index + m[0].length, key: 'F' + m[1] });
  }
  for (const m of text.matchAll(/More\.\.\./g)) out.push({ from: m.index, to: m.index + 7, key: 'ROLLUP' });
  return out;
}

let fieldEls = [];

function render() {
  const scr = session.screen();
  const lines = scr.chars.map((r) => r.join(''));
  term.textContent = '';
  fieldEls = [];
  for (let r = 0; r < ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    const fields = scr.fields.filter((f) => f.row === r).sort((a, b) => a.col - b.col);
    const keys = clickableRanges(lines[r]);
    const keyAt = (c) => keys.find((k) => c >= k.from && c < k.to)?.key || '';
    let c = 0;
    let fi = 0;
    while (c < COLS) {
      const f = fields[fi];
      if (f && f.col === c) {
        row.appendChild(makeInput(f));
        c += f.len;
        fi++;
        continue;
      }
      const stop = f ? f.col : COLS;
      const attr = scr.attrs[r][c];
      const key = keyAt(c);
      let e = c + 1;
      while (e < stop && scr.attrs[r][e] === attr && keyAt(e) === key) e++;
      const span = document.createElement('span');
      span.className = attrClass(attr);
      span.textContent = lines[r].slice(c, e);
      if (key) {
        span.classList.add('fk');
        span.dataset.key = key;
      }
      row.appendChild(span);
      c = e;
    }
    term.appendChild(row);
  }
  const target = fieldEls.find((i) => i.dataset.name === scr.cursor) || fieldEls[0];
  if (target) {
    target.focus({ preventScroll: true });
    const n = target.value.length;
    try { target.setSelectionRange(n, n); } catch { /* password-veld */ }
  } else term.focus({ preventScroll: true });

  $('power-off').hidden = !session.poweredOff;
  updateOia();
  scheduleTick();
  fit();
}

function makeInput(f) {
  const inp = document.createElement('input');
  inp.type = f.hidden ? 'password' : 'text';
  inp.maxLength = f.len;
  inp.value = f.hidden ? '' : f.value.trimEnd();
  inp.style.width = f.len + 'ch';
  inp.className = 'fld ' + attrClass(f.attr) + (f.upper ? ' up' : '') + (f.underline ? '' : ' nu');
  inp.dataset.name = f.name;
  inp.dataset.row = f.row;
  inp.dataset.col = f.col;
  inp.autocomplete = f.hidden ? 'current-password' : 'off';
  inp.spellcheck = false;
  inp.setAttribute('autocapitalize', f.upper ? 'characters' : 'off');
  inp.setAttribute('autocorrect', 'off');
  inp.setAttribute('enterkeyhint', 'enter');
  inp.setAttribute('aria-label', `Veld regel ${f.row + 1}, kolom ${f.col + 1}`);
  fieldEls.push(inp);
  return inp;
}

// ---------- Toetsen ----------

function send(aid) {
  const values = {};
  for (const inp of fieldEls) values[inp.dataset.name] = inp.value;
  const cursor = document.activeElement?.dataset?.name || null;
  session.aid(aid, values, cursor);
  render();
}

function moveVertical(dir) {
  const cur = document.activeElement;
  if (!fieldEls.length) return;
  const row = cur?.dataset?.row !== undefined ? Number(cur.dataset.row) : -1;
  const col = cur?.dataset?.col !== undefined ? Number(cur.dataset.col) + (cur.selectionStart || 0) : 0;
  const rows = [...new Set(fieldEls.map((i) => Number(i.dataset.row)))].sort((a, b) => a - b);
  let targetRow = dir > 0 ? rows.find((r) => r > row) : [...rows].reverse().find((r) => r < row);
  if (targetRow === undefined) targetRow = dir > 0 ? rows[0] : rows.at(-1);
  const candidates = fieldEls.filter((i) => Number(i.dataset.row) === targetRow);
  let best = candidates[0];
  for (const i of candidates) if (Number(i.dataset.col) <= col) best = i;
  best.focus({ preventScroll: true });
  const pos = Math.max(0, Math.min(best.value.length, col - Number(best.dataset.col)));
  try { best.setSelectionRange(pos, pos); } catch { /* password-veld */ }
}

function keyToAid(e) {
  if (e.key === 'Enter') return 'ENTER';
  const m = /^F(\d{1,2})$/.exec(e.key);
  if (m && Number(m[1]) <= 12) return 'F' + (Number(m[1]) + (e.shiftKey ? 12 : 0));
  if (m && Number(m[1]) <= 24) return 'F' + m[1];
  if (e.key === 'PageDown') return 'ROLLUP';
  if (e.key === 'PageUp') return 'ROLLDOWN';
  if (e.key === 'Escape') return 'F12';
  return null;
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('.panels')) return;
  if (session.poweredOff) return;
  const aid = keyToAid(e);
  if (aid) {
    e.preventDefault();
    send(aid);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveVertical(e.key === 'ArrowDown' ? 1 : -1);
  }
});

// Een vol veld: door naar het volgende (zoals op een echte terminal)
term.addEventListener('input', (e) => {
  const inp = e.target;
  if (inp.tagName !== 'INPUT') return;
  if (inp.value.length >= inp.maxLength && inp.selectionStart === inp.maxLength) {
    const i = fieldEls.indexOf(inp);
    const next = fieldEls[i + 1];
    if (next) next.focus({ preventScroll: true });
  }
  updateOia();
});

term.addEventListener('mousedown', (e) => {
  if (e.target.dataset?.key) e.preventDefault();
});
term.addEventListener('click', (e) => {
  const k = e.target.dataset?.key;
  if (k) send(k);
});
for (const ev of ['focusin', 'keyup', 'click']) term.addEventListener(ev, updateOia);

// ---------- Functietoetsen onder het scherm ----------

function buildKeys() {
  const bar = $('fkeys');
  const keys = [['ENTER', 'Enter'], ...Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]), ['ROLLDOWN', 'Pg ↑'], ['ROLLUP', 'Pg ↓']];
  for (const [aid, label] of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.tabIndex = -1;
    if (aid === 'ENTER') b.className = 'enter';
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => { if (!session.poweredOff) send(aid); });
    bar.appendChild(b);
  }
}

// ---------- Statusregel (operator information area) ----------

function updateOia() {
  const o = session.oia();
  const a = document.activeElement;
  let pos = '';
  if (a?.dataset?.row !== undefined) {
    const col = Number(a.dataset.col) + (a.selectionStart ?? 0) + 1;
    pos = `${String(Number(a.dataset.row) + 1).padStart(2, '0')}/${String(Math.min(col, COLS)).padStart(3, '0')}`;
  }
  const left = o.off ? '  Systeem uit' : `MA  ${o.mw ? 'MW' : '  '}   ${sys.name}  ${session.device}  ${o.user}`;
  $('oia').textContent = '';
  const l = document.createElement('span');
  l.textContent = left;
  const r = document.createElement('span');
  r.textContent = pos;
  if (o.mw) l.title = 'Er staat een bericht voor je klaar (DSPMSG)';
  $('oia').append(l, r);
}

// ---------- IPL-animatie ----------

let tickTimer = null;
function scheduleTick() {
  const needs = !!session.top()?.tick;
  if (needs && !tickTimer) {
    tickTimer = setInterval(() => {
      session.tick();
      render();
    }, 350);
  } else if (!needs && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

$('btn-ipl').addEventListener('click', () => {
  session.ipl();
  render();
});

// ---------- Schalen: het scherm is altijd 80 tekens breed ----------

let natural = null;
function fit() {
  term.style.transform = 'none';
  natural = { w: term.offsetWidth, h: term.offsetHeight };
  const avail = wrap.clientWidth;
  // Past in de breedte; op een groot scherm ook in de hoogte van het venster
  const byHeight = Math.max(0.55, (window.innerHeight - 190) / natural.h);
  const scale = Math.min(1.3, avail / natural.w, byHeight);
  term.style.transform = `scale(${scale})`;
  term.style.marginLeft = Math.max(0, (avail - natural.w * scale) / 2) + 'px';
  wrap.style.height = Math.ceil(natural.h * scale) + 'px';
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => fit()).observe(wrap);
window.addEventListener('resize', fit);

// ---------- Tabbladen ----------

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b === btn);
    for (const t of document.querySelectorAll('.tab-body')) t.classList.toggle('active', t.dataset.tab === btn.dataset.tab);
  });
}

// ---------- Instellingen ----------

const setMsg = (text, cls = '') => {
  const m = $('set-msg');
  m.textContent = text;
  m.className = 'msg ' + cls;
};

$('btn-reipl').addEventListener('click', () => {
  session.powerDown(true);
  render();
  setMsg('Het systeem start opnieuw op.', 'ok');
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(sys.state, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${sys.name.toLowerCase()}-schijf.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setMsg('Schijf geëxporteerd.', 'ok');
});

$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const st = JSON.parse(await file.text());
    if (!validState(st)) throw new Error('geen geldige SIM400-schijf');
    saveState(st);
    boot(st);
    setMsg(`Schijf uit ${file.name} teruggezet. Meld je opnieuw aan.`, 'ok');
  } catch (err) {
    setMsg(`Importeren mislukt: ${err.message}`, 'err');
  }
});

// Twee keer klikken in plaats van confirm() (werkt ook op de iPhone)
let factoryArmed = null;
$('btn-factory').addEventListener('click', () => {
  const b = $('btn-factory');
  if (!factoryArmed) {
    b.textContent = 'Klik nogmaals om te wissen';
    factoryArmed = setTimeout(() => {
      factoryArmed = null;
      b.textContent = 'Schijf wissen';
    }, 4000);
    return;
  }
  clearTimeout(factoryArmed);
  factoryArmed = null;
  b.textContent = 'Schijf wissen';
  try { localStorage.removeItem(STORE); } catch { /* niet beschikbaar */ }
  boot(null);
  setMsg('Schijf gewist; het systeem is als nieuw.', 'ok');
});

buildKeys();
boot(loadState());
