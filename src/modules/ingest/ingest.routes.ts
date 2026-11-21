import { Router } from 'express';
import { ingestGraphSchema, ingestPostsSchema, ingestUsersSchema } from './ingest.schemas.js';
import { ingestGraph, ingestPosts, ingestUsers } from './ingest.service.js';

export const ingestRouter = Router();

ingestRouter.post('/users', async (req, res) => {
  const input = ingestUsersSchema.parse(req.body);
  res.status(200).json(await ingestUsers(input));
});

ingestRouter.post('/posts', async (req, res) => {
  const input = ingestPostsSchema.parse(req.body);
  res.status(201).json(await ingestPosts(input));
});

ingestRouter.post('/graph', async (req, res) => {
  const input = ingestGraphSchema.parse(req.body);
  res.status(200).json(await ingestGraph(input));
});
