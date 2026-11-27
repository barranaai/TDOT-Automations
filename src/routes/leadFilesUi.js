'use strict';

/**
 * The lead page's "Attachments" button and its pop-up (Faran 2026-11-27) — the browser half.
 * Staff asked: "we are unable to check the attachments — can we move the attachment option to the top
 * beside the priority?" The button sits in the header chip row right after Priority, is ALWAYS there
 * (greyed "Attachments 0" when the lead has no files), and opens the house pop-up with the client's
 * letters and the files staff attached. Each file opens in a new tab (HEIC pictures are saved instead).
 *
 * The server half: routes/leadFilesRoutes.js + services/leadFilesService.js
 *   GET /api/leads/:leadId/files        → { state: 'ok' | 'unchecked', files: [...] }
 *   GET /api/leads/:leadId/files/:key   → the bytes (team key in the X-Api-Key header, like the page itself)
 *
 * WHY ONE BUTTON ELEMENT, KEPT: the page's render() rebuilds the whole chip row after every save. So the
 * list of files lives HERE (one variable, S), the button is ONE element made once, and render() only
 * leaves a slot marker that place() swaps for that same button. A re-render therefore never loses the
 * count, a "checking" state, the keyboard focus or an open pop-up (the pop-up hangs on <body>, not in
 * the chip row).
 *
 * HONEST STATES: "Attachments 0" is shown only after the server looked and found nothing. When the
 * files could not be checked the button says so and a click tries again — never a false 0.
 *
 * OPENING A FILE: a plain link to an /api address cannot carry the team key, so the click (1) opens a
 * blank tab at once — inside the click, or the browser's pop-up blocker stops it — (2) fetches the bytes
 * with the key header, (3) points the tab at them. The bytes are given their type HERE from a fixed list
 * by extension (pdf / pictures only — never a page a browser would run), whatever the answer said. A tab
 * that could not be opened, or was closed meanwhile, becomes a plain download.
 *
 * Use on a page (after the shared pop-up code, dialogUi.js):
 *   <style> … ${LEAD_FILES_CSS} </style>
 *   <script> … ${LEAD_FILES_UI_JS}
 *     var F = tdotLeadFiles({ leadId, key: getKey, icons: { clip, file }, name: function(){ … } });
 *     in render():  pills += F.slotHtml;  …  (the row's innerHTML is set)  …  F.place(hadFocus);
 *     after the first load:  F.start();      after a staff upload:  F.reload();
 *
 * The functions below are real functions: the page gets their source (fn.toString()) and the tests run
 * the very same code. They are pasted into a page script that lives inside a Node template literal, so
 * inside them: no backtick, no dollar-brace, no backslash (test/leadFilesUi.test.js checks).
 */

/** The paperclip (the page's icon sets draw it at 1em, in the text colour). */
const PAPERCLIP_PATH = '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>';

