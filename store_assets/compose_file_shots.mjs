// Przycina SUROWE zrzuty z urządzenia (1080x2400) do formatu Google Play 1080x1920 (9:16).
// Bez napisów i ozdobników — czysty ekran apki. Pasek stanu i pasek gestów Androida odcięte,
// reszta skalowana w całości (nic z UI nie ginie), boki dopełnione kolorem obudowy apki.
//   node store_assets/compose_file_shots.mjs <katalog-ze-zrzutami-adb>
import sharp from '../server/node_modules/sharp/lib/index.js';
import path from 'node:path';

const RAW = process.argv[2];
if (!RAW) { console.error('podaj katalog ze zrzutami z adb'); process.exit(1); }

const W = 1080, H = 1920;
const CROP_TOP = 96, CROP_BOTTOM = 34;   // pasek stanu / pasek gestów Androida

const SHOTS = ['s11.png', 's12.png', 's16.png', 's07.png', 's15.png'];

for (let i = 0; i < SHOTS.length; i++) {
  const src = sharp(path.join(RAW, SHOTS[i]));
  const meta = await src.metadata();
  const body = await src
    .extract({ left: 0, top: CROP_TOP, width: meta.width, height: meta.height - CROP_TOP - CROP_BOTTOM })
    .resize({ height: H, fit: 'inside' })
    .toBuffer();
  const bm = await sharp(body).metadata();
  // kolor tła bierzemy z samego zrzutu (obudowa apki), żeby dopełnienie było niewidoczne
  const px = await sharp(body).extract({ left: 2, top: Math.round(bm.height / 2), width: 1, height: 1 })
    .raw().toBuffer();
  const out = `store_assets/screenshot_files_${i + 1}_1080x1920.png`;
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: px[0], g: px[1], b: px[2] } } })
    .composite([{ input: body, left: Math.round((W - bm.width) / 2), top: 0 }])
    .png()
    .toFile(out);
  console.log(out, `${bm.width}x${bm.height} tło rgb(${px[0]},${px[1]},${px[2]})`);
}
