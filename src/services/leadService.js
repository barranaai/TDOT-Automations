/**
 * Lead Service
 *
 * Handles /lead/new form submission, Lead Board CRUD, and AI qualification.
 * Writes ONLY to the Lead Board (never to Client Master — that's handoffService).
 *
 *   createLead(formData)  → creates a Lead Board item + assigns a lead token
 *   qualifyLead(id, data) → Claude API assigns Tier, score, talking points, flags
 *   getLead(id)           → reads a lead back from the Lead Board
 *   updateLead(id, fields)→ writes camelCase fields to the right columns
 */

'use strict';

const mondayApi        = require('./mondayApi');
const leadTokenService = require('./leadTokenService');
const { leadBoardId }  = require('../../config/monday');
const boardCfg         = require('../data/newLeadsBoard.json');

const COLS = boardCfg.columns; // camelCase key → Monday column ID

// Per-column write format. (Status = { label }, Dropdown = { labels: [] }, etc.)
const COL_TYPE = {
  fullName: 'text', email: 'email', phone: 'phone', country: 'text',
  preferredContact: 'dropdown', sourceChannel: 'dropdown', caseTypeInterest: 'dropdown', confirmedCaseType: 'dropdown',
  utmSource: 'text', utmMedium: 'text', utmCampaign: 'text',
  situationDescription: 'long_text', howHeard: 'text',
  tier: 'status', aiScore: 'numbers', aiTalkingPoints: 'long_text', aiComplianceFlags: 'long_text',
  bookingStatus: 'status', preConsultSubmitted: 'status', outcome: 'status', conversionStatus: 'status',
  slotHeldUntil: 'text', bookedSlot: 'text', consultationHeld: 'date',
  retainerSent: 'date', retainerSigned: 'date', retainerPaid: 'date', retainerFee: 'numbers',
  squareConsultTxnId: 'text', squareConsultOrderId: 'text', zoomMeetingId: 'text',
  adobeSignAgreementId: 'text', squareRetainerTxnId: 'text', squareRetainerOrderId: 'text',
  clientMasterItemId: 'text', leadToken: 'text',
  oneDriveFolderId: 'text', oneDriveFolderLink: 'link',
  // V2 intake form (TDOT brief sections A–G)
  relationshipWithTdot: 'status', serviceRequired: 'dropdown', whatDoYouWant: 'dropdown',
  insideCanada: 'status', residentialAddress: 'long_text', currentStatus: 'dropdown',
  statusExpiry: 'date', deadlineDate: 'date', deadlineReason: 'dropdown',
  removalOrder: 'status', enforcementLetter: 'status',
  restorationPeriod: 'status', restorationDeadline: 'date',
  recentRefusal: 'status', refusalType: 'dropdown', refusalDate: 'date',
  crsScore: 'numbers', itaDeadline: 'date',
  referredBy: 'text', existingFileType: 'text', consentsAt: 'text',
  // V2 priority engine (rules own tier/priority; AI is second opinion)
  priority: 'status', priorityReasons: 'long_text', aiTierOpinion: 'text', aiDisagrees: 'status',
  bookingInvite: 'status', // "Send" (staff trigger / auto) → system emails the booking link → "Sent"
};

const ID_TO_KEY = Object.fromEntries(Object.entries(COLS).map(([k, id]) => [id, k]));

function formatValue(type, value) {
  switch (type) {
    case 'email':     return { email: String(value), text: String(value) };
    case 'phone':     return { phone: String(value).replace(/\D/g, ''), countryShortName: 'CA' };
    case 'dropdown':  return { labels: Array.isArray(value) ? value : [String(value)] };
    case 'status':    return { label: String(value) };
    case 'long_text': return { text: String(value) };
    case 'date':      return (value && typeof value === 'object') ? value : { date: String(value) };
    case 'link':      return (value && typeof value === 'object') ? { url: String(value.url), text: String(value.text || value.url) } : { url: String(value), text: String(value) };
    case 'numbers':   return String(value);
    default:          return String(value); // text
  }
}

/** Build a column_values object from a {camelCaseKey: value} map. */
function buildCols(fields) {
  const cols = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    const colId = COLS[key];
    if (!colId) continue; // unknown field — skip safely
    cols[colId] = formatValue(COL_TYPE[key] || 'text', value);
  }
  return cols;
}

/**
 * Create a new Lead Board item from the public form payload, then assign a
 * lead access token. Returns { id, ...formData }.
 */
