/**
 * Lead "Outcome & remarks" widget (consultant note #8, 2026-09-03).
 *
 * Shared by the lead page (/admin/lead/:id) and the consultation view
 * (/admin/consultation/:id): one-click remark presets + optional details +
 * the poster's name. Every post lands as an Update on the lead's Monday row
 * (POST /api/consultation/:leadId/action { action:'remark' }) so the whole
 * team sees what was done; the page's Updates thread refreshes right after.
 *
 * Client JS is a plain-string array (no template literal — see the
 * inline-script trap): it needs LEAD_ID, getKey() and the mount opts.
 */

const REMARKS_CSS = `
  .rmk-chips { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0 8px; }
  .rmk-chip { padding:7px 10px; border:1px solid var(--border, #e2e8f0); border-radius:999px; background:white; font-size:12px; font-weight:600; color:var(--navy, #1e3a5f); cursor:pointer; font-family:inherit; transition:all .12s; }
  .rmk-chip:hover:not(:disabled) { border-color:var(--navy, #1e3a5f); background:#f0f4f8; }
  .rmk-chip:disabled { opacity:.55; cursor:default; }
  .rmk-text { width:100%; min-height:64px; padding:8px 10px; border:1px solid var(--border, #e2e8f0); border-radius:8px; font:inherit; font-size:12.5px; resize:vertical; box-sizing:border-box; }
  .rmk-row { display:flex; gap:8px; align-items:center; margin-top:6px; flex-wrap:wrap; }
  .rmk-row input { flex:1 1 140px; min-width:120px; padding:7px 9px; border:1px solid var(--border, #e2e8f0); border-radius:8px; font:inherit; font-size:12.5px; }
  .rmk-msg { font-size:12px; margin-top:6px; min-height:16px; }
  .rmk-help { font-size:11.5px; color:#64748b; margin:2px 0 6px; }
`;

function remarksHtml(prefix) {
  const p = String(prefix || 'rmk');
  return [
    `<div class="rmk-help">One click posts to the lead’s Monday updates so the team sees what was done. Add details below first if you want them included. <b id="${p}-as"></b></div>`,
    `<div class="rmk-chips" id="${p}-chips"></div>`,
    `<textarea id="${p}-text" class="rmk-text" maxlength="2000" placeholder="Details (optional) — what was discussed, what happens next…"></textarea>`,
    `<div class="rmk-row">`,
    `<input id="${p}-name" type="text" maxlength="60" placeholder="Your name" title="Shown on the update so the team knows who did it">`,
    `<button class="btn" id="${p}-post" type="button">Post remark</button>`,
    `</div>`,
    `<div id="${p}-msg" class="rmk-msg"></div>`,
  ].join('');
}

const REMARKS_JS = [
  'function tdotRemarksMount(opts){',
  '  var p = opts.prefix || "rmk";',
  '  var el = function(id){ return document.getElementById(p + "-" + id); };',
  '  if (!el("chips")) return;',
  '  var NAME_KEY = "tdot_staff_name";',
  '  try { var saved = localStorage.getItem(NAME_KEY); if (saved && el("name")) el("name").value = saved; } catch (e) {}',
  '  function msg(t, cls){ var m = el("msg"); if (!m) return; m.textContent = t; m.style.color = cls === "err" ? "#c0392b" : cls === "ok" ? "#16a34a" : "#64748b"; }',
  '  var other = document.getElementById((opts.updatesPrefix || "updw") + "-name");   // the Updates box on the same page',
  '  function name(){ return ((el("name") && el("name").value) || (other && other.value) || "").trim(); }',
  '  function refreshAs(){ var a = el("as"); if (a) a.textContent = name() ? "Posting as " + name() + "." : "Add your name below first."; }',
  '  if (el("name")) el("name").addEventListener("input", function(){ if (other && other.value !== el("name").value) other.value = el("name").value; refreshAs(); });',
  '  if (other) other.addEventListener("input", function(){ if (el("name") && el("name").value !== other.value) el("name").value = other.value; refreshAs(); });',
  '  refreshAs();',
  '  function setBusy(b){ Array.prototype.forEach.call(document.querySelectorAll("#" + p + "-chips .rmk-chip"), function(c){ c.disabled = b; }); if (el("post")) el("post").disabled = b; }',
  '  function post(presetKey){',
  '    var text = (el("text") && el("text").value || "").trim();',
  '    if (!presetKey && !text) { msg("Pick a remark or write one.", "err"); return; }',
  '    if (!name()) { msg("Add your name so the team knows who did this.", "err"); if (el("name")) el("name").focus(); return; }',
  '    try { localStorage.setItem(NAME_KEY, name()); } catch (e) {}',
  '    if (el("name") && !el("name").value) el("name").value = name();',
  '    var key = (typeof getKey === "function") ? getKey() : ""; if (!key) return;',
  '    setBusy(true); msg("Posting…");',
  '    fetch("/api/consultation/" + encodeURIComponent(opts.leadId) + "/action", {',
  '      method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" },',
  '      body: JSON.stringify({ action: "remark", value: { preset: presetKey || "", text: text }, staffName: name() })',
  '    })',
  '      .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })',
  '      .then(function(res){',
  '        if (res.s === 401 || res.s === 403) { window.location.href = "/admin"; return; }',
  '        if (res.s >= 400) { msg(res.j.error || ("HTTP " + res.s), "err"); return; }',
  '        if (el("text")) el("text").value = "";',
  '        msg(res.j.message || "Posted.", "ok");',
  '        var reload = window["tdotUpdatesReload_" + (opts.updatesPrefix || "updw")]; if (typeof reload === "function") reload();',
  '      })',
  '      .catch(function(){ msg("Network error — not posted.", "err"); })',
  '      .finally(function(){ setBusy(false); });',
  '  }',
  '  (opts.presets || []).forEach(function(r){',
  '    var b = document.createElement("button"); b.type = "button"; b.className = "rmk-chip"; b.textContent = r.label; if (r.hint) b.title = r.hint;',
  '    b.onclick = function(){ post(r.key); };',
  '    el("chips").appendChild(b);',
  '  });',
  '  if (el("post")) el("post").onclick = function(){ post(""); };',
  '  window["tdotRemarksName_" + p] = name;   // lets the outcome buttons send the same name',
  '}',
].join('\n');

module.exports = { REMARKS_CSS, remarksHtml, REMARKS_JS };
