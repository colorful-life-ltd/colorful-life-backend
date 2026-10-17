import { readFileSync } from 'node:fs';

/**
 * Build & Bloom transactional email layout, following the owner-approved reference
 * (src/assets/email/reference/email-template-reference.png). Pure, provider-independent
 * rendering: table layout, inline styles, embedded (CID) images only, no scripts, remote
 * images, web fonts or tracking. Callers pass validated data; all dynamic text is escaped here.
 */
export const BRAND = { name: 'Build & Bloom', legalName: 'Colorful Life Ltd' } as const;
const C = { page: '#efe9df', card: '#fbf8f2', heading: '#1e2b21', text: '#3d3a33', muted: '#6b665c', rule: '#e7e0d3', panel: '#fffdf9', total: '#ebe8df', button: '#2e5435', footer: '#f4efe6' };
const SERIF = "Georgia,'Times New Roman',Times,serif", SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";

/** Inline images. Heroes are the approved final illustrations (optimised JPEG); icons are small decorative PNGs. */
const IMAGES = {
  'hero-verification': { file: 'email-verification-hero.jpg', type: 'image/jpeg' },
  'hero-order-confirmation': { file: 'email-order-confirmation-hero.jpg', type: 'image/jpeg' },
  'hero-dispatch': { file: 'email-dispatch-hero.jpg', type: 'image/jpeg' },
  'sprig': { file: 'icons/sprig.png', type: 'image/png' }, 'gift': { file: 'icons/gift.png', type: 'image/png' },
  'seedling': { file: 'icons/seedling.png', type: 'image/png' }, 'rainbow': { file: 'icons/rainbow.png', type: 'image/png' },
  'truck': { file: 'icons/truck.png', type: 'image/png' }, 'envelope': { file: 'icons/envelope.png', type: 'image/png' },
  'box': { file: 'icons/box.png', type: 'image/png' }, 'calendar': { file: 'icons/calendar.png', type: 'image/png' },
  'branch-left': { file: 'icons/branch-left.png', type: 'image/png' }, 'branch-right': { file: 'icons/branch-right.png', type: 'image/png' },
} as const;
export type EmailImage = keyof typeof IMAGES;
export type EmailHero = 'verification' | 'order-confirmation' | 'dispatch';
const CID_PREFIX = 'bb-';
const ASSET_ROOT = new URL('../../../assets/email/', import.meta.url);
const heroAlt: Record<EmailHero, string> = {
  'verification': 'Illustration of a child and her dog arriving at the Build & Bloom shop',
  'order-confirmation': 'Illustration of a child and her dog reading a picture book in the Build & Bloom shop',
  'dispatch': 'Illustration of parcels being loaded into a Build & Bloom delivery van outside the shop',
};

