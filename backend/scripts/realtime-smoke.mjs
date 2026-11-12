import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createRealtimeClient } from "@neon/realtime/client";

const require = createRequire(import.meta.url);
const { prisma } = require("../dist/db.js");
const { createAccessToken } = require("../dist/auth.js");
const apiBase = process.env.RELAY_API_BASE_URL || "http://127.0.0.1:3100/api";
const realtimeUrl = process.env.NEON_REALTIME_URL;
if (!realtimeUrl) throw new Error("NEON_REALTIME_URL is required");

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
let userId;
let subscription;
let client;

try {
  const registration = await fetch(`${apiBase}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle: `rt_smoke_${suffix}`,
      email: `realtime-smoke-${suffix}@example.test`,
      password: `RelayRealtime-${suffix}-Safe`,
      displayName: "Realtime smoke test",
    }),
  });
  if (!registration.ok) throw new Error(`Test account registration failed (${registration.status})`);
  const registered = await registration.json();
  userId = registered.user.id;

  const accessToken = createAccessToken(userId);
  const sealedResponse = await fetch(`${apiBase}/realtime-demo/live`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!sealedResponse.ok) throw new Error(`Sealing the live query failed (${sealedResponse.status})`);

  client = createRealtimeClient({ url: realtimeUrl });
  subscription = client.subscribe(await sealedResponse.json());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime did not reach live state")), 20000);
    const unsubscribe = subscription.onStateChange((state) => {
      if (state.status === "live") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      } else if (state.status === "error") {
        clearTimeout(timer);
        unsubscribe();
        reject(state.error);
      }
    });
    if (subscription.getState().status === "live") {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });

  const value = `Realtime committed row ${suffix}`;
  const insertResponse = await fetch(`${apiBase}/realtime-demo`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value }),
  });
  if (!insertResponse.ok) throw new Error(`Test row insert failed (${insertResponse.status})`);
  const committed = await insertResponse.json();
  await subscription.awaitTxId(committed.txid, 20000);

  const row = subscription.getSnapshot().data?.find((item) => item.value === value);
  if (!row) throw new Error("The live subscriber did not receive the inserted row");
  console.log(`Realtime subscriber received committed row: ${row.value}`);
} finally {
  subscription?.unsubscribe();
  client?.close();
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
  setTimeout(() => process.exit(process.exitCode ?? 0), 250);
}
