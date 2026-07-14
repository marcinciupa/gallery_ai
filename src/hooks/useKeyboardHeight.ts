/**
 * useKeyboardHeight — wysokość systemowej klawiatury (0 gdy schowana). W trybie edge-to-edge `adjustResize`
 * bywa niepewne (zależnie od OEM/wersji Androida) → sami podnosimy input o tę wysokość, zamiast liczyć na
 * przesunięcie okna. Zdarzenia `keyboardDidShow/Hide` (Android) / `keyboardWillShow/Hide` (iOS).
 */
import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => setHeight(e.endCoordinates?.height ?? 0));
    const hide = Keyboard.addListener(hideEvt, () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return height;
}
