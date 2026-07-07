/**
 * Kontekst motywu obudowy — udostępnia paletę (ThemePalette) wszystkim elementom
 * chrome, żeby nie przekazywać jej propsami przez całe drzewo. Domyślnie LIGHT.
 */
import { createContext, useContext, ReactNode } from 'react';
import { themes, ThemePalette } from './tokens';

const ThemeContext = createContext<ThemePalette>(themes.LIGHT);

export function ThemeProvider({ value, children }: { value: ThemePalette; children: ReactNode }) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemePalette {
  return useContext(ThemeContext);
}
