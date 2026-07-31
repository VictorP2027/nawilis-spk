# Nawilis SPK — Supabase (Postgres) clone

A **separate, parallel version** of the app that stores in **Supabase (Postgres)**
instead of MongoDB. The MongoDB/Atlas app (`apps/web`, port 3000) is untouched and
keeps working; this clone (`apps/web-supabase`, port **3100**) is fully independent.

It reuses ALL the shared domain logic (validation, Indonesian parsing, the Nawilis
export schema, the pixel-perfect blue SPK form) — only the storage layer differs.

| | MongoDB app | Supabase clone |
|---|---|---|
| App | `apps/web` (port 3000) | `apps/web-supabase` (port 3100) |
| Data layer | `@spk/core` (mongodb driver) | `@spk/core-supabase` (supabase-js) |
| Store | MongoDB / Atlas | Supabase Postgres (JSONB-hybrid) |
| UI / form / export | identical | identical |

## What's included
Capture → Supabase → view/export/delete, the assignment gate (only mechanic-assigned
SPKs are "used"), and the exact Nawilis `.xlsx` export. The Turboly RPA worker is not
ported to this clone yet (it's Mongo-side); the capture product is complete.

## Setup

1. Create a free project at **https://supabase.com** → New project (pick **Singapore**
   region for Indonesia).
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. This creates
   the tables + indexes.
3. Get credentials: **Project Settings → Data API** → copy the **Project URL**; **Project
   Settings → API Keys** → copy the **`service_role`** key (server-side secret — never ship
   to a browser).
4. Put them in root `.env`:
   ```
   SUPABASE_URL=https://YOURPROJECT.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...service_role...
   ```
5. Verify + seed + run:
   ```
   npm run db:check-supabase   # → lists table row counts, ✓ connected
   npm run seed:supabase       # degradation + demo mirror (NWL-BKS, "Demo Advisor")
   npm run dev:web-supabase    # → http://localhost:3100  (form, /sheet, /admin)
   ```

## Try it
Open **http://localhost:3100/sheet** — same blue NAWILIS form. Submit with branch
Bekasi, plate `B1234XY`, KM ≥ 10.000. It saves to Supabase. View rows in the Supabase
dashboard → **Table Editor → spk**, or run SQL:
```sql
select id, nomor_antrian, branch_code, state, plate, doc->'customer'->>'nama' as customer
from spk order by created_at desc;
```

## Notes
- `service_role` bypasses RLS and is only used server-side (Next route handlers). If you
  later expose the anon key to browsers, enable RLS + policies on the tables.
- The full `SpkDoc` lives in the `doc jsonb` column; key fields (`state`, `plate`,
  `branch_code`, `business_date`, `used`, `nomor_antrian`) are promoted to columns for
  indexing and the compare-and-swap state transition.
- To run BOTH apps at once: `npm run dev:web` (Mongo, :3000) and
  `npm run dev:web-supabase` (Supabase, :3100) in separate terminals.
