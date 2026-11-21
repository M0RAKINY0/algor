// Drizzle table definitions. drizzle-kit reads this file to generate migrations.
// Column keys are camelCase here and snake_case in Postgres (casing: 'snake_case').
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- users ----------

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    handle: varchar({ length: 30 }).notNull(),
    displayName: varchar({ length: 60 }).notNull(),
    bio: varchar({ length: 160 }),
    createdAt: createdAt(),
  },
  (t) => [
    // "Alice" and "alice" are the same handle.
    uniqueIndex('users_handle_lower_idx').on(sql`lower(${t.handle})`),
    check('users_handle_format', sql`${t.handle} ~ '^[A-Za-z0-9_]{1,30}$'`),
  ],
);

// ---------- posts ----------

export const posts = pgTable(
  'posts',
  {
    id: uuid().primaryKey().defaultRandom(),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text().notNull(),
    // Set when this post is a reply. The parent can be deleted without deleting the reply.
    replyToId: uuid().references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('posts_author_created_idx').on(t.authorId, t.createdAt.desc()),
    index('posts_created_idx').on(t.createdAt.desc()),
    index('posts_reply_to_idx').on(t.replyToId),
    check('posts_body_length', sql`char_length(${t.body}) between 1 and 280`),
  ],
);

// One row per hashtag, stored lowercase without the '#'.
export const topics = pgTable(
  'topics',
  {
    id: serial().primaryKey(),
    name: varchar({ length: 50 }).notNull().unique(),
  },
  (t) => [check('topics_name_lowercase', sql`${t.name} = lower(${t.name})`)],
);

export const postTopics = pgTable(
  'post_topics',
  {
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    topicId: integer()
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.topicId] }),
    index('post_topics_topic_idx').on(t.topicId),
  ],
);

// ---------- graph ----------

export const follows = pgTable(
  'follows',
  {
    followerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    followeeId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    index('follows_followee_idx').on(t.followeeId),
    check('follows_not_self', sql`${t.followerId} <> ${t.followeeId}`),
  ],
);

export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index('blocks_blocked_idx').on(t.blockedId),
    check('blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

export const mutes = pgTable(
  'mutes',
  {
    muterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mutedId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.muterId, t.mutedId] }),
    check('mutes_not_self', sql`${t.muterId} <> ${t.mutedId}`),
  ],
);

// ---------- interactions ----------

export const interactionType = pgEnum('interaction_type', [
  'view',
  'like',
  'reply',
  'repost',
  'profile_click',
  'not_interested',
  'report',
]);

// Append-only log of everything a user does to a post. `signals` reads it to update affinity.
export const interactions = pgTable(
  'interactions',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    type: interactionType().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('interactions_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('interactions_post_type_idx').on(t.postId, t.type),
    // A user can like, repost, report or hide a post once. Views and replies can repeat.
    uniqueIndex('interactions_once_per_post_idx')
      .on(t.userId, t.postId, t.type)
      .where(sql`${t.type} in ('like', 'repost', 'not_interested', 'report')`),
  ],
);

// ---------- signals ----------
// Scores decay over time: the read side applies score * exp(-rate * age since updatedAt).

export const userAuthorAffinity = pgTable(
  'user_author_affinity',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    score: real().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.authorId] }),
    index('user_author_affinity_user_score_idx').on(t.userId, t.score.desc()),
  ],
);

export const userTopicAffinity = pgTable(
  'user_topic_affinity',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: integer()
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    score: real().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.topicId] }),
    index('user_topic_affinity_user_score_idx').on(t.userId, t.score.desc()),
  ],
);

export const postStats = pgTable(
  'post_stats',
  {
    postId: uuid()
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    viewCount: integer().notNull().default(0),
    likeCount: integer().notNull().default(0),
    replyCount: integer().notNull().default(0),
    repostCount: integer().notNull().default(0),
    notInterestedCount: integer().notNull().default(0),
    reportCount: integer().notNull().default(0),
    // Weighted sum of the counts above, using the weights in the ranking config.
    engagementScore: real().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [index('post_stats_engagement_idx').on(t.engagementScore.desc())],
);

// ---------- feed ----------

// What the feed served to whom. Drives the "already seen" filter and is training data for ML later.
export const impressions = pgTable(
  'impressions',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: uuid()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    score: real().notNull(),
    position: integer().notNull(),
    servedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.postId] }),
    index('impressions_user_served_idx').on(t.userId, t.servedAt.desc()),
  ],
);
