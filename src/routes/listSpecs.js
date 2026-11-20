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
    TIMES = ['morning', 'afternoon', 'evening', 'none'], READYS = ['notready', 'ready', 'notasked'];
  function agreementOf(r) { return r.agreementSigned ? 'signed' : r.agreementSent ? 'sent' : 'none'; }
  function preconsultOf(r) { return r.preConsultSubmitted ? 'submitted' : 'pending'; }
  function paidOf(r) { return !s(r.paid) ? 'none' : r.paid === 'waived' ? 'waived' : r.paid === 'app' ? 'app' : 'staff'; }
  /* The "Ready" column (2026-11-20): has the client signed the consultation agreement and filled in the pre-consultation form?
     The server sends one word per row (utils/consultReady.js); here it is one filter value: ready, notasked (staff chose not
     to send them), or notready (agreement / form / both missing, or never sent). The mark is for consultations still to
     happen (Faran 2026-11-20): a row under Needs outcome or Completed is 'over' whatever its word. No word, or one this
     page does not know = '' (the "Not known" choice). */
  function readyOf(r) {
    var b = bucket(r); if (b === 'needs' || b === 'done') return 'over';
    var v = s(r.ready);
    return (v === 'ready' || v === 'notasked') ? v : (v === 'agreement' || v === 'form' || v === 'both' || v === 'notsent') ? 'notready' : '';
  }
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
      // Ready (2026-11-20): one tick on "Not ready" is the day-before check (Booked tab, Date "Tomorrow"). Its column shows on
      // Booked, No date and All only — so, like "Now", the numbers on the two past tabs are counted without it.
      ready: { label: 'Ready', get: readyOf, none: 'Not known',
        text: function (v) { return ({ notready: 'Not ready', ready: 'Ready', notasked: 'Not asked', over: 'Consultation over' })[v] || v; }, order: READYS, fixed: true,
        onlyOn: ['booked', 'nodate'] },
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
      ready: function (r) { var v = readyOf(r); return v === 'over' ? '' : ranked(READYS, v); },   // a consultation that is over has a dash in the cell — last both ways
      agreement: function (r) { return ranked(AGREEMENTS, agreementOf(r)); },
      preconsult: function (r) { return ranked(PRECONSULTS, preconsultOf(r)); },
      paid: function (r) { return ranked(PAIDS, paidOf(r)); },
      outcome: function (r) { return ranked(OUTCOMES, r.outcome); },
      now: function (r) { return r.done ? ranked(NOWS, r.now) : ''; },   // not completed yet: an empty cell — last both ways
    },
    sortBlanksLast: ['service', 'consultant', 'mode', 'ready', 'outcome', 'now'],
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
    onChange: ctx && ctx.onChange,   // the page keeps "Now" and "Ready" (filter and sort) to the tabs that show the column
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
      // Ready (2026-11-20): hidden on the Needs outcome and Completed tabs (the page's CSS, by position — like "Now")
      { id: 'ready', label: 'Ready', title: 'Signed agreement and filled pre-consultation form — both are needed before the consultation', menu: 'facet', facets: ['ready'], sort: 'ready', sortText: ['Not ready first', 'Not ready last'], sortDirs: ASC },
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
          typeOf(r): 'real' | 'imaginary' | 'none' (clientMasterWindows.typeOf),
          todoHas(r): is this row on the to-do list on screen (the To-do tab only — see below) }
   The view tabs (Assigning, Deadlines, EE after ITA) have their own columns since 2026-11-12 (team meeting 2026-11-10, item 12):
   the agreed twenty, one column each. The All tab keeps the columns it had. A column's `tabs` says where it shows.
   The To-do tab (stage 1, 2026-11-19; switch TODO_TAB) is a PAGE-ONLY view: `views` holds it (todoListService.PAGE_VIEW —
   { key: 'todo', pageOnly: true, todoBox: true }) only when the tab is on the page. Only then: the "With" column, its own
   filter and sort exist (all three named todoWith), the tab's twelve columns also show on it, and the tab is narrowed to the
   list on screen inside the `view` facet (ctx.todoHas). With no such view everything here is exactly as it was.
   Both functions below are pasted into EVERY Client Master page as text, comments and all — so, to keep a page without the
   tab free of it, neither function names the tab or its column in its own text: the tab's key comes from the view (the one
   with todoBox) and the column's id is that key + 'With'. Keep it so (test/todoList.test.js checks the text). */
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
  /* The page-only tab that shows one person's list at a time (the view with todoBox): its key, or '' when the page has no such tab. */
  var TODO = '';
  VIEWS.forEach(function (v) { if (v && v.todoBox) TODO = v.key; });
  /* The tabs a row is under: the views the server worked out. The page-only tab is narrowed HERE to the list on screen
     (ctx.todoHas(r), the page's hook), so the engine's own numbers — the tab's number, the count beside the search box,
     the counts inside the header filters, the search — are all about that list: a row the server marked for the tab
     stays under it only when it is on the chosen list. No hook, no list chosen or a hook that fails = no row.
     A page without the tab: the row's views as they are. */
  function viewsOf(r) {
    var vs = r.views || [];
    if (!TODO || vs.indexOf(TODO) < 0) return vs;
    var on = false;
    try { on = !!(ctx.todoHas && ctx.todoHas(r)); } catch (e) { on = false; }
    return on ? vs : vs.filter(function (k) { return k !== TODO; });
  }
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
  /* More from the Monday board (2026-11-20): the optional columns' values sit together on the row, in r.more, keyed by the
     column's id. A row without it (a page that did not ask for it) reads as blank everywhere. */
  function more(r, k) { var m = r && r.more; return m && m[k] != null ? m[k] : ''; }
  var spec = {
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
      view: { label: 'View', quick: true, fixed: true, order: VK, text: function (v) { return VL[v] || v; }, get: viewsOf, none: 'No view' },
      // More from the Monday board (2026-11-20): the optional columns that are a status, people or short text filter like the rest.
      qStatus: { label: 'Questionnaire status', get: function (r) { return s(more(r, 'qStatus')); }, none: 'Not set' },
      docsLocation: { label: 'Documents location', get: function (r) { return s(more(r, 'docsLocation')); }, none: 'Not set' },
      supervisor: { label: 'Ops supervisor', get: function (r) { return names(more(r, 'supervisor')); }, none: 'Nobody' },
      consultant: { label: 'Consultant', get: function (r) { return s(more(r, 'consultant')); }, none: 'No consultant' },
      consultOutcome: { label: 'Consultation outcome', get: function (r) { return s(more(r, 'consultOutcome')); }, none: 'No outcome' },
      sourceRef: { label: 'Source / Reference', get: function (r) { return s(more(r, 'sourceRef')); }, none: 'No source' },
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
      // More from the Monday board (2026-11-20): a date as its plain day, a number as a number, text A → Z; blanks last both ways.
      // A link column sorts by whether the case has the link (the address itself is never read here).
      stageStart: function (r) { return s(more(r, 'stageStart')); },
      hardDeadlineSys: function (r) { return s(more(r, 'hardDeadlineSys')); },
      softDeadlineSys: function (r) { return s(more(r, 'softDeadlineSys')); },
      prepDeadlineSys: function (r) { return s(more(r, 'prepDeadlineSys')); },
      reminderCount: function (r) { return pct(more(r, 'reminderCount')); },
      paymentConfirmed: function (r) { return s(more(r, 'paymentConfirmed')); },
      retainerSigned: function (r) { return s(more(r, 'retainerSigned')); },
      missingRequired: function (r) { return pct(more(r, 'missingRequired')); },
      qStatus: function (r) { return txt(more(r, 'qStatus')); },
      lastActivity: function (r) { return s(more(r, 'lastActivity')); },
      supervisor: function (r) { return txt(more(r, 'supervisor')); },
      escalationReason: function (r) { return txt(more(r, 'escalationReason')); },
      folder: function (r) { return more(r, 'folder') ? 0 : 1; },
      docsLocation: function (r) { return txt(more(r, 'docsLocation')); },
      consultant: function (r) { return txt(more(r, 'consultant')); },
      consultOutcome: function (r) { return txt(more(r, 'consultOutcome')); },
      consultFee: function (r) { return txt(more(r, 'consultFee')); },
      sourceRef: function (r) { return txt(more(r, 'sourceRef')); },
      consultRecord: function (r) { return more(r, 'consultRecord') ? 0 : 1; },
    },
    // a case with no date / phase / officer goes last, whichever way the column sorts (A → Z must not open on every blank)
    sortBlanksLast: ['actualDeadline', 'promisedDate', 'phase', 'officer',
      'dependents', 'clientEmail', 'clientPhone', 'caseTypeV', 'subType', 'deadlineType', 'phaseBoard', 'stageBoard', 'retainedBy', 'retainerStatus', 'paymentStatus', 'managerV', 'qPct', 'docPct',
      'stageStart', 'hardDeadlineSys', 'softDeadlineSys', 'prepDeadlineSys', 'reminderCount', 'paymentConfirmed', 'retainerSigned', 'missingRequired', 'qStatus', 'lastActivity',
      'supervisor', 'escalationReason', 'docsLocation', 'consultant', 'consultOutcome', 'consultFee', 'sourceRef'],
    defaultSort: { key: 'createdAt', dir: 'desc' },   // newest case first
    // The search box also finds a case by the client's email, phone (however the number is written) and dependents (2026-11-12).
    search: { chip: 'Search', text: function (r) { return [r.clientName, r.caseRef, r.caseType, r.officer, r.clientEmail, r.clientPhone, r.dependents]; },
      digits: function (r) { return s(r.clientPhone); } },
  };
  if (TODO) {
    /* The page-only tab's own column, "With" (its id: the tab's key + 'With'): the case's Case Manager(s) — who has it for
       review. Its OWN filter (the empty choice reads "Nobody") and sort, so the Manager filter and sort of the other tabs
       are not touched. */
    var WITH = TODO + 'With';
    spec.facets[WITH] = { label: 'With', get: function (r) { return names(r.manager); }, none: 'Nobody' };
    spec.sorts[WITH] = function (r) { var t = txt(r.manager); return t === 'unassigned' ? '' : t; };
    spec.sortBlanksLast.push(WITH);
  }
  return spec;
}
function casesListOpts(ctx) {
  var AZ = ['A → Z', 'Z → A'], ASC = ['asc', 'desc'], SOON = ['Soonest first', 'Latest first'];
  var VIEWS = ctx.views || [], hints = {};
  VIEWS.forEach(function (v) { if (v.hint) hints[v.key] = v.hint; });
  /* Where a column shows: ALL = the All tab only (the columns it has always had); VT = the view tabs only (the agreed
     twenty, team meeting 2026-11-10 item 12) — the Monday views, never a page-only view; no tabs = every tab (Case Ref, Client).
     TD = VT and the page-only tab that shows one person's list (the view with todoBox, when the page has it): the nine
     view-tab columns that are also among that tab's twelve — Case type, Sub-type, Stage, Actual deadline, Deadline type,
     Internal deadline, Support officer, Questionnaire %, Documents uploaded % (with Case Ref, Client and its own "With").
     Without that tab TD is VT itself — every column as it was. */
  var ALL = [''], VT = VIEWS.filter(function (v) { return !v.pageOnly; }).map(function (v) { return v.key; });
  var TODO = '';
  VIEWS.forEach(function (v) { if (v && v.todoBox) TODO = v.key; });
  var TD = TODO ? VT.concat([TODO]) : VT;
  var PCT = ['Highest first', 'Lowest first'], DESC = ['desc', 'asc'], BOARD = ['In the board’s order', 'The other way'];
  /* More from the Monday board (Faran 2026-11-20): nineteen more board columns, each OPTIONAL — on NO tab by default
     (tabs: NONE), so every tab shows exactly the columns it always did. A person switches one on with the Columns button
     (a column with more: … is what the page offers there, in this order, on every tab). The same word says how the page shows
     the value: date | num | status | names | text | clip (long text, cut to two lines) | link. Read-only, like every column here. */
  var NONE = [], LATE = ['Latest first', 'Earliest first'], MOST = ['Most first', 'Fewest first'], LINK = ['With a link first', 'Without a link first'];
  /* The three system dates are never the client's deadline. The header cell's tooltip says so, but a pointer on the column name
     shows the sort button's own tooltip instead, and a phone or the keyboard shows none — so the same words are also the column's
     note: the header gets the funnel, and its panel has the sort both ways and the words (like the Consultations "Client" column). */
  var SYS = ' Set by the system from the stage timings. Not the client’s deadline (see Actual deadline).', SYS_NOTE = SYS.slice(1);
  var opts = {
    key: 'tdot_list_cases',
    ids: { head: 'cs-headrow', chips: 'cs-chips', count: 'table-count', search: 'search-box', pop: 'cs-pop' },
    render: 'renderCasesList', api: 'CasesTable',
    initial: ctx.initial, onChange: ctx.onChange,
    /* The columns a person chose for the tab on view (team meeting 2026-11-10, item 13): the page answers them (cmPickCols). */
    pickCols: 'cmPickCols',
    /* The view tabs (block 3): All first (every case, newest first), then one per Monday view. No default: a new browser
       tab opens on All; the tab shown is kept until the browser tab is closed. A link's ?view= opens that tab. */
    quick: { facet: 'view', box: 'cs-quick', tabs: true, allLast: false, all: 'All', storeKey: 'tdot_list_cases_tab',
      values: VIEWS.map(function (v) { return v.key; }), hints: hints },
    /* No column sorts by the creation time (All), by Monday's order (a view tab) or by the soonest deadline (the page-only tab): a column sort shows as a chip whose × goes back. */
    sortReset: function (st) {
      var v = st && st.sel && st.sel.view;
      if (TODO && v && v.length && v[0] === TODO) return 'soonest deadline first';
      return v && v.length ? "Monday's order for this view" : 'newest case first';
    },
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
      { id: 'caseTypeV', label: 'Case type', title: 'Primary Case Type', menu: 'facet', facets: ['caseType'], sort: 'caseTypeV', sortText: AZ, sortDirs: ASC, tabs: TD },
      { id: 'subType', label: 'Sub-type', title: 'Case Sub Type', menu: 'facet', facets: ['subType'], sort: 'subType', sortText: AZ, sortDirs: ASC, tabs: TD },
      { id: 'actualDeadline', label: 'Actual deadline', title: 'The Actual Deadline and the half-month window the case is counted in', sort: 'actualDeadline', sortText: SOON, sortDirs: ASC, tabs: TD },
      { id: 'deadlineType', label: 'Deadline type', title: 'Real (a real deadline) or Imaginary (a date we promised)', menu: 'facet', facets: ['deadlineType'], sort: 'deadlineType', sortText: ['Real first', 'Imaginary first'], sortDirs: ASC, tabs: TD },
      { id: 'internalDeadline', label: 'Internal deadline', title: 'The Internal Deadline (the date promised on an Imaginary deadline)', sort: 'promisedDate', sortText: SOON, sortDirs: ASC, tabs: TD },
      { id: 'phaseV', label: 'Phase', menu: 'facet', facets: ['phase'], sort: 'phaseBoard', sortText: BOARD, sortDirs: ASC, tabs: VT },
      { id: 'retainedBy', label: 'Retained by', menu: 'facet', facets: ['retainedBy'], sort: 'retainedBy', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'retainerStatus', label: 'Retainer status', menu: 'facet', facets: ['retainerStatus'], sort: 'retainerStatus', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'paymentStatus', label: 'Payment status', menu: 'facet', facets: ['paymentStatus'], sort: 'paymentStatus', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'stageV', label: 'Stage', title: 'Case Stage', menu: 'facet', facets: ['stage'], sort: 'stageBoard', sortText: BOARD, sortDirs: ASC, tabs: TD },
      { id: 'portal', label: 'Client portal', title: 'Opens the client’s own portal page in a new tab', tabs: VT },
      { id: 'officerV', label: 'Support officer', title: 'Case Support Officer', menu: 'facet', facets: ['officer'], sort: 'officer', sortText: AZ, sortDirs: ASC, tabs: TD },
      { id: 'managerV', label: 'Case manager', menu: 'facet', facets: ['manager'], sort: 'managerV', sortText: AZ, sortDirs: ASC, tabs: VT },
      { id: 'qPct', label: 'Questionnaire %', title: 'Questionnaire Readiness %', sort: 'qPct', sortText: PCT, sortDirs: DESC, tabs: TD },
      { id: 'docPct', label: 'Documents uploaded %', title: 'Documents Uploaded %', sort: 'docPct', sortText: PCT, sortDirs: DESC, tabs: TD },
      // ── more from the Monday board: optional, on no tab until a person switches one on (the Columns button) ──
      { id: 'stageStart', label: 'Stage start date', title: 'Stage Start Date: the day the case entered its stage', sort: 'stageStart', sortText: LATE, sortDirs: DESC, tabs: NONE, more: 'date' },
      { id: 'hardDeadlineSys', label: 'Hard deadline (system)', title: 'Hard Deadline.' + SYS, note: SYS_NOTE, sort: 'hardDeadlineSys', sortText: SOON, sortDirs: ASC, tabs: NONE, more: 'date' },
      { id: 'softDeadlineSys', label: 'Soft deadline (system)', title: 'Soft Deadline.' + SYS, note: SYS_NOTE, sort: 'softDeadlineSys', sortText: SOON, sortDirs: ASC, tabs: NONE, more: 'date' },
      { id: 'prepDeadlineSys', label: 'Submission prep deadline (system)', title: 'Submission Prep Deadline.' + SYS, note: SYS_NOTE, sort: 'prepDeadlineSys', sortText: SOON, sortDirs: ASC, tabs: NONE, more: 'date' },
      { id: 'reminderCount', label: 'Reminder count', title: 'Reminder Count: how many reminders the board has counted for this case', sort: 'reminderCount', sortText: MOST, sortDirs: DESC, tabs: NONE, more: 'num' },
      { id: 'paymentConfirmed', label: 'Payment confirmation date', title: 'Payment Confirmation Date', sort: 'paymentConfirmed', sortText: LATE, sortDirs: DESC, tabs: NONE, more: 'date' },
      { id: 'retainerSigned', label: 'Retainer signed date', title: 'Retainer Signed Date', sort: 'retainerSigned', sortText: LATE, sortDirs: DESC, tabs: NONE, more: 'date' },
      { id: 'missingRequired', label: 'Missing required documents', title: 'Missing Required Documents: how many required documents are still missing', sort: 'missingRequired', sortText: MOST, sortDirs: DESC, tabs: NONE, more: 'num' },
      { id: 'qStatus', label: 'Questionnaire completion status', title: 'Questionnaire Completion Status', menu: 'facet', facets: ['qStatus'], sort: 'qStatus', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'status' },
      { id: 'lastActivity', label: 'Last client activity date', title: 'Last Client Activity Date', sort: 'lastActivity', sortText: LATE, sortDirs: DESC, tabs: NONE, more: 'date' },
      { id: 'supervisor', label: 'Ops supervisor', title: 'Ops Supervisor', menu: 'facet', facets: ['supervisor'], sort: 'supervisor', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'names' },
      { id: 'escalationReason', label: 'Escalation reason', title: 'Escalation Reason: a long reason is cut to two lines, hover the cell for the whole text', sort: 'escalationReason', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'clip' },
      { id: 'folder', label: 'OneDrive folder', title: 'Opens the case’s OneDrive folder in a new tab', sort: 'folder', sortText: LINK, sortDirs: ASC, tabs: NONE, more: 'link' },
      { id: 'docsLocation', label: 'Documents location', title: 'Documents Location', menu: 'facet', facets: ['docsLocation'], sort: 'docsLocation', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'status' },
      { id: 'consultant', label: 'Consultant', title: 'Consultant: copied from the consultation record', menu: 'facet', facets: ['consultant'], sort: 'consultant', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'text' },
      { id: 'consultOutcome', label: 'Consultation outcome', title: 'Consultation Outcome: copied from the consultation record', menu: 'facet', facets: ['consultOutcome'], sort: 'consultOutcome', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'text' },
      { id: 'consultFee', label: 'Consultation fee', title: 'Consultation Fee: copied from the consultation record, shown as it is written on the board', sort: 'consultFee', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'text' },
      { id: 'sourceRef', label: 'Source / Reference', title: 'Source / Reference: copied from the consultation record', menu: 'facet', facets: ['sourceRef'], sort: 'sourceRef', sortText: AZ, sortDirs: ASC, tabs: NONE, more: 'text' },
      { id: 'consultRecord', label: 'Consultation record', title: 'Opens the consultation record in a new tab', sort: 'consultRecord', sortText: LINK, sortDirs: ASC, tabs: NONE, more: 'link' },
    ],
  };
  /* The page-only tab's own column (only when the page has the tab): who has the case for review. Its id, filter and sort
     are the tab's key + 'With'. It comes last in this list; the tab's own column order (With third) is the page's (CM_TABCOLS). */
  if (TODO) {
    var WITH = TODO + 'With';
    opts.cols.push({ id: WITH, label: 'With', title: 'Case Manager on Client Master: who has the case for review', menu: 'facet', facets: [WITH], sort: WITH, sortText: AZ, sortDirs: ASC, tabs: [TODO] });
  }
  return opts;
}

module.exports = { consultListSpec, consultListOpts, retainerListSpec, retainerListOpts, casesListSpec, casesListOpts };
