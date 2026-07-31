# NAWILIS SPK → TURBOLY: DECISION DOCUMENT

**Date:** 2026-07-30 · **Status:** pre-build · **Author:** research + design synthesis

---

## RECOMMENDATION UP FRONT

1. **Build the intake system now. Do not build the Turboly push yet.** ~70% of the value (owning the intake data, cross-branch vehicle history, the photographic liability record, assisted entry) is independent of Turboly and carries no vendor risk, no legal gate, and no unresolved unknowns.
2. **Send Turboly the written request this week** (§11). It is the single highest-leverage action available and Nawilis's negotiating position is at its maximum right now — they are a fresh 23-store logo on `turboly.com/software-bengkel/`, onboarded ~June 2026. That leverage decays monthly.
3. **The paper form stays.** It is not just a data medium — it is the shop-floor traveler that goes on the car, and it carries a wet signature that is a stronger legal artifact than anything a tablet produces (§5, §9). Design *around* the paper, not against it.
4. **Capture order: typed-minimal intake first, photo-of-paper second, AI extraction third, RPA last and gated.** This ordering deletes the extraction bill and the cross-border data-transfer legal gate from the critical path entirely.
5. **Two hard gates on the RPA layer.** (a) Written confirmation from Turboly that automated UI access is permitted under the signed subscription agreement. (b) Confirmation that the Service Order has a **writable, list-searchable free-text field**. If either is missing, the push is not buildable *correctly* and should not be built at all.

---

## 1. WHAT THIS ACTUALLY IS

This is not a generic document-to-ERP pipeline. It is an **intake-capture system for an automotive workshop chain that currently has none.** Nawilis runs 23 outlets (13 full workshops + 10 QuickServ express bays inside bp petrol stations), generating 50–500 paper SPKs per day, none of which are queryable after the customer drives away. Turboly is a real, confirmed, ~2-month-old ERP relationship whose Service module (Reservation → Order → Work Order → Invoice) is the destination — but Nawilis has *normal tenant access only*, and Turboly exposes no service API, no service CSV import, no mobile app, and no iPaaS connector to a normal tenant. So the project splits cleanly into a low-risk, high-value data-capture system and a high-risk, medium-value last mile, and **the correct move is to stop treating them as one project.**

---

## 2. THE ONE FACT THAT DECIDES THE ARCHITECTURE

**Question:** *What is the sanctioned write path into Turboly's Service module?* Everything downstream — cost, complexity, headcount, legal exposure, whether half the design exists at all — falls out of the answer.

### The possible worlds

| | World | Probability (est.) | What we build | Build cost | Run cost/yr | Account risk |
|---|---|---|---|---|---|---|
| **W1** | Turboly builds a Service Order create API **or** a service-transaction CSV import | Medium | Thin adapter (~few hundred LOC) | Rp 50–300jt one-time to vendor *(UNVERIFIED — no public rate card)* | ~0 | None |
| **W2** | No API, but **written** permission for automated UI access from a disclosed static IP with named service accounts | Medium | Playwright RPA fleet + claim table + canary + breakers + DLQ console + degradation ladder | 6–12 person-months | ~Rp 20jt infra + ~1 FTE HO recovery desk | Low (papered) |
| **W3** | No API, no written permission (or explicit refusal) | Medium | **No push.** Assisted manual entry with doc-number write-back | ~2 weeks | ~0 | None |
| **W4** | RPA is permitted **but** the Service Order has no writable, searchable reference field | Low–Medium | **Treat as W3.** Exactly-once is unachievable; the documented fallback (plate+date fingerprint) manufactures vanished work orders and double-billed customers wearing green checkmarks | — | — | — |

**Note the shape of that table:** W1 and W3 are both *cheaper and safer* than W2. W2 is the expensive middle. It should be entered deliberately with a signed permission, never by default because nobody asked.

### The cheapest experiment — resolvable this week

| # | Experiment | Who | Time | Resolves |
|---|---|---|---|---|
| E1 | **Send the message in §11** (ID + EN), to `sales@turboly.com` + `+62 21-58356894`, offering to pay for scoping | You, today | 10 min | W1 vs W2 vs W3 — the whole tree |
| E2 | **Read the acceptable-use clause** in the signed Turboly subscription agreement | Nawilis finance/legal | 30 min | Whether W2 is even legal. Hard gate. |
| E3 | **Screen-record one Service Order + Work Order created by hand**, start to finish, with a stopwatch | One branch admin | 15 min | (a) Is there a Reference/Remarks/Notes field, and is it *searchable from the list view*? (b) Are there file attachments? (c) Does an Inspections module exist? (d) Is there a store switcher? (e) The real wall-clock per record — the number that validates or invalidates the entire concurrency model |
| E4 | **Export from Turboly UI:** Stores list, Service Products list, Mechanics/Advisors | Tenant admin | 15 min | Real `turbolyStoreId` values and real Service Product SKUs. Nothing can be pushed without these, and they must never be invented. Also settles 13-vs-20+-vs-23 authoritatively. |
| E5 | **Scan 3 QR codes** — two from one pad at one branch, one from a different branch — paste raw payloads | Any staff | 2 min | Static marketing link (mint our own identity) vs. variable-data serial (becomes the primary key). |

**Do not write push code until E1, E2, and E3 return.** Everything in §8 Week 1 proceeds in parallel and is unaffected by the answers.

---

## 3. RECOMMENDED ARCHITECTURE

### 3.1 Data flow

```
BRANCH (×23)                        CLOUD (Singapore, ap-southeast)          TURBOLY
──────────────────────────────      ──────────────────────────────────       ─────────────

  [PAPER SPK]  ← STAYS.
   │  traveler on the car
   │  wet signature = legal artifact
   │
   ├─(a) TYPED INTAKE  ≤30s ────┐
   │     plate · KM · jobs      │
   │     arrival time           ├──► INGEST API ──► MongoDB  ◄══ SYSTEM OF RECORD
   │     customer only if new   │        │           (never depends on Turboly)
   │                            │        │
   ├─(b) PHOTO AT HANDOVER ─────┘        ├──► object store (S3/R2, in-region, CMK)
   │     full sheet: condition,          │        originals · signatures · damage crops
   │     damage diagram, 2 signatures    │
   │                                     ├──► extraction lanes  [PHASE 3 — LEGAL GATE]
   ├─◄── [QR JOB TICKET] printed         │        Lane 0 local · Lane 1 Haiku · Lane 2 Sonnet
   │      goes on the car                │        NEVER: signature or damage crops
   │                                     │
   └─ mechanic scans ticket QR           ├──► review console (branch queue + HO ops)
      at start / at finish               │
      → MK + WAKTU + amendments          ├──► RECONCILER ─────────────────────┐
                                         │      token set-difference, 72h      │
                                         │      rolling window, no date join   │
                                         │                                     │
                                         └──► PUSH ADAPTER  [FEATURE-FLAGGED]  │
                                                 │                             │
                                                 │  exactly ONE of:            │
                                                 │   W1  API / CSV import ─────┼──► SRO → SO → SWO
                                                 │   W2  Playwright RPA ───────┤
                                                 │   W3  assisted manual  ─────┘
                                                 │       + doc-no writeback
                                                 │
                                          verifier reads back BY TOKEN,
                                          separate context, persistent
                                          Service Order LIST (never the
                                          ephemeral Service Dashboard)
```

**Two rules everything hangs off:**

1. **MongoDB is the system of record; the queue holds work, not truth.** Every job carries only a SPK ULID; the worker re-reads Mongo. Wipe Redis and a poller re-enqueues everything in `push_state ∈ {queued, failed}`.
2. **Capture never blocks on the push.** Staff complete intake and the customer drives in whether or not Turboly is reachable, whether or not there is internet.

### 3.2 MongoDB document shape (condensed — full field set in the data-layer design)

