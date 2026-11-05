'use strict';

/**
 * Leads list — filters and sorting IN THE COLUMN HEADERS (Faran 2026-10-28:
 * "all the filters are so scattered … integrate the filters in the respective
 * header of the column professionally and intelligently").
 *
 * Every column header has a small filter button; it opens a panel for THAT
 * column: tick boxes with how many leads each choice would show (counted with
 * the other filters applied), a search box when the list is long, sorting where
 * it makes sense, quick date ranges on Received. Active filters show as chips
 * above the table with "Clear all". Choices are remembered while the tab is open
 * (going to a lead and back keeps them).
 *
 * Since 2026-11-05 every list uses this engine (listFilters.js — one filter look for
 * every list). This file is the Leads list's part: its spec (values, sorts, search,
 * dates) and its options (ids, columns). Both are plain browser JavaScript injected
 * with Function#toString (no template-literal escaping — the inline-script trap).
 * The page keeps its own renderRows(rows) (the row HTML); the UI calls it.
 */

const { listCore, listTableScript, LIST_TABLE_CSS } = require('./listFilters');   // the shared list engine (2026-11-05)

/* eslint-disable no-var */
/** The Leads list: what each lead's values are, how it sorts, what the search and the dates read. */
function leadsTableSpec() {
  var CST_ORDER = ['new', 'invite-sending', 'invite-failed', 'invite', 'reminder1', 'reminder2', 'remark', 'abandoned', 'holding', 'paid', 'booked', 'expired', 'outcome'];
  var STATUS_TEXT = { 'new': 'New', 'invite-sending': 'Invite sending', 'invite-failed': 'Invite failed', 'invite': 'Invite sent', 'reminder1': '1st reminder sent',
    'reminder2': '2nd reminder sent', 'remark': 'A remark', 'abandoned': 'Booking not finished', 'holding': 'Booking in progress', 'paid': 'Paid / fee recorded',
    'booked': 'Booked', 'expired': 'Expired' };
  function s(v) { return String(v == null ? '' : v).trim(); }
  function cstKey(r) { var st = r.status || {}; if (!st.key) return ''; return st.key === 'outcome' ? 'outcome:' + s(st.label) : st.key; }
  function cstText(key) { return key.indexOf('outcome:') === 0 ? key.slice(8) : (STATUS_TEXT[key] || key); }
  var PRI = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  return {
    // The tick-box filters: what each lead's value is ('' = the "none" choice).
    facets: {
      service:  { label: 'Service', get: function (r) { return s(r.service); }, none: 'Not set' },
      source:   { label: 'Source / Reference', get: function (r) { return s(r.source); }, none: 'No source' },
      referredBy: { label: 'Referred By', get: function (r) { return s(r.referredBy); }, none: 'Not set' },
      owner:    { label: 'Owner', get: function (r) { return s(r.owner); }, none: 'No owner' },
      tier:     { label: 'Tier', get: function (r) { return s(r.tier); }, none: 'No tier' },
      priority: { label: 'Priority', get: function (r) { return s(r.priority); }, none: 'No priority', order: ['Critical', 'High', 'Medium', 'Low'] },
      booking:  { label: 'Booking', get: function (r) { return s(r.bookingStatus) || 'Not Yet'; }, order: ['Not Yet', 'Slot Held', 'Abandoned'] },
      invite:   { label: 'Invite', get: function (r) { return r.inviteSent ? 'Sent' : 'Not sent'; }, order: ['Sent', 'Not sent'] },
      status:   { label: 'Current status', get: cstKey, text: cstText, order: CST_ORDER, none: 'No status' },
    },
    sorts: {
      received: function (r) { return s(r.createdAt) || s(r.createdDay); },
      name:     function (r) { return s(r.name).toLowerCase(); },
      status:   function (r) { return (r.status && r.status.at) || 0; },
      priority: function (r) { var p = PRI[s(r.priority)]; return p == null ? 9 : p; },
      tier:     function (r) { return s(r.tier) || '~'; },
    },
    defaultSort: { key: 'received', dir: 'desc' },
    search: { chip: 'Name contains', text: function (r) { return r.name; } },
    flags: { urgent: { chip: 'Urgent only', test: function (r) { return !!r.urgent; } } },
    // The Received filter compares the server-made Toronto day.
    date: { key: 'received', chip: 'Received', get: function (r) { return s(r.createdDay); } },
    CST_ORDER: CST_ORDER, cstKey: cstKey,
  };
}

/** The pure part for the Leads list (unit-tested in Node): the shared engine with the Leads spec. */
function leadsTableCore() {
  var spec = leadsTableSpec(), LT = listCore(spec);
  LT.CST_ORDER = spec.CST_ORDER; LT.cstKey = spec.cstKey;
  return LT;
}

/** The Leads list on the page: the ids, the remembered state, and one entry per column, in table order. */
function leadsTableOpts() {
  return {
    key: 'tdot_leads_table_v1',
    ids: { head: 'q-headrow', chips: 'q-chips', count: 'q-count', search: 'q-search', pop: 'q-pop' },
    render: 'renderRows', api: 'LeadsTable',
    // menu: what the header's panel offers.
    cols: [
      { id: 'lead', label: 'Lead', menu: 'lead', flags: ['urgent'], note: 'Search by name in the box above the table.', sort: 'name', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
      { id: 'service', label: 'Service', menu: 'facet', facets: ['service'] },
      { id: 'source', label: 'Source / Reference', title: 'How they reached us · the lead owner underneath', menu: 'facet', facets: ['source', 'owner'] },
      { id: 'referred', label: 'Referred By', title: 'Who referred them: the employee or client chosen by staff, or the answer the client gave on the website form', menu: 'facet', facets: ['referredBy'] },
      { id: 'received', label: 'Received', title: 'The day the lead arrived, Toronto time', menu: 'date', date: true, sort: 'received', sortText: ['Newest first', 'Oldest first'], sortDirs: ['desc', 'asc'] },
      { id: 'tier', label: 'Tier', menu: 'facet', facets: ['tier'], sort: 'tier', sortText: ['A → Z', 'Z → A'], sortDirs: ['asc', 'desc'] },
      { id: 'priority', label: 'Priority', menu: 'facet', facets: ['priority'], sort: 'priority', sortText: ['Most urgent first', 'Least urgent first'], sortDirs: ['asc', 'desc'] },
      { id: 'booking', label: 'Booking', menu: 'facet', facets: ['booking'] },
      { id: 'invite', label: 'Invite', menu: 'facet', facets: ['invite'] },
      { id: 'status', label: 'Current status', title: 'Where the lead is with us: invite, reminders, the latest remark, booked, expired, or the Outcome', menu: 'facet', facets: ['status'], sort: 'status', sortText: ['Latest first', 'Oldest first'], sortDirs: ['desc', 'asc'] },
      { id: 'del', label: '' },
    ],
  };
}

const LEADS_TABLE_CSS = LIST_TABLE_CSS + `
  .tbl-wrap table { min-width:1100px; }
  td.ref-by { max-width:200px; overflow-wrap:anywhere; }
`;

/** The browser script: the core, then the UI wired to the page. */
function leadsTableScript() {
  return listTableScript(leadsTableSpec, leadsTableOpts);
}

module.exports = { leadsTableCore, leadsTableSpec, leadsTableOpts, leadsTableScript, LEADS_TABLE_CSS };
