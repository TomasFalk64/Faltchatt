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

Första versionen förutsätter att GeoTIFF-filen är korrekt georefererad och kan tolkas av browserbiblioteken. Om filen saknar användbar georeferering eller har en projektion biblioteket inte stödjer visas ett kort felmeddelande och appen fortsätter fungera.
