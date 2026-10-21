// Renders printed copies of one centre's variant. Every page carries the copy code
// in the footer and as a faint diagonal watermark, so a photo of any page names its copy.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const LETTERS = 'ABCDEF';
const INK = '#1c2840';
const SOFT = '#4a5670';

/**
 * paper:  { examName, subject, title, instructions, durationMinutes, examStart }
 * centre: { code, name, city }
 * questions: variant-ordered [{ number, section, sectionTitle, text, options[], marks }]
 * copies: [{ copyCode, copyNo, reprintOf? }]
 */
export function renderCopies({ paper, centre, questions, copies }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, bufferPages: true,
      info: { Title: `${paper.subject}: ${paper.title}`, Author: 'SealedPaper', Subject: `Centre ${centre.code}` } });
    doc.registerFont('body', path.join(FONTS, 'DejaVuSans.ttf'));
    doc.registerFont('bold', path.join(FONTS, 'DejaVuSans-Bold.ttf'));

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageCopy = [];        // page index -> copy code
    let current = null;
    const width = doc.page.width - 112;
    const totalMarks = questions.reduce((s, q) => s + q.marks, 0);

    // The watermark is drawn first on every page, under the questions.
    const watermark = () => {
      pageCopy.push(current);
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('bold').fontSize(44).fillColor('#1c2840').fillOpacity(0.06)
        .text(current.copyCode, 0, doc.page.height / 2 - 30, { width: doc.page.width, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillOpacity(1).fillColor(INK);
      doc.x = doc.page.margins.left;
      doc.y = doc.page.margins.top;
    };
    doc.on('pageAdded', watermark);

    copies.forEach((copy, ci) => {
      current = copy;
      if (ci === 0) watermark();
      else doc.addPage();

      // ---- header ----
      doc.font('body').fontSize(9).fillColor(SOFT).text(paper.examName, { width });
      doc.moveDown(0.2);
      doc.font('bold').fontSize(17).fillColor(INK).text(`${paper.subject}: ${paper.title}`, { width });
      doc.moveDown(0.4);
      doc.font('body').fontSize(10).fillColor(INK);
      doc.text(`Centre ${centre.code}, ${centre.name}, ${centre.city}`, { width });
      doc.text(`Time allowed: ${paper.durationMinutes} minutes      Maximum marks: ${totalMarks}`, { width });
      doc.text(`Copy ${copy.copyCode}${copy.reprintOf ? ` (replaces ${copy.reprintOf})` : ''}`, { width });
      doc.moveDown(0.6);
      doc.moveTo(56, doc.y).lineTo(56 + width, doc.y).lineWidth(0.8).strokeColor(INK).stroke();
      doc.moveDown(0.6);

      if (paper.instructions?.trim()) {
        doc.font('bold').fontSize(10).text('Instructions', { width });
        doc.font('body').fontSize(9.5).fillColor(SOFT).text(paper.instructions.trim(), { width, lineGap: 1.5 });
        doc.fillColor(INK).moveDown(0.8);
      }

      // ---- questions ----
      let section = null;
      for (const q of questions) {
        if (q.section !== section) {
          section = q.section;
          if (doc.y > doc.page.height - 160) doc.addPage();
          doc.moveDown(0.4);
          doc.font('bold').fontSize(11).fillColor(INK).text(`Section ${LETTERS[section - 1] || section}: ${q.sectionTitle}`, { width });
          doc.moveDown(0.4);
        }
        const needed = 40 + q.options.length * 16;
        if (doc.y + needed > doc.page.height - 70) doc.addPage();
        doc.font('bold').fontSize(10.5).fillColor(INK).text(`${q.number}. `, { continued: true, width });
        doc.font('body').text(q.text, { continued: true, width });
        doc.fillColor(SOFT).fontSize(9).text(`   [${q.marks} mark${q.marks === 1 ? '' : 's'}]`, { width });
        doc.fillColor(INK).fontSize(10.5);
        q.options.forEach((opt, i) => {
          doc.text(`(${LETTERS[i]}) ${opt}`, 74, doc.y + 2, { width: width - 18 });
        });
        doc.x = 56;
        doc.moveDown(0.7);
      }
      doc.moveDown(0.5);
      doc.font('body').fontSize(9).fillColor(SOFT).text('End of paper', { width, align: 'center' });
    });

    // ---- footers, numbered per copy ----
    const range = doc.bufferedPageRange();
    const perCopy = new Map();
    for (let i = 0; i < range.count; i++) perCopy.set(pageCopy[i].copyCode, (perCopy.get(pageCopy[i].copyCode) || 0) + 1);
    const seen = new Map();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const code = pageCopy[i].copyCode;
      const n = (seen.get(code) || 0) + 1;
      seen.set(code, n);
      const y = doc.page.height - 44;
      doc.save();
      doc.page.margins.bottom = 0;
      doc.moveTo(56, y - 6).lineTo(doc.page.width - 56, y - 6).lineWidth(0.4).strokeColor('#b8c3d4').stroke();
      doc.font('body').fontSize(8).fillColor(SOFT)
        .text(`SealedPaper | Centre ${centre.code} | Copy ${code}`, 56, y, { width: width / 2 + 60, lineBreak: false });
      doc.text(`Page ${n} of ${perCopy.get(code)}`, 56, y, { width, align: 'right', lineBreak: false });
      doc.restore();
    }
    doc.end();
  });
}
