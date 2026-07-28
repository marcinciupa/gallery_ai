/**
 * KeyIcon — ikona klawisza (Figma component set 496:24601), renderowana z danych `keyIcons.gen.ts`.
 * Ikony liniowe 32×32 (stroke 4, round cap). `color` = kolor klawisza (domyślnie phosphor; na klawiszu
 * `primary`/`highRisk` podajemy dark21, jak robi to tekst). GLOW = fosforowa poświata: warstwa pod spodem
 * z grubszym, półprzezroczystym stroke'iem (react-native-svg nie ma filtrów, więc halo robimy duplikatem).
 */
import { View } from 'react-native';
import Svg, { Path, Rect, Circle, G } from 'react-native-svg';
import { screen } from '../../theme/tokens';
import { KEY_ICONS, type IconEl, type KeyIconName } from './keyIcons.gen';

function Prims({ els, stroke, width }: { els: IconEl[]; stroke: string; width: number }) {
  return (
    <>
      {els.map((e, i) =>
        e.t === 'p' ? (
          <Path key={i} d={e.d} stroke={stroke} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ) : e.t === 'r' ? (
          <Rect key={i} x={e.x} y={e.y} width={e.w} height={e.h} stroke={stroke} strokeWidth={width} strokeLinejoin="round" fill="none" />
        ) : (
          <Circle key={i} cx={e.cx} cy={e.cy} r={e.r} stroke={stroke} strokeWidth={width} fill="none" />
        )
      )}
    </>
  );
}

export function KeyIcon({ name, size = 26, color = screen.olive.primary, glow = true }: { name: KeyIconName; size?: number; color?: string; glow?: boolean }) {
  const els = KEY_ICONS[name];
  if (!els) return null;
  return (
    <View style={{ width: size, height: size }}>
      {/* halo (glow): projekt = boxShadow 0 0 4px rgba(226,255,228,.25) — subtelny blur. react-native-svg
          nie ma filtrów, więc przybliżamy JEDNĄ delikatną, lekko szerszą warstwą pod crisp stroke'iem. */}
      {glow ? (
        <View pointerEvents="none" style={{ position: 'absolute', inset: 0 } as any}>
          <Svg width={size} height={size} viewBox="0 0 32 32">
            <G opacity={0.22}><Prims els={els} stroke={color} width={6} /></G>
          </Svg>
        </View>
      ) : null}
      {/* crisp stroke — grubość jak w projekcie (4 na 32) */}
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Prims els={els} stroke={color} width={4} />
      </Svg>
    </View>
  );
}
