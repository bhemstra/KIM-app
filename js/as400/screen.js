// Het 5250-scherm: 24 regels van 80 tekens, met kleuren en invoervelden.
// Dit model kent geen DOM; as400-main.js tekent het in de browser en de tests
// lezen het als tekst.

export const ROWS = 24;
export const COLS = 80;

// Kleuren (zoals op een 3477-kleurenterminal):
//   g groen (gewone tekst), w wit (hoge intensiteit), b blauw, r rood,
//   t turkoois, y geel, p roze. Een 'R' erachter betekent omgekeerd beeld.
export class Screen {
  constructor() {
    this.chars = [];
    this.attrs = [];
    for (let r = 0; r < ROWS; r++) {
      this.chars.push(Array(COLS).fill(' '));
      this.attrs.push(Array(COLS).fill('g'));
    }
    this.fields = [];
    this.cursor = null; // naam van het veld waar de cursor moet staan
  }

  text(row, col, str, attr = 'g') {
    if (row < 0 || row >= ROWS) return this;
    str = String(str);
    for (let i = 0; i < str.length; i++) {
      const c = col + i;
      if (c < 0) continue;
      if (c >= COLS) break;
      this.chars[row][c] = str[i];
      this.attrs[row][c] = attr;
    }
    return this;
  }

  // Tekst gecentreerd op een regel
  center(row, str, attr = 'w') {
    return this.text(row, Math.max(0, Math.floor((COLS - str.length) / 2)), str, attr);
  }

  // Invoerveld. upper: kleine letters worden hoofdletters (standaard aan).
  field(row, col, len, name, opts = {}) {
    len = Math.max(1, Math.min(len, COLS - col));
    const f = {
      row, col, len, name,
      value: String(opts.value ?? '').slice(0, len),
      hidden: !!opts.hidden,
      upper: opts.upper !== false,
      attr: opts.attr || 'g',
      underline: opts.underline !== false,
    };
    this.fields.push(f);
    return f;
  }

  getField(name) {
    return this.fields.find((f) => f.name === name);
  }

  // Het scherm als tekstregels, met de inhoud van de velden (verborgen velden leeg)
  lines() {
    const rows = this.chars.map((r) => r.slice());
    for (const f of this.fields) {
      const v = f.hidden ? '' : f.value;
      for (let i = 0; i < f.len; i++) rows[f.row][f.col + i] = v[i] ?? ' ';
    }
    return rows.map((r) => r.join(''));
  }

  toString() {
    return this.lines().map((l) => l.trimEnd()).join('\n');
  }
}
