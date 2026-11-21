import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { interactions } from '../src/db/schema.js';

describe('interactions schema', () => {
  it('allows one like/repost/report/hide per user and post, but repeat views and replies', () => {
    const index = getTableConfig(interactions).indexes.find(
      (i) => i.config.name === 'interactions_once_per_post_idx',
    );
    expect(index?.config.unique).toBe(true);

    const where = new PgDialect().sqlToQuery(index!.config.where!).sql;
    for (const type of ['like', 'repost', 'not_interested', 'report']) {
      expect(where).toContain(`'${type}'`);
    }
    for (const type of ['view', 'reply', 'profile_click']) {
      expect(where).not.toContain(`'${type}'`);
    }
  });
});
