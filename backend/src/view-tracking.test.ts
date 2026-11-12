import test from "node:test";
import assert from "node:assert/strict";
import { createViewerKey } from "./view-tracking";

const request = (
  userId: string | undefined,
  ip: string,
  userAgent: string,
): Parameters<typeof createViewerKey>[0] => ({
  userId,
  ip,
  headers: { "user-agent": userAgent },
});

test("authenticated viewer keys remain stable across sessions and dates", () => {
  const first = createViewerKey(request("user_123", "192.0.2.1", "Browser A"), new Date("2026-11-01T10:00:00Z"));
  const second = createViewerKey(request("user_123", "198.51.100.2", "Browser B"), new Date("2026-11-02T10:00:00Z"));
  assert.equal(first, "u:user_123");
  assert.equal(second, first);
});

test("anonymous viewer keys are stable per IP, user agent, and UTC day", () => {
  const first = createViewerKey(request(undefined, "192.0.2.1", "Browser A"), new Date("2026-11-01T10:00:00Z"));
  assert.equal(
    createViewerKey(request(undefined, "192.0.2.1", "Browser A"), new Date("2026-11-01T23:59:59Z")),
    first,
  );
  assert.notEqual(
    createViewerKey(request(undefined, "192.0.2.1", "Browser A"), new Date("2026-11-02T00:00:00Z")),
    first,
  );
  assert.notEqual(createViewerKey(request(undefined, "192.0.2.2", "Browser A")), first);
  assert.notEqual(createViewerKey(request(undefined, "192.0.2.1", "Browser B")), first);
  assert.match(first, /^a:[0-9a-f]{64}$/);
});
