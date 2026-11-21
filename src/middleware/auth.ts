import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { userExists } from '../modules/users/users.service.js';

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
