import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Transporter } from "nodemailer";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/relay";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough";
process.env.POST_VIEW_HMAC_SECRET = "test-post-view-hmac-secret-that-is-long-enough";
process.env.EMAIL_USER = "relay.sender@gmail.com";
process.env.EMAIL_PASS = "test-app-password";
process.env.NODE_ENV = "test";

const nodemailer = require("nodemailer") as typeof import("nodemailer");
const originalCreateTransport = nodemailer.createTransport;
const { sendOtpEmail } = require("./email") as typeof import("./email");

after(() => {
  nodemailer.createTransport = originalCreateTransport;
});

test("sends OTP emails through Gmail SMTP without exposing credentials", async () => {
  const sentMessages: Array<Record<string, unknown>> = [];
  let smtpOptions: Record<string, unknown> | undefined;
  nodemailer.createTransport = ((options: Record<string, unknown>) => {
    smtpOptions = options;
    return {
      sendMail: async (message: Record<string, unknown>) => {
        sentMessages.push(message);
      },
    } as unknown as Transporter;
  }) as typeof nodemailer.createTransport;

  await sendOtpEmail("recipient@example.com", "123456", "signup");

  assert.equal(smtpOptions?.host, "smtp.gmail.com");
  assert.equal(smtpOptions?.port, 465);
  assert.equal(smtpOptions?.secure, true);
  assert.deepEqual(smtpOptions?.auth, {
    user: "relay.sender@gmail.com",
    pass: "test-app-password",
  });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, "recipient@example.com");
  assert.equal(sentMessages[0].subject, "Verify your Relay account");
  assert.match(String(sentMessages[0].html), /123456/);
});
