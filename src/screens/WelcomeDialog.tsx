/**
 * WelcomeDialog — onboarding pierwszego uruchomienia (à la rec_ai). Ustawia domyślne: THEME / FULLSCREEN /
 * SCREEN (tryb wyświetlania) / LEFT-HANDED MODE. Steruje TYMI SAMYMI ustawieniami co ekran Settings
 * (optionOf/optionsOf/cycleByLabel) → zmiany trwałe, podgląd na żywo (motyw/fullscreen obudowy za nakładką).
 *
 * Nakładka renderowana W SLOCIE EKRANU obudowy (DeviceShell child), wyśrodkowana — NIE zasłania klawiszy/joysticka
 * pod obudową (inaczej nie dało się przejść onboardingu).
 *
 * Nawigacja (klawiatura gallery: 2 screen + 2 metal + joystick): joystick ▲/▼ = zaznaczenie, press = zmiana wartości;
 * screen[0] = CHANGE (kontekstowy, pokazuje wartość na którą przełączy), screen[1] = START (kończy onboarding).
 */
import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { color, font, screen, textShadow } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';

const glow = { textShadowColor: textShadow.phosphor.color, textShadowRadius: textShadow.phosphor.radius, textShadowOffset: { width: 0, height: 0 } } as const;

// wiersze welcome → klucz ustawienia (label z Settings) + etykieta
const WELCOME_ROWS: { key: string; label: string }[] = [
  { key: 'THEME', label: 'THEME' },
  { key: 'FULLSCREEN', label: 'FULLSCREEN' },
  { key: 'SCREEN', label: 'SCREEN MODE' },
  { key: 'LEFT-HANDED MODE', label: 'LEFT-HANDED' },
];
// długie wartości łamane na klawiszu
const KEY_WRAP: Record<string, string> = { FULLSCREEN: 'FULL-\nSCREEN', IMMERSIVE: 'IMMER-\nSIVE' };

/** Wiersz wyboru: etykieta z lewej, wartość z prawej. Zaznaczony = tło phosphor + ciemny tekst (jak Settings). */
function PickRow({ label, value, selected, onPress }: { label: string; value: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', gap: 16, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 2, backgroundColor: selected ? screen.olive.primary : 'transparent' }}
    >
      <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: selected ? color.dark21 : screen.olive.secondary }}>{label}</Text>
      <Text style={{ fontFamily: font.monoHeading.family, fontSize: font.monoHeading.size, color: selected ? color.dark21 : screen.olive.primary, ...(selected ? null : glow) }}>{value}</Text>
    </Pressable>
  );
}

export function useWelcomeDialog({
  optionOf,
  optionsOf,
  cycleByLabel,
  onFinish,
}: {
  optionOf: (label: string) => string;
  optionsOf: (label: string) => string[];
  cycleByLabel: (label: string) => void;
  onFinish: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const move = (d: -1 | 1) => setSelected((i) => (i + d + WELCOME_ROWS.length) % WELCOME_ROWS.length);
  const tapRow = (i: number) => { setSelected(i); cycleByLabel(WELCOME_ROWS[i].key); };
  const changeSel = () => cycleByLabel(WELCOME_ROWS[selected].key);

  // kontekstowy klawisz #1 = wartość, NA KTÓRĄ przełączymy zaznaczony wiersz (jak w Settings)
  const curKey = WELCOME_ROWS[selected].key;
  const opts = optionsOf(curKey);
  const nextVal = opts.length ? opts[(opts.indexOf(optionOf(curKey)) + 1) % opts.length] : '';
  const key1Label = KEY_WRAP[nextVal] ?? nextVal;

  const keyboard: KeyboardConfig = {
    screen: [
      { label: key1Label, supporting: opts.length > 2 ? '[CYCLE]' : undefined, variant: 'primary', onPress: changeSel },
      { label: 'START', variant: 'primary', onPress: onFinish },
    ],
    metal: [{ type: 'label', upper: '' }, { type: 'label', upper: '' }],
    joystick: { highlighted: true, onUp: () => move(-1), onDown: () => move(1), onPress: changeSel },
  };

  // Overlay w slocie ekranu (wyśrodkowany). Renderowany jako DeviceShell child — nie zasłania klawiatury.
  const overlay = (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <View style={{ alignSelf: 'stretch', maxWidth: 360, backgroundColor: color.dark1A, borderWidth: 1, borderColor: screen.olive.primary, borderRadius: 4, padding: 16, gap: 6, boxShadow: '0px 0px 8px 0px rgba(226,255,228,0.25)' } as any}>
        <Text style={{ fontFamily: font.monoHeading.family, fontSize: font.monoHeading.size, color: screen.olive.primary, textAlign: 'center', ...glow }}>WELCOME TO GALLERY AI</Text>
        <Text style={{ fontFamily: font.caption.family, fontSize: font.caption.size, color: screen.olive.secondary, textAlign: 'center' }}>SET YOUR DEFAULTS</Text>
        {WELCOME_ROWS.map((r, i) => (
          <PickRow key={r.key} label={r.label} value={optionOf(r.key)} selected={i === selected} onPress={() => tapRow(i)} />
        ))}
        <Text style={{ fontFamily: font.caption.family, fontSize: font.caption.size, color: screen.olive.secondary, textAlign: 'center', marginTop: 4, ...glow }}>CHANGE TO EDIT · START TO CONTINUE</Text>
      </View>
    </View>
  );

  return { overlay, keyboard };
}
