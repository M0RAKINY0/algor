import { Router } from 'express';
import { currentUserId, requireUser } from '../../middleware/auth.js';
import { getSignalsQuerySchema, recordEventSchema } from './signals.schemas.js';
import { getUserSignals, recordEvent } from './signals.service.js';

export const eventsRouter = Router();
export const signalsRouter = Router();

eventsRouter.post('/', requireUser, async (req, res) => {
  const input = recordEventSchema.parse(req.body);
  const result = await recordEvent(currentUserId(req), input);
  res.status(result.recorded ? 201 : 200).json(result);
});

signalsRouter.get('/', requireUser, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const query = getSignalsQuerySchema.parse(req.query);
  res.status(200).json(await getUserSignals(currentUserId(req), query.limit));
});