async function createLead(formData) {
  const name = (formData.fullName || '').trim() || 'Unnamed Lead';
  console.log(`[Lead] Creating lead for ${formData.email || '(no email)'}`);

  // Phone is set in a follow-up update so a bad phone format can't block creation.
  const createFields = {
    fullName:             formData.fullName,
    email:                formData.email,
    country:              formData.country,
    preferredContact:     formData.preferredContact,
    caseTypeInterest:     formData.caseTypeInterest,
    situationDescription: formData.situationDescription,
    howHeard:             formData.howHeard,
    sourceChannel:        formData.sourceChannel || 'Website',
    conversionStatus:     'New',
  };

  const result = await mondayApi.query(
    `mutation($boardId: ID!, $name: String!, $cols: JSON!) {
       create_item(board_id: $boardId, item_name: $name, column_values: $cols) { id }
     }`,
    { boardId: String(leadBoardId), name, cols: JSON.stringify(buildCols(createFields)) }
  );

  const id = result?.create_item?.id;
  if (!id) throw new Error('Lead create_item returned no ID');

  // Best-effort phone write (non-fatal).
  if (formData.phone) {
    try {
      await updateLead(id, { phone: formData.phone });
    } catch (err) {
      console.warn(`[Lead] Phone write failed for ${id}: ${err.message}`);
    }
  }

  // Assign a lead token so booking/consult links work later.
  try {
    await leadTokenService.ensureToken(id);
  } catch (err) {
    console.warn(`[Lead] Token assignment failed for ${id}: ${err.message}`);
  }

  // Create the client's OneDrive folder now (named "{Name} - LEAD-{id}") so
  // intake uploads have a home; it gets renamed to "{Name} - {CaseRef}" when
  // the case reference is generated. Fire-and-forget: an OneDrive outage must
  // never block lead creation.
  try {
    const oneDrive = require('./oneDriveService');
    oneDrive.ensureLeadFolder({ fullName: name, leadId: id })
      .then((folder) => updateLead(id, {
        oneDriveFolderId:   folder.id,
        oneDriveFolderLink: { url: folder.url, text: 'Open client folder' },
      }))
      .then(() => console.log(`[Lead] OneDrive folder linked for lead ${id}`))
      .catch((err) => console.warn(`[Lead] OneDrive folder creation failed for ${id} (non-fatal): ${err.message}`));
  } catch (err) {
    console.warn(`[Lead] OneDrive service unavailable (non-fatal): ${err.message}`);
  }

  console.log(`[Lead] Created lead ${id} (${name})`);
  return { id, ...formData };
}

/**
 * Update a lead with a {camelCaseKey: value} map of fields.
 * create_labels_if_missing lets status/dropdown labels auto-create on first
 * use — REQUIRED for the V2 intake columns (created empty). All public-form
 * values are whitelist-validated in intakeFormService before reaching here,
 * so the public cannot mint junk labels.
 */
async function updateLead(leadId, fields) {
  const cols = buildCols(fields);
  if (!Object.keys(cols).length) return;
  await mondayApi.query(
    `mutation($boardId: ID!, $itemId: ID!, $cols: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $cols, create_labels_if_missing: true) { id }
     }`,
    { boardId: String(leadBoardId), itemId: String(leadId), cols: JSON.stringify(cols) }
  );
}

/**
 * Find a lead by the value of one of its columns (e.g. a Square order id).
 * @param {string} key  camelCase column key (must exist in COLS)
 * @returns {Promise<object|null>} the lead (camelCase), or null
 */
async function findByColumnValue(key, value) {
  const colId = COLS[key];
  if (!colId || !value) return null;
  const data = await mondayApi.query(
    `query($boardId: ID!, $colId: String!, $val: String!) {
       items_page_by_column_values(limit: 1, board_id: $boardId, columns: [{ column_id: $colId, column_values: [$val] }]) {
         items { id }
       }
     }`,
    { boardId: String(leadBoardId), colId, val: String(value) }
  );
  const id = data?.items_page_by_column_values?.items?.[0]?.id;
  return id ? getLead(id) : null;
}

/** Read a lead back from the Lead Board as a camelCase object. */
async function getLead(leadId) {
  const data = await mondayApi.query(
    `query($itemId: ID!) {
       items(ids: [$itemId]) { id name column_values { id text value } }
     }`,
    { itemId: String(leadId) }
  );
  const item = data?.items?.[0];
  if (!item) return null;

  const lead = { id: item.id, name: item.name, fullName: item.name };
  for (const cv of item.column_values) {
    const key = ID_TO_KEY[cv.id];
    if (!key) continue;
    if (COL_TYPE[key] === 'link') {
      // Link columns: .text is "display text - url" mashed together — read the
      // bare URL from the JSON value instead.
      let url = '';
      try { url = JSON.parse(cv.value || '{}').url || ''; } catch (_) { /* leave empty */ }
      lead[key] = url;
    } else {
      lead[key] = cv.text || '';
    }
  }
  // Column may be empty on staff-created rows — fall back to the item name,
  // but never to the "Unnamed Lead" placeholder (handoff should fail loudly
  // for those rather than create a junk-named case + folder).
  if (!lead.fullName && item.name !== 'Unnamed Lead') lead.fullName = item.name;
  return lead;
}

