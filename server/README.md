# gallery-ai-proxy

Cienki backend-proxy między apką **gallery_ai** a **deAPI** (natywny REST **v2**, `api.deapi.ai`).
Trzyma klucz deAPI po stronie serwera — apka nigdy go nie widzi.

```
Apka (Expo) ──multipart(image,prompt)──►  proxy  ──submit──►  deAPI v2 /images/{edits,background-removals}
                                       ◄──── { uri } ──────◄── webhook /webhooks/deapi  (fallback: polling /jobs/{id})
```

deAPI v2 jest **asynchroniczne**: submit zwraca `request_id`, wynik odbieramy **webhookiem** (szybko) z
**fallbackiem na polling** (pewność). Apka dostaje odpowiedź **synchronicznie** — proxy trzyma połączenie do
czasu wyniku, więc kontrakt HTTP apki się nie zmienia (bez przebudowy AAB przy zmianach backendu).

## Endpointy (kontrakt zgodny z `src/lib/deapi.ts` w apce)

| Metoda | Ścieżka | Body | Odpowiedź |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ok, editModel, bgModel, steps, webhooks }` |
| `POST` | `/api/v1/image-edits` | multipart `image`, `prompt` (**EN**) | `{ uri }` |
| `POST` | `/api/v1/image-fills` | multipart `image` | `{ uri }` |
| `POST` | `/api/v1/remove-background` | multipart `image` | `{ uri }` (dedykowany model, np. Ben2) |
| `POST` | `/api/v1/upscale` | multipart `image` | `{ uri }` (dedykowany model, np. RealESRGAN_x4) |
| `POST` | `/api/v1/image-erase` | multipart `image` | `{ uri }` |
| `POST` | `/api/v1/prompt-boost` | json `{ prompt }` | `{ prompt }` (passthrough) |
| `POST` | `/webhooks/deapi` | raw JSON od deAPI | `{ ok }` (autoryzacja podpisem HMAC, **nie** X-App-Key) |

Każdy `/api/*` wymaga nagłówka `X-App-Key` równego `APP_KEY` (jeśli ustawiony). `/webhooks/deapi` jest poza
`/api` i autoryzowany podpisem `X-DeAPI-Signature` = `HMAC-SHA256(DEAPI_WEBHOOK_SECRET, timestamp + "." + raw_body)`.
Wszystkie prompty do deAPI są **po angielsku**.

## Uruchomienie lokalne

```bash
cd server
cp .env.example .env      # i uzupełnij DEAPI_API_KEY + APP_KEY
npm install
npm start                 # http://localhost:8787  (dev: npm run dev — watch)
```

Lokalnie webhooki są **OFF** (deAPI nie dosięgnie localhost) → proxy używa pollingu. To wystarcza do testów.

Szybki test:
```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/api/v1/remove-background \
  -H "X-App-Key: <APP_KEY>" \
  -F "image=@../assets/figma/body_texture.png;type=image/png"
```

## Konfiguracja (`.env`)

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DEAPI_API_KEY` | — | **wymagane**. Klucz deAPI `<id>\|<token>`. Prefiks `dpn-sk-` jest odcinany na potrzeby REST v2 — możesz trzymać klucz z prefiksem lub bez. |
| `DEAPI_V2_BASE_URL` | `https://api.deapi.ai` | baza REST v2 (raczej nie zmieniać) |
| `DEAPI_MODEL` | `Flux_2_Klein_4B_BF16` | model edycji img2img (alt.: `QwenImageEdit_Plus_NF4`) |
| `DEAPI_STEPS` | `4` | kroki edycji (Flux.2 Klein = distilled) |
| `DEAPI_BG_MODEL` | `Ben2` | dedykowany model usuwania tła (alt.: `RMBG-1.4`) |
| `DEAPI_UPSCALE_MODEL` | `RealESRGAN_x4` | dedykowany model upscalu (x4) |
| `DEAPI_WEBHOOK_SECRET` | — | sekret HMAC do weryfikacji webhooków (min. 32 zn.). Bez niego → polling. |
| `PUBLIC_URL` | z `RAILWAY_PUBLIC_DOMAIN` | publiczny URL proxy do `webhook_url`. Na Railway wykrywany automatycznie. |
| `APP_KEY` | — | współdzielony sekret apka↔proxy |
| `ALLOWED_ORIGINS` | porty Expo web | CORS (po przecinku); natywne żądania i tak przechodzą |
| `PORT` | `8787` | Railway wstrzykuje własny `PORT` |

Zmiana modelu/kroków = **tu**, bez przebudowy APK.

## Deploy na Railway

1. `railway up` z folderu `server/` (service `gallery-ai-backend`).
2. Zmienne (Variables): `DEAPI_API_KEY`, `APP_KEY`, `DEAPI_MODEL`, `DEAPI_STEPS`, `DEAPI_BG_MODEL`,
   **`DEAPI_WEBHOOK_SECRET`** (żeby włączyć webhooki). **Nie ustawiaj `PORT` ani `PUBLIC_URL`** — Railway
   wstrzykuje `PORT` i `RAILWAY_PUBLIC_DOMAIN` sam.
3. Start command: `npm start` (Node ≥ 20).
4. Publiczny URL wpisz w apce jako `EXPO_PUBLIC_API_URL` (główny `.env` + EAS env `production`).

Webhooki włączają się automatycznie, gdy w Railway jest `DEAPI_WEBHOOK_SECRET` (i publiczny domain). Bez tego
proxy działa poprawnie na pollingu.

## Uwagi

- Wynikowy URL z deAPI jest podpisany i wygasa po kilku godzinach — apka od razu ściąga go do pliku (`localFile.ts`).
- deAPI v2 `edits` wymaga pola `seed` — proxy losuje je per żądanie.
- Usuwanie tła idzie **dedykowanym modelem** (Ben2/RMBG) — prawdziwy alpha-cutout, nie edycja Flux na białe tło.
- `image-erase` bez maski jest ogólne; gdy apka zacznie wysyłać maskę, podłączymy inpaint z maską.
