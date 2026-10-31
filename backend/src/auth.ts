import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./db";
import { config } from "./config";
import { HttpError } from "./http";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const REFRESH_DAYS = 30;

export const createAccessToken = (userId: string): string =>
  jwt.sign({}, config.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: "15m",
    issuer: "relay-api",
    audience: "relay-client",
  });

export const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const issueRefreshToken = async (userId: string): Promise<string> => {
  const token = randomBytes(48).toString("base64url");
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return token;
};

export const authRequired: RequestHandler = (req, _res, next) => {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(new HttpError(401, "Authentication required"));
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_ACCESS_SECRET, {
      issuer: "relay-api",
      audience: "relay-client",
    });
    if (typeof payload === "string" || !payload.sub) {
      throw new Error("Invalid access token subject");
    }
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired access token"));
  }
};

export const authOptional: RequestHandler = (req, _res, next) => {
  const header = req.header("authorization");
  if (!header) {
    next();
    return;
  }
  if (!header.startsWith("Bearer ")) {
    next(new HttpError(401, "Invalid authentication header"));
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_ACCESS_SECRET, {
      issuer: "relay-api",
      audience: "relay-client",
    });
    if (typeof payload === "string" || !payload.sub) {
      throw new Error("Invalid access token subject");
    }
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, "Invalid or expired access token"));
  }
};

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, 12);

export const verifyPassword = (
  password: string,
  passwordHash: string,
): Promise<boolean> => bcrypt.compare(password, passwordHash);
