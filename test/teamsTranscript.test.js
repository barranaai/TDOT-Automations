'use strict';

// Teams transcript fetch — the pure decision + URL logic (the Graph I/O is mocked
// out; here we lock the candidate window, the join-URL lookup encoding, the
// content URL format, and picking the newest transcript).

const test   = require('node:test');
const assert = require('node:assert/strict');

const t = require('../src/services/teamsTranscriptService');
const { torontoSlotToUTC } = require('../src/services/postConsultService');

const SLOT = '2026-06-25 16:30';
const slotMs = torontoSlotToUTC(SLOT);
const teamsLead = (over = {}) => ({ id: '1', fullName: 'Aarav Sharma', bookedSlot: SLOT,
  transcriptUrl: '', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc', ...over });

test('isTranscriptCandidate: only after the meeting, within the 72h window, Teams, not yet captured', () => {
  // before the meeting ends → no
  assert.equal(t.isTranscriptCandidate(teamsLead(), slotMs + 10 * 60000), false);
  // 2h after → yes (done + within window)
  assert.equal(t.isTranscriptCandidate(teamsLead(), slotMs + 2 * 3600000), true);
  // 100h after → no (window closed)
  assert.equal(t.isTranscriptCandidate(teamsLead(), slotMs + 100 * 3600000), false);
  // already have a transcript → no
  assert.equal(t.isTranscriptCandidate(teamsLead({ transcriptUrl: 'https://x' }), slotMs + 2 * 3600000), false);
  // not a Teams meeting (Zoom) → no
  assert.equal(t.isTranscriptCandidate(teamsLead({ meetingUrl: 'https://zoom.us/j/123' }), slotMs + 2 * 3600000), false);
  // no meeting link → no
  assert.equal(t.isTranscriptCandidate(teamsLead({ meetingUrl: '' }), slotMs + 2 * 3600000), false);
  // unparseable slot → no
  assert.equal(t.isTranscriptCandidate(teamsLead({ bookedSlot: '' }), Date.now()), false);
});

test('meetingLookupUrl: $filter on JoinWebUrl, fully URL-encoded', () => {
  const url = t.meetingLookupUrl('organizer@tdot.ca', 'https://teams.microsoft.com/l/meetup-join/x?y=1&z=2');
  assert.match(url, /\/users\/organizer%40tdot\.ca\/onlineMeetings\?\$filter=/);
  // the raw filter string must be percent-encoded (no literal spaces / quotes / & leaking)
  assert.ok(!/ eq /.test(url.split('$filter=')[1]), 'space must be encoded');
  assert.match(url, /JoinWebUrl%20eq%20/);
  assert.match(decodeURIComponent(url.split('$filter=')[1]), /JoinWebUrl eq 'https:\/\/teams\.microsoft\.com\/l\/meetup-join\/x\?y=1&z=2'/);
});

test('transcriptContentUrl: content endpoint with WebVTT format', () => {
  const url = t.transcriptContentUrl('org@x.ca', 'MEET-1', 'TR-9');
  assert.equal(url, "https://graph.microsoft.com/v1.0/users/org%40x.ca/onlineMeetings/MEET-1/transcripts/TR-9/content?$format=text/vtt");
});

test('pickLatestTranscript: newest by createdDateTime, null when none', () => {
  assert.equal(t.pickLatestTranscript([]), null);
  assert.equal(t.pickLatestTranscript(null), null);
  const chosen = t.pickLatestTranscript([
    { id: 'old', createdDateTime: '2026-06-25T17:00:00Z' },
    { id: 'new', createdDateTime: '2026-06-25T17:30:00Z' },
    { id: 'mid', createdDateTime: '2026-06-25T17:15:00Z' },
  ]);
  assert.equal(chosen.id, 'new');
});
