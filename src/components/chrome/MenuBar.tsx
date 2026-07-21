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
const RED_PILL = { boxShadow: '0px 0px 4px 0px rgba(255,76,76,0.25)' } as const;
const HS = { top: 16, bottom: 16, left: 6, right: 6 } as const;

// `riskLabels` = pozycje „High Risk" (np. DELETE) renderowane na CZERWONO (Figma 460:2541 — czerwona pigułka
// #FF4C4C z ciemnym tekstem, niezależnie od fokusu paska).
export function MenuBar({ items, index, focused, onPick, riskLabels }: { items: readonly string[]; index: number; focused: boolean; onPick: (i: number) => void; riskLabels?: readonly string[] }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  const pillBg = focused ? color.dark21 : screen.olive.primary; // na fokusowanym pasku pigułka jest ciemna
  const pillFg = focused ? screen.olive.primary : color.dark21;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', alignSelf: 'stretch', paddingHorizontal: 8, paddingVertical: 6, borderRadius: 2, ...(focused ? { backgroundColor: screen.olive.primary, ...(PILL as any) } : null) }}>
      {items.map((label, i) => {
        const risk = !!riskLabels?.includes(label);
        return i === index ? (
          // zaznaczona pigułka: risk → czerwona z ciemnym tekstem; inaczej wg fokusu paska
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={HS} style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 3, paddingHorizontal: 4, borderRadius: 2, backgroundColor: risk ? screen.red.primary : pillBg, ...(risk ? (RED_PILL as any) : focused ? null : (PILL as any)) }}>
            <Text style={{ ...txt, color: risk ? color.dark21 : pillFg, ...(risk ? null : focused ? phosphorGlow : null) }}>{'•'}</Text>
            <Text style={{ ...txt, color: risk ? color.dark21 : pillFg, ...(risk ? null : focused ? phosphorGlow : null) }}>{label}</Text>
          </Pressable>
        ) : (
          // niezaznaczona: risk → czerwony tekst (glow); inaczej wg fokusu
          <Pressable key={label} onPress={() => onPick(i)} hitSlop={HS} style={{ paddingVertical: 3 }}>
            <Text style={{ ...txt, color: risk ? screen.red.primary : focused ? color.dark21 : screen.olive.primary, ...(risk ? redGlow : focused ? null : phosphorGlow) }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
