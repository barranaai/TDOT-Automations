// The lead page's "Attachments" (Faran 2026-11-27) — the service, with fakes only: which names may be listed
// (and every name that never may), both candidate folders, a same-name clash, the order, the keys, the honest
// "could not check" states, and reading one file by key (the stored name comes from a fresh listing, never
// from the caller). Every name, id and reference here is invented.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const svc = require('../src/services/leadFilesService');
const attachSvc = require('../src/services/leadAttachmentService');
const attachRules = require('../config/staffAttachments');

const LEAD = '9000000001';
const OTHER = '9000000002';
const CASE = '2026-TST-001';
const NAME = 'Test Person';

const f = (name, size = 100, when = '2026-11-01T10:00:00Z', isFolder = false) => ({ name, size, lastModifiedDateTime: when, isFolder });

/**
 * Fakes for the four seams. `folders` = { '<caseRef>': [children] | Error }; a reference that is not there
 * answers [] (listChildren's own "not there"). Restores the real seams when `fn` ends.
 */
async function withFakes(o, fn) {
  const keep = { ...svc.io };
  const calls = { getLead: [], folderState: [], list: [], read: [] };
  const leads = o.leads || { [LEAD]: { id: LEAD, name: NAME, fullName: NAME, clientMasterItemId: o.cmId || '' } };
  svc.io.getLead = async (id) => { calls.getLead.push(id); if (o.leadFails) throw new Error('monday down'); return leads[id] || null; };
  svc.io.folderState = async (lead) => {
    calls.folderState.push(lead.id);
    if (o.stateFails) throw new Error('boom');
    const refs = [];
    const caseRef = o.caseRefs ? o.caseRefs[lead.id] : o.caseRef;
    if (caseRef) refs.push({ clientName: lead.fullName, caseRef });
    refs.push({ clientName: lead.fullName, caseRef: `LEAD-${lead.id}` });
    return { refs, caseRefKnown: o.caseRefKnown !== false };
  };
  svc.io.listChildren = async (a) => {
    calls.list.push(a);
    const v = (o.folders || {})[a.caseRef];
    if (v instanceof Error) throw v;
    return v || [];
  };
  svc.io.readFile = async (a) => {
    calls.read.push(a);
    if (o.readFails) throw o.readFails;
    if (o.read) return o.read(a);
    return Buffer.from(`bytes of ${a.caseRef}/${a.subfolder}/${a.filename}`);
  };
  try { return await fn(calls); } finally { Object.assign(svc.io, keep); }
}

const LETTERS = ['enforcement-letter.pdf', 'refusal-letter.jpg', 'refusal-review-letter.png', 'reference-letter.jpeg'];
const STAFF_OLD = '2026-11-04 1432 - Staff One - WhatsApp Image 2026.jpeg';
const STAFF_NEW = '2026-11-20 0905 - Staff Two - passport scan.pdf';
const STAFF_HEIC = '2026-11-10 1200 - Staff One - IMG_0042.heic';

/* ══ the allow-list ═══════════════════════════════════════════════════════════ */

const NEVER = [
  'intake-submission.json', 'pre-consult-submission.json', 'pre-consultation-summary.pdf',
  'notes.txt', 'refusal-letter.html', 'refusal-letter.svg', 'refusal-letter.pdf.exe', 'refusal-letter.pdf.json',
  'refusal-letter.docx', 'refusal-letter.heic', 'refusal-letter.webp', 'refusal-letter', 'refusal-letter (1).pdf',
  'my-refusal-letter.pdf', 'refusal-letter.pdf ', ' refusal-letter.pdf', 'other-letter.pdf', '.pdf',
  'consultation-agreement-SIGNED.pdf', 'retainer-agreement.pdf', 'consultation-transcript.vtt',
  '2026-11-04 1432 - Staff One - page.html', '2026-11-04 1432 - Staff One - drawing.svg', '2026-11-04 1432 - notes.docx',
  '2026-11-04 1432 - Staff One - data.json', '2026-11-04 1432 Staff One - a.pdf', '2026-11-04 - Staff One - a.pdf',
  '2026-13-04 1432 - Staff One - a.pdf', '2026-11-04 2460 - Staff One - a.pdf', '26-11-04 1432 - a.pdf',
  'x 2026-11-04 1432 - Staff One - a.pdf', '2026-11-04 1432 - .pdf', '2026-11-04 1432 - a/b.pdf', '2026-11-04 1432 - a\\b.pdf',
  '2026-11-04 1432 - a\nb.pdf', '', null, undefined,
];

