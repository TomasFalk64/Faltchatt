# Supabase-setup

Använd aldrig `service_role`-nyckeln i frontend. Appen ska bara använda projektets anon/publishable key i `.env.local`.

## 1. Skapa Supabase-projekt

Skapa ett Supabase-projekt och kopiera:

- Project URL till `VITE_SUPABASE_URL`
- Anon/public key till `VITE_SUPABASE_ANON_KEY`

## 2. Kör SQL-migrationer

Om Supabase CLI används:

```bash
supabase link --project-ref DIN_PROJECT_REF
supabase db push
```

Om du använder SQL Editor i Dashboard, kör filerna i denna ordning:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_rls_policies.sql`
3. `supabase/migrations/003_realtime.sql`
4. `supabase/migrations/004_storage.sql`
5. `supabase/migrations/005_rpc_grants.sql`
6. `supabase/migrations/006_fix_join_code_function.sql`
7. `supabase/migrations/007_profile_symbol_color_alias.sql`
8. `supabase/migrations/008_profile_symbol_choices.sql`
9. `supabase/migrations/009_profile_symbol_final_set.sql`
10. `supabase/migrations/010_add_mushroom_symbol.sql`
11. `supabase/migrations/011_pending_membership_visibility.sql`
12. `supabase/migrations/012_repair_profile_symbol_constraint.sql`
13. `supabase/migrations/013_owner_clear_group_content.sql`
14. `supabase/migrations/014_fun_mushroom_join_codes.sql`
15. `supabase/migrations/015_owner_delete_group.sql`
16. `supabase/migrations/016_leave_group.sql`
17. `supabase/migrations/017_profile_show_phone.sql`
18. `supabase/migrations/018_group_invites.sql`
19. `supabase/migrations/019_locations_delete_own.sql`
20. `supabase/migrations/020_group_presence.sql`
21. `supabase/migrations/021_delete_account_cleanup.sql`
22. `supabase/migrations/022_privacy_simplification.sql`
23. `supabase/migrations/023_fix_create_group_profile_privacy.sql`
24. `supabase/migrations/024_random_initial_profile_symbol.sql`
25. `supabase/migrations/025_temporary_groups_limits.sql`
26. `supabase/migrations/026_expand_fun_join_code_words.sql`
27. `supabase/migrations/027_guest_access.sql`
28. `supabase/migrations/028_schedule_guest_cleanup.sql`
29. `supabase/migrations/029_delete_guest_account.sql`

## 3. Authentication

I Dashboard, gå till Authentication:

- Aktivera Email provider.
- Välj om e-postbekräftelse ska krävas.
- Lägg in redirect URLs för både lokal test och publicerad app, exempelvis `http://127.0.0.1:5173/Faltchatt/` och `https://tomasfalk64.github.io/Faltchatt/`.

### Gästläge och robotskydd

Gör inställningarna nedan innan gästinloggning aktiveras i produktion:

1. Kör migrationerna 027–029 som `postgres` (SQL Editor eller CLI). Om 027 och 028 redan är körda, kör bara 029. 028 aktiverar `pg_cron` och schemalägger rensning varje hel timme. 027 stoppar om befintliga gäster redan överskrider 100 eller har admin-/ägarroller; granska dessa manuellt först. 029 möjliggör omedelbar gästradering. Deploya därefter den uppdaterade `delete-my-account`-funktionen och frontend.
2. Skapa en **Managed** Cloudflare Turnstile-widget med appens värdnamn tillåtna. Lägg den offentliga webbplatsnyckeln i `VITE_TURNSTILE_SITE_KEY` i `.env.local` och i GitHub Actions repository variables. Bygg om appen efter ändringen.
3. Under Supabase Authentication → Bot and Abuse Protection, aktivera CAPTCHA och välj Turnstile. Lägg **hemliga** Turnstile-nyckeln endast där, aldrig i Vite eller GitHub Pages. CAPTCHA verifieras av Supabase Auth, inte bara av gränssnittet. Inställningen omfattar även vanlig registrering, lösenordsinloggning och återställning; appen skickar därför CAPTCHA-token i samtliga dessa flöden.
4. Behåll gränsen **30 anonyma inloggningar per timme och IP** i Supabase Auth rate limits. Detta är en Dashboard-inställning, inte något SQL-migrationen kan konfigurera.
5. Aktivera **Allow anonymous sign-ins** sist. Stäng av den inställningen för att tillfälligt stoppa nya gäster vid missbruk. Befintliga sessioner påverkas inte av nyregistreringsgränsen.

