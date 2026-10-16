import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config/index.js";

export type VerificationEmail = { recipientEmail: string; verificationUrl: string };
type VerificationEmailSender = (email: VerificationEmail) => Promise<void>;
export type PasswordResetEmail = { recipientEmail: string; resetUrl: string };
type PasswordResetEmailSender = (email: PasswordResetEmail) => Promise<void>;

const sesClient = new SESClient({ region: config.AWS_REGION });

const sesVerificationEmailSender: VerificationEmailSender = async (email) => {
  await sesClient.send(new SendEmailCommand({
    Source: config.SES_FROM_EMAIL,
    Destination: { ToAddresses: [email.recipientEmail] },
    Message: {
      Subject: { Data: "Verify your Colorful Life account", Charset: "UTF-8" },
      Body: { Text: { Data: [
        "Please verify your Colorful Life account using the link below:",
        email.verificationUrl,
        "This link expires in 24 hours.",
      ].join("\n"), Charset: "UTF-8" } },
    },
  }));
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
  await sesClient.send(buildPasswordResetEmailCommand(email), { abortSignal: AbortSignal.timeout(1500) });
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
  if (process.env.NODE_ENV === 'test') throw new Error('Real legacy SES disabled in tests');
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
