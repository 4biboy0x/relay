import { config } from "./config";

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

let cachedAccessToken: string | null = null;
let accessTokenExpiresAt = 0;
let accessTokenRequest: Promise<string> | null = null;

export class EmailDeliveryError extends Error {
  constructor() {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryError";
  }
}

const getGoogleAccessToken = async (): Promise<string> => {
  if (cachedAccessToken && accessTokenExpiresAt > Date.now() + 60_000) {
    return cachedAccessToken;
  }
  if (accessTokenRequest) return accessTokenRequest;

  accessTokenRequest = (async () => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.GMAIL_OAUTH_CLIENT_ID!,
        client_secret: config.GMAIL_OAUTH_CLIENT_SECRET!,
        refresh_token: config.GMAIL_OAUTH_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      console.error("Gmail OAuth token request failed.");
      throw new EmailDeliveryError();
    });

    if (!response.ok) {
      console.error("Gmail OAuth token request failed.", { status: response.status });
      throw new EmailDeliveryError();
    }

    const result = await response.json().catch(() => null) as GoogleTokenResponse | null;
    if (!result?.access_token || !result.expires_in) {
      console.error("Gmail OAuth token response was invalid.");
      throw new EmailDeliveryError();
    }

    cachedAccessToken = result.access_token;
    accessTokenExpiresAt = Date.now() + result.expires_in * 1000;
    return result.access_token;
  })().finally(() => {
    accessTokenRequest = null;
  });

  return accessTokenRequest;
};

export const sendOtpEmail = async (
  email: string,
  code: string,
  purpose: "signup" | "reset",
): Promise<void> => {
  const credentials = [
    config.GMAIL_OAUTH_CLIENT_ID,
    config.GMAIL_OAUTH_CLIENT_SECRET,
    config.GMAIL_OAUTH_REFRESH_TOKEN,
    config.GMAIL_FROM_EMAIL,
  ];
  if (credentials.some((value) => !value)) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[otp-dev] ${purpose} code for ${email}: ${code}`);
      return;
    }
    console.error("Gmail OTP delivery is not configured.");
    throw new EmailDeliveryError();
  }

  const subject = purpose === "signup" ? "Verify your Relay account" : "Reset your Relay password";
  const html = `<p>Your Relay verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p><p>If you did not request this, you can safely ignore it.</p>`;
  const encodedHtml = Buffer.from(html, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const mimeMessage = [
    `From: Relay <${config.GMAIL_FROM_EMAIL}>`,
    `To: ${email}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedHtml,
  ].join("\r\n");
  const raw = Buffer.from(mimeMessage, "utf8").toString("base64url");

  const accessToken = await getGoogleAccessToken();
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    console.error("Gmail OTP send request failed.");
    throw new EmailDeliveryError();
  });

  if (!response.ok) {
    console.error("Gmail OTP send request failed.", { status: response.status });
    throw new EmailDeliveryError();
  }
};
