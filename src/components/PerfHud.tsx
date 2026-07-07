/**
 * PerfHud — nakładka diagnostyczna FPS (wątek JS, mierzony przez requestAnimationFrame). Widoczna też
 * w release (włączana z Settings → PERF HUD). Służy do rozstrzygnięcia natury janku:
 *   • JS FPS spada podczas zacięcia → wąskie gardło na wątku JS (GC / animacje non-native / re-rendery)
 *   • JS FPS trzyma ~60, a i tak tnie → wątek UI/GPU (kompozycja/paint)
 * `rAF` w RN biegnie na wątku JS, więc ten licznik mierzy zdrowie JS. Do usunięcia po diagnozie.
 */
import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { font } from '../theme/tokens';

// Licznik re-renderów: App woła renderTicker.n++ w każdym renderze; HUD liczy renders/sekundę.
// R ~0 w bezczynności = brak pętli; R wysoki bez dotyku = ukryta pętla re-renderów.
export const renderTicker = { n: 0 };

export function PerfHud() {
  const [fps, setFps] = useState(0);
  const [lo, setLo] = useState(99);
  const [rps, setRps] = useState(0);

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
          setLo((l) => Math.min(l, f));
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
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: 48, left: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, zIndex: 9999 } as any}
    >
      <Text style={{ color: '#E2FFE4', fontFamily: font.monoLabel.family, fontSize: 12 }}>{`JS ${fps} · min ${lo} · R ${rps}/s`}</Text>
    </View>
  );
}
