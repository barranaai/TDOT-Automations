/**
 * Microsoft Mail Service
 *
 * Sends emails via Microsoft Graph API using the same Azure app registration
 * used for OneDrive access. Requires Mail.Send application permission
 * granted in Azure Portal.
 *
 * Environment variables required:
 *   MS_TENANT_ID      — Azure Directory (tenant) ID
 *   MS_CLIENT_ID      — Azure Application (client) ID
 *   MS_CLIENT_SECRET  — Azure client secret value
 *   MS_FROM_EMAIL     — The M365 mailbox to send from (e.g. noreply@tdotimmigration.ca)
 *
 * Token caching: tokens are cached in memory and refreshed automatically
 * 5 minutes before expiry (Graph tokens last 1 hour).
 */

const axios = require('axios');

// ─── Token cache ──────────────────────────────────────────────────────────────

let _cachedToken  = null;
let _tokenExpiry  = 0;   // Unix timestamp ms

async function getAccessToken() {
  const now = Date.now();

  // Return cached token if still valid with 5-minute buffer
  if (_cachedToken && now < _tokenExpiry - 300_000) {
    return _cachedToken;
  }

  const tenantId     = process.env.MS_TENANT_ID;
  const clientId     = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Microsoft Mail: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET must all be set in .env'
    );
  }

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         'https://graph.microsoft.com/.default',
  });

  const response = await axios.post(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  _cachedToken = response.data.access_token;
  _tokenExpiry = now + (response.data.expires_in * 1000);   // expires_in is seconds

  return _cachedToken;
}

// ─── Send email ───────────────────────────────────────────────────────────────

/**
 * Send an email via Microsoft Graph.
 *
 * @param {object} options
 * @param {string|string[]} options.to        — recipient email(s)
 * @param {string}          options.subject
 * @param {string}          options.html      — HTML body
 * @param {string}          [options.replyTo] — optional reply-to address
 */
async function sendEmail({ to, subject, html, replyTo }) {
  const fromEmail = process.env.MS_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('Microsoft Mail: MS_FROM_EMAIL must be set in .env');
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  if (!recipients.length) {
    throw new Error('Microsoft Mail: no recipients provided');
  }

  const message = {
    subject,
    body:         { contentType: 'HTML', content: html },
    toRecipients: recipients,
  };

  if (replyTo) {
    message.replyTo = [{ emailAddress: { address: replyTo } }];
  }

  const token = await getAccessToken();

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    { message, saveToSentItems: true },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

module.exports = { sendEmail, getAccessToken };
