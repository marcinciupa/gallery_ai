# gallery-ai-proxy

Cienki backend-proxy między apką **gallery_ai** a **deAPI** (OpenAI-compatible).
Trzyma klucz deAPI po stronie serwera — apka nigdy go nie widzi.

```
Apka (Expo) ──multipart(image,prompt)──►  proxy  ──OpenAI SDK──►  deAPI /v1/images/edits
                                       ◄──── { uri } ─────────◄──── { data:[{url}] }
```

## Endpointy (kontrakt zgodny z `src/lib/deapi.ts` w apce)

| Metoda | Ścieżka | Body (multipart) | Odpowiedź |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ok, model, steps }` |
| `POST` | `/api/v1/image-edits` | `image` (plik), `prompt` (tekst, **EN**) | `{ uri }` |
| `POST` | `/api/v1/image-fills` | `image` (plik) | `{ uri }` |

Każdy `/api/*` wymaga nagłówka `X-App-Key` równego `APP_KEY` (jeśli ustawiony).
Wszystkie prompty wysyłane do deAPI są **po angielsku** (modele działają najlepiej na EN);
edycja dokłada flagę `enhance_prompt=1` (prompt booster).

## Uruchomienie lokalne

```bash
cd server
cp .env.example .env      # i uzupełnij DEAPI_API_KEY + APP_KEY
npm install
npm start                 # http://localhost:8787  (dev: npm run dev — watch)
```

Szybki test:
```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/api/v1/image-edits \
  -H "X-App-Key: <APP_KEY>" \
  -F "prompt=Apply warm cinematic color grading" \
  -F "image=@../assets/mock/space/galaxy.jpg"
```

## Konfiguracja (`.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DEAPI_API_KEY` | — | **wymagane**. Klucz deAPI w formacie `<id>\|<token>` (np. `13660\|…`). Wklej 1:1 z panelu deAPI — **bez żadnego prefiksu**. |
| `DEAPI_BASE_URL` | `https://oai.deapi.ai/v1` | endpoint OpenAI-compatible |
| `DEAPI_MODEL` | `Flux_2_Klein_4B_BF16` | model edycji |
| `DEAPI_STEPS` | `4` | kroki (Flux.2 Klein = distilled) |
| `DEAPI_FILL_MODEL` | = `DEAPI_MODEL` | opcjonalny model do generative-fill |
| `DEAPI_FILL_STEPS` | = `DEAPI_STEPS` | opcjonalne kroki do fill |
| `APP_KEY` | — | współdzielony sekret apka↔proxy |
| `ALLOWED_ORIGINS` | porty Expo web | CORS (po przecinku); natywne żądania i tak przechodzą (brak Origin) |
| `PORT` | `8787` | Railway wstrzykuje własny `PORT` |

Zmiana modelu/kroków = **tu**, bez przebudowy APK.
Inne modele edycji z deAPI: `QwenImageEdit_Plus_NF4` (mocny w instrukcjach), `ZImageTurbo_INT8` (najszybszy).

## Deploy na Railway

1. `New Project → Deploy from GitHub repo` (albo `railway up` z folderu `server/`).
2. **Root Directory** = `server` (Settings → Root Directory), jeśli deployujesz z monorepo.
3. Zmienne środowiskowe (Variables) — przepisz z `.env`:
   `DEAPI_API_KEY`, `APP_KEY`, `DEAPI_MODEL`, `DEAPI_STEPS`. **Nie ustawiaj `PORT`** — Railway wstrzykuje własny.
4. Start command: `npm start` (Railway wykryje z `package.json`). Node ≥ 20.
5. Po deployu weź publiczny URL (`https://…up.railway.app`) i wpisz go w apce:
   `EXPO_PUBLIC_API_URL` w głównym `.env` projektu.

## Testy na telefonie (Expo Go, DEV)

- Telefon i komputer w tej samej sieci WiFi.
- W głównym `.env` apki: `EXPO_PUBLIC_API_URL=http://<LAN-IP>:8787` (tu: `http://192.168.0.150:8787`).
- Odpal `npm start` w `server/` oraz `npm start` w apce; zeskanuj QR w Expo Go.

## Uwagi

- Wynikowy URL z deAPI jest podpisany i wygasa po ~5 h — wystarcza do podglądu i zapisu tuż po edycji.
- deAPI nie ma maskowanego inpaintingu (mask → 400), więc `image-fills` używa edycji z promptem
  domalowującym puste krawędzie. Jakość dopracować na realnym zdjęciu (ewentualnie zmienić `DEAPI_FILL_MODEL`).