const LEAD_FILES_CSS = `
  /* "Attachments" in the header chip row: a chip that is a real button (the other chips are plain labels) */
  .chip-btn { position:relative; border:0; margin:0; font-family:inherit; line-height:inherit; text-align:left; white-space:normal; cursor:pointer; -webkit-appearance:none; appearance:none; }
  .chip-btn:hover:not(:disabled):not([aria-disabled="true"]) { box-shadow:inset 0 0 0 1.5px currentColor; }
  .chip-btn:disabled, .chip-btn[aria-disabled="true"] { cursor:default; opacity:1; }   /* greyed by its colour, never faded: the words stay readable */
  .chip-btn[aria-busy="true"] { cursor:progress; }
  .chip-btn .lf-chip-ico { display:inline-flex; }
  /* Phones, tablets and touch screens: the chip keeps its look, the area that takes a tap is 44px tall */
  @media (max-width:900px), (pointer:coarse) {
    .chip-btn::after { content:''; position:absolute; left:0; right:0; top:50%; height:44px; transform:translateY(-50%); }
  }
  /* the pop-up */
  .lf-who { font-size:13px; color:var(--muted, #64748b); margin:0 0 4px; overflow-wrap:anywhere; }
  .lf-note { background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; font-size:12.5px; line-height:1.45; color:#92400e; margin:10px 0 0; }
  .lf-group-t { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:#64748b; margin:16px 0 2px; }
  .lf-group { list-style:none; margin:0; padding:0; }
  .lf-item { border-top:1px solid #f1f5f9; padding:9px 0; }
  .lf-item:first-child { border-top:none; }
  .lf-row { display:flex; align-items:center; gap:10px; }
  .lf-ico { flex:none; display:inline-flex; font-size:18px; color:#64748b; }
  .lf-main { flex:1 1 auto; min-width:0; }
  .lf-name { font-size:13.5px; font-weight:600; line-height:1.35; color:var(--navy, #1a3558); overflow-wrap:anywhere; }
  .lf-meta { font-size:12px; line-height:1.4; color:#64748b; margin-top:1px; overflow-wrap:anywhere; }
  .lf-open { flex:none; min-width:84px; }
  .lf-msg { font-size:12.5px; line-height:1.45; color:#334155; margin:6px 0 0 28px; overflow-wrap:anywhere; }
  .lf-msg.err { color:#dc2626; }
  .lf-msg[hidden] { display:none; }
  .lf-empty { font-size:13px; color:#64748b; padding:12px 0 4px; }
  @media (max-width:560px) { .lf-open { min-height:44px; } }
  /* Printing the lead page: the chip prints as plain words; the pop-up never prints */
  @media print { .lf-ov { display:none !important; } .chip-btn::after { display:none; } }
`;

/** A file size in plain words: "340 KB", "1.2 MB". Nothing for an unknown size. */
function tdotLfSize(n) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/** The small line under a file's name: type · size, and for a staff file who added it and when (Toronto time). */
function tdotLfMeta(f) {
  var parts = [], size = tdotLfSize(f && f.size);
  if (f && f.ext) parts.push(String(f.ext).toUpperCase());
  if (size) parts.push(size);
  if (f && f.kind === 'staff') {
    if (f.addedBy) parts.push('added by ' + f.addedBy);
    if (f.addedAt) parts.push(f.addedAt);
  }
  return parts.join(' · ');
}

/** The name a saved file gets: the server's own safe name (Content-Disposition), cut down again to plain letters; "attachment.<ext>" without one. */
function tdotLfSaveName(header, f) {
  var h = String(header || ''), at = h.indexOf('filename="'), raw = '', name = '', i, c;
  var SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ._()-';
  if (at >= 0) { raw = h.slice(at + 10); raw = raw.indexOf('"') >= 0 ? raw.slice(0, raw.indexOf('"')) : ''; }
  for (i = 0; i < raw.length && name.length < 80; i++) { c = raw.charAt(i); if (SAFE.indexOf(c) >= 0) name += c; }
  while (name.charAt(0) === '.' || name.charAt(0) === ' ') name = name.slice(1);
  while (name.charAt(name.length - 1) === ' ') name = name.slice(0, -1);
  var ext = String((f && f.ext) || '').toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = '';
  if (!name) name = 'attachment';
  if (ext && name.toLowerCase().slice(-(ext.length + 1)) !== '.' + ext) name += '.' + ext;
  return name;
}

/**
 * The button and its pop-up for one lead. o:
 *   leadId   the lead's id
 *   key      function → the team key (the page's getKey: it sends the person to sign in when there is none)
 *   icons    { clip, file } — SVG strings from the page's own icon set
 *   name     function → the lead's name, for the pop-up's first line
 * Returns { chip, slotHtml, place(focus), start(), reload(), open(), state() }.
 */
