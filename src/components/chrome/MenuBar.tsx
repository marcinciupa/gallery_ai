/**
 * MenuBar — pasek dwupoziomowego menu edycji (Figma _AI 424:6660). FOKUS = duży fosforowy prostokąt, który
 * joystick (góra/dół) PRZENOSI między dwoma paskami. Zasada (identyczna dla obu pasków, niezależnie main/sub):
 *   • FOKUSOWANY pasek: fosforowe TŁO (prostokąt); zaznaczony = CIEMNA pigułka z fosforowym tekstem; reszta = ciemny tekst.
 *   • NIEFOKUSOWANY pasek: przezroczysty; zaznaczony = FOSFOROWA pigułka z ciemnym tekstem; reszta = fosforowy tekst (glow).
 * Bez wygaszeń/opacity — selekcję i fokus pokazują pigułka i prostokąt.
 */
import { View, Text, Pressable } from 'react-native';
import { color, font, screen, textShadow } from '../../theme/tokens';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;
const redGlow = { textShadowColor: screen.red.primary, textShadowRadius: textShadow.phosphor.radius, textShadowOffset: { width: 0, height: 0 } } as const;
const PILL = { boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as const;
const HS = { top: 16, bottom: 16, left: 6, right: 6 } as const;

// `riskLabels` = pozycje „High Risk" (np. DELETE) renderowane na CZERWONO (Figma 460:2541 — czerwona pigułka
// #FF4C4C z ciemnym tekstem, niezależnie od fokusu paska).
export function MenuBar({ items, index, focused, onPick, riskLabels, boldDigits }: { items: readonly string[]; index: number; focused: boolean; onPick: (i: number) => void; riskLabels?: readonly string[]; boldDigits?: boolean }) {
  // `boldDigits` — pogrubia CYFRY w etykiecie (np. licznik w „SELECT [3]"), reszta bez zmian.
  // Zagnieżdżony <Text> dziedziczy styl rodzica, więc podmieniamy tylko rodzinę na bold.
  const renderLabel = (label: string) =>
    boldDigits
      ? label.split(/(\d+)/).map((part, k) =>
          /^\d+$/.test(part) ? <Text key={k} style={{ fontFamily: font.monoLabel.family }}>{part}</Text> : part,
        )
      : label;
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  const pillBg = focused ? color.dark21 : screen.olive.primary; // na fokusowanym pasku pigułka jest ciemna
  const pillFg = focused ? screen.olive.primary : color.dark21;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 2, ...(focused ? { backgroundColor: screen.olive.primary, ...(PILL as any) } : null) }}>
      {items.map((label, i) => {
        const risk = !!riskLabels?.includes(label);
        return i === index ? (
          // Zaznaczona pigułka. `risk` (np. DELETE) zmienia TYLKO kolor tekstu na czerwony — tło pigułki
          // zostaje takie samo jak przy zwykłych pozycjach. Wcześniej było odwrotnie (czerwone tło,
          // ciemny tekst), przez co DELETE krzyczał także wtedy, gdy nikt na nim nie stał.
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={HS} style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 3, paddingHorizontal: 4, borderRadius: 2, backgroundColor: pillBg, ...(focused ? null : (PILL as any)) }}>
            <Text style={{ ...txt, color: risk ? screen.red.primary : pillFg, ...(risk ? redGlow : focused ? phosphorGlow : null) }}>{'•'}</Text>
            <Text style={{ ...txt, color: risk ? screen.red.primary : pillFg, ...(risk ? redGlow : focused ? phosphorGlow : null) }}>{renderLabel(label)}</Text>
          </Pressable>
        ) : (
          // Niezaznaczona: BEZ wyróżnienia — `risk` nie działa, DELETE wygląda jak każda inna pozycja.
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={HS} style={{ paddingVertical: 3 }}>
            <Text style={{ ...txt, color: focused ? color.dark21 : screen.olive.primary, ...(focused ? null : phosphorGlow) }}>{renderLabel(label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
