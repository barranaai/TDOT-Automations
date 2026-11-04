'use strict';

/**
 * "Attach a screenshot" (Faran 2026-11-04) — the shared browser pieces for the
 * Add lead pop-up (prefix "al"), the Direct retainer pop-up ("dc") and the lead
 * page ("la"). The box shows ONLY for the staff allowed to attach
 * (config/staffAttachments.js — Shafoli), signed in with Monday: the page asks
 * /admin/payments/viewer (canAttach). The server checks again on every upload.
 *
 * Files go one by one to POST /api/leads/:leadId/attachments AFTER the client
 * exists, so a failed upload never fails — or duplicates — the client.
 *
 * TEMPLATE-LITERAL TRAP: ATTACH_UI_JS is browser code inside a Node template
 * literal — no backslashes at all in it, no backticks, no ${ } except the
 * constants injected below. The tests parse the emitted <script>.
 */

const RULES = require('../../config/staffAttachments');

const ACCEPT = Object.keys(RULES.EXTENSIONS).join(',');
const MAX_MB = Math.round(RULES.MAX_FILE_BYTES / 1048576);

const ATTACH_CSS = `
  .att-row{margin-top:10px}
  .att-row input[type=file]{width:100%;font-size:12.5px;padding:6px 0;border:0;background:none}
  .att-hint{font-size:12px;color:#64748b;margin-top:3px;text-transform:none;letter-spacing:0;font-weight:400}
  .att-list{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px;color:#334155}
  .att-list li{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid #f1f5f9}
  .att-list li.bad{color:#b91c1c}
  .att-list .att-size{color:#64748b;flex:none}
  .att-status{font-size:12.5px;margin-top:6px;color:#334155}
  .att-status.err{color:#b91c1c}
  .att-status.ok{color:#166534}
`;

/** The hidden row (label + file input + list). `label` is the visible title. */
function attachFieldHtml(p, { label = 'Attach a screenshot or picture' } = {}) {
  return `
        <div id="${p}-att-row" class="att-row" style="display:none">
          <label class="al-l" for="${p}-att">${label} <span class="att-hint">(optional)</span></label>
          <input id="${p}-att" type="file" multiple accept="${ACCEPT}">
          <div class="att-hint">Pictures (JPG, PNG, HEIC, WEBP) or a PDF · up to ${RULES.MAX_FILES} files, ${MAX_MB} MB each · saved in the client’s folder (Intake), never shown to the client.</div>
          <ul id="${p}-att-list" class="att-list"></ul>
          <div id="${p}-att-status" class="att-status" role="status" aria-live="polite"></div>
        </div>`;
}

const ATTACH_UI_JS = `
var TDOT_ATT_EXT=${JSON.stringify(Object.keys(RULES.EXTENSIONS))}, TDOT_ATT_MAX=${RULES.MAX_FILES}, TDOT_ATT_BYTES=${RULES.MAX_FILE_BYTES}, TDOT_ATT_MB=${MAX_MB};
var TDOT_ATT_VIEWER=null;
function tdotAttViewer(){
  if (TDOT_ATT_VIEWER) return TDOT_ATT_VIEWER;
  var h={}; try { var k=sessionStorage.getItem('tdot_admin_key'); if (k) h['X-Api-Key']=k; } catch (e) {}
  TDOT_ATT_VIEWER=fetch('/admin/payments/viewer',{headers:h,credentials:'same-origin'})
    .then(function(r){ return r.ok ? r.json() : {}; }).catch(function(){ return {}; });
  return TDOT_ATT_VIEWER;
}
function tdotAttExt(name){ var m=/[.][a-zA-Z0-9]{1,5}$/.exec(String(name||'')); return m ? m[0].toLowerCase() : ''; }
function tdotAttSize(n){ return n>=1048576 ? (Math.round(n/104857.6)/10)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }
function tdotAttach(p){
  function el(id){ return document.getElementById(p+'-'+id); }
  var row=el('att-row'), input=el('att'), list=el('att-list'), status=el('att-status');
  var allowed=false;
  function setStatus(t,cls){ if (!status) return; status.textContent=t||''; status.className='att-status'+(cls?' '+cls:''); }
  function files(){ return (input && input.files) ? Array.prototype.slice.call(input.files) : []; }
  function problem(f){
    if (TDOT_ATT_EXT.indexOf(tdotAttExt(f.name))<0) return 'not a picture or PDF';
    if (f.size>TDOT_ATT_BYTES) return 'over '+TDOT_ATT_MB+' MB';
    if (!f.size) return 'empty file';
    return '';
  }
  function draw(){
    if (!list) return;
    list.innerHTML='';
    files().forEach(function(f){
      var li=document.createElement('li'); var bad=problem(f);
      if (bad) li.className='bad';
      var n=document.createElement('span'); n.textContent=f.name+(bad?' — '+bad:'');
      var s=document.createElement('span'); s.className='att-size'; s.textContent=tdotAttSize(f.size);
      li.appendChild(n); li.appendChild(s); list.appendChild(li);
    });
    setStatus('');
  }
  if (input) input.addEventListener('change',draw);
  function reset(){ if (input) input.value=''; draw(); }
  function check(){
    if (!allowed) return '';
    var fs=files();
    if (fs.length>TDOT_ATT_MAX) return 'Attach at most '+TDOT_ATT_MAX+' files.';
    for (var i=0;i<fs.length;i++){ var b=problem(fs[i]); if (b) return 'Remove '+fs[i].name+' ('+b+') from the attachments.'; }
    return '';
  }
  function uploadOne(leadId,f){
    var fd=new FormData(); fd.append('file',f,f.name);
    var h={}; try { var k=sessionStorage.getItem('tdot_admin_key'); if (k) h['X-Api-Key']=k; } catch (e) {}
    return fetch('/api/leads/'+encodeURIComponent(leadId)+'/attachments',{method:'POST',headers:h,body:fd,credentials:'same-origin'})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok:r.ok, error:(j&&j.error)||('HTTP '+r.status) }; }); })
      .catch(function(){ return { ok:false, error:'network error' }; });
  }
  /* Uploads the chosen files one after another. Resolves {sent, failed:[{name,error}]} — never rejects. */
  function upload(leadId){
    var fs=allowed ? files() : [];
    var out={ sent:0, failed:[] };
    if (!fs.length || !leadId) return Promise.resolve(out);
    var i=0;
    function next(){
      if (i>=fs.length) return Promise.resolve(out);
      var f=fs[i++];
      setStatus('Attaching '+i+' of '+fs.length+'…');
      return uploadOne(leadId,f).then(function(r){ if (r.ok) out.sent++; else out.failed.push({ name:f.name, error:r.error }); return next(); });
    }
    return next().then(function(o){
      if (o.failed.length) setStatus(o.failed.length+' of '+fs.length+' not attached: '+o.failed.map(function(x){ return x.name+' ('+x.error+')'; }).join('; '),'err');
      else setStatus(o.sent+' attached.','ok');
      return o;
    });
  }
  var ready=tdotAttViewer().then(function(v){ allowed=!!(v&&v.canAttach); if (row) row.style.display=allowed?'':'none'; return allowed; });
  return { reset:reset, check:check, upload:upload, files:function(){ return allowed ? files() : []; }, allowed:function(){ return allowed; }, ready:ready, setStatus:setStatus };
}
`;

module.exports = { ATTACH_CSS, ATTACH_UI_JS, attachFieldHtml, ACCEPT, MAX_MB };
