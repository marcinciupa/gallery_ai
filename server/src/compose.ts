/**
 * compose.ts — operacje na pikselach (sharp) potrzebne do KOMPOZYCJI wyniku AI przez maskę.
 *
 * Kontrakt całej układanki (patrz [[mask.ts]]): model regeneruje cały wycinek, a my wklejamy go do
 * oryginału TYLKO przez maskę. Dzięki temu piksele poza zaznaczeniem zostają nietknięte — to jest
 * właściwa poprawka na „edycja zmienia znacznie większy obszar niż zaznaczony".
 *
 * Dlaczego sharp: potrzebujemy dekodowania JPEG/PNG, wycinania, skalowania, rozmycia gaussowskiego
 * (feather) i alfa-kompozycji. sharp dostarcza to natywnie (libvips) i ma gotowe binaria na linux-x64,
 * więc `npm ci` na Railway nie kompiluje niczego ze źródeł.
 */
import sharp from 'sharp';
import type { Roi } from './mask.js';
import { BadRequest, ProxyError } from './errors.js';

/** Próg alfy, poniżej którego piksel uznajemy za „dziurę do wypełnienia" (rogi po obrocie kadru). */
const ALPHA_HOLE = 250;
/** sharp wymaga sigma ≥ 0.3; niżej rozmycie i tak nic by nie dało. */
const MIN_SIGMA = 0.3;

/**
 * Górny limit rozdzielczości wejścia. Limit rozmiaru PLIKU (20 MB w multerze) nic tu nie daje:
 * jednolity PNG 12000×12000 (144 MP) waży poniżej 0.5 MB, a rozpakowany zjada w tej ścieżce ~1.7 GB
 * (bufory RGBA + kolejka BFS) — czyli OOM kontenera i ubicie wszystkich równoległych żądań.
 * Apka i tak capuje dłuższy bok na 1536 px (≈2.4 MP), więc 12 MP to 5× zapas.
 */
const MAX_PIXELS = 12_000_000;

const rawGray = (width: number, height: number) => ({ raw: { width, height, channels: 1 as const } });

/**
 * Wymusza JEDNOKANAŁOWE wyjście raw. sharp domyślnie promuje bufor 1-kanałowy do sRGB (3 kanały) —
 * bez tego kolejny etap dostawał bufor 3× za duży i maska po cichu wychodziła pusta (złapane w selftest).
 */
async function gray1(p: sharp.Sharp, expect: number): Promise<Buffer> {
  const buf = await p.toColourspace('b-w').raw().toBuffer();
  if (buf.length !== expect) throw new ProxyError(`maska: ${buf.length} B zamiast ${expect} B (liczba kanałów?)`);
  return buf;
}

export type ImageFacts = { width: number; height: number; hasAlpha: boolean };

/**
 * Wymiary + czy obraz ma kanał alfa. Odrzuca (400) wejście nieczytelne albo zbyt duże — jedno i drugie
 * to wina żądania, nie deAPI, więc nie może wracać jako 502 „upstream failed" („spróbuj później" byłoby
 * myląceniem: ponowienie tego samego pliku nigdy nie zadziała).
 */
export async function readImage(buf: Buffer): Promise<ImageFacts> {
  let m: sharp.Metadata;
  try {
    m = await sharp(buf).metadata();
  } catch {
    throw new BadRequest('unreadable image');
  }
  if (!m.width || !m.height) throw new BadRequest('unreadable image');
  if (m.width * m.height > MAX_PIXELS) throw new BadRequest('image too large — max 12 megapixels');
  return { width: m.width, height: m.height, hasAlpha: Boolean(m.hasAlpha) };
}

/**
 * Maska z KANAŁU ALFA — dla GENERATIVE FILL. Kadrowanie z obrotem zostawia przezroczyste rogi;
 * to one (a nie całe zdjęcie) są obszarem do domalowania. Apka nie musi nic wysyłać: maskę
 * wyliczamy z samego obrazu.
 */
