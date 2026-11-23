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

const userIdSchema = z.uuid();

// Dev-only identity: the caller says who they are in the x-user-id header, and we trust it.
// To add real login, replace this function with JWT verification. Routes only read
// req.userId, so nothing else changes.
export const requireUser: RequestHandler = async (req, _res, next) => {
  const header = req.header('x-user-id');
  if (!header) throw new HttpError(401, 'Missing x-user-id header');

  const parsed = userIdSchema.safeParse(header);
  if (!parsed.success) throw new HttpError(401, 'x-user-id must be a UUID');

  if (!(await userExists(parsed.data))) throw new HttpError(401, 'Unknown user');

  req.userId = parsed.data;
  next();
};

// For handlers behind requireUser.
export function currentUserId(req: Request): string {
  if (!req.userId) throw new HttpError(401, 'Not signed in');
  return req.userId;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
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

    const provided = req.header('x-admin-key');
    if (!provided || !timingSafeEqual(sha256(provided), sha256(apiKey))) {
      throw new HttpError(401, 'Invalid or missing x-admin-key header');
    }

    next();
  };
}

export const requireAdmin = createRequireAdmin(() => ({
  apiKey: env.ADMIN_API_KEY,
  nodeEnv: env.NODE_ENV,
}));
