import { randomUUID } from "node:crypto";
import { config } from "./config";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const REQUEST_TIMEOUT_MS = 10_000;

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

export class EmailDeliveryError extends Error {
  constructor() {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryError";
  }
}

const otpEmailContent = (
  code: string,
  purpose: "signup" | "reset",
): { subject: string; html: string; text: string } => {
  const isSignup = purpose === "signup";
  const subject = isSignup ? "Verify your Relay account" : "Reset your Relay password";
  const title = isSignup ? "Verify your email" : "Reset your password";
  const instruction = isSignup
    ? "Use this code to verify your email."
    : "Use this code to reset your password.";
  const fontUrl = `${config.CLIENT_ORIGIN}/assets/fonts/Piazzolla-Light.woff2`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      @font-face {
        font-family: "Piazzolla";
        src: url("${fontUrl}") format("woff2");
        font-style: normal;
        font-weight: 300;
      }
    </style>
  </head>
  <body style="margin:0;padding:32px 16px;background:#f4f4f5;color:#09090b;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;">
      <tr>
        <td style="padding:28px 32px 30px;">
          <div style="font-family:'Piazzolla',Georgia,serif;font-size:30px;font-weight:300;letter-spacing:-1.3px;line-height:1;color:#09090b;">Relay</div>
          <div style="height:1px;margin:22px 0;background:#e4e4e7;"></div>
          <h1 style="margin:0 0 10px;font-size:20px;font-weight:600;line-height:1.3;color:#09090b;">${title}</h1>
          <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#52525b;">${instruction}</p>
          <div style="display:inline-block;padding:12px 16px;border:1px solid #e4e4e7;border-radius:8px;background:#fafafa;font-size:28px;font-weight:600;letter-spacing:7px;line-height:1.2;color:#09090b;">${code}</div>
          <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Expires in 10 minutes.</p>
          <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Didn't request this? Ignore this email.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  const text = `${title}\n\n${instruction}\n\n${code}\n\nExpires in 10 minutes.\nDidn't request this? Ignore this email.`;
  return { subject, html, text };
};

const getAccessToken = async (): Promise<string> => {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }

  if (!config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
    console.error("Gmail API OAuth credentials are not configured.");
    throw new EmailDeliveryError();
  }

  const body = new URLSearchParams({
    client_id: config.GMAIL_CLIENT_ID,
    client_secret: config.GMAIL_CLIENT_SECRET,
    refresh_token: config.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.error("Gmail API OAuth token request failed.");
    throw new EmailDeliveryError();
  }

  if (!response.ok) {
    console.error(`Gmail API OAuth token request failed with status ${response.status}.`);
    throw new EmailDeliveryError();
  }

  let tokenData: { access_token?: unknown; expires_in?: unknown };
  try {
    tokenData = await response.json() as { access_token?: unknown; expires_in?: unknown };
  } catch {
    console.error("Gmail API returned an invalid OAuth token response.");
    throw new EmailDeliveryError();
  }
  if (typeof tokenData.access_token !== "string" || typeof tokenData.expires_in !== "number") {
    console.error("Gmail API returned an invalid OAuth token response.");
    throw new EmailDeliveryError();
  }

  cachedAccessToken = {
    value: tokenData.access_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };
  return cachedAccessToken.value;
};

const encodeBase64 = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();

const createRawMessage = (
  sender: string,
  email: string,
  content: { subject: string; html: string; text: string },
): string => {
  const boundary = `relay-${randomUUID()}`;
  const message = [
    `From: Relay <${sender}>`,
    `To: ${email}`,
    `Subject: ${content.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(content.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(content.html),
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

  const content = otpEmailContent(code, purpose);
  const message = createRawMessage(config.EMAIL_USER, email, content);
  const accessToken = await getAccessToken();
  let response: Response;
  try {
    response = await fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    console.error("Gmail API OTP delivery request failed.");
    throw new EmailDeliveryError();
  }

  if (!response.ok) {
    console.error(`Gmail API OTP delivery failed with status ${response.status}.`);
    throw new EmailDeliveryError();
  }
};
