// Laden en opslaan van programma's: KIM-papertape (.ptp) en Intel HEX.

const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');

// KIM-papertape: ";" + aantal + adres + data + controlesom (16 bit), per regel max. 24 bytes.
// Slotregel: ";00" + aantal records + dezelfde waarde als controlesom.
export function toPaperTape(start, bytes) {
  const lines = [];
  let records = 0;
  for (let off = 0; off < bytes.length; off += 24) {
    const chunk = bytes.slice(off, off + 24);
    const addr = (start + off) & 0xFFFF;
    let sum = chunk.length + (addr >> 8) + (addr & 0xFF);
    let line = ';' + hex(chunk.length, 2) + hex(addr, 4);
    for (const b of chunk) { line += hex(b, 2); sum += b; }
    line += hex(sum & 0xFFFF, 4);
    lines.push(line);
    records++;
  }
  lines.push(';00' + hex(records, 4) + hex(records, 4));
  return lines.join('\r\n') + '\r\n';
}

// Geeft [{ start, bytes }] terug
export function parsePaperTape(text) {
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(';')) continue;
    const count = parseInt(line.slice(1, 3), 16);
    if (!count) break;
    const addr = parseInt(line.slice(3, 7), 16);
    const bytes = [];
    let sum = count + (addr >> 8) + (addr & 0xFF);
    for (let i = 0; i < count; i++) {
      const b = parseInt(line.slice(7 + i * 2, 9 + i * 2), 16);
      if (Number.isNaN(b)) throw new Error('ongeldige papertape-regel: ' + line);
      bytes.push(b);
      sum += b;
    }
    const check = parseInt(line.slice(7 + count * 2, 11 + count * 2), 16);
    if (check !== (sum & 0xFFFF)) throw new Error(`controlesom klopt niet op adres $${hex(addr, 4)}`);
    segments.push({ start: addr, bytes });
  }
  if (!segments.length) throw new Error('geen papertape-gegevens gevonden');
  return segments;
}

export function parseIntelHex(text) {
  const segments = [];
  let base = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(':')) continue;
    const bytes = [];
    for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.slice(i, i + 2), 16));
    const [count, ah, al, type] = bytes;
    if ((bytes.reduce((a, b) => a + b, 0) & 0xFF) !== 0) throw new Error('controlesom klopt niet: ' + line);
    if (type === 0x00) segments.push({ start: (base + ((ah << 8) | al)) & 0xFFFF, bytes: bytes.slice(4, 4 + count) });
    else if (type === 0x01) break;
    else if (type === 0x02) base = ((bytes[4] << 8) | bytes[5]) << 4;
    else if (type === 0x04) base = ((bytes[4] << 8) | bytes[5]) << 16;
  }
  if (!segments.length) throw new Error('geen Intel HEX-gegevens gevonden');
  return segments;
}
