import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config/index.js";

export type DispatchNotification = {
  customerEmail: string;
  orderId: number;
  shippingCarrier: string;
  trackingNumber?: string | null;
  dispatchedAt: Date;
};

type EmailSender = (notification: DispatchNotification) => Promise<void>;
export type VerificationEmail = { recipientEmail: string; verificationUrl: string };
type VerificationEmailSender = (email: VerificationEmail) => Promise<void>;
export type PasswordResetEmail = { recipientEmail: string; resetUrl: string };
type PasswordResetEmailSender = (email: PasswordResetEmail) => Promise<void>;

const sesClient = new SESClient({ region: config.AWS_REGION });

const sesEmailSender: EmailSender = async (notification) => {
  const tracking = notification.trackingNumber
    ? `Tracking number: ${notification.trackingNumber}`
    : "Tracking number: Not provided";
  await sesClient.send(new SendEmailCommand({
    Source: config.SES_FROM_EMAIL,
    Destination: { ToAddresses: [notification.customerEmail] },
    Message: {
      Subject: { Data: `Your order #${notification.orderId} has been dispatched`, Charset: "UTF-8" },
      Body: {
        Text: {
          Data: [
            `Your order #${notification.orderId} has been dispatched.`,
            `Carrier: ${notification.shippingCarrier}`,
            tracking,
            `Dispatched at: ${notification.dispatchedAt.toISOString()}`,
          ].join("\n"),
          Charset: "UTF-8",
        },
      },
    },
  }));
};

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

let sender: EmailSender = sesEmailSender;
let verificationSender: VerificationEmailSender = sesVerificationEmailSender;
let passwordResetSender: PasswordResetEmailSender = sesPasswordResetEmailSender;

export function setDispatchNotificationSenderForTests(testSender: EmailSender): () => void {
  const previous = sender;
  sender = testSender;
  return () => {
    sender = previous;
  };
}

export function sendDispatchNotification(notification: DispatchNotification): Promise<void> {
  return sender(notification);
}

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
