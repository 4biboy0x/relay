import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/relay";
process.env.JWT_ACCESS_SECRET = "test-jwt-access-secret-that-is-long-enough-32-chars";
process.env.POST_VIEW_HMAC_SECRET = "test-post-view-hmac-secret-that-is-long-enough";
process.env.EMAIL_USER = "relay.sender@gmail.com";
process.env.GMAIL_CLIENT_ID = "test-client-id";
process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "test-refresh-token";
process.env.NODE_ENV = "test";

const { forgotPasswordSchema, resetPasswordSchema, otpVerifySchema } = require("./validation");
const { createPasswordResetToken, verifyPasswordResetToken, hashPassword, verifyPassword } = require("./auth");

test("forgotPasswordSchema validates identifiers and emails correctly", () => {
  assert.equal(forgotPasswordSchema.safeParse({ identifier: "alice" }).success, true);
  assert.equal(forgotPasswordSchema.safeParse({ identifier: "@alice_123" }).success, true);
  assert.equal(forgotPasswordSchema.safeParse({ email: "user@example.com" }).success, true);
  assert.equal(forgotPasswordSchema.safeParse({ identifier: "   " }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({}).success, false);
});

test("resetPasswordSchema validates password matching and length", () => {
  // Valid token and matching 12+ char password
  const valid = resetPasswordSchema.safeParse({
    resetToken: "fake-jwt-token",
    password: "Password12345!",
    confirmPassword: "Password12345!",
  });
  assert.equal(valid.success, true);

  // Mismatched passwords
  const mismatch = resetPasswordSchema.safeParse({
    resetToken: "fake-jwt-token",
    password: "Password12345!",
    confirmPassword: "Password123456!",
  });
  assert.equal(mismatch.success, false);

  // Short password (< 12 chars)
  const shortPass = resetPasswordSchema.safeParse({
    resetToken: "fake-jwt-token",
    password: "Short1!",
    confirmPassword: "Short1!",
  });
  assert.equal(shortPass.success, false);

  // Missing reset token
  const noToken = resetPasswordSchema.safeParse({
    resetToken: "",
    password: "Password12345!",
    confirmPassword: "Password12345!",
  });
  assert.equal(noToken.success, false);
});

test("createPasswordResetToken and verifyPasswordResetToken flow", () => {
  const userId = "user-123";
  const email = "user@example.com";
  const authCodeId = "auth-code-999";

  const token = createPasswordResetToken(userId, email, authCodeId);
  assert.ok(token);

  const payload = verifyPasswordResetToken(token);
  assert.equal(payload.sub, userId);
  assert.equal(payload.email, email);
  assert.equal(payload.codeId, authCodeId);
  assert.equal(payload.purpose, "password-reset");

  // Invalid token throws
  assert.throws(() => verifyPasswordResetToken("invalid-garbage-token"));
});

test("password hashing and verification behaves consistently with sign-up", async () => {
  const password = "ValidPassword123!";
  const hash = await hashPassword(password);
  assert.ok(hash);
  assert.notEqual(hash, password);

  const isMatch = await verifyPassword(password, hash);
  assert.equal(isMatch, true);

  const isNotMatch = await verifyPassword("WrongPassword123!", hash);
  assert.equal(isNotMatch, false);
});
