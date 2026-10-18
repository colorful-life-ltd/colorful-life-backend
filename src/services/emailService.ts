import { assertRealEmailAllowed, testEmailMode } from "../config/testEmail.js";
import { SESClient, SendEmailCommand, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config/index.js";
import { composeVerificationEmail } from "../domain/email/verificationEmail.js";
import { approvedLegalIdentity, approvedSupportReplyTo } from "../domain/email/supportContact.js";
import { EMAIL_VERIFICATION_TOKEN_LIFETIME_MS } from "../domain/auth/emailVerificationService.js";

export type VerificationEmail = { recipientEmail: string; verificationUrl: string };
type VerificationEmailSender = (email: VerificationEmail) => Promise<void>;
export type PasswordResetEmail = { recipientEmail: string; resetUrl: string };
type PasswordResetEmailSender = (email: PasswordResetEmail) => Promise<void>;

let sesClient: SESClient | undefined;
function realSesClient() {
  assertRealEmailAllowed();
  return sesClient ??= new SESClient({ region: config.AWS_REGION });
}

// Branded Build & Bloom HTML with a plain-text fallback and an embedded hero, hence raw MIME.
const sesVerificationEmailSender: VerificationEmailSender = async (email) => {
  if (testEmailMode()) return; // Deterministic no-send default; content tests inject a capture sender.
  const message = await composeVerificationEmail({ to: email.recipientEmail, from: config.SES_FROM_EMAIL, replyTo: approvedSupportReplyTo(), legal: approvedLegalIdentity(),
    verificationUrl: email.verificationUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS, siteUrl: config.FRONTEND_URL });
  await realSesClient().send(new SendRawEmailCommand({ Source: config.SES_FROM_EMAIL, Destinations: [email.recipientEmail], RawMessage: { Data: message } }));
};

export function buildPasswordResetEmailCommand(email: PasswordResetEmail) {
  return new SendEmailCommand({
    Source: config.SES_FROM_EMAIL,
    Destination: { ToAddresses: [email.recipientEmail] },
    Message: {
      Subject: { Data: "Reset your Colorful Life password", Charset: "UTF-8" },
      Body: { Text: { Data: [
        "Use the link below to reset your Colorful Life password:",
        email.resetUrl,
        "This link expires in 1 hour.",
      ].join("\n"), Charset: "UTF-8" } },
    },
  });
}

const sesPasswordResetEmailSender: PasswordResetEmailSender = async (email) => {
  if (testEmailMode()) return;
  await realSesClient().send(buildPasswordResetEmailCommand(email), { abortSignal: AbortSignal.timeout(1500) });
};

let verificationSender: VerificationEmailSender = sesVerificationEmailSender;
let passwordResetSender: PasswordResetEmailSender = sesPasswordResetEmailSender;

export function setVerificationEmailSenderForTests(testSender: VerificationEmailSender): () => void {
  const previous = verificationSender;
  verificationSender = testSender;
  return () => { verificationSender = previous; };
}

export function sendVerificationEmail(email: VerificationEmail): Promise<void> {
  return verificationSender(email);
}

export function setPasswordResetEmailSenderForTests(testSender: PasswordResetEmailSender): () => void {
  const previous = passwordResetSender;
  passwordResetSender = testSender;
  return () => { passwordResetSender = previous; };
}

export function sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
  return passwordResetSender(email);
}

// Compatibility path until durable dispatch is explicitly activated. No new opt-in
// or business bundle is required to preserve the pre-existing notification.
export type DispatchNotification = { customerEmail: string; orderId: number; shippingCarrier: string; trackingNumber?: string | null; dispatchedAt: Date };
type DispatchSender = (notification: DispatchNotification) => Promise<void>;
const legacyDispatchSender: DispatchSender = async notification => {
  assertRealEmailAllowed();
  const client = new SESClient({ region: config.AWS_REGION, maxAttempts: 1 });
  try {
    const result = await client.send(new SendEmailCommand({
      Source: config.SES_FROM_EMAIL, Destination: { ToAddresses: [notification.customerEmail] },
      Message: { Subject: { Data: `Your order #${notification.orderId} has been dispatched`, Charset: 'UTF-8' },
        Body: { Text: { Data: [`Your order #${notification.orderId} has been dispatched.`, `Carrier: ${notification.shippingCarrier}`,
          notification.trackingNumber ? `Tracking number: ${notification.trackingNumber}` : 'Tracking number: Not provided',
          `Dispatched at: ${notification.dispatchedAt.toISOString()}`].join('\n'), Charset: 'UTF-8' } } },
    }), { abortSignal: AbortSignal.timeout(10_000) });
    if (!result.MessageId) throw new Error('Legacy acceptance unknown');
  } finally { client.destroy(); }
};
let dispatchSender = legacyDispatchSender;
export const sendDispatchNotification = (notification: DispatchNotification) => dispatchSender(notification);
export function setDispatchNotificationSenderForTests(sender: DispatchSender) {
  const previous = dispatchSender; dispatchSender = sender; return () => { dispatchSender = previous; };
}
