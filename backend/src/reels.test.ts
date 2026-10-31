import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { detectReelContainer } from "./reel-processing";
import { createLocalReelReadUrl, verifyLocalReelReadUrl } from "./reel-storage";

const reelId = "00000000-0000-4000-8000-000000000001";

test("detects MP4 and MOV containers from their file signature", () => {
  const prefix = Buffer.from("0000ftypisom", "ascii");
  assert.equal(detectReelContainer(prefix), "video/mp4");
});

test("detects WebM from EBML magic bytes", () => {
  assert.equal(
    detectReelContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93])),
    "video/webm",
  );
});

test("rejects content with a spoofed video extension but no video signature", () => {
  assert.equal(detectReelContainer(Buffer.from("<html>not a video</html>")), null);
});

test("local media links are signed and expire", () => {
  const url = new URL(createLocalReelReadUrl(reelId, "video"), "https://relay.test");
  const expires = url.searchParams.get("expires") ?? undefined;
  const signature = url.searchParams.get("signature") ?? undefined;
  assert.equal(verifyLocalReelReadUrl(reelId, "video", expires, signature), true);
  assert.equal(verifyLocalReelReadUrl(reelId, "poster", expires, signature), false);
  assert.equal(verifyLocalReelReadUrl(reelId, "video", "1", signature), false);
});
