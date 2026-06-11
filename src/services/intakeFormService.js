/**
 * Intake Form Service (V2 — built to TDOT's "Client Intake Form and Lead
 * Triage Brief for IT Team", sections A–G).
 *
 *   buildIntakeFormHtml()        → the public form (conditional sections, uploads)
 *   processIntakeSubmission()    → validate → create lead → upload letters +
 *                                  full JSON archive to the client's intake
 *                                  OneDrive folder → staff digest on the lead
 *
 * Storage model (hybrid):
 *   - Fields staff/the priority rules need  → Lead Board columns (COL_TYPE in
 *     leadService — relationship, service, status, deadlines, enforcement,
 *     refusal, CRS, consents, …)
 *   - The COMPLETE raw submission           → intake-submission.json in
 *     "Client Documents/{name} - LEAD-{id}/Intake/" (+ uploaded letters)
 *   - A readable digest                     → Monday update on the lead item
 *
 * Existing clients (section B) are captured and tagged but NOT funneled into
 * booking — they get a "we'll route you to your case team" thank-you. Full
 * internal routing is the next build step.
 */

'use strict';

const leadService = require('./leadService');
const { BRAND, TDOT_LOGO_LIGHT_HTML } = require('../branding');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── Section C: service dropdown (verbatim from the brief) ───────────────────
const SERVICE_GROUPS = {
  'Permanent Residence': [
    'Express Entry profile', 'Express Entry ITA and eAPR', 'PNP or OINP', 'Spousal sponsorship',
    'Family sponsorship', 'Caregiver pathway', 'Humanitarian and compassionate', 'PR application review',
  ],
  'Temporary Residence': [
    'Study permit', 'Work permit', 'PGWP', 'BOWP', 'Visitor visa or TRV', 'Visitor record',
    'Super Visa', 'Status extension', 'Status restoration',
  ],
  'After PR Services': [
    'PR card renewal', 'PR travel document', 'Citizenship', 'Residency obligation review',
    'Name update or document correction',
  ],
  'Employer Services': [
    'LMIA', 'LMIA exempt work permit', 'Employer portal submission', 'Job offer support',
    'Employer compliance support',
  ],
  'Other Support': [
    'Refusal review', 'ATIP or GCMS notes', 'Webform', 'Passport request or VFS support',
    'Document review', 'Case strategy consultation', 'Other',
  ],
};
const ALL_SERVICES = Object.values(SERVICE_GROUPS).flat();

/** Map the specific service to the broad interest the existing funnel logic understands. */
function serviceToInterest(service) {
  const s = String(service || '');
  if (s === 'Study permit') return 'Study Permit';
  if (['Visitor visa or TRV', 'Visitor record', 'Super Visa'].includes(s)) return 'Visitor Visa';
  if (s === 'Citizenship') return 'Citizenship';
  if (['Work permit', 'PGWP', 'BOWP', 'Status extension', 'Status restoration',
       'LMIA', 'LMIA exempt work permit', 'Employer portal submission', 'Job offer support',
       'Employer compliance support'].includes(s)) return 'Work Permit';
  if (['Spousal sponsorship', 'Family sponsorship'].includes(s)) return 'Spousal Sponsorship';
  if (['Express Entry profile', 'Express Entry ITA and eAPR', 'PNP or OINP', 'Caregiver pathway',
       'Humanitarian and compassionate', 'PR application review', 'PR card renewal',
       'PR travel document', 'Residency obligation review'].includes(s)) return 'Permanent Residence';
  return 'Other';
}

/** Which F-block (service-specific questions) a service shows. */
function serviceToFBlock(service) {
  const s = String(service || '');
  if (['Express Entry profile', 'Express Entry ITA and eAPR'].includes(s)) return 'F1';
  if (s === 'PNP or OINP') return 'F2';
  if (['Work permit', 'PGWP', 'BOWP', 'Status extension', 'Status restoration'].includes(s)) return 'F3';
  if (s === 'Study permit') return 'F4';
  if (['Visitor visa or TRV', 'Visitor record', 'Super Visa'].includes(s)) return 'F5';
  if (['Spousal sponsorship', 'Family sponsorship'].includes(s)) return 'F6';
  if (['PR card renewal', 'PR travel document', 'Citizenship', 'Residency obligation review',
       'Name update or document correction'].includes(s)) return 'F7';
  if (['LMIA', 'LMIA exempt work permit', 'Employer portal submission', 'Job offer support',
       'Employer compliance support'].includes(s)) return 'F8';
  if (s === 'Refusal review') return 'F9';
  if (['ATIP or GCMS notes', 'Webform', 'Passport request or VFS support'].includes(s)) return 'F10';
  return null;
}

// ─── Server-side validation ───────────────────────────────────────────────────

const DEADLINE_REASONS = ['ITA deadline', 'Passport request deadline', 'Restoration deadline', 'Status expiry',
  'CBSA or removal matter', 'Hearing or appointment', 'PNP deadline', 'Employer deadline', 'School deadline', 'Other'];
const REFUSAL_TYPES = ['Visitor visa', 'Study permit', 'Work permit', 'Spousal sponsorship', 'PR application',
  'Express Entry', 'PNP', 'Refugee or H and C', 'Other'];
