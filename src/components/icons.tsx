/**
 * Ikony wektorowe przepisane z Figmy na react-native-svg. Trzymane jako komponenty
 * (nie pliki .svg), żeby parametryzować kolory/stany bez transformera Metro.
 * Port z rec_ai — tylko ikony używane w galerii (deAPI status w pasku ekranu).
 */
import Svg, { Path } from 'react-native-svg';
import { color } from '../theme/tokens';

/** deapi.svg — znaczek "AI / deAPI" (chip z przekątną). 22×24, kolor phosphor. */
export function DeApiIcon({ size = 24, fill = color.phosphor }: { size?: number; fill?: string }) {
  return (
    <Svg width={(size * 22) / 24} height={size} viewBox="0 0 22 24" fill="none">
      <Path
        d="M17.5952 19.7333L18.4433 18.8852V16.6844H21.421V14.9882H18.4433V12.8485H21.421V11.1523H18.4433V9.01262H21.421V7.31644H18.4433V5.11566L17.5952 4.26757H15.3945V2.33733L13.6983 1.35779V4.26672H11.5586V0.122124L11.3465 0H10.0744L9.8624 0.122124V4.26672H7.72268V1.35779L6.0265 2.33733V4.26757H3.82572L2.97763 5.11566V7.31644H0V9.01262H2.97763V11.1523H0V12.8485H2.97763V14.9882H0V16.6844H2.97763V18.8852L3.82572 19.7333H6.0265V21.6627L7.72268 22.6422V19.7333H9.8624V23.8779L10.0744 24H11.3465L11.5586 23.8779V19.7333H13.6983V22.6422L15.3945 21.6627V19.7333H17.5952ZM4.6738 18.0371V5.9629H16.7472V18.0363L4.6738 18.0371ZM13.242 7.29694H15.3792L8.17555 16.7022H6.03838L13.242 7.29694Z"
        fill={fill}
      />
    </Svg>
  );
}
