# TDOT Retainer Templates — Merge-Field Specification

> **Status:** capture/documentation only. No system changes made. This spec records every per-case
> "fill-in" field (the **yellow-highlighted** runs) across the retainer templates, what each should be
> filled with, and whether the system collects that data today.
>
> **Source:** `Retainer Agreement Templates/` (template version **TDOT3.1, 2025-11-22**), extracted from the
> actual document highlighting on 2026-06-24.

---

## ✅ TDOT decisions — resolved 2026-06-24 (these supersede the ❌/❔ marks below)

1. **Use the templates AS-IS.** The generator fills **only the yellow merge fields**; every other word (firm
   address, clauses, letterhead) is left exactly as TDOT wrote it. We do **not** edit their documents. The
   §5 "QA flags" are optional clean-ups for TDOT, not changes we make.
2. **Firm address** = **"20 De Boers Dr., Suite 202, Toronto, ON M3J 0H1"** (the header value). It is static
   text, not a merge field, so the generator leaves it untouched anyway.
3. **"PA" = Principal Applicant** everywhere it appears. The LMIA template's "principal applicant's email"
   field is used as written. *(Build note: revisit only if an employer-only LMIA case has no PA email.)*
4. **Federal PR and Non-Express-Entry annexes are TWO DIFFERENT scopes** — keep both, do **not** merge.
   The annex library stands at **27 distinct** scopes.
5. **Selection = preselect the annex whose name matches the case type; the consultant confirms or overrides.**
   We do **not** need to perfect the mapping or create every missing annex up front — the consultant decides.
   New annexes for uncovered case types will come from TDOT as needed.
6. **Milestones: default to 4** (editable). The **first is always the non-refundable administrative fee.**
   The schedule **differs by case type and per case** — the consultant adjusts it in the portal.
7. **Government fees: system pre-fills a default value, the consultant can update it per case.** (So we hold
   a gov-fee reference; it is editable, not authoritative.)
8. **Confirmed:** sponsorship → **PA + Inviter** template (sponsor = the inviter); LMIA/employer → **Employer**
   template · **HST = 13%** · **biometrics = $85 / applicant (14+).**

**Still needed from TDOT (later, not blocking design):** the actual **government-fee amounts** to pre-fill
(per application type), and **any new annexes** they want for currently-uncovered case types.

---

## 1. Key facts

- **Yellow highlighting = the per-case merge points.** Only the **4 documents** in
  `Retainer Agreement Template/` contain yellow fields. The **27 Annex A documents have none** — they are
  static scope-of-work text that is **selected** (by application type), not filled in.
- **Constants (pre-printed, NOT merge fields):** RCIC **Shafoli Kapur, RCIC-IRB #R518177**; firm **TDOT
  Immigration Services Inc.** All standard clauses (fees-non-refundable, refund policy, termination,
  confidentiality, governing law = Ontario, etc.) are fixed text.
- **White-highlighted passages are NOT fields** — they are standard clause text (the non-refundable
  admin-fee acknowledgment and the late-fee clause). Do not substitute them.

### Template selection (which master doc to generate)
| When the case is… | Use this master template | Signatories |
|---|---|---|
| Standard application, single applicant | `Retainer Agreement … To be signed by PA.docx` | PA + RCIC |
| Sponsorship / has an inviter or sponsor | `Retainer Agreement … To be signed by PA + Inviter.docx` | PA + Inviter/Sponsor + RCIC |
| LMIA / employer-driven | `Retainer Agreement …LMIA… Employer's Legal Rep.docx` | Employer's Legal Rep + RCIC |
| Paid initial consultation (pre-retainer) | `Initial Consultation- TDOT.docx` | Client + RCIC |

The **scope Annex** (`Annex No. XX`) is then chosen from the 27 Annex A docs by application type (see §4).

---

## 2. Master merge-field catalogue

Legend for **System status**: ✅ have it · ◐ computable from data we have · ⚠️ captured but not cleanly · ❌ not collected anywhere.

