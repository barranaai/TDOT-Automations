# Teams meeting transcripts — setup (Option B: Microsoft Graph)

The automation fetches each Teams consultation's **transcript** via Microsoft Graph,
stores it in the client's OneDrive folder, and writes an org-share link to the
**Consultation Transcript** column on the lead (plus a "📝 transcript is ready" note).

Code: `src/services/teamsTranscriptService.js`, scheduled every 30 min in `scheduler.js`.
It is **inert until the steps below are done** — every call fails closed (logged, no crash).

---

## Why this needs extra setup (unlike the recording)

The recording is just a file in someone's OneDrive, so we read it with the
`Files.ReadWrite.All` permission we already have. The **transcript** is only
reachable through the Teams online-meeting API, which requires app-only access to
be explicitly authorized per organizer mailbox (an *application access policy*).

This works **only because our Teams meetings are calendar events** — the Graph
transcripts API rejects meetings made with the raw create-onlineMeeting API.
`meetingService.createTeamsMeeting` already creates calendar events, so we're good.

---

## 1. Azure app — add + consent two Application permissions

On the **same** Azure app registration used for mail/OneDrive (`MS_CLIENT_ID`):

Azure Portal → App registrations → *(the app)* → **API permissions** → Add a
permission → Microsoft Graph → **Application permissions**:

- `OnlineMeetings.Read.All`  — resolve the meeting by its join URL
- `OnlineMeetingTranscript.Read.All`  — read + download the transcript

Then click **“Grant admin consent for <tenant>”**. Both must show *Granted*.

(No new client secret or env var — the existing `MS_TENANT_ID` / `MS_CLIENT_ID` /
`MS_CLIENT_SECRET` token picks these up automatically via the `.default` scope.)

## 2. Teams — application access policy for the organizer mailbox

App-only calls to a user's online meetings must be authorized for that user. The
organizer is `MEETING_ORGANIZER_EMAIL` (the mailbox that creates the meetings).

> **Turnkey:** run `scripts/setup-teams-transcript-policy.ps1` as a Teams admin —
> it installs the module, connects, creates + grants the policy, and verifies. It
> prompts for the two values (AppId = `MS_CLIENT_ID`, Organizer =
> `MEETING_ORGANIZER_EMAIL`). The manual equivalent is below.

In PowerShell (Teams admin):

```powershell
Install-Module MicrosoftTeams   # first time only
Connect-MicrosoftTeams

# create a policy naming our app (use the Azure Application (client) ID = MS_CLIENT_ID)
New-CsApplicationAccessPolicy -Identity "TDOT-Transcripts" `
  -AppIds "<MS_CLIENT_ID>" -Description "TDOT automation — read consultation transcripts"

# grant it to the organizer mailbox (the account in MEETING_ORGANIZER_EMAIL)
Grant-CsApplicationAccessPolicy -PolicyName "TDOT-Transcripts" -Identity "<MEETING_ORGANIZER_EMAIL>"
```

> Propagation can take **up to ~30 minutes** (sometimes longer). Don't be alarmed
> if the first attempts after granting it return 403.

## 3. Tenant — allow Graph access to transcripts

A tenant admin can globally block Graph transcript access. If the logs show
`403 … GraphAccessToTranscriptsDisabled`, that block is on — a Teams admin must
re-enable Graph API access to meeting transcripts for the tenant.

## 4. Make sure meetings are actually transcribed

Graph can only return a transcript that **exists**. Teams does **not** transcribe
by default — someone must either:

- turn on **Record and transcribe** (or just **Start transcription**) during the
  call, **or**
- set a Teams **meeting policy** so recording/transcription starts automatically
  (recommended, so consultants can't forget): Teams admin center → Meetings →
  Meeting policies → *Recording & transcription*.

---

## How it behaves once configured

- Runs every 30 min; for each **booked Teams lead** whose slot has passed (and up
  to **72h** after — transcripts can lag), it resolves the meeting, grabs the
  **latest** transcript as WebVTT, saves `consultation-transcript.vtt` to the
  client's OneDrive folder, writes the **Consultation Transcript** link column, and
  posts a note. Idempotent — skips any lead that already has a transcript link.
- No transcript yet? It just tries again next run until the 72h window closes.

## Verifying

**First, without a real meeting** — once the policy has propagated (~30 min):
```
POST https://tdot-automations.onrender.com/api/transcript-preflight
  header:  X-Api-Key: <ADMIN_API_KEY>
```
`ok:true` → the permission + policy are active. `403` in the response → not
consented / policy not granted / not yet propagated (the `hint` field says which).

**Then, end to end:**

1. Book a Teams consultation, run it, and **turn on transcription** in the call.
2. End the meeting; within ~30–60 min the lead should get the Consultation
   Transcript link + the "📝 transcript is ready" note.
3. If nothing appears, check the Render logs for `[Transcript]` lines:
   - `403 …/GraphAccessToTranscriptsDisabled` → step 3
   - `403 …` (other) → permission/policy not granted or not propagated (steps 1–2)
   - `no onlineMeeting matched the join URL` → the stored join URL didn't match
     (rare; tell the dev — we can store the meeting id at creation instead)
