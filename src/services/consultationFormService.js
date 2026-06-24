/**
 * consultationFormService — a STANDALONE public consultation form (intake +
 * pre-consult fields, de-duplicated), independent of the lead/intake pipeline.
 * Renders the form, validates + maps submissions to a dedicated Monday board
 * (src/data/consultationBoard.json), and emails the submitter a confirmation.
 *
 * Config-driven: every field/section/condition comes from
 * config/consultationFormFields.js (the single source of truth shared with the
 * board-creation script), so the form and the board can never drift.
 */

'use strict';

const { BRAND, TDOT_LOGO_LIGHT_HTML_LARGE } = require('../branding');
const { SECTION_ORDER, SERVICE_GROUPS, FBLOCK_SERVICES, FIELDS, GROUPS } = require('../../config/consultationFormFields');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const FIELDS_BY_SECTION = {};
for (const f of FIELDS) (FIELDS_BY_SECTION[f.section] = FIELDS_BY_SECTION[f.section] || []).push(f);
const GROUP_BY_SECTION = {};
for (const g of GROUPS) GROUP_BY_SECTION[g.section] = g;

// ─── Field rendering ──────────────────────────────────────────────────────────

function inputControl(f, nameOverride) {
  const name = nameOverride || f.key;
  const req = f.required ? ' data-req="1"' : '';
  switch (f.type) {
    case 'textarea':
      return `<textarea name="${name}" rows="3"${req} placeholder="${esc(f.placeholder || '')}"></textarea>`;
    case 'dropdown': {
      let opts = `<option value="">Choose…</option>`;
      if (f.key === 'serviceRequired') {
        for (const [grp, list] of Object.entries(SERVICE_GROUPS)) {
          opts += `<optgroup label="${esc(grp)}">${list.map((o) => `<option>${esc(o)}</option>`).join('')}</optgroup>`;
        }
      } else {
        opts += f.options.map((o) => `<option>${esc(o)}</option>`).join('');
      }
      return `<select name="${name}"${req}>${opts}</select>`;
    }
    case 'radio':
      return `<div class="radios">${f.options.map((o) =>
        `<label class="radio"><input type="radio" name="${name}" value="${esc(o)}"${req}><span>${esc(o)}</span></label>`).join('')}</div>`;
    case 'number':
      return `<input type="number" name="${name}" min="0"${req}>`;
    case 'date':
      return `<input type="date" name="${name}"${req}>`;
    case 'email':
      return `<input type="email" name="${name}"${req}>`;
    case 'phone':
      return `<input type="tel" name="${name}"${req} placeholder="+1 …">`;
    default:
      return `<input type="text" name="${name}"${req}>`;
  }
}

function fieldHtml(f) {
  const showIf = f.showIf ? ` data-showif='${esc(JSON.stringify(f.showIf))}'` : '';
  if (f.type === 'checkbox') {
    return `<div class="field field-wide field-check" data-field="${f.key}"${showIf}>
      <label class="check"><input type="checkbox" name="${f.key}" value="Yes" data-req="1"><span>${esc(f.label)}</span></label></div>`;
  }
  const wide = (f.type === 'textarea' || f.type === 'radio' || f.label.length > 60) ? ' field-wide' : '';
  const star = f.required ? '<span class="req">*</span>' : '';
  return `<div class="field${wide}" data-field="${f.key}"${showIf}>
      <label>${esc(f.label)} ${star}</label>${inputControl(f)}</div>`;
}

function groupRowHtml(g, idx) {
  const cells = g.sub.map((s) => {
    const ff = { ...s, key: `${g.group}[${idx}][${s.key}]`, required: false };
    const wide = (s.type === 'textarea') ? ' field-wide' : '';
    return `<div class="field${wide}"><label>${esc(s.label)}</label>${inputControl(ff, `${g.group}[${idx}][${s.key}]`)}</div>`;
  }).join('');
  return `<div class="grp-row"><div class="grid">${cells}</div>
      <button type="button" class="rm-row" onclick="rmGrpRow(this)">Remove</button></div>`;
}

