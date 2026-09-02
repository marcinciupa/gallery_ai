#!/usr/bin/env node
/**
 * Runner testów czystej logiki (`tools/test-*.mjs`).
 *
 *   npm test                 → wszystkie testy
 *   npm test -- speaker      → tylko te, których nazwa zawiera „speaker"
 *
 * Testy importują skompilowane moduły z katalogu tymczasowego (np. `/tmp/rec_ai_test/x.js`),
 * bo `src/lib/*.ts` to TypeScript, a node go nie uruchomi. Wcześniej każdy test wymagał ręcznego
 * wklejenia dwóch komend z własnego nagłówka — dlatego testy powstawały i zaraz się kurzyły.
 *
 * Runner wyprowadza WSZYSTKO z samych testów: ścieżka importu (`/tmp/<dir>/<moduł>.js`) mówi mu
 * i gdzie kompilować, i co kompilować. Dzięki temu nowy test nie wymaga zmiany w runnerze —
 * wystarczy, że importuje tak samo jak reszta. Zależności modułów dociąga sam tsc.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileLib } from './lib-compile.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS, '..');
const filter = process.argv[2] ?? '';

const tests = readdirSync(TOOLS)
  .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter((f) => f.includes(filter))
  .sort();

if (tests.length === 0) {
  // Brak testów w ogóle to jeszcze nie porażka (projekt może ich dopiero dorabiać) — inaczej bramka
  // w build-apk.sh blokowałaby build. Filtr, który nic nie łapie, to już pomyłka w komendzie.
  if (filter) { console.error(`Brak testów pasujących do „${filter}".`); process.exit(1); }
  console.log('(brak plików tools/test-*.mjs — nie ma czego uruchomić)');
  process.exit(0);
}

// ── co skompilować: zbierane z importów samych testów ────────────────────────────────────────
const IMPORT_RE = /from\s+'(\/tmp\/[^']+)\/([A-Za-z0-9_]+)\.js'/g;
const outDirs = new Set();
const modules = new Set();
for (const t of tests) {
  const src = readFileSync(join(TOOLS, t), 'utf8');
  // tylko realne importy, nie przykłady komend w komentarzu nagłówka
  for (const line of src.split('\n')) {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
    for (const m of line.matchAll(IMPORT_RE)) {
      outDirs.add(m[1]);
      modules.add(m[2]);
    }
  }
}
if (outDirs.size !== 1) {
  console.error(`Testy importują z ${outDirs.size} różnych katalogów (${[...outDirs].join(', ')}) — ujednolić.`);
  process.exit(1);
}
const OUT = [...outDirs][0];

console.log(`▸ kompiluję ${modules.size} modułów → ${OUT}`);
let warnings = '';
try {
  ({ warnings } = compileLib(ROOT, [...modules], OUT));
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
if (warnings) console.log(`⚠️  tsc zgłosił uwagi (JS powstał, lecę dalej):\n${warnings}`);

// ── uruchomienie ─────────────────────────────────────────────────────────────────────────────
const failed = [];
for (const t of tests) {
  console.log(`\n──────── ${t} ────────`);
  const r = spawnSync('node', [join(TOOLS, t)], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failed.push(t);
}

console.log('\n════════════════════════════════════════');
if (failed.length === 0) {
  console.log(`✅ wszystkie testy przeszły (${tests.length} plików)`);
} else {
  console.log(`❌ oblane: ${failed.join(', ')}  (${failed.length}/${tests.length})`);
}
process.exit(failed.length === 0 ? 0 : 1);
