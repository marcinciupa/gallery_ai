/**
 * KeyIcon — ikona klawisza (Figma component set 496:24601), renderowana z danych `keyIcons.gen.ts`.
 * Ikony liniowe 32×32 (stroke ICON_STROKE, round cap). `color` = kolor klawisza (domyślnie phosphor; na klawiszu
 * `primary`/`highRisk` podajemy dark21, jak robi to tekst). GLOW = fosforowa poświata: warstwa pod spodem
 * z grubszym, półprzezroczystym stroke'iem (react-native-svg nie ma filtrów, więc halo robimy duplikatem).
 */
import { View } from 'react-native';
import Svg, { Path, Rect, Circle, G } from 'react-native-svg';
import { screen } from '../../theme/tokens';
import { KEY_ICONS, type IconEl, type KeyIconName } from './keyIcons.gen';

// Grubość ścieżki ikony w siatce 32×32 (Figma dawała 4). 3,8 — wspólna wartość dla rec_ai i gallery_ai,
// żeby ikonografia obu apek wyglądała identycznie. Przy renderze 26 px daje ~3,09 px na ekranie.
const ICON_STROKE = 3.6;
const GLOW_STROKE = ICON_STROKE + 2; // halo zawsze o 2 szersze od ścieżki
const GLOW_OPACITY = 0.15; // krycie poświaty — wspólne dla rec_ai i gallery_ai

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
            <G opacity={GLOW_OPACITY}><Prims els={els} stroke={color} width={GLOW_STROKE} /></G>
          </Svg>
        </View>
      ) : null}
      {/* crisp stroke — grubość jak w projekcie (ICON_STROKE na 32) */}
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Prims els={els} stroke={color} width={ICON_STROKE} />
      </Svg>
    </View>
  );
}