export async function maskFromAlpha(buf: Buffer, width: number, height: number): Promise<Buffer> {
  // `gray1` dokłada na końcu `toColourspace('b-w')`, a sharp wykonuje konwersję przestrzeni PRZED
  // `extractChannel` — do wyciągania trafia więc obraz 2-pasmowy (szarość+alfa), nie 4-pasmowy.
  // Działa, bo sharp ma dla `extractChannel === 3` na obrazie z alfą specjalny przypadek: remapuje
  // indeks na ostatnie pasmo. Zachowanie nieudokumentowane — stąd asercja długości w `gray1`.
  const alpha = await gray1(sharp(buf).toColorspace('srgb').ensureAlpha().extractChannel(3), width * height);
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < out.length; i++) out[i] = (alpha[i] ?? 255) < ALPHA_HOLE ? 255 : 0;
  return out;
}

/**
 * Zmiękcza maskę pod kompozycję: najpierw ROZSZERZA ją (dilate), potem rozmywa krawędź (feather).
 *
 * Kolejność jest istotna. Samo rozmycie ustawiłoby gradient NA granicy zaznaczenia, czyli połowa
 * przejścia wypadłaby WEWNĄTRZ — przy fillu zostałby widoczny półprzezroczysty rant starej dziury,
 * a przy erase — obwódka usuwanego obiektu. Rozmycie + próg 1 rozdyma kształt o ~2.6σ, więc po
 * drugim rozmyciu całe przejście leży już POZA pierwotnym zaznaczeniem (łączny zasięg ≈ 5.2σ).
 *
 * ⚠️ KAŻDY etap to OSOBNE wywołanie sharpa, celowo. sharp wykonuje operacje w stałej kolejności
 * WEWNĘTRZNEJ, nie w kolejności wywołań: w łańcuchu `.blur(s).threshold(1)` próg leci PRZED rozmyciem,
 * więc binaryzacja trafiała w już binarną maskę i dylatacja po cichu nie robiła nic (maska zostawała
 * miękka, a środek zaznaczenia miał alfę ~40% → edycja nakładała się tylko częściowo).
 */
export async function softenMask(mask: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  const s = Math.max(MIN_SIGMA, sigma);
  const raw = rawGray(width, height);
  const px = width * height;
  const spread = await gray1(sharp(mask, raw).blur(s), px);            // rozlej kształt na zewnątrz…
  const dilated = await gray1(sharp(spread, raw).threshold(1), px);    // …i znów utwardź (= dilate ≈2.6σ)
  return gray1(sharp(dilated, raw).blur(s), px);                       // dopiero teraz miękka krawędź
}

/** Wycinek obrazu (PNG — bezstratnie, wynik idzie prosto do modelu). */
export function cropRegion(buf: Buffer, roi: Roi): Promise<Buffer> {
  return sharp(buf).extract(roi).png().toBuffer();
}

/**
 * Zalepia przezroczyste dziury kolorem NAJBLIŻSZEGO nieprzezroczystego piksela (BFS z całej krawędzi
 * dziury naraz = transformata odległości). Zwraca RGB bez alfy.
 *
 * PO CO: deAPI spłaszcza przezroczystość do CZARNEGO, więc model dostawał czarny kwadrat i grzecznie go
 * zachowywał — generative fill oddawał zdjęcie z czarnym rogiem. Podając zamiast dziury rozciągnięte
 * otoczenie, dajemy modelowi sensowny punkt wyjścia; a gdyby nawet nic z nim nie zrobił, w rogu jest
 * przedłużenie tła zamiast czerni.
 */
