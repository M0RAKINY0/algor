import { eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { follows, users } from '../../db/schema.js';
import { HttpError } from '../../lib/http-error.js';
import { isUniqueViolation } from '../../lib/pg-errors.js';
import type { CreateUserInput, UpdateUserInput } from './users.schemas.js';

// Drizzle drops table names from columns in a single-table select, so the subqueries spell
// them out. Otherwise "id" would only resolve to users.id because follows has no id column.
const profileColumns = {
  ...getTableColumns(users),
  followerCount: sql<number>`(select count(*)::int from ${follows} f where f.followee_id = ${users}.id)`,
  followingCount: sql<number>`(select count(*)::int from ${follows} f where f.follower_id = ${users}.id)`,
};

export type Profile = Awaited<ReturnType<typeof findProfile>>;

async function findProfile(where: SQL) {
  const [row] = await db.select(profileColumns).from(users).where(where);
  return row;
}

async function getProfile(where: SQL) {
  const profile = await findProfile(where);
  if (!profile) throw new HttpError(404, 'User not found');
  return profile;
}

export function getProfileById(id: string) {
  return getProfile(eq(users.id, id));
}

// Handles match case-insensitively, the same way the unique index compares them.
export function getProfileByHandle(handle: string) {
  return getProfile(sql`lower(${users.handle}) = lower(${handle})`);
}

export async function createUser(input: CreateUserInput) {
  try {
    const [user] = await db.insert(users).values(input).returning({ id: users.id });
    return getProfileById(user!.id);
  } catch (err) {
    if (isUniqueViolation(err, 'users_handle_lower_idx')) {
      throw new HttpError(409, 'Handle is already taken');
    }
    throw err;
  }
}

export async function updateUser(id: string, patch: UpdateUserInput) {
  await db.update(users).set(patch).where(eq(users.id, id));
  return getProfileById(id);
}

export async function userExists(id: string) {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return row !== undefined;
}
