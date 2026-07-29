# Retainer Generation — Implementation Plan (rev. 2 — automation-first)

> **Status: planning only — nothing built.** Companion to `MERGE-FIELD-SPEC.md` (the *what*); this is the
> *how*. Revised after a 3-lens review (completeness · efficiency · consultant-automation). Each phase is
> deployed + verified like the rest of the system.

---

## 1. Goal

Replace the placeholder `buildRetainerPdf()` (one hardcoded PDFKit agreement, single fee) with a generator
that **picks the right master template (by signer) → attaches the right Annex A (by case type) → merges all
per-case values + a milestone schedule + government fees → produces the final document** — where the
**consultant reviews a near-complete draft and sends in 1–2 clicks**, never touching Monday, and nothing is
emitted before it's complete (the gate).

## 2. Design principle — "review a pre-filled draft," not "fill a form"

This is the heart of the build. The portal must feel like **signing off on a nearly-finished retainer**, not
data entry. Concretely:

- **Lead with a PREVIEW** of the assembled retainer (master + chosen annex + merged values), not a field list.
- **Everything the system can know is pre-filled** — the consultant only touches what needs *professional
  judgment*, and the UI routes their attention there (confidence flags).
- **The common case = 2 clicks:** open the consultation → "Retain" (draft auto-assembles) → review → "Send."

### 2a. Automation map — what's automatic vs. what the consultant touches
| Field group | Source (automatic) | Consultant action |
|---|---|---|
| Client name / address / phone / email | intake — **`residentialAddress` lead column already exists** (`long_text_mm4730ph`); no promotion needed | none (confirm if changed) |
| Application type · scope annex | **only the broad `confirmedCaseType` is on the lead** at retainer time — the Case **Sub Type** is set on Client Master at handoff, so base-vs-extension picks are always ◑ "verify" | **confirm** (1 click) · override on ◑/❔ cases |
| Master template (PA / PA+Inviter / Employer) | inferred from case + signals | **confirm** · override rare |
| **Inviter/sponsor details** | **captured at intake/pre-consult (client-entered)** | confirm (only fill if missing) |
| **Employer + legal-rep details** | **captured at intake/pre-consult** | confirm (only fill if missing) |
| Professional fee | the fee they already set | — |
| HST (13%) · Total | computed | — |
| **Milestones** | **pre-split by case-type default %, row 1 = admin fee** | tweak amounts if needed |
| Government fee | IRCC table × auto applicant count | confirm/override |
| Applicant count | **`lead.hasSpouse` + `lead.childrenCount`** (NOT Family Members — empty pre-handoff) | — |
| Agreement date | today | — |

> Net: for a clean, high-confidence case the consultant **confirms a couple of selections, glances at the
> preview, and clicks Send** — no typing, no arithmetic, no lookups.

> **⚠ CODE-VERIFIED CORRECTIONS (2026-06-24)** to earlier drafts: (1) the client **address is already a clean
> lead column** (`residentialAddress`/`long_text_mm4730ph`, written at `intakeFormService.js:211`) — drop the
> "promote address" task. (2) **Applicant count must come from `lead.hasSpouse`+`lead.childrenCount`**, not the
> Family Members board (keyed by `caseReference`, assigned only at handoff → empty at retainer time). (3) The
> Case **Sub Type is not on the lead** at retainer time (only `confirmedCaseType`), so §6 base-vs-extension
> annex distinctions can't be auto-resolved — they preselect at ◑ confidence and the consultant confirms.

---

## 3. Core approach — fill the real `.docx`, don't rebuild

Per TDOT's "use as-is" rule, we **fill only the yellow fields in the actual `.docx`** (never re-draft):

- `docxtemplater` + `pizzip` fill the master `.docx`.
- The 27 annexes have **no merge fields** → **pre-render each to PDF once** (static, cached forever) and
  **append** the chosen one with `pdf-lib`.
- Assemble: filled master → PDF, concatenate the annex PDF → one combined retainer PDF. Same
  `/retainer/:leadId` delivery + gating + email as today.