function readImage(name: EmailImage, root: URL): Buffer | null {
  try {
    const bytes = readFileSync(new URL(IMAGES[name].file, root));
    const ok = IMAGES[name].type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return ok ? bytes : null;
  } catch { return null; }
}
/** Images are decorative: if any asset is missing the email renders text-only rather than with broken images. */
export function emailImagesAvailable(root = ASSET_ROOT) { return (Object.keys(IMAGES) as EmailImage[]).every(n => readImage(n, root) !== null); }
/** Inline attachments for exactly the cid: references present in the rendered HTML. */
export function inlineImagesFor(html: string, root = ASSET_ROOT) {
  const names = [...new Set([...html.matchAll(/src="cid:bb-([a-z-]+)"/g)].map(m => m[1]))];
  return names.map(name => {
    if (!(name in IMAGES)) throw new Error(`Unknown email image ${name}`);
    const content = readImage(name as EmailImage, root);
    if (!content) throw new Error(`Email image ${name} unavailable`);
    return { filename: IMAGES[name as EmailImage].file.split('/').pop()!, content, contentType: IMAGES[name as EmailImage].type, cid: `${CID_PREFIX}${name}`, contentDisposition: 'inline' as const };
  });
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const e = escapeHtml;

/** Absolute http(s) URL or null. Links are only rendered from these. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
}

const regionNames = new Intl.DisplayNames(['en-GB'], { type: 'region' });
/** Customer-facing country name for an ISO alpha-2 code (invoice PDFs keep the code). */
export function countryName(code: string) { try { return regionNames.of(code) ?? code; } catch { return code; } }
/** e.g. "17 Oct 2026, 10:15 (UTC)". */
export const dateTimeUtc = (iso: string) => `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(new Date(iso))} (UTC)`;
export const shortDate = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

/** Renders inline images only when the composer confirmed the assets are available. */
export class Images {
  constructor(readonly enabled: boolean) {}
  img(name: EmailImage, width: number, height: number, alt = '', style = '') {
    return this.enabled ? `<img src="cid:${CID_PREFIX}${name}" width="${width}" height="${height}" alt="${e(alt)}" style="display:block;border:0;outline:none;text-decoration:none;width:${width}px;height:${height}px;${style}">` : '';
  }
}

const p = (text: string, style: string) => `<p style="margin:0;font-family:${SANS};color:${C.text};${style}">${e(text)}</p>`;
export const intro = (text: string) => p(text, 'font-size:16px;line-height:1.55;text-align:center;padding:0 0 22px;');
export const note = (text: string, align: 'center' | 'left' = 'center') => p(text, `font-size:13px;line-height:1.55;color:${C.muted};text-align:${align};padding:0 0 10px;`);

/** Bulletproof rounded button with arrow. Returns '' when the URL is not a safe absolute link. */
export function button(label: string, url: string | null | undefined, opts: { wide?: boolean } = {}) {
  const href = safeHttpUrl(url);
  if (!href) return '';
  return `<table role="presentation" ${opts.wide ? 'width="100%" ' : ''}cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 14px;"><tr><td align="center" bgcolor="${C.button}" style="border-radius:7px;background-color:${C.button};">`
    + `<a href="${e(href)}" target="_blank" style="display:block;padding:15px 34px;font-family:${SANS};font-size:17px;font-weight:bold;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:7px;text-align:center;">${e(label)}&nbsp;&nbsp;&rarr;</a>`
    + `</td></tr></table>`;
}
/** Visible copy-paste fallback for a critical link. */
export const linkFallback = (url: string) => `<p style="margin:0;padding:0 0 12px;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.muted};text-align:center;overflow-wrap:anywhere;word-break:break-all;">If the button does not work, copy this link into your browser:<br><a href="${e(url)}" style="color:${C.button};">${e(url)}</a></p>`;

/** Rounded panel used for the order summary, dispatch details and info cards. */
export const card = (inner: string, pad = '16px 18px') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.rule};border-radius:10px;background-color:${C.panel};border-collapse:separate;"><tr><td style="padding:${pad};">${inner}</td></tr></table>`;

export type SummaryItem = { description: string; detail: string | null; quantity: number; amount: string };
/** Order summary card: header, items, totals, highlighted total paid, optional delivery address. */
export function orderSummary(s: { orderLabel: string; dateLabel: string; items: SummaryItem[]; totals: Array<{ label: string; value: string }>; total: { label: string; value: string }; deliverTo?: string }) {
  const cell = `font-family:${SANS};color:${C.text};vertical-align:top;`;
  const items = s.items.map(i => `<tr><td style="${cell}padding:14px 0;border-top:1px solid ${C.rule};overflow-wrap:anywhere;word-break:break-word;"><span style="font-size:15px;font-weight:bold;line-height:1.4;">${e(i.description)}</span><br>`
    + `<span style="font-size:13px;line-height:1.6;color:${C.muted};">Qty: ${i.quantity}${i.detail ? ` &middot; ${e(i.detail)}` : ''}</span></td>`
    + `<td align="right" width="90" style="${cell}padding:14px 0 14px 10px;border-top:1px solid ${C.rule};font-size:15px;line-height:1.4;white-space:nowrap;">${e(i.amount)}</td></tr>`).join('');
  const totals = s.totals.map((t, n) => `<tr><td style="${cell}padding:${n ? 3 : 12}px 0 3px;font-size:14px;line-height:1.5;${n ? '' : `border-top:1px solid ${C.rule};`}">${e(t.label)}</td><td align="right" style="${cell}padding:${n ? 3 : 12}px 0 3px 10px;font-size:14px;line-height:1.5;white-space:nowrap;${n ? '' : `border-top:1px solid ${C.rule};`}">${e(t.value)}</td></tr>`).join('');
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;">`
    + `<tr><td style="padding:16px 18px 12px;font-family:${SERIF};font-size:21px;line-height:1.3;color:${C.heading};vertical-align:top;white-space:nowrap;">Order summary</td>`
    + `<td align="right" width="110" style="padding:18px 18px 12px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${C.text};vertical-align:top;">${e(s.orderLabel)}<br>${e(s.dateLabel)}</td></tr>`
    + `<tr><td colspan="2" style="padding:0 18px;"><table role="presentation" aria-label="Items in your order" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;">${items}${totals}<tr><td colspan="2" style="padding:0 0 10px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`
    + `<tr><td colspan="2" bgcolor="${C.total}" style="background-color:${C.total};padding:12px 18px;${s.deliverTo ? '' : 'border-radius:0 0 10px 10px;'}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td style="font-family:${SANS};font-size:17px;font-weight:bold;line-height:1.3;color:${C.heading};">${e(s.total.label)}</td><td align="right" style="font-family:${SANS};font-size:17px;font-weight:bold;line-height:1.3;color:${C.heading};white-space:nowrap;">${e(s.total.value)}</td></tr></table></td></tr>`
    + (s.deliverTo ? `<tr><td colspan="2" style="padding:12px 18px 14px;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.muted};overflow-wrap:anywhere;"><strong style="color:${C.text};">Delivering to:</strong> ${e(s.deliverTo)}</td></tr>` : '')
    + `</table>`;
  return card(inner, '0');
}

