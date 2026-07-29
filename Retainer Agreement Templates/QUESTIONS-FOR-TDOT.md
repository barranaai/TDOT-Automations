# Retainer Automation — Questions for TDOT

Before we automate retainer generation, please confirm the following. Answers here let us build it
correctly the first time (selecting the right template + scope annex and merging the right data).

## A. Which template & who signs
1. Confirm the master template per case: **PA-only** for a standard single applicant, **PA + Inviter** for
   sponsorship (the sponsor signs as the "Inviter"?), **Employer / Legal Rep** for LMIA. Correct?
2. For sponsorship cases, is the "Inviter" always the **sponsor**? Do any dependants/co-applicants also sign?
3. Are there employer-driven cases **other than LMIA** (e.g. LMIA-exempt) that should use the Employer
   template rather than the PA template?

## B. Scope annexes (the per-application "Annex A")
4. **"Federal PR" vs "Non-Express-Entry" annex** — are these two different scopes, or the same scope under
   two names? Which one applies to a Federal PR engagement?
5. These case types currently have **no annex** — should we create a new annex, reuse an existing one, or do
   they not get a standard application retainer? **LMIA-Exempt WP, Francophone-Mobility WP, Co-op WP,
   NB WP Extension, Refugee WP, Child Sponsorship, Addition of Spouse, Caregiver pathway, H&C.**
6. Do the provincial pilots **RCIP / RNIP / SNIP** use the **PNP** annex scope?
7. Confirm the **base-vs-extension** rule: when a case is an extension (e.g. LMIA-WP Extension, PGWP
   Extension, SOWP Extension, Visitor Record + Restoration), we use the matching **Extension** annex. Correct?
8. Which case types should **not** generate a retainer at all (consultation/administrative only — e.g.
   Appeal, PFL, ECA/WES, Notary, TRP, Reconsideration, Document review, Invitation/Request letter)?

## C. Fees, taxes & milestones
9. The agreement is paid **"by milestones (Annex No. X)"**, with the **first milestone = non-refundable
   administrative fee.** What is the standard milestone structure — **how many milestones, what amount/%
   each, and what triggers each payment?** Is it the same across all case types, or does it vary?
10. Is the professional tax always **HST 13% (Ontario)**? Any exceptions?
11. The **"$xxx CAD (each applicant)" government-fee** line — do you have a standard table of IRCC
    government fees **per application type and per applicant** we should use? Who keeps it current?
12. Confirm **biometrics = $85 / applicant (14+)**, and that it applies to all the listed application types.

## D. Party data we don't capture yet
13. **PA + Inviter template** needs the inviter/sponsor's **name, address, phone, email** — where do you
    capture these today, or should we add them to intake / case data?
14. **LMIA / Employer template** needs the employer's **legal-rep name, company name, company
    address/phone, and rep email** — same question: where captured?
15. The fee/government lines say **"each applicant"** — should the total scale by the number of applicants
    (we know family size from the case)? Confirm.

## E. Corrections to the source templates (so they're clean before we automate)
16. The **firm address** differs between the header ("Suite 202, Toronto, M3J 0H1") and the body
    ("202-20 De Boers Drive, North York, M3J 0G6") — which is correct?
17. In the **LMIA template**, the employer legal-rep's e-mail field is labelled "principal applicant's
    email" — should this be the **rep's** email? Please confirm so we merge the right value.
18. `Non Express Entry … - Copy.docx` looks like a **duplicate**, and `Visitor Visa (Oustide canada)` has a
    **typo** — are these safe to clean up, and which is the canonical version?
19. The **Initial Consultation** agreement leaves "amount paid", "duration", and "date" blank — confirm
    these are per-consultation fill-ins (we can populate amount & date automatically from the booking).
