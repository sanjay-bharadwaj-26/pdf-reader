// Copies the few PDF.js files the app needs from node_modules into src/lib.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', 'pdfjs-dist');
const out = join(root, 'src', 'lib');

if (!existsSync(pkg)) {
  console.error('pdfjs-dist not found - run "npm install" first.');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
cpSync(join(pkg, 'build', 'pdf.min.mjs'), join(out, 'pdf.min.mjs'));
cpSync(join(pkg, 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
cpSync(join(pkg, 'cmaps'), join(out, 'cmaps'), { recursive: true });
cpSync(join(pkg, 'standard_fonts'), join(out, 'standard_fonts'), { recursive: true });
console.log('PDF.js assets copied to src/lib');
