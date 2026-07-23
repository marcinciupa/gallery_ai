// Gallery AI — kompozytor. Montuje ekrany (GALLERY / VIEWER / SETTINGS),
// składa obudowę DeviceShell z kontekstową klawiaturą (5 slotów + joystick). Wariant/temat/left-handed
// sterowane z Settings; pinch synchronizuje fullscreen z przełącznikiem FULLSCREEN. Wg DESIGN_SYSTEM §8.
import { useState, useEffect, useRef } from 'react';
import { View, Text, Platform, StatusBar as RNStatusBar, BackHandler, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { ImmersiveViewer } from './src/screens/ImmersiveViewer';
import { useMedia } from './src/hooks/useMedia';
import { useLibraryFilter, momentsFolderIds } from './src/hooks/useLibraryFilter';
import { Mode, nextMode } from './src/screens/ScreenChrome';
import { PerfHud, renderTicker } from './src/components/PerfHud';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useWelcomeDialog } from './src/screens/WelcomeDialog';

// Android: wyłącz includeFontPadding globalnie, by wysokość linii (zwł. Kode Mono) zgadzała się z Figmą.
const TextWithDefaults = Text as unknown as { defaultProps?: { includeFontPadding?: boolean } };
TextWithDefaults.defaultProps = { ...(TextWithDefaults.defaultProps || {}), includeFontPadding: false };

SplashScreen.preventAutoHideAsync().catch(() => {});

