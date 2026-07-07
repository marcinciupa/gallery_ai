/**
 * Forehead — górny pas obudowy („czoło" nad ekranem). GALERIA: PUSTY — bez mikrofonu, logo i diody REC
 * (to nie dyktafon; w Figmie upper_forehead jest pustym paskiem, sam bevel/tekstura).
 *  device: pasek o stałej wysokości (upperMicHeight) — miejsce na górny bevel + zaokrąglone rogi.
 *  fullscreen: pas o wysokości statusbara (leży ZA ikonami systemowymi; ekran startuje tuż pod nimi).
 */
import { View, Platform, StatusBar as RNStatusBar } from 'react-native';
import { dims } from '../../theme/tokens';
import type { Variant } from './DeviceShell';

export function Forehead({ variant }: { variant: Variant }) {
  if (variant === 'fullscreen') {
    const sbH = Platform.OS === 'android' ? RNStatusBar.currentHeight || 0 : 0;
    return <View style={{ height: sbH, alignSelf: 'stretch' }} />;
  }
  return <View style={{ height: dims.upperMicHeight, alignSelf: 'stretch' }} />;
}
