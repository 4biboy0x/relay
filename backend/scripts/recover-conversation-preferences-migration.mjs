import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const migrationName = "20261112140000_conversation_preferences";
const prisma = new PrismaClient();

try {
  // Fresh databases do not have the Prisma migration table yet.
  const [table] = await prisma.$queryRaw`
    SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS table_exists
  `;

  if (!table?.table_exists) {
    console.info("Prisma migration table does not exist yet; recovery is not needed.");
    process.exitCode = 0;
  } else {
    const failed = await prisma.$queryRaw`
      SELECT migration_name
      FROM public."_prisma_migrations"
      WHERE migration_name = ${migrationName}
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `;

    if (failed.length === 0) {
      console.info("No failed conversation preferences migration found.");
    } else {
      console.warn(`Recovering failed migration: ${migrationName}`);
      await prisma.$disconnect();
      execFileSync("npx", ["prisma", "migrate", "resolve", "--rolled-back", migrationName], {
        stdio: "inherit",
      });
      console.info("Failed migration marked rolled back; Prisma can safely retry it.");
    }
  }
} catch (error) {
  console.error("Could not recover the failed conversation preferences migration:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
