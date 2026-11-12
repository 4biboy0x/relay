import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const asyncRoute = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = error.status;
    if (status === 400 || status === 413) {
      res.status(status).json({ error: status === 413 ? "Request body is too large" : "Malformed JSON request" });
      return;
    }
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Invalid request",
      details: error.issues.map(({ path, message }) => ({ path, message })),
    });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (code === "P2002") {
      res.status(409).json({ error: "A record with that value already exists" });
      return;
    }
    if (code === "P2025") {
      res.status(404).json({ error: "Record not found" });
      return;
    }
  }
  const errorDetails = typeof error === "object" && error !== null ? error : {};
  console.error("Unhandled API error", {
    route: `${req.method} ${req.originalUrl}`,
    userId: req.userId,
    prismaCode: "code" in errorDetails ? errorDetails.code : undefined,
    prismaMeta: "meta" in errorDetails ? errorDetails.meta : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  }, error);
  res.status(500).json({ error: "Internal server error" });
};
