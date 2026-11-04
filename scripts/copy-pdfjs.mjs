// Copies the few library files the app needs from node_modules into src/lib.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'src', 'lib');

if (!existsSync(join(nm, 'pdfjs-dist'))) {
  console.error('pdfjs-dist not found - run "npm install" first.');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const pdf = join(nm, 'pdfjs-dist');
cpSync(join(pdf, 'build', 'pdf.min.mjs'), join(out, 'pdf.min.mjs'));
cpSync(join(pdf, 'build', 'pdf.worker.min.mjs'), join(out, 'pdf.worker.min.mjs'));
cpSync(join(pdf, 'cmaps'), join(out, 'cmaps'), { recursive: true });
cpSync(join(pdf, 'standard_fonts'), join(out, 'standard_fonts'), { recursive: true });

// Word (.docx) support
cpSync(join(nm, 'jszip', 'dist', 'jszip.min.js'), join(out, 'jszip.min.js'));
cpSync(join(nm, 'docx-preview', 'dist', 'docx-preview.min.js'), join(out, 'docx-preview.min.js'));
console.log('Library files copied to src/lib');
