/**
 * EditorScreen — pełnoekranowy podgląd + edycja pojedynczego zdjęcia (Figma „fullscreen_view/edit").
 * Zastępuje treść ekranu, gdy w galerii otwarty jest podgląd (`viewerOpen`). Trzy pod-widoki:
 *   • VIEWER — czysty obraz w polu treści (pinch-zoom), pasek statusu z etykietą VIEWER.
 *   • CROP   — kadrowanie i rotacja (Etap 2; na razie placeholder).
 *   • AI     — edycja promptem przez deAPI/z-image (Etap 3; na razie placeholder).
 *
 * Menu EDIT (popover, jak menu galerii): AI EDIT / CROP & ROTATE — wybór pod-widoku.
 * Klawiatura kontekstowa per pod-widok. `goBack` domyka kolejno: menu → pod-widok → (false = zamknij podgląd).
 */
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Animated, PanResponder, Image as RNImage, ImageSourcePropType, LayoutChangeEvent, TextInput, Keyboard as RNKeyboard } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { color, font, screen, textShadow } from '../theme/tokens';
import type { KeyboardConfig } from '../components/chrome/Keyboard';
import { ScreenTopBar, AiStatusView } from './ScreenChrome';
import { CropStage, CropHandle } from './CropStage';
import { AiStage } from './AiStage';
import { editImage, fillImage, boostPrompt } from '../lib/deapi';
import { saveImageToLibrary } from '../lib/saveImage';

const phosphorGlow = {
  textShadowColor: textShadow.phosphor.color,
  textShadowRadius: textShadow.phosphor.radius,
  textShadowOffset: { width: 0, height: 0 },
} as const;

type EditView = 'viewer' | 'crop' | 'ai';

// pozycje menu EDIT — indeks steruje pod-widokiem (0 → AI, 1 → CROP)
const EDIT_MENU = ['AI EDIT', 'CROP & ROTATE'] as const;

/**
 * Pinch-zoom podglądu (1×–6×), 1 palcem przesuwanie gdy powiększone; puszczenie poniżej 1× wraca do
 * dopasowania. Gesty na PanResponderze (brak gesture-handlera w projekcie). Remount przez `key` (PREV/NEXT)
 * zeruje zoom. Renderowany W POLU TREŚCI (nie fullscreen) — pasek statusu nad nim zostaje widoczny.
 */