test('classify: only the four client letters (pdf/jpg/jpeg/png) and staff-attached files; every other name is refused', () => {
  for (const n of NEVER) assert.equal(svc.classify(n), null, JSON.stringify(n));
  for (const base of ['enforcement-letter', 'refusal-letter', 'refusal-review-letter', 'reference-letter']) {
    for (const ext of ['pdf', 'jpg', 'jpeg', 'png']) {
      const c = svc.classify(`${base}.${ext}`);
      assert.equal(c.kind, 'client'); assert.equal(c.ext, ext);
    }
  }
  for (const ext of ['jpg', 'jpeg', 'png', 'heic', 'webp', 'pdf']) {
    const c = svc.classify(`2026-11-04 1432 - Staff One - scan.${ext}`);
    assert.deepEqual(c, { kind: 'staff', ext, label: `scan.${ext}`, order: 0, addedBy: 'Staff One', addedAt: '2026-11-04 14:32' });
  }
});

test('labels follow the intake form; names match whatever the case of the letters', () => {
  assert.deepEqual(svc.CLIENT_LETTERS.map((l) => [l.base, l.label]), [
    ['enforcement-letter', 'Enforcement letter or notice'],
    ['refusal-letter', 'Refusal letter'],
    ['refusal-review-letter', 'Refusal letter (refusal review)'],
    ['reference-letter', 'Relevant letter or screenshot'],
  ]);
  assert.deepEqual(svc.classify('Refusal-Letter.PDF'), { kind: 'client', ext: 'pdf', label: 'Refusal letter', order: 1 });
  assert.equal(svc.classify('REFERENCE-LETTER.JpEg').ext, 'jpeg');
  assert.equal(svc.classify('2026-11-04 1432 - Staff One - Scan.PDF').ext, 'pdf');
});

test('the listing shows the allowed files only — the client\'s full answers and the summary PDF never appear', async () => {
  const kids = [...NEVER.filter((n) => typeof n === 'string' && n).map((n) => f(n)), ...LETTERS.map((n) => f(n)), f(STAFF_OLD), f(STAFF_NEW),
    f('refusal-letter.pdf', 0, '', true), f('2026-11-04 1432 - Staff One - a folder.pdf', 0, '', true)];
  await withFakes({ folders: { [`LEAD-${LEAD}`]: kids } }, async () => {
    const r = await svc.listLeadFiles(LEAD);
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.files.map((x) => x.label), [
      'Enforcement letter or notice', 'Refusal letter', 'Refusal letter (refusal review)', 'Relevant letter or screenshot',
      'passport scan.pdf', 'WhatsApp Image 2026.jpeg',
    ]);
    const text = JSON.stringify(r);
    for (const bad of ['intake-submission', 'pre-consult', 'summary', '.json', '.html', '.svg', 'folder']) assert.ok(!text.includes(bad), bad);
  });
});

/* ══ the shape, the order, the keys ═══════════════════════════════════════════ */

test('each file: key, label, kind, ext, size, modified, view (+ who and when on staff files) — and nothing else', async () => {
  await withFakes({ folders: { [`LEAD-${LEAD}`]: [f('refusal-letter.pdf', 2048, '2026-10-30T12:00:00Z'), f(STAFF_HEIC, 4096, '2026-11-10T17:00:01Z')] } }, async () => {
    const r = await svc.listLeadFiles(LEAD);
    assert.deepEqual(Object.keys(r).sort(), ['files', 'state']);
    const [letter, staff] = r.files;
    assert.deepEqual(letter, { key: letter.key, label: 'Refusal letter', kind: 'client', ext: 'pdf', size: 2048, modified: '2026-10-30T12:00:00Z', view: 'tab' });
    assert.deepEqual(staff, { key: staff.key, label: 'IMG_0042.heic', kind: 'staff', ext: 'heic', size: 4096, modified: '2026-11-10T17:00:01Z', view: 'download', addedBy: 'Staff One', addedAt: '2026-11-10 12:00' });
    // nothing that says where the file is or whose it is
    const text = JSON.stringify(r);
    for (const secret of [NAME, `LEAD-${LEAD}`, 'Intake', STAFF_HEIC, '_ref', '_name', 'clientName', 'caseRef']) assert.ok(!text.includes(secret), secret);
  });
});

