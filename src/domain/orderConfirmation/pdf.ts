import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { create } from 'fontkit';
import { addressLines, deliveryEstimate, gbp, invoiceDate, invoiceSchema, NON_VAT_STATEMENT, type Invoice } from './contract.js';
export class UnsupportedInvoiceText extends Error {}
export class InvoiceFontUnavailable extends Error {}
export function loadInvoiceFont(url = new URL('../../../assets/fonts/DejaVuSans.ttf', import.meta.url)) {
  try {
    const bytes = readFileSync(url);
    const parsed = create(bytes);
    const font = 'fonts' in parsed ? parsed.fonts[0] : parsed;
    if (!font) throw new Error('Missing font');
    return { bytes, font };
  } catch { throw new InvoiceFontUnavailable('Approved invoice font unavailable'); }
}
export async function generateInvoicePdf(value: Invoice): Promise<Buffer> {
  const s = invoiceSchema.parse(value), p = s.purchase, b = s.business;
  const lines = [b.legalName, ...b.registeredAddress, `Company registration number: ${b.registrationNumber}`, '', 'Commercial invoice', `Invoice: ${s.invoiceNumber}`, `Invoice date: ${invoiceDate(s.issuedAt)}`, `Order: #${p.orderId}`, `Payment: received in GBP (${invoiceDate(p.paidAt)})`, '', 'Bill to', ...addressLines(p.billing), '', 'Deliver to', ...addressLines(p.shippingAddress), '', ...p.items.flatMap(i => [i.description + (i.setNumber ? ` (${i.setNumber})` : ''), `Quantity: ${i.quantity} | Unit price: ${gbp(i.unitPence)} | Line total: ${gbp(i.linePence)}`, '']), `Subtotal: ${gbp(p.subtotalPence)}`, `Delivery: ${p.delivery.method}`, `Delivery charge: ${gbp(p.delivery.chargePence)}`, `Estimate: ${deliveryEstimate(p)}`, `Total paid: ${gbp(p.totalPence)} GBP`, '', NON_VAT_STATEMENT];
  const { bytes: fontBytes, font } = loadInvoiceFont();
  for (const line of lines) for (const char of line) if (!/\s/.test(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!)) throw new UnsupportedInvoiceText('Invoice text needs an approved font with wider coverage');
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: 'Commercial invoice', Author: b.legalName, CreationDate: new Date(s.issuedAt), ModDate: new Date(s.issuedAt) } });
  const output = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    doc.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 3_000_000) doc.destroy(new Error('Invoice exceeds attachment budget')); else chunks.push(chunk); });
    doc.once('error', reject); doc.once('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.font(fontBytes).fontSize(11);
  for (const line of lines) doc.text(line || ' ', { width: 499, lineGap: 3 });
  doc.end();
  return output;
}
