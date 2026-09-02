/**
 * Kompilacja modułów `src/lib/*.ts` do JS, żeby dało się je uruchomić node'em (testy, podgląd podziału).
 * Wspólna dla `run-tests.mjs` i `show-split.mjs` — jedno miejsce zna flagi tsc i pułapkę z rozszerzeniami.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * @param root katalog projektu (ten z package.json)
 * @param modules nazwy modułów z src/lib bez rozszerzenia, np. ['transcriptRows', 'speakerSplit']
 * @param outDir katalog docelowy (kasowany i tworzony od nowa)
 * @returns outDir — do budowania ścieżek importu
 */
export function compileLib(root, modules, outDir) {
  const files = modules.map((m) => join('src/lib', `${m}.ts`));
  const missing = files.filter((f) => !existsSync(join(root, f)));
  if (missing.length) throw new Error(`Brak modułów: ${missing.join(', ')}`);

  rmSync(outDir, { recursive: true, force: true });
  const tsc = spawnSync(
    'npx',
    ['tsc', ...files, '--ignoreConfig', '--outDir', outDir, '--module', 'esnext', '--target', 'es2022', '--skipLibCheck'],
    { cwd: root, encoding: 'utf8' },
  );

  // tsc emituje JS mimo błędów typów (np. gdy moduł ociera się o typy react-native). Twardo przerywamy
  // dopiero, gdy naprawdę brakuje plików — inaczej i tak nie dałoby się ich zaimportować.
  const emitted = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.js')) : [];
  const notEmitted = modules.filter((m) => !emitted.includes(`${m}.js`));
  if (notEmitted.length) {
    throw new Error(`tsc nie wyprodukował: ${notEmitted.join(', ')}\n${tsc.stdout ?? ''}${tsc.stderr ?? ''}`);
  }

  // tsc nie dopisuje `.js` do ścieżek względnych, a node ESM tego wymaga.
  for (const f of emitted) {
    const p = join(outDir, f);
    const before = readFileSync(p, 'utf8');
    const after = before.replace(/from\s+'(\.\/[A-Za-z0-9_]+)'/g, "from '$1.js'");
    if (after !== before) writeFileSync(p, after);
  }

  return { outDir, warnings: tsc.status === 0 ? '' : (tsc.stdout ?? '').trim() };
}
