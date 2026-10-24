// Stamps a released PDF for one reader: every page gets
//   - a footer: "Confidential. Issued to <name> <email>. Copy <code>. <date>"
//   - a faint diagonal watermark with the reader's name and the copy code
//   - the copy code as tiny white text, so even copy-pasted text carries it
// and the PDF metadata carries the code too. A leaked page, photo or paste names its reader.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const FONT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'));
const INK = rgb(0.11, 0.16, 0.25);

export function isPdf(buffer, mimeType) {
  return mimeType === 'application/pdf' || Buffer.from(buffer.subarray(0, 5)).toString() === '%PDF-';
}

export async function stampPdf(buffer, { readerName, readerEmail, copyCode, title, issuedAt = new Date() }) {
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false, updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(FONT, { subset: true });
  const when = issuedAt.toISOString().slice(0, 16).replace('T', ' ');
  const footer = `Confidential. Issued to ${readerName} (${readerEmail}). Copy ${copyCode}. ${when} UTC`;

  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(14, Math.min(width, height) / 18);
    const mark = `${readerName}  ${copyCode}`;
    const markWidth = font.widthOfTextAtSize(mark, size);
    page.drawText(mark, {
      x: width / 2 - (markWidth / 2) * Math.cos(Math.PI / 6),
      y: height / 2 - (markWidth / 2) * Math.sin(Math.PI / 6),
      size, font, color: INK, opacity: 0.08, rotate: degrees(30),
    });
    let fsize = 7;
    while (font.widthOfTextAtSize(footer, fsize) > width - 40 && fsize > 4) fsize -= 0.5;
    page.drawRectangle({ x: 0, y: 0, width, height: 18, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(footer, { x: 20, y: 6, size: fsize, font, color: INK });
    // invisible to the eye, but kept when someone selects all and copies the text
    page.drawText(`[${copyCode}]`, { x: 20, y: height - 8, size: 2, font, color: rgb(1, 1, 1) });
  }
  pdf.setTitle(title);
  pdf.setSubject(`Confidential copy ${copyCode} issued to ${readerEmail}`);
  pdf.setKeywords(['SealedPaper', copyCode]);
  pdf.setProducer('SealedPaper');
  return Buffer.from(await pdf.save());
}