const HOW_HEARD = ['Instagram', 'TikTok', 'Google', 'Website', 'WhatsApp', 'Referral', 'Existing client', 'Walk in', 'Event', 'Other'];
const RELATIONSHIPS = ['New inquiry', 'Existing client with active application', 'Previous client with completed or inactive application'];
const INTENTS  = ['Book consultation', 'Start new application', 'Request quote', 'Existing file update', 'General information'];
const STATUSES = ['Visitor', 'Student', 'Worker', 'Permanent resident', 'Citizen', 'No valid status', 'Outside Canada', 'Other'];
const YN  = ['Yes', 'No'];
const YNS = ['Yes', 'No', 'Not sure'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate the public submission. Every enum is whitelist-checked and every
 * date format-checked: these values flow into Monday status/dropdown columns
 * with create_labels_if_missing, so anything not on a whitelist must be
 * rejected here or the public could mint junk board labels (and a single bad
 * value fails the whole 21-column write).
 */
function validateIntake(f) {
  const errors = [];
  const req  = (key, label) => { if (!String(f[key] || '').trim()) errors.push(`${label} is required.`); };
  const inEnum = (key, list, label, required) => {
    const v = String(f[key] || '').trim();
    if (!v) { if (required) errors.push(`${label} is required.`); return; }
    if (!list.includes(v)) errors.push(`${label}: invalid selection.`);
  };
  const isDate = (key, label, required) => {
    const v = String(f[key] || '').trim();
    if (!v) { if (required) errors.push(`${label} is required.`); return; }
    if (!DATE_RE.test(v)) errors.push(`${label}: please use the date picker (YYYY-MM-DD).`);
  };

  req('fullName', 'Full legal name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(f.email || ''))) errors.push('A valid email address is required.');
  req('phone', 'Contact number');
  req('residentialAddress', 'Residential address');
  inEnum('insideCanada', YN, 'Are you currently inside Canada', true);
  if (f.insideCanada === 'No') req('currentCountry', 'Current country (you said you are outside Canada)');
  inEnum('relationshipWithTdot', RELATIONSHIPS, 'Relationship with TDOT', true);
  inEnum('serviceRequired', ALL_SERVICES, 'Service required', true);
  req('situationDescription', 'A brief explanation of your inquiry');
  inEnum('whatDoYouWant', INTENTS, 'What you would like to do', true);
  inEnum('currentStatus', STATUSES, 'Current immigration status', true);
  isDate('statusExpiry', 'Status expiry date', ['Visitor', 'Student', 'Worker'].includes(f.currentStatus));
  if (f.insideCanada === 'Yes') inEnum('maintainedStatus', YN, 'Maintained or implied status question', true);
  inEnum('urgentDeadline', YN, 'Urgent deadline question', true);
  isDate('deadlineDate', 'Deadline date', f.urgentDeadline === 'Yes');
  inEnum('deadlineReason', DEADLINE_REASONS, 'Deadline reason', f.urgentDeadline === 'Yes');
  inEnum('removalOrder', YNS, 'Removal/enforcement question', true);
  inEnum('enforcementLetter', YNS, 'CBSA/IRCC letter question', true);
  if (f.insideCanada === 'Yes') inEnum('restorationPeriod', YN, 'Restoration period question', true);
  isDate('restorationDeadline', 'Restoration deadline', false);
  inEnum('recentRefusal', YN, 'Recent refusal question', true);
  inEnum('refusalType', REFUSAL_TYPES, 'What was refused', f.recentRefusal === 'Yes');
  isDate('refusalDate', 'Refusal date', f.recentRefusal === 'Yes');
  inEnum('howHeard', HOW_HEARD, 'How you heard about TDOT', true);
  for (const k of ['f1_itaDeadline', 'f2_deadline', 'f4_deadline', 'f7_prDate', 'f9_deadline', 'f9_refusalDate', 'f10_deadline']) {
    isDate(k, 'Date field', false);
  }
  inEnum('f9_refusalType', REFUSAL_TYPES, 'Refused application type', false);
  if (String(f.f1_crsScore || '').trim()) {
    const n = Number(f.f1_crsScore);
    if (!Number.isInteger(n) || n < 0 || n > 1200) errors.push('CRS score must be a whole number between 0 and 1200.');
  }
  for (const [k, label] of [['consentContact', 'Consent to contact'], ['consentAccuracy', 'Accuracy confirmation'],
    ['consentDisclaimer', 'Disclaimer acknowledgment'], ['consentStorage', 'Permission to store information']]) {
    if (f[k] !== 'on' && f[k] !== 'true' && f[k] !== '1') errors.push(`${label} checkbox must be accepted.`);
  }
  return errors;
}

// ─── Submission processing ────────────────────────────────────────────────────

/**
 * @param {object} f      multipart text fields (req.body)
 * @param {object} files  multer files map: { enforcementLetter?: [..], refusalLetter?: [..] }
 * @returns {Promise<{ ok: boolean, html: string, leadId?: string }>}
 */
async function processIntakeSubmission(f, files = {}) {
  const errors = validateIntake(f);
  if (errors.length) return { ok: false, html: buildErrorsHtml(errors) };

  const isExistingClient = f.relationshipWithTdot === 'Existing client with active application';
  const interest = serviceToInterest(f.serviceRequired);
  const country = f.insideCanada === 'Yes' ? 'Canada' : String(f.currentCountry || '').trim();
  // ONE canonical name string: createLead trims before naming the OneDrive
  // folder, so uploads must use the identical trimmed value or a stray space
  // would silently split the client's files into a second folder.
  const fullName = String(f.fullName || '').trim();
  // Only the ACTIVE service's F-block answers count — hidden blocks keep
  // stale values in the browser, which must not become triage data.
  const activeBlock = serviceToFBlock(f.serviceRequired);
  const inVSW = ['Visitor', 'Student', 'Worker'].includes(f.currentStatus);

  // 1. Create the lead with the fields the existing funnel already understands.
  const lead = await leadService.createLead({
    fullName, email: f.email, phone: f.phone, country,
    caseTypeInterest: interest,
    situationDescription: f.situationDescription,
    howHeard: f.howHeard,
    sourceChannel: 'Website',
  });
  const leadId = lead.id;

  // 2. Write the V2 columns (best-effort — a column hiccup must not lose the lead).
  const v2Fields = {
    relationshipWithTdot: f.relationshipWithTdot,
    serviceRequired:      f.serviceRequired,
    whatDoYouWant:        f.whatDoYouWant,
    insideCanada:         f.insideCanada,
    residentialAddress:   f.residentialAddress,
    currentStatus:        f.currentStatus,
    statusExpiry:         inVSW ? f.statusExpiry : '',
    removalOrder:         f.removalOrder,
    enforcementLetter:    f.enforcementLetter,
    recentRefusal:        f.recentRefusal,
    // E-section refusal answers win; a Refusal-review client reviewing an OLD
    // refusal (E9=No) still gets their F9 answers onto the triage columns.
    refusalType:          f.recentRefusal === 'Yes' ? f.refusalType : (activeBlock === 'F9' ? f.f9_refusalType || '' : ''),
    refusalDate:          f.recentRefusal === 'Yes' ? f.refusalDate : (activeBlock === 'F9' ? f.f9_refusalDate || '' : ''),
    restorationPeriod:    f.insideCanada === 'Yes' ? f.restorationPeriod : '',
    restorationDeadline:  (f.insideCanada === 'Yes' && f.restorationPeriod === 'Yes') ? f.restorationDeadline : '',
    referredBy:           f.howHeard === 'Referral' ? f.referredBy : '',
    existingFileType:     f.relationshipWithTdot === 'New inquiry' ? '' : f.existingFileType,
    consentsAt:           new Date().toISOString(),
    crsScore:             activeBlock === 'F1' ? f.f1_crsScore : '',
    itaDeadline:          activeBlock === 'F1' ? f.f1_itaDeadline : '',
  };
  // Urgency deadline: E2/E3 win; else borrow the ACTIVE block's service deadline.
  if (f.urgentDeadline === 'Yes' && f.deadlineDate) {
    v2Fields.deadlineDate = f.deadlineDate;
    v2Fields.deadlineReason = f.deadlineReason;
  } else {
    const borrowed =
      (activeBlock === 'F2'  && f.f2_deadline  && { date: f.f2_deadline,  reason: 'PNP deadline' })    ||
      (activeBlock === 'F4'  && f.f4_deadline  && { date: f.f4_deadline,  reason: 'School deadline' }) ||
      (activeBlock === 'F9'  && f.f9_deadline  && { date: f.f9_deadline,  reason: 'Other' })           ||
      (activeBlock === 'F10' && f.f10_deadline && { date: f.f10_deadline, reason: 'Other' })           || null;
    if (borrowed) { v2Fields.deadlineDate = borrowed.date; v2Fields.deadlineReason = borrowed.reason; }
  }
  try {
    await leadService.updateLead(leadId, v2Fields);
  } catch (err) {
    console.error(`[Intake] V2 column write failed for ${leadId} (lead kept): ${err.message}`);
  }

  // 2b. RULES decide the priority/tier (deterministic, per the TDOT brief);
  //     Critical leads fire an internal alert. The AI below is opinion only.
  let rulesResult = null;
  try {
    rulesResult = await require('./leadPriorityService').applyPriority(leadId, { ...v2Fields, fullName, email: f.email, phone: f.phone, urgentDeadline: f.urgentDeadline });
  } catch (err) {
    console.error(`[Intake] Priority evaluation failed for ${leadId}: ${err.message}`);
  }

  // 3. Upload letters + the full JSON archive to the intake OneDrive folder.
  //    Path-addressed PUTs auto-create the folder, so this never races the
  //    fire-and-forget ensureLeadFolder in createLead.
  const uploaded = [];
  const rejectedUploads = Array.isArray(f._rejectedUploads) ? f._rejectedUploads : [];
  try {
    const oneDrive = require('./oneDriveService');
    const put = (filename, buffer, mimeType) => oneDrive.uploadFile({
      clientName: fullName, caseRef: `LEAD-${leadId}`, category: 'Intake', filename, buffer, mimeType,
    });
    // Stored content-type derived from the validated extension — never trust
    // the client-supplied mimetype.
    const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
    for (const [field, base] of [['enforcementLetterFile', 'enforcement-letter'], ['refusalLetterFile', 'refusal-letter'],
                                 ['f9LetterFile', 'refusal-review-letter'], ['f10LetterFile', 'reference-letter']]) {
      const file = files[field] && files[field][0];
      if (!file) continue;
      const ext = (file.originalname.match(/\.(pdf|jpe?g|png)$/i) || ['', 'pdf'])[1].toLowerCase();
      await put(`${base}.${ext}`, file.buffer, MIME[ext] || 'application/octet-stream');
      uploaded.push(`${base}.${ext}`);
    }
    const archive = { submittedAt: new Date().toISOString(), leadId, fields: { ...f }, uploadedFiles: uploaded };
    delete archive.fields.consentContact; delete archive.fields.consentAccuracy;
    delete archive.fields.consentDisclaimer; delete archive.fields.consentStorage;
    archive.consents = { contact: true, accuracy: true, disclaimer: true, storage: true, at: archive.submittedAt };
    await put('intake-submission.json', Buffer.from(JSON.stringify(archive, null, 2)), 'application/json');
  } catch (err) {
    console.warn(`[Intake] OneDrive archive/upload failed for ${leadId} (non-fatal): ${err.message}`);
  }

  // 4. Staff digest on the lead (best-effort).
  try {
    const mondayApi = require('./mondayApi');
    await mondayApi.query(
      `mutation($itemId: ID!, $body: String!){ create_update(item_id: $itemId, body: $body){ id } }`,
      { itemId: String(leadId), body: buildDigest(f, uploaded, rejectedUploads) }
    );
  } catch (err) {
    console.warn(`[Intake] Digest update failed for ${leadId}: ${err.message}`);
  }

  // 5. AI second opinion — skip for existing clients (they are not sales leads).
  if (!isExistingClient) {
    leadService.qualifyLead(leadId, {
      ...lead, ...v2Fields, serviceRequired: f.serviceRequired,
      rulesPriority: rulesResult ? rulesResult.priority : '',
    }).catch((err) => console.error(`[Intake] Qualification failed for ${leadId}:`, err.message));
  }

  return { ok: true, leadId, html: buildThanksHtml(f, isExistingClient) };
}

/**
 * Readable digest for staff, posted as a Monday update. Monday renders update
 * bodies as HTML, and every value here is attacker-controlled (public form) —
 * so EVERYTHING interpolated, including F-block field names, goes through esc().
 */
function buildDigest(f, uploaded = [], rejectedUploads = []) {
  const lines = [];
  const add = (label, v) => { if (String(v || '').trim()) lines.push(`${label}: ${esc(v)}`); };
  const alert = [];
  if (f.removalOrder === 'Yes') alert.push('REMOVAL/ENFORCEMENT ORDER');
  if (f.enforcementLetter === 'Yes') alert.push('CBSA/IRCC LETTER RECEIVED');
  if (alert.length) lines.push(`🚨 ${alert.join(' · ')} — review urgently\n`);

  lines.push('— V2 Intake Submission —');
  add('Relationship', f.relationshipWithTdot);
  add('Existing file type', f.existingFileType);
  add('Service', f.serviceRequired);
  add('Wants to', f.whatDoYouWant);
  add('Inside Canada', f.insideCanada);
  add('Country', f.insideCanada === 'Yes' ? 'Canada' : f.currentCountry);
  add('Address', f.residentialAddress);
  add('Status', f.currentStatus);
  add('Status expiry', f.statusExpiry);
  add('Maintained/implied status', f.maintainedStatus);
  add('Recent extension/status application', f.recentExtension);
  add('Extension details', f.recentExtensionDetails);
  add('Urgent deadline', f.urgentDeadline === 'Yes' ? `${f.deadlineDate} (${f.deadlineReason})` : f.urgentDeadline);
  add('Removal/enforcement order', f.removalOrder);
  add('CBSA/IRCC letter', f.enforcementLetter);
  add('Enforcement details', f.enforcementDetails);
  add('Restoration period', f.restorationPeriod);
  add('Restoration deadline', f.restorationDeadline);
  add('Recent refusal', f.recentRefusal === 'Yes' ? `${f.refusalType} (${f.refusalDate})` : f.recentRefusal);
  add('How heard', f.howHeard);
  add('Referred by', f.referredBy);
  const fBlock = serviceToFBlock(f.serviceRequired);
  if (fBlock) {
    const fAnswers = Object.entries(f).filter(([k, v]) => k.startsWith(fBlock.toLowerCase() + '_') && String(v || '').trim())
      .map(([k, v]) => `  ${esc(k.replace(/^f\d+_/, ''))}: ${esc(v)}`);
    if (fAnswers.length) lines.push(`${fBlock} answers:\n${fAnswers.join('\n')}`);
  }
  if (uploaded.length) lines.push(`Uploaded to OneDrive/Intake: ${uploaded.map(esc).join(', ')}`);
  if (rejectedUploads.length) lines.push(`⚠ Upload rejected (type/size not allowed): ${rejectedUploads.map(esc).join(', ')} — ask the client to email the document.`);
  lines.push('Full submission: intake-submission.json in the client OneDrive folder (link on this item).');
  return lines.join('\n');
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function buildErrorsHtml(errors) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Please complete the form</title>
  <style>body{font-family:-apple-system,sans-serif;background:${BRAND.lightBg};padding:48px;color:${BRAND.textOnLight}}
  .box{background:#fff;padding:40px;border-radius:12px;max-width:560px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08)}</style></head>
  <body><div class="box"><h2 style="color:${BRAND.primary}">A few things are missing</h2>
  <ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
  <p><a href="javascript:history.back()">← Go back to the form</a> — your answers are still there.</p></div></body></html>`;
}

function buildThanksHtml(f, isExistingClient) {
  const first = esc(String(f.fullName || 'there').split(' ')[0]);
  const msg = isExistingClient
    ? `Since you already have an active file with us, your request is being routed directly to your case team — they'll be in touch shortly.`
    : `We've received your information and our team will review it and reach out within 24 hours by email.`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Thank You</title>
  <style>body{font-family:-apple-system,sans-serif;background:${BRAND.lightBg};padding:48px;text-align:center;color:${BRAND.textOnLight}}
  .box{background:#fff;padding:48px;border-radius:12px;max-width:520px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,0.08)}</style></head>
  <body><div class="box"><h1 style="color:${BRAND.primary}">Thank you, ${first}.</h1><p>${msg}</p>
  <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:28px">This form is for preliminary information collection only. Completing it does not confirm eligibility, create a client relationship, or guarantee any immigration outcome.</p>
  </div></body></html>`;
}

function buildIntakeFormHtml() {
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label || v)}</option>`;
  const yesNo = (name, extra = []) => ['Yes', 'No', ...extra].map((v) =>
    `<label class="radio"><input type="radio" name="${name}" value="${v}" required> ${v}</label>`).join('');

  const serviceOptions = Object.entries(SERVICE_GROUPS).map(([group, items]) =>
    `<optgroup label="${esc(group)}">${items.map((s) => opt(s)).join('')}</optgroup>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Client Intake — TDOT Immigration</title>
<style>
  body{background:${BRAND.lightBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;color:${BRAND.textOnLight}}
  .container{max-width:680px;margin:0 auto;padding:32px 20px}
  .header{background:${BRAND.darkPanel};color:${BRAND.textOnDark};padding:28px;border-radius:12px 12px 0 0;text-align:center}
  .intro{background:${BRAND.lightCard};padding:20px 28px;border-bottom:1px solid ${BRAND.border};font-size:13.5px;color:${BRAND.mutedOnLight}}
  .card{background:${BRAND.lightCard};padding:28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,0.08)}
  .section{margin-bottom:8px;border:1px solid ${BRAND.border};border-radius:10px;padding:20px 22px;margin-top:18px}
  .section h2{margin:0 0 4px;font-size:17px;color:${BRAND.darkPanel}}
  .section .hint{margin:0 0 8px;font-size:13px;color:${BRAND.mutedOnLight}}
  label{display:block;font-weight:600;margin:16px 0 6px;font-size:14.5px}
  label .opt{font-weight:400;color:${BRAND.mutedOnLight}}
  input[type=text],input[type=email],input[type=tel],input[type=date],input[type=number],select,textarea{width:100%;padding:11px;border:1px solid ${BRAND.border};border-radius:8px;font-size:15px;box-sizing:border-box;background:#fff}
  .radio{display:inline-block;font-weight:400;margin:4px 18px 4px 0}
  .radio input{margin-right:6px}
  .check{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:13.5px;margin:12px 0}
  .check input{margin-top:3px;flex:none}
  .cond{display:none;margin-left:2px;padding-left:14px;border-left:3px solid ${BRAND.border}}
  .cond.show{display:block}
  button{background:${BRAND.primary};color:#fff;padding:15px 28px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;margin-top:22px;width:100%}
  button:hover{background:${BRAND.primaryHover}}
  .filehint{font-size:12.5px;color:${BRAND.mutedOnLight}}
</style></head><body><div class="container">
  <div class="header">${TDOT_LOGO_LIGHT_HTML}
    <h1 style="margin:12px 0 4px;font-size:22px">Tell Us About Your Case</h1>
    <p style="margin:0;opacity:.85;font-size:14px">Complete this short intake so we can guide you to the right next step.</p>
  </div>
  <div class="intro">Thank you for contacting TDOT Immigration Services Inc. To help our team understand your inquiry and guide you to the right next step, please complete this intake form with accurate information.<br><br>
  This form is for preliminary information collection only. Completing this form does not confirm eligibility, does not create a client relationship, and does not guarantee any immigration outcome. Our team may recommend a paid consultation or request additional documents before providing case-specific advice.</div>
  <form class="card" method="POST" action="/lead/new" enctype="multipart/form-data">

    <div class="section"><h2>1 · Basic Information</h2>
      <label>Full legal name (as per passport) *</label><input type="text" name="fullName" required>
      <label>Email address *</label><input type="email" name="email" required>
      <label>Contact number with country code *</label><input type="tel" name="phone" required placeholder="+1 416 XXX XXXX">
      <label>Current complete residential address *</label><textarea name="residentialAddress" rows="2" required placeholder="Street address, city, province or state, postal code, country"></textarea>
      <label>Are you currently inside Canada? *</label><div>${yesNo('insideCanada')}</div>
      <div class="cond" id="c-outside"><label>Which country are you currently in? *</label><input type="text" name="currentCountry"></div>
    </div>

    <div class="section"><h2>2 · Your Relationship With TDOT</h2>
      <label>Have you contacted or worked with TDOT Immigration before? *</label>
      <select name="relationshipWithTdot" required><option value="">Choose...</option>
        ${opt('New inquiry')}${opt('Existing client with active application')}${opt('Previous client with completed or inactive application')}
      </select>
      <div class="cond" id="c-existing"><label>Which service or file type, if known? <span class="opt">(e.g. PGWP, Spousal Sponsorship, PR Card, Express Entry)</span></label>
      <input type="text" name="existingFileType"></div>
    </div>

    <div class="section"><h2>3 · Service Required</h2>
      <label>What service or support are you looking for? *</label>
      <select name="serviceRequired" id="serviceRequired" required><option value="">Choose...</option>${serviceOptions}</select>
      <label>Please briefly explain your inquiry or goal *</label>
      <textarea name="situationDescription" rows="4" required placeholder="Example: I received an ITA, I need to extend my work permit, I need help after a refusal..."></textarea>
      <label>What would you like to do? *</label>
      <select name="whatDoYouWant" required><option value="">Choose...</option>
        ${opt('Book consultation')}${opt('Start new application')}${opt('Request quote')}${opt('Existing file update')}${opt('General information')}
      </select>
    </div>

    <div class="section"><h2>4 · Current Immigration Status</h2>
      <label>Your current status in the country where you are presently located *</label>
      <select name="currentStatus" id="currentStatus" required><option value="">Choose...</option>
        ${['Visitor', 'Student', 'Worker', 'Permanent resident', 'Citizen', 'No valid status', 'Outside Canada', 'Other'].map((v) => opt(v)).join('')}
      </select>
      <div class="cond" id="c-expiry"><label>When does your current status expire? * <span class="opt">(exact date, not an estimate)</span></label>
      <input type="date" name="statusExpiry"></div>
      <div class="cond" id="c-maintained"><label>Are you currently on maintained or implied status? *</label><div>${yesNo('maintainedStatus')}</div></div>
      <label>Have you applied for an extension or change of status recently? <span class="opt">(optional)</span></label>
      <div><label class="radio"><input type="radio" name="recentExtension" value="Yes"> Yes</label>
      <label class="radio"><input type="radio" name="recentExtension" value="No"> No</label></div>
      <div class="cond" id="c-extension"><label>Application type and submission date <span class="opt">(e.g. visitor record submitted on May 1, 2026)</span></label>
      <textarea name="recentExtensionDetails" rows="2"></textarea></div>
    </div>

    <div class="section"><h2>5 · Urgency Screening</h2>
      <label>Do you have any urgent deadline connected to your inquiry? *</label><div>${yesNo('urgentDeadline')}</div>
      <div class="cond" id="c-deadline">
        <label>Deadline date *</label><input type="date" name="deadlineDate">
        <label>Reason for the deadline *</label>
        <select name="deadlineReason"><option value="">Choose...</option>${DEADLINE_REASONS.map((v) => opt(v)).join('')}</select>
      </div>
      <label>Are you currently subject to a removal, departure, exclusion, or deportation order, or any enforcement action? *</label>
      <div>${yesNo('removalOrder', ['Not sure'])}</div>
      <label>Have you received any letter, notice, call, or communication from CBSA, IRCC, or law enforcement asking you to attend, leave, or respond? *</label>
      <div>${yesNo('enforcementLetter', ['Not sure'])}</div>
      <div class="cond" id="c-letter">
        <label>Please upload the letter <span class="opt">(PDF, JPG, PNG)</span> and/or provide details</label>
        <input type="file" name="enforcementLetterFile" accept=".pdf,.jpg,.jpeg,.png">
        <textarea name="enforcementDetails" rows="3" placeholder="Details — what the letter says, who it is from, any dates" style="margin-top:8px"></textarea>
      </div>
      <div class="cond" id="c-restoration">
        <label>Are you currently within a restoration period? *</label><div>${yesNo('restorationPeriod')}</div>
        <div class="cond" id="c-restorationDate"><label>Restoration deadline <span class="opt">(exact date if known)</span></label>
        <input type="date" name="restorationDeadline"></div>
      </div>
      <label>Do you have any recent refusal? *</label><div>${yesNo('recentRefusal')}</div>
      <div class="cond" id="c-refusal">
        <label>What was refused? *</label>
        <select name="refusalType"><option value="">Choose...</option>${REFUSAL_TYPES.map((v) => opt(v)).join('')}</select>
        <label>Date of most recent refusal *</label><input type="date" name="refusalDate">
        <label>Upload refusal letter if available <span class="opt">(PDF, JPG, PNG)</span></label>
        <input type="file" name="refusalLetterFile" accept=".pdf,.jpg,.jpeg,.png">
      </div>
    </div>

    <div class="section" id="fblocks" style="display:none"><h2>6 · A Few Service-Specific Questions</h2>
      <div class="fb" id="F1">
        <label>Do you have a valid Express Entry profile?</label><div>${yesNo('f1_hasProfile')}</div>
        <label>What is your CRS score?</label><input type="number" name="f1_crsScore" min="0" max="1200">
        <label>Have you received an ITA?</label><div>${yesNo('f1_hasIta')}</div>
        <div class="cond" id="c-ita"><label>ITA deadline</label><input type="date" name="f1_itaDeadline">
        <label>Which program or draw invited you, if known?</label><input type="text" name="f1_program"></div>
      </div>
      <div class="fb" id="F2">
        <label>Have you received a NOI, nomination, or invitation?</label><div>${yesNo('f2_hasNomination')}</div>
        <label>Deadline, if any</label><input type="date" name="f2_deadline">
        <label>Which province?</label><input type="text" name="f2_province">
        <label>Are you applying with employer support?</label><div>${yesNo('f2_employerSupport')}</div>
      </div>
      <div class="fb" id="F3">
        <label>What type of work permit do you currently hold?</label><input type="text" name="f3_permitType">
        <label>Have you submitted a PR application or received an AOR?</label><div>${yesNo('f3_prSubmitted')}</div>
        <label>Do you have employer documents?</label><div>${yesNo('f3_employerDocs')}</div>
      </div>
      <div class="fb" id="F4">
        <label>Which intake are you targeting?</label><input type="text" name="f4_intake" placeholder="e.g. Fall 2026">
        <label>Have you received admission?</label><div>${yesNo('f4_admission')}</div>
        <label>Do you need application filing or document review?</label>
        <select name="f4_need"><option value="">Choose...</option>${opt('Application filing')}${opt('Document review')}${opt('Both')}</select>
        <label>School deadline, if any</label><input type="date" name="f4_deadline">
      </div>
      <div class="fb" id="F5">
        <label>What is the purpose of travel or stay extension?</label><textarea name="f5_purpose" rows="2"></textarea>
        <label>Have you had a refusal before? <span class="opt">(any refusal, even years ago)</span></label><div>${yesNo('f5_priorRefusal')}</div>
      </div>
      <div class="fb" id="F6">
        <label>Who is sponsoring whom?</label><input type="text" name="f6_whoSponsors" placeholder="e.g. I am sponsoring my spouse">
        <label>Is the sponsor a citizen or permanent resident?</label>
        <select name="f6_sponsorStatus"><option value="">Choose...</option>${opt('Citizen')}${opt('Permanent resident')}${opt('Not sure')}</select>
        <label>Is the applicant inside or outside Canada?</label>
        <select name="f6_applicantLocation"><option value="">Choose...</option>${opt('Inside Canada')}${opt('Outside Canada')}</select>
        <label>Any previous refusal or marriage-history concern?</label><input type="text" name="f6_concerns">
      </div>
      <div class="fb" id="F7">
        <label>When did you become a permanent resident?</label><input type="date" name="f7_prDate">
      </div>
      <div class="fb" id="F8">
        <label>Are you the employer or the employee?</label>
        <select name="f8_role"><option value="">Choose...</option>${opt('Employer')}${opt('Employee')}</select>
        <label>What is the job title?</label><input type="text" name="f8_jobTitle">
      </div>
      <div class="fb" id="F9">
        <label>What application was refused?</label>
        <select name="f9_refusalType"><option value="">Choose...</option>${REFUSAL_TYPES.map((v) => opt(v)).join('')}</select>
        <label>Date of the refusal <span class="opt">(even if it was a long time ago)</span></label><input type="date" name="f9_refusalDate">
        <label>Upload the refusal letter if available <span class="opt">(PDF, JPG, PNG)</span></label>
        <input type="file" name="f9LetterFile" accept=".pdf,.jpg,.jpeg,.png">
        <label>Any upcoming deadline to reapply or respond?</label><input type="date" name="f9_deadline">
      </div>
      <div class="fb" id="F10">
        <label>What document or update do you need?</label><input type="text" name="f10_need">
        <label>Is there a deadline?</label><input type="date" name="f10_deadline">
        <label>Upload the relevant letter or screenshot <span class="opt">(PDF, JPG, PNG)</span></label>
        <input type="file" name="f10LetterFile" accept=".pdf,.jpg,.jpeg,.png">
      </div>
    </div>

    <div class="section"><h2>7 · How You Found Us &amp; Consent</h2>
      <label>How did you hear about TDOT Immigration? *</label>
      <select name="howHeard" required><option value="">Choose...</option>${HOW_HEARD.map((v) => opt(v)).join('')}</select>
      <div class="cond" id="c-referral"><label>Who referred you?</label><input type="text" name="referredBy"></div>
      <label class="check"><input type="checkbox" name="consentContact" required> I consent to TDOT Immigration contacting me by phone, WhatsApp, email, or message regarding my inquiry. *</label>
      <label class="check"><input type="checkbox" name="consentAccuracy" required> I confirm that the information provided in this form is true and accurate to the best of my knowledge. *</label>
      <label class="check"><input type="checkbox" name="consentDisclaimer" required> I understand that submitting this form does not guarantee eligibility, approval, or representation by TDOT Immigration, and that case-specific advice may require a paid consultation. *</label>
      <label class="check"><input type="checkbox" name="consentStorage" required> I consent to TDOT Immigration storing this information for intake, follow-up, and service assessment purposes. *</label>
    </div>

    <button type="submit">Submit my information</button>
  </form>
</div>
<script>
(function(){
  function radios(name){ return Array.prototype.slice.call(document.querySelectorAll('input[name="'+name+'"]')); }
  function radioVal(name){ var r = radios(name).filter(function(x){return x.checked;}); return r.length ? r[0].value : ''; }
  function show(id, on){ var el = document.getElementById(id); if (el) el.classList[on ? 'add' : 'remove']('show'); }
  function onRadio(name, fn){ radios(name).forEach(function(r){ r.addEventListener('change', fn); }); }

  // A5 → A6 (+ D3 maintained status and E7 restoration: per the brief, both
  // are asked of EVERYONE inside Canada and required there)
  function updCanada(){ var v = radioVal('insideCanada'); show('c-outside', v === 'No');
    show('c-maintained', v === 'Yes'); show('c-restoration', v === 'Yes');
    document.getElementsByName('currentCountry')[0].required = (v === 'No');
    radios('restorationPeriod').forEach(function(r){ r.required = (v === 'Yes'); });
    radios('maintainedStatus').forEach(function(r){ r.required = (v === 'Yes'); }); }
  onRadio('insideCanada', updCanada);

  // B1 → B2
  var rel = document.getElementsByName('relationshipWithTdot')[0];
  rel.addEventListener('change', function(){ show('c-existing', rel.value && rel.value !== 'New inquiry'); });

  // C1 → F-block
  var SERVICE_TO_F = ${JSON.stringify(Object.fromEntries(ALL_SERVICES.map((s) => [s, serviceToFBlock(s)])))};
  var svc = document.getElementById('serviceRequired');
  svc.addEventListener('change', function(){
    var f = SERVICE_TO_F[svc.value] || null;
    document.getElementById('fblocks').style.display = f ? 'block' : 'none';
    Array.prototype.slice.call(document.querySelectorAll('.fb')).forEach(function(b){ b.style.display = (b.id === f) ? 'block' : 'none'; });
  });
  Array.prototype.slice.call(document.querySelectorAll('.fb')).forEach(function(b){ b.style.display = 'none'; });

  // D1 → D2 (expiry required for Visitor/Student/Worker)
  var st = document.getElementById('currentStatus');
  st.addEventListener('change', function(){
    var needs = ['Visitor','Student','Worker'].indexOf(st.value) >= 0;
    show('c-expiry', needs);
    document.getElementsByName('statusExpiry')[0].required = needs;
  });

  // D4 → details
  onRadio('recentExtension', function(){ show('c-extension', radioVal('recentExtension') === 'Yes'); });

  // E1 → E2/E3
  onRadio('urgentDeadline', function(){ var on = radioVal('urgentDeadline') === 'Yes'; show('c-deadline', on);
    document.getElementsByName('deadlineDate')[0].required = on;
    document.getElementsByName('deadlineReason')[0].required = on; });

  // E4/E5 → upload block
  function updLetter(){ show('c-letter', radioVal('removalOrder') === 'Yes' || radioVal('enforcementLetter') === 'Yes'); }
  onRadio('removalOrder', updLetter); onRadio('enforcementLetter', updLetter);

  // E7 → E8
  onRadio('restorationPeriod', function(){ show('c-restorationDate', radioVal('restorationPeriod') === 'Yes'); });

  // E9 → E10-E12
  onRadio('recentRefusal', function(){ var on = radioVal('recentRefusal') === 'Yes'; show('c-refusal', on);
    document.getElementsByName('refusalType')[0].required = on;
    document.getElementsByName('refusalDate')[0].required = on; });

  // F1 ITA → deadline
  onRadio('f1_hasIta', function(){ show('c-ita', radioVal('f1_hasIta') === 'Yes'); });

  // G1 → referral name
  var hh = document.getElementsByName('howHeard')[0];
  hh.addEventListener('change', function(){ show('c-referral', hh.value === 'Referral'); });

  // Hidden/optional radios must never block submit ("invalid form control is
  // not focusable"): F-block radios are optional, and restorationPeriod is
  // re-required by updCanada only once "inside Canada = Yes" reveals it.
  ['f1_hasProfile','f1_hasIta','f2_hasNomination','f2_employerSupport','f3_prSubmitted','f3_employerDocs','f4_admission','f5_priorRefusal','maintainedStatus','restorationPeriod']
    .forEach(function(n){ radios(n).forEach(function(r){ r.required = false; }); });
})();
</script>
</body></html>`;
}

module.exports = {
  buildIntakeFormHtml, processIntakeSubmission,
  // exported for tests
  serviceToInterest, serviceToFBlock, validateIntake, buildDigest,
  SERVICE_GROUPS, ALL_SERVICES,
};
