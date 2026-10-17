import nodemailer from 'nodemailer';
import { BRAND, button, emailImagesAvailable, featureRow, Images, inlineImagesFor, intro, legalDisclosure, linkFallback, note, renderBrandedEmail, safeHttpUrl, type LegalIdentity } from './brandEmail.js';

/** Branded account-verification email. The link is built by the caller from FRONTEND_URL. */
export function renderVerificationEmail(input: { verificationUrl: string; lifetimeMs: number; siteUrl?: string | null; legal?: LegalIdentity | null; includeImages?: boolean }) {
  const url = safeHttpUrl(input.verificationUrl);
  if (!url) throw new Error('Verification URL must be an absolute http(s) URL');
  const site = safeHttpUrl(input.siteUrl);
  const images = new Images(input.includeImages ?? true);
  const hours = Math.round(input.lifetimeMs / 3_600_000);
  const expiry = `This link will expire in ${hours} ${hours === 1 ? 'hour' : 'hours'}.`;
  const subject = `Welcome to ${BRAND.name} – please verify your email`;
  const heading = `Welcome to ${BRAND.name}!`;
  const message = 'Thank you for joining our community. Please verify your email address to complete your account and start your journey with us.';
  const ignore = 'If you did not create this account, you can safely ignore this email.';
  const notice = 'You are receiving this email because this address was used to create an account.';
  const legalLines = input.legal ? [...legalDisclosure(input.legal), notice] : [`${BRAND.name} is a store by ${BRAND.legalName}.`, notice];
  const features = [{ icon: 'gift', label: 'Curated sets and more' }, { icon: 'seedling', label: 'Safe & secure shopping' }, { icon: 'rainbow', label: 'A more creative tomorrow' }] as const;
  const html = renderBrandedEmail({
    title: subject, preheader: `Confirm your email to finish setting up your ${BRAND.name} account.`, hero: 'verification', images, heading,
    body: intro(message) + button('Verify my email address', url, { wide: true }) + note(expiry) + linkFallback(url) + note(ignore) + featureRow(images, [...features]),
    footerLinks: site ? [{ label: 'Visit our shop', href: site }] : [], legalLines,
  });
  const text = [heading, '', message, '', 'Verify my email address:', url, '', expiry, ignore, '', ...features.map(f => `• ${f.label}`), '',
    ...(site ? [`Visit our shop: ${site}`] : []), ...legalLines].join('\n');
  return { subject, text, html };
}

/** Raw MIME (multipart text/HTML with inline images) for SES SendRawEmail. File/URL loading disabled. */
export async function composeVerificationEmail(input: { to: string; from: string; replyTo?: string | null; legal?: LegalIdentity | null; verificationUrl: string; lifetimeMs: number; siteUrl?: string | null }) {
  const rendered = renderVerificationEmail({ verificationUrl: input.verificationUrl, lifetimeMs: input.lifetimeMs, siteUrl: input.siteUrl, legal: input.legal, includeImages: emailImagesAvailable() });
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const result = await composer.sendMail({ from: { name: BRAND.name, address: input.from }, to: input.to, ...(input.replyTo ? { replyTo: input.replyTo } : {}), subject: rendered.subject,
    text: rendered.text, html: rendered.html, disableFileAccess: true, disableUrlAccess: true, attachments: inlineImagesFor(rendered.html) });
  if (!Buffer.isBuffer(result.message)) throw new Error('MIME composition did not return bytes');
  return Buffer.from(result.message);
}