| # | Yellow field (as written) | Appears in | In-context meaning | Canonical field | Fill from | Format | System status |
|---|---|---|---|---|---|---|---|
| 1 | `agreement date` / `date of agreement` / `agreement_date` | All 4 | "made this {date}" + every signature Date line | `agreementDate` | Signing date (today) | date | ✅ today |
| 2 | `type of application` | PA, PA+Inviter (×2 each) | "decided to pursue a {X}" / "preparing and submitting a {X}" | `applicationType` | Confirmed case type | text | ✅ `confirmedCaseType` |
| 3 | `XX` (annex No. XX) | PA, PA+Inviter | "scope is indicated in the annex No. {XX}" | `scopeAnnexNo` | The Annex A chosen by app type (§4) + its number | ref | ❌ not assembled |
| 4 | `X` (Annex No. X) | All 3 retainers | "milestones … detailed in Annex No. {X}" | `paymentAnnexNo` | The milestone-schedule annex | ref | ❌ no milestone schedule exists |
| 5 | `payment_terms_summary_fees` | All 3 retainers | "$ {X} CAD" — professional service fees | `serviceFeesCAD` | The retainer fee | currency CAD | ✅ `retainerFee` |
| 6 | `professional taxes CAD` | All 3 retainers | "$ {X}" — HST on the fees | `hstCAD` | 13% × serviceFees (ON) | currency CAD | ◐ compute |
| 7 | `Total` | All 3 retainers | "$ {X}" — fees + HST | `totalCAD` | serviceFees + HST | currency CAD | ◐ compute |
| 8 | `xxx` (each applicant) | All 3 retainers | "$ {xxx} CAD (each applicant)" — **government** fees | `govFeePerApplicant` | Gov fee for that application type | currency CAD | ❌ no gov-fee table |
| 9 | `principal applicant` | PA, PA+Inviter, Consult | "Name: {X}" + "Signature of {Client}" | `paName` | Client full name | text | ✅ `lead.fullName` |
| 10 | `address` | PA, PA+Inviter, Consult | "Address: {X}" | `paAddress` | Client residential address | text | ⚠️ intake archive only (not a clean lead field) |
| 11 | `principal applicant phone number` | PA, PA+Inviter, Consult | "Tel: {X}" | `paPhone` | Client phone | text | ✅ `lead.phone` |
| 12 | `principal applicant's email` | PA, PA+Inviter, Consult | "E-mail: {X}" | `paEmail` | Client email | email | ✅ `lead.email` |
| 13 | `inviter` | PA+Inviter only | "Name: {X}" + "Signature of {Inviter}" | `inviterName` | Inviter/Sponsor name | text | ❌ not collected |
| 14 | `address` (inviter block) | PA+Inviter only | "Address: {X}" | `inviterAddress` | Inviter address | text | ❌ not collected |
| 15 | `phone number` (inviter block) | PA+Inviter only | "Tel: {X}" | `inviterPhone` | Inviter phone | text | ❌ not collected |
| 16 | `email` (inviter block) | PA+Inviter only | "E-mail: {X}" | `inviterEmail` | Inviter email | email | ❌ not collected |
| 17 | `Full name of Employer's Legal Representative` | LMIA only | opening party + "Signature of {X}" | `empLegalRepName` | Employer's legal rep name | text | ❌ not collected |
| 18 | `Full name of Employer Company or Legal Entity` / `Employer's Company` | LMIA only | opening party + signature company | `empCompanyName` | Employer company / legal entity | text | ❌ not collected |
| 19 | `Company's` + `address` | LMIA only | "Address: {Company's} {address}" | `empCompanyAddress` | Employer company address | text | ❌ not collected |
| 20 | `Company's` + `phone number` | LMIA only | "Tel: {Company's} {phone}" | `empCompanyPhone` | Employer company phone | text | ❌ not collected |
| 21 | `Legal Representative's` + `phone number` | LMIA only | legal rep direct line | `empLegalRepPhone` | Legal rep phone | text | ❌ not collected |
| 22 | (LMIA) `principal applicant's email` ← **artifact** | LMIA only | "E-mail: {X}" in the rep block | `empLegalRepEmail` | Legal rep email | email | ❌ not collected · **template mislabel** |
| 23 | `[$ amount paid]` | Initial Consult | "The client has paid {X}" | `consultFeePaid` | Consult fee paid (Square) | currency CAD | ✅ |
| 24 | `[duration of consultation mins]` | Initial Consult | "for {X}" | `consultDurationMins` | Consult length (minutes) | number | ⚠️ derivable from slot, not stored |
| 25 | `Date` (consultation date) | Initial Consult | "for consultation Date- {X}" | `consultDate` | Consultation date | date | ✅ `bookedSlot` / `consultationHeld` |

