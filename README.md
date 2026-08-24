# Fältchatt

Fältchatt är en webb-MVP för gruppbaserad fältkommunikation. Appen använder Supabase för inloggning, grupper, godkända medlemskap, chatt, polls, positioner, Realtime och privat lagring av GeoTIFF-kartor.

## Funktioner

- Konto med e-post/lösenord, e-postbekräftelse och lösenordsåterställning.
- Profil med alias, färg och personlig symbol. E-post ligger bara i Supabase Auth.
- Grupper med gruppkod, pending/godkända medlemskap och owner/admin-godkännande.
- Notisprickar i sidnaven för pending medlemskap och olästa chattmeddelanden.
- Leaflet-karta med OpenStreetMap, egen position och gruppmedlemmars senaste positioner.
- Platsmeddelanden från kartan till chatten, med möjlighet att dölja platsnålar lokalt.
- GeoTIFF-uppladdning till Supabase Storage, lista över uppladdade kartor, visa/dölj och radera.
- Gruppchatt med ljudnotis från `public/data/golgroda.mp3` vid nya meddelanden från andra.
- Polls i chatten med svarsalternativ och enkel sammanställning.
- Integritetssida som beskriver lagrade uppgifter, positionsdelning och kontoradering.
- Loggruta i vänsterspalten för händelser och felmeddelanden.

## Teknik

- Frontend: Vite och vanilla JavaScript-moduler i `src/`.
- Karta: Leaflet och OpenStreetMap.
- GeoTIFF: `georaster`, `georaster-layer-for-leaflet` och `proj4-fully-loaded`.
- Backend: Supabase direkt från frontend med anon/publishable key.
- Databas: PostgreSQL med RLS, RPC-funktioner och Realtime.
- Storage: privat Supabase bucket `group-maps`.

## Kom Igång Lokalt

Installera beroenden:

```bash
npm install
```

Skapa `.env.local` i projektroten:

```bash
cp .env.example .env.local
```

Fyll i:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

Kör Supabase-migrationerna enligt [SUPABASE_SETUP.md](./SUPABASE_SETUP.md).

Starta appen:

```bash
npm run dev
```

På Windows/PowerShell kan `npm.ps1` ibland blockeras av execution policy. Då fungerar ofta:

```powershell
cmd /c npm run dev
```

## Supabase

Appen kräver migrationerna i `supabase/migrations/` i nummerordning. De skapar tabeller, RLS policies, RPC-funktioner, Realtime-publication och Storage bucket.

Viktigt för auth:

- Använd bara Supabase anon/publishable key i frontend.
- Lägg till lokal redirect URL, exempelvis `http://127.0.0.1:5173`, i Supabase Auth settings.
- Supabase standardmail har låg rate limit. För rimlig testning behövs ofta custom SMTP, till exempel Brevo eller Resend.
- Lösenordsåterställning loggar in användaren i recovery-läge; appen visar då formulär för nytt lösenord i Profil.
- Fältchatts vanliga tabeller ska inte lagra e-postadresser eller mobilnummer.

## Projektstruktur

```text
src/
  auth.js        konto, profil och lösenordsåterställning
  chat.js        chatt, polls, ljudnotis och oläststatus
  geotiff.js     uppladdade GeoTIFF-lager via Supabase Storage
  groups.js      grupper, medlemskap och adminflöde
  main.js        bootstrap, laddning och Realtime-prenumerationer
  map.js         Leaflet-karta, positioner och platsmeddelanden
  state.js       klientstate och lokalt sparade val
  supabase.js    Supabase-klient
  ui.js          gemensam DOM/UI, symboler, logg och nav
  styles.css     layout och komponentstilar

public/data/
  golgroda.mp3   ljudnotis för ny chatt

supabase/migrations/
  001_initial_schema.sql
  ...
  012_repair_profile_symbol_constraint.sql
```

## Kända Begränsningar

- Webbläsare kan strypa GPS och timers när fliken är i bakgrunden eller enheten sparar ström.
- Andra medlemmars position kan inte tvingas fram från din webbläsare; appen kan bara läsa deras senast sparade position.
- Ljudnotiser kräver att användaren först interagerat med sidan, enligt webbläsarens ljudregler.
- GeoTIFF-stöd beror på filens georeferering och projektion.
- Storage-migrationen har låg filstorleksgräns för GeoTIFF, ungefär 5 MB.
- Ingen offline-synk, push-notiser eller native-app ingår ännu.
- Produktionsbuilden är stor eftersom GeoTIFF-biblioteken drar in många moduler.


