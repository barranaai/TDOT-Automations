'use strict';

/**
 * Subject words that mean an email to info@ is a job application or a business
 * pitch, not a client (Faran 2026-11-09, step 4). Used ONLY when the sender is
 * new — a sender we already know (open case or lead) always gets the email as a
 * note, whatever the subject (clients send CVs as documents).
 *
 * Whole words / phrases, case-insensitive, subject only. Removed on purpose:
 * sponsorship, applying for, hiring, partnership — real clients use them.
 * EMAIL_LEADS_SKIP_WORDS adds more (comma-separated); EMAIL_LEADS_SKIP_WORDS=off
 * switches the check off.
 */
const SKIP_SUBJECT_WORDS = [
  'resume', 'cv', 'curriculum vitae', 'job application', 'application for the position',
  'job opening', 'vacancy', 'internship', 'career opportunity', 'collaboration', 'seo',
  'web design', 'guest post', 'marketing services', 'business proposal',
];

/** "resume" is a verb too ("resume my file"): not a skip when one of these follows it. */
const RESUME_VERB_NEXT = ['my', 'our', 'the', 'processing', 'file', 'application', 'case'];

/** "CV" with one of these is an assessment request ("my CV for PR assessment"), not a job seeker. */
const CV_IMMIGRATION_WORDS = ['pr', 'assessment', 'eligibility', 'express entry', 'work permit', 'consultation', 'lmia', 'visa', 'oinp', 'immigration'];

module.exports = { SKIP_SUBJECT_WORDS, RESUME_VERB_NEXT, CV_IMMIGRATION_WORDS };
