Microsoft OneDrive — Developer Access Setup Guide

Prepared by: TDOT Immigration Automation Team
Purpose: Grant secure API access to OneDrive for document automation
Estimated time to complete: 15–20 minutes


Overview

To enable the TDOT automation system to upload and organise client documents directly into your OneDrive, we need you to create a secure app registration in your Microsoft Azure account.

This process creates a dedicated application identity — similar to creating a user account for a software system. It allows our server to connect to your OneDrive without ever needing your personal password.

Your IT administrator or Microsoft 365 Global Admin must complete this setup.


Before You Begin

Make sure you have:

- Admin access to your Microsoft 365 account
- The ability to sign in to portal.azure.com
- A secure way to share credentials with us (WhatsApp, 1Password share link, or similar — not plain email)


Step 1 — Sign In to Azure Portal

Open your browser and go to https://portal.azure.com and sign in using your Microsoft 365 administrator account.

If you are unsure which account to use, it is typically the account used to manage your Microsoft 365 subscription, for example admin@yourcompany.com.


Step 2 — Open App Registrations

In the search bar at the top of the Azure Portal, type "App registrations" and click it from the results. Then click the "New registration" button at the top left of the page.


Step 3 — Register the Application

Fill in the registration form as follows:

    Name: TDOT Automations
    Supported account types: Accounts in this organizational directory only
    Redirect URI: Leave blank

Click "Register" to create the application.


Step 4 — Copy the Application IDs

After registering, you will be taken to the application overview page. Locate and copy the following two values — you will need to send these to us:

    Application (client) ID — shown on the overview page, format: a1b2c3d4-e5f6-...
    Directory (tenant) ID — shown just below the Client ID, same format

These IDs are not secret and are safe to share via email.


Step 5 — Create a Client Secret

This is the password that allows our system to authenticate as the app.

1. In the left-hand menu, click "Certificates & secrets"
2. Click "New client secret"
3. Set the Description to: TDOT Automations Secret
4. Set Expires to: 24 months
5. Click "Add"
6. A new row will appear — copy the Value shown in that row immediately

Important: This value will be hidden as soon as you leave the page and cannot be recovered. If lost, you would need to create a new secret. Please share this value with us securely via WhatsApp or a password manager share link — not plain email.


Step 6 — Add API Permissions

This step grants the app the specific permissions it needs to access OneDrive.

1. In the left-hand menu, click "API permissions"
2. Click "Add a permission"
3. On the panel that opens, click "Microsoft Graph"
4. Select "Application permissions" — this is the second option, not Delegated
5. Search for and check each of the following four permissions:

    Files.ReadWrite.All — to upload and manage documents in OneDrive
    Sites.ReadWrite.All — to access SharePoint and OneDrive document libraries
    User.Read.All — to identify which OneDrive folder belongs to which user
    Mail.Send — to send automated emails (intake, reminders, expiry alerts) from your Microsoft 365 mailbox

6. Click "Add permissions" to save


Step 7 — Grant Admin Consent

This step activates the permissions you just added. Without it, the app will not be able to connect.

1. On the API permissions page, click the button labelled "Grant admin consent for [Your Organisation Name]"
2. A confirmation dialog will appear — click "Yes"
3. Each permission should now show a green checkmark and the status "Granted for [Your Org]"

If you do not see this button, you may not have Global Administrator rights. Please ask your IT administrator to complete this step.


Step 8 — Confirm OneDrive Location

Before sharing credentials with us, please also confirm the following:

Should documents be stored in a personal OneDrive (a specific user's drive)? If yes, provide the email address of that user.

Or should they go into a SharePoint Team Site or shared document library? If yes, provide the site name or URL.

What folder structure would you prefer? A suggested option is: Client Documents / Case Reference / Document Type.


What to Send to TDOT

Once the above steps are complete, please securely share the following five items:

    Tenant ID
    Client ID
    Client Secret
    OneDrive user email or SharePoint site URL
    The email address that should be used as the sender for all automated emails (e.g. noreply@yourcompany.com or admin@yourcompany.com).

    Important: This mailbox must already exist in your Microsoft 365 account before we can use it. You have two options:

    Option A — Use an existing mailbox such as admin@yourcompany.com or info@yourcompany.com. No extra setup is needed. Just confirm the address.

    Option B — Create a dedicated sender address such as noreply@yourcompany.com. This requires your Microsoft 365 admin to create it as a Shared Mailbox first. A shared mailbox does not require a paid licence. To create one, go to Microsoft 365 Admin Centre, then Users, then Shared Mailboxes, and add a new one with the address you want.


Security Notes

The Client Secret will be stored in an encrypted environment variable on our secure server — never in any code file or spreadsheet.

The app will only have access to OneDrive file storage and the ability to send outgoing emails on behalf of the designated mailbox. It cannot read your emails, access your calendar, Teams messages, or any other Microsoft 365 service.

You can revoke access at any time by deleting the app registration or the client secret in Azure Portal.

We recommend reviewing and rotating the client secret annually as a good security practice.


If you encounter any issues during this setup, please contact your TDOT account manager or share a screenshot of the step where you are stuck.


Document version 1.0 — March 2026
