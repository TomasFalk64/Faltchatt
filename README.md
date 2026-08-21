# Fältchatt

En första webb-MVP för gruppbaserad fältkommunikation: Supabase Auth, grupper med godkännande, Leaflet-karta, GPS-positioner, gruppchatt, platsmeddelanden, polls och GeoTIFF-karta via Supabase Storage.

## Arkitektur

- Frontend: Vite + modern vanilla JavaScript i moduler under `src/`.
- Karta: Leaflet med OpenStreetMap som baskarta.
- GeoTIFF: `georaster` och `georaster-layer-for-leaflet`, läst från privat Supabase Storage-bucket.
- Backend: Supabase direkt från frontend med anon/publishable key.
- Databas: PostgreSQL med RLS, RPC-funktioner, Realtime och Storage policies.

## Kom igång lokalt

1. Installera beroenden:

   ```bash
   npm install
   ```

2. Skapa `.env.local`:

   ```bash
   cp .env.example .env.local
   ```

3. Fyll i:

   ```text
   VITE_SUPABASE_URL=
   VITE_SUPABASE_ANON_KEY=
   ```

4. Kör Supabase-migrationerna enligt [SUPABASE_SETUP.md](./SUPABASE_SETUP.md).

5. Starta appen:

   ```bash
   npm run dev
   ```

## Testa med två användare

1. Öppna appen i två olika webbläsare eller en vanlig och en privat flik.
2. Skapa två konton med olika e-postadresser.
3. Användare A skapar en grupp och kopierar gruppkoden.
4. Användare B går med via gruppkoden och får status `pending`.
5. Användare A går till Grupp och godkänner B.
6. Båda kan nu använda karta, chatt, polls och positionsdelning.

## Projektstruktur

```text
src/
  auth.js
  chat.js
  geotiff.js
  groups.js
  main.js
  map.js
  state.js
  supabase.js
  ui.js
  styles.css

supabase/migrations/
  001_initial_schema.sql
  002_rls_policies.sql
  003_realtime.sql
  004_storage.sql
  005_rpc_grants.sql
  006_fix_join_code_function.sql
  007_profile_symbol_color_alias.sql
```

## Databastabeller

Appen använder `profiles`, `groups`, `group_members`, `locations`, `messages`, `questions`, `question_options` och `question_answers`.

## Kända begränsningar

- Webbläsare kan stoppa GPS när mobilen är låst eller fliken ligger i bakgrunden.
- GeoTIFF-stöd beror på filens georeferering och projektion.
- Första versionen stödjer små GeoTIFF-filer, cirka 1-5 MB.
- Ingen offline-synk, push-notiser, bilder i chatten eller native-app ingår.
- Produktionsbuilden blir stor eftersom GeoTIFF-biblioteken drar in många moduler; code splitting är ett rimligt nästa steg.

## Verifiering

Kört:

```bash
npm run build
```

Builden gick igenom. `npm install` rapporterade sårbarheter i dependency-trädet, främst transitive paket från äldre GIS-bibliotek. Kör `npm audit` innan produktion och byt GeoTIFF-stack om auditkraven är hårda.