test('view: pdf / jpg / jpeg / png / webp open in a tab, heic is a download; content types come from the fixed list', async () => {
  assert.deepEqual({ ...svc.MIME }, { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' });
  assert.ok(!Object.values(svc.MIME).some((m) => /html|svg|xml|javascript|text\//.test(m)));
  const kids = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic'].map((e, i) => f(`2026-11-0${i + 1} 1000 - Staff One - file${i}.${e}`));
  await withFakes({ folders: { [`LEAD-${LEAD}`]: kids } }, async () => {
    const r = await svc.listLeadFiles(LEAD);
    const view = Object.fromEntries(r.files.map((x) => [x.ext, x.view]));
    assert.deepEqual(view, { pdf: 'tab', jpg: 'tab', jpeg: 'tab', png: 'tab', webp: 'tab', heic: 'download' });
    for (const x of r.files) {
      const got = await svc.readLeadFile(LEAD, x.key);
      assert.equal(got.mime, svc.MIME[x.ext]); assert.equal(got.view, x.view); assert.equal(got.ext, x.ext);
    }
  });
});

test('order: the client\'s letters first in their fixed order, then staff files newest first', async () => {
  const kids = [f(STAFF_OLD), f('reference-letter.png'), f(STAFF_NEW), f('refusal-review-letter.pdf'), f(STAFF_HEIC), f('refusal-letter.pdf'), f('refusal-letter.jpg'), f('enforcement-letter.jpeg')];
  await withFakes({ folders: { [`LEAD-${LEAD}`]: kids } }, async () => {
    const r = await svc.listLeadFiles(LEAD);
    assert.deepEqual(r.files.map((x) => `${x.kind}:${x.label}:${x.ext}`), [
      'client:Enforcement letter or notice:jpeg', 'client:Refusal letter:jpg', 'client:Refusal letter:pdf',
      'client:Refusal letter (refusal review):pdf', 'client:Relevant letter or screenshot:png',
      'staff:passport scan.pdf:pdf', 'staff:IMG_0042.heic:heic', 'staff:WhatsApp Image 2026.jpeg:jpeg',
    ]);
  });
});

test('keys: hex only, the same on every look, different per file and per lead — and no part of a file name', async () => {
  const kids = [...LETTERS.map((n) => f(n)), f(STAFF_OLD), f(STAFF_NEW)];
  const leads = { [LEAD]: { id: LEAD, fullName: NAME }, [OTHER]: { id: OTHER, fullName: 'Second Person' } };
  await withFakes({ leads, folders: { [`LEAD-${LEAD}`]: kids, [`LEAD-${OTHER}`]: kids } }, async () => {
    const a1 = await svc.listLeadFiles(LEAD), a2 = await svc.listLeadFiles(LEAD), b = await svc.listLeadFiles(OTHER);
    assert.deepEqual(a1.files.map((x) => x.key), a2.files.map((x) => x.key), 'stable');
    const keys = a1.files.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, 'one key per file');
    for (const k of keys) {
      assert.match(k, /^[a-f0-9]{24}$/); assert.match(k, svc.KEY_RE);
      for (const part of ['refusal', 'letter', 'staff', 'pdf', 'lead', LEAD]) assert.ok(!k.includes(part), part);
    }
    assert.equal(keys.filter((k) => b.files.some((x) => x.key === k)).length, 0, 'another lead\'s keys are different, even for the same names');
  });
});

/* ══ both folders ═════════════════════════════════════════════════════════════ */

test('a lead with a case: the case folder is listed first, then LEAD-<id>; both lists are merged; only "Intake" is asked for', async () => {
  const folders = { [CASE]: [f(STAFF_NEW), f('refusal-letter.pdf', 111)], [`LEAD-${LEAD}`]: [f('enforcement-letter.pdf'), f(STAFF_OLD)] };
  await withFakes({ caseRef: CASE, cmId: '777', folders }, async (calls) => {
    const r = await svc.listLeadFiles(LEAD);
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.files.map((x) => x.label), ['Enforcement letter or notice', 'Refusal letter', 'passport scan.pdf', 'WhatsApp Image 2026.jpeg']);
    assert.deepEqual(calls.list, [{ clientName: NAME, caseRef: CASE, subfolder: 'Intake' }, { clientName: NAME, caseRef: `LEAD-${LEAD}`, subfolder: 'Intake' }]);
    assert.equal(calls.read.length, 0, 'a listing reads no file');
  });
});

test('the same name in both folders: shown once, from the first (the case folder) — and that is the one that opens', async () => {
  const folders = { [CASE]: [f('refusal-letter.pdf', 111)], [`LEAD-${LEAD}`]: [f('Refusal-Letter.PDF', 999), f('reference-letter.pdf', 5)] };
  await withFakes({ caseRef: CASE, cmId: '777', folders }, async (calls) => {
    const r = await svc.listLeadFiles(LEAD);
    assert.deepEqual(r.files.map((x) => [x.label, x.size]), [['Refusal letter', 111], ['Relevant letter or screenshot', 5]]);
    const got = await svc.readLeadFile(LEAD, r.files[0].key);
    assert.deepEqual(calls.read, [{ clientName: NAME, caseRef: CASE, subfolder: 'Intake', filename: 'refusal-letter.pdf' }]);
    assert.equal(got.buffer.toString(), `bytes of ${CASE}/Intake/refusal-letter.pdf`);
    const second = await svc.readLeadFile(LEAD, r.files[1].key);
    assert.equal(second.buffer.toString(), `bytes of LEAD-${LEAD}/Intake/reference-letter.pdf`);
  });
});

test('with the real folder rule (utils/clientFolderRefs): a lead with no case looks in "<name> - LEAD-<id>" only, with no Monday read', async () => {
  const keep = { ...svc.io };
  const asked = [];
  svc.io.getLead = async () => ({ id: LEAD, name: NAME, fullName: NAME, clientMasterItemId: '' });
  svc.io.listChildren = async (a) => { asked.push(a); return [f('refusal-letter.pdf')]; };
  try {
    const r = await svc.listLeadFiles(LEAD);
    assert.equal(r.state, 'ok'); assert.equal(r.files.length, 1); assert.equal(r.partial, undefined);
    assert.deepEqual(asked, [{ clientName: NAME, caseRef: `LEAD-${LEAD}`, subfolder: 'Intake' }]);
  } finally { Object.assign(svc.io, keep); }
});

/* ══ honest states ════════════════════════════════════════════════════════════ */

test('nothing there: a clean look with no files, a missing Intake folder or a missing client folder → ok + []', async () => {
  await withFakes({ folders: {} }, async () => assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'ok', files: [] }));
  await withFakes({ caseRef: CASE, cmId: '777', folders: { [CASE]: [], [`LEAD-${LEAD}`]: [] } }, async () => assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'ok', files: [] }));
  await withFakes({ folders: { [`LEAD-${LEAD}`]: [f('intake-submission.json'), f('pre-consultation-summary.pdf')] } }, async () => assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'ok', files: [] }));
});

