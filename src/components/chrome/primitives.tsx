/**
 * Prymitywy skeuomorficzne wielokrotnego użytku.
 */
import { ReactNode } from 'react';
import { View, ViewStyle, StyleProp } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, LinearGradient as SvgLinear, Stop } from 'react-native-svg';
import { Gradient, gradient } from '../../theme/tokens';
import { useTheme } from '../../theme/ThemeContext';

/**
 * Metaliczny bevel — DWIE warstwy obrysów per-strona (jak w Figmie 121:269/122:414/122:688):
 * stroke.colors[0] = LIGHT → góra + lewo; stroke.colors[1] = SHADOW → dół + prawo.
 * (raised: light TL / shadow BR; recessed: odwrotnie — zakodowane w kolejności kolorów tokenu.)
 * Kolory są pół-przezroczyste (biel/czerń 25%), więc bevel działa na KAŻDYM motywie niezależnie od tła.
 * Jeden View z borderkolorami per-strona (RN to wspiera) — elegancko, bez SVG/pomiaru.
 */
export function Bevel({
  stroke,
  width = 1,
  radius,
  fill,
  fillGradient,
  style,
  innerStyle,
  children,
}: {
  stroke: Gradient;
  width?: number;
  radius: number;
  fill?: string;
  fillGradient?: Gradient;
  style?: StyleProp<ViewStyle>;
  innerStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const tl = stroke.colors[0]; // light → góra + lewo
  const br = stroke.colors[1]; // shadow → dół + prawo
  const border: ViewStyle = {
    borderRadius: radius,
    borderTopWidth: width,
    borderLeftWidth: width,
    borderBottomWidth: width,
    borderRightWidth: width,
    borderTopColor: tl,
    borderLeftColor: tl,
    borderBottomColor: br,
    borderRightColor: br,
    overflow: 'hidden',
  };
  if (fillGradient) {
    return (
      <LinearGradient
        colors={fillGradient.colors}
        locations={fillGradient.locations as any}
        start={fillGradient.start}
        end={fillGradient.end}
        style={[border, style, innerStyle]}
      >
        {children}
      </LinearGradient>
    );
  }
  return <View style={[border, { backgroundColor: fill }, style, innerStyle]}>{children}</View>;
}

/**
 * Rząd kropek grille mikrofonu (upper/lower). Kropki: ciemne wypełnienie + metaliczny obrys.
 * Renderujemy jako jeden SVG, liczbę kropek dobieramy do szerokości (pitch 8px, r 1.75).
 */
export function MicGrille({
  width,
  rows = 1,
  pitch = 8,
  r = 1.75,
}: {
  width: number;
  rows?: number;
  pitch?: number;
  r?: number;
}) {
  const t = useTheme();
  const count = Math.max(0, Math.floor((width - pitch) / pitch));
  const total = count * pitch;
  const startX = (width - total) / 2;
  const height = rows * pitch;
  const dots: ReactNode[] = [];
  for (let row = 0; row < rows; row++) {
    const cy = pitch / 2 + row * pitch;
    for (let i = 0; i <= count; i++) {
      const cx = startX + i * pitch;
      dots.push(
        <Circle
          key={`${row}-${i}`}
          cx={cx}
          cy={cy}
          r={r}
          fill="url(#dotFill)"
          stroke="url(#dotStroke)"
          strokeWidth={0.5}
        />
      );
    }
  }
  return (
    // gradientUnits="objectBoundingBox" (domyślne) → KAŻDA kropka dostaje własny
    // gradient mapowany do swojego bounding-boxa (a nie jeden wspólny na cały rząd).
    // Bevel kropki: ciemny lewy-góra → jasny prawy-dół (wklęsły otwór, odwrotnie niż klawisze).
    <Svg width={width} height={height} fill="none">
      <Defs>
        <SvgLinear id="dotFill" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={gradient.darkSurface.colors[0]} />
          <Stop offset="1" stopColor={gradient.darkSurface.colors[1]} />
        </SvgLinear>
        <SvgLinear id="dotStroke" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={t.recessedBevel.colors[0]} />
          <Stop offset="1" stopColor={t.recessedBevel.colors[1]} />
        </SvgLinear>
      </Defs>
      {dots}
    </Svg>
  );
}