**Distinct data inputs needed (deduped):** ~20 — of which **~10 we already have / can compute** (incl.
`paAddress` — see correction below), and **~10 we do not collect at all** (inviter block, employer block,
government-fee table, milestone schedule, scope-annex assembly).

> **CODE-VERIFIED CORRECTION (2026-06-24):** `paAddress` is **NOT** archive-only — there is a clean lead
> column `residentialAddress` (`long_text_mm4730ph`, `newLeadsBoard.json:46`), written at intake
> (`intakeFormService.js:211`). Read it directly; no OneDrive lookup needed. (Field-#10 status below is stale.)

---

## 3. Data the system must start capturing (the gaps)

1. **Inviter / Sponsor block** (name, address, phone, email) — needed for the PA+Inviter template (sponsorship cases). Not captured anywhere today.
2. **Employer + Legal Representative block** (rep name, company name, company address/phone, rep phone, rep email) — needed for the LMIA template. Not captured.
3. **Government-fee table** — `$xxx CAD (each applicant)` per application type (IRCC fees, separate from the professional fee). No source today.
4. **Milestone payment schedule** — the templates pay "by milestones, detailed in Annex No. X," and the **first milestone is the non-refundable administrative fee**. The system currently holds a **single** retainer-fee number, not a milestone breakdown.
5. **Scope-Annex assembly** — choosing the correct Annex A by application type and giving it an annex number, then attaching it.
6. ~~Clean client address field~~ — **NOT a gap (code-verified):** `residentialAddress` lead column already
   exists and is written at intake. Read `lead.residentialAddress`.
7. **Number of applicants** — fee/gov-fee lines say "(each applicant)"; total gov fees scale with applicant
   count. **CODE-VERIFIED: at retainer time use `lead.hasSpouse` (`color_mm47zmpe`) + `lead.childrenCount`
   (`numeric_mm471h07`)** → count = 1 + (hasSpouse=='Yes'?1:0) + childrenCount. **NOT** the Family Members
   board — that is keyed by `caseReference` (`familyMembersBoard.json:5`), which is only assigned at handoff
   (`caseRefService`), so it is **empty at the lead/retainer stage**.
8. **Computed fields** — HST (13% ON) and Total are derived, not stored.

---

## 4. Scope-Annex (Annex A) selection map

The `Annex No. XX` scope reference is filled by attaching the matching Annex A document. The 27 available:

**Permanent (8):** Express Entry · Canadian Experience Class · Non-Express Entry · Federal PR · Provincial Nominee Program (PNP) · LMIA · Parents-Grandparents Sponsorship · Spousal/Common-Law Sponsorship

**Temporary (19):** Study Permit · Study Permit Extension · Post-Graduate Work Permit (PGWP) · PGWP Extension · LMIA-based Work Permit · LMIA-based WP Extension · Bridging Open Work Permit (BOWP) · Concurrent Work Permit · SCLPC Work Permit · Spousal Open Work Permit (SOWP) · SOWP Extension · Restoration of Status · Visitor Visa (outside Canada) · Temporary Resident Visa (TRV) · Visitor Record (change of status) · Parents-Grandparents Super Visa · PR Card · PR Travel Document (PRTD) · Canadian Citizenship

> **To do (later):** map each of these to the system's case-type / sub-type taxonomy so the right Annex is
> auto-selected. Most are 1:1 by name; a few (e.g. Express Entry family: EE / CEC / Non-EE) need a rule.

---

## 5. Template QA notes / artifacts to confirm with TDOT

- **Address inconsistency:** document **headers** read "20 De Boers Dr., Suite 202, Toronto ON **M3J 0H1**"; the **body/signature** reads "202-20 De Boers Drive, North York, ON **M3J 0G6**." Two different postal codes — confirm the correct one.
- **LMIA email mislabel (field #22):** the employer template's rep e-mail line is highlighted as
  *"principal applicant's email"* — almost certainly a copy-paste leftover; should be the **legal rep's** email.
- **`Non Express Entry Application- Annex A - Copy.docx`** — has " - Copy" in the filename; likely a stray duplicate to clean up.
- **`Visitor Visa (Oustide canada)`** — filename typo ("Oustide").
- **Initial Consultation** still has unfilled placeholders for amount/duration/date — confirm these are
  intended as per-engagement merge fields (they are, per the highlighting).
- The `type of application` and scope `Annex No. XX` each appear **twice** in the PA / PA+Inviter docs
  (intro recital + services clause) — both instances must receive the same value.

---

## 6. Case-type → Annex-A scope mapping

This fills the `Annex No. XX (scope)` reference. The application type is known from `confirmedCaseType`
(lead stage, one of the 33 intake services) and/or the Client Master **Primary Case Type + Sub Type** (the
canonical taxonomy, ~60 types — the single source of truth). The 27 Annex docs are indexed here as:

> **Permanent:** P1 Express Entry · P2 CEC · P3 Non-Express-Entry · P4 Federal PR · P5 PNP · P6 LMIA ·
> P7 Parents-Grandparents Sponsorship · P8 Spousal/Common-Law Sponsorship
> **Temporary:** T1 Study Permit · T2 Study Permit Ext · T3 PGWP · T4 PGWP Ext · T5 LMIA-based WP ·
> T6 LMIA-based WP Ext · T7 BOWP · T8 Concurrent WP · T9 SCLPC WP · T10 SOWP · T11 SOWP Ext ·
> T12 Restoration of Status · T13 Visitor Visa (outside Canada) · T14 TRV · T15 Visitor Record ·
> T16 Super Visa · T17 PR Card · T18 PRTD · T19 Citizenship

### 6a. Selection rules (apply before the table)
1. **PNP family → P5.** All provincial programs share the PNP scope: `AAIP`, `BCPNP`, `OINP`, `MPNP`,
   `Manitoba PNP`, `NSNP` (and the pilots `RCIP`, `RNIP`, `SNIP` — *confirm*).
2. **Sub-type picks base vs extension.** Where a case type has an "Extension" sub-type, the sub-type
   selects the Annex: `LMIA Based WP` → T5, but sub-type *Extension (Inside Canada)* → **T6**;
   `PGWP` → T3, *Extension…* sub-types → **T4**; `SOWP` → T10, *Extension (Spouse or Child)* → **T11**;
   `Visitor Record / Extension` → T15, *Visitor Record + Restoration* → **T12** (or both).
3. **CEC vs generic Express Entry.** All `Canadian Experience Class …` variants → **P2**. Generic
   Express Entry (FSW/FSTP via EE, from the intake services *Express Entry profile* / *Express Entry ITA
   and eAPR*) → **P1**.

### 6b. Client Master Primary Case Type → Annex (confidence: ✔ direct · ◑ rule/sub-type · ❔ decision)
| Primary Case Type | Annex | Conf. | Note |
|---|---|---|---|
| CEC · Canadian Experience Class (EE after ITA) · (Profile+ITA+Submission) · (Profile Recreation+ITA+Submission) | **P2** | ✔ | all CEC variants |
| Federal PR | **P3** (Non-EE) or **P4** | ◑ | **TDOT-confirmed: P3 and P4 are TWO DISTINCT scopes — keep both.** Preselect by best guess; consultant confirms which. |
| AAIP · BCPNP · OINP · MPNP · Manitoba PNP · NSNP | **P5** | ✔ | PNP family rule |
| RCIP · RNIP · SNIP | **P5** | ❔ | pilots; tbf — confirm they use PNP scope |
| Inland Spousal Sponsorship · Outland Spousal Sponsorship | **P8** | ✔ | |
| Parents/Grandparents Sponsorship | **P7** | ✔ | |
| Child Sponsorship | **P8 / P7?** | ❔ | no "Child Sponsorship" Annex — decide which (or new Annex) |
| Addition of Spouse | **P8?** | ❔ | sponsorship-adjacent — confirm |
| LMIA | **P6** | ✔ | |
| LMIA Based WP | **T5** (base) / **T6** (Extension sub-type) | ◑ | |
| SCLPC WP | **T9** | ✔ | |
| Concurrent WP | **T8** | ✔ | |
| BOWP | **T7** | ✔ | |
| PGWP | **T3** (base) / **T4** (Extension sub-types) | ◑ | |
| SOWP | **T10** (base) / **T11** (Extension sub-type) | ◑ | |
| LMIA Exempt WP · Francophone Mobility WP · Co-op WP · NB WP Extension · Refugee WP | **— no exact Annex** | ❔ | closest is a WP Annex; **new Annex(es) likely needed** |
| Study Permit | **T1** | ✔ | |
| Study Permit Extension | **T2** | ✔ | |
| TRV | **T14** | ✔ | |
| Visitor Visa | **T13** | ◑ | "Visitor Visa (outside Canada)"; if applicant inside Canada, reconsider vs T15 |
| Visitor Record / Extension | **T15** (base) / **T12** (Restoration sub-type) | ◑ | |
| Supervisa | **T16** | ✔ | |
| Citizenship | **T19** | ✔ | |
| PR Card Renewal | **T17** | ✔ | |
| PRTD | **T18** | ✔ | |
| ETA · USA Visa | **— none** | ❔ | minor/out-of-scope; likely no standard retainer+Annex |

### 6c. Intake services (lead-stage `confirmedCaseType`) → Annex
| Intake service | Annex |
|---|---|
| Express Entry profile · Express Entry ITA and eAPR | **P1** |
| PNP or OINP | **P5** |
| Spousal sponsorship | **P8** |
| Family sponsorship | **P7 / P8** (relationship-dependent — confirm) |
| PR application review | **P3 / P4** (depends on stream) |
| Caregiver pathway · Humanitarian and compassionate | **— no Annex** (new Annex or consult-only) |
| Study permit | **T1** |
| Work permit | **❔** — ambiguous; needs sub-type (LMIA-based T5 / SCLPC T9 / Concurrent T8 / LMIA-exempt …) |
| PGWP | **T3** |
| BOWP | **T7** |
| Visitor visa or TRV | **T13 / T14** |
| Visitor record | **T15** |
| Super Visa | **T16** |
| Status extension | **❔** — which status? (study T2 / WP T4/T6 / visitor T15) |
| Status restoration | **T12** |
| PR card renewal | **T17** |
| PR travel document | **T18** |
| Citizenship | **T19** |
| Residency obligation review | **— none** |
| LMIA | **P6** |
| LMIA exempt work permit · Employer portal submission · Job offer support · Employer compliance support | **— no exact Annex** |
| Refusal review · ATIP or GCMS notes · Webform · Passport request or VFS support · Document review · Case strategy consultation · Other · Name update or document correction | **— none** (not a representation retainer; consult/admin only) |

---

## 7. Coverage gaps — case types with NO matching Annex

The 27 Annexes do **not** cover the full ~60-type canon. These either need a **new Annex** or do not get a
standard application retainer (admin/consult/appeal work). **Confirm with TDOT how each is papered:**

- **Work-permit variants without an Annex:** LMIA Exempt WP, Francophone Mobility WP, Co-op WP, NB WP
  Extension, Refugee WP.
- **Sponsorship variants:** Child Sponsorship, Addition of Spouse.
- **Pathways/PR:** Caregiver pathway, Humanitarian & Compassionate (H&C), Refugee, PRAA, Reconsideration
  (per the contracts a refusal/reconsideration is a *new* retainer), Renunciation of PR, OCI/Passport Surrender.
- **Admin / quasi-legal / consult-only:** Amendment of Document, Appeal, Employer Portal, ICAS/WES/IQAS
  (ECA), Invitation Letter, Notary, PFL (Procedural Fairness Letter), Request Letter, TRP, Miscellaneous,
  ETA, USA Visa, Residency obligation review.

---

## 8. Open decisions to confirm with TDOT (resolve before building)
1. **Federal PR vs Non-Express-Entry Annex (P4 vs P3)** — are these two distinct scopes, or is one the
   general and one a variant? Which does the `Federal PR` case type use?
2. **Generic "Work permit" / "Status extension"** at intake are too coarse to pick an Annex — the retainer
   needs the **specific WP type / status** (this is the `Case Sub Type`, set at handoff). Confirm the
   retainer is generated **after** the precise type is known.
3. **Which signatory template** for sponsorship cases — sponsorship = the **PA + Inviter** master template
   (sponsor = inviter)? And LMIA/employer = the **Employer** template, even though the Annex is P6.
4. **Child Sponsorship / Addition of Spouse / Caregiver / H&C** — new Annexes, or reuse existing?
5. **The work-permit gaps** (LMIA-Exempt, Francophone Mobility, Co-op, NB Extension, Refugee WP) — new
   Annexes or map to the nearest existing one?
6. **Pilots** (RCIP / RNIP / SNIP) — confirm they use the PNP (P5) scope.

---

## 9. Retainer selection model (system proposes → consultant confirms)

> Design decision: the **consultant is the final authority** on which paperwork is generated. It is a legal
> document and the RCIC is professionally accountable for the engagement scope, so the system *assists* but
> does not *decide*. This also de-risks the §6 mapping — the rules only need to be **good**, not flawless,
> because the human catches the edge cases.

At the moment the consultant records **Retain** in the Consultant Portal, they confirm/override three things:

1. **Master template** (PA · PA+Inviter · Employer) — pre-selected from signals we already hold:
   inviter/sponsor present → PA+Inviter; LMIA/employer service → Employer; otherwise PA.
2. **Scope Annex** (the 27, grouped Permanent/Temporary) — pre-selected via the §6 rules + case type/sub type.
3. **Milestone schedule** (see §10).

Each pre-selection shows **its basis** ("Suggested: CEC Annex — because case type = Canadian Experience
Class") and a **confidence flag**: high-confidence (the ✔ direct hits) = one-click confirm; ❔ ambiguous
(coarse "Work permit"/"Status extension", no-Annex gaps, Federal-PR-vs-Non-EE) = visibly flagged
"please verify." The consultant can change any selection from the full list.

**Why (not just convenience):** §6 carries genuine ambiguity and ~10 coverage gaps; a fully-automatic
selector would confidently err *exactly* in those cases — on a contract that states the fee. Human-confirmed
selection is the correct control, produces an audit trail, and keeps the consultant in the portal (no Monday
frontend), consistent with the cockpit.

**Optional AI layer — top, not foundation.** Deterministic rules are the backbone. An AI assist can later
(a) suggest the precise **sub-type** for coarse cases by reading the situation description / consultation
notes, and (b) **flag inconsistencies** (e.g. "PA-only template chosen, but this looks like a sponsorship").
AI *suggests with a confidence score*; it never makes the final selection on a legal document. This is
consistent with the existing Claude lead-triage layer and can be added after the rules-based version ships.

**Stored on the case (new fields):** `selectedTemplate`, `selectedScopeAnnex` (+ the milestone data, §10) —
written from the portal, consumed by retainer generation.

---

## 10. Milestone schedule — capture & variable-count storage

Milestones vary per case (**2–4+**), each a small record: **label · amount (or %) · trigger/description**.
The **first milestone is the non-refundable administrative fee**, and the milestone amounts should **sum to
the professional service fee** (`payment_terms_summary_fees`).

**Capture (portal):** a **repeatable-row editor** — the same "add another row" pattern already built for
education/employment in the pre-consult form. **Pre-fill 4 milestone rows by default** (TDOT-confirmed
default; count/amounts vary by case type and per case, so the consultant adds/removes/edits). **Row 1 is the
non-refundable administrative fee** (locked label). Show a **live total + validation** that the rows sum to
the professional service fee.

**Storing a variable-length list when Monday columns are fixed — two clean options:**

| Option | How | Best when |
|---|---|---|
| **A. JSON in one long-text column** *(recommended)* | Whole milestone array stored as JSON in a single `Retainer Milestones` long-text column on the lead/case; portal serializes/deserializes and renders it readably. | Milestones are **set once for the agreement**. Any count, zero schema change, data stays on Monday — same approach as AI talking points / priority reasons / the pre-consult eligibility JSON. |
| **B. Separate "Milestones" board** | One Monday item per milestone, `board_relation` to the case (same pattern as the Family Members board). | Milestones must be **native, reportable, or payment-tracked** over time (per-milestone status: due / paid). Heavier; re-introduces the lead→case timing bridge (no caseRef at lead stage). |

> **Anti-pattern (do not use):** fixed "milestone 1..N" columns — caps the count, wastes columns, and can't
> hold the per-milestone sub-fields cleanly.

**Recommendation:** start with **Option A**. It caters for the variable count, keeps the data with the lead,
and the portal supplies the editor + readable view. **Move to Option B only if** you later want to *track each
milestone being paid* — that's a payment-tracking feature, not contract capture.

**Decision to make:** milestones **set-once (for the PDF)** → Option A · or **tracked/paid over the case** →
Option B. That single answer picks the storage.

---

## 11. Government-fee reference (pre-fill defaults)

> **Source:** official IRCC fee list — <https://ircc.canada.ca/english/information/fees/fees.asp> (page last
> modified **2026-04-30**; PR fees increased 2026-04-30, citizenship 2026-03-31). All amounts **CAD**.
>
> **Use:** these pre-fill the retainer's `$xxx CAD (each applicant)` government-fee line. They are a
> **default the consultant can override per case** (per TDOT). **Fees change — re-verify periodically; the
> consultant is the final check.** **Government fees are separate from the professional fee** and are charged
> per applicant unless noted. **LMIA is an ESDC fee, not an IRCC fee** (see note).

| Annex / application | Government fee (per applicant unless noted) |
|---|---|
| **P1 Express Entry / Skilled Worker** · **P2 CEC** · **P3 Non-EE** · **P4 Federal PR** | Principal: **$1,590** (incl. RPRF) or **$990** + **RPRF $600** later · Spouse: **$1,590** / $990 · Dependent child: **$270** each |
| **P5 PNP** | Same as economic above — PNP processing $990 + **RPRF $600** = **$1,590** PA · Spouse $1,590 · Child $270 |
| **P6 LMIA** | **ESDC, not IRCC: $1,000 per position** (employer-paid). No IRCC processing fee for the LMIA itself. |
| **P7 Parents/Grandparents Sponsorship** | Sponsored parent/GP: **$1,260** (sponsorship+processing+RPRF) or **$660** without RPRF · Spouse of sponsored: $1,260 · Child: **$180** |
| **P8 Spousal / Common-Law Sponsorship** | Sponsored spouse/partner: **$1,260** (incl. RPRF) or **$660** without RPRF · Dependent child: **$180** |
| **T1 Study Permit** · **T2 Study Permit Ext** | **$150** per person |
| **T3 PGWP** · **T4 PGWP Ext** · **T7 BOWP** · **T10 SOWP** · **T11 SOWP Ext** (open WPs) | Work permit **$155** + open-work-permit-holder **$100** = **$255** per person |
| **T5 LMIA-based WP** · **T6 LMIA-based WP Ext** · **T8 Concurrent WP** · **T9 SCLPC WP** (employer-specific) | Work permit **$155** per person *(+ $100 open-WP-holder fee only if it is an open permit)* |
| **T12 Restoration of Status** | Worker **$401.25** ($246.25 restore + $155 permit) · Student **$396.25** ($246.25 + $150) · Visitor **$246.25** |
| **T13 Visitor Visa (outside Canada)** · **T14 TRV** · **T16 Super Visa** | **$100** per person · family max **$500** |
| **T15 Visitor Record / extension (in Canada)** | Extend stay as visitor **$100** per person |
| **T17 PR Card** | **$50** |
| **T18 PRTD** | **$50** |
| **T19 Citizenship** | Adult (18+) grant **$653** (incl. right-of-citizenship $123) · Minor **$100** |
| **Biometrics** (most TR + PR) | **$85** per person · **$170** family max (2+) |
| **eTA** | **$7** |

**Notes / build rules:**
- **Per-applicant scaling:** total government fee = sum across applicants (PA + spouse + each child). We know
  the applicant count from the Family Members data, so the system can compute the default total, then the
  consultant adjusts.
- **RPRF timing:** the Right of Permanent Residence Fee ($600) is sometimes deferred until just before
  approval — offer the "with RPRF" vs "without RPRF (pay later)" default.
- **LMIA exception:** the LMIA government fee is the **ESDC $1,000/position** (employer-paid), structurally
  different from IRCC fees — flag separately in the LMIA/Employer flow.
- This table is a **starting default only**; store it as editable config so TDOT/the consultant can update
  amounts when IRCC changes them (which they just did, 2026-04-30).

---

## 12. One-line summary

A real auto-generated retainer = **pick the master template by signatory type → attach the Annex A by
application type → merge ~20 per-case values** (client/inviter/employer identity, application type, the
fee + HST + total, the milestone schedule, and government fees). We currently have ~9 of those inputs; the
rest (inviter, employer, gov-fee table, milestone schedule, scope-annex assembly, clean address,
applicant count) are not collected yet.
