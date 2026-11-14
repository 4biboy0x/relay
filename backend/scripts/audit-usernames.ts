import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const acceptedHandlePattern = /^(?=.*[a-z])[a-z0-9_]{3,30}$/;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn("Username audit skipped: DATABASE_URL is not available during this deploy.");
    return;
  }

  // Read-only audit: this script never creates or updates user records.
  const users = await prisma.user.findMany({
    select: { id: true, handle: true },
    orderBy: { handle: "asc" },
  });

  const reservedHandles = new Set(users.map((user) => user.handle.toLowerCase()));
  const findings: Array<{ currentHandle: string; suggestedHandle: string }> = [];

  for (const user of users) {
    const currentHandle = user.handle.toLowerCase();
    if (acceptedHandlePattern.test(currentHandle)) continue;

    const idSuffix = user.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8) || "account";
    const base = `member_${idSuffix}`;
    let suggestedHandle = base;
    let suffix = 2;

    while (reservedHandles.has(suggestedHandle)) {
      const extra = `_${suffix++}`;
      suggestedHandle = `${base.slice(0, 30 - extra.length)}${extra}`;
    }

    reservedHandles.add(suggestedHandle);
    findings.push({
      currentHandle: user.handle,
      suggestedHandle,
    });
  }

  console.log(`Username audit complete. Total users: ${users.length}. Invalid usernames: ${findings.length}.`);

  if (findings.length === 0) {
    console.log("All existing usernames satisfy the current validation rule.");
    return;
  }

  console.table(findings.map(({ currentHandle, suggestedHandle }) => ({
    currentHandle,
    suggestedHandle,
  })));

  console.log("\nNo database records were modified.");
}

main()
  .catch((error) => {
    // This is an informational deploy audit; never block a healthy application deploy.
    console.error("Username audit could not complete. Deployment will continue.");
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