test('a storage error is "could not check" — never 0 files: a thrown error, a transient one, a folder held during a repair', async () => {
  const transient = Object.assign(new Error('OneDrive list failed: {"error":{"message":"Test Person - folder"}}'), { transient: true });
  const held = Object.assign(new Error(`case ${CASE}: folder repair in progress — try again in a minute`), { transient: true, held: true });
  for (const [err, reason] of [[new Error('socket hang up'), 'storage'], [transient, 'storage'], [held, 'folder-busy']]) {
    await withFakes({ folders: { [`LEAD-${LEAD}`]: err } }, async () => {
      const r = await svc.listLeadFiles(LEAD);
      assert.deepEqual(r, { state: 'unchecked', files: [], reason });
      assert.ok(!JSON.stringify(r).includes('Test Person'), 'the storage error\'s own words are never passed on');
      assert.deepEqual(await svc.readLeadFile(LEAD, 'a'.repeat(24)), { refused: 'unchecked', reason });
    });
  }
});

test('one folder answers and the other fails → "could not check", not half a list', async () => {
  await withFakes({ caseRef: CASE, cmId: '777', folders: { [CASE]: [f('refusal-letter.pdf')], [`LEAD-${LEAD}`]: new Error('timeout') } }, async () => {
    assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'unchecked', files: [], reason: 'storage' });
  });
  await withFakes({ caseRef: CASE, cmId: '777', folders: { [CASE]: new Error('timeout'), [`LEAD-${LEAD}`]: [f('refusal-letter.pdf')] } }, async (calls) => {
    assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'unchecked', files: [], reason: 'storage' });
    assert.equal(calls.list.length, 1, 'stops at the failure');
  });
});