function ZoomImage({ source }: { source: ImageSourcePropType }) {
  const initRatio = useMemo(() => {
    try { const a = RNImage.resolveAssetSource(source as any); return a?.width && a?.height ? a.width / a.height : 1; } catch { return 1; }
  }, [source]);
  const [ratio, setRatio] = useState(initRatio); // szer/wys
  const [box, setBox] = useState({ w: 0, h: 0 });

  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const cur = useRef({ s: 1, x: 0, y: 0 });
  const base = useRef({ s: 1, x: 0, y: 0 });
  const pinch = useRef<{ d0: number; s0: number } | null>(null);

  const dist2 = (ts: any[]) => Math.hypot(ts[0].pageX - ts[1].pageX, ts[0].pageY - ts[1].pageY);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { base.current = { ...cur.current }; pinch.current = null; },
      onPanResponderMove: (e, g) => {
        const ts = e.nativeEvent.touches;
        if (ts.length >= 2) {
          const d = dist2(ts);
          if (!pinch.current) pinch.current = { d0: d, s0: base.current.s };
          const s = clamp(pinch.current.s0 * (d / pinch.current.d0), 1, 6);
          cur.current.s = s;
          scale.setValue(s);
        } else if (ts.length === 1 && base.current.s > 1) {
          cur.current.x = base.current.x + g.dx;
          cur.current.y = base.current.y + g.dy;
          tx.setValue(cur.current.x);
          ty.setValue(cur.current.y);
        }
      },
      onPanResponderRelease: () => {
        pinch.current = null;
        if (cur.current.s <= 1.01) {
          cur.current = { s: 1, x: 0, y: 0 };
          base.current = { s: 1, x: 0, y: 0 };
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
            Animated.spring(tx, { toValue: 0, useNativeDriver: true }),
            Animated.spring(ty, { toValue: 0, useNativeDriver: true }),
          ]).start();
        } else {
          base.current = { ...cur.current };
        }
      },
    }),
  ).current;

  // dopasowanie „contain" do pola: bierzemy mniejszy z wymiarów (szer wg ratio, wys wg pola)
  const fit = box.w > 0 && box.h > 0
    ? (box.w / box.h > ratio ? { width: box.h * ratio, height: box.h } : { width: box.w, height: box.w / ratio })
    : { width: 0, height: 0 };

  return (
    <View
      style={{ flex: 1, alignSelf: 'stretch', borderRadius: 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
      onLayout={(e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setBox((b) => (Math.abs(b.w - width) < 1 && Math.abs(b.h - height) < 1 ? b : { w: width, h: height }));
      }}
      {...responder.panHandlers}
    >
      {fit.width > 0 ? (
        <Animated.View style={{ transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
          <ExpoImage
            source={source}
            contentFit="contain"
            cachePolicy="memory-disk"
            onLoad={(ev: any) => { const s = ev?.source; if (s?.width && s?.height) setRatio(s.width / s.height); }}
            style={{ width: fit.width, height: fit.height }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

/** Menu EDIT — popover fosforowy (jak menu galerii): zaznaczona pozycja = ciemna pigułka z bulletem „•". */
function EditMenu({ index, onPick, leftHanded = false }: { index: number; onPick: (i: number) => void; leftHanded?: boolean }) {
  const txt = { fontFamily: font.monoBody.family, fontSize: font.monoBody.size } as const;
  // popover trzyma się klawisza menu (EDIT/MENU): domyślnie prawy dolny róg; left-handed → lewy.
  return (
    <View
      style={{ position: 'absolute', ...(leftHanded ? { left: 0 } : { right: 0 }), bottom: 0, padding: 8, gap: 8, borderRadius: 2, backgroundColor: screen.olive.primary, boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any}
    >
      {EDIT_MENU.map((label, i) => {
        const sel = i === index;
        // każdy wiersz ma tę samą strukturę (bullet + label + padding) → szerokość menu = najszerszy label,
        // stała niezależnie od zaznaczenia (bullet przezroczysty, gdy niezaznaczony — rezerwuje miejsce).
        return (
          <Pressable
            key={label}
            onPress={() => onPick(i)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 2, paddingRight: 4, paddingLeft: 2, borderRadius: 2, backgroundColor: sel ? color.dark21 : 'transparent' }}
          >
            <Text style={{ ...txt, color: sel ? screen.olive.primary : 'transparent', ...(sel ? phosphorGlow : null) }}>{'•'}</Text>
            <Text style={{ ...txt, color: sel ? screen.olive.primary : color.dark21, ...(sel ? phosphorGlow : null) }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function useImageEditor({
  source,
  open,
  onExit,
  onPrev,
  onNext,
  onCycleMode,
  leftHanded = false,
  promptBooster = false,
}: {
  source?: ImageSourcePropType;
  open: boolean;         // podgląd otwarty (galeria: viewerOpen)
  onExit: () => void;    // zamknij podgląd → powrót do siatki
  onPrev: () => void;    // poprzednie zdjęcie
  onNext: () => void;    // następne zdjęcie
  onCycleMode?: () => void; // kliknięcie kafelka trybu → cykl GALLERY/VIEWER/SETTINGS (tylko tryb VIEWER)
  leftHanded?: boolean;  // klawiatura lustrzana → popover menu po lewej
  promptBooster?: boolean; // ustawienie EDIT/PROMPT BOOSTER — ulepsz prompt AI przed edycją
}): { content: ReactNode; keyboard: KeyboardConfig; goBack: () => boolean; typing: boolean } {
  const [view, setView] = useState<EditView>('viewer');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  // wynik edycji (crop/AI) trzymany w sesji edytora jako URI; podmienia wyświetlane zdjęcie.
  const [workingUri, setWorkingUri] = useState<string | null>(null);
  const cropRef = useRef<CropHandle>(null);
  const displaySource: ImageSourcePropType | undefined = workingUri ? { uri: workingUri } : source;

  // AI EDIT — pisanie promptu (natywna klawiatura) + przetwarzanie.
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const [processing, setProcessing] = useState(false);
  const [boosting, setBoosting] = useState(false); // trwa ulepszanie promptu (prompt booster) przed edycją
  const [aiError, setAiError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  // SAVE — krótki komunikat po zapisie edytowanego obrazu
  const [saved, setSaved] = useState<null | 'ok' | 'denied' | 'error'>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // FILL — po kadrze z obrotem zostały puste obszary → propozycja wypełnienia AI
  const [fillOffer, setFillOffer] = useState(false);

  // zamknięcie podglądu → reset do stanu wyjściowego, żeby następne otwarcie zaczynało od VIEWER
  useEffect(() => {
    if (!open) { setView('viewer'); setMenuOpen(false); setMenuIndex(0); setWorkingUri(null); setTyping(false); setDraft(''); setProcessing(false); setBoosting(false); setAiError(null); setSaved(null); setFillOffer(false); }
  }, [open]);
  // zmiana zdjęcia (PREV/NEXT) → porzuć wynik edycji poprzedniego
  useEffect(() => { setWorkingUri(null); setFillOffer(false); }, [source]);
  // wyjście z widoku AI → zakończ pisanie; wejście w pod-widok → schowaj ofertę wypełnienia
  useEffect(() => { if (view !== 'ai') setTyping(false); if (view !== 'viewer') setFillOffer(false); }, [view]);
  // schowanie systemowej klawiatury (Android adjustNothing nie woła onBlur) → wyjście z trybu pisania
  useEffect(() => {
    if (!typing) return;
    const sub = RNKeyboard.addListener('keyboardDidHide', () => { setTyping(false); inputRef.current?.blur(); });
    return () => sub.remove();
  }, [typing]);

  const openMenu = () => { setMenuIndex(0); setMenuOpen(true); };
  const closeMenu = () => setMenuOpen(false);
  const menuMove = (d: number) => setMenuIndex((i) => Math.max(0, Math.min(EDIT_MENU.length - 1, i + d)));
  const pick = (i: number) => { setMenuOpen(false); setView(i === 0 ? 'ai' : 'crop'); };
  const toViewer = () => setView('viewer');
  // APPLY (crop) — policz i wykonaj kadr/rotację, podmień obraz roboczy, wróć do podglądu.
  // Jeśli kadr zostawił puste obszary (obrót) → zaproponuj wypełnienie AI w podglądzie.
  const applyCrop = async () => {
    const res = await cropRef.current?.apply();
    if (res?.uri) { setWorkingUri(res.uri); setFillOffer(res.needsFill); }
    setView('viewer');
  };

  // FILL — wypełnij puste obszary (po obrocie) przez AI (deAPI: z-image / qwen-edit-plus)
  const fillAI = async () => {
    if (!workingUri || processing) return;
    setProcessing(true); setAiError(null);
    try {
      const res = await fillImage({ uri: workingUri });
      if (res?.uri) setWorkingUri(res.uri);
      setFillOffer(false);
    } catch (e) {
      setAiError(e instanceof Error ? `ERROR: ${e.message}` : 'FILL FAILED');
    } finally {
      setProcessing(false);
    }
  };
  const skipFill = () => setFillOffer(false);

  // AI EDIT — sterowanie klawiaturą/promptem
  const resolveUri = (src?: ImageSourcePropType) => { try { return RNImage.resolveAssetSource(src as any)?.uri ?? ''; } catch { return ''; } };
  const openKeyboard = () => { setAiError(null); setTyping(true); setTimeout(() => inputRef.current?.focus(), 0); };
  const cancelTyping = () => { setTyping(false); inputRef.current?.blur(); };
  const sendPrompt = async () => {
    const p = draft.trim();
    if (!p || processing || boosting) return;
    setTyping(false); inputRef.current?.blur();
    const uri = resolveUri(displaySource);
    if (!uri) { setAiError('NO IMAGE SOURCE'); return; }
    setAiError(null);
    // PROMPT BOOSTER: najpierw ulepsz prompt (stub); jeśli booster padnie, jedź na oryginalnym promptcie
    let prompt = p;
    if (promptBooster) {
      setBoosting(true);
      try { const b = await boostPrompt({ prompt: p }); prompt = b.prompt || p; }
      catch { /* fallback: oryginalny prompt */ }
      finally { setBoosting(false); }
    }
    setProcessing(true);
    try {
      const res = await editImage({ uri, prompt });
      if (res?.uri) { setWorkingUri(res.uri); setDraft(''); setView('viewer'); }
    } catch (e) {
      setAiError(e instanceof Error ? `ERROR: ${e.message}` : 'EDIT FAILED');
    } finally {
      setProcessing(false);
    }
  };

  // SAVE — zapis obrazu roboczego (edytowanego) do biblioteki; krótki feedback (toast)
  const saveWorking = async () => {
    if (!workingUri) return;
    const res = await saveImageToLibrary(workingUri);
    setSaved(res);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1800);
  };
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  // back: (processing = blokada) → oferta fill → pisanie → menu → pod-widok → (false = zamknij podgląd)
  const goBack = (): boolean => {
    if (processing || boosting) return true;   // w trakcie boostu/edycji/wypełniania AI back nic nie robi (blokada)
    if (fillOffer) { setFillOffer(false); return true; }
    if (typing) { setTyping(false); return true; }
    if (menuOpen) { setMenuOpen(false); return true; }
    if (view !== 'viewer') { setView('viewer'); return true; }
    return false;
  };

  // etykieta paska statusu + status AI (deAPI). Pulsuje w trakcie przetwarzania (edycja AI / wypełnianie).
  const label = view === 'viewer' ? 'VIEWER' : 'EDIT';
  const ai: AiStatusView | undefined = boosting
    ? { lines: ['PROMPT BOOSTER', 'BOOSTING…'], pulse: true }
    : processing
      ? { lines: ['AI IMAGE EDIT', view === 'ai' ? 'PROCESSING…' : 'GENERATIVE FILL…'], pulse: true }
      : view === 'ai'
        // gdy booster aktywny → pasek zapowiada PROMPT BOOSTER WITH DEAPI (dwie linie obok ikony AI)
        ? { lines: promptBooster ? ['PROMPT BOOSTER', 'WITH DEAPI'] : ['AI IMAGE EDIT', 'WITH DEAPI'], pulse: false }
        : undefined;

  // KLAWIATURA per pod-widok/stan. VIEWER: EDIT · · joy · · MENU (EDIT/MENU otwierają menu,
  // joystick press = wyjście do siatki, L/R = prev/next — poprzednie/następne zdjęcie MA joystick, nie klawisze).
  // Menu otwarte: lewy = akcja zaznaczonej pozycji (KEYBOARD dla AI EDIT, CROP dla CROP & ROTATE),
  // prawy = CLOSE MENU; joystick góra/dół = wybór. Sloty metalowe (2/4) puste poza CROP (ROTATE ‹/›).
  // sloty metalowe (2/4) bez funkcji prev/next — WIDOCZNE puste klawisze (szkło), nie dziury
  const metalBlank: KeyboardConfig['metal'] = [{ type: 'label', upper: '' }, { type: 'label', upper: '' }];
  let keyboard: KeyboardConfig;
  if (view === 'crop') {
    // CROP & ROTATE (dwustopniowe): BACK · ROTATE‹ · joystick · ROTATE› · APPLY.
    // Joystick góra/dół = przełącz aktywny panel (rotacja ⇄ proporcje), lewo/prawo = reguluj aktywny,
    // press = APPLY. Metale = precyzyjna rotacja (zawsze). Pinch/pan na obrazie = framing.
    keyboard = {
      screen: [
        { label: 'BACK', onPress: toViewer },
        { label: 'APPLY', variant: 'primary', onPress: applyCrop },
      ],
      metal: [
        // poz. 2 = ROTATE CCW (w lewo), poz. 4 = ROTATE CW (w prawo) — górna linia ROTATE, dolna CCW/CW
        { type: 'label', upper: 'ROTATE', lower: 'CCW', active: true, onPress: () => cropRef.current?.rotateBy(-1) },
        { type: 'label', upper: 'ROTATE', lower: 'CW', active: true, onPress: () => cropRef.current?.rotateBy(1) },
      ],
      joystick: {
        highlighted: true,
        repeat: true, // przytrzymanie L/P powtarza regulację aktywnego panelu (np. ciągły obrót)
        onUp: () => cropRef.current?.focusRotation(),
        onDown: () => cropRef.current?.focusRatio(),
        onLeft: () => cropRef.current?.adjust(-1),
        onRight: () => cropRef.current?.adjust(1),
        onPress: applyCrop,
      },
    };
  } else if (view === 'ai') {
    // AI EDIT: idle → KEYBOARD(otwórz klawiaturę)·BACK; typing → CANCEL·SEND; boost/processing → klawisze wygaszone.
    if (processing || boosting) {
      keyboard = { screen: [{ label: '' }, { label: '' }], metal: metalBlank, joystick: { highlighted: false } };
    } else if (typing) {
      keyboard = {
        screen: [{ label: 'CANCEL', onPress: cancelTyping }, { label: 'SEND', variant: 'primary', onPress: sendPrompt }],
        metal: metalBlank,
        joystick: { highlighted: true, onPress: sendPrompt },
      };
    } else {
      keyboard = {
        screen: [{ label: 'KEY-\nBOARD', variant: 'primary', onPress: openKeyboard }, { label: 'BACK', onPress: toViewer }],
        metal: metalBlank,
        joystick: { highlighted: true, onPress: openKeyboard },
      };
    }
  } else if (menuOpen) {
    keyboard = {
      screen: [
        { label: menuIndex === 0 ? 'KEY-\nBOARD' : 'CROP', onPress: () => pick(menuIndex) },
        { label: 'CLOSE\nMENU', variant: 'primary', onPress: closeMenu },
      ],
      metal: metalBlank,
      joystick: {
        highlighted: true,
        onUp: () => menuMove(-1),
        onDown: () => menuMove(1),
        onPress: () => pick(menuIndex),
      },
    };
  } else {
    if (processing) {
      // trwa wypełnianie AI (fill) — klawisze wygaszone
      keyboard = { screen: [{ label: '' }, { label: '' }], metal: metalBlank, joystick: { highlighted: false } };
    } else if (fillOffer) {
      // po kadrze z obrotem: propozycja wypełnienia pustych obszarów AI
      keyboard = {
        screen: [
          { label: 'SKIP', onPress: skipFill },
          { label: 'FILL\nAI', variant: 'primary', onPress: fillAI },
        ],
        metal: metalBlank,
        joystick: { highlighted: true, onPress: fillAI },
      };
    } else {
      keyboard = {
        // 1 = BACK (wyjście z podglądu), 2 = EDIT (menu edycji); 5 = SAVE gdy jest edycja, inaczej MENU
        screen: [
          { label: 'BACK', onPress: onExit },
          workingUri
            ? { label: 'SAVE', variant: 'primary', onPress: saveWorking }
            : { label: 'MENU', onPress: openMenu },
        ],
        metal: [{ type: 'label', upper: 'EDIT', onPress: openMenu }, { type: 'label', upper: '' }],
        joystick: {
          highlighted: true,
          onLeft: onPrev,
          onRight: onNext,
          onPress: onExit,
        },
      };
    }
  }

  const content = (
    <>
      <ScreenTopBar mode="VIEWER" label={label} onCycleMode={view === 'viewer' ? onCycleMode : undefined} ai={ai} labelActive />
      <View style={{ flex: 1, alignSelf: 'stretch' }}>
        {/* content_area: przy otwartym menu przygaszona do 25% widoczności (menu zostaje pełne) */}
        <View style={{ flex: 1, alignSelf: 'stretch', opacity: menuOpen && view === 'viewer' ? 0.25 : 1 }}>
          {view === 'viewer' ? (
            displaySource ? <ZoomImage key={workingUri ?? String((source as any)?.uri ?? source)} source={displaySource} /> : null
          ) : view === 'crop' ? (
            displaySource ? <CropStage ref={cropRef} source={displaySource} /> : null
          ) : (
            displaySource ? (
              <AiStage
                source={displaySource}
                draft={draft}
                typing={typing}
                processing={processing}
                error={aiError}
                inputRef={inputRef}
                onChangeText={setDraft}
                onSubmit={sendPrompt}
                onBlur={() => setTyping(false)}
                onOpenKeyboard={openKeyboard}
              />
            ) : null
          )}
        </View>
        {/* menu EDIT — popover nad obrazem (prawy-dolny róg), tylko w widoku VIEWER */}
        {menuOpen && view === 'viewer' ? <EditMenu index={menuIndex} onPick={pick} leftHanded={leftHanded} /> : null}

        {/* propozycja wypełnienia AI (puste obszary po obrocie) — banner przy dolnej krawędzi */}
        {view === 'viewer' && fillOffer && !processing ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center', paddingHorizontal: 16 }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 2, backgroundColor: screen.olive.primary, ...({ boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any) }}>
              <Text style={{ fontFamily: font.monoBody.family, fontSize: font.monoBody.size, color: color.dark21, textAlign: 'center' }}>
                {'FILL EMPTY AREAS WITH GENERATIVE AI?'}
              </Text>
            </View>
          </View>
        ) : null}

        {/* nakładka przetwarzania (wypełnianie AI) */}
        {view === 'viewer' && processing ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(26,26,26,0.55)' }}>
            <Text style={{ fontFamily: font.monoLabel.family, fontSize: 14, letterSpacing: 2, color: screen.olive.primary, ...phosphorGlow }}>
              GENERATIVE FILL…
            </Text>
          </View>
        ) : null}

        {/* toast SAVE — fosforowa pigułka przy dolnej krawędzi */}
        {saved ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 8, alignItems: 'center' }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 2, backgroundColor: screen.olive.primary, ...({ boxShadow: '0px 0px 4px 0px rgba(226,255,228,0.25)' } as any) }}>
              <Text style={{ fontFamily: font.bodyLgBold.family, fontSize: font.bodyLgBold.size, color: color.dark21 }}>
                {saved === 'ok' ? 'SAVED' : saved === 'denied' ? 'NO SAVE PERMISSION' : 'SAVE FAILED'}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </>
  );

  return { content, keyboard, goBack, typing };
}
