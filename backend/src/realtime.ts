import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { z } from "zod";
import { clientOrigins, config } from "./config";
import { prisma } from "./db";

let io: Server | undefined;

export const initializeRealtime = (server: HttpServer): Server => {
  io = new Server(server, {
    cors: {
      origin: clientOrigins,
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    },
    maxHttpBufferSize: 16_384,
  });

  io.use(async (socket, next) => {
    try {
      const token = z.string().min(1).parse(socket.handshake.auth.token);
      const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
        issuer: "relay-api",
        audience: "relay-client",
      });
      if (typeof payload === "string" || !payload.sub) throw new Error("Invalid token");
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, handle: true, displayName: true },
      });
      if (!user) throw new Error("User no longer exists");
      socket.data.userId = payload.sub;
      socket.data.user = user;
      socket.data.tokenExpiresAt = payload.exp ? payload.exp * 1000 : Date.now();
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const user = socket.data.user as { id: string; handle: string; displayName: string };
    const expiresIn = Math.max(0, (socket.data.tokenExpiresAt as number) - Date.now());
    const expiryTimer = setTimeout(() => socket.disconnect(true), expiresIn);
    socket.on("disconnect", () => clearTimeout(expiryTimer));
    socket.join(`user:${userId}`);

    socket.on("post:join", async (postId: unknown) => {
      const parsed = z.string().cuid().safeParse(postId);
      if (!parsed.success) return;
      const exists = await prisma.post.findFirst({
        where: { id: parsed.data, deletedAt: null },
        select: { id: true },
      }).catch((error: unknown) => {
        console.error("Could not verify post room", error);
        return null;
      });
      if (exists) await socket.join(`post:${parsed.data}`);
    });

    socket.on("posts:join", async (postIds: unknown) => {
      const parsed = z.array(z.string().cuid()).max(100).safeParse(postIds);
      if (!parsed.success || parsed.data.length === 0) return;
      const ids = [...new Set(parsed.data)];
      const posts = await prisma.post.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true },
      }).catch((error: unknown) => {
        console.error("Could not verify post rooms", error);
        return [];
      });
      await Promise.all(posts.map(({ id }) => socket.join(`post:${id}`)));
    });

    socket.on("conversation:join", async (conversationId: unknown, ack?: unknown) => {
      const acknowledge = typeof ack === "function" ? ack as (result: { ok: boolean }) => void : () => {};
      const parsed = z.string().cuid().safeParse(conversationId);
      if (!parsed.success) {
        acknowledge({ ok: false });
        return;
      }
      const member = await prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId: parsed.data, userId } },
        select: { conversationId: true },
      }).catch((error: unknown) => {
        console.error("Could not verify conversation membership", error);
        return null;
      });
      if (!member) {
        acknowledge({ ok: false });
        return;
      }
      await socket.join(`conversation:${parsed.data}`);
      acknowledge({ ok: true });
    });

    const typing = (active: boolean) => async (value: unknown) => {
      const parsed = z.object({ conversationId: z.string().cuid() }).safeParse(value);
      if (!parsed.success || !socket.rooms.has(`conversation:${parsed.data.conversationId}`)) return;
      socket.to(`conversation:${parsed.data.conversationId}`).emit("typing:update", {
        conversationId: parsed.data.conversationId,
        userId,
        handle: user.handle,
        displayName: user.displayName,
        active,
      });
    };
    socket.on("typing:start", typing(true));
    socket.on("typing:stop", typing(false));
  });

  return io;
};

export const emitToUser = (userId: string, event: string, payload: unknown): void => {
  io?.to(`user:${userId}`).emit(event, payload);
};

export const emitToConversation = (conversationId: string, event: string, payload: unknown): void => {
  io?.to(`conversation:${conversationId}`).emit(event, payload);
};

export const emitToPost = (postId: string, event: string, payload: unknown): void => {
  io?.to(`post:${postId}`).emit(event, payload);
};

export const emitToAuthenticated = (event: string, payload: unknown): void => {
  io?.emit(event, payload);
};