function groupHtml(g, showIf) {
  const si = showIf ? ` data-showif='${esc(JSON.stringify(showIf))}'` : '';
  const label = g.group === 'education' ? 'Education history (add each qualification)' : 'Work experience (add each job)';
  return `<div class="grp" data-group="${g.group}"${si}>
      <div class="grp-h">${esc(label)}</div>
      <div class="grp-rows" id="grp-${g.group}">${groupRowHtml(g, 0)}</div>
      <button type="button" class="add-row" onclick="addGrpRow('${g.group}')">+ Add another</button>
      <template id="tpl-${g.group}">${groupRowHtml(g, '__I__')}</template></div>`;
}

const SECTION_ICONS = {
  'Personal & Contact': '👤', 'Family': '👨‍👩‍👧', 'Immigration Status': '🛂', 'Education': '🎓',
  'Employment': '💼', 'Language': '🗣️', 'Your Relationship With TDOT': '🤝', 'Service Needed': '🧭',
  'Service-Specific Questions': '📋', 'Urgency': '⏰', 'Final Notes': '📝', 'How You Found Us & Consent': '✅',
};
const SECTION_HINTS = {
  'Personal & Contact': 'Who you are and how to reach you.',
  'Family': 'Your spouse or partner and any dependants.',
  'Immigration Status': 'Your current status and any deadlines.',
  'Education': 'Your qualifications after Grade 10.',
  'Employment': 'Your skilled work experience.',
  'Language': 'English / French test results, if you have them.',
  'Your Relationship With TDOT': 'Are you a new or returning client?',
  'Service Needed': "What you'd like help with.",
  'Service-Specific Questions': 'A few questions specific to your selected service.',
  'Urgency': 'Any time-sensitive deadlines or issues.',
  'Final Notes': "Anything else you'd like us to know.",
  'How You Found Us & Consent': 'Almost done — a few quick confirmations.',
};

function sectionHtml(section, num) {
  const fields = FIELDS_BY_SECTION[section] || [];
  let body;
  if (section === 'Service-Specific Questions') {
    const byBlock = {};
    for (const f of fields) (byBlock[f.block] = byBlock[f.block] || []).push(f);
    body = Object.keys(byBlock).map((b) =>
      `<div class="fblock" data-block="${b}" data-services='${esc(JSON.stringify(FBLOCK_SERVICES[b] || []))}'>
        <div class="grid">${byBlock[b].map(fieldHtml).join('')}</div></div>`).join('');
  } else {
    const inner = `<div class="grid">${fields.map(fieldHtml).join('')}</div>`;
    const g = GROUP_BY_SECTION[section];
    const grp = g ? groupHtml(g, g.group === 'employment' ? { field: 'hasTeerExperience', in: ['Yes'] } : null) : '';
    body = inner + grp;
  }
  const hint = SECTION_HINTS[section] ? `<p class="sec-sub">${esc(SECTION_HINTS[section])}</p>` : '';
  return `<div class="step" data-step="${num - 1}" data-name="${esc(section)}"${num > 1 ? ' hidden' : ''}>
    <section class="card">
      <div class="sec-head"><span class="sec-ico">${SECTION_ICONS[section] || '•'}</span>
        <div><h2>${esc(section)}</h2>${hint}</div></div>
      ${body}
    </section></div>`;
}

// ─── The full page ──────────────────────────────────────────────────────────