```jsonc
{
  "_id": "01JZQK7M4F8T2XVYB3D5N9WQ2A",     // ULID. THE primary key. Not the paper serial.
  "schemaVersion": 4,
  "docType": "SPK_NAWILIS",                 // | QS_INSPECTION
  "tenantId": "NAWILIS",

  "branchCode": "NWL-TA17",                 // from SESSION + device binding, never the checkbox column
  "branchType": "NAWILIS",                  // | QUICKSERV  → drives form variant + push SLA
  "deviceBindingVerified": true,            // geofence guard; supervisor PIN if device moved

  "spkNumber": { "normalized": "TA17-004821", "source": "typed" },  // business id, NOT unique-indexed
  "qr": { "payload": "...", "kind": "unknown" },                     // blocked on E5

  "capture": {
    "mode": "typed",                        // typed | photo | hybrid
    "operator": { "userId": "u_8812", "pin": "verified" },
    "arrivalTime":  "2026-07-30T09:12:00Z", // WHAT THE ADVISOR SAYS. Editable. ≠ capture time.
    "capturedAt":   "2026-07-30T09:13:04Z",
    "receivedAt":   "2026-07-30T09:13:11Z", // server clock, authoritative
    "captureLagMinutes": 1,                 // ⚑ best adoption telemetry in the system
    "businessDate": "2026-07-30"            // ops dashboards ONLY. Never a reconciliation key.
  },

  "customer": { "nama": "...", "waE164": "+62812...", "alamat": "...",
                "turbolyCustomerId": null, "consent": { "marketing": false, "at": null } },

  "vehicle": {
    "noPolisi": { "full": "B1234SZA", "display": "B 1234 SZA",
                  "correctionsApplied": [] },   // ⚑ non-empty ⇒ tier capped at CONFIRM, always
    "plateVariants": ["B1234SZA", "B1Z34SZA"],  // OCR-confusion neighbourhood, multikey index
    "merkNormalized": "TOYOTA", "merkRaw": "Toyot", "merkMatchScore": 0.94,
    "tipeNormalized": "AVANZA", "tahun": 2019, "warna": "SILVER",
    "km": { "raw": "45.230", "value": 45230 },  // '.' = THOUSANDS in id-ID. 1000× error if assumed English.
    "vehicleRef": "veh_B1234SZA",
    "bindReason": "exact_plate+merk_match"      // ⚑ two independent signals required to bind
  },

  "complaint": { "keluhan": "..." },

  "jobLines": [                              // 14 rows for SPK_NAWILIS; variable for QS
    { "lineNo": 1, "serviceCode": "SPOORING", "ordered": true, "qty": 1,
      "keterangan": "4 roda",
      "mk": { "mechanicCode": null, "source": "pending_ticket_scan" },   // ⚑ filled at ticket scan
      "waktu": { "minutes": null, "source": "pending_ticket_scan" },
      "quotedPrice": 350000,                 // ⚑ captured at intake, printed on ticket, pushed to SO
      "turbolySku": "JASA-SPOORING" }        // from Turboly export ONLY. Never invented.
  ],
  "jobLineSummary": { "orderedCount": 3, "unmappedCount": 0, "quotedTotal": 750000 },

  "conditionChecks": [ { "rowNo": 1, "item": "PANEL_DASHBOARD",
                         "marks": [], "status": "UNMARKED",             // ⚑ default UNMARKED, not OK
                         "source": null } ],                            // bulk_ok | photo | typed
  "damageDiagram": { "imageRef": "att_07", "neverReviewed": true },     // evidentiary. Never extracted to fields.
  "signatures": {
    "menyerahkan": { "present": true, "inkDensity": 0.083,
                     "computedAt": "device" },                          // ⚑ computed on-device, syncs with JSON
    "menerima":    { "present": true, "namaJelas": "Rina S." }
  },
  "authorization": { "accepted": true, "acceptedBasis": "wet_signature",
                     "textVersion": "SPK_AUTH_2024" },

  "fieldMeta": [ { "path": "customer.waE164", "source": "typed",
                   "modelConfidence": null, "validator": "pass",
                   "tier": "AUTO_PASS", "corrections": 0 } ],           // ⚑ ALWAYS query with $elemMatch

  "lifecycle": "open",                        // open | amended | closed   ⚑ SPK is MUTABLE until handover
  "amendments": [ { "at": "...", "by": "u_9001", "added": ["OLI"], "reason": "upsell" } ],

  "state": "queued",
  "push": {
    "correlationToken": "SPK:01JZQK7M4F8T2XVYB3D5N9WQ2A",  // ⚑ written INTO Turboly. Sole identity.
    "priority": 95,                                         // QuickServ 95 / Nawilis 50
    "attempt": 1, "maxAttempts": 6, "nextAttemptAt": null,
    "lease": { "workerId": null, "epoch": 0, "expiresAt": null },  // ⚑ fencing epoch
    "phases": { "order": { "status": "pending" }, "workOrder": { "status": "pending" } },
    "storeSwitch": { "expected": "Tanah Abang 17", "observed": null, "verifiedFrom": "document_detail" }
  },
  "turboly": {
    "serviceOrderNo": null, "workOrderNo": null,
    "readback": { "matchedOn": [], "lineCount": null, "lineSkus": [], "km": null }  // ⚑ not just existence
  },
  "createdAt": "...", "updatedAt": "..."
}
```

**Companion collections:** `spk_events` (append-only audit + labelled-correction corpus), `turboly_docs` (claim table, `_id = spkId#phase`), `vehicles` (cross-branch plate index), `ref_*` (branches, service codes, condition items, brands, damage zones, templates), `tb_*` (Turboly mirror: stores, service products, mechanics), `push_dlq`, `recon_runs`.

**Six schema decisions that matter, and why:**

| Decision | Reason |
|---|---|
| ULID `_id`, paper serial is *not* the PK and *not* uniquely indexed | The serial may be missing, illegible, or duplicated across 23 branches × multiple print runs. A unique index on OCR output throws E11000 on the extraction update and strands the doc mid-pipeline in an infinite paid retry loop. |
| `fieldMeta[]` parallel array, never inline dotted keys | Mongo keys can't contain `.`. **All queries must use `$elemMatch`** — a compound multikey query without it matches across *different* array elements and silently corrupts the tier-tuning loop. |
| `conditionChecks[].marks[]` + derived tri-state, default `UNMARKED` | Staff circle two words on one row. And a defaulted `OK` converts "not checked" into a signed affirmative statement that the car was undamaged — strictly worse than paper for the exact dispute the section exists to defend. |
| `lifecycle: open → amended → closed`, separate from `state` | Upsell during the job *is* the spooring business model — the paper has a pre-printed *Rekomendasi Service* box. An SPK terminal at intake means the SO has 2 lines and the invoice has 5, forever, silently. |
| No `push.idempotencyKey` unique index | It equalled `_id`, so it could never collide. It was decorative, and it was load-bearing in the "double-push is impossible" argument. Delete it and re-derive the claim honestly. |
| Binaries in object storage, in-region, CMK | ~4 MB/SPK × 500/day ≈ 700 GB/yr. GridFS churns the oplog. Also: in-region storage keeps the images out of the cross-border transfer question entirely. |

### 3.3 State machine

```
  captured ──► extracted ──► needs_review ──► validated ──► queued ──► pushing ──► pushed ──► confirmed
      │            │             │  ▲                         ▲          │           │          │
      │            │             └──┘ edit loop               │          │           │          │
      │            └──► needs_review (ALL docs pass through;  └─ retry ──┤           │          │
      │                  auto-pass docs with required=false)  failed ◄───┘           │          │
      │                                                          │                   │          │
      └──────────────────────► manual_intervention ◄─────────────┴───────────────────┴──────────┘
                                       │                                             │
                                       ├──► validated   (fixed, re-enters at T7)     │
                                       ├──► voided      (terminal)              amend_pending ◄┘
                                       └──► superseded  (terminal, duplicate)        │
                                                                                     └──► pushing
```

**Enforcement rule, non-negotiable:** every transition is a `findOneAndUpdate` whose filter includes the expected current state. Never `updateOne({_id})` on `state`. That compare-and-swap is what makes concurrent workers safe.

| Transition | Guard | Notes |
|---|---|---|
| `→ captured` | Idempotent on client `uploadId`; branch from session **and** device binding verified | Ticket printed here. Customer leaves. |
| `captured → extracted` | Typed mode: required fields present. Photo mode: all lanes returned + schema-parsed | Typed mode skips lanes 1–2 entirely (cost $0). |
| `extracted → needs_review` | Always. Every document passes through. | Computes tiers. `review.required` = any tier ≥ CONFIRM or any blocker. |
| `needs_review → validated` | No blockers **and** `unmappedCount == 0` | Signature `present == false` blocks **invoicing**, not intake. `present == undefined` (blob pending) allows submit + deferred check. |
| `validated → queued` | Mirror preflight: branch resolves to a real store; every ordered `turbolySku` exists in `tb_service_products` | Unknown SKU ⇒ BLOCK. Unknown customer ⇒ never blocks (search live, create, write through). |
| `queued → pushing` | CAS on state + `nextAttemptAt <= now`; **lease epoch incremented** | Worker re-asserts its epoch immediately before every irreversible click. |
| `pushing → pushed` | All non-deferred phases committed in `turboly_docs` | |
| `pushed → confirmed` | **Separate process, separate browser context**, token search on the persistent Service Order **list**, asserting store + line count + line SKUs + KM | Only this may set `confirmed`. Never the Service Dashboard (completed SWOs drop off after 5 min → false-negative → human creates the duplicate). |
| `confirmed → amend_pending` | Amendment recorded, or nightly audit finds a diff | Without this, Mongo and Turboly diverge permanently and nothing can ever fix it. |
| `pushing → failed` | Classified error, OR **lease reaper** | A `claimed`-but-uncommitted row may **not** be released for retry until `now − claimedAt > 3 × max observed save latency` (start 10 min) with a repeated token search at the end of the window. Releasing early is how a *stalled* (not dead) worker produces two Service Orders. |

