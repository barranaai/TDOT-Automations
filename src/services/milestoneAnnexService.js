/**
 * milestoneAnnexService — renders the retainer's payment / milestone schedule as
 * a dynamic one-page PDF annex (pdfkit), appended after the scope annex. Each
 * milestone shows its amount, its own HST, and the total (incl. HST); a totals
 * row sums them; the government fee is listed separately with NO HST.
 *
 * Built per-case from the consultant's saved milestones + HST rate, so it can't
 * be a static template.
 */

'use strict';

const PDFDocument = require('pdfkit');
const { BRAND } = require('../branding');
const { centsToMoney, dollarsToMoney } = require('../utils/money');

const m = (c) => '$' + centsToMoney(c);

/**
 * @param {{ schedule:{rows,totals}, hstRate:number, govFeeDollars?:number|null,
 *           govFeeEmployerPaid?:boolean, paName?:string, applicationType?:string }} p
 * @returns {Promise<Buffer>}
 */
function buildMilestoneAnnexPdf({ schedule, hstRate = 0.13, govFeeDollars = null, govFeeEmployerPaid = false, paName = '', applicationType = '' } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = BRAND.darkPanel, red = BRAND.primary, muted = BRAND.mutedOnLight;
    const ratePct = Math.round((Number(hstRate) || 0) * 100);
    const X = 56, W = 500;

    // Letterhead
    doc.fillColor(red).fontSize(13).font('Helvetica-Bold').text('TDOT Immigration', X, 50);
    doc.font('Helvetica').fillColor(muted).fontSize(8.5).text('20 De Boers Dr., Suite 202, Toronto ON M3J 0H1  ·  www.tdotimm.com', X);

    // Annex title block (centred)
    doc.moveDown(1.3);
    doc.fillColor(navy).fontSize(16).font('Helvetica-Bold').text('ANNEX B', X, doc.y, { width: W, align: 'center' });
    doc.fillColor('#111111').fontSize(12).font('Helvetica').text('Fee Structure and Payment Schedule', X, doc.y + 2, { width: W, align: 'center' });
    doc.moveDown(0.7);
    doc.strokeColor('#CCCCCC').lineWidth(1).moveTo(X, doc.y).lineTo(X + W, doc.y).stroke();

    // Client / Matter
    doc.moveDown(0.9).fillColor('#111111').fontSize(10).font('Helvetica');
    if (paName) doc.text(`Client:   ${paName}`, X, doc.y, { width: W });
    if (applicationType) doc.text(`Matter:  ${applicationType}`, X, doc.y, { width: W });

    doc.moveDown(0.7).fillColor('#333333').fontSize(10).text(
      'The Client will be billed a flat professional fee for this matter, payable by milestones as set out below.',
      X, doc.y, { width: W, align: 'justify' });

    doc.moveDown(0.7).fillColor(navy).fontSize(11).font('Helvetica-Bold').text('Professional fee — payment by milestones', X, doc.y, { width: W });
    doc.font('Helvetica').moveDown(0.4);

    // Table
    const cols = [{ w: 196, t: 'Milestone', a: 'left' }, { w: 102, t: 'Amount (CAD)', a: 'right' },
                  { w: 100, t: `HST (${ratePct}%)`, a: 'right' }, { w: 102, t: 'Total (CAD)', a: 'right' }];
    const RH = 24;

    // A milestone label may wrap in its 196px column (staff type them freely) —
    // each row grows to fit its label instead of clipping the second line.
    function rowHeightFor(label) {
      doc.fontSize(10).font('Helvetica');
      const h = doc.heightOfString(String(label), { width: cols[0].w - 4 });
      return Math.max(RH, Math.ceil(h) + 14);
    }

    function drawRow(y, cells, { head = false, bold = false } = {}) {
      let cx = X;
      cells.forEach((txt, i) => {
        doc.fillColor(head || bold ? navy : '#111111').fontSize(head ? 9 : 10).font(bold || head ? 'Helvetica-Bold' : 'Helvetica')
           .text(String(txt), cx + (cols[i].a === 'left' ? 4 : 0), y + 7,
                 { width: cols[i].w - (cols[i].a === 'left' ? 4 : 8), align: cols[i].a });
        cx += cols[i].w;
      });
      doc.font('Helvetica');
    }

    let y = doc.y;
    doc.rect(X, y, W, RH).fill('#f1f3f6');
    drawRow(y, cols.map((c) => c.t), { head: true }); y += RH;

    schedule.rows.forEach((r, i) => {
      // Row 1 carries the asterisk pointing at the 50% non-refundable note below.
      const label = i === 0 ? `${r.label} *` : r.label;
      const rh = rowHeightFor(label);
      drawRow(y, [label, m(r.amountCents), m(r.hstCents), m(r.totalCents)]);
      doc.strokeColor('#eceef2').moveTo(X, y + rh).lineTo(X + W, y + rh).stroke();
      y += rh;
    });

    doc.rect(X, y, W, RH).fill('#fbeaea');
    drawRow(y, ['Total professional fee', m(schedule.totals.amountCents), m(schedule.totals.hstCents), m(schedule.totals.totalCents)], { bold: true });
    y += RH;

    // First-milestone (admin fee) acknowledgement — mirrors the master agreement.
    // The 50% is stated with the ACTUAL dollar figures so the fee schedule leaves
    // no room for interpretation about what is and is not refundable.
    // Reset x to the left margin (the table left doc.x at the last column).
    let cy = y + 18;
    const first = schedule.rows[0];
    const adminHalfCents = first ? Math.round(first.amountCents / 2) : 0;
    doc.fillColor(navy).fontSize(10).font('Helvetica-Bold').text('* First milestone — administrative fee (50% non-refundable)', X, cy, { width: W });
    doc.font('Helvetica').fillColor('#111111').fontSize(9.5).text(
      `Of the first milestone payment of ${first ? m(first.amountCents) : '$0.00'} (before HST), fifty percent (50%) — ${m(adminHalfCents)} — `
      + 'constitutes a non-refundable administrative fee, charged upon engagement. The remainder of the first milestone is subject to the '
      + 'refund terms of the retainer agreement. By signing the retainer agreement, the Client acknowledges and agrees to this.',
      X, doc.y + 2, { width: W, align: 'justify' });
    cy = doc.y + 14;

    if (govFeeDollars != null) {
      doc.fillColor(navy).fontSize(11).font('Helvetica-Bold').text('Government fee (third-party disbursement)', X, cy, { width: W });
      const who = govFeeEmployerPaid ? 'employer-paid to ESDC' : 'payable to IRCC';
      doc.font('Helvetica').fillColor('#111111').fontSize(10).text(
        `$${dollarsToMoney(govFeeDollars)} — ${who}, separate from the professional fee and not subject to HST.`, X, doc.y + 3, { width: W });
      cy = doc.y + 12;
    }

    doc.fillColor(muted).fontSize(9).font('Helvetica').text(
      'Amounts are shown before and after HST. HST applies to the professional fee only; government fees are third-party '
      + 'disbursements and are not subject to HST. Milestone payments are due as set out above, and the application proceeds '
      + 'to each stage upon receipt of the corresponding payment.', X, cy, { width: W, align: 'justify' });

    doc.end();
  });
}

module.exports = { buildMilestoneAnnexPdf };
