/**
 * Joystick — NOWY element galerii (Figma node 350:4682), środek klawiatury. Zastępuje shuttle/slider
 * z rec_ai jako główna kontrolka nawigacji. Fizycznie: metalowy kwadrat 64 (wypukły bevel) → wklęsła
 * ciemna studnia 56 → wypukły metalowy grzybek 24 (przesuwa się za palcem, sprężynuje na środek).
 *
 * Sterowanie 4-kierunkowe (discrete, jak knob dyskretny w Settings): po przekroczeniu progu wychylenia
 * odpala JEDEN raz onUp/onDown/onLeft/onRight (dominująca oś), środek (tap bez wychylenia) = onPress.
 * Haptyka z Warstwy 0 (§9): hapticKnob na tick kierunku, hapticKnobReturn na powrót, hapticPress/Release
 * na środek.
 */
import { useRef } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import { dims, gradient } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { Bevel } from './primitives';
import { shadow, elevationShadow } from '../../theme/tokens';
import { hapticKnob, hapticKnobReturn, hapticPress, hapticRelease, hapticShort } from '../../lib/haptics';

/** Konfiguracja joysticka dla danego ekranu (kontekstowa jak KeyboardConfig/SliderConfig). */
export type JoystickConfig = {
  highlighted?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onPress?: () => void; // wciśnięcie środka
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function Joystick({ config }: { config?: JoystickConfig }) {
  const t = useTheme();
  const cfgRef = useRef(config);
  cfgRef.current = config;

  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const fired = useRef(false);

  const springBack = () => {
    Animated.spring(tx, { toValue: 0, useNativeDriver: false }).start();
    Animated.spring(ty, { toValue: 0, useNativeDriver: false }).start();
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.hypot(g.dx, g.dy) > 3,
      // nie oddawaj gestu innym responderom (np. ekranowemu swipe) — inaczej poziome ruchy joysticka giną
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        fired.current = false;
        const c = cfgRef.current;
        const hasAny = !!(c && (c.onUp || c.onDown || c.onLeft || c.onRight || c.onPress));
        hasAny ? hapticPress() : hapticShort();
      },
      onPanResponderMove: (_e, g) => {
        const max = dims.joystick.nubTravel;
        tx.setValue(clamp(g.dx, -max, max));
        ty.setValue(clamp(g.dy, -max, max));
        if (fired.current) return;
        const th = dims.joystick.dirThreshold;
        if (Math.abs(g.dx) > th || Math.abs(g.dy) > th) {
          fired.current = true;
          const c = cfgRef.current;
          // dominująca oś decyduje o kierunku (4-kier., bez skosów)
          if (Math.abs(g.dx) >= Math.abs(g.dy)) (g.dx > 0 ? c?.onRight : c?.onLeft)?.();
          else (g.dy > 0 ? c?.onDown : c?.onUp)?.();
          hapticKnob(0.5); // krótki impuls na zmianie (jak knob discrete)
        }
      },
      onPanResponderRelease: (_e, g) => {
        springBack();
        const moved = Math.hypot(g.dx, g.dy);
        const c = cfgRef.current;
        if (!fired.current && moved < 6) {
          // brak wychylenia → wciśnięcie środka
          c?.onPress?.();
          hapticRelease();
        } else {
          hapticKnobReturn(!!c?.highlighted);
        }
        fired.current = false;
      },
      onPanResponderTerminate: () => {
        springBack();
        fired.current = false;
      },
    })
  ).current;

  const hl = config?.highlighted;
  const rec = t.recessedBevel;
  return (
    // outer: metalowy kwadrat 64 (wypukły bevel)
    <Bevel
      stroke={t.raisedBevel}
      width={1}
      radius={dims.key.radius}
      fill={t.metal}
      style={{ width: dims.joystick.size, height: dims.joystick.size }}
      innerStyle={{ alignItems: 'center', justifyContent: 'center' }}
    >
      <View {...pan.panHandlers} style={{ padding: dims.joystick.wellOffset }}>
        {/* studnia: wklęsła ciemna kołowa wnęka (recessed bevel + inset shadow). Plain View (bez overflow
            hidden Bevela), żeby wypukły cień grzybka się nie obciął. */}
        <View
          style={
            {
              width: dims.joystick.well,
              height: dims.joystick.well,
              borderRadius: dims.joystick.wellRadius,
              backgroundColor: '#1A1A1A',
              borderTopWidth: 1,
              borderLeftWidth: 1,
              borderBottomWidth: 1,
              borderRightWidth: 1,
              borderTopColor: rec.colors[0], // recessed: cień góra+lewo
              borderLeftColor: rec.colors[0],
              borderBottomColor: rec.colors[1], // światło dół+prawo
              borderRightColor: rec.colors[1],
              boxShadow: shadow.keyInsetReduction,
              alignItems: 'center',
              justifyContent: 'center',
            } as any
          }
        >
          {/* grzybek: wypukły metalowy dysk 24, przesuwa się za palcem */}
          <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }] }}>
            <Bevel
              stroke={t.raisedBevel}
              width={1}
              radius={dims.joystick.nub / 2}
              fillGradient={hl ? gradient.bevelButton : gradient.bevelSharp}
              style={{ width: dims.joystick.nub, height: dims.joystick.nub, boxShadow: elevationShadow(t) }}
            />
          </Animated.View>
        </View>
      </View>
    </Bevel>
  );
}