---

## 4. SPK → TURBOLY SERVICE ORDER FIELD MAPPING

Confidence: **V** verified from public Turboly docs/marketing · **L** likely, concept confirmed, label unknown · **U** UNKNOWN, must be checked in the live UI (E3) · **NH** no home in Turboly.

| SPK field | MongoDB path | Turboly target | Conf | Action |
|---|---|---|---|---|
| Tanggal | `capture.arrivalTime` | SO header date | L | **U:** editable or auto-stamped `today`? If auto-stamped, back-dating a late SPK is impossible. |
| Nama | `customer.nama` | Customer → **Nama** | **V** | Search first, create on miss, write through to mirror. |
| Alamat | `customer.alamat` | Customer → **Alamat** | **V** | Check max length. |
| Nomor WA | `customer.waE164` | Customer → **No. Telp** | **V** | **U:** accepts `+62…` or requires `08…`? Store both. |
| Kontak Lain | `customer.kontakLain` | — | **U** | Likely no second-phone field → notes. |
| Merk Mobil | `vehicle.merkNormalized` | SO vehicle → Merk | L | **U:** free text or dropdown? If dropdown, our brand vocab must reconcile or pushes fail. |
| Tipe | `vehicle.tipeNormalized` | SO vehicle → Tipe | L | Same. Variant → notes if dropdown. |
| **No. Polisi** | `vehicle.noPolisi.display` | SO/SWO → **No Polisi** | **V** | Dashboard's primary column. **Match Turboly's exact spacing convention or read-back fails.** |
| Tahun | `vehicle.tahun` | — | **U** | If absent → notes. |
| Warna | `vehicle.warna` | — | **U** | If absent → notes. |
| KM | `vehicle.km.value` | Odometer (arrival) | L | Push the **integer**. Never the separator-formatted string. |
| Keluhan | `complaint.keluhan` | SO complaint/notes | L | **U:** max length — this field also absorbs every `NH` overflow below. |
| PEKERJAAN ordered rows | `jobLines[].turbolySku` | SO/SWO **line items** = Service Products | **V** | SKUs from the Turboly export (E4). **Never invent one.** |
| PEKERJAAN → KETERANGAN | `jobLines[].keterangan` | Per-line note | **U** | If absent → fold into notes as `SPOORING: 4 roda`. |
| PEKERJAAN → **MK** | `jobLines[].mk` | SWO → mechanic assignment | **V** | ⚑ **Not available at intake.** The mechanic writes this during the job. Capture via ticket-QR scan, push at closure. Assigning at intake fabricates mechanic-productivity data. |
| PEKERJAAN → **WAKTU** | `jobLines[].waktu` | Estimated duration | L→U | Turboly computes SWO finish as *plan time + the Service Product's master duration* — duration may be **master data, not a per-line input**. If not overridable → NH. Also captured at ticket scan. |
| **Price** | `jobLines[].quotedPrice` | SO line price | L | ⚑ **Not in the current design and must be.** No price is captured at intake, but the SO will be invoiced at master price → argument at the cashier → cashier override → SO and sale diverge on value → every margin report wrong. Seed chips from the store's master price, editable, print on the ticket. |
| Estimasi waktu | `estimasi.minutes` | Likely computed | L | Probably NH. Drives our own SLA dashboard. |
| Branch checkbox | `branchCode` → `turbolyStoreId` | **Store** selection | **V** | ⚑ Verify the store by reading it **off the created document's detail page**, not off nav chrome — switchers commonly update the label client-side while the session context lags. |
| **PENGECEKAN AWAL** (8 rows) | `conditionChecks[]` | Possibly **Inspections** module | **U** | Nav-listed, docs are stubs. If it exists with an 8-row template → 1:1. **If not: Mongo is system of record; push `conditionSummary.notesText`.** |
| **Damage diagram** | `damageDiagram.imageRef` | — | **NH** | **Never extract to fields.** The pen mark defends a dispute; a JSON array does not. Attach the crop only if attachments exist (E3). |
| **Signature — menyerahkan** | `signatures.menyerahkan` | — | **NH** | Liability artefact. Mongo only. Presence blocks **invoicing**, not intake. |
| **Signature — menerima** | `signatures.menerima` | Service Advisor (name only) | L | Advisor is a confirmed Dashboard column. |
| Authorization text | `authorization.*` | — | **NH** | Version the wording so you can prove what the customer signed. |
| Rekomendasi Service | `rekomendasiService.text` | Next-service / reminder? | **U** | Turboly markets km/date reminders — check for a field. Else notes + our own CRM. |
| **NO. serial / correlation token** | `push.correlationToken` | Reference / Remarks / External No. | **U** | ⚑ **THE critical check.** Must be (a) writable, (b) **searchable from the list view**, (c) fillable **early** in the form — if the SO header commits before lines are added, the token must be on the header step or crash recovery is blind to orphans. |
| QR payload, capture metadata, fieldMeta, audit trail | various | — | **NH** | Internal. |

**Consequence of the NH column:** MongoDB is **not a staging area — it is the system of record for vehicle condition and liability.** Turboly holds the commercial transaction. Retention policy follows from that (§9).

**Notes-field budget.** Every `U`/`NH` row degrading to "put it in notes" competes for one field. Establish max length first, then truncate from the bottom of this priority order: (1) Keluhan verbatim, (2) unmapped custom job lines, (3) condition ISSUE rows, (4) rekomendasi, (5) tahun/warna, (6) damage-zone summary, (7) per-line keterangan, (8) kontak lain. Set `turboly.notesTruncated: true` when anything drops.

---

## 5. CAPTURE UX — AND WHY BOTH MODES EXIST

**The reframe that resolves this:** photo-of-paper is **not** a bridge to be replaced by the tablet. The two modes capture *different things at different moments*, and both are permanent.

| | Typed intake (mode A) | Photo of paper (mode B) |
|---|---|---|
| **When** | At the counter, before the car moves | At handover, after the sheet is complete |
| **Captures** | plate · KM · jobs ordered · quoted price · arrival time · customer (only if plate unknown) | condition checks · damage diagram · **both signatures** · MK/WAKTU as written · any amendments |
| **Target time** | **≤30 s** | ~8 s (shoot + quality gate) |
| **Cost** | $0 | $0 as archive; ~$0.041/doc if extracted |
| **Purpose** | Get the car into the system and into Turboly *now* | Complete the liability record |
| **Legal role** | Operational | **The wet signature. The defensible artifact.** |

### Why typed-first, photo-second, extraction-third

1. **Extraction is not on the critical path.** Photo mode as pure image archive costs $0 in API spend, requires no homography, no QR answer, no vision prompts, and — decisively — **no cross-border personal-data transfer to a US API**, which is currently an unresolved UU PDP exposure with no lawful basis (§9). Store the images in-region; add extraction later once the DPIA and Anthropic DPA/ZDR are executed.
2. **Typed intake is 100% accurate by construction.** No 45–65% zero-touch ceiling, no 22-cell checkbox classification, no ~19 s review, no 2.6 person-hours/day of reviewing.
3. **It sidesteps the adoption trap.** The plan's original bet was an 83-second tablet interaction competing against a 20-second scrawl on a clipboard that goes with the car. That bet loses at 17:00 on Saturday — and workshop habits are formed at the peak, not the average. A 30-second intake that *adds* a printed ticket the shop already needs wins on the advisor's own terms.

### The intake screen (≤30 s, one thumb, landscape)

| # | Screen | Content | Budget (new / returning) |
|---|---|---|---|
| 0 | **Antrian** | Today's open SPKs at this branch + `+ SPK BARU`. Branch from session, never a picker. | — |
| 1 | **PLAT** | Segmented `[B][1234][SZA]` plate keypad. Live search against the **full all-branch** plate cache as you type. Hit → card: *"B 1234 SZA · Toyota Avanza 2019 Putih · Budi Santoso · terakhir 12 Mar, 45.230 km"* | 5 s / 5 s |
| 2 | **KM + JAM MASUK** | Numeric KM with monotonicity check. Arrival-time chip defaulting to now with *"1 jam lalu / 2 jam lalu"* quick-adjust. | 6 s / 6 s |
| 3 | **PEKERJAAN** | 12 pre-printed rows as large toggle tiles, **each bound to a real Turboly Service Product SKU**. Selected tile expands: price chip (seeded from store master, editable) + qty. `+ Tambah` covers rows 13–14. | 12 s |
| 4 | **CUSTOMER** | *Skipped entirely for a matched plate.* New: Nama · WA (auto `08…`→`+628…`) · Alamat optional, never blocks. | 20 s / **0 s** |
| 5 | **CETAK** | Prints the QR job ticket over Bluetooth thermal. Ticket carries SPK no, plate, jobs, quoted total, estimated finish. | 4 s |

