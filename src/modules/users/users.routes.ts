import { Router } from 'express';
import { currentUserId, requireUser } from '../../middleware/auth.js';
import { createUserSchema, handleSchema, updateUserSchema } from './users.schemas.js';
import { createUser, getProfileByHandle, getProfileById, updateUser } from './users.service.js';

export const usersRouter = Router();

usersRouter.post('/', async (req, res) => {
  const input = createUserSchema.parse(req.body);
  res.status(201).json(await createUser(input));
});

// /me routes come before /:handle so "me" isn't read as a handle.
usersRouter.get('/me', requireUser, async (req, res) => {
  res.json(await getProfileById(currentUserId(req)));
});

usersRouter.patch('/me', requireUser, async (req, res) => {
  const patch = updateUserSchema.parse(req.body);
  res.json(await updateUser(currentUserId(req), patch));
});

usersRouter.get('/:handle', async (req, res) => {
  const handle = handleSchema.parse(req.params.handle);
  res.json(await getProfileByHandle(handle));
});