export function fillHolesNearest(rgba: Buffer, width: number, height: number): Buffer {
  const n = width * height;
  const out = Buffer.alloc(n * 3);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  for (let i = 0; i < n; i++) {
    if ((rgba[i * 4 + 3] ?? 0) < ALPHA_HOLE) continue;
    seen[i] = 1;
    queue[tail++] = i;
    out[i * 3] = rgba[i * 4] ?? 0;
    out[i * 3 + 1] = rgba[i * 4 + 1] ?? 0;
    out[i * 3 + 2] = rgba[i * 4 + 2] ?? 0;
  }
  if (tail === 0) return out; // wszystko przezroczyste — nie ma skąd wziąć koloru

  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const spread = (j: number) => {
      if (seen[j]) return;
      seen[j] = 1;
      out[j * 3] = out[i * 3] ?? 0;
      out[j * 3 + 1] = out[i * 3 + 1] ?? 0;
      out[j * 3 + 2] = out[i * 3 + 2] ?? 0;
      queue[tail++] = j;
    };
    if (x > 0) spread(i - 1);
    if (x < width - 1) spread(i + 1);
    if (i >= width) spread(i - width);
    if (i < n - width) spread(i + width);
  }
  return out;
}

/**
 * Wycinek gotowy dla modelu przy GENERATIVE FILL: dziury zalepione ([[fillHolesNearest]]) i dodatkowo
 * zmiękczone rozmyciem — samo rozciągnięcie sąsiada zostawia promieniste smugi. Rozmycie trafia WYŁĄCZNIE
 * w dziury; realna treść zdjęcia zostaje ostra, żeby model nie odwzorował rozmycia w wyniku.
 */
export async function prefillHoles(crop: Buffer, width: number, height: number, sigma: number): Promise<Buffer> {
  const raw3 = { raw: { width, height, channels: 3 as const } };
  const rgba = await sharp(crop).toColorspace('srgb').ensureAlpha().raw().toBuffer();
  if (rgba.length !== width * height * 4) throw new ProxyError('prefill: wycinek nie jest RGBA w oczekiwanym rozmiarze');
  const filled = fillHolesNearest(rgba, width, height);
  const smoothed = await sharp(filled, raw3).blur(Math.max(MIN_SIGMA, sigma)).toColorspace('srgb').removeAlpha().raw().toBuffer();
  if (smoothed.length !== filled.length) throw new ProxyError('prefill: nieoczekiwana liczba kanałów po rozmyciu');

  // podmiana pikseli wprost, bez alfa-kompozycji sharpa: rozmycie ma trafić TYLKO w dawne dziury,
  // a wynik musi wyjść bez kanału alfa (model dostaje wtedy zwykłe, nieprzezroczyste zdjęcie)
  for (let i = 0; i < width * height; i++) {
    if ((rgba[i * 4 + 3] ?? 255) >= ALPHA_HOLE) continue;
    filled[i * 3] = smoothed[i * 3] ?? 0;
    filled[i * 3 + 1] = smoothed[i * 3 + 1] ?? 0;
    filled[i * 3 + 2] = smoothed[i * 3 + 2] ?? 0;
  }
  return sharp(filled, raw3).png().toBuffer();
}

/**
 * Skaluje wycinek do `target` na dłuższym boku, jeśli jest mniejszy — modele generują wyraźnie lepiej
 * przy większym wejściu, a wynik i tak wracamy do rozmiaru wycinka przy kompozycji.
 */
export async function upscaleForModel(buf: Buffer, roi: Roi, target: number): Promise<Buffer> {
  const longest = Math.max(roi.width, roi.height);
  if (longest >= target) return buf;
  const k = target / longest;
  return sharp(buf)
    .resize(Math.round(roi.width * k), Math.round(roi.height * k), { fit: 'fill' })
    .png()
    .toBuffer();
}

export type Composed = { buffer: Buffer; mime: string };

/** Maks. korekta tonalna na kanał (±). Klamra: przy dziwnym wyniku modelu wolimy zostawić różnicę niż ją pogłębić. */
const MAX_TONE_SHIFT = 40;

