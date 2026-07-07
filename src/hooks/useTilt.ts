/**
 * useTilt — znormalizowane przechylenie urządzenia (-1..1) dla efektu parallax.
 * Natywnie: akcelerometr (expo-sensors, ~30 Hz). Web: fallback na pozycję myszy
 * (żeby dało się testować w podglądzie). Gdy `enabled=false` — brak subskrypcji,
 * wartości wracają do 0 (zero kosztu sensora/baterii).
 */
import { useEffect, useRef } from 'react';
import { Animated, Platform, AppState } from 'react-native';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function useTilt(enabled: boolean) {
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!enabled) {
      // useNativeDriver: false ŚWIADOMIE — tx/ty są karmione przez setValue (JS) i wpięte w JS-driven
      // style (translateX/opacity) u konsumentów; native driver na tej samej wartości nie zadziała (reset
      // by nie wrócił do środka — parallax zamarzłby na ostatnim przechyle).
      Animated.timing(tx, { toValue: 0, duration: 200, useNativeDriver: false }).start();
      Animated.timing(ty, { toValue: 0, duration: 200, useNativeDriver: false }).start();
      return;
    }

    if (Platform.OS === 'web') {
      const onMove = (e: PointerEvent) => {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = (e.clientY / window.innerHeight) * 2 - 1;
        Animated.timing(tx, { toValue: clamp(nx, -1, 1), duration: 120, useNativeDriver: false }).start();
        Animated.timing(ty, { toValue: clamp(ny, -1, 1), duration: 120, useNativeDriver: false }).start();
      };
      window.addEventListener('pointermove', onMove);
      return () => window.removeEventListener('pointermove', onMove);
    }

    // natywnie: akcelerometr, z pauzą gdy apka w tle (oszczędność baterii)
    let sub: { remove: () => void } | null = null;
    let appSub: { remove: () => void } | null = null;
    // lazy import — expo-sensors nie jest ładowany na web
    const { Accelerometer } = require('expo-sensors');

    const start = () => {
      Accelerometer.setUpdateInterval(50); // ~20 Hz wystarcza do parallaxu; mniej fan-outu po JS niż 30 Hz
      sub = Accelerometer.addListener(({ x, y }: { x: number; y: number }) => {
        // x: przechylenie lewo/prawo, y: przód/tył (odwrócone, by parallax był „naturalny")
        tx.setValue(clamp(x, -1, 1));
        ty.setValue(clamp(-y, -1, 1));
      });
    };
    start();
    appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') start();
      else {
        sub?.remove();
        sub = null;
      }
    });

    return () => {
      sub?.remove();
      appSub?.remove();
    };
  }, [enabled, tx, ty]);

  return { tx, ty };
}
