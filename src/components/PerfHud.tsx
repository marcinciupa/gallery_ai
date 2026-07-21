/**
 * PerfHud — nakładka diagnostyczna FPS (wątek JS, mierzony przez requestAnimationFrame). Widoczna też
 * w release (włączana z Settings → PERF HUD). Służy do rozstrzygnięcia natury janku:
 *   • JS FPS spada podczas zacięcia → wąskie gardło na wątku JS (GC / animacje non-native / re-rendery)
 *   • JS FPS trzyma ~60, a i tak tnie → wątek UI/GPU (kompozycja/paint)
 * `rAF` w RN biegnie na wątku JS, więc ten licznik mierzy zdrowie JS. Do usunięcia po diagnozie.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { font } from '../theme/tokens';

// Licznik re-renderów: App woła renderTicker.n++ w każdym renderze; HUD liczy renders/sekundę.
// R ~0 w bezczynności = brak pętli; R wysoki bez dotyku = ukryta pętla re-renderów.
export const renderTicker = { n: 0 };

// ZNACZNIK CZASU ostatniego zdarzenia scrolla (ms) — ustawiany przez FeedGrid/GalleryScreen w `onScroll`.
// Minimum zatrzaskujemy tylko wtedy, gdy przewijanie było świeżo, bo panel LTPO przy nieruchomym ekranie
// schodzi do ~24 Hz i bez tego każda przerwa na spojrzenie w licznik zatrzaskiwała 24 jako „dip"
// (to oszczędzanie baterii, nie zacięcie).
//
// Świadomie NIE jest to flaga włącz/wyłącz: parowanie „start → stop" ma za dużo ścieżek (drag, momentum,
// timer awaryjny, scroll programowy) i wystarczyło, że jedna nie trafiła, a minimum nie zapisywało się
// NIGDY (HUD pokazywał „-"). Znacznik czasu sam się zeruje i nie da się go zostawić w złym stanie.
export const scrollFlag = { at: 0 };
const SCROLL_FRESH_MS = 400;

export function PerfHud() {
  const [fps, setFps] = useState(0);
  // `lo` = minimum OD OSTATNIEGO RESETU (TAP w HUD), nie od montażu komponentu.
  // Wcześniej było `useState(99)` + `Math.min(l, f)` bez resetu — przez co (a) „99" nie było pomiarem,
  // tylko nigdy niepobitą wartością startową, a (b) zacięcie przy STARCIE APKI zatruwało odczyt do końca
  // sesji i mieszało się z pomiarem scrolla. Teraz: zeruj przed testem, przewijaj, odczytaj najgorszy dip
  // dokładnie z tego okresu — dzięki temu pomiary między buildami są porównywalne.
  const [lo, setLo] = useState(0);
  const [rps, setRps] = useState(0);
  const minRef = useRef(Infinity);
  const reset = () => { minRef.current = Infinity; setLo(0); setRps(0); };

  useEffect(() => {
    let raf = 0;
    let last = 0;
    let frames = 0;
    let acc = 0;
    let lastRenders = renderTicker.n;
    let mounted = true;
    const loop = (t: number) => {
      if (last) {
        acc += t - last;
        frames++;
        if (acc >= 500) {
          const f = Math.round((frames * 1000) / acc);
          setFps(f);
          const fresh = Date.now() - scrollFlag.at < SCROLL_FRESH_MS;
          if (fresh && f < minRef.current) minRef.current = f;
          // 0 = „brak pomiaru" (HUD pokazuje „-"). NIE przepuszczaj `Infinity` do stanu: minRef startuje
          // z Infinity i dopóki nie było przewijania, wyświetlałoby się dosłowne „min Infinity".
          setLo(Number.isFinite(minRef.current) ? minRef.current : 0);
          const r = Math.round(((renderTicker.n - lastRenders) * 1000) / acc);
          setRps(r);
          lastRenders = renderTicker.n;
          frames = 0;
          acc = 0;
        }
      }
      last = t;
      if (mounted) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { mounted = false; cancelAnimationFrame(raf); };
  }, []);

  return (
    // TAP = reset minimum (bez tego dip z uruchamiania apki zostawał w odczycie na zawsze).
    // Stąd BRAK `pointerEvents="none"` — HUD musi łapać dotyk. Hitbox jest mały i leży nad chromem.
    <Pressable
      onPress={reset}
      hitSlop={8}
      style={{ position: 'absolute', top: 48, left: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, zIndex: 9999 } as any}
    >
      <Text style={{ color: '#E2FFE4', fontFamily: font.monoLabel.family, fontSize: 12 }}>{`JS ${fps} · min ${lo || '-'} · R ${rps}/s`}</Text>
    </Pressable>
  );
}