/**
 * Dopasowuje TON wyniku modelu do oryginału — IN PLACE na buforze RGB wycinka.
 *
 * Po co: model regeneruje CAŁY wycinek, więc razem z treścią przesuwa globalną jasność/kolor. Po wklejeniu
 * przez maskę widać wtedy jaśniejszą (albo cieplejszą) łatę, mimo że sam szew jest rozmyty. Piksele wycinka
 * POZA maską to ten sam kadr w obu obrazach, więc różnica ich średnich to czysty dryf modelu — odejmujemy
 * go od całej łaty. Bez próbki (albo przy zbyt małej) nie robimy nic.
 */
function matchTone(edited: Buffer, original: Buffer, alpha: Buffer): void {
  let dr = 0, dg = 0, db = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] !== 0) continue; // liczymy TYLKO piksele w pełni „oryginalne" (poza rozmytą maską)
    const o = i * 3;
    dr += (original[o] ?? 0) - (edited[o] ?? 0);
    dg += (original[o + 1] ?? 0) - (edited[o + 1] ?? 0);
    db += (original[o + 2] ?? 0) - (edited[o + 2] ?? 0);
    n++;
  }
  if (n < 500) return; // za mała próbka, żeby ufać średniej
  const cap = (d: number) => Math.max(-MAX_TONE_SHIFT, Math.min(MAX_TONE_SHIFT, Math.round(d / n)));
  const sr = cap(dr), sg = cap(dg), sb = cap(db);
  if (sr === 0 && sg === 0 && sb === 0) return;
  const fit = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < edited.length; i += 3) {
    edited[i] = fit((edited[i] ?? 0) + sr);
    edited[i + 1] = fit((edited[i + 1] ?? 0) + sg);
    edited[i + 2] = fit((edited[i + 2] ?? 0) + sb);
  }
}

/**
 * Wkleja `edited` w obszar `roi` oryginału przez miękką maskę `mask` (pełny rozmiar obrazu).
 * Poza rozmytą maską piksele pochodzą wyłącznie z oryginału — nic z wyniku modelu tam nie dociera.
 *
 * Wyjście: JPEG. PNG dla zdjęcia 1536 px to ~5 MB, a odpowiedź wraca do telefonu jako base64 (×1.37) —
 * JPEG 92/4:4:4 daje wizualnie to samo przy ~10× mniejszym transferze. Przezroczystości nie tracimy,
 * bo jedyna trasa z alfą (remove-background) nie przechodzi przez kompozycję.
 * Cena: całość jest przekodowywana, więc „nietknięte" piksele niosą szum JPEG-a (zmierzone: średnio
 * 0.5/255, maks. ~36 na ostrych krawędziach). Przy edycji łańcuchowej to zbiega, a nie narasta.
 */
export async function compositeThroughMask(
  original: Buffer,
  edited: Buffer,
  mask: Buffer,
  size: { width: number; height: number },
  roi: Roi,
): Promise<Composed> {
  const alpha = await gray1(sharp(mask, rawGray(size.width, size.height)).extract(roi), roi.width * roi.height);
  // wynik modelu bywa „przyciągnięty" do wielokrotności 8/16 px → przywróć dokładny rozmiar wycinka
  const rgb = await sharp(edited)
    .resize(roi.width, roi.height, { fit: 'fill' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer();
  const origRoi = await sharp(original).extract(roi).toColorspace('srgb').removeAlpha().raw().toBuffer();
  matchTone(rgb, origRoi, alpha);
  const patch = await sharp(rgb, { raw: { width: roi.width, height: roi.height, channels: 3 } })
    .joinChannel(alpha, rawGray(roi.width, roi.height))
    .png()
    .toBuffer();
  const buffer = await sharp(original)
    .composite([{ input: patch, left: roi.left, top: roi.top }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { buffer, mime: 'image/jpeg' };
}

/** Oryginał bez zmian, ale w formacie odpowiedzi (np. FILL bez dziur do wypełnienia). */
export async function passthroughJpeg(buf: Buffer): Promise<Composed> {
  return { buffer: await sharp(buf).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' };
}
