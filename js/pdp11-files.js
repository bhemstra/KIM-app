// Bestandsformaten voor de PDP-11:
// - DEC "absolute loader"-formaat (.lda, .bin, .ptp): blokken met 1 0, lengte
//   (inclusief de 6 kopbytes), laadadres, data en een controlegetal. Een blok
//   zonder data geeft het startadres (oneven = niet starten).

export function parseAbsoluteLoader(bytes) {
  const segments = [];
  let start = null;
  let i = 0;
  const n = bytes.length;
  for (;;) {
    while (i < n && bytes[i] === 0) i++;
    if (i >= n) break;
    if (bytes[i] !== 1 || bytes[i + 1] !== 0) throw new Error(`geen geldig absolute-loaderblok op positie ${i}`);
    if (i + 6 > n) throw new Error('bestand houdt halverwege een blok op');
    const len = bytes[i + 2] | (bytes[i + 3] << 8);
    const addr = bytes[i + 4] | (bytes[i + 5] << 8);
    if (len < 6 || i + len + 1 > n) throw new Error(`ongeldige bloklengte op positie ${i}`);
    let sum = 0;
    for (let k = 0; k <= len; k++) sum += bytes[i + k];
    if ((sum & 0xFF) !== 0) throw new Error(`controlegetal klopt niet in het blok op adres ${addr.toString(8)}`);
    if (len === 6) {
      start = addr & 1 ? null : addr;
      break;
    }
    segments.push({ start: addr, bytes: Array.from(bytes.slice(i + 6, i + len)) });
    i += len + 1;
  }
  if (!segments.length) throw new Error('geen data gevonden');
  return { segments, start };
}

export function toAbsoluteLoader(segments, start) {
  const out = [];
  const block = (addr, data) => {
    const len = data.length + 6;
    const b = [1, 0, len & 0xFF, len >> 8, addr & 0xFF, (addr >> 8) & 0xFF, ...data];
    const sum = b.reduce((s, x) => s + x, 0);
    out.push(...b, (-sum) & 0xFF);
  };
  for (let k = 0; k < 8; k++) out.push(0); // aanloop
  for (const s of segments) {
    for (let o = 0; o < s.bytes.length; o += 256) block(s.start + o, s.bytes.slice(o, o + 256));
  }
  block(start === null || start === undefined ? 1 : start, []);
  for (let k = 0; k < 8; k++) out.push(0);
  return new Uint8Array(out);
}
