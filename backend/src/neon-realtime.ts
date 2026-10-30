import { config } from "./config";

export const getNeonRealtime = async () => {
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error("NEON_REALTIME_SECRET is required for live queries");

  const database = decodeURIComponent(new URL(config.DATABASE_URL).pathname.slice(1));
  if (!database) throw new Error("DATABASE_URL must include a database name");
  const { createRealtime } = await import("@neon/realtime/server");
  return createRealtime({ secret, db: database });
};
