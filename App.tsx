// Gallery AI — kompozytor. Montuje ekrany (GALLERY / VIEWER / SETTINGS),
// składa obudowę DeviceShell z kontekstową klawiaturą (5 slotów + joystick). Wariant/temat/left-handed
// sterowane z Settings; pinch synchronizuje fullscreen z przełącznikiem FULLSCREEN. Wg DESIGN_SYSTEM §8.
import { useState, useEffect, useRef } from 'react';
import { View, Text, Platform, StatusBar as RNStatusBar, BackHandler, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { KodeMono_400Regular, KodeMono_700Bold } from '@expo-google-fonts/kode-mono';
import * as SplashScreen from 'expo-splash-screen';
import { themes } from './src/theme/tokens';
import { DeviceShell } from './src/components/chrome/DeviceShell';
import { KeyboardConfig } from './src/components/chrome/Keyboard';
import { useSettingsScreen } from './src/screens/SettingsScreen';
import { useGalleryScreen, DESIGN, MOCK_FOLDERS, EMPTY_FOLDERS } from './src/screens/GalleryScreen';
import { useViewerScreen } from './src/screens/ViewerScreen';
import { useMedia } from './src/hooks/useMedia';
import { useLibraryFilter } from './src/hooks/useLibraryFilter';
import { Mode, nextMode } from './src/screens/ScreenChrome';
import { PerfHud, renderTicker } from './src/components/PerfHud';

// Android: wyłącz includeFontPadding globalnie, by wysokość linii (zwł. Kode Mono) zgadzała się z Figmą.
const TextWithDefaults = Text as unknown as { defaultProps?: { includeFontPadding?: boolean } };
TextWithDefaults.defaultProps = { ...(TextWithDefaults.defaultProps || {}), includeFontPadding: false };

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  renderTicker.n++; // diagnostyka: liczba re-renderów App (HUD pokazuje R/s)
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_700Bold,
    KodeMono_400Regular,
    KodeMono_700Bold,
  });
  const { width: winW, height: winH } = useWindowDimensions();

  const [mode, setMode] = useState<Mode>('GALLERY');
  const cycleMode = () => setMode((m) => nextMode(m));

  // JEDNO źródło mediów/folderów — współdzielone przez Settings (edytor filtra) i Gallery (filtrowanie).
  const media = useMedia();
  const allFolders = DESIGN ? MOCK_FOLDERS : (media.folders ?? EMPTY_FOLDERS);
  const lib = useLibraryFilter();

  const settings = useSettingsScreen({
    mode, onCycleMode: cycleMode, onBack: () => setMode('GALLERY'),
    folders: allFolders, included: lib.included, excluded: lib.excluded,
    onToggleIncluded: lib.toggleIncluded, onToggleExcluded: lib.toggleExcluded,
  });
  const gallery = useGalleryScreen({
    mode, onCycleMode: cycleMode, onOpenSettings: () => setMode('SETTINGS'),
    media, allFolders, included: lib.included, excluded: lib.excluded,
    displayMode: settings.screenMode, diag: settings.diag, leftHanded: settings.leftHanded,
    promptBooster: settings.promptBooster,
  });
  const viewer = useViewerScreen({
    active: mode === 'VIEWER', onCycleMode: cycleMode, onBack: () => setMode('GALLERY'),
    leftHanded: settings.leftHanded, promptBooster: settings.promptBooster,
    media, allFolders, included: lib.included, excluded: lib.excluded,
  });

  // pisanie promptu AI wymusza fullscreen + schowaną dolną obudowę (systemowa klawiatura) — wzorzec rec_ai
  const editorTyping = (mode === 'GALLERY' && gallery.typing) || (mode === 'VIEWER' && viewer.typing);
  const variant = settings.fullscreen || editorTyping ? 'fullscreen' : 'device';

  // Systemowy back (Android)/Escape (web): w GALLERY najpierw wyjście z folderu (goBack), potem z apki;
  // z innych trybów → powrót do GALLERY.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    if (mode === 'GALLERY') return gallery.goBack();
    if (mode === 'SETTINGS' && settings.goBack()) return true; // wyjście z sub-widoku (EXCLUDED) do listy ustawień
    if (mode === 'VIEWER' && viewer.goBack()) return true;     // najpierw domknij menu EDIT / crop / ai
    setMode('GALLERY');
    return true;
  };
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backRef.current());
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const base =
    mode === 'SETTINGS'
      ? { content: settings.content, keyboard: settings.keyboard }
      : mode === 'GALLERY'
        ? { content: gallery.content, keyboard: gallery.keyboard }
        : { content: viewer.content, keyboard: viewer.keyboard };

  // LEFT-HANDED MODE: lustro rzędu — zamiana krawędzi (screen) i wewnętrznych (metal); joystick w środku.
  const keyboard: KeyboardConfig = settings.leftHanded
    ? {
        ...base.keyboard,
        screen: [base.keyboard.screen[1], base.keyboard.screen[0]],
        metal: [base.keyboard.metal[1], base.keyboard.metal[0]],
      }
    : base.keyboard;

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#000000' }} />;
  }

  const topInset = Platform.OS === 'android' && variant === 'device' ? RNStatusBar.currentHeight || 0 : 0;
  const barStyle = themes[settings.theme].casingDark ? 'light' : 'dark';
  // PODGLĄD WEB: skaluj całe urządzenie 390×844 do okna (zachowując proporcje).
  const webScale = Platform.OS === 'web' ? Math.min(winW / 390, winH / 844, 1) : 1;

  return (
    <View style={{ flex: 1, paddingTop: topInset, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={
          Platform.OS === 'web'
            ? { width: 390, height: 844, transform: [{ scale: webScale }], overflow: 'hidden' }
            : { width: '100%', height: '100%', overflow: 'hidden' }
        }
      >
        <DeviceShell
          variant={variant}
          theme={settings.theme}
          motion={false}
          keyboard={keyboard}
          hideControls={editorTyping}
          // pinch na OBUDOWIE → device/fullscreen
          onPinch={(dir) => settings.setFullscreen(dir === 'out')}
          // pinch na EKRANIE → liczba kolumn; swipe lewo/prawo → cykl efektu miniatur (pętla). Tylko w GALLERY.
          onScreenPinch={(dir) => { if (mode === 'GALLERY' && !gallery.viewerOpen && !gallery.menuOpen) gallery.pinchColumns(dir); }}
          onScreenSwipe={(dir) => { if (mode === 'GALLERY' && !gallery.viewerOpen) { settings.cycleScreenMode(dir === 'left' ? 1 : -1); gallery.showModeToast(); } }}
          diag={settings.diag}
        >
          {base.content}
        </DeviceShell>
      </View>
      {settings.perfHud ? <PerfHud /> : null}
      <StatusBar style={barStyle} />
    </View>
  );
}
