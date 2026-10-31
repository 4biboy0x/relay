import { createServer } from "node:http";
import { app } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { initializeRealtime } from "./realtime";
import { checkReelMediaTools } from "./reel-processing";
import { runReelWorker, stopReelWorker } from "./reel-worker";

const server = createServer(app);
const io = initializeRealtime(server);
server.listen(config.PORT, () => {
  console.log(`Relay API listening on port ${config.PORT}`);
});

let shuttingDown = false;
void checkReelMediaTools().then(() => {
  if (process.env.NODE_ENV === "production" || shuttingDown) return;
  console.info("Reel worker loop running in the API process (development mode)");
  return runReelWorker({ checkMediaTools: false });
}).catch((error: unknown) => {
  console.error("Reel worker stopped unexpectedly:", error);
});

const shutdown = async () => {
  shuttingDown = true;
  io.close(() => {
    void (async () => {
      await stopReelWorker();
      await prisma.$disconnect();
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("Could not shut down the Reel worker cleanly:", error);
      process.exitCode = 1;
    });
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
