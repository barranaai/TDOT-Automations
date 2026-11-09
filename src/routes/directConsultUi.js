'use strict';

/**
 * "＋ Direct consultation" — the pop-up on the Consultations page (step 2, commit 3,
 * 2026-11-09). A consultation booked OUTSIDE the app (Melanie books most of them in
 * Square, by phone or at the office) is added by hand: one Lead Board row, already
 * Booked. The server (directConsultService) checks everything again and decides the
 * kind (New / Follow-up / Existing client) — this pop-up only collects the facts and
 * shows what the server says.
 *
 * The button shows only when GET /api/consultation/direct-consult/options answers
 * 200 (the DIRECT_CONSULTATION switch is on for this person). 503 = switched on but
 * the Lead Board column is not made yet: the button shows greyed out, saying so.
 *
 * The one pop-up standard: tdotDialogNew (dialogUi.js) — ×, Cancel, Escape, no
 * closing while saving, a bottom sheet on a phone. Built fresh at every opening, so
 * nothing typed for one client is ever left in the form for the next.
 * Inputs are 16px (a phone does not zoom into them); the form fits 375 px.
 *
 * TEMPLATE-LITERAL TRAP: DQ_JS is browser code inside the page's template literal —
 * no backticks, no dollar-brace, no backslashes (test/directConsultPages.test.js checks).
 * The form markup is built HERE (dqFormHtml) and handed to the page as a JSON value.
 */

const { referralFieldsHtml, sourceOptionsHtml } = require('./referralPicker');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DQ_CSS = `
  .btn-direct { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border:1px solid var(--navy); background:var(--navy); color:#fff; border-radius:9px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; }
  .btn-direct:hover:not(:disabled) { filter:brightness(1.12); }
  .btn-direct:disabled { opacity:.5; cursor:not-allowed; }
  #btn-direct-consult[hidden] { display:none; }   /* .btn-direct sets display, which beats the hidden attribute: switched off or not on the list = no button */
  .page-top .top-r { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  #dq-done { display:none; background:#f0fdf4; border:1px solid #bbf7d0; color:#14532d; border-radius:10px; padding:10px 14px; font-size:13px; margin:0 0 12px; line-height:1.5; }
  #dq-done.warn { background:#fffbeb; border-color:#fde68a; color:#92400e; }
  #dq-done a { color:inherit; font-weight:700; }
  #dq-done button { background:none; border:0; color:inherit; cursor:pointer; font:inherit; text-decoration:underline; padding:0 0 0 8px; }
  .dq-pill { cursor:help; }
  /* The pop-up (dialogUi.js .tdlg); its fields: 16px so a phone does not zoom in. */
  .dq .dq-sub { font-size:12.5px; color:#64748b; margin:0 0 10px; line-height:1.45; }
  .dq label.dq-l, .dq .dq-l { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:12px 0 4px; }
  .dq .dq-l .dq-h { font-weight:500; text-transform:none; letter-spacing:0; }
  .dq input[type=text], .dq input[type=email], .dq input[type=tel], .dq input[type=datetime-local], .dq input[type=date], .dq select, .dq textarea {
    width:100%; padding:9px 10px; border:1px solid #e2e8f0; border-radius:8px; font-size:16px; font-family:inherit; color:var(--navy, #1a3558); background:#fff; box-sizing:border-box; min-height:42px; }
  .dq textarea { min-height:60px; resize:vertical; }
  .dq .dq-row2 { display:grid; grid-template-columns:1fr 1fr; gap:0 10px; }
  .dq .dq-row2 > div { min-width:0; }
  .dq .dq-hint { font-size:12px; color:#64748b; margin-top:4px; line-height:1.4; }
  .dq .dq-seg { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
  .dq .dq-seg label { display:inline-flex; align-items:center; gap:6px; border:1px solid #e2e8f0; border-radius:8px; padding:8px 11px; font-size:14px; cursor:pointer; background:#fff; margin:0; min-height:40px; box-sizing:border-box; }
  .dq .dq-seg label:has(input:checked) { border-color:var(--navy, #1a3558); background:#eef2f8; font-weight:600; }
  .dq .dq-seg input { margin:0; width:auto; flex:none; }
  .dq .dq-choice { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:4px; }
  .dq .dq-choice label { display:flex; gap:8px; align-items:flex-start; border:1px solid #e2e8f0; border-radius:10px; padding:10px 11px; font-size:14px; line-height:1.35; cursor:pointer; margin:0; }
  .dq .dq-choice label:has(input:checked) { border-color:var(--navy, #1a3558); background:#eef2f8; }
  .dq .dq-choice input { margin:3px 0 0; flex:none; }
  .dq .dq-choice small { display:block; color:#64748b; font-size:12px; font-weight:400; margin-top:2px; }
  .dq .dq-fees { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 6px; }
  .dq .dq-fees button { border:1px solid #cbd5e1; background:#fff; border-radius:8px; padding:7px 10px; font-size:14px; font-family:inherit; cursor:pointer; color:var(--navy, #1a3558); min-height:38px; }
  .dq .dq-fees button.on { border-color:var(--navy, #1a3558); background:#eef2f8; font-weight:700; }
  .dq .dq-total { font-size:13px; color:#14532d; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:7px 10px; margin-top:6px; }
  .dq .dq-box { border-radius:8px; padding:10px 12px; margin-top:12px; font-size:13px; line-height:1.45; }
  .dq .dq-box.info { background:#eff6ff; border:1px solid #bfdbfe; color:#1e3a8a; }
  .dq .dq-box.warn { background:#fffbeb; border:1px solid #fde68a; color:#92400e; }
  .dq .dq-box a { color:#1d4ed8; }
  .dq .dq-box .dq-t { font-weight:700; margin-bottom:4px; }
  .dq .dq-person { padding:6px 0; border-top:1px solid rgba(0,0,0,.06); }
  .dq .dq-person:first-of-type { border-top:0; }
  .dq .dq-person .dq-who { font-weight:700; }
  .dq .dq-line { padding:2px 0 2px 10px; }
  .dq label.dq-tick { display:flex; gap:8px; align-items:flex-start; font-size:13.5px; margin:8px 0 0; cursor:pointer; text-transform:none; letter-spacing:0; font-weight:600; color:inherit; }
  .dq label.dq-tick input { margin:3px 0 0; width:auto; flex:none; }
  .dq .ref-row .al-l { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:#64748b; margin:12px 0 4px; }
  .dq .ref-search input { font-size:16px; }
  .dq .al-hint { font-size:12px; color:#64748b; margin-top:4px; }
  @media (max-width:560px) {
    .dq .dq-row2, .dq .dq-choice { grid-template-columns:1fr; }
    .dq .dq-seg label { flex:1 1 auto; justify-content:center; }
  }
`;