test('the case reference could not be read: nothing found → "could not check"; something found → shown, marked partial', async () => {
  await withFakes({ caseRefKnown: false, cmId: '777', folders: {} }, async () => {
    assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'unchecked', files: [], reason: 'case-unreadable' });
    assert.deepEqual(await svc.readLeadFile(LEAD, 'a'.repeat(24)), { refused: 'unchecked', reason: 'case-unreadable' });
  });
  await withFakes({ caseRefKnown: false, cmId: '777', folders: { [`LEAD-${LEAD}`]: [f('refusal-letter.pdf')] } }, async () => {
    const r = await svc.listLeadFiles(LEAD);
    assert.equal(r.state, 'ok'); assert.equal(r.partial, true); assert.equal(r.files.length, 1);
    assert.equal((await svc.readLeadFile(LEAD, r.files[0].key)).mime, 'application/pdf');
    // a key that is not in a half look: "could not check", not "gone"
    assert.deepEqual(await svc.readLeadFile(LEAD, 'b'.repeat(24)), { refused: 'unchecked', reason: 'case-unreadable' });
  });
});

test('the lead: not on the board → not-found; unreadable → "could not check"; a bad id reads nothing at all', async () => {
  await withFakes({ leads: {} }, async (calls) => {
    assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'not-found', files: [] });
    assert.deepEqual(await svc.readLeadFile(LEAD, 'a'.repeat(24)), { refused: 'not-found' });
    assert.equal(calls.list.length, 0);
  });
  await withFakes({ leadFails: true }, async () => {
    assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'unchecked', files: [], reason: 'lead-unreadable' });
    assert.deepEqual(await svc.readLeadFile(LEAD, 'a'.repeat(24)), { refused: 'unchecked', reason: 'lead-unreadable' });
  });
  await withFakes({ stateFails: true }, async () => assert.deepEqual(await svc.listLeadFiles(LEAD), { state: 'unchecked', files: [], reason: 'lead-unreadable' }));
  for (const bad of ['', '12', 'abc', '../9000000001', '9000000001/x', `LEAD-${LEAD}`, null, undefined, '9'.repeat(21)]) {
    await withFakes({}, async (calls) => {
      assert.deepEqual(await svc.listLeadFiles(bad), { state: 'not-found', files: [] });
      assert.deepEqual(await svc.readLeadFile(bad, 'a'.repeat(24)), { refused: 'not-found' });
      assert.equal(calls.getLead.length + calls.list.length + calls.read.length, 0, String(bad));
    });
  }
});

/* ══ reading one file ═════════════════════════════════════════════════════════ */

