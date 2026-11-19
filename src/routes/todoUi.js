'use strict';

/**
 * The To-do tab of the Client Master page (stage 1, READ-ONLY; Faran 2026-11-19): the pure
 * helpers. Who has a list, which cases are on it, the order, the groups under the headings and
 * the names in the "With" pill. No DOM, no request, nothing is written anywhere.
 *
 * Plain browser JavaScript injected with Function#toString (like clientMasterUi), only when
 * the tab is on the page: the one function below refers to nothing outside itself and its two
 * arguments. Node requires this file for the tests.
 * INJECTED-CODE RULE (tests enforce it): no backslash, no backtick and no dollar-brace anywhere
 * in this file. Write [0-9] for a digit and join strings with +.
 *
 * The rows are the Client Master rows the page already has (dashboardService.parseItem):
 *   views       - the server puts 'todo' on every OPEN row (a row in the Assigning view);
 *   officer     - Case Support Officer, the names as text ("A, B");
 *   officerIds  - { personIds, teamIds } of Case Support Officer;
 *   manager     - Case Manager, the names as text ('Unassigned' when the cell is empty);
 *   managerIds  - { personIds, teamIds } of Case Manager (on the rows only when the tab is on).
 * Only these two people columns ever put a case on a list. Retained by, Stage Owner, Ops
 * Supervisor, Submission Team and Override Approved By never do.
 *
 * A list is named by a "who" value, exactly one of:
 *   'me'          - the signed-in person (their own id and every team they are in);
 *   'nobody'      - open cases with no Case Support Officer AND no Case Manager;
 *   'p:<digits>'  - one person, by Monday user id;
 *   't:<digits>'  - one team, by Monday team id.
 * me (from the data answer, todo.me): { id, name, teamIds } or null (no Monday sign-in).
 *
 * todoUi(CMW, CMU): CMW = clientMasterWindows (bucketDate, windowOf), CMU = clientMasterUi
 * (groupRows, groupId, noOfficer).
 */

