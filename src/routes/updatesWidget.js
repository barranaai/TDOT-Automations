/**
 * Updates widget — the Monday "Updates" thread, embedded in the platform's
 * detail pages (staff request 2026-08-19). One shared implementation:
 *
 *   UPDATES_WIDGET_CSS            — styles (namespaced .updw-*)
 *   updatesWidgetHtml(prefix)     — the card body markup
 *   UPDATES_WIDGET_JS             — defines window.tdotUpdatesMount(opts)
 *
 * All thread content is rendered via textContent (never innerHTML), so Monday
 * update bodies can't inject markup. NOTE for maintainers: these strings are
 * interpolated into page template literals as VALUES — escapes here are safe —
 * but keep the widget JS free of backslash escapes anyway (house rule after
 * the emitted-JS regex incident, see test/inlineScripts.test.js).
 */

'use strict';

const UPDATES_WIDGET_CSS = [
  '.updw-list { display:flex; flex-direction:column; gap:10px; max-height:520px; overflow-y:auto; padding-right:4px; }',
  '.updw-item { border:1px solid #eef2f7; border-radius:10px; padding:10px 12px; background:#fbfcfe; }',
  '.updw-head { display:flex; align-items:center; gap:8px; font-size:11.5px; color:#64748b; margin-bottom:5px; }',
  '.updw-by { font-weight:700; color:#1e293b; }',
  '.updw-origin { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:1px 7px; border-radius:99px; background:#eef2ff; color:#4338ca; }',
  '.updw-origin.updw-lead { background:#fef9c3; color:#854d0e; }',
  '.updw-body { font-size:13px; color:#1f2937; white-space:pre-wrap; word-break:break-word; line-height:1.5; }',
  '.updw-reply { margin:8px 0 0 16px; border-left:2px solid #e2e8f0; padding-left:10px; }',
  '.updw-empty { color:#94a3b8; font-size:13px; padding:8px 2px; }',
  '.updw-compose { margin-top:12px; border-top:1px solid #f1f5f9; padding-top:12px; }',
  '.updw-compose textarea { width:100%; min-height:64px; border:1px solid #e2e8f0; border-radius:8px; padding:8px 10px; font:inherit; box-sizing:border-box; resize:vertical; }',
  '.updw-row { display:flex; gap:8px; align-items:center; margin-top:8px; }',
  '.updw-row input { flex:0 0 170px; border:1px solid #e2e8f0; border-radius:8px; padding:7px 10px; font:inherit; font-size:12.5px; }',
  '.updw-msg { font-size:12px; margin-left:auto; }',
  '.updw-otter { display:flex; align-items:center; gap:7px; font-size:12.5px; font-weight:600; color:#334155; margin:0 0 6px; cursor:pointer; }',
  '.updw-otter input { margin:0; flex:none; }',
  '.updw-otter span { font-weight:400; color:#64748b; }',
  '.updw-compose.otter textarea { min-height:180px; }',
].join('\n');

// opts.otter (the consultation record page, step 2 2026-11-09): a "Consultation summary (Otter)"
// tick — the post gets that header and may run to MAX_OTTER characters (updatesService checks
// the same); without the tick the normal MAX_UPDATE cap stays.
const MAX_UPDATE = 4000;
const MAX_OTTER = 20000;

function updatesWidgetHtml(prefix, opts = {}) {
  const p = String(prefix || 'updw');
  return [
    `<div id="${p}-list" class="updw-list"><div class="updw-empty">Loading updates…</div></div>`,
    `<div class="updw-compose" id="${p}-compose">`,
    opts.otter ? `<label class="updw-otter"><input type="checkbox" id="${p}-otter"> Consultation summary (Otter) <span>— paste the whole summary, up to ${MAX_OTTER.toLocaleString('en-CA')} characters</span></label>` : '',
    // With the Otter tick the box takes MAX_OTTER from the start (review round 1): a summary pasted
    // BEFORE ticking is never cut by the browser. Unticked posts over MAX_UPDATE are refused by the
    // page check below (it tells staff to tick), never silently shortened.
    `<textarea id="${p}-text" maxlength="${opts.otter ? MAX_OTTER : MAX_UPDATE}" placeholder="Write an update… (posts to this item's Monday thread)"></textarea>`,
    `<div class="updw-row">`,
    `<input id="${p}-name" type="text" maxlength="60" placeholder="Your name" title="Shown as [Name] on the update — the API posts as the integration account">`,
    `<button class="btn primary" id="${p}-post" type="button">Post update</button>`,
    `<span id="${p}-msg" class="updw-msg"></span>`,
    `</div></div>`,
  ].join('');
}

