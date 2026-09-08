/**
 * Bearer-token authentication middleware for the coordinator API.
 *
 * When a token is configured every /api/* route except /api/health requires
 * Authorization: Bearer <token>.  Comparison is constant-time via
 * crypto.timingSafeEqual so the token is never logged.
 *
 * When no token is configured the middleware is a pass-through (loopback-only
 * callers are presumed safe; config.ts enforces that non-loopback bind hosts
 * must have a token).
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Returns a Hono middleware that enforces bearer-token auth on /api/* except
 * /api/health.  Pass `token: undefined` to get a no-op pass-through.
 */
export function createBearerAuthMiddleware(token: string | undefined): MiddlewareHandler {
  if (!token) {
    return async (_c, next) => {
      await next();
    };
  }

  const expected = Buffer.from(token, "utf-8");

  return async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;

    // Health endpoint is public regardless of token configuration.
    if (path === "/api/health") {
      await next();
      return;
    }

    // Only guard /api/* paths.
    if (!path.startsWith("/api/")) {
      await next();
      return;
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const provided = Buffer.from(authHeader.slice("Bearer ".length), "utf-8");

    // Lengths must match; timingSafeEqual requires equal-length buffers.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    await next();
  };
}