/** The form, built on the server (the option lists and the referral rows), handed to the page as a JSON value. */
function dqFormHtml() {
  return [
    '<h3 id="dq-title">Add a direct consultation</h3>',
    '<p class="dq-sub">A consultation booked outside the app — in Square, by phone or at the office. One row per consultation. The client gets no email from this unless you tick the consultation package.</p>',
    '<label class="dq-l" for="dq-name">Full name *</label><input id="dq-name" type="text" maxlength="120" autocomplete="off">',
    '<div class="dq-row2"><div><label class="dq-l" for="dq-email">Email</label><input id="dq-email" type="email" maxlength="200" autocomplete="off"></div>',
    '<div><label class="dq-l" for="dq-phone">Phone</label><input id="dq-phone" type="tel" maxlength="40" autocomplete="off"></div></div>',
    '<div class="dq-hint">An email or a phone number — one of the two is enough. The app looks the person up as you type.</div>',
    '<div id="dq-match" aria-live="polite"></div>',
    '<div class="dq-l" id="dq-choice-l">What is it? *</div>',
    '<div class="dq-choice" role="radiogroup" aria-labelledby="dq-choice-l">',
    '<label><input type="radio" name="dq-choice" value="new"><span>New client / new matter<small>Counts as a lead and gets an outcome.</small></span></label>',
    '<label><input type="radio" name="dq-choice" value="existing"><span>Existing client: about their current file<small>Not counted as a new lead; no outcome needed.</small></span></label>',
    '</div>',
    '<div class="dq-row2"><div><label class="dq-l" for="dq-consultant">Consultant *</label><select id="dq-consultant"><option value="">Choose…</option></select></div>',
    '<div><div class="dq-l" id="dq-how-l">How *</div><div class="dq-seg" role="radiogroup" aria-labelledby="dq-how-l" id="dq-how"></div></div></div>',
    '<div class="dq-row2"><div><label class="dq-l" for="dq-when">Date and time * <span class="dq-h">(Toronto)</span></label><input id="dq-when" type="datetime-local" step="300"></div>',
    '<div><label class="dq-l" for="dq-len">Length *</label><select id="dq-len"></select></div></div>',
    '<div class="dq-hint" id="dq-when-hint"></div>',
    '<div class="dq-l" id="dq-pay-l">Payment *</div><div class="dq-seg" role="radiogroup" aria-labelledby="dq-pay-l" id="dq-pay"></div>',
    '<div id="dq-fee-w" style="display:none">',
    '<label class="dq-l" for="dq-fee">Fee before HST *</label><div class="dq-fees" id="dq-fees"></div>',
    '<input id="dq-fee" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 300.00">',
    '<div class="dq-total" id="dq-total" style="display:none"></div>',
    '<label class="dq-l" for="dq-paidon">Date paid</label><input id="dq-paidon" type="date">',
    '</div>',
    '<label class="dq-l" for="dq-about">What it is about * <span class="dq-h">(one short line)</span></label><input id="dq-about" type="text" maxlength="200" autocomplete="off" placeholder="e.g. spousal sponsorship, study permit extension…">',
    '<label class="dq-l" for="dq-casetype">Case type <span class="dq-h">(optional)</span></label><select id="dq-casetype"><option value="">— not sure yet —</option></select>',
    '<label class="dq-l" for="dq-bookedby">Booked by *</label><select id="dq-bookedby"><option value="">Choose…</option></select>',
    '<div id="dq-src-w">',
    '<label class="dq-l" for="dq-source">Source / Reference *</label>',
    '<select id="dq-source">' + sourceOptionsHtml({ blank: true }) + '</select>' + referralFieldsHtml('dq'),
    '</div>',
    '<div class="dq-l" id="dq-inca-l">In Canada now? <span class="dq-h">(optional — sets the HST on the fee)</span></div>',
    '<div class="dq-seg" role="radiogroup" aria-labelledby="dq-inca-l"><label><input type="radio" name="dq-inca" value="Yes"> Yes</label><label><input type="radio" name="dq-inca" value="No"> No</label><label><input type="radio" name="dq-inca" value="" checked> Not known</label></div>',
    '<div id="dq-country-w" style="display:none"><label class="dq-l" for="dq-country">Which country? *</label><select id="dq-country">' + require('./adminShared').COUNTRY_OPTS + '</select></div>',
    '<div id="dq-sq-w" style="display:none"><div class="dq-l" id="dq-sq-l">Already booked in Square? *</div>',
    '<div class="dq-seg" role="radiogroup" aria-labelledby="dq-sq-l"><label><input type="radio" name="dq-sq" value="yes"> Yes</label><label><input type="radio" name="dq-sq" value="no"> No</label></div>',
    '<div class="dq-hint">Yes: Square reminds the client, so the app sends nothing. No: the app sends the 24-hour and 1-hour reminders.</div></div>',
    '<div id="dq-pkg-w" style="display:none">',
    '<label class="dq-tick"><input type="checkbox" id="dq-pkg"><span>Email the client the consultation agreement and pre-consultation form now</span></label>',
    '<div id="dq-addr-w" style="display:none"><label class="dq-l" for="dq-addr">Residential address <span class="dq-h">(prints on the agreement)</span></label><textarea id="dq-addr" rows="2" maxlength="500" placeholder="Street, city, province/state, postal code, country"></textarea>',
    '<div class="dq-hint" id="dq-addr-hint"></div></div>',
    '</div>',
    '<div id="dq-server" aria-live="polite"></div>',
    '<div class="tdlg-err" id="dq-err" role="alert"></div>',
    '<div class="tdlg-actions"><button type="button" class="tdlg-btn" data-x>Cancel</button><button type="button" class="tdlg-btn primary" id="dq-save">Save</button></div>',
  ].join('');
}

