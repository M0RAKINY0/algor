import { Router } from 'express';
import { patchRankingConfigSchema } from '../../config/ranking.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  getRankingConfigSnapshot,
  patchRankingConfig,
  resetRankingConfigToDefaults,
} from './ranking.service.js';

export const rankingRouter = Router();

rankingRouter.get('/config', async (_req, res) => {
  res.status(200).json(await getRankingConfigSnapshot());
});

rankingRouter.patch('/config', requireAdmin, async (req, res) => {
  const patch = patchRankingConfigSchema.parse(req.body);
  res.status(200).json(await patchRankingConfig(patch));
});

rankingRouter.post('/config/reset', requireAdmin, async (_req, res) => {
  res.status(200).json(await resetRankingConfigToDefaults());
});