const UPDATES_WIDGET_JS = [
  'function tdotUpdatesMount(opts){',
  '  var p = opts.prefix || "updw";',
  '  var el = function(id){ return document.getElementById(p + "-" + id); };',
  '  if (!el("list")) return;',
  '  var postTarget = opts.itemId || "";',
  '  var NAME_KEY = "tdot_staff_name";',
  '  try { var savedName = localStorage.getItem(NAME_KEY); if (savedName && el("name")) el("name").value = savedName; } catch (e) {}',
  '',
  '  function fmtAt(at){ return String(at || "").slice(0, 16).split("T").join(" "); }',
  '  function renderOne(u, mixed){',
  '    var item = document.createElement("div"); item.className = "updw-item";',
  '    var head = document.createElement("div"); head.className = "updw-head";',
  '    var by = document.createElement("span"); by.className = "updw-by"; by.textContent = u.by || "System";',
  '    head.appendChild(by);',
  '    if (mixed && u.origin) {',
  '      var badge = document.createElement("span");',
  '      badge.className = "updw-origin" + (u.origin === "lead" ? " updw-lead" : "");',
  '      badge.textContent = u.origin === "lead" ? "Lead" : "Case";',
  '      head.appendChild(badge);',
  '    }',
  '    var at = document.createElement("span"); at.textContent = fmtAt(u.at); head.appendChild(at);',
  '    item.appendChild(head);',
  '    var body = document.createElement("div"); body.className = "updw-body"; body.textContent = u.body;',
  '    item.appendChild(body);',
  '    var reps = u.replies || [];',
  '    for (var ri = 0; ri < reps.length; ri++) {',
  '      var r = reps[ri];',
  '      var rd = document.createElement("div"); rd.className = "updw-reply";',
  '      var rh = document.createElement("div"); rh.className = "updw-head";',
  '      var rby = document.createElement("span"); rby.className = "updw-by"; rby.textContent = r.by || "System"; rh.appendChild(rby);',
  '      var rat = document.createElement("span"); rat.textContent = fmtAt(r.at); rh.appendChild(rat);',
  '      rd.appendChild(rh);',
  '      var rb = document.createElement("div"); rb.className = "updw-body"; rb.textContent = r.body; rd.appendChild(rb);',
  '      item.appendChild(rd);',
  '    }',
  '    return item;',
  '  }',
  '',
  '  function render(updates){',
  '    var list = el("list"); list.innerHTML = "";',
  '    if (!updates.length) {',
  '      var e = document.createElement("div"); e.className = "updw-empty";',
  '      e.textContent = "No updates yet — the thread starts with the first note."; list.appendChild(e); return;',
  '    }',
  '    var mixed = false;',
  '    for (var i = 1; i < updates.length; i++) { if (updates[i].origin !== updates[0].origin) { mixed = true; break; } }',
  '    for (var j = 0; j < updates.length; j++) list.appendChild(renderOne(updates[j], mixed));',
  '  }',
  '',
  '  function load(){',
  '    var key = (typeof peekKey === "function") ? peekKey() : getKey();',
  '    if (!key) { el("list").innerHTML = ""; var nk = document.createElement("div"); nk.className = "updw-empty"; nk.textContent = "Updates need the admin key (enter it on the sign-in page)."; el("list").appendChild(nk); return; }',
  '    fetch(opts.threadUrl, { headers: { "X-Api-Key": key } })',
  '      .then(function(r){ return r.json(); })',
  '      .then(function(j){',
  '        if (j.error) { el("list").innerHTML = ""; var e = document.createElement("div"); e.className = "updw-empty"; e.textContent = j.error; el("list").appendChild(e); return; }',
  '        if (!postTarget && j.cmItemId) postTarget = j.cmItemId;',
  '        render(j.updates || []);',
  '      })',
  '      .catch(function(){ el("list").innerHTML = ""; var e = document.createElement("div"); e.className = "updw-empty"; e.textContent = "Could not load updates — refresh to retry."; el("list").appendChild(e); });',
  '  }',
  '',
  '  /* The Otter tick (when the page has it): a longer box and a longer cap, and the post says what it is. */',
  '  var otterEl = el("otter");',
  '  function syncOtter(){',
  '    if (!otterEl) return;',
  '    var on = otterEl.checked, ta = el("text");',
  '    ta.maxLength = ' + MAX_OTTER + ';   /* never shrinks back: unticking must not cut what is already typed */',
  '    ta.placeholder = on ? "Paste the Otter summary of the consultation (it is posted in full, with a Consultation summary heading)" : "Write an update… (posts to this item' + "'" + 's Monday thread)";',
  '    if (el("compose")) el("compose").classList.toggle("otter", on);',
  '  }',
  '  if (otterEl) otterEl.onchange = syncOtter;',
  '',
  '  var postBtn = el("post");',
  '  if (postBtn) postBtn.onclick = function(){',
  '    var text = (el("text").value || "").trim();',
  '    var name = (el("name").value || "").trim();',
  '    var msg = el("msg");',
  '    if (!text) { msg.textContent = "Write something first."; msg.style.color = "#c0392b"; return; }',
  '    var otter = !!(otterEl && otterEl.checked);',
  '    if (!otter && text.length > ' + MAX_UPDATE + ') { msg.textContent = "Updates are limited to ' + MAX_UPDATE + ' characters" + (otterEl ? " — tick Consultation summary (Otter) for a longer summary." : "."); msg.style.color = "#c0392b"; return; }',
  '    if (!name) { msg.textContent = "Add your name so the team knows who posted."; msg.style.color = "#c0392b"; el("name").focus(); return; }',
  '    if (!postTarget) { msg.textContent = "No Monday item to post to."; msg.style.color = "#c0392b"; return; }',
  '    try { localStorage.setItem(NAME_KEY, name); } catch (e) {}',
  '    var key = (typeof peekKey === "function") ? peekKey() : getKey();',
  '    if (!key) { msg.textContent = "Posting needs the admin key (enter it on the sign-in page)."; msg.style.color = "#c0392b"; return; }',
  '    postBtn.disabled = true; msg.textContent = "Posting…"; msg.style.color = "#64748b";',
  '    fetch("/api/updates/" + encodeURIComponent(postTarget), {',
  '      method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" },',
  '      body: JSON.stringify(otter ? { body: text, staffName: name, kind: "otter" } : { body: text, staffName: name }),',
  '    })',
  '      .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })',
  '      .then(function(res){',
  '        if (res.s >= 400) { msg.textContent = res.j.error || ("HTTP " + res.s); msg.style.color = "#c0392b"; return; }',
  '        el("text").value = ""; msg.textContent = otter ? "Consultation summary posted." : "Posted."; msg.style.color = "#16a34a";',
  '        if (otterEl) { otterEl.checked = false; syncOtter(); }',
  '        load();',
  '      })',
  '      .catch(function(){ msg.textContent = "Network error — not posted."; msg.style.color = "#c0392b"; })',
  '      .finally(function(){ postBtn.disabled = false; });',
  '  };',
  '',
  '  load();',
  '  window["tdotUpdatesReload_" + p] = load;   // other widgets on the page (remarks) refresh the thread after posting',
  '}',
].join('\n');

module.exports = { UPDATES_WIDGET_CSS, updatesWidgetHtml, UPDATES_WIDGET_JS, MAX_UPDATE, MAX_OTTER };
