/**
 * Generator `src/components/icons/keyIcons.gen.ts` z plików `assets/key-icons/*.svg`
 * (eksport z Figmy, component set 496:24601 „icons").
 *
 *   node tools/gen-key-icons.mjs                      # zapisuje src/components/icons/keyIcons.gen.ts (tego repo)
 *
 * Kopia z rec_ai/mobile/tools (2026-09-21) + bramka na `transform`. W gallery_ai uruchamiać bez argumentu.
 *
 * Po co osobny plik zamiast trzymania SVG: `react-native-svg` renderuje prymitywy, a nie tekst SVG,
 * więc i tak trzeba je sparsować. Trzymamy WYNIK parsowania, żeby apka nie robiła tego w runtime.
 *
 * Skrypt jest w repo świadomie — poprzednia wersja istniała tylko w historii sesji, więc po każdej
 * zmianie zestawu w Figmie trzeba było pisać go od nowa.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'assets', 'key-icons');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, '..', 'src', 'components', 'icons', 'keyIcons.gen.ts');

const num = (s) => Math.round(Number(s) * 100) / 100; // setne wystarczą przy siatce 32×32
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/** Jeden plik SVG → lista prymitywów w kolejności rysowania. */
function parseSvg(svg, file) {
  const els = [];
  for (const tag of svg.match(/<(path|rect|circle|ellipse)\b[^>]*>/g) ?? []) {
    // `transform` NIE jest przenoszony do IconEl — bez tej bramki prymityw lądował po cichu w złym miejscu
    // (shred.svg: prostokąt z rotate(-180) wypadał poza pole 32×32, ikona trwałego kasowania była zepsuta).
    // Figma eksportuje tak obrócone elementy — rozwiąż transform w SVG ręcznie, zanim uruchomisz generator.
    if (/\btransform=/.test(tag)) throw new Error(`${file}: element z transform (${tag.slice(0, 60)}…) — rozwiąż go w SVG`);
    if (/^<path/.test(tag)) {
      const d = attr(tag, 'd');
      if (d) els.push({ t: 'p', d: d.replace(/\s+/g, ' ').trim() });
    } else if (/^<rect/.test(tag)) {
      els.push({ t: 'r', x: num(attr(tag, 'x') ?? 0), y: num(attr(tag, 'y') ?? 0), w: num(attr(tag, 'width')), h: num(attr(tag, 'height')) });
    } else if (/^<circle/.test(tag)) {
      els.push({ t: 'c', cx: num(attr(tag, 'cx')), cy: num(attr(tag, 'cy')), r: num(attr(tag, 'r')) });
    } else {
      const rx = num(attr(tag, 'rx'));
      const ry = num(attr(tag, 'ry'));
      // elipsa nie-okrągła nie ma reprezentacji w IconEl — lepiej głośno niż po cichu krzywo
      if (Math.abs(rx - ry) > 0.01) throw new Error(`${file}: elipsa rx≠ry (${rx}≠${ry}) — dołóż typ do IconEl`);
      els.push({ t: 'c', cx: num(attr(tag, 'cx')), cy: num(attr(tag, 'cy')), r: rx });
    }
  }
  if (!els.length) throw new Error(`${file}: brak prymitywów`);
  return els;
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.svg')).sort();
const icons = {};
for (const f of files) icons[path.basename(f, '.svg')] = parseSvg(fs.readFileSync(path.join(SRC, f), 'utf8'), f);

const header = `// AUTO-GENEROWANE z assets/key-icons/*.svg (Figma component set 496:24601). NIE edytować ręcznie.
// Ikony liniowe 32×32 (stroke-width w KeyIcon.tsx, round cap). Renderować przez <KeyIcon>.
// Regeneracja: node tools/gen-key-icons.mjs [ścieżka/do/keyIcons.gen.ts]
export type IconEl =
  | { t: 'p'; d: string }
  | { t: 'r'; x: number; y: number; w: number; h: number }
  | { t: 'c'; cx: number; cy: number; r: number };
export const KEY_ICONS: Record<string, IconEl[]> = ${JSON.stringify(icons)};
export type KeyIconName = keyof typeof KEY_ICONS;
`;
fs.writeFileSync(OUT, header);
console.log(`${files.length} ikon → ${OUT}`);
console.log(Object.keys(icons).join(' '));
