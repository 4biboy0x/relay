import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStoredUploadPath } from "./storage-path";

const endpoint = "https://br-plain-dream-b90c0dnn.storage.c-7.eu-central-1.aws.neon.tech";

test("keeps canonical local upload paths", () => {
  assert.equal(
    resolveStoredUploadPath("/uploads/3c02e7a2-a919-4351-ba8a-9e30d0f40fac.png", endpoint, "assets"),
    "/uploads/3c02e7a2-a919-4351-ba8a-9e30d0f40fac.png",
  );
});

test("resolves legacy full Neon presigned URLs to their storage key", () => {
  const legacyUrl = `${endpoint}/assets/3c02e7a2-a919-4351-ba8a-9e30d0f40fac.png?X-Amz-Date=20261102T000000Z&X-Amz-Expires=172800&X-Amz-Signature=expired`;
  assert.equal(
    resolveStoredUploadPath(legacyUrl, endpoint, "assets"),
    "/uploads/3c02e7a2-a919-4351-ba8a-9e30d0f40fac.png",
  );
});

test("does not rewrite URLs from other origins or buckets", () => {
  assert.equal(
    resolveStoredUploadPath("https://media1.giphy.com/image.gif", endpoint, "assets"),
    null,
  );
  assert.equal(
    resolveStoredUploadPath(`${endpoint}/other-bucket/photo.png`, endpoint, "assets"),
    null,
  );
  assert.equal(
    resolveStoredUploadPath("https://attacker.example/assets/photo.png", endpoint, "assets"),
    null,
  );
});

test("rejects malformed object paths", () => {
  assert.equal(resolveStoredUploadPath(`${endpoint}/assets/folder/photo.png`, endpoint, "assets"), null);
  assert.equal(resolveStoredUploadPath(`${endpoint}/assets/../secret.png`, endpoint, "assets"), null);
});
