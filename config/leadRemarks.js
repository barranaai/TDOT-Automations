/**
 * One-click remark presets for leads (consultant note #8, 2026-09-03).
 * Each click posts an Update on the lead's Monday row so the whole team sees
 * what was done. Labels are free to edit; keys are what the UI sends.
 * "Notes sent / not sent / retain, no fees quoted" are Shafoli's conventions
 * from the 2026-08-13 meeting.
 */
const REMARK_PRESETS = [
  { key: 'notes-sent',       label: 'Notes sent to client',      hint: 'Consultation notes / summary emailed to the client' },
  { key: 'notes-not-sent',   label: 'Notes not sent',            hint: 'Decided not to send notes — say why in the details' },
  { key: 'retain-no-fees',   label: 'Retain — no fees quoted',   hint: 'Client wants to retain; fee not discussed yet' },
  { key: 'fees-quoted',      label: 'Fees quoted',               hint: 'Fee discussed with the client' },
  { key: 'follow-up-done',   label: 'Follow-up done',            hint: 'Follow-up call / email completed' },
  { key: 'no-answer',        label: 'No answer / voicemail',     hint: 'Tried to reach the client, no answer' },
  { key: 'client-to-revert', label: 'Client to revert',          hint: 'Waiting on the client to come back to us' },
  { key: 'docs-requested',   label: 'Documents requested',       hint: 'Asked the client for documents / information' },
];

module.exports = { REMARK_PRESETS };
