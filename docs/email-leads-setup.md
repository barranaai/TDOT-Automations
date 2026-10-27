# Email → lead: setup

The app reads the office inbox (**info@tdotimm.com**) every 5 minutes:

- a **new person** → a new lead on the Lead Board (Source "Email"), with the email saved on it;
- **someone already in the system** → no new lead; the email is added as a note on their open case (or their lead);
- **junk and automatic emails** (our own staff, no-reply senders, newsletters, auto-replies, bounces, Square / Documenso / Monday / Microsoft notices, government and payment notices) → skipped.

It only **reads**. It never moves, marks or deletes anything in Outlook. It starts with the emails that arrive after it can first read the inbox, so the old emails are never imported.

It needs **one permission** from your Microsoft 365 admin before it can read the inbox. Until then it does nothing, and the status page says so.

---

## Option A: the quick way (about 5 minutes, in the browser)

1. Go to **https://entra.microsoft.com** and sign in as a Microsoft 365 admin.
2. Open **Applications → App registrations → All applications**, and open the app the TDOT system already uses. It's the one that sends the app's emails, and its *Application (client) ID* is the `MS_CLIENT_ID` value on Render.
3. Open **API permissions → Add a permission → Microsoft Graph → Application permissions**, search for **Mail.Read**, tick it, and click **Add permissions**.
4. Click **Grant admin consent for …** and confirm. The status turns green.

Note: this permission lets the app read **any** mailbox in your organisation. The app's code only ever reads info@tdotimm.com. If you want Microsoft itself to enforce that, use Option B instead.

## Option B: only info@tdotimm.com (for an IT person, PowerShell)

This uses Exchange Online "RBAC for Applications". **Skip Option A** for this: an Entra Mail.Read permission would still allow every mailbox.

```powershell
Connect-ExchangeOnline
# once per app: the IDs come from Entra → Enterprise applications → the TDOT app
New-ServicePrincipal -AppId <Application (client) ID> -ObjectId <Enterprise application Object ID> -DisplayName "TDOT app"
New-ManagementScope -Name "TDOT email leads" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'info@tdotimm.com'"
New-ManagementRoleAssignment -App <Application (client) ID> -Role "Application Mail.Read" -CustomResourceScope "TDOT email leads"
```

**Do not** use the older `New-ApplicationAccessPolicy` to limit the app. That policy limits *all* of the app's mail and calendar permissions, so it would stop the app sending its emails (from noreply@tdotimm.com) and creating Teams meetings. The only exception is if its group also contains those mailboxes.

---

## Check it

Microsoft can take **up to an hour** before a new permission works. Then, signed in as an admin:

- **https://app.tdotimm.com/admin/email-leads/check**: says "Access OK" or what is still missing. It also confirms that the Junk folder is recognised and that emails moved out of Junk can be found.
- **https://app.tdotimm.com/admin/email-leads/status**: the last run and the most recent emails (new lead / note / skipped, and why).

The first run that can read the inbox starts the record **from that moment**. The next email that arrives becomes a lead or a note within 5 minutes.

## Switches (Render environment)

| Setting | Default | What it does |
|---|---|---|
| `EMAIL_LEADS` | on | `off` stops it. Switched back on, it catches up on the emails that came in meanwhile |
| `EMAIL_LEADS_MAILBOX` | `info@tdotimm.com` | the inbox to read (changing it starts a fresh record from now) |
| `EMAIL_LEADS_SKIP_DOMAINS` | — | extra sender domains to skip, comma-separated (e.g. `vendor.com,agency.ca`) |
| `EMAIL_LEADS_SKIP_ADDRESSES` | — | extra single addresses to skip (our own addresses outside tdotimm.com) |
| `EMAIL_LEADS_FORM_SENDERS` | — | the address our **website contact form** sends from (for example wordpress@tdotimm.com or a form service's no-reply address). The visitor's address in Reply-To then becomes the lead. Without it, form emails sent "from" us or from a no-reply address are skipped |

## When something goes wrong

- **Monday is down:** each email waits and is tried again every 5 minutes, in order. If one email keeps failing, after 5 tries it is set aside so the others go through, and it keeps being retried on its own. It is given up only after a full day, and then it is listed on the status page.
- **An email lands in Junk:** it is skipped. If someone moves it to the Inbox, it is picked up within 5 minutes.
- **The same email twice** (moved to a folder, or a second copy): it is taken once.