// SafeAreaProvider musi otaczać komponent, który czyta insety (useSafeAreaInsets) — stąd rozdział App/AppInner.
export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
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
  // Zasiej MOMENTS folderami aparatu, gdy foldery są już znane (raz — potem użytkownik zarządza ręcznie).
  useEffect(() => {
    if (allFolders.length) lib.seedMoments(momentsFolderIds(allFolders as any[], []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFolders]);

  const settings = useSettingsScreen({
    mode, onCycleMode: cycleMode, onBack: () => setMode('GALLERY'),
    folders: allFolders, included: lib.included, excluded: lib.excluded, hidden: lib.hidden,
    onToggleIncluded: lib.toggleIncluded, onToggleExcluded: lib.toggleExcluded, onToggleHidden: lib.toggleHidden,
    moments: lib.moments, onToggleMoments: lib.toggleMoments,
  });
  const gallery = useGalleryScreen({
    mode, onCycleMode: cycleMode, onOpenSettings: () => setMode('SETTINGS'), onExitApp: () => BackHandler.exitApp(),
    media, allFolders, included: lib.included, excluded: lib.excluded, hidden: lib.hidden, moments: lib.moments,
    displayMode: settings.screenMode, diag: settings.diag, leftHanded: settings.leftHanded,
    promptBooster: settings.promptBooster,
  });
  const viewer = useViewerScreen({
    active: mode === 'VIEWER', onCycleMode: cycleMode, onBack: () => setMode('GALLERY'),
    leftHanded: settings.leftHanded, promptBooster: settings.promptBooster,
    media, allFolders, included: lib.included, excluded: lib.excluded,
  });

  // WELCOME — onboarding pierwszego uruchomienia (ustawia domyślne, à la rec_ai). null = jeszcze nie wiadomo.
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  useEffect(() => {
    AsyncStorage.getItem('galleryai.welcome.v1').then((v) => setShowWelcome(!v)).catch(() => setShowWelcome(false));
  }, []);
  const welcome = useWelcomeDialog({
    optionOf: settings.optionOf,
    optionsOf: settings.optionsOf,
    cycleByLabel: settings.cycleByLabel,
    onFinish: () => { AsyncStorage.setItem('galleryai.welcome.v1', '1').catch(() => {}); setShowWelcome(false); },
  });

  // pisanie promptu AI wymusza fullscreen + schowaną dolną obudowę (systemowa klawiatura) — wzorzec rec_ai
  const editorTyping = (mode === 'GALLERY' && gallery.typing) || (mode === 'VIEWER' && viewer.typing);
  const variant = settings.fullscreen || editorTyping ? 'fullscreen' : 'device';

  // Systemowy back (Android)/Escape (web): w GALLERY najpierw wyjście z folderu (goBack), potem z apki;
  // z innych trybów → powrót do GALLERY.
  const backRef = useRef<() => boolean>(() => false);
  const backExitAt = useRef(0); // znacznik pierwszego BACK w ROOT (double-back → wyjście)
  backRef.current = () => {
    if (showWelcome) return true; // onboarding: back nic nie robi (kończy się CONFIRM/START)
    if (mode === 'GALLERY') {
      if (gallery.goBack()) return true; // najpierw nawigacja wstecz (menu/folder/feed)
      // ROOT: double-back → wyjście. Pierwszy BACK = toast (3 s); drugi w oknie = zamknij apkę.
      const now = Date.now();
      if (now - backExitAt.current < 3000) return false; // drugi BACK → domyślne = exit
      backExitAt.current = now;
      gallery.showExitToast();
      return true;
    }
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

  // IMMERSIVE — pełnoekranowy podgląd renderowany w ROOCIE (poza obudową). Aktywny z GALLERY (podgląd) lub VIEWER.
  const immersive = mode === 'GALLERY' ? gallery.immersive : mode === 'VIEWER' ? viewer.immersive : null;

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
  // podczas onboardingu klawiatura należy do dialogu (nie lustrzana — welcome ma własny układ)
  const shellKeyboard: KeyboardConfig = showWelcome ? welcome.keyboard : keyboard;

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#000000' }} />;
  }

  // INSETY systemowe: górny pasek (status) + DOLNY navbar (3-przyciski/gesty). Bez dolnego insetu navbar
  // nachodził na klawiaturę aplikacji. Tylko w trybie „device" (fullscreen celowo idzie edge-to-edge).
  const insets = useSafeAreaInsets();
  const isDevice = variant === 'device';
  const topInset = Platform.OS === 'android' && isDevice ? RNStatusBar.currentHeight || 0 : 0;
  const bottomInset = isDevice ? insets.bottom : 0;
  const barStyle = themes[settings.theme].casingDark ? 'light' : 'dark';
  // PODGLĄD WEB: skaluj całe urządzenie 390×844 do okna (zachowując proporcje).
  const webScale = Platform.OS === 'web' ? Math.min(winW / 390, winH / 844, 1) : 1;

  return (
    <View style={{ flex: 1, paddingTop: topInset, paddingBottom: bottomInset, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
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
          keyboard={shellKeyboard}
          hideControls={editorTyping}
          // pinch na OBUDOWIE → device/fullscreen
          onPinch={(dir) => settings.setFullscreen(dir === 'out')}
          // pinch na EKRANIE → liczba kolumn; swipe lewo/prawo → cykl efektu miniatur (pętla). Tylko w GALLERY.
          onScreenPinch={(dir) => { if (mode === 'GALLERY' && !gallery.viewerOpen && !gallery.menuOpen && !gallery.selectMode) gallery.pinchColumns(dir); }}
          onScreenSwipe={(dir) => { if (mode === 'GALLERY' && !gallery.viewerOpen && !gallery.selectMode) { settings.cycleScreenMode(dir === 'left' ? 1 : -1); gallery.showModeToast(); } }}
          diag={settings.diag}
        >
          {base.content}
          {/* WELCOME — onboarding W EKRANIE (slot Display), wyśrodkowany; NIE zasłania klawiszy/joysticka pod obudową */}
          {showWelcome ? welcome.overlay : null}
        </DeviceShell>
      </View>
      {/* IMMERSIVE — nakładka NAD obudową, edge-to-edge (kompensacja insetów), czysta czerń bez matrycy/filtrów */}
      {immersive ? (
        <View style={{ position: 'absolute', top: -topInset, left: 0, right: 0, bottom: -bottomInset }}>
          <ImmersiveViewer photos={immersive.photos} index={immersive.index} setIndex={immersive.setIndex} onClose={immersive.close} info={immersive.info} statusBarH={Platform.OS === 'android' ? (RNStatusBar.currentHeight || undefined) : undefined} />
        </View>
      ) : null}
      {settings.perfHud ? <PerfHud /> : null}
      <StatusBar style={barStyle} />
    </View>
  );
}
