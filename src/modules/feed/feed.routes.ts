import { Router } from 'express';
import { currentUserId, requireUser } from '../../middleware/auth.js';
import { feedQuerySchema } from './feed.schemas.js';
import { getFeed } from './feed.service.js';

export const feedRouter = Router();

// Side-effect-free HEAD handler so probes never consume unseen posts or log impressions.
feedRouter.head('/', requireUser, (_req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.status(200).end();
});

feedRouter.get('/', requireUser, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const query = feedQuerySchema.parse(req.query);
  res.status(200).json(await getFeed(currentUserId(req), query));
});
