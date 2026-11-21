import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { blocks, follows, mutes, posts, postTopics, topics, users } from '../../db/schema.js';
import { extractHashtags, normalizeTopic } from '../../lib/hashtags.js';
import { HttpError } from '../../lib/http-error.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/pg-errors.js';
import type {
  GraphEdgeInput,
  IngestGraphInput,
  IngestPostsInput,
  IngestUsersInput,
} from './ingest.schemas.js';

export async function userExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return row !== undefined;
}

export async function ingestUsers(input: IngestUsersInput) {
  // Deduplicate by case-insensitive handle within a single batch (last entry wins).
  const deduped = new Map<string, (typeof input.users)[number]>();
  for (const user of input.users) {
    deduped.set(user.handle.toLowerCase(), user);
  }

  try {
    const upserted = await db.transaction(async (tx) => {
      const lowerHandles = [...deduped.keys()];
      const existing = await tx
        .select({ id: users.id, handle: users.handle })
        .from(users)
        .where(inArray(sql`lower(${users.handle})`, lowerHandles));

      const existingByLower = new Map(existing.map((u) => [u.handle.toLowerCase(), u.id]));
      const toInsert: Array<{
        id?: string;
        handle: string;
        displayName: string;
        bio: string | null;
      }> = [];
      const updated: Array<typeof users.$inferSelect> = [];

      for (const [lower, user] of deduped) {
        const existingId = existingByLower.get(lower);
        if (existingId) {
          const [row] = await tx
            .update(users)
            .set({ displayName: user.displayName, bio: user.bio ?? null })
            .where(eq(users.id, existingId))
            .returning();
          if (row) updated.push(row);
        } else {
          toInsert.push({
            ...(user.id ? { id: user.id } : {}),
            handle: user.handle,
            displayName: user.displayName,
            bio: user.bio ?? null,
          });
        }
      }

      const inserted =
        toInsert.length > 0 ? await tx.insert(users).values(toInsert).returning() : [];

      return [...inserted, ...updated];
    });

    return { count: upserted.length, users: upserted };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'User id or handle conflicts with an existing user');
    }
    throw err;
  }
}

export async function ingestPosts(input: IngestPostsInput) {
  const prepared = input.posts.map((item) => {
    const mergedTopics = new Set<string>(extractHashtags(item.body));
    for (const topic of item.topics ?? []) {
      mergedTopics.add(normalizeTopic(topic));
    }

    return {
      row: {
        ...(item.id ? { id: item.id } : {}),
        authorId: item.authorId,
        body: item.body,
        replyToId: item.replyToId ?? null,
        ...(item.createdAt ? { createdAt: new Date(item.createdAt) } : {}),
      },
      topics: [...mergedTopics].sort(),
    };
  });

  try {
    const ingested = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(posts)
        .values(prepared.map((p) => p.row))
        .onConflictDoNothing({ target: posts.id })
        .returning();

      if (inserted.length === 0) return [];

      // Map each inserted post back to its extracted/explicit topics.
      // When explicit IDs are supplied, match by ID; otherwise positional order matches values().
      const topicsById = new Map<string, string[]>();
      const preparedById = new Map<string, string[]>();
      for (const p of prepared) {
        if (p.row.id) preparedById.set(p.row.id, p.topics);
      }

      const allTopicNames = new Set<string>();
      for (let i = 0; i < inserted.length; i++) {
        const post = inserted[i]!;
        const postTopicList = preparedById.get(post.id) ?? prepared[i]?.topics ?? [];
        topicsById.set(post.id, postTopicList);
        for (const name of postTopicList) allTopicNames.add(name);
      }

      if (allTopicNames.size > 0) {
        const uniqueNames = [...allTopicNames];
        await tx
          .insert(topics)
          .values(uniqueNames.map((name) => ({ name })))
          .onConflictDoNothing({ target: topics.name });

        const topicRows = await tx
          .select({ id: topics.id, name: topics.name })
          .from(topics)
          .where(inArray(topics.name, uniqueNames));

        const idByName = new Map(topicRows.map((t) => [t.name, t.id]));
        const links: Array<{ postId: string; topicId: number }> = [];

        for (const [postId, names] of topicsById) {
          for (const name of names) {
            const topicId = idByName.get(name);
            if (topicId !== undefined) links.push({ postId, topicId });
          }
        }

        if (links.length > 0) {
          await tx.insert(postTopics).values(links).onConflictDoNothing();
        }
      }

      return inserted.map((post) => ({
        ...post,
        topics: topicsById.get(post.id) ?? [],
      }));
    });

    return { count: ingested.length, posts: ingested };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new HttpError(400, 'Referenced authorId or replyToId does not exist');
    }
    throw err;
  }
}

export async function ingestGraph(input: IngestGraphInput) {
  // Group consecutive edges with the same action so bulk ingests run in minimal SQL queries
  // while preserving exact order for mixed add/remove sequences.
  const runs: Array<{ action: GraphEdgeInput['action']; edges: GraphEdgeInput[] }> = [];
  for (const edge of input.edges) {
    const prev = runs.at(-1);
    if (prev && prev.action === edge.action) {
      prev.edges.push(edge);
    } else {
      runs.push({ action: edge.action, edges: [edge] });
    }
  }

  try {
    await db.transaction(async (tx) => {
      for (const run of runs) {
        switch (run.action) {
          case 'follow':
            await tx
              .insert(follows)
              .values(
                run.edges.map((e) => ({ followerId: e.sourceUserId, followeeId: e.targetUserId })),
              )
              .onConflictDoNothing();
            break;
          case 'unfollow':
            for (const e of run.edges) {
              await tx
                .delete(follows)
                .where(
                  and(
                    eq(follows.followerId, e.sourceUserId),
                    eq(follows.followeeId, e.targetUserId),
                  ),
                );
            }
            break;
          case 'block':
            await tx
              .insert(blocks)
              .values(
                run.edges.map((e) => ({ blockerId: e.sourceUserId, blockedId: e.targetUserId })),
              )
              .onConflictDoNothing();
            break;
          case 'unblock':
            for (const e of run.edges) {
              await tx
                .delete(blocks)
                .where(
                  and(eq(blocks.blockerId, e.sourceUserId), eq(blocks.blockedId, e.targetUserId)),
                );
            }
            break;
          case 'mute':
            await tx
              .insert(mutes)
              .values(run.edges.map((e) => ({ muterId: e.sourceUserId, mutedId: e.targetUserId })))
              .onConflictDoNothing();
            break;
          case 'unmute':
            for (const e of run.edges) {
              await tx
                .delete(mutes)
                .where(and(eq(mutes.muterId, e.sourceUserId), eq(mutes.mutedId, e.targetUserId)));
            }
            break;
        }
      }
    });

    return { applied: input.edges.length };
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new HttpError(400, 'Referenced user does not exist');
    }
    throw err;
  }
}
