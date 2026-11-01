import { createHmac } from "node:crypto";
import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clientOrigins, config } from "./config";
import { HttpError } from "./http";

const blockedUserAgent = /(?:bot\b|crawler|spider|slurp|headless|curl\/|wget\/|python-requests|python-urllib|go-http-client|httpie|postmanruntime)/i;

export const viewRequestGuard: RequestHandler = (req, _res, next) => {
  const origin = req.get("origin");
  if (!origin || !clientOrigins.includes(origin)) {
    next(new HttpError(403, "Views must be recorded from the Relay app"));
    return;
  }
  const userAgent = req.get("user-agent") ?? "";
  if (!userAgent || blockedUserAgent.test(userAgent)) {
    next(new HttpError(403, "Automated view requests are not allowed"));
    return;
  }
  next();
};

export const viewRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId
    ? `user:${req.userId}`
    : `ip:${ipKeyGenerator(req.ip ?? "unknown")}`,
});

export const createViewerKey = (
  req: Pick<Request, "userId" | "ip" | "headers">,
  date = new Date(),
): string => {
  if (req.userId) return `u:${req.userId}`;
  const day = date.toISOString().slice(0, 10);
  const fingerprint = createHmac("sha256", config.POST_VIEW_HMAC_SECRET)
    .update(req.ip ?? "unknown")
    .update("\0")
    .update(req.headers["user-agent"] ?? "")
    .update("\0")
    .update(day)
    .digest("hex");
  return `a:${fingerprint}`;
};
