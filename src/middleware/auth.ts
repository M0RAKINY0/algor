import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { HttpError } from '../lib/http-error.js';
import { userExists } from '../modules/ingest/ingest.service.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

const userIdSchema = z.uuid().transform((v) => v.toLowerCase());

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function keysMatch(provided: string | undefined, expected: string): boolean {
  return Boolean(provided && timingSafeEqual(sha256(provided), sha256(expected)));
}

/**
 * Identity guard reading the caller UUID from `x-user-id` (canonicalized to lowercase so it
 * always matches PostgreSQL UUID strings).
 *
 * Security boundary:
 * - When `INTERNAL_API_KEY` is configured, callers must also present a matching `x-internal-key`
 *   header (e.g. injected by an authenticated API gateway).
 * - In `production`, fails closed with 503 if `INTERNAL_API_KEY` is unset so unverified
 *   `x-user-id` headers are never trusted publicly.
 * - In `development`/`test` with no `INTERNAL_API_KEY`, accepts `x-user-id` directly for local ergonomics.
 */
export function createRequireUser(
  getAuthConfig: () => { internalApiKey: string | undefined; nodeEnv: string },
  checkUserExists: (id: string) => Promise<boolean> = userExists,
): RequestHandler {
  return async (req, _res, next) => {
    const { internalApiKey, nodeEnv } = getAuthConfig();

    if (!internalApiKey) {
      if (nodeEnv === 'production') {
        throw new HttpError(503, 'Internal API key is not configured for x-user-id trust boundary');
      }
    } else if (!keysMatch(req.header('x-internal-key'), internalApiKey)) {
      throw new HttpError(401, 'Invalid or missing x-internal-key header');
    }

    const header = req.header('x-user-id');
    if (!header) throw new HttpError(401, 'Missing x-user-id header');

    const parsed = userIdSchema.safeParse(header);
    if (!parsed.success) throw new HttpError(401, 'x-user-id must be a UUID');

    if (!(await checkUserExists(parsed.data))) throw new HttpError(401, 'Unknown user');

    req.userId = parsed.data;
    next();
  };
}

export const requireUser = createRequireUser(() => ({
  internalApiKey: env.INTERNAL_API_KEY,
  nodeEnv: env.NODE_ENV,
}));

// For handlers behind requireUser.
export function currentUserId(req: Request): string {
  if (!req.userId) throw new HttpError(401, 'Not signed in');
  return req.userId;
}

export function createRequireAdmin(
  getAuthConfig: () => { apiKey: string | undefined; nodeEnv: string },
): RequestHandler {
  return (req, _res, next) => {
    const { apiKey, nodeEnv } = getAuthConfig();

    if (!apiKey) {
      if (nodeEnv === 'production') {
        throw new HttpError(503, 'Admin API key is not configured');
      }
      next();
      return;
    }

    if (!keysMatch(req.header('x-admin-key'), apiKey)) {
      throw new HttpError(401, 'Invalid or missing x-admin-key header');
    }

    next();
  };
}

export const requireAdmin = createRequireAdmin(() => ({
  apiKey: env.ADMIN_API_KEY,
  nodeEnv: env.NODE_ENV,
}));