/** Icon + label + value rows (dispatch details). */
export function detailRows(images: Images, rows: Array<{ icon: EmailImage; label: string; value: string }>) {
  const body = rows.map((r, n) => `<tr>${images.enabled ? `<td width="36" style="padding:${n ? 10 : 2}px 10px 2px 0;vertical-align:middle;">${images.img(r.icon, 26, 26)}</td>` : ''}`
    + `<td width="36%" style="padding:${n ? 10 : 2}px 8px 2px 0;font-family:${SANS};font-size:15px;line-height:1.45;color:${C.text};vertical-align:middle;">${e(r.label)}</td>`
    + `<td style="padding:${n ? 10 : 2}px 0 2px;font-family:${SANS};font-size:15px;line-height:1.45;color:${C.heading};vertical-align:middle;overflow-wrap:anywhere;">${e(r.value)}</td></tr>`).join('');
  return card(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;">${body}</table>`, '16px 20px');
}

/** Small icon cards side by side on desktop, stacked on mobile. Body text is escaped; bodyHtml is trusted markup. */
export function infoCards(images: Images, cards: Array<{ icon: EmailImage; title: string; body: string }>) {
  const col = (c: (typeof cards)[number]) => card(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${images.enabled ? `<td width="40" style="vertical-align:top;padding:0 10px 0 0;">${images.img(c.icon, 30, 30)}</td>` : ''}`
    + `<td style="vertical-align:top;font-family:${SANS};"><p style="margin:0 0 4px;font-size:14px;font-weight:bold;line-height:1.4;color:${C.heading};">${e(c.title)}</p><p style="margin:0;font-size:13px;line-height:1.5;color:${C.text};overflow-wrap:anywhere;">${e(c.body)}</p></td></tr></table>`, '14px 14px');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cards.map((c, n) => `<td class="bb-col" width="50%" style="vertical-align:top;padding:0 ${n ? 0 : 6}px 12px ${n ? 6 : 0}px;">${col(c)}</td>`).join('')}</tr></table>`;
}

/** Three icon features under a divider (verification). */
export function featureRow(images: Images, features: Array<{ icon: EmailImage; label: string }>) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.rule};margin-top:14px;"><tr>`
    + features.map(f => `<td width="33%" align="center" style="padding:22px 6px 6px;vertical-align:top;">${images.enabled ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 8px;"><tr><td>${images.img(f.icon, 40, 40)}</td></tr></table>` : ''}`
      + `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.4;color:${C.text};">${e(f.label)}</p></td>`).join('')
    + `</tr></table>`;
}

/** Company identity from environment configuration (ORDER_CONFIRMATION_BUSINESS_JSON); never hardcoded. */
export type LegalIdentity = { legalName: string; registrationNumber: string; registeredAddress: string[]; registeredIn?: string };
/** UK trading disclosures shown in every footer: name, place of registration, number and registered office. */
export const legalDisclosure = (b: LegalIdentity) => [`${BRAND.name} is a store by ${b.legalName}.`, b.legalName,
  ...(b.registeredIn ? [`Registered in ${b.registeredIn}`] : []), `Company No. ${b.registrationNumber}`, `Registered office: ${b.registeredAddress.join(', ')}`];