- **Initial Consultation agreement** (spec §1, fields #23–25) reuses this engine — and is **fully
  auto-fillable** (fee/date from the booking, client from the lead), so it can generate at booking with
  **zero consultant effort**. Small parallel deliverable.

### 3b. The one tech spike — docx→PDF on Render (Phase 0; MEASURE, don't guess)
| Option | Reality |
|---|---|
| **A. LibreOffice headless** (`soffice --convert-to pdf`) — **lead** | Install is **build-time** (Dockerfile), a *sunk* cost, not per-request. Best fidelity. Render supports `apt-get install libreoffice` (~adds image size). |
| **B. Cloud API** (Adobe PDF Services / CloudConvert) | Fallback. Per-doc cost + latency. |
| **C. Serve filled `.docx`** | Ship-anyway interim only (messy client signing). |
| **D. mammoth→HTML→Puppeteer** | Rejected — loses "as-is" fidelity. |

**Spike = measure:** (1) Render build-time delta with LibreOffice in the Dockerfile, (2) `soffice` conversion
speed per doc (expect 1–3s). If build <~1 min and convert <~2s → ship **A**, skip B. Annex PDFs are
pre-rendered once and **cached**, so per-retainer cost is only the master conversion.

---

## 4. Data model — capture upstream, pre-fill downstream

Stored on the **Lead board** (retainer is pre-handoff). **Capture the "new" data at intake/pre-consult so the
consultant confirms, never types.**

| Data | Where | Captured at |
|---|---|---|
| `selectedTemplate`, `selectedScopeAnnex` | Lead status + dropdown columns | portal (preselected) |
| Client `paAddress` | **already exists** — `residentialAddress` (`long_text_mm4730ph`) | intake — read `lead.residentialAddress` (no new column) |
| Inviter block (`inviterName/Address/Phone/Email`) | 4 **new** Lead text columns | **intake/pre-consult** (new conditional "is there a sponsor?" block — does not exist today) |
| Employer block (`empRepName/CompanyName/CompanyAddress/CompanyPhone/RepEmail`) | 5 **new** Lead text columns | **intake/pre-consult** (new conditional "employer/LMIA?" block — does not exist today) |
| `retainerMilestones` | **1 new long-text column, JSON** (spec §10A) | portal editor (pre-split) |
| `govFeePerApplicant`, `govFeeTotal` | 2 **new** Lead numeric columns | pre-filled, editable |
| Applicant count | **`lead.hasSpouse` + `lead.childrenCount`** (NOT Family Members) | automatic |

**Milestone JSON schema (formalize in config):** `[{ label, amount, trigger, locked? }]`; row 1
`{label:"Administrative fee (non-refundable)", locked:true}`. Validated everywhere (see `validateMilestones`).

**Config (in-repo, editable):**
- `config/retainerTemplates.js` — 3 masters + Initial Consult; merge-field list; signer rules; **milestone JSON schema**.
- `config/annexCatalogue.js` — 27 annexes (label, file, group) + the §6 case-type → annex preselect map.
- `config/milestoneDefaults.js` — **per-case-type default % split** (e.g. PA 20/30/30/20; sponsorship 25/…; LMIA 15/…); row 1 = admin fee.
- `config/governmentFees.js` — **`irccFees`** (the §11 table, per applicant) **and `esdcFees`** (LMIA = $1,000/**position**, employer-paid — kept separate). Re-verify quarterly (IRCC changed 2026-04-30).

---

## 5. Phases (each deployed + verified)

### Phase 0 — Spike + merge engine PoC
- **Run the docx→PDF spike (§3b) and decide A/B/C with measured numbers.**
- Tag-prep one master: convert its yellow runs → `docxtemplater` tags (replace run *text*, keep run
  properties to protect formatting) → `src/templates/retainer/`. Originals stay as reference.
- Pre-render the 27 annex PDFs (one-off).
- `retainerDocService.generate({ template, annex, data })` → filled master PDF + appended annex → Buffer.
- **Verify:** one full template assembled with sample data; visually diff output vs the source doc.

### Phase 1 — Config, data model, upstream capture, pure helpers
- The 4 config files; the new Lead columns; the milestone JSON column.
- **Intake/pre-consult additions:** conditional **inviter** block (sponsorship) + **employer/legal-rep** block
  (LMIA), and the clean **address** field — so the data arrives *before* retainer time.
- Pure, unit-tested helpers: `pickTemplate(lead)`, `pickAnnex(caseType, subType) → {annexId, basis, confidence}`
  (implements §6a–c), `computeFees(fee) → {hst, total}`, `computeGovFees(annex, applicantCount, {rprf}) →
  {perApplicant, total}` (handles RPRF-deferral + LMIA-ESDC exception), `defaultMilestones(fee, caseType)`
  (per-case-type split, row 1 locked admin fee), `validateMilestones(rows, fee)` (≥1 row, row 1 = admin,
  numeric, sum ≈ fee ± $0.01).
- **Verify:** unit tests for every helper, asserting the §6 rules + the §11 fees + milestone validation.

### Phase 2 — Consultant Portal "retainer draft" (depends on Phase 1 columns being LIVE)
> **Blocker:** start only after Phase 1 is deployed and the new Lead columns are queryable via the API.

- **Preview-led panel:** assemble + show the draft (template + annex + merged values + milestone table)
  on entering the Retain step.
- Inline confirm/override for: **template** + **annex** (each shows *basis* + a **confidence flag** —
  ✔ direct / ◑ rule / ❔ verify — so attention goes to edge cases only).
- **Milestone editor** — pre-split rows from `defaultMilestones`; **row 1 label locked**; live total vs fee.
- **Inviter/Employer** blocks shown only for the matching template, **pre-filled** from intake; confirm.
- **Government fee** pre-filled (table × auto applicant count: "PA + 2 dependents = 3 × $1,590 = $4,770");
  editable.
- Saves via the existing `/api/consultation/:leadId/action` pattern (new actions).
- **One-click "Looks good — send"** after preview. **The portal is the *only* retainer interface** (no Monday).
- **Verify:** in-browser — preselects + confidence flags render; pre-filled milestones/fees/inviter; preview
  matches; sum validation blocks a bad schedule.

### Phase 3 — Gated swap (behind `RETAINER_ENGINE=v2`)
- **Strengthen the gate** in `maybeSendRetainerAgreement`: refuse to emit unless **`selectedTemplate` AND
  `selectedScopeAnnex` AND fee AND a *valid* milestone schedule** are present. ⭐ *Requiring
  `selectedTemplate` is the load-bearing guard — it prevents a contract going out with the wrong signatory if
  anyone bypasses the portal.* Hold + post a one-line "what's missing" note (same pattern as the fee gate).
- On ready-Retain: `retainerDocService.generate(...)` → OneDrive → `Retainer PDF` link → email client —
  **replacing** the `buildRetainerPdf` body. Route, token, reminder, audit-note, and Signed→handoff flow
  unchanged.
- **Verify:** controlled live test on a throwaway lead → correct combined PDF emailed; gate blocks an
  incomplete one.

### Phase 4 — Optional
- AI *suggester* for annex/sub-type + inconsistency flags (spec §9 — suggests, never decides).
- **Admin config screen** so TDOT edits gov fees / milestone-default splits without a developer.
- Milestones → a **Milestones board** *only if* per-milestone payment tracking is wanted (spec §10B).

---

## 5b. Current-system fixes required (code-verified bugs — fix with/before the build)

A grounded audit (file:line verified) of the **live** retainer flow found real issues that affect the
reliability the plan builds on:

- **HIGH — silent email failure locks the lead (agreement).** `retainerService2.js` sets
  `retainerSent: todayISO()` **unconditionally** after the email try/catch (verified ~lines 99–109). If
  `microsoftMail.sendEmail` throws, the lead is still marked sent, the line-69 guard blocks **all** retries,
  and the client **silently never receives the agreement** — staff see only a log warning. **Fix:** set
  `retainerSent` only when the email actually sent (or there's no email); on failure post a **visible staff
  note** and leave the lead un-locked so a retry can fire.
- **HIGH — same pattern in the payment link.** `paymentService.js` (~137–157): email failure isn't tracked;
  "sent" logs unconditionally; the client may never get the Square payment link. Same fix.
- **MEDIUM — webhook outcome not trimmed.** `phase2.js:361` compares `event.value?.label?.text` to `'Retain'`
  without `.trim()`; a stray space → no agreement fires. (The portal trims; the webhook should too.)
- **MEDIUM — link-column parse silent failure.** `leadService.js` (~204–209): a malformed link JSON silently
  yields an empty URL with no log — add a warn.

**Verified SAFE (no change needed):** the fee gate correctly rejects $0/missing (`feeToCents`); the outcome
whitelist is exact (curly quotes/em-dash); the fee-change webhook's two calls (agreement + payment link) are
double-fire-safe via **separate** in-flight maps; cleared-outcome is handled.

> **Recommendation:** fix the two HIGH email-idempotency bugs **before/alongside** the retainer build — the new
> generator depends on reliable delivery, and the bug already affects live clients today.

---

## 6. What stays unchanged (preserve)
The retainer flow we already built: the `/retainer/:leadId` route + token auth; the **fee-gating** (now
widened to template/annex/milestones); the `Retainer Sent` stamp + `conversionStatus`; the `[Consultant
portal]` audit notes; the reminder crons; and **Retainer Signed → handoff + payment link**. We swap *how the
document is built*, not the surrounding flow.

## 7. Risks & mitigations
- **docx→PDF on Render** — main risk; de-risked by the Phase-0 *measured* spike + the serve-`.docx` fallback.
- **Template fidelity** (tag-prep shifts layout) — replace run *text* only, keep run properties; visual-diff vs source.
- **Consultant bypasses the portal → wrong-signatory contract** — the gate **requires `selectedTemplate`**;
  generation is impossible without a portal-confirmed template. ⭐ highest-value safety.
- **Milestone JSON divergence / silent blank PDF** — one formal schema + `validateMilestones()` called in
  the portal save *and* before generation; clear error, never a silent blank.
- **Missing/stale annex PDF at runtime** — **build-time check**: verify every file in `annexCatalogue.js`
  exists, else fail the build.
- **Gov fees drift** — editable config + consultant override + a quarterly re-verify reminder (IRCC changes).

## 8. Dependencies / still needed from TDOT (non-blocking for P0–P3)
- **New annex documents** for uncovered case types (spec §7) — until then those cases get "no annex /
  consultant attaches manually."
- Confirmation of the **default milestone % splits** per case-type family (we'll seed sensible defaults; they tune).
- Government-fee defaults already pre-filled from IRCC; TDOT can adjust in config.

## 9. Sequence
Phase 0 (spike + PoC) → Phase 1 (config/data/intake-capture/helpers) → **[columns live]** → Phase 2
(preview-led portal draft) → Phase 3 (gated swap, flagged) → verify on a test lead → flip the flag. Phase 4 as
wanted. Each phase deployed + verified before the next.
