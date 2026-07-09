// Numer builda (jedno źródło prawdy dla wyświetlania w apce). Trzymać w synchronie z app.json:
//   version === APP_VERSION,  versionCode === round(APP_VERSION * 10000)  (0.900 → 9000, 0.9005 → 9005, 0.901 → 9010).
// Konwencja (jak rec_ai): zmiana normalna = +0.001 (3. cyfra: 0.900 → 0.901); mała zmiana = 4. cyfra (0.900 → 0.9005).
// versionCode ×10000, żeby 4. cyfra dawała unikalny, ROSNĄCY versionCode dla Google Play.
export const APP_VERSION = '0.921';