test('readLeadFile: a fresh listing every time; the stored name of THAT listing is read from THAT folder', async () => {
  const folders = { [CASE]: [f(STAFF_NEW, 300)], [`LEAD-${LEAD}`]: [f('enforcement-letter.jpg', 200)] };
  await withFakes({ caseRef: CASE, cmId: '777', folders }, async (calls) => {
    const { files } = await svc.listLeadFiles(LEAD);
    calls.list.length = 0;
    const staff = await svc.readLeadFile(LEAD, files.find((x) => x.kind === 'staff').key);
    assert.equal(calls.list.length, 2, 'listed again for the read');
    assert.deepEqual(calls.read, [{ clientName: NAME, caseRef: CASE, subfolder: 'Intake', filename: STAFF_NEW }]);
    assert.deepEqual(Object.keys(staff).sort(), ['buffer', 'downloadName', 'ext', 'kind', 'mime', 'view']);
    assert.equal(staff.mime, 'application/pdf'); assert.equal(staff.view, 'tab'); assert.equal(staff.kind, 'staff');
    assert.equal(staff.downloadName, 'passport scan.pdf');
    const letter = await svc.readLeadFile(LEAD, files.find((x) => x.kind === 'client').key);
    assert.deepEqual(calls.read[1], { clientName: NAME, caseRef: `LEAD-${LEAD}`, subfolder: 'Intake', filename: 'enforcement-letter.jpg' });
    assert.equal(letter.mime, 'image/jpeg'); assert.equal(letter.downloadName, 'enforcement-letter.jpg');
  });
});

test('readLeadFile: an unknown key, a file name, a path, or another lead\'s key never reads anything', async () => {
  const kids = [f('refusal-letter.pdf'), f('intake-submission.json'), f(STAFF_OLD)];
  const leads = { [LEAD]: { id: LEAD, fullName: NAME }, [OTHER]: { id: OTHER, fullName: 'Second Person' } };
  await withFakes({ leads, folders: { [`LEAD-${LEAD}`]: kids, [`LEAD-${OTHER}`]: kids } }, async (calls) => {
    const mine = (await svc.listLeadFiles(LEAD)).files;
    const theirs = (await svc.listLeadFiles(OTHER)).files;
    for (const bad of ['c'.repeat(24), 'refusal-letter.pdf', 'intake-submission.json', '../intake-submission.json', STAFF_OLD, 'Intake/refusal-letter.pdf',
      mine[0].key.toUpperCase(), mine[0].key.slice(0, 15), mine[0].key + '/..', '', null, undefined, theirs[0].key, theirs[1].key]) {
      assert.deepEqual(await svc.readLeadFile(LEAD, bad), { refused: 'not-found' }, String(bad));
    }
    assert.equal(calls.read.length, 0);
    // the key of the hidden archive, had someone worked it out, is not in the listing either
    assert.deepEqual(await svc.readLeadFile(LEAD, svc.keyOf(LEAD, `LEAD-${LEAD}`, 'intake-submission.json')), { refused: 'not-found' });
    assert.equal(calls.read.length, 0);
    // and the lead's own key works for that lead only
    assert.ok((await svc.readLeadFile(LEAD, mine[0].key)).buffer);
    assert.deepEqual(await svc.readLeadFile(OTHER, mine[0].key), { refused: 'not-found' });
  });
});

test('readLeadFile: gone between the look and the read → not-found; storage trouble → "could not check"; a file too big is not read', async () => {
  const folders = { [`LEAD-${LEAD}`]: [f('refusal-letter.pdf', 10), f('reference-letter.pdf', svc.MAX_READ_BYTES + 1)] };
  await withFakes({ folders, read: () => null }, async () => {
    const { files } = await svc.listLeadFiles(LEAD);
    assert.deepEqual(await svc.readLeadFile(LEAD, files[0].key), { refused: 'not-found' });
  });
  await withFakes({ folders, readFails: Object.assign(new Error('OneDrive read failed'), { transient: true }) }, async () => {
    const { files } = await svc.listLeadFiles(LEAD);
    assert.deepEqual(await svc.readLeadFile(LEAD, files[0].key), { refused: 'unchecked', reason: 'storage' });
  });
  await withFakes({ folders }, async (calls) => {
    const { files } = await svc.listLeadFiles(LEAD);
    assert.deepEqual(await svc.readLeadFile(LEAD, files[1].key), { refused: 'too-big' });
    assert.equal(calls.read.length, 0, 'never read into memory');
  });
  await withFakes({ folders, read: () => Buffer.alloc(svc.MAX_READ_BYTES + 1) }, async () => {
    const { files } = await svc.listLeadFiles(LEAD);
    assert.deepEqual(await svc.readLeadFile(LEAD, files[0].key), { refused: 'too-big' });
  });
});