function tdotLeadFiles(o) {
  o = o || {};
  var icons = o.icons || {};
  /* The one place the list lives. state: 'loading' | 'ok' | 'unchecked'. */
  var S = { state: 'loading', files: [], partial: false };
  var started = false, seq = 0, opening = 0, dlg = null, listEl = null, drawn = '';
  /* What a file is shown as — by its extension, from this list only. Never what the answer called it. */
  var TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
  var IN_TAB = { pdf: 1, jpg: 1, jpeg: 1, png: 1, webp: 1 };
  var base = '/api/leads/' + encodeURIComponent(String(o.leadId == null ? '' : o.leadId)) + '/files';

  function mk(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function theKey() { try { return typeof o.key === 'function' ? o.key() : null; } catch (e) { return null; } }
  function signIn() { try { window.location.href = '/admin'; } catch (e) {} }

  /* ── the button: made once, painted in place ── */
  var chip = mk('button', 'chip chip-btn grey');
  chip.type = 'button'; chip.id = 'c-att-chip';
  chip.setAttribute('aria-haspopup', 'dialog');
  var ico = mk('span', 'lf-chip-ico'); ico.setAttribute('aria-hidden', 'true'); ico.innerHTML = icons.clip || '';
  var count = document.createTextNode('');
  chip.appendChild(ico); chip.appendChild(mk('span', 'pk', 'Attachments')); chip.appendChild(count);

  function paint() {
    var n = S.files.length, st = S.state;
    chip.className = 'chip chip-btn ' + (st === 'unchecked' ? 'amber' : (st === 'ok' && n > 0) ? 'blue' : 'grey');
    count.textContent = ' ' + (st === 'loading' ? '…' : st === 'unchecked' ? '— could not check' : String(n));
    chip.disabled = (st === 'ok' && n === 0);
    if (st === 'loading') { chip.setAttribute('aria-busy', 'true'); chip.setAttribute('aria-disabled', 'true'); }
    else { chip.removeAttribute('aria-busy'); chip.removeAttribute('aria-disabled'); }
    chip.title = st === 'loading' ? 'Checking for files…'
      : st === 'unchecked' ? 'Click to try again'
      : n === 0 ? 'No files on this lead'
      : (n === 1 ? 'Show the file on this lead' : 'Show the ' + n + ' files on this lead');
  }

  /* Only files the pop-up can name safely: a key made of hex digits (it becomes part of the address). */
  function tidy(list) {
    var out = [], i, f, ext;
    for (i = 0; i < list.length; i++) {
      f = list[i];
      if (!f || !/^[a-f0-9]{16,64}$/.test(String(f.key || ''))) continue;
      ext = String(f.ext || '').toLowerCase();
      out.push({ key: String(f.key), label: String(f.label || 'File'), kind: f.kind === 'client' ? 'client' : 'staff', ext: ext,
        size: f.size, view: (f.view === 'tab' && IN_TAB[ext] === 1) ? 'tab' : 'download',
        addedBy: String(f.addedBy || ''), addedAt: String(f.addedAt || '') });
    }
    return out;
  }

  function sig() { return S.state + '|' + (S.partial ? 1 : 0) + '|' + S.files.map(function (f) { return f.key; }).join(','); }
  function land(next) {
    S = next; paint();
    /* An open pop-up is drawn again only when the list really changed (a message under a file stays), and never under a file that is being opened. */
    if (dlg && dlg.isOpen() && !opening && sig() !== drawn) draw();
  }

  /* quiet = a re-check behind an open pop-up: the list stays as it is until the new one arrives, and a failed re-check changes nothing. */
  function load(quiet) {
    var key = theKey(); if (!key) return;
    var my = ++seq;
    if (!quiet) { S = { state: 'loading', files: [], partial: false }; paint(); }
    function failed() { if (my === seq && !quiet) land({ state: 'unchecked', files: [], partial: false }); }
    fetch(base, { headers: { 'X-Api-Key': key }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { signIn(); return null; }
        return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; }, function () { return { ok: false, j: {} }; });
      })
      .then(function (res) {
        if (!res || my !== seq) return;
        if (res.ok && res.j.state === 'ok' && Array.isArray(res.j.files)) land({ state: 'ok', files: tidy(res.j.files), partial: res.j.partial === true });
        else failed();
      })
      .catch(failed);
  }

  /* ── the pop-up ── */
  function say(el, kind, text) {
    if (!text) { el.textContent = ''; el.hidden = true; el.removeAttribute('role'); el.className = 'lf-msg'; return; }
    el.className = 'lf-msg' + (kind === 'alert' ? ' err' : '');
    el.setAttribute('role', kind);
    el.hidden = false;
    el.textContent = text;
  }

  function openFile(f, btn, msg) {
    if (btn.disabled) return;   /* one opening at a time per file */
    var key = theKey(); if (!key) return;
    var tab = f.view === 'tab', idle = btn.textContent, w = null;
    /* The tab is opened NOW, inside the click — after the wait for the file a browser would block it. */
    if (tab) { try { w = window.open('', '_blank'); } catch (e) { w = null; } }
    if (w) {
      try { w.opener = null; } catch (e) {}
      try { w.document.title = 'Opening…'; w.document.body.textContent = 'Opening the file…'; } catch (e) {}
    }
    function shut() { if (w) { try { w.close(); } catch (e) {} } w = null; }
    var over = false;
    function done() { if (over) return; over = true; opening = Math.max(0, opening - 1); btn.disabled = false; btn.textContent = idle; }
    function refuse(text) { var e = new Error(text); e.forStaff = true; return e; }
    opening++; btn.disabled = true; btn.textContent = tab ? 'Opening…' : 'Downloading…';
    say(msg, '', '');
    fetch(base + '/' + encodeURIComponent(f.key), { headers: { 'X-Api-Key': key }, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { var s = new Error('sign in'); s.signIn = true; throw s; }
        if (!r.ok) {
          return r.json().then(function (j) { return j; }, function () { return null; })
            .then(function (j) { throw refuse((j && j.error) || ('Could not open the file (error ' + r.status + ') — try again.')); });
        }
        var saveAs = tdotLfSaveName(r.headers && r.headers.get ? r.headers.get('Content-Disposition') : '', f);
        return r.blob().then(function (b) { return { blob: b, saveAs: saveAs }; });
      })
      .then(function (got) {
        var url = URL.createObjectURL(new Blob([got.blob], { type: TYPES[f.ext] || 'application/octet-stream' }));
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 120000);
        var shown = false;
        if (tab && w && !w.closed) { try { w.location.href = url; shown = true; } catch (e) { shown = false; } }
        if (!shown) {
          shut();
          var a = document.createElement('a');
          a.href = url; a.download = got.saveAs; a.rel = 'noopener'; a.style.display = 'none';
          document.body.appendChild(a); a.click();
          setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 2000);
          if (tab) say(msg, 'status', 'The file could not be shown in a new tab, so it was saved to your computer instead — look in your downloads.');
        }
        done();
      })
      .catch(function (e) {
        shut(); done();
        if (e && e.signIn) { signIn(); return; }
        say(msg, 'alert', (e && e.forStaff && e.message) || 'Could not reach the server — try again.');
      });
  }

  function item(f) {
    var li = mk('li', 'lf-item'), row = mk('div', 'lf-row'), main = mk('div', 'lf-main'), meta = tdotLfMeta(f);
    var pic = mk('span', 'lf-ico'); pic.setAttribute('aria-hidden', 'true'); pic.innerHTML = icons.file || '';
    main.appendChild(mk('div', 'lf-name', f.label));
    if (meta) main.appendChild(mk('div', 'lf-meta', meta));
    var save = f.view !== 'tab';
    var b = mk('button', 'tdlg-btn lf-open', save ? 'Download' : 'Open');
    b.type = 'button';
    b.setAttribute('aria-label', (save ? 'Download ' : 'Open ') + f.label);
    b.title = save ? 'This kind of file does not open in the browser — it is saved to your computer.' : 'Opens in a new tab';
    var msg = mk('div', 'lf-msg'); msg.hidden = true;
    b.onclick = function () { openFile(f, b, msg); };
    row.appendChild(pic); row.appendChild(main); row.appendChild(b);
    li.appendChild(row); li.appendChild(msg);
    return li;
  }
  function group(title, files) {
    if (!files.length) return;
    listEl.appendChild(mk('h4', 'lf-group-t', title));
    var ul = mk('ul', 'lf-group'), i;
    for (i = 0; i < files.length; i++) ul.appendChild(item(files[i]));
    listEl.appendChild(ul);
  }
  function draw() {
    if (!listEl) return;
    drawn = sig();
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (S.state !== 'ok') { listEl.appendChild(mk('div', 'lf-empty', 'The files could not be checked just now — close this box and click Attachments again.')); return; }
    if (S.partial) {
      var note = mk('div', 'lf-note', 'There may be more files than these: the client’s case folder could not be checked just now. Close this box and open Attachments again in a minute.');
      note.setAttribute('role', 'status'); listEl.appendChild(note);
    }
    if (!S.files.length) { listEl.appendChild(mk('div', 'lf-empty', 'No files on this lead.')); return; }
    group('From the client’s form', S.files.filter(function (f) { return f.kind === 'client'; }));
    group('Added by staff', S.files.filter(function (f) { return f.kind !== 'client'; }));
  }

  function open() {
    if (typeof tdotDialogNew !== 'function') return false;
    if (dlg && dlg.isOpen()) return true;
    var c = tdotDialogNew({ cls: 'lf-dlg', ovClass: 'lf-ov', labelledBy: 'lf-title', group: 'lf',
      onClosed: function () { if (dlg === c) { dlg = null; listEl = null; } } });
    dlg = c;
    var h = mk('h3', '', 'Attachments'); h.id = 'lf-title';
    var who = ''; try { who = String((typeof o.name === 'function' ? o.name() : '') || '').trim(); } catch (e) { who = ''; }
    var acts = mk('div', 'tdlg-actions'), close = mk('button', 'tdlg-btn', 'Close');
    close.type = 'button'; close.setAttribute('data-x', '1'); close.onclick = function () { c.tryClose('cancel'); };
    acts.appendChild(close);
    listEl = mk('div', 'lf-list');
    c.box.appendChild(h);
    c.box.appendChild(mk('div', 'lf-who', who ? 'Files for ' + who : 'Files on this lead'));
    c.box.appendChild(listEl);
    c.box.appendChild(acts);
    draw();
    load(true);   /* opening the box looks again: a file added or removed since the page loaded shows up */
    return true;
  }

  chip.addEventListener('click', function () {
    if (S.state === 'loading') return;                 /* still checking */
    if (S.state === 'unchecked') { load(); return; }   /* "could not check": the click tries again */
    if (!S.files.length) return;
    open();
  });

  paint();
  return {
    chip: chip,
    /* What render() writes where the button belongs (hidden: it takes no room until the button replaces it). */
    slotHtml: '<span id="c-att-slot" hidden></span>',
    /* After the chip row was rebuilt: put the button back where the slot marker is. focus = it had the keyboard focus before the rebuild. */
    place: function (focus) {
      var slot = document.getElementById('c-att-slot');
      if (!slot || !slot.parentNode) return false;
      slot.parentNode.replaceChild(chip, slot);
      if (focus) { try { chip.focus(); } catch (e) {} }
      return true;
    },
    /* The first look — once, however many times the page loads the lead again. */
    start: function () { if (started) return; started = true; load(); },
    /* Look again and show it (after a staff member attached a file). */
    reload: function () { started = true; load(); },
    open: open,
    state: function () { return S; }
  };
}

const NL = '\n';
const LEAD_FILES_FUNCTIONS = [tdotLfSize, tdotLfMeta, tdotLfSaveName, tdotLeadFiles];
const LEAD_FILES_UI_JS = '/* ── "Attachments" on the lead page (leadFilesUi.js) ── */' + NL
  + LEAD_FILES_FUNCTIONS.map(function (f) { return f.toString(); }).join(NL) + NL;

module.exports = { LEAD_FILES_CSS, LEAD_FILES_UI_JS, PAPERCLIP_PATH, tdotLfSize, tdotLfMeta, tdotLfSaveName, tdotLeadFiles };