Utan en Turnstile-webbplatsnyckel tillåter gränssnittet inte nytt gästinträde. Säkerheten kräver ändå att CAPTCHA verkligen är aktiverad i Supabase, eftersom Auth API kan anropas direkt.

Serverregler i 027:

- Exakt 100 låsbara gästplatser i ett privat schema. Triggern på `auth.users` tilldelar en plats atomärt och avvisar även direkta Auth-anrop när det är fullt. Ett misslyckat försök rullar tillbaka hela skapandet. Befintliga gäster räknas in vid migrationen.
- Gäster får inte skapa/äga grupper eller tilldelas admin-/ägarroll, inte heller genom automatisk ägaröverföring. Profilens `is_guest` bestäms av servern.
- 5 gruppkodsförsök per minut och användare, inklusive felaktiga koder. RPC:n `request_group_membership` returnerar nu `{group_id}` eller `{error}`. Deploya frontend tillsammans med migrationen.
- 20 meddelanden/minut (max 4 000 tecken), varav högst 10 platsnålar/minut. 30 positions-, närvaro- respektive svarsuppdateringar/minut. Profil/poll: 20/minut; pollalternativ: 100/minut. Gränserna gäller per användare, över alla grupper, även vanliga konton. De begränsar accepterade skrivningar, inte alla inkommande HTTP-anrop.
- Rensning efter minst 24 timmars inaktivitet, även för gäster som aldrig skapade en profil eller gick med i en grupp. Synlig app skickar aktivitet varje minut, även utan vald grupp. Skrivningar i appen räknas också som aktivitet. Tidsstämplar för gästrensning sätts på servern.
- Utloggning tar bort egen position/närvaro i alla grupper och avslutar sessionen. Användaren och medlemskapen finns kvar fram till rensningen. Gästens meddelanden, polls, svar och platsnålar behålls vid rensning med tom användarkoppling och visas som ”Tidigare gäst”. Vanliga kontons befintliga raderingsbeteende behålls.
- Gamla gäster undantas från den separata tolvmånadersrensningen för vanliga konton.

Omedelbar gästradering i 029: knappen **Radera min gästprofil** kräver uttrycklig bekräftelse och skickar `{confirmGuest: true}` till `delete-my-account`. Funktionen verifierar sessionen med Auth och använder endast den verifierade användarens ID. En anonym användare behöver ingen e-postbekräftelse. Den nya RPC:n `delete_guest_account` får endast anropas med `service_role`, kontrollerar att kontot är anonymt och bevarar bidragen samt raderar kontot i en transaktion. Profil, medlemskap, position/närvaro och interna räknare raderas genom databasens foreign keys; gästplatsen frigörs direkt. Vanliga konton behöver fortfarande bekräfta sin e-postadress och använder det tidigare raderingsflödet. Vanlig utloggning är oförändrad.

Kontrollera schemat och körhistoriken i Supabase Cron. För SQL Editor:

```sql
select jobid, schedule, active from cron.job where jobname = 'faltchatt-cleanup-guests';
select status, return_message, start_time from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'faltchatt-cleanup-guests')
order by start_time desc limit 10;
select count(*) as guests from auth.users where is_anonymous;
```

Följ Auth-felfrekvens, gästantal, databasbelastning och Realtime-användning i Dashboard. Robotskydd, skrivgränser och kontotak är inte ett generellt skydd mot all överbelastning.

