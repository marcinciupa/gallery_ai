/**
 * Kontekst przechylenia — udostępnia animowane wartości tilt (tx,ty, -1..1) elementom
 * chrome (sheen ekranu, sheen przycisków "screen"), bez przekazywania propsami.
 * null = brak ruchu (MOTION off / poza providerem).
 */
import { createContext, useContext, ReactNode } from 'react';
import { Animated } from 'react-native';

export type TiltValue = { tx: Animated.Value; ty: Animated.Value } | null;

const TiltContext = createContext<TiltValue>(null);

export function TiltProvider({ value, children }: { value: TiltValue; children: ReactNode }) {
  return <TiltContext.Provider value={value}>{children}</TiltContext.Provider>;
}

export function useTiltCtx(): TiltValue {
  return useContext(TiltContext);
}
