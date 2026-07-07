/**
 * Keyboard — klawiatura galerii: JEDEN rząd × 5 slotów (rozjazd vs rec_ai 2×3):
 *   [ screen[0] · metal[0] · JOYSTICK · metal[1] · screen[1] ]
 * czyli w Figmie: BUTTON_1 · PREV · JOYSTICK · NEXT · BUTTON_2. Krawędzie to klawisze „screen"
 * (ciemna szyba), wewnątrz metalowe (PREV/NEXT), a środek zajmuje nowy joystick (§ Joystick.tsx),
 * który zastąpił shuttle/slider z rec_ai. KONTEKSTOWA: układ zależny od ekranu (`config`).
 */
import { ReactNode } from 'react';
import { View } from 'react-native';
import { dims, gradient } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';
import { Bevel } from './primitives';
import { MetalLabelKey, RecordKey, ScreenKey, KeyVariant } from './KeyButton';
import { Joystick, JoystickConfig } from './Joystick';

/** Definicja klawisza "screen" (krawędzie). Pusty label = klawisz bez treści (widmo). */
export type ScreenKeyDef = {
  label: string;
  supporting?: string;
  variant?: KeyVariant;
  onPress?: () => void;
  onLongPress?: () => void;
  onHoldComplete?: () => void;
  onHoldStart?: () => void;
  holdMs?: number;
  progress?: number;
};
/** Definicja klawisza "metal" (wewnątrz, PREV/NEXT): etykietowany albo record/shutter. */
export type MetalKeyDef =
  | { type: 'label'; upper: string; lower?: string; active?: boolean; lowerActive?: boolean; onPress?: () => void }
  | { type: 'record'; onPress?: () => void };

/**
 * Pełny układ klawiatury: 2 klawisze "screen" (krawędzie), 2 "metal" (wewnątrz), joystick (środek).
 * screen[0]/metal[0] po lewej, metal[1]/screen[1] po prawej.
 */
export type KeyboardConfig = { screen: ScreenKeyDef[]; metal: MetalKeyDef[]; joystick?: JoystickConfig };

const EMPTY_KEYBOARD: KeyboardConfig = { screen: [], metal: [] };

function MetalKey({ def }: { def?: MetalKeyDef }) {
  if (!def) return <View style={{ width: dims.key.size, height: dims.key.size }} />;
  if (def.type === 'record') return <RecordKey onPress={def.onPress} />;
  return (
    <MetalLabelKey upper={def.upper} lower={def.lower} active={def.active} lowerActive={def.lowerActive} onPress={def.onPress} />
  );
}

function ScreenSlot({ def }: { def?: ScreenKeyDef }) {
  if (!def) return <View style={{ width: dims.key.size, height: dims.key.size }} />;
  return (
    <ScreenKey
      label={def.label}
      supporting={def.supporting}
      variant={def.variant}
      onPress={def.onPress}
      onLongPress={def.onLongPress}
      onHoldComplete={def.onHoldComplete}
      onHoldStart={def.onHoldStart}
      holdMs={def.holdMs}
      progress={def.progress}
    />
  );
}

export function Keyboard({ config = EMPTY_KEYBOARD }: { config?: KeyboardConfig }) {
  const t = useTheme();
  const { screen, metal, joystick } = config;
  return (
    <View
      style={{
        height: dims.keyboardAreaHeight,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Bevel
        stroke={t.recessedBevel}
        width={1}
        radius={dims.keyboard.radius}
        fillGradient={gradient.keyboard}
        // +1px na obramowania 0.5px (box-border), żeby 5×64 + przerwy zmieściły się bez zawijania
        style={{ width: dims.keyboard.width + 1, height: dims.keyboard.height + 1 }}
        innerStyle={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: dims.keyboard.gap,
          padding: dims.keyboard.padding,
        }}
      >
        {/* key = pozycja+label: zmiana klawisza w slocie REMONTUJE go → cleanup czyści hold-timer */}
        <ScreenSlot key={`s0:${screen[0]?.label ?? ''}`} def={screen[0]} />
        <MetalKey key="m0" def={metal[0]} />
        <Joystick config={joystick} />
        <MetalKey key="m1" def={metal[1]} />
        <ScreenSlot key={`s1:${screen[1]?.label ?? ''}`} def={screen[1]} />
      </Bevel>
    </View>
  );
}
