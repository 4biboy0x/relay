import test from "node:test";
import assert from "node:assert/strict";
import { messageSchema } from "./validation";

test("message schema accepts text with up to four image attachments", () => {
  const attachments = [
    "/uploads/one.jpg",
    "/uploads/two.png",
    "/uploads/three.webp",
    "https://media.giphy.com/media/example/giphy.gif",
  ];
  const result = messageSchema.safeParse({
    body: "Caption",
    attachments,
    mediaDimensions: attachments.map(() => ({ width: 640, height: 480 })),
  });
  assert.equal(result.success, true);
});

test("message schema rejects more than four attachments", () => {
  const result = messageSchema.safeParse({
    attachments: Array.from({ length: 5 }, (_, index) => `/uploads/${index}.jpg`),
  });
  assert.equal(result.success, false);
});

test("message schema rejects non-image attachments and empty messages", () => {
  assert.equal(messageSchema.safeParse({ attachments: ["/uploads/clip.mp4"] }).success, false);
  assert.equal(messageSchema.safeParse({ attachments: [] }).success, false);
  assert.equal(messageSchema.safeParse({}).success, false);
});

test("message schema keeps legacy single mediaUrl payloads valid", () => {
  assert.equal(messageSchema.safeParse({ mediaUrl: "/uploads/legacy.gif" }).success, true);
});

test("message schema requires stored dimensions to match attachments", () => {
  assert.equal(messageSchema.safeParse({
    attachments: ["/uploads/one.jpg", "/uploads/two.gif"],
    mediaDimensions: [{ width: 640, height: 480 }],
  }).success, false);
  assert.equal(messageSchema.safeParse({
    mediaUrl: "/uploads/legacy.gif",
    mediaDimensions: [{ width: 640, height: 480 }],
  }).success, true);
});
