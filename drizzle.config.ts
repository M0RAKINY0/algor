import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Must match the casing in src/db/index.ts, or migrations get camelCase columns.
  casing: 'snake_case',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
