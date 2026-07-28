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
import { RecordKey, ScreenKey, KeyVariant } from './KeyButton';
import type { KeyIconName } from '../icons/keyIcons.gen';
import { Joystick, JoystickConfig } from './Joystick';

/** Definicja klawisza "screen" (krawędzie). Pusty label = klawisz bez treści (widmo). */
export type ScreenKeyDef = {
  label: string;
  supporting?: string;
  variant?: KeyVariant;
  /** Jawna ikona (tryb KEY ICONS) — nadpisuje mapę label→ikona; np. SIZE zależnie od liczby kolumn. */
  icon?: KeyIconName;
  onPress?: () => void;
  onLongPress?: () => void;
  onHoldComplete?: () => void;
  onHoldStart?: () => void;
  onHoldCancel?: () => void;
  holdMs?: number;
  progress?: number;
};
/** Definicja klawisza "metal" (wewnątrz, PREV/NEXT): etykietowany albo record/shutter. */
export type MetalKeyDef =
  | { type: 'label'; upper: string; lower?: string; active?: boolean; lowerActive?: boolean; variant?: KeyVariant; icon?: KeyIconName; onPress?: () => void }
  | { type: 'record'; onPress?: () => void };

/**
 * Pełny układ klawiatury: 2 klawisze "screen" (krawędzie), 2 "metal" (wewnątrz), joystick (środek).
 * screen[0]/metal[0] po lewej, metal[1]/screen[1] po prawej.
 */
export type KeyboardConfig = { screen: ScreenKeyDef[]; metal: MetalKeyDef[]; joystick?: JoystickConfig };

const EMPTY_KEYBOARD: KeyboardConfig = { screen: [], metal: [] };

function MetalKey({ def, icons }: { def?: MetalKeyDef; icons?: boolean }) {
  if (!def) return <View style={{ width: dims.key.size, height: dims.key.size }} />;
  if (def.type === 'record') return <RecordKey onPress={def.onPress} />;
  // Klawisze wewnętrzne (poz. 2 i 4, dawniej metalowe PREV/NEXT/ROTATE) renderujemy jako "screen"
  // — ciemna szyba + matryca + phosphor — zachowując dotychczasowy label. `active:false` → wygaszony.
  return (
    <ScreenKey
      label={def.upper}
      supporting={def.lower}
      variant={def.variant}
      active={def.active}
      icons={icons}
      icon={def.icon}
      onPress={def.active === false ? undefined : def.onPress}
    />
  );
}

function ScreenSlot({ def, icons }: { def?: ScreenKeyDef; icons?: boolean }) {
  if (!def) return <View style={{ width: dims.key.size, height: dims.key.size }} />;
  return (
    <ScreenKey
      label={def.label}
      supporting={def.supporting}
      variant={def.variant}
      icon={def.icon}
      onPress={def.onPress}
      onLongPress={def.onLongPress}
      onHoldComplete={def.onHoldComplete}
      onHoldStart={def.onHoldStart}
      onHoldCancel={def.onHoldCancel}
      holdMs={def.holdMs}
      progress={def.progress}
      icons={icons}
    />
  );
}

export function Keyboard({ config = EMPTY_KEYBOARD, keyIcons }: { config?: KeyboardConfig; keyIcons?: boolean }) {
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
        <ScreenSlot key={`s0:${screen[0]?.label ?? ''}`} def={screen[0]} icons={keyIcons} />
        <MetalKey key="m0" def={metal[0]} icons={keyIcons} />
        <Joystick config={joystick} />
        <MetalKey key="m1" def={metal[1]} icons={keyIcons} />
        <ScreenSlot key={`s1:${screen[1]?.label ?? ''}`} def={screen[1]} icons={keyIcons} />
      </Bevel>
    </View>
  );
}
