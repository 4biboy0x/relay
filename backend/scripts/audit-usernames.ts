import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const acceptedHandlePattern = /^(?=.*[a-z])[a-z0-9_]{3,30}$/;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing. Add it to backend/.env before running this local audit.");
  }

  // Read-only audit: this script never creates or updates user records.
  const users = await prisma.user.findMany({
    select: { id: true, handle: true },
    orderBy: { handle: "asc" },
  });

  const reservedHandles = new Set(users.map((user) => user.handle.toLowerCase()));
  const findings: Array<{ userId: string; currentHandle: string; suggestedHandle: string }> = [];

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
      userId: user.id,
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

  // IDs are included in the local JSON report for a possible, separately approved migration.
  console.log("\nDRY_RUN_REPORT_JSON");
  console.log(JSON.stringify(findings, null, 2));
  console.log("\nNo database records were modified.");
}

main()
  .catch((error) => {
    console.error("Username audit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
