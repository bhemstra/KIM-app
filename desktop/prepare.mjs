// Zet de webbestanden van de Junior-emulator klaar in dist/ voor de desktop-app.
// De pagina is dezelfde als junior.html, zonder de link naar de KIM-1.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(here, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
cpSync(join(root, 'css'), join(dist, 'css'), { recursive: true });
cpSync(join(root, 'js'), join(dist, 'js'), { recursive: true });

let html = readFileSync(join(root, 'junior.html'), 'utf8');
html = html.replace(/\s*<nav class="machines"[\s\S]*?<\/nav>/, '');
writeFileSync(join(dist, 'index.html'), html);
console.log('dist/ klaar');
