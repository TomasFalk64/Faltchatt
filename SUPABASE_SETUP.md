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

## 3. Authentication

I Dashboard, gå till Authentication:

- Aktivera Email provider.
- Välj om e-postbekräftelse ska krävas.
- Lägg in redirect URLs för både lokal test och publicerad app, exempelvis `http://127.0.0.1:5173/Faltchatt/` och `https://tomasfalk64.github.io/Faltchatt/`.

## 4. Storage

Migrationen skapar bucket `group-maps` som privat bucket med ungefär 5 MB filgräns.

Filvägarna följer:

```text
group-maps/{group_id}/{uuid}.tif
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

## 6. Edge Functions och e-post

Gruppadministrationens knapp `Skicka e-post till gruppen` använder Supabase Edge Function:

```text
supabase/functions/send-group-email
```

Deploya funktionen och sätt följande secrets i Supabase:

```bash
supabase functions deploy send-group-email
supabase secrets set BREVO_API_KEY=din_brevo_api_key
supabase secrets set BREVO_SENDER_EMAIL=avsandare@example.com
supabase secrets set BREVO_SENDER_NAME=Fältchatt
supabase secrets set FALTCHATT_APP_URL=https://tomasfalk64.github.io/Faltchatt/
```

`SUPABASE_URL` och `SUPABASE_SERVICE_ROLE_KEY` finns normalt redan i Edge Function-miljön. Lägg aldrig service role key eller Brevo-nycklar i frontend eller `.env.local`.

Om appen visar `Failed to send a request to the Edge Function` betyder det oftast att `send-group-email` inte är deployad i Supabase-projektet, eller att Edge Function-miljön saknar någon av secrets ovan. Kontrollera även Function Logs i Supabase Dashboard.

## 7. RLS-regler

RLS är aktivt på alla apptabeller.

Grundprinciperna:

- Profiler: användaren kan läsa och uppdatera sig själv samt läsa godkända gruppmedlemmars begränsade profilinfo.
- Grupper: endast godkända medlemmar kan läsa; owner/admin kan uppdatera administrativa fält.
- Medlemskap: användare går med via `request_group_membership`; owner/admin kan godkänna och avvisa.
- Invites: endast owner/admin kan läsa gruppens invites; import, claim och återkallning sker via RPC.
- Positioner: godkända medlemmar kan läsa gruppens positioner; användaren kan bara skriva sin egen rad.
- Meddelanden: godkända medlemmar kan läsa och skriva som sig själva.
- Frågor/svar: godkända medlemmar kan läsa; användaren kan skapa eller ändra sitt eget svar.
- Storage: privat bucket, åtkomst via gruppmedlemskap.

## 8. GeoTIFF

Första versionen förutsätter att GeoTIFF-filen är korrekt georefererad och kan tolkas av browserbiblioteken. Om filen saknar användbar georeferering eller har en projektion biblioteket inte stödjer visas ett kort felmeddelande och appen fortsätter fungera.
