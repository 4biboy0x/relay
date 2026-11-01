type ReelShareTransaction = {
  reelShare: {
    createMany(args: {
      data: { userId: string; reelId: string };
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
  reel: {
    update(args: {
      where: { id: string };
      data: { shareCount: { increment: 1 } };
    }): Promise<unknown>;
  };
};

export const recordUniqueReelShare = async (
  tx: ReelShareTransaction,
  userId: string,
  reelId: string,
): Promise<void> => {
  const created = await tx.reelShare.createMany({
    data: { userId, reelId },
    skipDuplicates: true,
  });
  if (created.count > 0) {
    await tx.reel.update({
      where: { id: reelId },
      data: { shareCount: { increment: 1 } },
    });
  }
};