Dokumentation: [Supabase anonymous sign-ins](https://supabase.com/docs/guides/auth/auth-anonymous), [CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha), [rate limits](https://supabase.com/docs/guides/auth/rate-limits).

### Testa gästläget

Kör `npm test` för SQL/RLS/trigger-tester med lokal PGlite och `npm run build` för produktionsbygget. PGlite ersätter inte integrationstest av Supabase Auth, samtidiga databasanslutningar, Turnstile, Storage eller pg_cron.

Verifiera följande i ett separat Supabase-testprojekt innan produktionsaktivering:

- Gästfliken har en knapp, kräver inga kontouppgifter och skapar en anonym användare efter Turnstile. Utan giltig CAPTCHA-token ska även direkt `signInAnonymously` avvisas.
- Vanlig inloggning, registrering och lösenordsåterställning fungerar med CAPTCHA aktiverad.
- En väntande gäst ser inte chatt/karta. Godkännande öppnar dem. Profil, alias, symbol, färg och positionsreglage fungerar. Skapa grupp är gråat. Gästen går inte att välja som admin. **Radera min gästprofil** är tillgänglig och kräver bekräftelse utan e-post.
- När 99 gäster finns: skicka flera parallella Auth-anrop med varsin giltig CAPTCHA-token. Högst ett får skapa en gäst; antalet ska aldrig överstiga 100. Vanliga konton och befintliga gäster fungerar när det är fullt.
- Fel gruppkod fem gånger spärrar nästa försök under resten av minutperioden. Kontrollera med direkt RPC-anrop också.
- Utloggning lämnar Auth-användaren kvar, rensar live-data och nästa gästinträde skapar en ny användare. Stängning/återöppning med giltig session återanvänder gästen.
- Radera en gästprofil: Auth-användare, profil, medlemskap och live-data försvinner direkt medan chatt, platsnålar och polls ligger kvar. Avbryt bekräftelsen och kontrollera att inget raderas. Kontrollera också att ett vanligt konto fortfarande kräver rätt e-postadress.
- I testprojektet: sätt en utvald gästs `private.guest_slots.last_seen` till äldre än 24 timmar och kör `select private.cleanup_guests();`. Profil/medlemskap försvinner medan chatt/platsnålar/polls finns kvar. Öppna sedan den gamla gästens webbläsare: den ska återgå till inloggningssidan. Verifiera också att schemat körs automatiskt.

## 4. Storage

Migrationen skapar bucket `group-maps` som privat bucket med 5 MiB filgräns. Migration `030_map_tiles.sql` tillåter även PNG och JSON för förberedda kartor. Befintliga behörigheter gäller även filer i underkataloger.

Filvägarna följer:

```text
group-maps/{group_id}/{uuid}.tif
group-maps/{group_id}/{map_id}.tiles.json
group-maps/{group_id}/{map_id}/{z}-{x}-{y}.png
```

Policies tillåter:

- approved gruppmedlemmar att läsa gruppens karta
- owner/admin att ladda upp, ersätta och ta bort gruppens karta

## 5. Realtime

Migrationen lägger följande tabeller i `supabase_realtime`:

- `group_members`
- `locations`
- `messages`
- `questions`
- `question_answers`

Om SQL Editor säger att en tabell redan finns i publication kan du ignorera den raden eller ta bort motsvarande `alter publication`-rad och köra igen.

## 6. Edge Functions

Kontoradering och framtida inaktivitetsstädning körs server-side via Supabase Edge Functions. Service role key får aldrig ligga i frontend eller `.env.local`.

Deploya vid behov:

```bash
supabase functions deploy delete-my-account
supabase functions deploy cleanup-inactive-accounts
supabase functions deploy cleanup-expired-groups
```

`delete-my-account` använder `SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY`, som normalt redan finns i Edge Function-miljön.

`cleanup-expired-groups` raderar grupper vars 7-dagars giltighetstid har gått ut och tar även bort gruppens GeoTIFF-filer från Storage. Den kan schemaläggas server-side en gång per dygn, till exempel kl. 03:00.

`cleanup-inactive-accounts` är grunden för automatisk radering efter 12 månaders inaktivitet. Den kan köras från en server-side scheduler och hämtar eventuell e-post bara från Supabase Auth. Om varningsmail ska skickas cirka 30 dagar innan radering behövs Brevo-secrets i Edge Function-miljön:

```bash
supabase secrets set BREVO_API_KEY=din_brevo_api_key
supabase secrets set BREVO_SENDER_EMAIL=avsandare@example.com
supabase secrets set BREVO_SENDER_NAME=Fältchatt
supabase secrets set FALTCHATT_APP_URL=https://tomasfalk64.github.io/Faltchatt/
supabase secrets set INACTIVE_ACCOUNT_CLEANUP_SECRET=valfri_hemlig_strang
supabase secrets set EXPIRED_GROUP_CLEANUP_SECRET=valfri_hemlig_strang
```

Grupputskick via e-post och e-postbaserad medlemsimport används inte längre. Inbjudan sker med gruppkod eller invite-länk.

## 7. RLS-regler

RLS är aktivt på alla apptabeller.

Grundprinciperna:

- Profiler: användaren kan läsa och uppdatera sig själv samt läsa godkända gruppmedlemmars begränsade profilinfo. E-post och mobilnummer ska inte finnas i apptabellerna.
- Grupper: endast godkända medlemmar kan läsa pågående grupper; owner/admin kan uppdatera administrativa fält innan gruppen gått ut. Grupper lever i 7 dagar.
- Medlemskap: användare går med via `request_group_membership`; owner/admin kan godkänna och avvisa. Max 30 `approved + pending` räknas per grupp.
- Inbjudningar: sker via gruppkod/invite-länk, inte via lagrade e-postadresser.
- Positioner: godkända medlemmar kan läsa gruppens positioner; användaren kan bara skriva sin egen rad.
- Meddelanden: godkända medlemmar kan läsa och skriva som sig själva.
- Frågor/svar: godkända medlemmar kan läsa; användaren kan skapa eller ändra sitt eget svar.
- Storage: privat bucket, åtkomst via gruppmedlemskap.

## 8. GeoTIFF

Nya kartor kontrolleras och omvandlas i webbläsaren före uppladdning. Gränserna är 5 MiB, 2000 pixlar per sida och 512 genererade tiles. Bilden måste ha georeferering och ett känt EPSG-koordinatsystem. Standardiserad TIFF-orientering, roterade affina kartor samt PixelIsArea/PixelIsPoint stöds. Kartor som saknar användbar georeferering nekas med ett felmeddelande.

En module Worker avkodar bilden, omprojicerar den till EPSG:3857 med bilinjär omsampling och skapar 256 × 256 px PNG-rutor. Lägre zoomnivåer skapas genom successiv nedskalning. Högsta nivån matchar minst originalets pixelupplösning; normalt används den och tre lägre nivåer. Arbetsytan begränsas till 8192 pixlar per sida och 24 × 1024 × 1024 pixlar totalt. Bildens verkliga detaljskärpa kan inte avläsas ur pixelmåtten och används inte som urvalskriterium.

PNG-filerna laddas upp med högst fyra samtidiga anrop. Manifestet publiceras sist, så ofullständiga kartor inte visas i listan. Vid fel försöker klienten ta bort påbörjade filer; om fliken stängs eller nätverket försvinner kan rester ligga kvar tills gruppens lagring städas. Original-TIFF sparas inte för nya importer. Gamla `.tif`/`.tiff`-filer visas oförändrat med den äldre renderaren; ladda upp dem igen för att få tile-visning och radera sedan den gamla kartposten.

Tile-lagret hämtar bilder med tidsbegränsade signerade URL:er från den privata bucketen. Signeringen delas mellan rutorna och förnyas vid nya tile-förfrågningar efter 50 minuter. Leaflet förstorar högsta nivån vid fortsatt inzoomning. Standardopaciteten är 100 %, med reglaget kvar.

### Driftsättning av tile-import

1. Kör `030_map_tiles.sql` i Supabase. Den uppdaterar tillåtna filtyper och skapar en skyddad städkö för borttagna grupper.
2. Publicera om `cleanup-expired-groups` (inklusive `functions/_shared/map-cleanup.js`). Den raderar nu underkataloger, gamla TIFF-filer och rester av avbrutna uppladdningar. Manuellt borttagna grupper och grupper borttagna via kontoradering städas vid nästa körning via kön. Befintliga redan borttagna grupper återfylls inte automatiskt i kön.
3. Bygg och publicera webbsidan med hela `dist`, inklusive worker-filer och dess avkodningsmoduler.

### Verifiering

`npm test` kontrollerar gränser, projektion/utbredning, TIFF-till-PNG-rendering, detaljer över rutgränser, alfa/nodata, uppladdningsfel, paginering, rekursiv radering och städköns databasbehörigheter. PNG-renderingstester använder en canvas-adapter i Node; de ersätter inte provning på riktiga telefoner.

Efter driftsättning, prova på dator och mobil:

- Ladda upp en georefererad karta på ungefär 1000 × 1000 px och 1 × 1 km. Kontrollera förlopp, bibehållen respons och korrekt placering mot bakgrundskartan.
- Jämför text och tunna linjer med originalet vid 100 % opacitet. Panorera över rutgränser och zooma genom samtliga nivåer samt över högsta genererade nivån.
- Testa en äldre TIFF-karta tillsammans med en ny tile-karta; visa/dölj, ändra opacitet och byt grupp.
- Kontrollera att >2000 px eller >5 MiB nekas innan något laddas upp. Avbryt nätverket under uppladdning och kontrollera att ingen halvfärdig kartpost publiceras.
- Radera en tile-karta och kontrollera att både manifest och PNG-filer försvinner. Radera därefter en testgrupp och kör cleanup-jobbet; dess lagring och köpost ska försvinna.