export type BrandedEmail = {
  title: string; preheader: string; hero: EmailHero; images: Images; heading: string; subheading?: string; body: string;
  footerLinks: Array<{ label: string; href: string }>; legalLines: string[];
};

function brandLockup(images: Images, size: 'header' | 'footer') {
  const big = size === 'header';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>`
    + (images.enabled ? `<td style="padding:0 10px 0 0;vertical-align:middle;">${images.img('sprig', big ? 36 : 28, big ? 40 : 31)}</td>` : '')
    + `<td style="vertical-align:middle;text-align:left;"><p style="margin:0;font-family:${SERIF};font-size:${big ? 32 : 25}px;line-height:1.1;color:${C.heading};">${e(BRAND.name)}</p>`
    + `<p style="margin:3px 0 0;font-family:${SANS};font-size:${big ? 13 : 11}px;line-height:1.3;color:${C.muted};">A store by ${e(BRAND.legalName)}</p></td></tr></table>`;
}

/** Wraps already-rendered body HTML in the shared Build & Bloom shell. */
export function renderBrandedEmail(m: BrandedEmail) {
  const { images } = m;
  const hero = images.enabled ? `<tr><td style="padding:0;line-height:0;font-size:0;"><img src="cid:${CID_PREFIX}hero-${m.hero}" width="600" alt="${e(heroAlt[m.hero])}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none;"></td></tr>` : '';
  const links = m.footerLinks.filter(l => safeHttpUrl(l.href) || /^mailto:[^\s"<>]+@[^\s"<>]+$/.test(l.href)).map(l => `<a href="${e(l.href)}" style="color:${C.text};text-decoration:none;font-family:${SANS};font-size:12px;">${e(l.label)}</a>`).join(`<span style="color:${C.rule};">&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;</span>`);
  const branch = (side: 'left' | 'right') => images.enabled ? `<td class="bb-branch" width="56" style="vertical-align:middle;padding:0;">${images.img(`branch-${side}`, 48, 72)}</td>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${e(m.title)}</title>`
    + `<style>@media only screen and (max-width:620px){.bb-pad{padding-left:20px!important;padding-right:20px!important}.bb-h1{font-size:28px!important}.bb-outer{padding:0!important}.bb-col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}.bb-branch{display:none!important}.bb-tag{letter-spacing:2px!important;font-size:10px!important}}</style></head>`
    + `<body style="margin:0;padding:0;background-color:${C.page};-webkit-text-size-adjust:100%;">`
    + `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${e(m.preheader)}</div>`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};"><tr><td align="center" class="bb-outer" style="padding:24px 12px;">`
    + `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="max-width:600px;background-color:${C.card};">`
    + `<tr><td align="center" style="padding:22px 20px 0;">${brandLockup(images, 'header')}</td></tr>`
    + `<tr><td align="center" class="bb-tag" style="padding:14px 10px 16px;font-family:${SANS};font-size:11px;line-height:1.2;letter-spacing:3px;color:${C.text};">CREATIVITY&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;PLAY&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;GROW&nbsp;TOGETHER</td></tr>`
    + hero
    + `<tr><td class="bb-pad" style="padding:28px 36px 6px;"><h1 class="bb-h1" style="margin:0;padding:0 0 ${m.subheading ? 6 : 14}px;font-family:${SERIF};font-size:36px;line-height:1.15;font-weight:normal;color:${C.heading};text-align:center;">${e(m.heading)}</h1>`
    + (m.subheading ? `<p style="margin:0;padding:0 0 12px;font-family:${SANS};font-size:18px;line-height:1.4;font-weight:bold;color:${C.heading};text-align:center;">${e(m.subheading)}</p>` : '')
    + `${m.body}</td></tr>`
    + `<tr><td bgcolor="${C.footer}" style="padding:20px 16px 18px;background-color:${C.footer};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${branch('left')}`
    + `<td align="center" style="vertical-align:middle;">${brandLockup(images, 'footer')}${links ? `<p style="margin:12px 0 0;line-height:1.6;">${links}</p>` : ''}</td>${branch('right')}</tr></table>`
    + `<p style="margin:14px 0 0;font-family:${SANS};font-size:11px;line-height:1.6;color:${C.muted};text-align:center;overflow-wrap:anywhere;">${m.legalLines.map(e).join('<br>')}</p></td></tr>`
    + `</table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
}
