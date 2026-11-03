import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/relay";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough";
process.env.POST_VIEW_HMAC_SECRET = "test-post-view-hmac-secret-that-is-long-enough";
process.env.GMAIL_OAUTH_CLIENT_ID = "test-client-id";
process.env.GMAIL_OAUTH_CLIENT_SECRET = "test-client-secret";
process.env.GMAIL_OAUTH_REFRESH_TOKEN = "test-refresh-token";
process.env.GMAIL_FROM_EMAIL = "relay.sender@gmail.com";
process.env.NODE_ENV = "test";

const { sendOtpEmail } = require("./email") as typeof import("./email");
const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

test("sends OTP email through Gmail API using an OAuth access token", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "test-message" }), { status: 200 });
  };

  await sendOtpEmail("recipient@example.com", "123456", "signup");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(requests[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(new Headers(requests[1].init?.headers).get("Authorization"), "Bearer test-access-token");

  const payload = JSON.parse(String(requests[1].init?.body)) as { raw: string };
  const mimeMessage = Buffer.from(payload.raw, "base64url").toString("utf8");
  const encodedBody = mimeMessage.split("\r\n\r\n")[1]?.replace(/\r\n/g, "") ?? "";
  const htmlBody = Buffer.from(encodedBody, "base64").toString("utf8");
  assert.match(mimeMessage, /To: recipient@example\.com/);
  assert.match(mimeMessage, /Subject: Verify your Relay account/);
  assert.match(htmlBody, /123456/);
});
