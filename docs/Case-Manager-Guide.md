# TDOT Immigration — Case Manager Guide
### Automation System Walkthrough

> **Audience:** Case managers and officers already familiar with Monday.com.  
> **Purpose:** Step-by-step guide to using the automated case management system end-to-end.  
> **Format:** Read alongside a live screen-share session.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Creating a New Case](#2-creating-a-new-case)
3. [What Happens Automatically (and When)](#3-what-happens-automatically-and-when)
4. [Monitoring Case Readiness](#4-monitoring-case-readiness)
5. [Reviewing Documents](#5-reviewing-documents)
6. [Reviewing the Questionnaire](#6-reviewing-the-questionnaire)
7. [Moving a Case Through Stages](#7-moving-a-case-through-stages)
8. [SLA, Health & Escalation](#8-sla-health--escalation)
9. [Notifications You Will Receive](#9-notifications-you-will-receive)
10. [Special Situations & Manual Controls](#10-special-situations--manual-controls)
11. [Quick Reference Card](#11-quick-reference-card)

---

## 1. System Overview

The system has **three layers**:

| Layer | Where | What it is |
|---|---|---|
| **Case Management Hub** | Monday.com — Client Master Board | The single source of truth for every case. All readiness scores, stages, and flags live here. |
| **Execution Boards** | Monday.com — Document & Questionnaire Boards | One row per document/question per case. Updated as clients submit. |
| **Client Portal** | Web browser (hosted) | Two secure pages the client accesses via emailed links — one for documents, one for the questionnaire. |

**Your job as a case manager is primarily on the Client Master Board.** The execution boards and client portal are updated automatically. You review them, flag issues, and move the case forward when ready.

---

## 2. Creating a New Case

### Step 1 — Create the item on the Client Master Board

Create a new item on the **Client Master Board** in Monday.com. The item title **must be the client's full name** — this is what all automation, emails, and OneDrive folders use.

> ✅ Example: `John Smith`  
> ❌ Not: `Smith case` or `New client April`

### Step 2 — Fill in the required columns

These columns **must be filled in before the retainer is marked as Paid**:

| Column | What to enter | Why it matters |
|---|---|---|
| **Item title** | Client's full legal name | Used as folder name in OneDrive and in all emails |
| **Client Email** | Client's email address | All automated emails go here |
| **Primary Case Type** | Select from dropdown | Triggers Case Reference Number generation automatically |
| **Case Sub-Type** | Select if applicable | Determines which questionnaire form is sent |
| **Case Manager** | Assign yourself / the lead officer | Used for notifications and escalation routing |
| **Ops Supervisor** | Assign the supervising officer | Copied on escalation and expiry alerts |
| **Passport Expiry / IELTS Expiry / Medical Expiry** | Fill in if known | SLA engine monitors these and alerts before they expire |

### Step 3 — Mark Retainer as Paid

Once the client has paid, set the **Retainer Status** column to **"Paid"**.

This is the **master trigger** that sets up the entire case:

- ✅ Payment date is recorded
- ✅ Case Stage advances to **Document Collection Started**
- ✅ All document checklist items are created on the Execution Board
- ✅ The questionnaire is set up (or an HTML form link is generated)
- ✅ The intake email is sent to the client with their personal document upload link and questionnaire link
- ✅ Automation lock is cleared — all engines begin monitoring this case

> **Note:** If the Case Reference Number column is empty after setting Case Type, wait 10–15 seconds and refresh. It is generated automatically.

---

## 3. What Happens Automatically (and When)

This section explains what the system does without anyone touching it. Understanding this helps you know what to expect and when to step in.

### On Item Creation
- An **access token** is generated and stored silently. This is the security key embedded in the client's document and questionnaire links.

### When Case Type is Set
- The **Case Reference Number** is generated automatically (e.g., `2026-VV-013`).

### When Retainer → Paid
- Case Stage set to **Document Collection Started**
- Document checklist rows created on the Execution Board
- Questionnaire set up
- Intake email sent to client

### When Client Email is Corrected
- If the email column is updated while the case is active (Document Collection Started through Submission Preparation), the **intake email is automatically re-sent** to the new address. No action needed.

### Daily (runs every morning)
| Engine | What it does |
|---|---|
| **Readiness Scan** | Counts documents and questionnaire answers. Updates Q Readiness %, Doc Readiness %, Blocking Doc Count on the Client Master Board. |
| **Stage Gates** | If readiness meets the threshold (typically 80%) with zero blocking items, the case automatically advances from *Document Collection Started → Internal Review*, or from *Internal Review → Submission Preparation*. |
| **Chasing Loop** | If a client hasn't responded in X days (set per case type in the SLA Config), reminder emails are sent automatically. Escalates through: *Reminder 1 → Reminder 2 → Final Notice → Client Blocked*. |
| **SLA Engine** | Calculates days elapsed, expected deadlines, and SLA risk band (Green / Amber / Red). Updates SLA columns on the board. |
| **Case Health Engine** | Scores overall case health based on multiple signals (SLA, client responsiveness, blocking items). Sets Case Health Status. |
| **Expiry Engine** | Checks passport, IELTS, and medical expiry dates. Flags and emails the case manager if any are approaching. |
| **Escalation Routing** | Applies escalation rules (configured in the SLA Config board) to high-risk cases. Can re-assign, lock stages, or send final notices automatically. |

---

## 4. Monitoring Case Readiness

### The readiness columns to watch

On the **Client Master Board**, these columns tell you where the case stands:

| Column | What it shows |
|---|---|
| **Q Readiness %** | Percentage of questionnaire fields completed by the client |
| **Q Completion Status** | *Working on it* (in progress) / *Done* (submitted) |
| **Doc Readiness %** | Percentage of required documents received and reviewed |
| **Doc Threshold Met** | *Yes* when doc readiness ≥ threshold — green light for stage advance |
| **Ready for Review** | *Done* when both Q and Doc readiness meet threshold with no blocking items |
| **Blocking Doc Count** | Number of required documents that are still Missing |
| **Missing Required** | Number of required items (docs + questions) outstanding |

### The readiness threshold

The minimum readiness percentage needed to advance a case is **80% by default**. Some case types have different thresholds configured in the SLA Config board. The case will not advance to Internal Review until:
- Q Readiness ≥ threshold, **AND**
- Doc Readiness ≥ threshold, **AND**
- Blocking Doc Count = 0

> **Blocking documents** are items marked as "must be received before the case can proceed". Even at 99%, if one blocking document is missing the case will not advance automatically.

---

## 5. Reviewing Documents

### Where to review

Open the **Document Checklist Execution Board** in Monday.com. Filter by the client's case reference number or find the group for their case type.

Each row represents one document item. The key columns are:

| Column | Meaning |
|---|---|
| **Document Status** | Missing / Received / Reviewed / Rework Required |
| **Last Upload Date** | When the client last uploaded a file for this item |
| **Review Notes** | Your notes to the client (shown on their upload page when status is *Rework Required*) |
| **Required Type** | Required / Optional / Conditional |
| **Blocking Document** | Yes / No — whether missing this document blocks the stage gate |

### Your review workflow

1. Open the Execution Board and find the client's document rows
2. For each document with status **Received**:
   - Open the file attachment to review it
   - If acceptable → change status to **Reviewed**
   - If it needs to be redone → change status to **Rework Required** and enter instructions in the **Review Notes** column
3. The client will automatically receive a **revision notification email** within 2 minutes of you marking items as *Rework Required*. The email lists every item flagged in that batch with your review notes.
4. The **Doc Readiness %** on the Client Master Board updates the following morning (daily scan), or immediately after the client's next upload.

> **Tip:** You do not need to chase the client manually. The chasing loop sends reminder emails automatically based on inactivity days. See Section 8.

---

## 6. Reviewing the Questionnaire

For cases using the new HTML questionnaire forms, clients fill in their answers on a web page. You review those answers through the **staff review page**.

### Accessing the review page

The URL format is:

```
https://tdot-automations.onrender.com/q/{CASE-REFERENCE}/review
```

You can also add it as a button or link in the Monday.com item. The first time you open it, you'll be asked to log in with your Monday.com account.

> Only email addresses from authorised domains can access the review page.

### What the review page shows

- The **full questionnaire form** with the client's answers pre-filled
- All sections expanded so everything is visible at once
- **Flag buttons** next to every question

### Flagging items for correction

1. Click the **⚑ Flag** button next to any question that needs attention
2. Type your comment / instruction in the note box that appears
3. Click **Save Flag**
4. Flagged items are highlighted in amber

Flags are saved instantly to the case's OneDrive folder.

### Sending the correction request

Once you've flagged all the items that need attention:
1. Click **"Send Correction Request"** in the toolbar at the top
2. Confirm the prompt
3. The client receives an email listing every flagged question with your notes and a link to re-open their form

When the client re-submits, the flags remain visible to you until you manually remove them.

### Exporting the questionnaire as PDF

Click **"⬇ Export PDF"** in the toolbar. A new tab opens with a clean, printable report showing:
- Case details summary
- All questions and answers grouped by section
- Flagged items highlighted in amber with your officer notes
- Completion statistics

Use your browser's **File → Print → Save as PDF** or the green "Save as PDF / Print" button on the page.

---

## 7. Moving a Case Through Stages

The **Case Stage** column on the Client Master Board controls where a case is in its lifecycle. Most transitions happen automatically, but some require a manual decision from you.

### Stage lifecycle

```
[Intake]
    ↓ (Retainer marked Paid — automatic)
[Document Collection Started]
    ↓ (Readiness ≥ threshold + no blocking items — automatic, next morning)
[Internal Review]
    ↓ (100% readiness + no blocking items — automatic, next morning)
[Submission Preparation]
    ↓ (You decide the case is ready for submission — MANUAL)
[Submission Ready]
    ↓ (After submission — MANUAL)
[Submitted]
    ↓ (Outcome received — MANUAL)
[Approved] / [Refused] / [Closed] / [Withdrawn] / [Cancelled] / [Archived]
```

### Manual stage changes you are responsible for

| Stage | When you set it | What happens |
|---|---|---|
| **Submission Ready** | When you've reviewed everything and the case is ready for the application to be filed | Locks the case — no more automatic stage advances |
| **Submitted** | After the application has been submitted to immigration authorities | Locks all automation — chasing, SLA, health, escalation all stop |
| **Approved / Refused / Closed / Withdrawn / Cancelled / Archived** | When the case outcome is known or the case ends | Locks all automation |

> **Important:** Setting any terminal stage (Submitted, Approved, Refused, Closed, Withdrawn, Cancelled, Archived) automatically:  
> - Sets **Automation Lock = Yes** — all daily engines skip this case  
> - Sets **Chasing Stage = Resolved** — stops all client reminder emails  
> - Clears **Escalation Required**  
> - Posts an audit comment on the item

### Stage Start Date

This column is reset automatically every time the case advances to a new stage. It is used by the SLA engine to calculate how long the case has been in the current stage.

---

## 8. SLA, Health & Escalation

### SLA columns (updated daily)

| Column | What it means |
|---|---|
| **Days Elapsed** | Days since the current Stage Start Date |
| **SLA Total Days** | Total expected days for this case type (from SLA Config) |
| **Stage Expected Duration** | How long this specific stage should take |
| **SLA Risk Band** | Green / Amber / Red — overall time risk |
| **Hard Deadline / Soft Deadline** | Calculated target dates |

### Case Health Status

Separate from SLA. Reflects the overall health of the case based on multiple signals: SLA risk, client responsiveness, inactivity, and blocking items. Can be:
- **Green** — on track
- **Amber** — requires attention
- **Red** — critical, case manager notified immediately

When **Case Health → Red**, you receive a Monday.com notification automatically.

### Chasing Stage (client follow-up)

The chasing loop sends emails automatically. You can monitor where it is:

| Chasing Stage value | Meaning |
|---|---|
| *(blank)* or **Pending** | Not started — client hasn't been chased yet |
| **Reminder 1 Sent** | First reminder sent |
| **Reminder 2 Sent** | Second reminder sent |
| **Final Notice Sent** | Final warning sent |
| **Client Blocked** | Client has not responded after all reminders — escalation triggered |
| **Resolved** | Client has responded / case has moved forward — chasing stopped |

### Escalation Required column

When this is set to **Yes** (either automatically or by you):
- The ops supervisor is notified
- An escalation reason is recorded

When set back to **No**, the escalation reason is cleared automatically.

### Manual Override column

Set this to **Yes** if a client has a valid reason for delay and you want to **pause the chasing loop** for that case. This stops reminder emails without locking the whole case. The SLA and health engines still run.

> Use this for situations like: client is travelling, client is waiting on third-party documents, client has spoken to you directly.

---

## 9. Notifications You Will Receive

All notifications are sent via Monday.com's notification system (bell icon, top right).

| Trigger | Who is notified |
|---|---|
| You are assigned as Case Manager | You |
| You are assigned as Ops Supervisor | You |
| A document is marked **Received** on the Execution Board | Case Manager |
| A document is marked **Rework Required** | Case Manager |
| A questionnaire response is **Answered** | Case Manager |
| Case Health → **Red** | Case Manager |
| Expiry date approaching (passport, IELTS, medical) | Case Manager + Ops Supervisor |
| **Escalation Required → Yes** | Ops Supervisor + Case Manager |
| Client is **Blocked** (chasing exhausted) | Ops Supervisor |

---

## 10. Special Situations & Manual Controls

### Client gives you a corrected email address
Update the **Client Email** column. The intake email is automatically re-sent to the new address. No other action needed.

### Client hasn't received their links
Use the manual resend endpoint (ask your system admin) or check that the **Client Email** column is correct and the **Access Token** column is not empty. If the token is missing, the links will show "Access Denied" for the client.

### Case should not advance automatically
Set **Automation Lock = Yes**. This stops all daily engines from processing the case. Remember to set it back to No when you want automation to resume.

### Client says their form is empty when they open it
The client may need to use the same link from the original intake email (it contains their security token). Sharing the plain URL without the `?t=...` token will show Access Denied.

### You need to re-send the questionnaire / documents link
The links are always:  
- **Documents:** `https://tdot-automations.onrender.com/documents/{CASE-REF}`  
- **Questionnaire:** `https://tdot-automations.onrender.com/q/{CASE-REF}?t={ACCESS-TOKEN}`

The access token is visible in the **Access Token** column on the Client Master Board. Copy it and append to the questionnaire URL as `?t=` before sending.

### Case type has no questionnaire form yet
Some case types are marked "TO BE FINALIZED". Clients will see a placeholder page instead of a form. The document upload page still works normally.

---

## 11. Quick Reference Card

> Print or bookmark this section for quick lookups.

### Key Monday.com boards

| Board | Purpose |
|---|---|
| **Client Master Board** | All cases — your main workspace |
| **Document Checklist Execution Board** | Review uploaded documents per case |
| **Questionnaire Execution Board** | Legacy Q items (older cases only) |
| **SLA Config Board** | Thresholds, chasing intervals, escalation rules (admin use) |

### Stage gate conditions

| From | To | Condition |
|---|---|---|
| Document Collection Started | Internal Review | Q% ≥ threshold AND Doc% ≥ threshold AND Blocking Docs = 0 |
| Internal Review | Submission Preparation | Q% = 100% AND Doc% = 100% AND Blocking Docs = 0 |
| Submission Preparation | Submission Ready | **Manual** — set by case manager |
| Submission Ready | Submitted | **Manual** — set after filing |

### Document statuses

| Status | Colour | Meaning |
|---|---|---|
| **Missing** | 🔴 Red | Not yet uploaded by client |
| **Received** | 🔵 Blue | Uploaded, awaiting your review |
| **Reviewed** | 🟢 Green | You have approved this document |
| **Rework Required** | 🟠 Orange | You have requested re-upload; client is notified |

### Questionnaire review page URL

```
https://tdot-automations.onrender.com/q/{CASE-REFERENCE}/review
```

### When to use Manual Override vs Automation Lock

| Control | Stops | Use when |
|---|---|---|
| **Manual Override = Yes** | Chasing emails only | Client has a valid reason for delay — don't want to chase them but case is still active |
| **Automation Lock = Yes** | Everything (SLA, health, chasing, escalation) | Case is on hold, disputed, or needs manual handling only |

---

*Last updated: April 2026 — TDOT Immigration Internal Use Only*
