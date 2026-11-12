import assert from "node:assert/strict";
import { after, test } from "node:test";
import { google } from "googleapis";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/relay";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough";
process.env.POST_VIEW_HMAC_SECRET = "test-post-view-hmac-secret-that-is-long-enough";
process.env.EMAIL_USER = "relay.sender@gmail.com";
process.env.GMAIL_CLIENT_ID = "test-client-id";
process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
process.env.NODE_ENV = "test";

const originalGmail = google.gmail;
const { EmailDeliveryError, sendOtpEmail } = require("./email") as typeof import("./email");

const decodeMimeBodies = (message: string): string[] => [...message.matchAll(
  /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?=\r\n--relay-[^\r\n]+)/g,
)].map((match) => Buffer.from(match[1].replace(/\r\n/g, ""), "base64").toString("utf8"));

after(() => {
  google.gmail = originalGmail;
});

test("sends a multipart OTP email through the official Gmail API client", async () => {
  const requests: Array<{ userId?: string; requestBody?: { raw?: string } }> = [];
  let oauthRefreshToken: string | undefined;
  google.gmail = ((options: { auth?: unknown }) => {
    oauthRefreshToken = (options.auth as InstanceType<typeof google.auth.OAuth2>)
      .credentials.refresh_token ?? undefined;
    return {
      users: {
        messages: {
          send: async (request: { userId?: string; requestBody?: { raw?: string } }) => {
            requests.push(request);
            return { data: { id: "gmail-message-id" } };
          },
        },
      },
    } as unknown as ReturnType<typeof google.gmail>;
  }) as unknown as typeof google.gmail;

  await sendOtpEmail("recipient@example.com", "123456", "signup");
  await sendOtpEmail("recipient@example.com", "654321", "reset");

  assert.equal(oauthRefreshToken, "test-refresh-token");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.userId, "me");
    const raw = request.requestBody?.raw;
    assert.ok(raw);
    const message = Buffer.from(raw, "base64url").toString("utf8");
    const bodies = decodeMimeBodies(message);
    assert.match(message, /From: Relay <relay\.sender@gmail\.com>/);
    assert.match(message, /To: recipient@example\.com/);
    assert.match(message, /Subject: Your Relay Verification Code/);
    assert.match(message, /Date: .+/);
    assert.match(message, /Message-ID: <.+@gmail\.com>/);
    assert.match(message, /Content-Type: multipart\/alternative; boundary="relay-/);
    assert.match(bodies[0], /^Your verification code is: \d{6}\. This code is valid for 10 minutes\.$/);
    assert.match(bodies[1], /^<p>Your verification code is: <strong>\d{6}<\/strong>\. This code is valid for 10 minutes\.<\/p>$/);
  }
  assert.match(decodeMimeBodies(Buffer.from(requests[0].requestBody!.raw!, "base64url").toString("utf8"))[0], /123456/);
  assert.match(decodeMimeBodies(Buffer.from(requests[1].requestBody!.raw!, "base64url").toString("utf8"))[0], /654321/);
});

test("rejects Gmail API delivery failures with the standard email error", async () => {
  google.gmail = (() => ({
    users: {
      messages: {
        send: async () => {
          throw new Error("upstream failure");
        },
      },
    },
  }) as unknown as ReturnType<typeof google.gmail>) as typeof google.gmail;

  await assert.rejects(
    sendOtpEmail("recipient@example.com", "123456", "signup"),
    EmailDeliveryError,
  );
});