test('the save name is plain ASCII built from the label — never the client\'s name, nothing that could break a header', async () => {
  const odd = ['2026-11-04 1432 - Staff One - Résumé “final” (2).pdf', '2026-11-05 0900 - Staff One - جواز السفر.png', '2026-11-06 0900 - Staff One - a"b;c\'d.jpg'];
  await withFakes({ folders: { [`LEAD-${LEAD}`]: odd.map((n) => f(n)) } }, async () => {
    const { files } = await svc.listLeadFiles(LEAD);
    const names = [];
    for (const x of files) names.push((await svc.readLeadFile(LEAD, x.key)).downloadName);
    assert.deepEqual(names.sort(), ['Resume final (2).pdf', 'a b c d.jpg', 'attachment.png']);
    for (const n of names) { assert.match(n, /^[A-Za-z0-9 ._()-]+$/); assert.ok(!n.includes(NAME)); }
  });
});

/* ══ the names cannot drift from the code that writes them ════════════════════ */

test('staff files: the name attach() builds is the name the matcher reads back (one builder, one reader, side by side)', () => {
  const at = new Date('2026-11-04T19:32:00Z');   // 14:32 in Toronto
  for (const ext of Object.keys(attachRules.EXTENSIONS)) {
    const stored = attachSvc.staffFileName({ at, who: 'Staff One', base: 'WhatsApp Image 2026', ext });
    assert.equal(stored, `2026-11-04 1432 - Staff One - WhatsApp Image 2026${ext}`);
    assert.deepEqual(attachSvc.parseStaffFileName(stored), { date: '2026-11-04', time: '14:32', who: 'Staff One', name: 'WhatsApp Image 2026', ext: ext.slice(1) });
    assert.equal(svc.classify(stored).kind, 'staff');
    assert.ok(svc.MIME[ext.slice(1)], `a content type for ${ext}`);
  }
  // no staff name on the sign-in → no staff part
  const bare = attachSvc.staffFileName({ at, who: '', base: 'scan', ext: '.pdf' });
  assert.equal(bare, '2026-11-04 1432 - scan.pdf');
  assert.deepEqual(attachSvc.parseStaffFileName(bare), { date: '2026-11-04', time: '14:32', who: '', name: 'scan', ext: 'pdf' });
  // OneDrive's own "keep both" suffix on a second upload of the same name still reads
  assert.equal(attachSvc.parseStaffFileName('2026-11-04 1432 - Staff One - scan 1.pdf').name, 'scan 1');
  // a name with " - " inside keeps everything after the staff part
  assert.deepEqual(attachSvc.parseStaffFileName('2026-11-04 1432 - Staff One - visa - page 2.png'), { date: '2026-11-04', time: '14:32', who: 'Staff One', name: 'visa - page 2', ext: 'png' });
  const src = fs.readFileSync(require.resolve('../src/services/leadAttachmentService.js'), 'utf8');
  assert.ok(src.includes('const filename = staffFileName({ at: io.now(), who, base, ext });'), 'attach() uses the shared builder');
});

test('client letters: the four names here are the four intakeFormService stores', () => {
  const src = fs.readFileSync(require.resolve('../src/services/intakeFormService.js'), 'utf8');
  const stored = [...src.matchAll(/\['\w+LetterFile', '([a-z-]+)'\]/g)].map((m) => m[1]);
  assert.deepEqual(stored, svc.CLIENT_LETTERS.map((l) => l.base));
  assert.ok(src.includes('.match(/\\.(pdf|jpe?g|png)$/i)'), 'and the same four extensions');
  for (const base of stored) assert.match(`${base}.pdf`, svc.CLIENT_LETTER_RE);
});

test('the service only reads: no upload, create, move, delete or link call anywhere in it', () => {
  const src = fs.readFileSync(require.resolve('../src/services/leadFilesService.js'), 'utf8');
  assert.ok(!/upload|ensure|create(?!Hash)|rename|move|delete|orgLink|mondayApi|console\./i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  assert.deepEqual(Object.keys(svc.io).sort(), ['folderState', 'getLead', 'listChildren', 'readFile']);
});
