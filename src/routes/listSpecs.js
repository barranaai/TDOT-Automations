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
  /* The page's four tabs (Faran 2026-11-12), each consultation under exactly one:
     done   — completed (the server marks it: an outcome, a retainer under way, or retained)
     nodate — marked Booked by hand with no consultation time
     needs  — its day has passed and no outcome is recorded (a direct consultation about an existing client's file has none to set)
     booked — everything else: still to happen */
  function bucket(r) {
    if (r.done) return 'done';
    var d = day(r); if (!d) return 'nodate';
    if (d < today() && !s(r.outcome) && r.direct !== 'Existing client') return 'needs';
    return 'booked';
  }
  /* One meaning order per column, used by its filter list AND its sort (Faran 2026-11-12: filters and sorting on every column). */
  var MODES = ['In-person', 'Virtual', 'Phone Call'], AGREEMENTS = ['signed', 'sent', 'none'], PRECONSULTS = ['submitted', 'pending'],
    PAIDS = ['app', 'staff', 'waived', 'none'], OUTCOMES = ['Retain', 'Follow-Up', 'Newsletter', 'Not Wanted'],
    NOWS = ['Retained', 'Retainer paid', 'Retainer signed', 'Retainer sent', 'Retainer to send', 'Following up', 'Newsletter list', 'Closed', 'Existing client', 'upcoming'],
    TIMES = ['morning', 'afternoon', 'evening', 'none'];
  function agreementOf(r) { return r.agreementSigned ? 'signed' : r.agreementSent ? 'sent' : 'none'; }
  function preconsultOf(r) { return r.preConsultSubmitted ? 'submitted' : 'pending'; }
  function paidOf(r) { return !s(r.paid) ? 'none' : r.paid === 'waived' ? 'waived' : r.paid === 'app' ? 'app' : 'staff'; }
  /* The part of the day, from the Toronto wall-clock time kept in bookedSlot ('YYYY-MM-DD HH:MM'):
     morning before 12:00, afternoon 12:00 to before 17:00, evening 17:00 and later; no slot or no time part = none. */
  function timeOf(r) {
    var t = day(r) ? s(r.bookedSlot).slice(11, 16) : '';
    if (!/^\d{2}:\d{2}$/.test(t)) return 'none';
    return t < '12:00' ? 'morning' : t < '17:00' ? 'afternoon' : 'evening';
  }
  /* A sort value in a column's meaning order: its place in the list, then the text (a value the list does not know comes
     after the known ones, A → Z); '' for a blank — the blank ones go last both ways (sortBlanksLast). */
  function ranked(list, v) { v = s(v); if (!v) return ''; var i = list.indexOf(v); return ('0' + (i < 0 ? 99 : i)).slice(-2) + ' ' + v.toLowerCase(); }
  return {
    facets: {
      consultant: { label: 'Consultant', get: function (r) { return s(r.consultant); }, none: 'Unassigned' },
      mode: { label: 'Mode', get: function (r) { return s(r.meetingType); }, none: 'Not set', order: MODES },
      agreement: { label: 'Agreement', get: agreementOf,
        text: function (v) { return ({ signed: 'Signed', sent: 'Sent, not signed', none: 'Not sent' })[v] || v; }, order: AGREEMENTS, fixed: true },
      paid: { label: 'Paid', get: paidOf,
        text: function (v) { return ({ app: 'Paid (app)', staff: 'Paid — recorded by staff', waived: 'Waived', none: 'Not paid' })[v] || v; }, order: PAIDS, fixed: true },
      // Every column filters, like the Leads list (Faran 2026-11-11).
      service: { label: 'Service', get: function (r) { return s(r.service); }, none: 'Not set' },
      preconsult: { label: 'Pre-consult', get: preconsultOf,
        text: function (v) { return ({ submitted: 'Submitted', pending: 'Pending' })[v] || v; }, order: PRECONSULTS, fixed: true },
      outcome: { label: 'Outcome', get: function (r) { return s(r.outcome); }, none: 'No outcome yet', order: OUTCOMES },
      // Completed consultations (2026-11-11): where the client is now — the "Now" column of the Completed tab.
      now: { label: 'Now', get: function (r) { return r.done ? s(r.now) : 'upcoming'; },
        text: function (v) { return v === 'upcoming' ? 'Not completed yet' : v; }, order: NOWS,
        onlyOn: ['done'] },   // the Completed (and All) column: the numbers on the other tabs are counted without it — the page drops it when one is opened
      // The Time column's filter (Faran 2026-11-12): the part of the day — always these four, in this order.
      time: { label: 'Time', get: timeOf,
        text: function (v) { return ({ morning: 'Morning (before 12:00)', afternoon: 'Afternoon (12:00 to 16:59)', evening: 'Evening (17:00 and later)', none: 'No time' })[v] || v; }, order: TIMES, fixed: true },
      // The tabs above the table (Faran 2026-11-12): four lists, one at a time, and All last (the four together).
      tab: { label: 'List', quick: true, get: bucket, order: ['booked', 'needs', 'done', 'nodate'],
        text: function (v) { return ({ booked: 'Booked', needs: 'Needs outcome', done: 'Completed', nodate: 'No date' })[v] || v; } },
    },
    // Every column name sorts (Faran 2026-11-11; all of them since 2026-11-12). No column chosen = the server order.
    sorts: {
      date: function (r) { return s(r.bookedSlot); },                 // the day, then the time within it
      time: function (r) { return s(r.bookedSlot).slice(11, 16); },   // the time of day
      client: function (r) { return s(r.name).toLowerCase(); },
      service: function (r) { return s(r.service).toLowerCase(); },
      consultant: function (r) { return s(r.consultant).toLowerCase(); },
      // The status columns sort in the order their filter lists them (Signed, Sent, Not sent …), never A → Z.
      mode: function (r) { return ranked(MODES, r.meetingType); },
      agreement: function (r) { return ranked(AGREEMENTS, agreementOf(r)); },
      preconsult: function (r) { return ranked(PRECONSULTS, preconsultOf(r)); },
      paid: function (r) { return ranked(PAIDS, paidOf(r)); },
      outcome: function (r) { return ranked(OUTCOMES, r.outcome); },
      now: function (r) { return r.done ? ranked(NOWS, r.now) : ''; },   // not completed yet: an empty cell — last both ways
    },
    sortBlanksLast: ['service', 'consultant', 'mode', 'outcome', 'now'],
    defaultSort: null,   // the server order: earliest consultation first
    // The Date column's filter (Faran 2026-11-11 — it replaced the Today / This week / This month / All buttons): the
    // consultation's Toronto day, with choices that look ahead. Since 2026-11-12 every tab has its OWN date range
    // (Booked, Needs outcome, Completed and All — "No date" has no dates, so no date filter): the range of the tab on
    // view narrows that tab's rows, and each tab's number is counted with that tab's own range. On All the range
    // narrows every row (one with no date is hidden while a range is on). A range kept before this was Booked's.
    date: { key: 'date', chip: 'Date', get: day,
      presets: [['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'This week'], ['nextweek', 'Next week'], ['fullmonth', 'This month']],
      // The quick choices fit the tab (review 2026-11-12): Booked looks ahead; Needs outcome and Completed hold past days, so they look back.
      presetsBy: {
        needs: [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month']],
        done: [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month']],
        all: [['today', 'Today'], ['week', 'This week'], ['fullmonth', 'This month'], ['30d', 'Last 30 days'], ['lastmonth', 'Last month']],
      },
      per: { facet: 'tab', all: 'all', none: ['nodate'], legacy: 'booked' } },
    search: { chip: 'Search', text: function (r) { return r.name; }, id: function (r) { return r.id; } },
  };
}
function consultListOpts(ctx) {
  var AZ = ['A → Z', 'Z → A'], ASC = ['asc', 'desc'];
  return {
    key: 'tdot_list_consultations',
    ids: { head: 'cq-headrow', chips: 'cq-chips', count: 'cq-count', search: 'cq-search', pop: 'cq-pop' },
    serverSearch: '/api/leads/search',   // name, phone or email (step 3, 2026-11-09)
    render: 'renderConsultList', api: 'ConsultTable',
    sortReset: 'earliest consultation first',   // a column sort shows as a chip; its × goes back to the normal order
    onChange: ctx && ctx.onChange,   // the page keeps "Now" (filter and sort) to the tabs that show the column
    panelCountable: 'consultPanelRow',   // the numbers inside a filter panel count the month on view (Completed / All), like the table
    // A new browser tab opens the Booked tab on today's consultations (Faran 2026-11-11); the chip's × shows every date.
    // The other tabs open on every date; each keeps its own range (2026-11-12).
    defaultDate: 'today', defaultDateScope: 'booked',
    // Four tabs and All, like the Leads page (Faran 2026-11-12): a new browser tab opens on Booked; the tab shown is kept until it is closed.
    quick: { facet: 'tab', box: 'cq-tabs', tabs: true, allLast: true, all: 'All', default: 'booked', storeKey: 'tdot_list_consult_tab4', values: ['booked', 'needs', 'done', 'nodate'],
      hints: { booked: 'Consultations still to happen — the Date filter chooses the days', needs: 'The consultation day has passed and no outcome is recorded',
        done: 'Completed consultations, one month at a time — also after the client is retained and has a case', nodate: 'Marked Booked by hand with no consultation time',
        '': 'The four lists together' } },
    cols: [
      { id: 'date', label: 'Date', title: 'The consultation day, Toronto time', menu: 'date', date: true, sort: 'date', sortText: ['Earliest first', 'Latest first'], sortDirs: ASC },
      { id: 'time', label: 'Time', title: 'The consultation time, Toronto', menu: 'facet', facets: ['time'], sort: 'time', sortText: ['Earliest in the day first', 'Latest in the day first'], sortDirs: ASC },
      // like the Leads list's "Lead" column: the sort, and a pointer to the search box (no list of names to tick)
      { id: 'client', label: 'Client', menu: 'lead', note: 'To filter by client, use the search box above the table (name, phone or email).', sort: 'client', sortText: AZ, sortDirs: ASC },
      { id: 'service', label: 'Service', menu: 'facet', facets: ['service'], sort: 'service', sortText: AZ, sortDirs: ASC },
      { id: 'consultant', label: 'Consultant', menu: 'facet', facets: ['consultant'], sort: 'consultant', sortText: AZ, sortDirs: ASC },
      { id: 'mode', label: 'Mode', menu: 'facet', facets: ['mode'], sort: 'mode', sortText: ['In-person first', 'Phone call first'], sortDirs: ASC },
      { id: 'agreement', label: 'Agreement', menu: 'facet', facets: ['agreement'], sort: 'agreement', sortText: ['Signed first', 'Not sent first'], sortDirs: ASC },
      { id: 'preconsult', label: 'Pre-consult', menu: 'facet', facets: ['preconsult'], sort: 'preconsult', sortText: ['Submitted first', 'Pending first'], sortDirs: ASC },
      { id: 'paid', label: 'Paid', title: 'The consultation fee', menu: 'facet', facets: ['paid'], sort: 'paid', sortText: ['Paid first', 'Not paid first'], sortDirs: ASC },
      { id: 'outcome', label: 'Outcome', menu: 'facet', facets: ['outcome'], sort: 'outcome', sortText: ['Retain first', 'Not Wanted first'], sortDirs: ASC },
      { id: 'now', label: 'Now', title: 'Where the client is now (the Completed tab)', menu: 'facet', facets: ['now'], sort: 'now', sortText: ['Retained first', 'Retained last'], sortDirs: ASC },
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
          views: the Client Master view tabs (clientMasterViews.pageViews(): [{ key, label, hint }…]), initial(state), onChange(state),
          meta(): the board meta of the data on the page ({ stageOrder, phaseOrder } — label indexes in board order) or null,
          typeOf(r): 'real' | 'imaginary' | 'none' (clientMasterWindows.typeOf) }
   The view tabs (Assigning, Deadlines, EE after ITA) have their own columns since 2026-11-12 (team meeting 2026-11-10, item 12):
   the agreed twenty, one column each. The All tab keeps the columns it had. A column's `tabs` says where it shows. */
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
  /* A cell of names ("A, B"): each name is its own choice; whole names only. */
  function names(v) { return s(v).split(',').map(s).filter(function (m) { return m && m !== 'Unassigned'; }); }
  function dtype(r) { if (ctx.typeOf) return ctx.typeOf(r); var t = s(r.deadlineType); return t === 'Deadline' ? 'real' : t === 'Imaginary' ? 'imaginary' : 'none'; }
  /* A status column sorted in the board's own label order (the order Monday lists the labels in), where the board meta is
     on the page; without it A → Z (the phases with their numbers as numbers). An empty cell is blank — last both ways. */
  function boardRank(orderKey, idxKey, r, text) {
    var i = r[idxKey];
    if (typeof i !== 'number' || i === 5 || !text) return '';   // Monday: an empty status cell = label index 5
    var m = ctx.meta ? ctx.meta() : null, order = m && m[orderKey];
    if (!order || !order.length) return text;
    var at = order.indexOf(i);
    return ('000' + (at < 0 ? 999 : at)).slice(-3) + ' ' + text;
  }
  function pct(v) { var n = Number(v); return (v === '' || v == null || isNaN(n)) ? null : n; }
  return {
    facets: {
      stage: { label: 'Stage', get: function (r) { return s(r.caseStage); }, none: 'No stage' },
      health: { label: 'Health', get: function (r) { return s(r.health); }, none: 'Not set', order: ['Red', 'Orange', 'Green'], fixed: true },
      // A case can have several managers ("A, B"): each is its own choice; whole names only.
      manager: { label: 'Manager', get: function (r) { return s(r.manager).split(',').map(s).filter(function (m) { return m && m !== 'Unassigned'; }); }, none: 'Unassigned' },
      // The view tabs' columns (2026-11-12): the label-like ones filter, like every list.
      caseType: { label: 'Case type', get: function (r) { var t = s(r.caseType); return t === 'Unknown' ? '' : t; }, none: 'No case type' },
      subType: { label: 'Sub-type', get: function (r) { return s(r.caseSubType); }, none: 'No sub-type' },
      deadlineType: { label: 'Deadline type', get: dtype, order: ['real', 'imaginary', 'none'], fixed: true,
        text: function (v) { return ({ real: 'Real', imaginary: 'Imaginary', none: 'Not recorded' })[v] || v; } },
      phase: { label: 'Phase', get: function (r) { return s(r.phase); }, none: 'No phase', natural: true },
      retainedBy: { label: 'Retained by', get: function (r) { return names(r.retainedBy); }, none: 'Nobody' },
      retainerStatus: { label: 'Retainer status', get: function (r) { return s(r.retainerStatus); }, none: 'Not set' },
      paymentStatus: { label: 'Payment status', get: function (r) { return s(r.paymentStatus); }, none: 'Not set' },
      officer: { label: 'Support officer', get: function (r) { return names(r.officer); }, none: 'Nobody' },
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
      // The view tabs' columns (2026-11-12). Text A → Z; a percentage as a number; a status in the board's label order where
      // the page knows it (Stage, Phase), Real before Imaginary, else A → Z. Blanks last both ways (sortBlanksLast).
      dependents: function (r) { return txt(r.dependents); },
      clientEmail: function (r) { return txt(r.clientEmail); },
      clientPhone: function (r) { return s(r.clientPhone).replace(/[^0-9]/g, ''); },
      caseTypeV: function (r) { var t = txt(r.caseType); return t === 'unknown' ? '' : t; },
      subType: function (r) { return txt(r.caseSubType); },
      deadlineType: function (r) { var t = dtype(r); return t === 'real' ? '0' : t === 'imaginary' ? '1' : ''; },
      phaseBoard: function (r) { return boardRank('phaseOrder', 'phaseIdx', r, natural(r.phase)); },
      stageBoard: function (r) { return boardRank('stageOrder', 'stageIdx', r, txt(r.caseStage)); },
      retainedBy: function (r) { return txt(r.retainedBy); },
      retainerStatus: function (r) { return txt(r.retainerStatus); },
      paymentStatus: function (r) { return txt(r.paymentStatus); },
      managerV: function (r) { var t = txt(r.manager); return t === 'unassigned' ? '' : t; },
      qPct: function (r) { return pct(r.qReadinessPct); },
      docPct: function (r) { return pct(r.docUploadedPct); },
    },
    // a case with no date / phase / officer goes last, whichever way the column sorts (A → Z must not open on every blank)
    sortBlanksLast: ['actualDeadline', 'promisedDate', 'phase', 'officer',
      'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'deadlineType', 'phaseBoard', 'stageBoard', 'retainedBy', 'retainerStatus', 'paymentStatus', 'managerV', 'qPct', 'docPct'],
    defaultSort: { key: 'createdAt', dir: 'desc' },   // newest case first
    // The search box also finds a case by the client's email, phone (however the number is written) and dependents (2026-11-12).
    search: { chip: 'Search', text: function (r) { return [r.clientName, r.caseRef, r.caseType, r.officer, r.clientEmail, r.clientPhone, r.dependents]; },
      digits: function (r) { return s(r.clientPhone); } },
  };
}
function casesListOpts(ctx) {
  var AZ = ['A → Z', 'Z → A'], ASC = ['asc', 'desc'], SOON = ['Soonest first', 'Latest first'];
  var VIEWS = ctx.views || [], hints = {};
  VIEWS.forEach(function (v) { if (v.hint) hints[v.key] = v.hint; });
  /* Where a column shows: ALL = the All tab only (the columns it has always had); VT = the view tabs only (the agreed
     twenty, team meeting 2026-11-10 item 12); no tabs = both (Case Ref, Client). */
  var ALL = [''], VT = VIEWS.map(function (v) { return v.key; });
  var PCT = ['Highest first', 'Lowest first'], DESC = ['desc', 'asc'], BOARD = ['In the board’s order', 'The other way'];
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
      // ── the All tab: the columns it has always had ──
      { id: 'caseType', label: 'Type', sort: 'caseType', sortText: AZ, sortDirs: ASC, tabs: ALL },
      { id: 'caseStage', label: 'Stage', menu: 'facet', facets: ['stage'], sort: 'caseStage', sortText: AZ, sortDirs: ASC, tabs: ALL },
      { id: 'phase', label: 'Phase', sort: 'phase', sortText: AZ, sortDirs: ASC, tabs: ALL },
      { id: 'deadline', label: 'Deadline', title: 'Deadline Type (Real or Imaginary), the Actual Deadline, and its half-month window', sort: 'actualDeadline', sortText: SOON, sortDirs: ASC, tabs: ALL },
      { id: 'promised', label: 'Promised', title: 'The Internal Deadline (the date promised on an Imaginary deadline)', sort: 'promisedDate', sortText: SOON, sortDirs: ASC, tabs: ALL },
      { id: 'health', label: 'Health', menu: 'facet', facets: ['health'], sort: 'health', sortText: ['Red first', 'Green first'], sortDirs: ASC, tabs: ALL },
      { id: 'slaRisk', label: 'SLA Risk', sort: 'slaRisk', sortText: ['Red first', 'Green first'], sortDirs: ASC, tabs: ALL },
      { id: 'officer', label: 'Support Officer', title: 'Case Support Officer', sort: 'officer', sortText: AZ, sortDirs: ASC, tabs: ALL },
      { id: 'manager', label: 'Manager', menu: 'facet', facets: ['manager'], sort: 'manager', sortText: AZ, sortDirs: ASC, tabs: ALL },
      { id: 'overallReadiness', label: 'Readiness', sort: 'overallReadiness', sortText: PCT, sortDirs: DESC, tabs: ALL },
      { id: 'daysElapsed', label: 'Days', sort: 'daysElapsed', sortText: ['Most first', 'Fewest first'], sortDirs: DESC, tabs: ALL },
      { id: 'status', label: 'Status', tabs: ALL },
      { id: 'del', label: '', tabs: ALL },
      // ── the view tabs: after Case Ref and Client, the agreed list in its order, one column each (nothing beyond it) ──
      { id: 'dependents', label: 'Dependents', title: 'Dependents / Inviter / Sponsor — the search box above the table finds a case by them', sort: 'dependents', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'clientEmail', label: 'Client email', title: 'Client Email — the search box above the table finds a case by it', sort: 'clientEmail', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'clientPhone', label: 'Contact number', title: 'Client Contact Number — the search box above the table finds a case by it', sort: 'clientPhone', sortText: ['0 → 9', '9 → 0'], sortDirs: ASC, tabs: VT },
      { id: 'caseTypeV', label: 'Case type', title: 'Primary Case Type', menu: 'facet', facets: ['caseType'], sort: 'caseTypeV', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'subType', label: 'Sub-type', title: 'Case Sub Type', menu: 'facet', facets: ['subType'], sort: 'subType', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'actualDeadline', label: 'Actual deadline', title: 'The Actual Deadline and the half-month window the case is counted in', sort: 'actualDeadline', sortText: SOON, sortDirs: ASC, tabs: VT },
      { id: 'deadlineType', label: 'Deadline type', title: 'Real (a real deadline) or Imaginary (a date we promised)', menu: 'facet', facets: ['deadlineType'], sort: 'deadlineType', sortText: ['Real first', 'Imaginary first'], sortDirs: ASC, tabs: VT },
      { id: 'internalDeadline', label: 'Internal deadline', title: 'The Internal Deadline (the date promised on an Imaginary deadline)', sort: 'promisedDate', sortText: SOON, sortDirs: ASC, tabs: VT },
      { id: 'phaseV', label: 'Phase', menu: 'facet', facets: ['phase'], sort: 'phaseBoard', sortText: BOARD, sortDirs: ASC, tabs: VT },
      { id: 'retainedBy', label: 'Retained by', menu: 'facet', facets: ['retainedBy'], sort: 'retainedBy', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'retainerStatus', label: 'Retainer status', menu: 'facet', facets: ['retainerStatus'], sort: 'retainerStatus', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'paymentStatus', label: 'Payment status', menu: 'facet', facets: ['paymentStatus'], sort: 'paymentStatus', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'stageV', label: 'Stage', title: 'Case Stage', menu: 'facet', facets: ['stage'], sort: 'stageBoard', sortText: BOARD, sortDirs: ASC, tabs: VT },
      { id: 'portal', label: 'Client portal', title: 'Opens the client’s own portal page in a new tab', tabs: VT },
      { id: 'officerV', label: 'Support officer', title: 'Case Support Officer', menu: 'facet', facets: ['officer'], sort: 'officer', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'managerV', label: 'Case manager', menu: 'facet', facets: ['manager'], sort: 'managerV', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'qPct', label: 'Questionnaire %', title: 'Questionnaire Readiness %', sort: 'qPct', sortText: PCT, sortDirs: DESC, tabs: VT },
      { id: 'docPct', label: 'Documents uploaded %', title: 'Documents Uploaded %', sort: 'docPct', sortText: PCT, sortDirs: DESC, tabs: VT },
    ],
  };
}

module.exports = { consultListSpec, consultListOpts, retainerListSpec, retainerListOpts, casesListSpec, casesListOpts };
