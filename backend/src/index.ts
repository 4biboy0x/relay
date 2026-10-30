import { createServer } from "node:http";
import { app } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { initializeRealtime } from "./realtime";

const server = createServer(app);
const io = initializeRealtime(server);
server.listen(config.PORT, () => {
  console.log(`Relay API listening on port ${config.PORT}`);
});

const shutdown = async () => {
  io.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