// ─── AI qualification ─────────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  const Ctor = Anthropic.default || Anthropic;
  _anthropic = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const QUALIFY_SYSTEM_PROMPT = `You are an immigration lead qualifier for TDOT Immigration (a Toronto-based RCIC firm).
Given a prospective client's situation, assign:
1. Tier — one of: T0 (emergency, same-day), T1 (urgent, 24-48h), T2 (standard new client), T3 (referral, lower-priority), T4 (quick consultation only), Newsletter (ineligible but interested), Decline (not a fit)
2. AI Eligibility Score — an integer 0-100 for likelihood of becoming a paying client
3. Talking Points — 3-5 short bullet points the consultant should cover
4. Compliance Flags — any RCIC ethical concerns (e.g. unrealistic expectations, unauthorized representation); empty array if none

Return ONLY valid JSON, no markdown, in exactly this shape:
{ "tier": "T2", "score": 75, "talkingPoints": ["..."], "complianceFlags": ["..."] }`;

function parseJsonLoose(text) {
  const cleaned = String(text).replace(/```json\s*|\s*```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

/**
 * Qualify a lead with Claude → write Tier, score, talking points, flags, and
 * set Conversion Status = Qualified. Fire-and-forget from the route.
 * @param {string} leadId
 * @param {object} [data] optional in-memory lead data (avoids a board re-read race)
 */
async function qualifyLead(leadId, data) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[Lead] ANTHROPIC_API_KEY not set — skipping qualification');
    return null;
  }
  const lead = data || (await getLead(leadId)) || {};

  const opt = (label, v) => (String(v || '').trim() ? `\n${label}: ${v}` : '');
  const userPrompt = `Lead details:
Name: ${lead.fullName || ''}
Country: ${lead.country || ''}
Case Type Interest: ${lead.caseTypeInterest || ''}
Situation: ${lead.situationDescription || 'Not provided'}
Source: ${lead.sourceChannel || 'Website'}`
    + opt('Specific service requested', lead.serviceRequired)
    + opt('Inside Canada', lead.insideCanada)
    + opt('Current status', lead.currentStatus)
    + opt('Status expiry', lead.statusExpiry)
    + opt('Urgent deadline', lead.deadlineDate ? `${lead.deadlineDate} (${lead.deadlineReason || 'reason not given'})` : '')
    + opt('Removal/enforcement order', lead.removalOrder)
    + opt('CBSA/IRCC letter received', lead.enforcementLetter)
    + opt('In restoration period', lead.restorationPeriod)
    + opt('Recent refusal', lead.recentRefusal === 'Yes' ? `${lead.refusalType || ''} ${lead.refusalDate || ''}`.trim() : '')
    + opt('CRS score', lead.crsScore);

  const response = await getAnthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1000,
    system: QUALIFY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content?.[0]?.text || '';
  const result = parseJsonLoose(text);

  // The AI is a SECOND OPINION: the deterministic rules engine
  // (leadPriorityService) owns the Tier/Priority columns. The AI writes its
  // own view to "AI Tier Opinion" and we flag when it is MORE alarmed than
  // the rules (or thinks the lead is no fit at all) so staff take a look.
  const update = {
    aiTierOpinion:     result.tier,
    aiScore:           result.score,
    aiTalkingPoints:   Array.isArray(result.talkingPoints) ? result.talkingPoints.join('\n') : (result.talkingPoints || ''),
    aiComplianceFlags: Array.isArray(result.complianceFlags) ? result.complianceFlags.join('\n') : (result.complianceFlags || ''),
    conversionStatus:  'Qualified',
  };
  let disagrees = false;
  const rulesPriority = lead.rulesPriority || lead.priority || '';
  if (rulesPriority) {
    const { aiDisagreement } = require('./leadPriorityService');
    disagrees = aiDisagreement(rulesPriority, result.tier);
    update.aiDisagrees = disagrees ? 'Yes' : 'No';
  }
  // Legacy fallback: if no rules priority exists (lead created outside the V2
  // intake flow), the AI tier remains the only signal — keep writing it.
  if (!rulesPriority) update.tier = result.tier;

  await updateLead(leadId, update);

  if (disagrees) {
    try {
      await mondayApi.query(
        `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
        { itemId: String(leadId),
          body: `🤖 AI second opinion DISAGREES with the rules engine: rules say "${rulesPriority}", AI suggests "${result.tier}". ` +
                `The AI may have picked something up from the free-text situation — please review before actioning.` }
      );
    } catch (_) { /* note is best-effort */ }
  }

  console.log(`[Lead] AI opinion for ${leadId}: ${result.tier} (score ${result.score})${rulesPriority ? ` · rules=${rulesPriority} · disagrees=${disagrees}` : ' · legacy tier write'}`);
  return result;
}

module.exports = { createLead, qualifyLead, getLead, updateLead, findByColumnValue };
