import test from "node:test";
import assert from "node:assert/strict";
import { recordUniqueReelShare } from "./reel-shares";

const createTransaction = () => {
  const shares = new Set<string>();
  const reelCounts = new Map<string, number>();
  const tx = {
    reelShare: {
      async createMany({ data }: { data: { userId: string; reelId: string } }) {
        const key = `${data.userId}:${data.reelId}`;
        if (shares.has(key)) return { count: 0 };
        shares.add(key);
        return { count: 1 };
      },
    },
    reel: {
      async update({ where, data }: { where: { id: string }; data: { shareCount: { increment: 1 } } }) {
        reelCounts.set(where.id, (reelCounts.get(where.id) || 0) + data.shareCount.increment);
      },
    },
  };
  return { tx, reelCounts };
};

test("increments a reel share count once for repeated shares by the same user", async () => {
  const { tx, reelCounts } = createTransaction();
  await Promise.all(Array.from({ length: 10 }, () => recordUniqueReelShare(
    tx,
    "user-1",
    "00000000-0000-4000-8000-000000000001",
  )));
  assert.equal(reelCounts.get("00000000-0000-4000-8000-000000000001"), 1);
});

test("counts shares once per user and reel", async () => {
  const { tx, reelCounts } = createTransaction();
  const firstReel = "00000000-0000-4000-8000-000000000001";
  const secondReel = "00000000-0000-4000-8000-000000000002";
  await recordUniqueReelShare(tx, "user-1", firstReel);
  await recordUniqueReelShare(tx, "user-2", firstReel);
  await recordUniqueReelShare(tx, "user-1", secondReel);
  assert.equal(reelCounts.get(firstReel), 2);
  assert.equal(reelCounts.get(secondReel), 1);
});
