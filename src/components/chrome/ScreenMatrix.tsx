/**
 * ScreenMatrix — nakładka „matryca ekranu" (Figma warstwa „matrix"): kafelkowany PNG symulujący
 * siatkę pikseli wyświetlacza. Tekstura ma alfę (ciemne piksele ~10–25% + przezroczyste oczka),
 * nakładana zwykłym alpha (bez blendingu). Renderowana MIĘDZY treścią a połyskiem/glow.
 *
 * WYDAJNOŚĆ (kluczowe): `resizeMode="repeat"` mapuje się na Skia `TileMode.REPEAT` (BitmapShader,
 * patrz RN `ImageResizeMode.kt`), więc koszt = liczba wypełnianych pikseli, czyli POWIERZCHNIA
 * warstwy. Liczba kafli mieszczących się w tej powierzchni jest dla GPU obojętna — shader liczy
 * zawinięte UV per piksel, nie „stempluje" kafli. Dlatego warstwa MUSI mieć dokładnie 100%×100%.
 * Historycznie było odwrotnie: warstwę powiększano do 100/SCALE %, żeby potem zjechać ją
 * `transform: scale(SCALE)` i w ten sposób zmniejszyć kafel. Przy SCALE=0.25 dawało to 400%×400%
 * = 16× powierzchnia ekranu i było PRAWDZIWĄ przyczyną wielodniowego janku galerii (2026-07-02);
 * SCALE=0.5 (4× ekran) tylko to łagodziło. Obecne 1:1 usuwa problem u źródła. NIE przywracać
 * transformu ani warstwy większej niż 100%.
 *
 * GĘSTOŚĆ kropek reguluj WYŁĄCZNIE rozmiarem tekstury: 1 px PNG = 1 dp przy skali 1. Kafel 2 dp =
 * PNG 2×2 (kwadrant 1 px), warianty @2x 4×4, @3x 6×6, @4x 8×8. Chcesz drobniejsze kropki — zmniejsz
 * PNG, nie kombinuj ze skalą.
 *
 * ⚠️ Wariant @4x MUSI istnieć. Metro mapuje skale na kubełki gęstości Androida (patrz
 * `@react-native/community-cli-plugin/.../assetPathUtils.js`): 1→mdpi, 2→xhdpi, 3→xxhdpi, 4→xxxhdpi.
 * Bez @4x urządzenia xxxhdpi (np. S25 Ultra) biorą xxhdpi i doskalowują go w górę → kafel rośnie,
 * a wzór wygląda 2× rzadziej. Zdiagnozowane na urządzeniu 2026-07-21.
 *
 * WZÓR (Figma „pattern_1", node 472:16254): 2×2 kwadranty, RGB 14,13,11, alfy .25 / .1 / .1 / 0
 * (kolejno TL, TR, BL, BR). PNG generowane PROCEDURALNIE z tych wartości — NIE eksportem z Figmy,
 * bo frame ma fill #FFFFFF, który wkleiłby się pod półprzezroczyste kwadranty i zabił alfę.
 *
 * Rounded-clip pominięty — szyba (rodzic) i tak przycina do zaokrąglonych rogów.
 */
import { Image, View } from 'react-native';

const MATRIX = require('../../../assets/figma/screen_matrix.png');

// Wrapper istnieje TYLKO dla `pointerEvents="none"` — nakładka leży nad treścią, więc bez tego
// przechwytywałaby dotyk. Ani <Image>, ani ImageStyle nie przyjmują tego propa (RN 0.85).
//
// ⚠️ `width/height: '100%'` MUSZĄ być jawne. Insety (`top/left/right/bottom: 0`, czyli absoluteFill)
// NIE nadają rozmiaru temu <Image> — spada wtedy do wymiaru własnego tekstury (12×12) i `repeat`
// kafelkuje tylko malutki prostokąt w lewym górnym rogu zamiast całego ekranu. Zweryfikowane na
// urządzeniu buildem diagnostycznym (2026-07-21): matryca zniknęła dokładnie z tego powodu.
export function ScreenMatrix(_props: { radius?: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <Image
        source={MATRIX}
        resizeMode="repeat"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      />
    </View>
  );
}