/** The button and the line that says what was saved — in the page's top row. */
const DQ_BUTTON_HTML = '<button class="btn-direct" id="btn-direct-consult" type="button" hidden title="A consultation booked outside the app — in Square, by phone or at the office">＋ Direct consultation</button>';
const DQ_DONE_HTML = '<div id="dq-done" role="status"></div>';

/* Browser code. Needs: getKey/peekKey (SHARED_AUTH_JS), tdotDialogNew (DIALOG_UI_JS), tdotRef (REFERRAL_UI_JS),
   tdotBlacklistHtml (BLACKLIST_UI_JS), DQ_FORM (the form markup), load(force) (the list). */
const DQ_JS = `
/* ── ＋ Direct consultation (step 2): a consultation booked outside the app ── */
var DQ_OPTS=null;
function dqEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function dqKey(){ return (typeof peekKey==='function')?peekKey():getKey(); }
/* Toronto wall clock, 'YYYY-MM-DD HH:MM' — the server compares the same way. */
function dqNowWall(){
  var p={};
  try { new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).forEach(function(x){ p[x.type]=x.value; }); }
  catch(e){ var d=new Date(); return d.toISOString().slice(0,16).split('T').join(' '); }
  return p.year+'-'+p.month+'-'+p.day+' '+(p.hour==='24'?'00':p.hour)+':'+p.minute;
}
function dqDayAdd(day,n){ var m=String(day).split('-'); var t=new Date(Date.UTC(Number(m[0]),Number(m[1])-1,Number(m[2])+n)); return t.toISOString().slice(0,10); }
function dqDayDiff(a,b){ var x=String(a).split('-'), y=String(b).split('-'); return Math.round((Date.UTC(Number(x[0]),Number(x[1])-1,Number(x[2]))-Date.UTC(Number(y[0]),Number(y[1])-1,Number(y[2])))/86400000); }
function dqMoney(c){ return '$'+(Number(c||0)/100).toFixed(2); }
function dqCents(v){ var s=String(v==null?'':v).replace(/[^0-9.]/g,''); if(!s) return NaN; var n=Number(s); return isFinite(n)?Math.round(n*100):NaN; }
function dqNorm(n){ return String(n||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/ +/g,' ').trim(); }

/* The button: shown only when the server says this person may use it. */
function dqInitButton(){
  var b=document.getElementById('btn-direct-consult'); if(!b) return;
  var key=dqKey(); if(!key) return;
  fetch('/api/consultation/direct-consult/options',{headers:{'X-Api-Key':key},credentials:'same-origin'})
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {s:r.status,j:j}; }); })
    .then(function(res){
      if(res.s===200){ DQ_OPTS=res.j; b.hidden=false; b.disabled=false; b.onclick=openDirectConsult; return; }
      if(res.s===503){
        var why=(res.j&&res.j.error)||'Direct consultation is not set up yet.';
        b.hidden=false; b.disabled=true; b.title=why;
        dqShowDone(why,'',true);   /* in words too: a greyed button shows no tooltip on a phone or tablet (review round 2) */
        return;
      }
      b.hidden=true;   /* 404 = switched off; 401 = this list is for Monday sign-ins only */
    })
    .catch(function(){ b.hidden=true; });
}

/* A server error or a lost answer: it may or may not have been saved. */
var DQ_CHECK_LIST='Something went wrong on the server — it may or may not have been saved. Check the Consultations list before trying again, so it is not added twice.';
function dqShowDone(text,link,warn){
  var el=document.getElementById('dq-done'); if(!el) return;
  el.className=warn?'warn':'';
  el.innerHTML=dqEsc(text)+(link?' <a href="'+dqEsc(link)+'">Open the record</a>':'')+' <button type="button" id="dq-done-x" aria-label="Hide this message">hide</button>';
  el.style.display='block';
  var x=document.getElementById('dq-done-x'); if(x) x.onclick=function(){ el.style.display='none'; };
}

function openDirectConsult(){
  if(!DQ_OPTS) return;
  var o=DQ_OPTS;
  var dlg=tdotDialogNew({ cls:'dq', labelledBy:'dq-title', slowText:'Still waiting for an answer. You can close this window, but check the Consultations list before trying again, so the consultation is not added twice.' });
  var box=dlg.box; box.innerHTML=DQ_FORM;
  var run=dlg.openId;
  function q(id){ return box.querySelector('#'+id); }
  var st={ match:null, matchSeq:0, matchTimer:null, feeTouched:false, lenTouched:false, blHit:false, clashAck:false, live:[] };
  var ref=tdotRef('dq');

  /* Fill the lists from the options. */
  q('dq-consultant').innerHTML='<option value="">Choose…</option>'+(o.consultants||[]).map(function(c){ return '<option value="'+dqEsc(c.name)+'">'+dqEsc(c.name)+(c.rcic?'':' (not an RCIC)')+'</option>'; }).join('');
  var HOW_LABELS={ 'In-person':'In person', 'Virtual':'Video', 'Phone Call':'Phone' };
  q('dq-how').innerHTML=(o.meetingTypes||[]).map(function(t){ return '<label><input type="radio" name="dq-how" value="'+dqEsc(t)+'"> '+dqEsc(HOW_LABELS[t]||t)+'</label>'; }).join('');
  q('dq-len').innerHTML=(o.lengths||[]).map(function(n){ return '<option value="'+n+'">'+n+' minutes</option>'; }).join('');
  q('dq-pay').innerHTML=(o.payments||[]).map(function(p){ return '<label><input type="radio" name="dq-pay" value="'+dqEsc(p.kind)+'"> '+dqEsc(p.label)+'</label>'; }).join('');
  q('dq-casetype').innerHTML='<option value="">— not sure yet —</option>'+(o.caseTypes||[]).map(function(c){ return '<option value="'+dqEsc(c)+'">'+dqEsc(c)+'</option>'; }).join('');
  var staff=(o.staff||[]).slice(); if(o.bookedBy && staff.indexOf(o.bookedBy)<0) staff.unshift(o.bookedBy);
  q('dq-bookedby').innerHTML='<option value="">Choose…</option>'+staff.map(function(n){ return '<option value="'+dqEsc(n)+'">'+dqEsc(n)+'</option>'; }).join('');
  if(o.bookedBy) q('dq-bookedby').value=o.bookedBy;
  var today=dqNowWall().slice(0,10);
  q('dq-when').min=dqDayAdd(today,-(o.backDays||30))+'T00:00';
  q('dq-paidon').max=today; q('dq-paidon').value=today;

  function radio(name){ var r=box.querySelector('input[name="'+name+'"]:checked'); return r?r.value:''; }
  /* "This is a different consultation": the tick under the look-up, or the one under the server's answer. */
  function diffTicked(){ var a=q('dq-diff'), b=q('dq-diff2'); return !!((a&&a.checked)||(b&&b.checked)); }
  function consultant(){ var n=q('dq-consultant').value; return (o.consultants||[]).filter(function(c){ return c.name===n; })[0]||null; }
  function slot(){ var v=String(q('dq-when').value||''); return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/.test(v)?v.slice(0,10)+' '+v.slice(11,16):''; }
  function future(){ var s=slot(); return !!s && s>dqNowWall(); }
  function hstPct(){ var yn=radio('dq-inca'), c=q('dq-country').value; if(yn==='No' && c && c!=='Canada') return 0; return Number(o.hstPct||0); }

  /* The length follows the consultant's usual one until staff pick it. */
  function syncConsultant(){
    var c=consultant();
    if(c && !st.lenTouched) q('dq-len').value=String(c.defaultMin||30);
    syncFees(); syncPackage();
  }
  /* Fee buttons: the consultant's prices; the one for the chosen length is filled in until staff type their own. */
  function syncFees(){
    var kind=radio('dq-pay'), paid=!!kind && kind!=='waived' && kind!=='none';
    q('dq-fee-w').style.display=(kind && kind!=='none')?'':'none';
    q('dq-fee').style.display=paid?'':'none';
    box.querySelector('label[for="dq-fee"]').style.display=paid?'':'none';
    var c=consultant(), opts=(c&&c.options)||[], len=Number(q('dq-len').value||0);
    q('dq-fees').innerHTML=paid?opts.map(function(x){ return '<button type="button" data-fee="'+x.feeCents+'">'+dqMoney(x.feeCents)+' · '+x.durationMin+' min</button>'; }).join(''):'';
    q('dq-fees').style.display=(paid&&opts.length)?'':'none';
    if(paid && !st.feeTouched){ var m=opts.filter(function(x){ return x.durationMin===len; })[0]; q('dq-fee').value=m?(m.feeCents/100).toFixed(2):''; }
    Array.prototype.forEach.call(q('dq-fees').querySelectorAll('[data-fee]'),function(b){
      b.onclick=function(){ st.feeTouched=true; q('dq-fee').value=(Number(b.getAttribute('data-fee'))/100).toFixed(2); syncTotal(); };
    });
    syncTotal();
  }
  function syncTotal(){
    var kind=radio('dq-pay'), t=q('dq-total');
    var paid=!!kind && kind!=='waived' && kind!=='none';
    var c=dqCents(q('dq-fee').value);
    Array.prototype.forEach.call(q('dq-fees').querySelectorAll('[data-fee]'),function(b){ b.classList.toggle('on', Number(b.getAttribute('data-fee'))===c); });
    if(!paid || isNaN(c) || c<=0){ t.style.display='none'; return; }
    var pct=hstPct(), total=Math.round(c*(1+pct/100));
    t.textContent=pct>0?('Fee '+dqMoney(c)+' + HST '+pct+'% = '+dqMoney(total)+' total'):('Fee '+dqMoney(c)+' — no HST (outside Canada)');
    t.style.display='';
  }
  /* "Already booked in Square?" — only for a time still ahead. */
  function syncWhen(){
    var s=slot(), h=q('dq-when-hint');
    q('dq-sq-w').style.display=future()?'':'none';
    if(!s){ h.textContent=''; }
    else if(dqDayDiff(today,s.slice(0,10))>(o.backDays||30)) h.textContent='More than '+(o.backDays||30)+' days ago — only the last '+(o.backDays||30)+' days can be added here.';
    else h.textContent=future()?'':'This consultation has already happened — that is fine, it is recorded as held.';
    renderMatch(); syncPackage();
  }
  /* The package tick: a new client, a time ahead, an email, an RCIC, a fee record, not video (no Teams link is made here). */
  function syncPackage(){
    var c=consultant(), kind=radio('dq-pay');
    var ok=radio('dq-choice')==='new' && future() && !!q('dq-email').value.trim() && !!(c&&c.rcic) && !!kind && kind!=='none' && radio('dq-how')!=='Virtual';
    q('dq-pkg-w').style.display=ok?'':'none';
    if(!ok) q('dq-pkg').checked=false;
    var on=q('dq-pkg').checked;
    q('dq-addr-w').style.display=on?'':'none';
    q('dq-addr-hint').textContent=(on && !q('dq-addr').value.trim())?'Left empty, the package waits for the address — add it on the record and it goes out then.':'';
  }
  function syncChoice(){
    var existing=radio('dq-choice')==='existing';
    q('dq-src-w').style.display=existing?'none':'';
    renderMatch(); syncPackage();
  }

  /* ── The live look-up: what the app already has for this email / phone, grouped by person ── */
  function clearServer(){ q('dq-server').innerHTML=''; st.clashAck=false; }
  function lookUp(){
    var email=q('dq-email').value.trim(), phone=q('dq-phone').value.trim();
    var digits=phone.replace(/[^0-9]/g,'');
    if(!(/^[^ @]+@[^ @]+[.][^ @]+$/.test(email)) && digits.length<7){ st.match=null; renderMatch(); return; }
    var key=dqKey(); if(!key) return;
    var seq=++st.matchSeq;
    fetch('/api/consultation/client-matches?email='+encodeURIComponent(email)+'&phone='+encodeURIComponent(phone),{headers:{'X-Api-Key':key}})
      .then(function(r){ return r.ok?r.json():null; })
      .then(function(m){ if(!dlg.still(run) || seq!==st.matchSeq) return; st.match=m; renderMatch(); })
      .catch(function(){ /* the server checks again on Save */ });
  }
  function lookUpSoon(){ clearTimeout(st.matchTimer); st.matchTimer=setTimeout(lookUp,600); }
  function leadLine(l){
    var bits=[];
    if(l.directConsult) bits.push('direct consultation ('+l.directConsult+')');
    if(l.outcome) bits.push('outcome '+l.outcome);
    else if(l.bookingStatus==='Booked' && l.bookedSlot) bits.push('consultation '+l.bookedSlot+(l.consultant?' with '+l.consultant:''));
    else if(l.bookingStatus) bits.push(l.bookingStatus+(l.bookedSlot?' '+l.bookedSlot:''));
    if(l.hasCase) bits.push('has a case');
    else if(l.retainerSent) bits.push('retainer sent');
    else if(l.planInProgress) bits.push('retainer plan in progress');
    if(l.direct) bits.push('direct retainer client');
    var href=(l.bookingStatus==='Booked'||l.outcome)?'/admin/consultation/'+encodeURIComponent(l.id):'/admin/lead/'+encodeURIComponent(l.id);
    return '<a href="'+href+'" target="_blank" rel="noopener">Lead '+dqEsc(l.id)+'</a>'+(l.sourceChannel?' ('+dqEsc(l.sourceChannel)+')':'')+(bits.length?' — '+dqEsc(bits.join(' · ')):' — not booked');
  }
  function reusable(l){ return !l.hasCase && !l.retainerSent && !l.planInProgress && !l.outcome && !l.direct && !l.directConsult && l.conversionStatus!=='Retained' && l.bookingStatus!=='Booked'; }
  function renderMatch(){
    var el=q('dq-match'); if(!el) return;
    var m=st.match; st.live=[];
    var any=m && ((m.leads&&m.leads.length)||(m.cases&&m.cases.length)||(m.clients&&m.clients.length));
    var bl=(m&&typeof tdotBlacklistHtml==='function')?tdotBlacklistHtml(m.blacklist,{leadLinks:true}):'';
    st.blHit=!!(m&&m.blacklist&&m.blacklist.hit);
    if(!any && !bl){ el.innerHTML=''; return; }
    var keepUse=radio('dq-use'), keepDiff=!!(q('dq-diff')&&q('dq-diff').checked), keepAck=!!(q('dq-bl-ack')&&q('dq-bl-ack').checked);
    var people={}, order=[];
    function person(name){ var k=dqNorm(name)||'?'; if(!people[k]){ people[k]={ name:name||'(no name)', lines:[] }; order.push(k); } return people[k]; }
    var existing=radio('dq-choice')==='existing', s=slot();
    ((m&&m.clients)||[]).forEach(function(c){ person(c.name).lines.push('Client account'+(c.reasons&&c.reasons.length?' ('+dqEsc(c.reasons.join(', '))+')':'')); });
    ((m&&m.cases)||[]).forEach(function(c){ person(c.name).lines.push('Case <a href="/admin/case/'+encodeURIComponent(c.caseRef||'')+'" target="_blank" rel="noopener">'+dqEsc(c.caseRef||'(no number yet)')+'</a>'+(c.caseStage?' · '+dqEsc(c.caseStage):'')); });
    var uses=[];
    ((m&&m.leads)||[]).forEach(function(l){
      person(l.name).lines.push(leadLine(l));
      /* Live = still ahead (today or later), as the server counts it: a consultation that already happened is never this one. */
      if(l.bookingStatus==='Booked' && !l.outcome && l.bookedSlot && String(l.bookedSlot).slice(0,10)>=dqNowWall().slice(0,10) && (!s || Math.abs(dqDayDiff(s.slice(0,10),String(l.bookedSlot).slice(0,10)))<=30)) st.live.push(l);
      if(!existing && reusable(l)) uses.push(l);
    });
    var h='<div class="dq-box info"><div class="dq-t">Already in the app for this email / phone</div>'+order.map(function(k){ var p=people[k]; return '<div class="dq-person"><div class="dq-who">'+dqEsc(p.name)+'</div>'+p.lines.map(function(x){ return '<div class="dq-line">'+x+'</div>'; }).join('')+'</div>'; }).join('');
    if(!existing && m && m.cases && m.cases.length) h+='<div class="dq-hint">This person has a file with us. If the consultation is about that file, choose “Existing client: about their current file”.</div>';
    if(uses.length){
      h+='<div class="dq-l" style="margin-top:10px">Add it to an existing lead?</div>'+
        '<label class="dq-tick"><input type="radio" name="dq-use" value=""'+(keepUse?'':' checked')+'><span>No — add a new row</span></label>'+
        uses.map(function(l){ return '<label class="dq-tick"><input type="radio" name="dq-use" value="'+dqEsc(l.id)+'"'+(keepUse===String(l.id)?' checked':'')+'><span>Use lead '+dqEsc(l.id)+' ('+dqEsc(l.name)+') — keeps one record for this enquiry</span></label>'; }).join('');
    }
    h+='</div>';
    if(st.live.length){
      h+='<div class="dq-box warn"><div class="dq-t">A consultation for this person is already in the app</div>'+st.live.map(function(l){ return '<div class="dq-line"><a href="/admin/consultation/'+encodeURIComponent(l.id)+'" target="_blank" rel="noopener">'+dqEsc(l.bookedSlot)+(l.consultant?' with '+dqEsc(l.consultant):'')+'</a> — '+dqEsc(l.name)+'</div>'; }).join('')+
        '<div class="dq-hint">If it moved in Square, open that record and change its time there — do not add it again.</div>'+
        '<label class="dq-tick"><input type="checkbox" id="dq-diff"'+(keepDiff?' checked':'')+'><span>This is a different consultation</span></label></div>';
    }
    if(bl) h+=bl+(st.blHit?'<label class="dq-tick" style="color:#991b1b"><input type="checkbox" id="dq-bl-ack"'+(keepAck?' checked':'')+'><span>I have read the warning — add the consultation anyway</span></label>':'');
    el.innerHTML=h;
  }

  /* ── Wiring ── */
  ['dq-email','dq-phone'].forEach(function(id){ var e=q(id); e.addEventListener('input',function(){ clearServer(); lookUpSoon(); syncPackage(); }); e.addEventListener('blur',function(){ clearTimeout(st.matchTimer); lookUp(); }); });
  q('dq-name').addEventListener('input',clearServer);
  Array.prototype.forEach.call(box.querySelectorAll('input[name="dq-choice"]'),function(r){ r.onchange=function(){ clearServer(); syncChoice(); }; });
  q('dq-consultant').onchange=function(){ clearServer(); syncConsultant(); };
  q('dq-len').onchange=function(){ st.lenTouched=true; clearServer(); syncFees(); };
  q('dq-when').addEventListener('change',function(){ clearServer(); syncWhen(); });
  q('dq-when').addEventListener('input',syncWhen);
  Array.prototype.forEach.call(box.querySelectorAll('input[name="dq-how"]'),function(r){ r.onchange=function(){ clearServer(); syncPackage(); }; });
  Array.prototype.forEach.call(box.querySelectorAll('input[name="dq-pay"]'),function(r){ r.onchange=function(){ syncFees(); syncPackage(); }; });
  q('dq-fee').addEventListener('input',function(){ st.feeTouched=true; syncTotal(); });
  Array.prototype.forEach.call(box.querySelectorAll('input[name="dq-inca"]'),function(r){ r.onchange=function(){ q('dq-country-w').style.display=(radio('dq-inca')==='No')?'':'none'; syncTotal(); }; });
  q('dq-country').onchange=syncTotal;
  q('dq-pkg').onchange=syncPackage;
  q('dq-addr').addEventListener('input',syncPackage);
  box.querySelector('[data-x]').onclick=function(){ dlg.tryClose('cancel'); };
  q('dq-save').onclick=function(){ save(); };
  syncFees(); syncChoice(); syncWhen();
  setTimeout(function(){ var f=q('dq-name'); if(f && dlg.still(run)) f.focus(); },30);

  /* ── Save ── */
  function fail(msg,focusEl){ q('dq-err').textContent=msg; if(focusEl && focusEl.focus) focusEl.focus(); }
  /* One save at a time (review round 2): a double click on Save or "Save anyway" sends once. */
  function anywayBtn(on){ var a=q('dq-anyway'); if(a) a.disabled=on; }
  function save(){
    if(st.saving||dlg.busy) return;
    q('dq-err').textContent='';
    var choice=radio('dq-choice'), existing=choice==='existing';
    var name=q('dq-name').value.trim(), email=q('dq-email').value.trim(), phone=q('dq-phone').value.trim();
    if(name.length<2) return fail('Enter the client'+String.fromCharCode(8217)+'s full name.',q('dq-name'));
    if(!email && !phone) return fail('Enter an email or a phone number — one of the two is required.',q('dq-email'));
    if(email && !/^[^ @]+@[^ @]+[.][^ @]+$/.test(email)) return fail('That email doesn'+String.fromCharCode(8217)+'t look right — fix it or leave it empty.',q('dq-email'));
    if(phone && phone.replace(/[^0-9]/g,'').length<7) return fail('That phone number is too short — fix it or leave it empty.',q('dq-phone'));
    if(!choice) return fail('Choose “New client / new matter” or “Existing client: about their current file”.',box.querySelector('input[name="dq-choice"]'));
    if(!q('dq-consultant').value) return fail('Choose the consultant.',q('dq-consultant'));
    if(!radio('dq-how')) return fail('Choose how the consultation happens: in person, video or phone.',box.querySelector('input[name="dq-how"]'));
    var s=slot(); if(!s) return fail('Enter the consultation date and time.',q('dq-when'));
    var kind=radio('dq-pay'); if(!kind) return fail('Choose the payment.',box.querySelector('input[name="dq-pay"]'));
    var payment={ kind:kind };
    if(kind!=='none'){
      if(kind!=='waived'){ var c=dqCents(q('dq-fee').value); if(isNaN(c)||c<=0) return fail('Enter the fee before HST, in dollars and cents — or tap a price.',q('dq-fee')); payment.amountCents=c; }
      payment.on=q('dq-paidon').value||today;
    }
    var about=q('dq-about').value.trim(); if(about.length<3) return fail('Say in one short line what the consultation is about.',q('dq-about'));
    var bookedBy=q('dq-bookedby').value; if(!bookedBy) return fail('Choose who booked it.',q('dq-bookedby'));
    if(!existing){
      if(!q('dq-source').value) return fail('Choose the source / reference.',q('dq-source'));
      var refErr=ref.check(); if(refErr){ fail(refErr); ref.focus(); return; }
    }
    var inca=radio('dq-inca');
    if(inca==='No' && !q('dq-country').value) return fail('Choose the country the client is in now (or answer “Not known”).',q('dq-country'));
    var sq=radio('dq-sq');
    if(future() && !sq) return fail('Answer “Already booked in Square?” — Yes or No.',box.querySelector('input[name="dq-sq"]'));
    if(st.blHit){ var ack=q('dq-bl-ack'); if(!(ack&&ack.checked)) return fail('This person is on the Not Wanted list — tick the box above if you mean to add the consultation anyway.'); }
    if(st.live.length && !diffTicked()) return fail('A consultation for this person is already in the app — open it and change its time there, or tick “This is a different consultation”.');
    var body={
      choice:choice, fullName:name, email:email, phone:phone,
      date:s.slice(0,10), time:s.slice(11,16), consultant:q('dq-consultant').value, meetingType:radio('dq-how'), durationMin:Number(q('dq-len').value),
      payment:payment, about:about, caseType:q('dq-casetype').value, bookedBy:bookedBy,
      sourceChannel:existing?'':q('dq-source').value, referredBy:existing?'':ref.value(), referredFrom:existing?'':ref.from(),
      inSquare:future()?(sq==='yes'):null,
      inCanada:inca, currentCountry:inca==='No'?q('dq-country').value:'',
      package:q('dq-pkg').checked, residentialAddress:q('dq-pkg').checked?q('dq-addr').value:'',
      useLeadId:existing?'':(radio('dq-use')||''),
      differentConsultation:diffTicked(),
      blacklistAck:!!(q('dq-bl-ack')&&q('dq-bl-ack').checked),
      clashAck:st.clashAck
    };
    var key=dqKey(); if(!key) return;
    var btn=q('dq-save'); st.saving=true; anywayBtn(true); btn.disabled=true; btn.textContent='Saving…'; dlg.setBusy(true);
    fetch('/api/consultation/direct-consult',{method:'POST',credentials:'same-origin',headers:{'X-Api-Key':key,'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return {s:r.status,j:j}; }); })
      .then(function(res){
        var j=res.j||{};
        st.saving=false; anywayBtn(false);
        if(!dlg.still(run)){   /* closed after the long wait: the outcome is still told, never lost */
          if(res.s===200){ dqShowDone(j.message||'Saved.',j.link,!!(j.left&&j.left.length)); load(true); }
          else dqShowDone((res.s>=500&&res.s!==503)?DQ_CHECK_LIST:('Not saved: '+(j.error||('HTTP '+res.s))),j.link||'',true);
          return;
        }
        dlg.setBusy(false); btn.disabled=false; btn.textContent='Save';
        if(res.s===200){
          dlg.close(true);
          dqShowDone(j.message||'Saved.',j.link,!!(j.left&&j.left.length));
          load(true);
          return;
        }
        if(res.s===409) return showConflict(j);
        if(res.s===401 && j.loginUrl){ q('dq-err').innerHTML=dqEsc(j.error||'Sign in with Monday first.')+' <a href="'+dqEsc(j.loginUrl+'?returnTo='+encodeURIComponent(location.pathname))+'">Sign in with Monday</a>'; return; }
        if(res.s===404) return fail('Direct consultation is switched off — nothing was saved.');
        /* A server error may come after the row was made: never say "nothing was saved". */
        if(res.s>=500 && res.s!==503) return fail(DQ_CHECK_LIST);
        fail(j.error||('Could not save (HTTP '+res.s+') — nothing was saved. Try again.'));
      })
      .catch(function(e){
        st.saving=false; anywayBtn(false);
        if(!dlg.still(run)){ dqShowDone(DQ_CHECK_LIST,'',true); return; }
        dlg.setBusy(false); btn.disabled=false; btn.textContent='Save'; fail('Network error — check the Consultations list before trying again, so it is not added twice.');
      });
  }
  /* What the server found that the pop-up must show: a re-submit, the Not Wanted list, the same consultation, a clash. */
  function showConflict(j){
    var el=q('dq-server');
    if(j.code==='not-wanted' || j.blacklist){ if(j.matches) st.match={ clients:j.matches.clients||[], cases:j.matches.cases||[], leads:j.matches.leads||[], blacklist:j.blacklist }; renderMatch(); return fail(j.error||'This person is on the Not Wanted list.'); }
    if(j.code==='same-consultation'){
      if(j.matches) st.match={ clients:j.matches.clients||[], cases:j.matches.cases||[], leads:j.matches.leads||[], blacklist:st.match&&st.match.blacklist };
      el.innerHTML='<div class="dq-box warn"><div class="dq-t">Is this the consultation already in the app?</div>'+(j.liveBooking||[]).map(function(l){ return '<div class="dq-line"><a href="'+dqEsc(l.link)+'" target="_blank" rel="noopener">'+dqEsc(l.slot)+(l.consultant?' with '+dqEsc(l.consultant):'')+'</a> — '+dqEsc(l.name)+'</div>'; }).join('')+
        '<div class="dq-hint">If it moved in Square, open that record and change its time there.</div>'+
        '<label class="dq-tick"><input type="checkbox" id="dq-diff2"><span>This is a different consultation</span></label></div>';
      renderMatch();
      return fail(j.error||'This looks like a consultation already in the app.');
    }
    if(j.code==='clash'){
      el.innerHTML='<div class="dq-box warn"><div class="dq-t">The consultant is already booked at that time</div>'+(j.clash||[]).map(function(c){ return '<div class="dq-line"><a href="'+dqEsc(c.link||('/admin/consultation/'+encodeURIComponent(c.leadId)))+'" target="_blank" rel="noopener">'+dqEsc(c.slot)+'</a> — '+dqEsc(c.name||('lead '+c.leadId))+(c.consultant?' · '+dqEsc(c.consultant):'')+'</div>'; }).join('')+
        '<div class="dq-hint">Family members can share one time. If this is a different client at the same time, save anyway.</div>'+
        '<div style="margin-top:8px"><button type="button" class="tdlg-btn" id="dq-anyway">Save anyway (different client)</button></div></div>';
      q('dq-anyway').onclick=function(){ st.clashAck=true; save(); };
      return fail(j.error||'The consultant already has a consultation at that time.');
    }
    if(j.code==='already'){
      el.innerHTML=j.link?'<div class="dq-box warn">'+dqEsc(j.error||'Already in the app.')+' <a href="'+dqEsc(j.link)+'">Open it</a></div>':'';
      return fail('Not saved again — it is already in the app.');
    }
    fail(j.error||'Not saved.');
  }
}
`;

module.exports = { DQ_CSS, DQ_JS, DQ_BUTTON_HTML, DQ_DONE_HTML, dqFormHtml };
