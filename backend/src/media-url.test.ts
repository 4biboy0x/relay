import test from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { createSignedMediaUrl } from "./media-url";

test("signed media URLs are identical throughout the UTC-day signing window", async () => {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "https://storage.example.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
  });
  try {
    const first = await createSignedMediaUrl(client, "assets", "avatar.jpg");
    const second = await createSignedMediaUrl(client, "assets", "avatar.jpg");
    assert.equal(first, second);
    const signedAt = new URL(first).searchParams.get("X-Amz-Date");
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    assert.equal(signedAt, midnight.toISOString().replace(/[-:]|\.\d{3}/g, ""));
    assert.equal(new URL(first).searchParams.get("X-Amz-Expires"), String(48 * 60 * 60));
  } finally {
    client.destroy();
  }
});
