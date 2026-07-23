# Ikony na klawiszach — propozycja zamiany tekstów

Lista wszystkich klawiszy w apce (stan 0.958) z propozycją ikony. Nic z tego nie jest jeszcze
zaimplementowane — w projekcie nie ma dziś zestawu ikon, jedyna istniejąca to `DeApiIcon`
(`src/components/icons.tsx`).

## Nawigacja i stan

- BACK → strzałka w lewo `←` (najczęstszy klawisz w apce)
- CLOSE → krzyżyk `✕` (świadomie inna niż BACK — zamknięcie, nie cofnięcie)
- EXIT → wyjście z drzwi / `⏻` (ma `[HOLD]` → ikona plus pierścień postępu)
- MENU → trzy kreski `☰`
- CLOSE MENU → `☰` przekreślone albo `✕` (dziś dwuwierszowy tekst — ikona zyskuje najwięcej)
- CONFIRM → ptaszek `✓`
- CANCEL → `✕` (kolizja z CLOSE — rozważyć `↶` albo zostawić tekst)
- SKIP → `⏭` (onboarding)
- START → `▶` (onboarding)

## Widok galerii

- SIZE → cztery kwadraty ⇄ dziewięć kwadratów (przełącznik 2/3 kolumn — ikona ma pokazywać STAN DOCELOWY)
- FEED → pionowy strumień kafli różnej wielkości
- FOLDERS → folder (para z FEED, jedna ikona w dwóch stanach)
- TOGGLE → przełącznik
- FULLSCREEN → strzałki na zewnątrz `⤢`

## Edycja

- EDIT → ołówek / suwaki
- CLOSE EDIT → ołówek przekreślony (dziś dwuwierszowy)
- SAVE → dyskietka lub `↓` do kreski
- APPLY → ptaszek (kolizja z CONFIRM — rozważyć „ptaszek w ramce")
- RESET → `↺`
- UNDO → `↶`
- SEND → samolocik / `→`
- FILL AI → gwiazdka AI + pędzel (dziś dwuwierszowy)
- KEYBOARD → klawiatura (dziś dwuwierszowy)

## Zaznaczanie i kosz

- TRASH → kosz
- DELETE → kosz przekreślony albo kosz + `✕` (musi się WYRAŹNIE różnić od TRASH — to operacja trwała)
- RESTORE → strzałka z kosza w górę

## Podgląd

- INFO → `i` w kółku
- HIDE INFO → `i` przekreślone (dziś dwuwierszowy)

## Do rozważenia przed wdrożeniem

- Najwięcej zyskują klawisze dwuwierszowe — CLOSE EDIT, FILL AI, HIDE INFO, KEYBOARD, CLOSE MENU.
  Tekst się tam łamie i jest najmniej czytelny.
- Trzy pary są ryzykowne, bo znaczeniowo bliskie: CLOSE i CANCEL, CONFIRM i APPLY, TRASH i DELETE.
  Przy samych ikonach różnica może zniknąć — te warto zostawić z tekstem albo dać ikonę z podpisem.
- Klawisze z `[HOLD]` (EXIT, DELETE) mają dolny wiersz z etykietą i pierścień postępu — sprawdzić,
  czy ikona nie zderzy się z tą kompozycją.
