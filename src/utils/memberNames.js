'use strict';

/**
 * Family Members board rows the app creates for a member nobody has named yet
 * carry a placeholder name: "Spouse (from intake)", "Child 1 (from intake)"
 * (familyCompositionService, intake), "Dependent Child (consultant-set)"
 * (familyCompositionService, retainer panel), "Spouse (added by staff)",
 * "Child 2 (added by client)" (familyMemberService). A bare member-type word,
 * with or without a number ("Child 2", "Parent", "Worker Spouse") — the
 * questionnaire's own default section labels — is not a name either. None of
 * these is ever a questionnaire label, pre-filled into a name field, or shown
 * to the client as a person. ONE rule, used everywhere that question is asked.
 */
const PLACEHOLDER_NAME_RE = /\((?:from intake|added by (?:staff|client)|consultant-set)\)/i;
const TYPE_WORD_RE = /^\s*(?:spouse(?:\s*\/\s*common-law partner)?|common-law partner|dependent child|child|worker spouse|sponsor|parent|sibling|principal applicant|primary applicant)(?:\s*\d+)?\s*$/i;

const isPlaceholderName = (name) => { const s = String(name || ''); return PLACEHOLDER_NAME_RE.test(s) || TYPE_WORD_RE.test(s); };

module.exports = { PLACEHOLDER_NAME_RE, TYPE_WORD_RE, isPlaceholderName };