**≈47 s new, ≈27 s returning.** Every element of that budget comes from a specific decision: branch from session, plate-first history prefill, customer skipped on match, no signature on glass, no condition checklist at intake.

### The QR job ticket — the change that makes this work

The paper SPK's second job is being the **shop-floor traveler**: it goes on the dash, and the mechanic writes MK and WAKTU on it *during* the job. Any design that asks the advisor to supply MK/WAKTU at intake either fabricates the data or forces the branch to keep filling paper *as well* — which is double entry, the precise thing they were promised would end. Adoption dies in week 2 for a reason nobody anticipated.

So: **the app prints the traveler.** The mechanic scans its QR at start and finish (two taps, zero typing) → MK + WAKTU. The cashier scans it at handover → amendments + final line set. Turboly gets a Service Order at intake and a complete, amended Work Order at closure, *before* invoicing.

### Non-negotiable UX rules

- **Devices: minimum 2 per full branch, 1 regional spare.** Paper parallelizes across three advisors with three clipboards; one tablet serializes intake and makes peak throughput *worse*. Budget 30–40%/yr replacement (oil, drops, concrete). QuickServ bays are outdoors under SPBU canopies — **verify screen brightness at one QS site before buying 23.**
- **Offline-first PWA, IndexedDB as local truth.** Append-only outbox of `{ulid, spk_id, field_path, value, device_clock, lamport}`. Reference data is strictly server→device. **Cache the full all-branch plate index** (~100k vehicles × ~120 B ≈ 12 MB) — not just the local branch, or the returning-customer fast path vanishes exactly when the network is worst. Prefer Android tablets.
- **Never trust `navigator.onLine`.** Indonesian workshop wifi and captive portals lie. Confirm with a real `HEAD /healthz`, 3 s timeout.
- **Persistent, tappable sync badge** — *"3 SPK belum terkirim"* → per-record reasons. Silent failure is the enemy; staff must always be able to answer "did it save?"
- **Device-bound credential that cannot expire mid-shift** + a 4-digit staff PIN on the SPK screen (~1 s) for operator attribution. A password prompt at 17:00 Saturday is a 100% adoption-loss event and the habit does not reverse. PIN skipped ⇒ `operator: unattributed`, never a block.
- **Device–branch binding record.** A device >2 km from its bound branch requires a supervisor PIN before the shift's first SPK. Branch name permanently in the header, large. Otherwise a borrowed tablet silently books a day of revenue to the wrong branch P&L.
- **Every label uses the paper form's exact wording** (Keluhan, No. Polisi, Nomor WA, Tanggal), screen order matches the paper's section order, and there is a **"SPK Latihan"** practice mode that pushes nothing. Learnable in one shift with no manual is a design constraint, not a training deck — advisor turnover is high.

### Photo mode specifics

- **Capture-time quality gate is the highest-ROI component in the whole photo path and costs $0 in API spend.** Blur (variance of Laplacian), exposure, glare fraction, page-fill, skew — all client-side, in Bahasa: *"Terlalu buram" · "Ada silau" · "Dekatkan" · "Miring"*. Burst 2–3 frames, auto-select sharpest. Reject-and-reshoot costs 5 s; a bad extraction costs ~60 s of review plus a possible wrong Turboly record.
- **Signature ink-density is computed on-device at capture and syncs with the JSON.** The blob is evidence, not the computation input — otherwise a slow blob upload blocks submission with a misleading "signature missing" error.
- **Signature and damage-diagram crops never leave the region and never go to any API.** Enforce it in the crop map, not by convention.
- **If extraction is switched on later:** template registry from day one (two doc types already exist); verify every homography against the QR fiducial and fall back to whole-page on failure (a 5%-off homography extracts adjacent fields *with high model confidence*); Haiku's minimum cacheable prefix is 4096 tokens so the Lane-1 prompt must be padded past it with few-shot tick exemplars or it silently never caches.

---

## 6. THE PUSH PIPELINE (only in W1/W2)

### 6.1 Throughput arithmetic

| Input | Value |
|---|---|
| Volume | 500 SPK/day ÷ ~9 operating hours = **55.6/hr flat** |
| Peak factor (morning drop-off cluster) | ×2.5 → **~140/hr design peak** |
| Worst-case burst | **200/hr** |
| Service time per record *(UNVERIFIED — E3 must measure this)* | **45 s median · 90 s p95 cold · ~30 s marginal inside a batched session** |

Little's Law, `L = λ × S`:

| Scenario | λ | S | Raw workers | Sized at 2.5× (queues degrade above ~70% utilisation) |
|---|---|---|---|---|
| Peak, median | 0.0389/s | 45 s | 1.75 | 4.4 |
| Peak, p95 | 0.0389/s | 90 s | 3.5 | 8.8 |
| Burst, p95 | 0.0556/s | 90 s | 5.0 | 12.5 |

**Capacity at 6 workers:** 480/hr raw, ~336/hr at 70% utilisation — **2.4× headroom over the 140/hr peak.** With batching (30 s marginal): 720/hr raw. **Recommendation: 6 workers, 8 for comfort. Throughput is not the risk.**

### 6.2 Where it actually breaks — none of these are throughput

| Risk | Why it's the real ceiling |
|---|---|
| **Cumulative failure volume** | 15,000 records/month. At 99% per-record success = 150 DLQ items/month (fine). At 95% = **25 manual fixes/day**, which consumes the entire benefit. The binding constraint is per-record reliability. |
| **Single shared HO account** | If Turboly permits one session per user and only one account is issued, a global mutex caps throughput at **80/hr — below the 140/hr peak.** This is the one configuration where the math genuinely fails, and it's a licensing question, not an engineering one. |
| **UI change** | One changed selector = 100% failure until patched. |
| **A new *required* field** | All selectors still resolve; Turboly returns an inline validation error; the classifier calls it "permanent/data → 0 retries → DLQ"; the **structural breaker never trips** because nothing structural happened; ~500 records land in DLQ before a human diagnoses a one-line fix. |
| **Unautomatable 2FA** | Email/SMS OTP with no dedicated mailbox turns every session refresh into a human interrupt. |
| **Real architectural ceiling** | ~2,000/day. Nawilis must grow 4× before the architecture is the problem. |

### 6.3 Design decisions

- **One BullMQ queue per branch (23 queues)**, workers drawing round-robin and skipping branches whose lease is held. BullMQ's group fairness is **Pro-only**; with one FIFO queue, one branch's 180-record offline backlog starves the other 22 for ~22 minutes — precisely when someone starts entering manually and generating duplicates the queue later replays. Cap any branch at ~2 workers regardless of depth.
- **The poller is load-bearing; change streams are a latency optimisation.** A 15-s sweep over the queue index is the correctness mechanism. Change streams silently strand everything queued during an oplog-window gap (`ChangeStreamHistoryLost` → most code restarts without a resume token → starts from "now"), and they can't fire on `nextAttemptAt <= now` anyway.
- **One BrowserContext per worker, page concurrency 1, non-negotiable.** ERP session state (last-viewed record, wizard position) means parallel pages inside one session cause cross-talk that lands data on the wrong record — the worst failure mode because it looks like success. Recycle the browser every ~50 jobs.
- **Batch by branch**: drain up to 10 jobs or 5 minutes on one session before releasing the lease. Amortises login+navigate; drops marginal time 45 s → 30 s.
- **Priority by branch type.** QuickServ `priority: 95`, hard 5-minute target; full Nawilis 15 min. A QS oil change is a 20–30 minute door-to-door job — the customer is at the cashier before a 30-minute-lagged SWO exists, so the cashier rings it as a retail walk-in and the SPK later creates an orphan SO that is never invoiced. The branch learns that workaround in one shift, and it bypasses the entire Service module.
- **Retry classification, not blanket retry.** Transient (5×, 30 s→1 h exponential + full jitter) · Auth (does not consume budget; re-auth once → `blocked_auth`) · Permanent/data (0 retries → DLQ with verbatim Turboly error) · Structural (1 cheap retry → DLQ **and** increment the structural counter). **Critically: "login endpoint returned 5xx / connection refused / DNS failure" is *infrastructure*, not auth** — retry with backoff, never count it toward any breaker, or a 4-minute Turboly deploy flaps all 23 branches into manual mode.
- **Two circuit breakers.** Per-account auth (3 consecutive failures → 15 min open). Global structural, tripping on **any** of: canary fails twice consecutively · ≥5 consecutive structural failures across ≥2 branches · structural rate >25% over last 20 jobs · **identical normalised `turboly_error_text` on ≥5 records across ≥2 branches within 10 min** (cross-branch repetition of a byte-identical error is a schema change, never a data problem). **While open, jobs stay queued — never DLQ'd.** Every transition written to a Mongo audit trail.
- **Canary: read-only is primary.** Every 5 min, load the Service Order form and hash the set of `name`/`id`/`data-*` attributes on its controls. A changed hash while all selectors resolve means Turboly shipped something that hasn't broken you yet — the only signal that arrives *before* the write canary fails. Zero writes, zero pollution. The **write** canary runs at most hourly, in a dedicated `ZZ - Canary` store if the tenant will create one, and **only with the accountant's sign-off**: at 52 runs/day it would create ~15,600 Service Orders + ~15,600 voids/year inside the ledger that produces consolidated financial reporting. That's an audit finding.
- **Rate limiting is a defensibility feature, not politeness.** Hard-cap 6–8 concurrent contexts *regardless of queue depth* — **never scale workers up to drain a backlog**, that is exactly the moment a legitimate integration starts resembling an attack. Business-hours window 07:00–20:00 WIB (a 3 a.m. burst of 400 writes is the most attack-like signature available). Honest UA suffix `… NawilisSPKBridge/1.2 (+ops@nawilis.com)`. **Static, disclosed egress IP — explicitly no residential or rotating proxies**, that is the line between automation and evasion. Treat any WAF challenge as a full stop + page a human, never as something to solve. ⚑ Move the reference-data mirror sync from 03:00 to **06:00** — inside the window you told the vendor you operate in.

