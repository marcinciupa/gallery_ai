/**
 * ScreenMatrix — nakładka „matryca ekranu" (Figma warstwa „matrix"): kafelkowany PNG symulujący
 * siatkę pikseli wyświetlacza. Tekstura ma alfę (ciemne piksele ~10–25% + przezroczyste oczka),
 * nakładana zwykłym alpha (bez blendingu). Renderowana MIĘDZY treścią a połyskiem/glow.
 *
 * WYDAJNOŚĆ (kluczowe): koszt `resizeMode="repeat"` skaluje się z POWIERZCHNIĄ warstwy = 100/SCALE %.
 * Kafel docelowy = (natywny PNG px) × SCALE. Przy SCALE=0.25 warstwa miała 400%×400% = 16× ekran →
 * Android re-kafelkował ją przy każdej rekompozycji (scroll gęstej siatki) = jank. SCALE=0.5 → 200%×200%
 * = 4× ekran (4× taniej). GĘSTOŚĆ kropek jest sprzężona ze SCALE, a SCALE ze SCALĄ powierzchni — dlatego
 * „2× gęściej" NIE robimy przez zejście SCALE (wróciłby jank), tylko przez ZMNIEJSZENIE natywnej tekstury:
 * PNG 8×8 (był 16×16, ten sam wzór 2×2 kwadrantów) + SCALE=0.5 → kafel 4px, powierzchnia repeat bez zmian.
 * Rounded-clip pominięty — szyba (rodzic) już przycina do zaokrąglonych rogów, wystarczy tani overflow.
 */
import { Image, View } from 'react-native';

const MATRIX = require('../../../assets/figma/screen_matrix.png');
const SCALE = 0.5; // PNG 8×8 → kafel 4px; powierzchnia repeat = 200%×200% (4× ekran), jak przy 8px

export function ScreenMatrix(_props: { radius?: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden' }}>
      <Image
        source={MATRIX}
        resizeMode="repeat"
        style={{ position: 'absolute', top: 0, left: 0, width: `${100 / SCALE}%`, height: `${100 / SCALE}%`, transform: [{ scale: SCALE }], transformOrigin: 'top left' } as any}
      />
    </View>
  );
}
