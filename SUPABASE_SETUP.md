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

## 3. Authentication

I Dashboard, gå till Authentication:

- Aktivera Email provider.
- Välj om e-postbekräftelse ska krävas.
- Lägg in lokal redirect URL om lösenordsåterställning används, exempelvis `http://127.0.0.1:5173`.

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

## 6. RLS-regler

RLS är aktivt på alla apptabeller.

Grundprinciperna:

- Profiler: användaren kan läsa och uppdatera sig själv samt läsa godkända gruppmedlemmars begränsade profilinfo.
- Grupper: endast godkända medlemmar kan läsa; owner/admin kan uppdatera administrativa fält.
- Medlemskap: användare går med via `request_group_membership`; owner/admin kan godkänna och avvisa.
- Positioner: godkända medlemmar kan läsa gruppens positioner; användaren kan bara skriva sin egen rad.
- Meddelanden: godkända medlemmar kan läsa och skriva som sig själva.
- Frågor/svar: godkända medlemmar kan läsa; användaren kan skapa eller ändra sitt eget svar.
- Storage: privat bucket, åtkomst via gruppmedlemskap.

## 7. GeoTIFF

Första versionen förutsätter att GeoTIFF-filen är korrekt georefererad och kan tolkas av browserbiblioteken. Om filen saknar användbar georeferering eller har en projektion biblioteket inte stödjer visas ett kort felmeddelande och appen fortsätter fungera.