function buildFormHtml() {
  const sections = SECTION_ORDER.map((s, i) => sectionHtml(s, i + 1)).join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TDOT Immigration — Consultation Form</title>
<style>
  :root{ --primary:${BRAND.primary}; --navy:${BRAND.darkPanel}; --bg:${BRAND.lightBg}; --card:${BRAND.lightCard};
    --border:${BRAND.border}; --text:${BRAND.textOnLight}; --muted:${BRAND.mutedOnLight}; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); }
  /* Hero */
  .hero{ background:linear-gradient(160deg,#0e2440 0%,var(--navy) 70%); color:#fff; padding:34px 24px 28px; text-align:center; }
  .hero .logo{ display:inline-block; margin-bottom:14px; }
  .hero h1{ margin:0; font-size:28px; font-weight:800; letter-spacing:-.6px; }
  .hero p{ margin:9px auto 0; max-width:600px; font-size:14px; color:#cbd5e1; line-height:1.6; }
  .hero .meta{ margin-top:14px; display:flex; gap:18px; justify-content:center; flex-wrap:wrap; font-size:12.5px; color:#9fb3cc; }
  .hero .meta span{ display:inline-flex; align-items:center; gap:6px; }
  /* Sticky progress */
  .pbar-wrap{ position:sticky; top:0; z-index:20; background:rgba(250,248,244,.92); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border); padding:12px 22px; }
  .pbar-inner{ max-width:1080px; margin:0 auto; }
  .pbar-meta{ display:flex; justify-content:space-between; align-items:center; font-size:12px; font-weight:700;
    color:var(--navy); margin-bottom:8px; letter-spacing:.2px; }
  .pbar-meta .pct{ color:var(--primary); }
  .pbar{ height:7px; background:#e9e3d6; border-radius:99px; overflow:hidden; }
  .pfill{ height:100%; width:8%; background:linear-gradient(90deg,var(--primary),#b33); border-radius:99px; transition:width .4s cubic-bezier(.4,0,.2,1); }
  /* Layout */
  .wrap{ max-width:1080px; margin:0 auto; padding:26px 22px 48px; }
  .step{ } .step.anim{ animation:fade .32s ease; }
  @keyframes fade{ from{ opacity:0; transform:translateY(8px); } to{ opacity:1; transform:none; } }
  .card{ background:var(--card); border:1px solid var(--border); border-radius:18px; padding:26px 28px;
    box-shadow:0 4px 22px rgba(15,29,50,.06); }
  .sec-head{ display:flex; align-items:center; gap:14px; margin-bottom:20px; padding-bottom:16px; border-bottom:1px solid var(--border); }
  .sec-ico{ width:44px; height:44px; border-radius:13px; background:#fff5f5; display:inline-flex; align-items:center;
    justify-content:center; font-size:22px; flex-shrink:0; border:1px solid #f3dada; }
  .sec-head h2{ margin:0; font-size:19px; font-weight:800; color:var(--navy); letter-spacing:-.3px; }
  .sec-sub{ margin:2px 0 0; font-size:13px; color:var(--muted); }
  .grid{ display:grid; grid-template-columns:1fr 1fr; gap:18px 22px; }
  @media(max-width:680px){ .grid{ grid-template-columns:1fr; } }
  .field{ display:flex; flex-direction:column; gap:7px; }
  .field-wide{ grid-column:1 / -1; }
  .field label{ font-size:13px; font-weight:600; color:var(--text); }
  .req{ color:var(--primary); font-weight:700; }
  .field input, .field select, .field textarea{ width:100%; padding:12px 14px; border:1px solid var(--border);
    border-radius:11px; font-size:14.5px; font-family:inherit; background:#fff; color:var(--text); transition:border .15s,box-shadow .15s; }
  .field input:hover, .field select:hover, .field textarea:hover{ border-color:#cbd2c0; }
  .field input:focus, .field select:focus, .field textarea:focus{ outline:none; border-color:var(--navy);
    box-shadow:0 0 0 3px rgba(11,29,50,.09); }
  .field textarea{ resize:vertical; min-height:80px; }
  .radios{ display:flex; flex-wrap:wrap; gap:9px; }
  .radio{ display:inline-flex; align-items:center; gap:8px; padding:10px 16px; border:1px solid var(--border);
    border-radius:11px; font-size:13.5px; cursor:pointer; background:#fff; transition:.15s; user-select:none; }
  .radio:hover{ border-color:var(--navy); background:#f8fafc; }
  .radio input{ accent-color:var(--primary); margin:0; }
  .radio:has(input:checked){ border-color:var(--primary); background:#fff5f5; font-weight:600; box-shadow:0 0 0 2px rgba(139,0,0,.08); }
  .check{ display:flex; align-items:flex-start; gap:11px; font-size:13.5px; line-height:1.55; cursor:pointer;
    padding:12px 14px; border:1px solid var(--border); border-radius:11px; background:#fff; transition:.15s; }
  .check:hover{ border-color:var(--navy); }
  .check:has(input:checked){ border-color:var(--primary); background:#fff5f5; }
  .check input{ margin-top:2px; accent-color:var(--primary); width:18px; height:18px; flex-shrink:0; }
  .grp{ grid-column:1/-1; margin-top:4px; }
  .grp-h{ font-size:13px; font-weight:700; color:var(--navy); margin-bottom:11px; }
  .grp-row{ border:1px dashed var(--border); border-radius:13px; padding:18px; margin-bottom:13px; background:#fcfbf8; }
  .add-row{ background:#fff; border:1px solid var(--navy); color:var(--navy); padding:10px 17px; border-radius:10px;
    font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; transition:.15s; }
  .add-row:hover{ background:#f0f4f8; }
  .rm-row{ background:none; border:none; color:var(--primary); font-size:12px; cursor:pointer; margin-top:8px; font-family:inherit; padding:0; }
  /* Wizard nav */
  .err-banner{ display:none; background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; padding:13px 16px;
    border-radius:12px; font-size:13.5px; margin-top:18px; }
  .wnav{ display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:22px; }
  .btn-ghost{ background:#fff; border:1px solid var(--border); color:var(--navy); padding:13px 24px; border-radius:11px;
    font-size:14.5px; font-weight:600; cursor:pointer; font-family:inherit; transition:.15s; }
  .btn-ghost:hover{ border-color:var(--navy); background:#f8fafc; }
  .btn-next{ background:var(--navy); color:#fff; border:none; padding:13px 30px; border-radius:11px; font-size:14.5px;
    font-weight:700; cursor:pointer; font-family:inherit; margin-left:auto; transition:.15s; }
  .btn-next:hover{ filter:brightness(1.12); transform:translateY(-1px); }
  .submit{ background:var(--primary); color:#fff; border:none; padding:14px 36px; border-radius:12px; font-size:15.5px;
    font-weight:700; cursor:pointer; font-family:inherit; margin-left:auto; box-shadow:0 4px 16px rgba(139,0,0,.25); transition:.15s; }
  .submit:hover{ filter:brightness(1.08); transform:translateY(-1px); }
  .submit:disabled{ opacity:.6; cursor:not-allowed; transform:none; }
  .field.invalid input, .field.invalid select, .field.invalid textarea, .field.invalid .radios .radio{ border-color:#dc2626; }
  .foot{ text-align:center; font-size:12px; color:var(--muted); margin-top:26px; }
  @media(max-width:560px){ .wnav .btn-ghost, .wnav .btn-next, .wnav .submit{ padding:13px 18px; } .sec-head h2{ font-size:17px; } .hero h1{ font-size:23px; } }
  [hidden]{ display:none !important; }
</style></head><body>
  <div class="hero"><div class="logo">${TDOT_LOGO_LIGHT_HTML_LARGE}</div>
    <h1>Book Your Immigration Consultation</h1>
    <p>Tell us about your situation so your RCIC can prepare — the more you share, the better tailored your consultation will be.</p>
    <div class="meta"><span>🕐 About 8–10 minutes</span><span>🔒 Kept strictly confidential</span><span>✱ Required fields are marked</span></div>
  </div>
  <div class="pbar-wrap"><div class="pbar-inner">
    <div class="pbar-meta"><span id="pmeta">Step 1 of ${SECTION_ORDER.length}</span><span class="pct" id="ppct">8%</span></div>
    <div class="pbar"><div class="pfill" id="pfill"></div></div>
  </div></div>
  <div class="wrap">
    <form id="cform" method="POST" action="/consultation/submit" novalidate>
      <input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
${sections}
      <div id="err-banner" class="err-banner"></div>
      <div class="wnav">
        <button type="button" class="btn-ghost" id="btn-back" style="display:none">‹ Back</button>
        <button type="button" class="btn-next" id="btn-next">Next ›</button>
        <button type="submit" class="submit" id="btn-submit" style="display:none">Submit consultation request ✓</button>
      </div>
      <div class="foot">TDOT Immigration · Your information is kept confidential and used only to prepare your consultation.</div>
    </form>
  </div>
<script>
(function(){
  var form=document.getElementById('cform');
  var steps=[].slice.call(form.querySelectorAll('.step'));
  var cur=0;
  var pmeta=document.getElementById('pmeta'), ppct=document.getElementById('ppct'), pfill=document.getElementById('pfill');
  var back=document.getElementById('btn-back'), next=document.getElementById('btn-next'), submitBtn=document.getElementById('btn-submit');
  var banner=document.getElementById('err-banner');

  function val(name){
    var els=form.querySelectorAll('[name="'+CSS.escape(name)+'"]');
    if(!els.length) return '';
    if(els[0].type==='radio'){ for(var i=0;i<els.length;i++) if(els[i].checked) return els[i].value; return ''; }
    if(els[0].type==='checkbox') return els[0].checked?els[0].value:'';
    return els[0].value;
  }
  function cmp(c){
    if(c.anyOf) return c.anyOf.some(cmp);
    if(c.allOf) return c.allOf.every(cmp);
    var v=val(c.field);
    if(c.in) return c.in.indexOf(v)>=0;
    if(c.gt!=null) return Number(v||0)>c.gt;
    return false;
  }
  function setEnabled(c,on){ c.querySelectorAll('input,select,textarea').forEach(function(el){ el.disabled=!on; }); }
  function apply(){
    var svc=val('serviceRequired');
    form.querySelectorAll('[data-block]').forEach(function(b){
      var on=(JSON.parse(b.getAttribute('data-services'))||[]).indexOf(svc)>=0; b.hidden=!on; setEnabled(b,on);
    });
    form.querySelectorAll('[data-showif]').forEach(function(el){
      var on=cmp(JSON.parse(el.getAttribute('data-showif')));
      var blk=el.closest('[data-block]'); if(blk&&blk.hidden) on=false;
      el.hidden=!on; setEnabled(el,on);
    });
  }
  form.addEventListener('input',apply); form.addEventListener('change',apply);

  // repeatable groups
  window.addGrpRow=function(g){
    var tpl=document.getElementById('tpl-'+g), box=document.getElementById('grp-'+g);
    var i=box.querySelectorAll('.grp-row').length;
    var div=document.createElement('div'); div.innerHTML=tpl.innerHTML.replace(/__I__/g,i); box.appendChild(div.firstElementChild); apply();
  };
  window.rmGrpRow=function(btn){ var box=btn.closest('.grp-rows'); if(box.querySelectorAll('.grp-row').length>1) btn.closest('.grp-row').remove(); };

  // ── wizard ──
  function stepEmpty(st){
    var fs=st.querySelectorAll('.field'); if(!fs.length) return false;
    for(var i=0;i<fs.length;i++){ if(!fs[i].hidden){ var blk=fs[i].closest('[data-block]'); if(!(blk&&blk.hidden)) return false; } }
    return true;
  }
  function nextStep(from){ for(var i=from+1;i<steps.length;i++) if(!stepEmpty(steps[i])) return i; return -1; }
  function prevStep(from){ for(var i=from-1;i>=0;i--) if(!stepEmpty(steps[i])) return i; return -1; }
  function show(i){
    steps.forEach(function(s,idx){ s.hidden=idx!==i; });
    cur=i; apply();
    var st=steps[i];
    back.style.display = prevStep(i)===-1 ? 'none' : '';
    var last = nextStep(i)===-1;
    next.style.display = last?'none':''; submitBtn.style.display = last?'':'none';
    var nonEmpty=steps.filter(function(s){ return !stepEmpty(s); });
    var pos=nonEmpty.indexOf(st)+1, total=nonEmpty.length||1, pct=Math.round((pos/total)*100);
    pfill.style.width=pct+'%'; ppct.textContent=pct+'%';
    pmeta.textContent='Step '+pos+' of '+total+' · '+st.getAttribute('data-name');
    banner.style.display='none';
    st.classList.remove('anim'); void st.offsetWidth; st.classList.add('anim');
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function badIn(scope){
    var bad=[], seen={};
    scope.querySelectorAll('[data-req="1"]').forEach(function(el){
      if(el.disabled) return; var f=el.closest('.field'); if(f&&f.hidden) return;
      if(seen[el.name]) return; seen[el.name]=1;
      if(el.type==='checkbox'){ if(!el.checked) bad.push(f); } else if(!val(el.name)) bad.push(f);
    });
    return bad;
  }
  function flag(bad){
    form.querySelectorAll('.invalid').forEach(function(x){x.classList.remove('invalid');});
    bad.forEach(function(f){ if(f) f.classList.add('invalid'); });
    banner.textContent='Please complete the '+bad.length+' highlighted field'+(bad.length>1?'s':'')+' to continue.';
    banner.style.display='block';
    if(bad[0]) bad[0].scrollIntoView({behavior:'smooth',block:'center'});
  }
  next.addEventListener('click',function(){ var bad=badIn(steps[cur]); if(bad.length){ flag(bad); return; } var n=nextStep(cur); if(n!==-1) show(n); });
  back.addEventListener('click',function(){ var p=prevStep(cur); if(p!==-1) show(p); });
  form.addEventListener('submit',function(e){
    apply();
    var bad=badIn(form);
    if(bad.length){ e.preventDefault();
      var st=bad[0]&&bad[0].closest('.step'), idx=st?steps.indexOf(st):-1;
      if(idx!==-1&&idx!==cur) show(idx);
      flag(bad);
    } else { submitBtn.disabled=true; submitBtn.textContent='Submitting…'; }
  });

  apply(); show(0);
})();
</script></body></html>`;
}

// ─── Submission: validate → map → store → confirm ────────────────────────────

const path = require('path');
const fs = require('fs');
const BOARD_CFG_PATH = path.join(__dirname, '..', 'data', 'consultationBoard.json');

const FLAT_SERVICES = Object.values(SERVICE_GROUPS).flat();

/** Server-side mirror of the form's conditional logic. */
function evalCond(c, body) {
  if (!c) return true;
  if (c.anyOf) return c.anyOf.some((x) => evalCond(x, body));
  if (c.allOf) return c.allOf.every((x) => evalCond(x, body));
  const v = body[c.field];
  if (c.in) return c.in.includes(v);
  if (c.gt != null) return Number(v || 0) > c.gt;
  return false;
}
function isActive(f, body) {
  if (f.block && !(FBLOCK_SERVICES[f.block] || []).includes(body.serviceRequired)) return false;
  if (f.showIf && !evalCond(f.showIf, body)) return false;
  return true;
}

/** Validate a submission. Returns an array of human messages (empty = valid). */
function validate(body) {
  const errors = [];
  for (const f of FIELDS) {
    if (!isActive(f, body)) continue;
    const v = body[f.key];
    const empty = (v == null || String(v).trim() === '');
    if (f.type === 'checkbox') { if (f.required && v !== 'Yes') errors.push(`"${f.label}" is required.`); continue; }
    if (f.required && empty) { errors.push(`"${f.label}" is required.`); continue; }
    if (!empty && (f.type === 'dropdown' || f.type === 'radio')) {
      const opts = f.key === 'serviceRequired' ? FLAT_SERVICES : f.options;
      if (!opts.includes(v)) errors.push(`Invalid value for "${f.label}".`);
    }
  }
  return errors;
}

/** Mirror leadService.formatValue for the consultation board write. */
function fmt(type, v) {
  switch (type) {
    case 'email':     return { email: String(v), text: String(v) };
    case 'phone':     return { phone: String(v).replace(/\D/g, ''), countryShortName: 'CA' };
    case 'dropdown':  return { labels: Array.isArray(v) ? v : [String(v)] };
    case 'status':    return { label: String(v) };
    case 'long_text': return { text: String(v) };
    case 'date':      return { date: String(v) };
    case 'numbers':   return String(v);
    default:          return String(v);
  }
}

/** Normalise a repeatable group (array or index-keyed object) → array of non-empty rows. */
function groupRows(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr.filter((r) => r && typeof r === 'object' && Object.values(r).some((x) => String(x || '').trim()));
}

function mapToColumns(body, cols) {
  const out = {};
  for (const f of FIELDS) {
    if (!isActive(f, body)) continue;
    let v = body[f.key];
    if (f.type === 'checkbox') v = (v === 'Yes') ? 'Yes' : '';
    if (v == null || String(v).trim() === '') continue;
    const colId = cols[f.key];
    if (colId) out[colId] = fmt(f.mondayType, v);
  }
  for (const g of GROUPS) {
    const rows = groupRows(body[g.group]);
    const colId = cols[g.group];
    if (rows.length && colId) out[colId] = { text: JSON.stringify(rows) };
  }
  return out;
}

function loadBoardCfg() {
  try { return JSON.parse(fs.readFileSync(BOARD_CFG_PATH, 'utf8')); } catch (_) { return null; }
}

/**
 * Process a public submission: honeypot → validate → create the Monday item on
 * the dedicated board → email the submitter a confirmation.
 * @throws {Error} .badRequest (with .errors) on validation failure
 */
async function processSubmission(body) {
  if (body && body.website) return { ok: true }; // honeypot tripped — silently accept, store nothing

  const errors = validate(body || {});
  if (errors.length) { const e = new Error(errors.join(' ')); e.badRequest = true; e.errors = errors; throw e; }

  const cfg = loadBoardCfg();
  if (!cfg || !cfg.boardId) { const e = new Error('The consultation board is not set up yet.'); throw e; }

  const mondayApi = require('./mondayApi');
  const cols = mapToColumns(body, cfg.columns || {});
  const name = String(body.fullName || 'Consultation request').slice(0, 250);
  await mondayApi.query(
    `mutation($b: ID!, $n: String!, $c: JSON!){ create_item(board_id:$b, item_name:$n, column_values:$c, create_labels_if_missing:true){ id } }`,
    { b: String(cfg.boardId), n: name, c: JSON.stringify(cols) }
  );

  if (body.email) {
    try { await sendConfirmation(body); }
    catch (err) { console.warn(`[ConsultForm] confirmation email failed for ${body.email}: ${err.message}`); }
  }
  return { ok: true };
}

async function sendConfirmation(body) {
  const microsoftMail = require('./microsoftMailService');
  const first = esc(String(body.fullName || 'there').split(' ')[0]);
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:0 auto;color:${BRAND.textOnLight}">
      <div style="background:${BRAND.darkPanel};padding:24px;border-radius:12px 12px 0 0;text-align:center">${TDOT_LOGO_LIGHT_HTML_LARGE}
        <h1 style="color:#fff;margin:12px 0 0;font-size:20px">We've received your consultation request</h1></div>
      <div style="background:#fff;padding:28px;border-radius:0 0 12px 12px;border:1px solid ${BRAND.border}">
        <p>Hi ${first},</p>
        <p>Thank you for sharing your details with TDOT Immigration. Our team will review your information and reach out to schedule your consultation.</p>
        <p style="color:${BRAND.mutedOnLight};font-size:13px;margin-top:24px">Anything to add? Just reply to this email.</p>
      </div></div>`;
  await microsoftMail.sendEmail({ to: body.email, subject: 'We received your TDOT Immigration consultation request', html });
}

function buildThanksHtml() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thank you — TDOT Immigration</title><style>
  body{ font-family:-apple-system,sans-serif; background:${BRAND.lightBg}; margin:0; color:${BRAND.textOnLight}; }
  .hero{ background:${BRAND.darkPanel}; padding:28px; text-align:center; }
  .box{ background:#fff; max-width:520px; margin:48px auto; padding:44px 40px; border-radius:16px; text-align:center;
    border:1px solid ${BRAND.border}; box-shadow:0 4px 18px rgba(15,29,50,.06); }
  .tick{ width:62px; height:62px; border-radius:50%; background:#f0fdf4; color:#16a34a; font-size:32px; line-height:62px; margin:0 auto 18px; }
  h1{ color:${BRAND.darkPanel}; font-size:23px; margin:0 0 10px; }
  p{ color:${BRAND.mutedOnLight}; font-size:15px; line-height:1.6; }
</style></head><body>
  <div class="hero">${TDOT_LOGO_LIGHT_HTML_LARGE}</div>
  <div class="box"><div class="tick">✓</div>
    <h1>Thank you — we've got your request</h1>
    <p>Our team will review your information and contact you to schedule your consultation. A confirmation email is on its way.</p>
  </div></body></html>`;
}

function buildErrorHtml(errors) {
  const list = (errors || ['Something went wrong.']).map((e) => `<li>${esc(e)}</li>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Please check your answers</title><style>
    body{ font-family:-apple-system,sans-serif; background:${BRAND.lightBg}; padding:48px; color:${BRAND.textOnLight}; }
    .box{ background:#fff; max-width:560px; margin:0 auto; padding:36px; border-radius:14px; border:1px solid ${BRAND.border}; }
    h1{ color:${BRAND.primary}; font-size:20px; } ul{ line-height:1.7; } a{ color:${BRAND.darkPanel}; }
  </style></head><body><div class="box"><h1>Please check your answers</h1><ul>${list}</ul>
    <p><a href="/consultation">← Back to the form</a></p></div></body></html>`;
}

module.exports = { buildFormHtml, validate, mapToColumns, processSubmission, buildThanksHtml, buildErrorHtml };
