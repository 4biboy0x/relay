import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import { z } from "zod";
import { config } from "./config";

const REQUEST_TIMEOUT_MS = 10_000;

export class EmailDeliveryError extends Error {
  constructor() {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryError";
  }
}

const encodeBase64 = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);

const createRawMessage = (sender: string, recipient: string, code: string): string => {
  const boundary = `relay-${randomUUID()}`;
  const messageText = `Your verification code is: ${code}. This code is valid for 10 minutes.`;
  const messageHtml = `<p>Your verification code is: <strong>${escapeHtml(code)}</strong>. This code is valid for 10 minutes.</p>`;
  const messageId = `<${randomUUID()}@${sender.split("@")[1]}>`;
  const message = [
    `From: Relay <${sender}>`,
    `To: ${recipient}`,
    "Subject: Your Relay Verification Code",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(messageText),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(messageHtml),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
};

export const sendOtpEmail = async (
  email: string,
  code: string,
  purpose: "signup" | "reset",
): Promise<void> => {
  if (!config.EMAIL_USER || !config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[otp-dev] ${purpose} code for ${email}: ${code}`);
      return;
    }
    console.error("Gmail API OTP delivery is not configured.");
    throw new EmailDeliveryError();
  }

  if (!z.string().email().safeParse(email).success) {
    console.error("Gmail API OTP delivery received an invalid recipient address.");
    throw new EmailDeliveryError();
  }

  const oauthClient = new google.auth.OAuth2(
    config.GMAIL_CLIENT_ID,
    config.GMAIL_CLIENT_SECRET,
  );
  oauthClient.setCredentials({ refresh_token: config.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: oauthClient });

  try {
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: createRawMessage(config.EMAIL_USER, email, code),
      },
    }, {
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch {
    console.error("Gmail API OTP delivery failed.");
    throw new EmailDeliveryError();
  }
};
