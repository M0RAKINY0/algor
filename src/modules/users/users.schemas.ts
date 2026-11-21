import { z } from 'zod';

export const handleSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,30}$/, 'Handle must be 1-30 letters, numbers or underscores');

const displayName = z.string().trim().min(1).max(60);
const bio = z.string().trim().max(160).nullable();

export const createUserSchema = z.object({
  handle: handleSchema,
  displayName,
  bio: bio.optional(),
});

export const updateUserSchema = z
  .object({ displayName: displayName.optional(), bio: bio.optional() })
  .refine((v) => v.displayName !== undefined || v.bio !== undefined, {
    message: 'Send displayName or bio',
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
