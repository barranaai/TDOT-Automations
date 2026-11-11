'use strict';

/**
 * The lists that moved onto the shared filter engine (listFilters.js) on 2026-11-05 —
 * Consultations, Retainers & follow-ups, Cases. For each: a spec (what a row's values
 * are, how it sorts, what the search reads) and the page options (ids, columns).
 *
 * The rule for the move: the SAME filters giving the SAME rows, only in the column
 * headers. Where an old drop-down choice covered two values ("Paid (any way)" = app +
 * recorded by staff; follow-up "has a date" = due + later), the row gets one value and
 * the old choice is the two ticks together (test/listSpecs.test.js proves each against
 * a frozen copy of the old filter).
 *
 * Plain browser JavaScript injected with Function#toString: each function takes the
 * page context CTX (passed by listTableScript) and refers to nothing outside itself.
 */

/* eslint-disable no-var */

/* The consultation fee, one value per row: app | staff | waived | none.
   ctx.directNa: a direct retainer client with no consultation payment reads "na" (no consultation). */
function consultListSpec(ctx) {
  function s(v) { return String(v == null ? '' : v).trim(); }
  function day(r) { var d = s(r.bookedSlot).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; }
  function today() { return (ctx && ctx.today) ? ctx.today() : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); }
  return {
    facets: {
      consultant: { label: 'Consultant', get: function (r) { return s(r.consultant); }, none: 'Unassigned' },
      mode: { label: 'Mode', get: function (r) { return s(r.meetingType); }, none: 'Not set', order: ['In-person', 'Virtual', 'Phone Call'] },
      agreement: { label: 'Agreement', get: function (r) { return r.agreementSigned ? 'signed' : r.agreementSent ? 'sent' : 'none'; },
        text: function (v) { return ({ signed: 'Signed', sent: 'Sent, not signed', none: 'Not sent' })[v] || v; }, order: ['signed', 'sent', 'none'], fixed: true },
      paid: { label: 'Paid', get: function (r) { return !s(r.paid) ? 'none' : r.paid === 'waived' ? 'waived' : r.paid === 'app' ? 'app' : 'staff'; },
        text: function (v) { return ({ app: 'Paid (app)', staff: 'Paid — recorded by staff', waived: 'Waived', none: 'Not paid' })[v] || v; }, order: ['app', 'staff', 'waived', 'none'], fixed: true },
      // Every column filters, like the Leads list (Faran 2026-11-11).
      service: { label: 'Service', get: function (r) { return s(r.service); }, none: 'Not set' },
      preconsult: { label: 'Pre-consult', get: function (r) { return r.preConsultSubmitted ? 'submitted' : 'pending'; },
        text: function (v) { return ({ submitted: 'Submitted', pending: 'Pending' })[v] || v; }, order: ['submitted', 'pending'], fixed: true },
      outcome: { label: 'Outcome', get: function (r) { return s(r.outcome); }, none: 'No outcome yet', order: ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted'] },
      // Completed consultations (2026-11-11): where the client is now — the "Now" column of the month groups.
      now: { label: 'Now (completed consultations)', get: function (r) { return r.done ? s(r.now) : 'upcoming'; },
        text: function (v) { return v === 'upcoming' ? 'Not completed yet' : v; }, order: ['Retained', 'Retainer paid', 'Retainer signed', 'Retainer sent', 'Retainer to send', 'Following up', 'Newsletter list', 'Closed', 'Existing client', 'upcoming'] },
    },
    // The column names sort, like the Leads list (Faran 2026-11-11). No column chosen = the server order.
    sorts: {
      date: function (r) { return s(r.bookedSlot); },                 // the day, then the time within it
      time: function (r) { return s(r.bookedSlot).slice(11, 16); },   // the time of day
      client: function (r) { return s(r.name).toLowerCase(); },
      service: function (r) { return s(r.service).toLowerCase(); },
      consultant: function (r) { return s(r.consultant).toLowerCase(); },
    },
    sortBlanksLast: ['service', 'consultant'],
    defaultSort: null,   // the server order: earliest consultation first
    // The Date column's filter (Faran 2026-11-11 — it replaced the Today / This week / This month / All buttons): the
    // consultation's Toronto day, with choices that look ahead. The two lists beside the table are never hidden by it:
    // "No date" (no day to compare) and "Needs outcome" (the day has passed, nothing recorded — the page's consultBucket rule).
    date: { key: 'date', chip: 'Date', get: day,
      presets: [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['nextweek', 'Next week'], ['fullmonth', 'This month']],
      // …and the completed ones (2026-11-11) sit in their own month groups, which are the way through the past.
      exempt: function (r) { var d = day(r); return !!r.done || !d || (d < today() && !s(r.outcome) && r.direct !== 'Existing client'); } },
    search: { chip: 'Search', text: function (r) { return r.name; }, id: function (r) { return r.id; } },
  };
}
function consultListOpts(ctx) {
  return {
    key: 'tdot_list_consultations',
    ids: { head: 'cq-headrow', chips: 'cq-chips', count: 'cq-count', search: 'cq-search', pop: 'cq-pop' },
    serverSearch: '/api/leads/search',   // name, phone or email (step 3, 2026-11-09)
    render: 'renderConsultList', api: 'ConsultTable',
    sortReset: 'earliest consultation first',   // a column sort shows as a chip; its × goes back to the normal order
    defaultDate: 'today',   // a new browser tab opens on today's consultations (Faran 2026-11-11); the chip's × shows every date
    cols: [
      { id: 'date', label: 'Date', title: 'The consultation day, Toronto time', menu: 'date', date: true, sort: 'date', sortText: ['Earliest first', 'Latest first'], sortDirs: ['asc', 'desc'] },
      { id: 'time', label: 'Time', title: 'The consultation time, Toronto', sort: 'time', sortText: ['Earliest in the day first', 'Latest in the day first'], sortDirs: ['asc', 'desc'] },
      { id: 'client', label: 'Client', sort: 'client', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
      { id: 'service', label: 'Service', menu: 'facet', facets: ['service'], sort: 'service', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
      { id: 'consultant', label: 'Consultant', menu: 'facet', facets: ['consultant'], sort: 'consultant', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
      { id: 'mode', label: 'Mode', menu: 'facet', facets: ['mode'] },
      { id: 'agreement', label: 'Agreement', menu: 'facet', facets: ['agreement'] },
      { id: 'preconsult', label: 'Pre-consult', menu: 'facet', facets: ['preconsult'] },
      { id: 'paid', label: 'Paid', title: 'The consultation fee', menu: 'facet', facets: ['paid'] },
      { id: 'outcome', label: 'Outcome', menu: 'facet', facets: ['outcome', 'now'] },
      { id: 'del', label: '' },
    ],
  };
}

/* ctx: { outcomes: the tabs — the four outcome labels (config/outcomes), plus 'Retained' on the Retainers page (2026-11-05),
          apart: the tabs never counted under All (['Retained']), today(): the Toronto day, hints: { outcome: text }, initial(state), onChange(state) } */
function retainerListSpec(ctx) {
  function s(v) { return String(v == null ? '' : v).trim(); }
  var OUT = ctx.outcomes || [];
  return {
    facets: {
      kind: { label: 'Client', get: function (r) { return s(r.kind); }, none: 'Not set',
        text: function (v) { return ({ direct: 'Direct retainer clients', booked: 'After a consultation' })[v] || v; }, order: ['direct', 'booked'], fixed: true },
      consultant: { label: 'Consultant', get: function (r) { return s(r.consultant); }, none: 'Unassigned' },
      followUp: { label: 'Follow-up', get: function (r) { var d = s(r.followUpDate); return !d ? 'none' : d <= ctx.today() ? 'due' : 'later'; },
        text: function (v) { return ({ due: 'Due (today or earlier)', later: 'Later', none: 'No follow-up date' })[v] || v; }, order: ['due', 'later', 'none'], fixed: true },
      // A direct retainer client had no consultation: under no fee choice unless a fee was recorded (the old rule).
      paid: { label: 'Consult fee', get: function (r) { return (r.kind === 'direct' && !s(r.paid)) ? 'na' : !s(r.paid) ? 'none' : r.paid === 'waived' ? 'waived' : r.paid === 'app' ? 'app' : 'staff'; },
        text: function (v) { return ({ app: 'Paid (app)', staff: 'Paid — recorded by staff', waived: 'Waived', none: 'Not paid', na: 'No consultation (direct)' })[v] || v; }, order: ['app', 'staff', 'waived', 'none', 'na'], fixed: true },
      stage: { label: 'Stage', get: function (r) { return s(r.stage); }, none: 'No stage', order: ['New', 'Retain', 'Fee set', 'Sent', 'Signed', 'Paid'] },
      // The tabs above the table: one per outcome (+ Retained); a row without a group counts under the first (Retain).
      // Retained rows are kept apart: only on their own tab, never under All (All = everyone still being worked).
      outcome: { label: 'Outcome', quick: true, get: function (r) { return OUT.indexOf(r.outcomeGroup) >= 0 ? r.outcomeGroup : OUT[0]; }, order: OUT, apart: ctx.apart || [] },
    },
    sorts: {},
    defaultSort: null,   // the server order: by stage, then date
    search: { chip: 'Search', text: function (r) { return r.name; }, id: function (r) { return r.id; } },
  };
}
function retainerListOpts(ctx) {
  return {
    key: 'tdot_list_retainers',
    ids: { head: 'rq-headrow', chips: 'rq-chips', count: 'r-count', search: 'rq-search', pop: 'rq-pop' },
    serverSearch: '/api/leads/search',   // name, phone or email (step 3, 2026-11-09)
    render: 'renderRetainerList', api: 'RetainerTable',
    initial: ctx.initial, onChange: ctx.onChange,
    // Tabs, like the Leads page (team meeting 2026-11-05, point 7): one outcome at a time, "All" last; a new browser tab
    // opens on Retain; the tab shown is kept until the browser tab is closed. A link's ?outcome= opens that tab (and keeps it).
    quick: { facet: 'outcome', box: 'r-quick', tabs: true, allLast: true, all: 'All', storeKey: 'tdot_list_retainers_tab', default: (ctx.outcomes || [])[0],
      values: ctx.outcomes || [], hints: ctx.hints || {} },
    cols: [
      { id: 'client', label: 'Client', menu: 'facet', facets: ['kind'] },
      { id: 'casetype', label: 'Case type' },
      { id: 'consultant', label: 'Consultant', menu: 'facet', facets: ['consultant'] },
      { id: 'outcome', label: 'Outcome', title: 'The outcome tabs are above the table; here: the follow-up date', menu: 'facet', facets: ['followUp'] },
      { id: 'fee', label: 'Consult fee', menu: 'facet', facets: ['paid'] },
      { id: 'retfee', label: 'Retainer fee' },
      { id: 'sent', label: 'Sent' },
      { id: 'signed', label: 'Signed' },
      { id: 'paidon', label: 'Paid' },
      { id: 'stage', label: 'Stage', menu: 'facet', facets: ['stage'] },
      { id: 'case', label: 'Case' },
      { id: 'del', label: '' },
    ],
  };
}

/* ctx: { healthOrder: { Red: 0, Orange: 1, Green: 2 },
          views: the Client Master view tabs (clientMasterViews.pageViews(): [{ key, label, hint }…]), initial(state), onChange(state) } */
function casesListSpec(ctx) {
  function s(v) { return String(v == null ? '' : v).trim(); }
  var HO = ctx.healthOrder || { Red: 0, Orange: 1, Green: 2 };
  function health(v) { return HO[v] !== undefined ? HO[v] : 2; }
  function num(v) { var n = Number(v); return (v === '' || v == null || isNaN(n)) ? -Infinity : n; }
  function txt(v) { return s(v).toLowerCase(); }
  /* "Phase 8" before "Phase 11": numbers inside the text compare as numbers */
  function natural(v) { return txt(v).replace(/[0-9]+/g, function (d) { return ('00000' + d).slice(-6); }); }
  var VIEWS = ctx.views || [], VK = VIEWS.map(function (v) { return v.key; }), VL = {};
  VIEWS.forEach(function (v) { VL[v.key] = v.label; });
  return {
    facets: {
      stage: { label: 'Stage', get: function (r) { return s(r.caseStage); }, none: 'No stage' },
      health: { label: 'Health', get: function (r) { return s(r.health); }, none: 'Not set', order: ['Red', 'Orange', 'Green'], fixed: true },
      // A case can have several managers ("A, B"): each is its own choice; whole names only.
      manager: { label: 'Manager', get: function (r) { return s(r.manager).split(',').map(s).filter(function (m) { return m && m !== 'Unassigned'; }); }, none: 'Unassigned' },
      // The view tabs above the table (block 3): a row is in every Monday view it passes (worked out on the server).
      view: { label: 'View', quick: true, fixed: true, order: VK, text: function (v) { return VL[v] || v; }, get: function (r) { return r.views || []; }, none: 'No view' },
    },
    sorts: {
      createdAt: function (r) { return s(r.createdAt); },
      caseRef: function (r) { return txt(r.caseRef); },
      clientName: function (r) { return txt(r.clientName); },
      caseType: function (r) { return txt(r.caseType); },
      caseStage: function (r) { return txt(r.caseStage); },
      phase: function (r) { return natural(r.phase); },
      actualDeadline: function (r) { return s(r.actualDeadline); },
      promisedDate: function (r) { return s(r.promisedDate); },
      health: function (r) { return health(r.health); },
      slaRisk: function (r) { return health(r.slaRisk); },
      officer: function (r) { return txt(r.officer); },
      manager: function (r) { return txt(r.manager); },
      overallReadiness: function (r) { return num(r.overallReadiness); },
      daysElapsed: function (r) { return num(r.daysElapsed); },
    },
    // a case with no date / phase / officer goes last, whichever way the column sorts (A → Z must not open on every blank)
    sortBlanksLast: ['actualDeadline', 'promisedDate', 'phase', 'officer'],
    defaultSort: { key: 'createdAt', dir: 'desc' },   // newest case first
    search: { chip: 'Search', text: function (r) { return [r.clientName, r.caseRef, r.caseType, r.officer]; } },
  };
}
function casesListOpts(ctx) {
  var AZ = ['A → Z', 'Z → A'], ASC = ['asc', 'desc'], SOON = ['Soonest first', 'Latest first'];
  var VIEWS = ctx.views || [], hints = {};
  VIEWS.forEach(function (v) { if (v.hint) hints[v.key] = v.hint; });
  return {
    key: 'tdot_list_cases',
    ids: { head: 'cs-headrow', chips: 'cs-chips', count: 'table-count', search: 'search-box', pop: 'cs-pop' },
    render: 'renderCasesList', api: 'CasesTable',
    initial: ctx.initial, onChange: ctx.onChange,
    /* The view tabs (block 3): All first (every case, newest first), then one per Monday view. No default: a new browser
       tab opens on All; the tab shown is kept until the browser tab is closed. A link's ?view= opens that tab. */
    quick: { facet: 'view', box: 'cs-quick', tabs: true, allLast: false, all: 'All', storeKey: 'tdot_list_cases_tab',
      values: VIEWS.map(function (v) { return v.key; }), hints: hints },
    /* No column sorts by the creation time (All) or by Monday's order (a view tab): a column sort shows as a chip whose × goes back. */
    sortReset: function (st) { var v = st && st.sel && st.sel.view; return v && v.length ? "Monday's order for this view" : 'newest case first'; },
    countText: function (shown, total) { return shown + (shown !== total ? ' of ' + total : '') + ' case' + (total !== 1 ? 's' : ''); },
    cols: [
      { id: 'caseRef', label: 'Case Ref', sort: 'caseRef', sortText: AZ, sortDirs: ASC },
      { id: 'clientName', label: 'Client', sort: 'clientName', sortText: AZ, sortDirs: ASC },
      { id: 'caseType', label: 'Type', sort: 'caseType', sortText: AZ, sortDirs: ASC },
      { id: 'caseStage', label: 'Stage', menu: 'facet', facets: ['stage'], sort: 'caseStage', sortText: AZ, sortDirs: ASC },
      { id: 'phase', label: 'Phase', sort: 'phase', sortText: AZ, sortDirs: ASC },
      { id: 'deadline', label: 'Deadline', title: 'Deadline Type (Real or Imaginary), the Actual Deadline, and its half-month window', sort: 'actualDeadline', sortText: SOON, sortDirs: ASC },
      { id: 'promised', label: 'Promised', title: 'The Internal Deadline (the date promised on an Imaginary deadline)', sort: 'promisedDate', sortText: SOON, sortDirs: ASC },
      { id: 'health', label: 'Health', menu: 'facet', facets: ['health'], sort: 'health', sortText: ['Red first', 'Green first'], sortDirs: ASC },
      { id: 'slaRisk', label: 'SLA Risk', sort: 'slaRisk', sortText: ['Red first', 'Green first'], sortDirs: ASC },
      { id: 'officer', label: 'Support Officer', title: 'Case Support Officer', sort: 'officer', sortText: AZ, sortDirs: ASC },
      { id: 'manager', label: 'Manager', menu: 'facet', facets: ['manager'], sort: 'manager', sortText: AZ, sortDirs: ASC },
      { id: 'overallReadiness', label: 'Readiness', sort: 'overallReadiness', sortText: ['Highest first', 'Lowest first'], sortDirs: ['desc', 'asc'] },
      { id: 'daysElapsed', label: 'Days', sort: 'daysElapsed', sortText: ['Most first', 'Fewest first'], sortDirs: ['desc', 'asc'] },
      { id: 'status', label: 'Status' },
      { id: 'del', label: '' },
    ],
  };
}

module.exports = { consultListSpec, consultListOpts, retainerListSpec, retainerListOpts, casesListSpec, casesListOpts };
