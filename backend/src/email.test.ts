import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/relay";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough";
process.env.POST_VIEW_HMAC_SECRET = "test-post-view-hmac-secret-that-is-long-enough";
process.env.EMAIL_USER = "relay.sender@gmail.com";
process.env.GMAIL_CLIENT_ID = "test-client-id";
process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
process.env.NODE_ENV = "test";

const originalFetch = globalThis.fetch;
const { EmailDeliveryError, sendOtpEmail } = require("./email") as typeof import("./email");

const decodeMimeBodies = (message: string): string[] => [...message.matchAll(
  /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?=\r\n--relay-[^\r\n]+)/g,
)].map((match) => Buffer.from(match[1].replace(/\r\n/g, ""), "base64").toString("utf8"));

after(() => {
  globalThis.fetch = originalFetch;
});

test("sends OTP emails through Gmail API using OAuth refresh tokens", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });

    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "test-access-token", expires_in: 3600 });
    }

    return Response.json({ id: "gmail-message-id" });
  }) as typeof fetch;

  await sendOtpEmail("recipient@example.com", "123456", "signup");
  await sendOtpEmail("recipient@example.com", "654321", "reset");

  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(requests[0].init?.method, "POST");
  const tokenBody = new URLSearchParams(String(requests[0].init?.body));
  assert.equal(tokenBody.get("client_id"), "test-client-id");
  assert.equal(tokenBody.get("client_secret"), "test-client-secret");
  assert.equal(tokenBody.get("refresh_token"), "test-refresh-token");
  assert.equal(tokenBody.get("grant_type"), "refresh_token");

  const sendRequests = requests.slice(1);
  for (const request of sendRequests) {
    assert.equal(request.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assert.equal(request.init?.method, "POST");
    assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer test-access-token");
    const payload = JSON.parse(String(request.init?.body)) as { raw: string };
    const message = Buffer.from(payload.raw, "base64url").toString("utf8");
    const bodies = decodeMimeBodies(message);
    assert.match(message, /From: Relay <relay\.sender@gmail\.com>/);
    assert.match(message, /To: recipient@example\.com/);
    assert.match(bodies[0], /Expires in 10 minutes/);
    assert.match(bodies[1], /font-family: ?"Piazzolla"/);
    assert.match(bodies[1], /assets\/fonts\/Piazzolla-Light\.woff2/);
    assert.match(bodies[1], /background:#f4f4f5/);
  }

  const signupMessage = Buffer.from(
    (JSON.parse(String(sendRequests[0].init?.body)) as { raw: string }).raw,
    "base64url",
  ).toString("utf8");
  assert.match(signupMessage, /Subject: Verify your Relay account/);
  assert.match(decodeMimeBodies(signupMessage)[0], /123456/);

  const resetMessage = Buffer.from(
    (JSON.parse(String(sendRequests[1].init?.body)) as { raw: string }).raw,
    "base64url",
  ).toString("utf8");
  assert.match(resetMessage, /Subject: Reset your Relay password/);
  assert.match(decodeMimeBodies(resetMessage)[0], /654321/);
});

test("reports Gmail API delivery failures with the standard email error", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;

  await assert.rejects(
    sendOtpEmail("recipient@example.com", "123456", "signup"),
    EmailDeliveryError,
  );
});