### 6.4 Degradation ladder

Descends automatically, ascends only with a human. That asymmetry is deliberate.

| Rung | Descend when | Behaviour | Ascend |
|---|---|---|---|
| **0 — Full auto** | (normal) | Capture → Mongo → queue → Turboly → verified. Staff see `✓ Terkirim`. | — |
| **1 — Sampled audit** | Verified success <95% over a 24 h window, **or** read-back mismatches >2% (landing, but landing *wrong* — the most dangerous state) | Auto-push continues + **20% sampled human read-back audit**. *(Pause-before-save only works if Turboly's form has a deferrable commit step — check in E3. If it's single-shot, sampled audit is the only viable Rung 1, and it's cheaper anyway.)* | 100 consecutive verified successes **and** canary green 1 h |
| **2 — Assisted entry** | Structural breaker OPEN, **or** auth blocked >50% of accounts, **or** Rung 1 >2 h with growing backlog — **all requiring ≥10 min of continuous failure, not N consecutive events** | Stop driving the browser. Emit per-branch **keyboard-ordered work sheets** (columns in Turboly's exact tab order) + **clipboard-assist console** with sequenced copy-buttons and a mandatory *"mark entered → paste doc no."* completion step. ⚑ **Recovery is an HO function, never a branch function** — 1 named FTE at HO with all-store credentials owns the DLQ and Rung 2 queues; branch UI shows status only, never a task. Nobody types 40 SPKs at a branch on a Saturday evening. | Canary green 3 runs **and** an operator clicks Resume. **Never auto-resume** — if the UI changed, a human looks at the fix before 400 queued records replay against it. |
| **3 — Manual** | Turboly unreachable, credentials revoked, or the vendor asks you to stop | **Capture continues completely untouched.** Records accumulate as `manual_pending`. The replayer **must** token-search before re-entering anything a human already typed. | Manual |

**Anti-flap:** 15-min minimum dwell before descending further; ascent thresholds strictly stricter than the descent that triggered them. **Notification:** in-app banner in Bahasa (*"Mode manual: SPK tersimpan, tapi harus diinput manual ke Turboly. Cetak lembar shift."*) — never English, never a stack trace. Per-record badges 🟢 Terkirim · 🟡 Menunggu · 🔵 Perlu input manual · 🔴 Gagal, tappable to a one-sentence reason. **WhatsApp message to branch supervisors on every rung change** — they live in WhatsApp; a dashboard nobody opens is not a notification channel. Send the "we're back" message automatically even though resume stays manual.

---

## 7. VALIDATION IN THREE LAYERS

### Layer 1 — Form-level (client-side, deterministic, free)

| Rule | Severity | Detail |
|---|---|---|
| `PLATE_FORMAT` | BLOCK | `^([A-Z]{1,2})\s?(\d{1,4})\s?([A-Z]{0,3})$`. Position-aware correction first (digit block: O→0, S→5, B→8, I/L→1, Z→2, G→6; letter blocks reverse), then area-code check against the ~90-code closed set. ⚑ **A non-local prefix lowers confidence, never rejects** — out-of-town customers are legitimate. |
| `KM_SEPARATOR` | auto | `.` = **thousands**, `,` = decimal (id-ID). `45.230` → 45230. Assuming English convention is a silent 1000× error that then poisons monotonicity for every future visit. |
| `KM_RANGE` | BLOCK | 0–1,500,000. |
| `WA_FORMAT` | CONFIRM | Normalise to E.164; validate the 3-digit operator prefix (Telkomsel 811-814/816-819/821-823/851-853, Indosat 855-858, XL 817-819/859/877-878, Axis 831-838, Three 895-899) to catch transpositions length alone misses. **No checksum exists → this field stays CONFIRM permanently unless history-matched.** |
| `BRAND_MODEL_COMPAT` | WARN | `Toyota Xenia` is impossible (Daihatsu). Never a hard reject — the vocab always lags the market. |
| `TAHUN_VS_MODEL_YEAR` | WARN | `Toyota Raize 2005` is impossible (Raize launched 2021). |
| `MERK_NORMALIZE` | auto | Jaro-Winkler **≥ 0.92 only**. `Xenia`/`Xpander` are both real and a few edits apart; a loose threshold manufactures confident wrong data, strictly worse than a flagged unknown. Always keep `merkRaw` + score. |

### Layer 2 — Pre-push business rules (server, before enqueue)

| Rule | Severity | Detail |
|---|---|---|
| `MIRROR_STORE_RESOLVES` | BLOCK | `branchCode` → a real `tb_stores` row. |
| `MIRROR_ALL_SKUS_MAPPED` | BLOCK | Every ordered `jobLines[].turbolySku` exists in `tb_service_products` for that store. ⚑ **Unknown SKU blocks; unknown *customer* never blocks** — the push searches live and creates on genuine miss. Absence from the mirror means "not known", not "does not exist", except for COMPLETE-class entities. If the service-product mirror is STALE, **degrade this rule from BLOCK to WARN** — a stale mirror must not halt 500 SPKs/day. |
| `JOBLINE_MIN_ONE` | BLOCK | At least one ordered line with a SKU. |
| `KM_MONOTONIC` | **CONFIRM, not BLOCK** | ⚑ Changed from the original design. One bad first-visit odometer read (`45.230`→`452300`) passes every check (no history to compare), becomes the baseline, and then **BLOCKs that vehicle on every future visit forever with no repair path**. Present two options: *"correct this reading"* or *"correct the stored history"* (writes `KM_BASELINE_CORRECTED`). Fit a robust trend over the last N readings rather than trusting the max. On a first-visit vehicle, KM is CONFIRM regardless of confidence — it's the only field with permanent downstream memory and no cross-check. |
| `PLATE_CORRECTION_CAP` | auto | ⚑ **If `noPolisi.correctionsApplied` is non-empty, cap the tier at CONFIRM regardless of history agreement.** Otherwise: correction makes a wrong plate valid → fuzzy lookup matches a different real car → `history_match` is read as corroboration → tier upgrades to AUTO_PASS → the review UI renders it small and grey and does not stop. Three mechanisms that each look like accuracy improvements jointly manufacture confident wrong data. |
| `VEHICLE_BIND_TWO_SIGNALS` | auto | Binding to an existing `vehicles` doc requires plate **plus** (merk match OR WA match OR name Jaro-Winkler ≥0.9). Single-signal on a corrected plate becomes a one-tap disambiguation. Log `bindReason`. |
| `SIG_CUSTOMER_PRESENT` | blocks **invoicing**, not intake | `present == false` → block invoice. `present == undefined` (blob pending) → allow submit, defer, alert after 1 h. Allowed bases: `wet_signature` · `on_glass` · `verbal_recorded` (advisor attests + PIN + timestamp). A single customer refusal must never block the SPK — the advisor's only escape would be paper. |
| `SCHEMA_VERSION_IN_RANGE` | BLOCK | Workers declare a supported range and **refuse** documents outside it → `migration_pending` + alert. Fail closed, loudly. A v4 worker reading a v3 doc can create a Service Order with **no billable lines** that passes every existence check and reaches `confirmed` — every affected car serviced and never billed. |

### Layer 3 — Post-push reconciliation

**Per-record verification** (sets `confirmed`, nothing else may):
- Runs in a **separate process, separate browser context, fresh navigation** — nothing about the write session may leak into the read.
- Searches the **persistent Service Order list by `correlationToken`**. Never the Service Dashboard: completed SWOs drop off it after 5 minutes, so a fast QuickServ job produces a false negative → `manual_intervention` → a human sees "not found in Turboly" and re-enters it. **The verification mechanism itself becomes the duplicate vector.**
- Asserts store (read off the **created document's own detail page**), **line count, line SKUs**, and KM — not merely existence.

**Nightly reconciliation — must read ZERO on a normal day, or nobody will read it:**

```js
// Identity, not date buckets. No date join anywhere.
const turbolySOs = await harvestServiceOrders({ window: '72h rolling' });
const byToken    = turbolySOs.map(extractToken);          // "SPK:<ulid>"

missingInTurboly = mongoConfirmedTokens  −  byToken       // we think we pushed; Turboly disagrees
extraWithOurToken = byToken ∩ ourTokens  −  mongoOwned    // DOUBLE-PUSH. Page immediately.
extraNoToken      = byToken.filter(t => t === null)       // manual entry. Informational only.
stuck             = spk.count({ state: {$nin: terminal}, capturedAt: {$lt: now-4h} })
```

⚑ **Why 72 h rolling and no date join:** three different dates are in play — `businessDate` (Asia/Jakarta day of `receivedAt`), Turboly's SO creation date (the *push* date), and the 07:00–20:00 push window that guarantees every post-20:00 SPK is pushed the next day. Any date-bucketed comparison produces non-zero deltas *every day from correct behaviour*, routes correct records to `manual_intervention`, gets them re-entered as duplicates, and within two weeks ops stops reading the only control that catches genuine silent loss.

### Alert routing

| Signal | Threshold | Fires to | Why |
|---|---|---|---|
| `extraWithOurToken > 0` | any | **Page engineering immediately** | Definitional double-push. Possible double-billed customer. |
| `missingInTurboly > 0` | any | HO recovery desk | Genuine silent loss. |
| E11000 on `uq_turboly_so` / `uq_turboly_swo` | any | **Page engineering** | Double-adoption. Never swallow this exception. |
| DLQ: `failure_class = data` | depth >10 or age >4 business hours | **HO recovery desk** (Turboly-literate) | Engineers cannot fix "service product not found". |
| DLQ: `failure_class ∈ {structural, auth}` | any | **Page engineering** | |
| Top normalised `turboly_error_text`, last hour | ≥5 records / ≥2 branches | **Page engineering + trip breaker** | Schema change discriminator. |
| Age-in-state | `queued >10min` · `pushing >5min` · `needs_review >4h` · `manual_intervention >4h` | HO ops | Catches queued-with-no-worker-interest before the nightly job. |
| Per-branch `captureLagMinutes` median | >20 min | HO ops | ⚑ **The single best adoption telemetry in the system** — it tells HO which branch has silently reverted to paper without anyone having to admit it. |
| Per-branch `SPKs captured ÷ Turboly service invoices` | <0.8 | HO ops weekly | The adoption ratio. The recon job already computes both halves. |
| Per-branch rectification-failure / quality-gate reject rate | >2× 7-day baseline | HO ops | One branch's new glossy counter can silently send its whole day to `manual_intervention`. |
| `cache_read_input_tokens == 0` rate | >5% per lane | Engineering | The Haiku 4096-token minimum-prefix trap fails **silently** at ~4× the Lane-1 bill. |
| Daily cost/doc | >30% off 30-day median, or >120% of modelled monthly | Engineering + finance | Store `pricingVersion` — Sonnet 5 intro pricing expires 2026-08-31. |
| SLO | *99% of SPKs reach `confirmed` within 4 business hours of capture*, 24 h sliding window | HO ops | Derive ladder thresholds from this error budget, not from a 50-job count (~20 min of volume — it will flap). |

---

## 8. PHASED PLAN

### Week 1 — standalone value, zero Turboly dependency, zero legal gate

| Ship | Why it stands alone |
|---|---|
| Typed intake PWA, offline-first, ≤30 s, on 2 devices at **one pilot branch** | Paper continues unchanged. Additive only. |
| MongoDB + object storage in-region, `spk` / `spk_events` / `vehicles` / `ref_*` | System of record from day one. |
| **Cross-branch plate index + vehicle history search** | Spooring/balancing is a high-repeat business; a customer's history at Cibubur is invisible at BSD today. This is a genuine competitive capability and the best counter-conversation tool the advisor has. |
| **QR job ticket printing** (Bluetooth thermal) | Replaces nothing, adds the traveler the shop already needs. Ticket-QR scan captures MK/WAKTU at the right moment. |
| Branch queue screen + branch/HO dashboard (open SPKs, job mix, estimated completion) | Today this exists only if someone counts paper. |
| `ref_branches`, `ref_service_codes` seeded; **`tb_stores` + `tb_service_products` loaded from a manual UI export (E4)** — no scraping | Real store IDs and real SKUs, obtained without any automated access, before the ToS question is answered. |
| Send the Turboly message (§11), pull the contract (E2), record the manual-entry walkthrough (E3), scan the QRs (E5) | Resolves the architecture. |

**Explicitly *not* in Week 1:** photo extraction, RPA, tablet-replaces-paper, WhatsApp sends, public status URL, geolocation.

### Weeks 2–4

- **Photo-at-handover as pure image archive** — quality gate, in-region storage, on-device signature ink-density, damage-diagram crop. **Zero API calls. Zero cross-border transfer.** The liability record is complete from here.
- **Amend flow** (`open → amended → closed`) + ticket-QR scan at start/finish/handover.
- **Review console** (shared component with the intake form, per-field provenance chips) + **HO recovery desk** with the DLQ split by `failure_class`.
- **Assisted manual entry with mandatory doc-number write-back** — this is the W3 product, and it's also Rung 2 and Rung 3 of the ladder. Build it once, use it three ways. Even at its worst it beats transcribing handwriting, and the write-back keeps reconciliation intact.
- **Reconciliation by count**, per branch per day, plus the adoption ratio. (Token-based recon arrives with the push.)
- **Legal track, in parallel:** appoint the DPO, run the DPIA, execute the Anthropic DPA + ZDR *if* extraction is going ahead, draft the employee privacy notice, set the retention schedule (§9).
- Roll to 3 branches — one full Nawilis, one QuickServ, one high-volume. Never big-bang.

### Later — gated, in this order

| Gate | Then build |
|---|---|
| DPIA complete + DPA/ZDR executed + QR payload known (E5) | **AI extraction lanes.** 3-lane pipeline (Lane 0 local, Lane 1 Haiku 4.5 ticks, Lane 2 Sonnet 5 handwriting, field-level Opus 5 escalation). Budget at **list** pricing: ~$0.041/doc → **$246/mo at 200/day, $615/mo at 500/day.** Never send signature or damage crops. Never run the nightly Batch audit under a ZDR-uncovered endpoint. |
| **E1 returns W1** | Thin API/CSV adapter. Delete the canary, DLQ console, degradation ladder, mirror completeness semantics, and claim-table machinery from the plan. |
| **E1 returns W2 in writing AND E3 confirms a searchable reference field** | RPA fleet behind a feature flag, one pilot branch, sampled audit from day one. |
| Either gate fails | **Stop at W3.** Ship assisted manual entry and the doc-number write-back. Do not build the RPA. |
| Extraction stable + branches actively asking | Tablet-replaces-paper — and only with a written counsel opinion that an on-glass signature is enforceable for this authorization text (§9). |

---

## 9. RISK REGISTER

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **ToS / vendor relationship.** RPA against a tenant whose acceptable-use terms nobody has read. There is no public ToS — `turboly.com/terms` redirects to the homepage; only a Privacy Policy exists and it is silent on automated access. | Med | **Catastrophic** — suspension of the tenant running POS, inventory, and finance for 23 outlets. Chain-wide revenue interruption + emergency ERP migration under duress. Upside is ~Rp 300jt/yr of typing labour. | **Hard gate:** written permission or an API. §11 message. Read the contract (E2) before a line of RPA. A verbal "should be fine" from sales is not a defence in a termination dispute. Also ask explicitly whether automated entry affects support scope. |
| 2 | **UU PDP 27/2022 — cross-border transfer.** Lane 2 sends name/address/WA/plate to a US API. Art 56 permits offshore transfer only on adequacy, adequate-and-binding safeguards, or consent. Indonesia has issued no adequacy list; the pre-printed authorization covers *the work and a test drive*, not cloud/AI/offshore processing. **No basis exists today.** | High if extraction ships as designed | Fine up to 2% of annual revenue + civil claims | **Extraction is off the critical path (§5, §8) precisely because of this.** Before switching it on: execute Anthropic's DPA; enable **ZDR** and get written confirmation of covered endpoints (it covers Messages + Token Counting, **not Batch/Files/Managed Agents**, and Batch retains ~29 days); **delete the nightly Batch audit** or move it under ZDR — the ~$220/mo discount is not worth a 29-day US retention window on signature-bearing images; add processing purposes to the authorization paragraph at the next print run. |
| 3 | **UU PDP — DPO and DPIA are mandatory, not optional.** Constitutional Court 151/PUU-XXII/2024 reinterpreted Art 53(1)'s "dan" as "dan/atau" — **any one** criterion triggers the DPO duty. Nawilis meets at least two (large-scale systematic monitoring; specific personal data). Art 34(2) requires a DPIA *before* high-risk processing begins. | High | Standing administrative violation from day one, independent of anything going wrong | Appoint a DPO (an existing employee with the function formally assigned is sufficient) and complete the DPIA **before the pilot branch**. 2–4 weeks of external counsel. **Put both above the QR-code question on the blocker list.** |
| 4 | **Signature handling — the tablet may weaken the record it is sold on.** PP 71/2019 Arts 59–60: certified (PSrE-issued) and uncertified e-signatures are both lawful but carry different evidentiary weight; uncertified sits at *akta di bawah tangan* level and can fail the authentication element. Certified at ~125,000 sigs/yr × Rp 3,000–5,000 = **Rp 375–625jt/yr** — more than the project's entire operational saving. | Med | Rp 50–70jt of hardware buys a *weaker* artifact than the wet signature Nawilis has relied on for 60 years | **Keep the paper original as the legal artifact.** Photograph it; file the physical sheet. Position the tablet record as operational convenience. If tablet-only is insisted on, get a written counsel opinion first and store the signature as a **flat raster without stroke timing** — the stroke-path-plus-timing capture is what most plausibly makes it biometric data under Art 4(2), which is itself a DPO trigger. |
| 5 | **Retention conflict + no legal hold.** UU 8/1997 requires 10-year retention of bookkeeping evidence and its supporting financial-administration data, with **personal liability for the responsible officer** for losses from early destruction. The design set 5 years, on a MongoDB TTL that deletes only the metadata row — over-retaining orphaned S3 objects and under-retaining metadata simultaneously. TTL cannot be paused, so the record for a disputed vehicle is the one most likely to auto-delete mid-dispute. | Med | Director liability; evidence destroyed mid-dispute | Retention **per data class**: financial-linkage 10 yr; condition/liability images per counsel; extraction telemetry and per-field `touchedMs` 90 days (PDP minimisation). Replace the TTL index with a **reviewed deletion job** that deletes object + metadata together and honours `legalHold: true`. Sign off the retention schedule as a DPIA input. |
| 6 | **Breach notification — 3×24 h statutory clock, no runbook.** One bucket accumulating ~180,000 ID-grade records/yr (name + address + phone + plate + signature) where 23 filing cabinets used to be. | Low–Med | Art 46 notification duty; criminal provisions to 5–6 yr / Rp 5–6 miliar, corporate fines to 10×. The supervisory body is still being formed with Komdigi acting interim — an immature regulator is not a defence, and it makes the reputational channel faster-moving | Write the runbook before the first record: detection triggers, named notifier, 72 h clock owner, pre-drafted Bahasa subject notice. Encrypt at rest with a customer-managed key. `credentialRef` only, enforced in CI. |
| 7 | **Duplicate Service Orders → double-billed customers.** A *stalled* (not dead) worker whose in-flight Save outlives its lease defeats all four "impossible" layers: the reaper releases, W2 finds no token yet (still in flight), orphans the claim, retries, and both saves land. | Med | Customer-visible billing error wearing a green checkmark | Lease **fencing epoch** re-asserted before every irreversible click. **Quarantine, never orphan-on-first-miss** — a `claimed` row may not be released until `3 × max observed save latency` with a repeated token search. Token-only identity: delete the plate+date search and the fingerprint fallback outright. E11000 on `uq_turboly_so` pages immediately. |
| 8 | **Wrong-branch data.** Two independent paths: a borrowed/moved tablet (capture side) and a client-side-optimistic store switcher (push side). | Med | Corrupts branch P&L, stock movement, commissions. Silent. | Device–branch binding + geofence + supervisor PIN. Verify the store off the **created document's detail page**, never nav chrome. Weekly out-of-geofence audit report. |
| 9 | **Adoption failure — the peak-hour test.** 17:00 Saturday, 12 cars, one tablet. If the app is slower than a clipboard at the peak, it loses at 10:00 Tuesday too — habits form at the peak. | **High if built as originally designed** | Total project failure, quietly | ≤30 s intake · **2 devices minimum per branch** · paper stays as the traveler · printed QR ticket · one named SPK champion per branch · `captureLagMinutes` and the capture÷invoice ratio as the honest adoption metrics. |
| 10 | **Review becomes a rubber stamp, and the self-tuning loop bakes it in.** Deferred review → one tired person clears 30 SPKs at 20:00 → <5% correction rate on every field → the closed loop reads operator fatigue as extraction accuracy and auto-demotes fields to AUTO_PASS. | Med–High (photo mode) | "Zero wrong records reaching Turboly" becomes silently false | Never demote on human-accept data alone — require an independent second vote. Hard-exclude sessions with median review <6 s/SPK from the tuning corpus. Cap unreviewed backlog per branch at 5. **All tier changes are human-approved, versioned diffs in `ref_field_policy`, never unattended writes.** |
| 11 | **ROI inversion.** ~60–70% of engineering cost sits in the ~30%-of-value last mile. Gross labour pool ≈ Rp 316jt/yr *(500×3 min at UMP DKI 2026 Rp 5.73jt loaded ≈ Rp 40.5k/hr — 3 min/SPK is UNVERIFIED)*; minus review + DLQ burden ≈ Rp 260jt net; minus run-rate (extraction + infra) ≈ Rp 145jt/yr → **≈ Rp 115jt/yr before any build cost.** Build is realistically Rp 400jt–1.0 miliar *(ESTIMATE)*. Payback on the last mile alone: 4–9 years. | High | The project is justified on a saving that mostly isn't there | **Typed-first deletes the extraction run-rate.** Price the W1 alternative before building W2 — a vendor-built endpoint is plausibly Rp 50–300jt one-time, a third to a fifth of the RPA path, zero account risk, zero maintenance tax. |
| 12 | **Cost model expires in 31 days.** Sonnet 5 intro $2/$10 ends 2026-08-31; list is $3/$15. | Certain | ~38% overrun from month two, plus unhedged USD/IDR | Budget at **list**: ~$0.041/doc, $615/mo at 500/day. Store `pricingVersion` on every extraction record. Alert at 120% of modelled monthly. |
| 13 | **QuickServ controllership undefined for 10 of 23 branches.** QS bays sit inside bp stations with Castrol/Tire Pro; the English inspection form's ownership is unconfirmed. | Med | Undefined controller for 43% of branches; UU PDP requires a documented joint-controller arrangement | Determine controllership per branch type before capture begins. Execute a data-sharing agreement. Confirm who owns the QS form — if the partners own it, its fields may be unchangeable. **Consider phasing QS out of v1**: 13 Nawilis branches is a cleaner legal perimeter and still covers the full 12-line workflow. |
| 14 | **PSE registration.** A customer-facing status URL triggers registration under Permenkominfo 5/2020 via OSS-RBA; non-registration escalates to **access blocking** — a blocked URL printed on customer receipts. | Med | Customer-facing outage + regulatory notice | Register before the status URL ships, or defer it to phase 2 and send a static WhatsApp summary in phase 1. |
| 15 | **WhatsApp receipts are neither free nor sendable from a shared tablet.** Click-to-chat sends from the *device's* number — either an advisor's personal number (customer takes the relationship when they quit) or an account bound to a shared tablet. | High if built as designed | Relationship leakage + a broken feature presented as a free win | Send **server-side via the WhatsApp Business Platform** from one Nawilis business number. Cost is not the obstacle (~$0.0036/msg utility in ID ≈ ~$54/mo at 500/day + BSP fees). The obstacles are business verification, **pre-approved utility templates** (you cannot free-text a receipt), and the 24 h service window — **budget 2–4 weeks for template approval before launch.** Reminders need a separate, explicitly-ticked consent (`consent.marketing`), hard-gated. |
| 16 | **Employee surveillance telemetry with no lawful basis.** `review.durationMs`, per-field `touchedMs`, `deviceId`, operator identity, staff signature, and `capture.geo`. | Med | PDP exposure + industrial-relations dispute the first time a supervisor ranks staff by review time | **Drop `capture.geo` entirely** — branch comes from the session; the stated use is achieved by the periodic paper-vs-session audit. Publish an employee privacy notice; run on *kepentingan yang sah* with a documented balancing test; commit in writing that per-operator timing is aggregate-only and never disciplinary; aggregate to branch level after 30 days. Corpus reuse for tuning is a **second purpose** needing its own basis. |
| 17 | **Canary pollutes a production financial ledger.** ~15,600 SOs + ~15,600 voids/yr, plus a permanent fake customer in the master. | Med | Audit finding; contaminated exports and any data shared with bp/Castrol | Read-only structural canary as the **primary** signal. Write canary hourly at most, in a dedicated `ZZ - Canary` store, **only with the accountant's sign-off**. Track every canary document number and verify the previous run's cleanup at the start of each run. |

---

## 10. OPEN QUESTIONS FOR YOU

Ordered by how much they unblock. Most are answerable in under 10 minutes.

**Blocking the architecture**

1. **Will you send the Turboly message this week?** (§11.) If yes, everything below about RPA can wait for the answer. If no, say so and we design for W3 today.
2. **Can you get the signed Turboly subscription agreement and read the acceptable-use clause?** Who at Nawilis holds it? This is a hard gate on the entire RPA layer, not a checklist item.
3. **Screen-record one Service Order + Work Order being created by hand, start to finish, with a stopwatch.** From that one recording I need: (a) is there a **Reference / Remarks / External No.** field, is it writable, and is it **searchable from the list view**? (b) does the form accept **file attachments**? (c) does an **Inspections** module exist under Setup? (d) is there a **store switcher** in the top nav? (e) **how many seconds** did it take? (e) alone validates or invalidates the entire concurrency model.
4. **Export from Turboly and send me:** the Stores list, the Service Products list (SKU + name + type + tax + price), and the Mechanics/Service Advisors list. Nothing can be pushed until these are real — the seed data ships with `null` deliberately, and inventing a SKU fails mid-flow leaving a half-built Service Order.

**Blocking photo mode**

5. **Scan three QR codes** — two from the same pad at one branch, one from a different branch — and paste the raw payloads. Identical ⇒ static marketing link, we mint our own identity. Different ⇒ variable-data print encoding the serial, and it becomes the primary key linking paper → Mongo → Turboly.
6. **Is the SPK an NCR/carbon-copy multi-part form, and if so which layer do staff photograph?** Carbon copies have dramatically lower contrast and bleed-through and would materially change the accuracy projections.
7. **Are forms photographed flat on the counter or handheld at an angle?** This decides whether homography rectification is 20 lines of OpenCV or a genuine engineering effort.

**Blocking capture UX**

8. **How many service advisors take intake simultaneously at a busy branch at peak?** This sets devices-per-branch. If it's three, one tablet makes peak throughput *worse* than paper.
9. **Do mechanics currently write MK and WAKTU on the SPK during the job, or does the advisor fill them at intake?** If the mechanic writes them, the printed-ticket-QR design is required, not optional.
10. **Where does the price come from today** — a printed list, the advisor's head, or per-branch discretion? And is the price quoted verbally at intake? This decides whether `quotedPrice` is a chip list or free entry.
11. **Do QuickServ bays have usable screen visibility under the SPBU canopy at midday?** Check one before buying 23 tablets.

**Blocking the legal track**

12. **Who is your DPO, or who will be assigned the function?** This is now mandatory, not optional, and it gates the pilot.
13. **Does Nawilis have counsel who can give a written view on (a) the on-glass signature's enforceability for this specific authorization text, and (b) the 10-year retention obligation over SPKs as supporting documents?**
14. **Who owns the QuickServ English inspection checklist** — Nawilis, or bp/Castrol/Tire Pro? If the partners own it, its fields may be unchangeable and QS data may need to flow to them as well.

**Operational**

15. **Is Turboly licensed per-user?** If so, 23 service accounts is an uncosted recurring line item — and creating them may breach a named-user clause.
16. **Which branch do you want as the pilot?** Ideally a mid-volume full Nawilis branch with a supervisor who will actually complain when something is wrong.

---

## 11. THE MESSAGE TO SEND TURBOLY

To: `sales@turboly.com` · cc support · phone follow-up `+62 21-58356894` · or via the contact form at `turboly.com/contact-us/` with Kategori Industri = **Otomotif**.

**Subject / Perihal:** Permintaan integrasi API Service Order — Nawilis (23 outlet, 50–500 transaksi/hari)

---

### Bahasa Indonesia

> Yth. Tim Turboly,
>
> Kami dari **Nawilis Auto Service Center** (Spooring & Balancing Specialist sejak 1963), pengguna Turboly untuk **23 outlet** — 13 bengkel Nawilis dan 10 gerai Nawilis QuickServ di SPBU bp.
>
> Saat ini proses intake kendaraan kami masih menggunakan **SPK (Surat Perintah Kerja) kertas**, dengan volume **50–500 SPK per hari** di seluruh cabang. Kami sedang membangun aplikasi internal untuk mendigitalkan intake tersebut, dan kami ingin data itu masuk langsung ke modul Service Turboly agar tidak terjadi input ganda.
>
> Kami mohon informasi dan penawaran untuk hal-hal berikut:
>
> 1. **API untuk membuat Service Order / Service Work Order** — endpoint, dokumentasi, dan kredensial. Ini adalah kebutuhan utama kami.
> 2. **Alternatif:** apakah tersedia (atau dapat dikembangkan) **import CSV/Excel untuk transaksi service**, seperti yang sudah ada untuk Product dan Chart of Accounts? Import batch harian pun sudah sangat membantu.
> 3. **Sandbox / demo tenant** untuk pengembangan dan pengujian.
> 4. **Penawaran harga enterprise** untuk 23 store, termasuk kejelasan apakah lisensi dihitung per pengguna (kami perlu membuat akun integrasi khusus per cabang).
> 5. Terlepas dari poin 1–4: **konfirmasi tertulis** mengenai kebijakan Turboly atas **akses otomatis ke antarmuka web** (browser automation) dari satu alamat IP statis yang kami sebutkan, menggunakan akun layanan bernama, pada jam operasional 07.00–20.00 WIB. Kami ingin memastikan pendekatan kami sesuai dengan perjanjian berlangganan yang telah kami tandatangani, dan apakah hal tersebut memengaruhi cakupan dukungan teknis.
>
> **Kami bersedia membayar untuk proses scoping maupun pengembangan custom.** Kami sangat terbuka untuk berdiskusi langsung atau melalui video call minggu ini.
>
> Terima kasih atas perhatiannya.
>
> Hormat kami,
> [Nama] — [Jabatan]
> Nawilis Auto Service Center
> Jl. Tanah Abang I No.17–19, Jakarta Pusat
> [telepon] · [email]

---

### English

> Dear Turboly team,
>
> We are **Nawilis Auto Service Center** (Spooring & Balancing specialists since 1963), a Turboly customer across **23 outlets** — 13 Nawilis workshops and 10 Nawilis QuickServ bays inside bp petrol stations.
>
> Our vehicle intake still runs on **paper SPK (work order) forms**, at **50–500 SPKs per day** across all branches. We are building an internal application to digitise that intake, and we want the data to land directly in Turboly's Service module so our staff do not have to enter it twice.
>
> We would like information and a quotation on the following:
>
> 1. **An API to create Service Orders / Service Work Orders** — endpoint, documentation, and credentials. This is our primary request.
> 2. **Alternatively:** is there (or could you build) a **CSV/Excel import for service transactions**, along the lines of your existing Product and Chart of Accounts imports? Even a daily batch import would be a large improvement.
> 3. **A sandbox / demo tenant** for development and testing.
> 4. **Enterprise pricing for 23 stores**, including confirmation of whether licensing is per-user — we would need dedicated integration accounts per branch.
> 5. Independently of 1–4: **written confirmation** of Turboly's position on **automated access to the web interface** (browser automation) from a single disclosed static IP, using named service accounts, during 07:00–20:00 WIB business hours. We want to be certain our approach is consistent with our signed subscription agreement, and to understand whether it affects the scope of technical support.
>
> **We are prepared to pay for scoping and for custom development.** We would welcome a call this week.
>
> Kind regards,
> [Name] — [Title]
> Nawilis Auto Service Center
> Jl. Tanah Abang I No.17–19, Jakarta Pusat
> [phone] · [email]

**Why this wording:** it leads with the ask you actually want (an API), names the volume and store count as commercial leverage, offers to pay, and — critically — **asks the ToS question separately from the API question**, so a "no" on the API still returns the written answer that determines whether W2 is even legal. Send it from a Nawilis address with a title on it; a 23-store customer asking for an integration two months into onboarding gets built, the same customer asking in a year gets a ticket.