/* eslint-disable no-var */
function todoUi(CMW, CMU) {
  var TAG = 'todo';   // the server's mark on an open row (todoListService.PAGE_VIEW.key)
  /* "No one assigned" is grouped by Case Stage in the board's own stage order, like the Assigning tab. This shape is what
     CMU.groupRows is given: never the tab's own definition (its grouping is not one groupRows knows). */
  var STAGE_VIEW = { key: 'todo-nobody', label: 'No one assigned', by: 'stage', dir: 'ASC', groupOrder: 'position', sort: null };

  function s(v) { return String(v == null ? '' : v).trim(); }
  function isId(v) { return typeof v === 'string' && v.length > 0 && v.length <= 20 && /^[0-9]+$/.test(v); }
  function own(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /** A kept or linked value made safe: one of 'me', 'nobody', 'p:<digits>', 't:<digits>', else ''. Nothing is trimmed or guessed. */
  function normWho(v) {
    if (typeof v !== 'string') return '';
    if (v === 'me' || v === 'nobody') return v;
    var kind = v.slice(0, 2);
    return (kind === 'p:' || kind === 't:') && isId(v.slice(2)) ? v : '';
  }

  /* ── the two people cells of a row ── */
  function idList(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (x) { var k = x == null ? '' : String(x); if (isId(k) && out.indexOf(k) < 0) out.push(k); });
    return out;
  }
  /** A people cell's ids as list keys: every person ('p:<id>'), then every team ('t:<id>'). */
  function cellKeys(ids) {
    var o = ids || {};
    return idList(o.personIds).map(function (x) { return 'p:' + x; }).concat(idList(o.teamIds).map(function (x) { return 't:' + x; }));
  }
  function officerKeys(r) { return cellKeys(r && r.officerIds); }
  function managerKeys(r) { return cellKeys(r && r.managerIds); }
  /** The names in a people cell's text ("A, B"), in order; 'Unassigned' (an empty Case Manager cell) is never a name. */
  function cellNames(text) { return s(text).split(',').map(s).filter(function (n) { return n !== '' && n !== 'Unassigned'; }); }
  function filled(ids) { var o = ids || {}; return !!((o.personIds && o.personIds.length) || (o.teamIds && o.teamIds.length)); }
  function noOfficer(r) { return CMU && typeof CMU.noOfficer === 'function' ? CMU.noOfficer(r) : !filled(r && r.officerIds); }
  /** Nobody in Case Manager. A row that came without managerIds is read by the cell's text, so it is never called empty by mistake. */
  function noManager(r) {
    if (!r || !r.managerIds) return cellNames(r && r.manager).length === 0;
    return !filled(r.managerIds);
  }
  function hit(keys, wanted) { for (var i = 0; i < wanted.length; i++) if (keys.indexOf(wanted[i]) >= 0) return true; return false; }
  function isOpen(r) { return !!r && Array.isArray(r.views) && r.views.indexOf(TAG) >= 0; }

  /** The list keys that are the signed-in person: their own id, then every team they are in. [] = no Monday sign-in. */
  function meKeys(me) {
    var id = me && me.id != null ? String(me.id) : '';
    if (!isId(id)) return [];
    return ['p:' + id].concat(idList(me.teamIds).map(function (x) { return 't:' + x; }));
  }
  /** The keys a list is made of: 'me' = my id and my teams; a person or a team = itself; 'nobody' / nothing = none. */
  function whoKeys(who, me) {
    var w = normWho(who);
    if (w === 'me') return meKeys(me);
    return w && w !== 'nobody' ? [w] : [];
  }

  /**
   * The names of the people and teams, learned from EVERY row given (open or not), from both cells:
   * { 'p:<id>': name, 't:<id>': name }. A cell's ids are paired with its comma-split names only when the cell holds ONE
   * kind (people only, or teams only: between a person and a team the order is not known) and as many names as ids.
   * One id seen with different names: the most frequent wins (the one seen first on a tie).
   * An id that is not in the answer has no name yet: nameOf() then says "Monday user <id>" / "Monday team <id>".
   */
  function names(rows) {
    var tally = {}, seq = 0;
    function learn(ids, text) {
      var o = ids || {}, rp = Array.isArray(o.personIds) ? o.personIds : [], rt = Array.isArray(o.teamIds) ? o.teamIds : [];
      if ((rp.length > 0) === (rt.length > 0)) return;            // an empty cell, or people and teams together
      var kind = rp.length ? 'p:' : 't:', raw = rp.length ? rp : rt, list = idList(raw), nm = cellNames(text);
      if (list.length !== raw.length || nm.length !== list.length) return;
      list.forEach(function (id, i) {
        var k = kind + id, t = tally[k] || (tally[k] = {});
        if (!own(t, nm[i])) t[nm[i]] = { n: 0, at: seq++ };
        t[nm[i]].n++;
      });
    }
    (rows || []).forEach(function (r) {
      if (!r) return;
      learn(r.officerIds, r.officer);
      learn(r.managerIds, r.manager);
    });
    var out = {};
    Object.keys(tally).forEach(function (k) {
      var best = null, t = tally[k];
      Object.keys(t).forEach(function (n) { if (best === null || t[n].n > t[best].n || (t[n].n === t[best].n && t[n].at < t[best].at)) best = n; });
      if (best !== null) out[k] = best;
    });
    return out;
  }
  /** The name of a person or team key from names(); one never resolved reads "Monday user <id>" / "Monday team <id>". */
  function nameOf(key, nm) {
    var k = normWho(key);
    if (own(nm, k) && s(nm[k])) return s(nm[k]);
    if (k.slice(0, 2) === 'p:') return 'Monday user ' + k.slice(2);
    if (k.slice(0, 2) === 't:') return 'Monday team ' + k.slice(2);
    return '';
  }

  /** The open rows: the ones the server marked (a row in the Assigning view). */
  function open(rows) { return (rows || []).filter(isOpen); }

  /**
   * Who has a list, from the newest data:
   * { me: null | { key: 'me', name, mine, review, total },
   *   list: [{ key, name, mine, review, total }] A to Z by name,
   *   nobody: { key: 'nobody', total } | null }.
   * A person or team is listed when they are Case Support Officer or Case Manager on at least one open row.
   * mine = open rows where they are officer; review = open rows where they are manager and NOT officer; total = both
   * (each case once). me (when signed in with Monday) = my own id and every team I am in: always there, also with no case;
   * my own person entry is NOT repeated in list (it is "My list"); a team I am in still shows in list as itself.
   * nobody = open rows with no officer AND no manager (person or team); always offered, also at 0.
   * scope 'assigned' (the viewer gets only their own cases): only "My list" is offered: list is empty and nobody is null.
   */
  function people(rows, me, scope) {
    var op = open(rows), nm = names(rows), mk = meKeys(me), by = {}, keys = [];
    var mine = { key: 'me', name: '', mine: 0, review: 0, total: 0 }, none = 0;
    function entry(k) {
      if (!own(by, k)) { by[k] = { key: k, name: nameOf(k, nm), mine: 0, review: 0, total: 0 }; keys.push(k); }
      return by[k];
    }
    op.forEach(function (r) {
      var ok = officerKeys(r), mg = managerKeys(r);
      if (noOfficer(r) && noManager(r)) { none++; return; }
      ok.forEach(function (k) { entry(k).mine++; });
      mg.forEach(function (k) { if (ok.indexOf(k) < 0) entry(k).review++; });
      if (mk.length) { if (hit(ok, mk)) mine.mine++; else if (hit(mg, mk)) mine.review++; }
    });
    var list = [];
    keys.forEach(function (k) {
      if (mk.length && k === mk[0]) return;                        // my own entry is "My list"
      by[k].total = by[k].mine + by[k].review;
      list.push(by[k]);
    });
    list.sort(function (a, b) {
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    var my = null;
    if (mk.length) {
      mine.total = mine.mine + mine.review;
      mine.name = s(me && me.name) || (own(nm, mk[0]) ? s(nm[mk[0]]) : '');
      my = mine;
    }
    if (s(scope) === 'assigned') return { me: my, list: [], nobody: null };
    return { me: my, list: list, nobody: { key: 'nobody', total: none } };
  }

  /**
   * The list to show now, from the kept choice and the newest people():
   * 'me' stays only with a Monday sign-in (else no list); 'nobody' stays while it is offered; a person or a team stays
   * while they are in the list; anything else, or nothing kept: "My list" with a Monday sign-in, else no list ('').
   */
  function resolveWho(kept, ppl) {
    var k = normWho(kept), p = ppl || {}, back = p.me ? 'me' : '';
    if (k === 'me') return back;
    if (k === 'nobody') return p.nobody ? 'nobody' : back;
    if (k) {
      var list = p.list || [];
      for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === k) return k;
    }
    return back;
  }

  /** How many open cases are on a list, from people(): the number beside its name (0 for no list, or one that is not offered now). */
  function sizeOf(ppl, who) {
    var w = normWho(who), p = ppl || {};
    if (w === 'me') return p.me ? p.me.total : 0;
    if (w === 'nobody') return p.nobody ? p.nobody.total : 0;
    var list = p.list || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === w) return list[i].total;
    return 0;
  }

  /**
   * Is this row on that list? Only an OPEN row ever is. A person, a team or 'me' (my id and my teams): they are Case
   * Support Officer or Case Manager. 'nobody': no officer and no manager. No list ('' or anything else): never.
   */
  function has(r, who, me) {
    var w = normWho(who);
    if (!w || !isOpen(r)) return false;
    if (w === 'nobody') return noOfficer(r) && noManager(r);
    var keys = whoKeys(w, me);
    return keys.length > 0 && (hit(officerKeys(r), keys) || hit(managerKeys(r), keys));
  }

  /* ── the date a list is ordered by ── */
  function day(v) { var t = s(v).slice(0, 10); return CMW.windowOf(t) ? t : ''; }
  /**
   * The date a case is due, 'YYYY-MM-DD' or '': the team's own counting rule (CMW.bucketDate: Real and not recorded =
   * Actual deadline, Imaginary = Internal deadline) and, when that one is blank, the other of the two (Actual, then
   * Internal), so a row that shows a date is never ordered as having none. Never the Hard, Soft or Prep deadline.
   */
  function dueDate(r) { return day(CMW.bucketDate(r)) || day(r && r.actualDeadline) || day(r && r.promisedDate); }
  /** The column that holds that date: 'actualDeadline', 'internalDeadline' or '' (no date). The "Passed" pill goes in this cell. */
  function dueField(r) {
    var d = dueDate(r);
    if (!d) return '';
    var a = day(r && r.actualDeadline), p = day(r && r.promisedDate);
    if (day(CMW.bucketDate(r))) return CMW.typeOf(r) === 'imaginary' ? 'internalDeadline' : 'actualDeadline';
    return a === d ? 'actualDeadline' : p === d ? 'internalDeadline' : '';
  }
  /** Has that date passed? today = the Toronto day, 'YYYY-MM-DD'. No date, or no today: no. */
  function duePassed(r, today) { var d = dueDate(r), t = day(today); return !!d && !!t && d < t; }

  /* A case reference with the numbers in it compared as numbers ("...-9" before "...-10"). */
  function refKey(v) {
    return s(v).toLowerCase().replace(/[0-9]+/g, function (d) { return d.length >= 12 ? d : ('000000000000' + d).slice(-12); });
  }
  /**
   * Soonest deadline first: by dueDate, the earliest first (so a date that has passed leads), no date last; the same date:
   * by case reference with its numbers as numbers (no reference last); then the order given. A new list; the rows are not changed.
   */
  function order(rows) {
    return (rows || []).map(function (r, i) { return { r: r, i: i, d: dueDate(r), k: refKey(r && r.caseRef) }; })
      .sort(function (a, b) {
        if ((a.d === '') !== (b.d === '')) return a.d === '' ? 1 : -1;
        if (a.d !== b.d) return a.d < b.d ? -1 : 1;
        if ((a.k === '') !== (b.k === '')) return a.k === '' ? 1 : -1;
        if (a.k !== b.k) return a.k < b.k ? -1 : 1;
        return a.i - b.i;
      })
      .map(function (o) { return o.r; });
  }

  /**
   * The rows GIVEN, split under the list's headings. A stable split: it does not sort (the caller orders first) and it
   * leaves out a row that is not on the list.
   * o: { me, names (from names()), meta (the board meta, for the stage order; may be null), today ('YYYY-MM-DD', Toronto) }.
   * Returns { who, name, title, groups: [{ key, title, section, rows, passed, noDate }] }:
   *   a person, a team or me: '<who>|mine' (they are Case Support Officer) then '<who>|review' (they are Case Manager and
   *     not officer); "My cases" / "With me for review" for me, "<Name>'s cases" / "With <Name> for review" for another;
   *     an empty group is left out;
   *   nobody: one group per Case Stage in the board's stage order, 'nobody|<stage index>', titled with the stage name
   *     (section 'nobody', stageIdx = the index);
   *   no list: no groups.
   * The keys carry the list, so what a person opens or closes is remembered per list.
   * title: "To-do · <name>" (my own name when known, else "To-do · My list"), "To-do · No one assigned", or "To-do".
   * name: the list's name on its own ('' for my own list with no name known, and for no list).
   * passed / noDate: how many of the group's rows have a due date before today / no due date.
   */
  function listFor(rows, who, o) {
    o = o || {};
    var w = normWho(who), me = o.me || null, nm = o.names || {}, today = day(o.today);
    function group(key, title, section, rs) {
      var passed = 0, noDate = 0;
      rs.forEach(function (r) { var d = dueDate(r); if (!d) noDate++; else if (today && d < today) passed++; });
      return { key: key, title: title, section: section, rows: rs, passed: passed, noDate: noDate };
    }
    if (!w) return { who: '', name: '', title: 'To-do', groups: [] };
    var on = (rows || []).filter(function (r) { return has(r, w, me); });
    if (w === 'nobody') {
      return { who: w, name: 'No one assigned', title: 'To-do · No one assigned',
        groups: CMU.groupRows(STAGE_VIEW, on, o.meta || null).map(function (g) {
          var out = group('nobody|' + CMU.groupId(g.key), g.title, 'nobody', g.rows);
          out.stageIdx = g.key;
          return out;
        }) };
    }
    var keys = whoKeys(w, me), mine = [], review = [];
    on.forEach(function (r) { (hit(officerKeys(r), keys) ? mine : review).push(r); });
    var isMe = w === 'me', name = isMe ? (s(me && me.name) || (keys.length && own(nm, keys[0]) ? s(nm[keys[0]]) : '')) : nameOf(w, nm);
    var groups = [];
    if (mine.length) groups.push(group(w + '|mine', isMe ? 'My cases' : name + "'s cases", 'mine', mine));
    if (review.length) groups.push(group(w + '|review', isMe ? 'With me for review' : 'With ' + name + ' for review', 'review', review));
    return { who: w, name: name, title: 'To-do · ' + (name || 'My list'), groups: groups };
  }

  /**
   * The names for a row's "With" pill: { lead: 'With' | 'Also with', list: [names] }. An empty list = the cell shows a dash.
   * The names are the row's Case Manager(s), from managerIds through names(). On a person's list that person is left out
   * (for 'me': me and my teams): in their own cases (section 'mine') the pill reads "With <the others>", in their review
   * cases (section 'review') "Also with <the others>". On "No one assigned", with no list, or on another tab (any other
   * section): 'With' and every manager. Never "Unassigned".
   * Where an id has no name in names() (a cell of people and teams together that never paired), the cell's own names are
   * shown as they are, less the name of the person whose list it is; a row that came without managerIds likewise.
   */
  function withNames(r, who, section, nm, me) {
    var sec = s(section), lead = sec === 'review' ? 'Also with' : 'With';
    var skip = sec === 'mine' || sec === 'review' ? whoKeys(who, me) : [], list = [];
    function add(n) { n = s(n); if (n && n !== 'Unassigned' && list.indexOf(n) < 0) list.push(n); }
    var keys = r && r.managerIds ? managerKeys(r) : null;
    if (keys && keys.every(function (k) { return own(nm, k) && s(nm[k]) !== ''; })) {
      keys.forEach(function (k) { if (skip.indexOf(k) < 0) add(nm[k]); });
      return { lead: lead, list: list };
    }
    var leave = [];
    skip.forEach(function (k) { if (own(nm, k) && s(nm[k])) leave.push(s(nm[k])); });
    if (skip.length && me && s(me.name) && normWho(who) === 'me') leave.push(s(me.name));
    var text = cellNames(r && r.manager);
    if (!text.length && keys) keys.forEach(function (k) { if (skip.indexOf(k) < 0) add(nameOf(k, nm)); });
    text.forEach(function (n) { if (leave.indexOf(n) < 0) add(n); });
    return { lead: lead, list: list };
  }

  return { TAG: TAG, normWho: normWho, names: names, nameOf: nameOf, open: open, people: people, resolveWho: resolveWho, sizeOf: sizeOf, has: has,
    dueDate: dueDate, dueField: dueField, duePassed: duePassed, order: order, listFor: listFor, withNames: withNames };
}

module.exports = { todoUi: todoUi };
