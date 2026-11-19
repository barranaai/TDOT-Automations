'use strict';

/**
 * The 19 questions of the shared questions page (questions.html, beside this file): ids, titles, the
 * suggested option and each option's key + text, in the order the page shows them.
 *
 * ONE list for the server: the answers API validates against it (a question id or an option key
 * that is not here is refused) and the admin read turns a stored key into plain words with it.
 * The page carries its own copy inside its inline script; the feature's test fails when the two
 * differ, so change both together.
 */

const QUESTIONS = Object.freeze([
  { id: "G1", title: "Should everyone sign in with their own Monday account?", sug: "b",
    opts: [["a","Yes, everyone, once each person has a Monday seat or another way to sign in is agreed"], ["b","Keep today's mix, and require Monday sign-in for each new “who did it” action (fee approval, waivers, hand-off)"], ["c","Keep the shared key as it is"]] },
  { id: "H1", title: "Who is on the retainer team, and who may send agreements?", sug: "b",
    opts: [["a","Only the retainer team sends; consultants set Retain and fill in the hand-off"], ["b","The retainer team normally, but a consultant (Shafoli or Shermin) may still send their own direct retainers"], ["c","Anyone, as today"]] },
  { id: "H2", title: "Must anything more be filled in before an outcome is saved?", sug: "b",
    opts: [["a","Keep it as now"], ["b","Follow-Up also needs a follow-up date"], ["c","Retain also needs the fee quoted and the payment plan (milestones) choice"]] },
  { id: "H3", title: "What is the general payment (milestone) plan?", sug: "a",
    opts: [["a","One payment, as now"], ["b","One split for every case (for example 50/50)"], ["c","A split per application type, from Asmita's sheet"]] },
  { id: "H4", title: "Who calls Follow-Up clients back, and when do we stop?", sug: "a",
    opts: [["a","The consultant must set a date, the retainer team calls on that date, and after 3 unanswered tries the client becomes Newsletter"], ["b","The consultant follows up"], ["c","Melanie follows up"]] },
  { id: "A1", title: "What happens when a client arrives without a signed agreement or a filled form?", sug: "a",
    opts: [["a","The agreement must be signed before the consultation starts (the client can sign on their phone on the spot); a missing form is only a warning"], ["b","Both are required, otherwise the consultation is rebooked with the fee carried over"], ["c","Warning only; the consultant decides"]] },
  { id: "B1", title: "How should a staff booking (early slot) work?", sug: "a",
    opts: [["a","Melanie books in the app with “Record payment / Waived (and book)” and also blocks the time in Square"], ["b","Melanie books in Square as now and adds it with “+ Direct consultation” the same day"], ["c","The app books the time and writes it into Square, checking Square's calendar for clashes (a bigger build)"], ["d","A special booking link with extra internal times"]] },
  { id: "B2", title: "When must an early-slot client pay?", sug: "a",
    opts: [["a","Pay first, as today"], ["b","Book now, pay later (say for whom in the note)"], ["c","Hold the time until paid and release it after 2 hours (not built yet)"]] },
  { id: "B3", title: "Who may waive the consultation fee?", sug: "d",
    opts: [["a","Melanie alone, existing or returning clients only, reason required"], ["b","Melanie asks, and you or Asmita approve first"], ["c","Anyone, reason required"], ["d","Melanie, and the consultants for their own clients; reason required; every waiver listed with who and why in Reporting each month"]] },
  { id: "B4", title: "Cash or e-transfer: can a time be booked before the money arrives?", sug: "a",
    opts: [["a","Only after it is received, everywhere"], ["b","Book first; the client pays before or at the consultation"], ["c","Book first, but the consultation can't start until it is marked paid"]] },
  { id: "B5", title: "Prajawal's leads, and who may book a time for a client", sug: "a",
    opts: [["a","Prajawal sends the booking invite for his own leads; Melanie owns all others; booking a time is Melanie's job, plus the consultants for their own existing clients"], ["b","Prajawal passes his leads to Melanie, who sends the invite and books"], ["c","Anyone may send invites and book, as today"]] },
  { id: "F1", title: "Who approves a fee more than $500 below the minimum?", sug: "a",
    opts: [["a","You only"], ["b","You or Asmita"], ["c","Both of you"], ["d","Not allowed"]] },
  { id: "F2", title: "What does Asmita's minimum-fee sheet hold?", sug: "a",
    opts: [["a","One number per application: the lowest we accept"], ["b","Two numbers: the usual price and the lowest"]] },
  { id: "F3", title: "How is the minimum set?", sug: "a",
    opts: [["a","Per case type, plus sub-type rows (e.g. CEC single vs with spouse and child), with an optional amount per extra person"], ["b","Per case type only"], ["c","Per scope annex"]] },
  { id: "F4", title: "When can Asmita have the minimum-fee sheet ready?", sug: "a",
    opts: [["a","Yes, send the template and she will fill it in"], ["b","She will make her own sheet"]] },
  { id: "D1", title: "What is the limit per half-month window?", sug: "a",
    opts: [["a","20 for the whole firm"], ["b","25 for the whole firm"], ["c","Per case manager"], ["d","Per consultant"], ["e","No number: Asmita and Deeksha judge from the counts"]] },
  { id: "R1", title: "Which red items should chase a named person, and who gets each?", sug: "b",
    opts: [["a","The longer 8-item list from 15 October"], ["b","The shorter first cut above, built on the lists that already exist"], ["c","Keep the lists only, with no chasing"]] },
  { id: "R2", title: "How should a red item reach the person?", sug: "a",
    opts: [["a","One email per person each working morning, with links, plus red rows in the app"], ["b","A Monday bell notification, as Assign uses"], ["c","Both"]] },
  { id: "O1", title: "How is the client told the consultation is recorded and transcribed, and what if they say no?", sug: "a",
    opts: [["a","A line in the consultation agreement plus a spoken notice at the start"], ["b","A spoken notice only"], ["c","Record only when the client agrees"]] },
].map((q) => Object.freeze({ ...q, opts: Object.freeze(q.opts.map((o) => Object.freeze(o))) })));

module.exports = { QUESTIONS };
