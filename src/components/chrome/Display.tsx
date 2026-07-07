/**
 * Display — „ekran" urządzenia. To SLOT NA TREŚĆ: cały content aplikacji renderuje się tu jako
 * children. Obudowa wokół jest stała. Tu odwzorowana sama szyba: ramka + połysk + glow + matryca.
 */
import { ReactNode } from 'react';
import { Animated, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { color, dims, gradient, shadow } from '../../theme/tokens';
import { useTiltCtx } from '../../theme/TiltContext';
import { ScreenMatrix } from './ScreenMatrix';
import { Diag, DIAG_ALL } from '../../lib/diag';

/** Miękka poświata zza lewego-górnego rogu szyby; delikatnie pływa (parallax, górna część). */
function Glow() {
  const tilt = useTiltCtx();
  const transform = tilt
    ? [
        { translateX: tilt.tx.interpolate({ inputRange: [-1, 1], outputRange: [-18, 18] }) },
        { translateY: tilt.ty.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] }) },
      ]
    : undefined;
  const mag = tilt
    ? Animated.add(
        tilt.tx.interpolate({ inputRange: [-1, 0, 1], outputRange: [1, 0, 1] }),
        tilt.ty.interpolate({ inputRange: [-1, 0, 1], outputRange: [1, 0, 1] })
      )
    : null;
  const opacity = mag ? mag.interpolate({ inputRange: [0, 2], outputRange: [0.45, 1], extrapolate: 'clamp' }) : 0.45;
  return (
    <Animated.View
      style={{ position: 'absolute', top: -24, bottom: -24, left: -24, right: -24, pointerEvents: 'none', opacity, transform } as any}
    >
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="screenGlow" cx="22%" cy="14%" r="80%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.28" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#screenGlow)" />
      </Svg>
    </Animated.View>
  );
}

/** Połysk szyby — biały gradient TL→BR; sunie po górnej krawędzi z przechyleniem. */
function Sheen() {
  const tilt = useTiltCtx();
  const sheenX = tilt ? tilt.tx.interpolate({ inputRange: [-1, 1], outputRange: [-44, 44] }) : 0;
  const opacity = tilt ? tilt.tx.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.34, 0.16, 0.34] }) : 0.16;
  return (
    <Animated.View
      style={
        {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: -56,
          right: -56,
          opacity,
          transform: [{ translateX: sheenX }],
        } as any
      }
      pointerEvents="none"
    >
      <LinearGradient
        colors={gradient.screenSheen.colors}
        start={gradient.screenSheen.start}
        end={gradient.screenSheen.end}
        style={{ flex: 1 }}
      />
    </Animated.View>
  );
}

export function Display({ children, diag = DIAG_ALL }: { children?: ReactNode; diag?: Diag }) {
  return (
    // screen_frame — ciemna ramka wokół szyby (padding 2, darkSurface)
    <LinearGradient
      colors={gradient.darkSurface.colors}
      start={gradient.darkSurface.start}
      end={gradient.darkSurface.end}
      style={{ flex: 1, alignSelf: 'stretch', padding: dims.screenFramePadding }}
    >
      {/* screen — szyba: tło #1A1A1A + połysk + inset shadow */}
      <View
        style={{
          flex: 1,
          borderRadius: dims.screenRadius,
          backgroundColor: color.dark1A,
          overflow: 'hidden',
          ...(diag.shadow ? { boxShadow: shadow.screenInset } : null),
        }}
      >
        {/* SLOT NA TREŚĆ — POD połyskiem/poświatą */}
        <View
          style={{
            position: 'absolute',
            inset: 0,
            padding: dims.screenPadding,
            gap: dims.screenGap,
          }}
        >
          {children}
        </View>
        {/* matryca ekranu: między treścią a połyskiem/poświatą. Zostaje we WSZYSTKICH trybach
            wyświetlania (IMMERSIVE/RETRO/CLEAN) — Figma CLEAN też ją ma (rozjazd vs §11b.1). */}
        {diag.matrix ? <ScreenMatrix radius={dims.screenRadius} /> : null}
        {/* połysk + poświata ZAWSZE NAD treścią (pointerEvents none → nie blokują dotyku) */}
        {diag.sheen ? <Sheen /> : null}
        {diag.glow ? <Glow /> : null}
      </View>
    </LinearGradient>
  );
}
