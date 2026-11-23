# algor

A standalone, X-style recommendation feed engine that learns from user behavior.

Algor focuses on the **ranking and learning pipeline** — not social-app boilerplate (no profile editing, reply threads, or full social CRUD). Feed it users, posts, graph edges, and interaction events; pull back a ranked, diversified feed with inspectable score breakdowns.

---

## How the pipeline works

```text
  Events (like, reply, repost, view, not_interested, report)
        │
        ▼
  1. Signals ──────► updates post_stats + time-decayed author & topic affinities
        │
        ▼
  2. Candidates ───► retrieves ~500 posts from 4 sources:
        │            • in-network (followed authors)
        │            • topic match (user's top topics)
        │            • social proof (liked/reposted by follows)
        │            • trending (recent high-engagement posts)
        ▼
  3. Ranking ──────► scores each candidate (author affinity × topic match ×
        │            engagement × recency) with tunable weights & debug breakdown
        ▼
  4. Filter & Mix ─► removes blocked, muted, seen, and own posts; caps consecutive
        │            posts per author; balances in-network vs. out-of-network
        ▼
  5. Impressions ──► logs served posts so the next page doesn't repeat them
```

### Default engagement weights

Starting from X's open-sourced recommendation weights (tunable at runtime via ranking config):

| Interaction      | Default weight | Notes                     |
| ---------------- | -------------: | ------------------------- |
| `reply`          |        `+13.5` | Strongest positive signal |
| `repost`         |         `+1.0` | Amplification             |
| `like`           |         `+0.5` | Lightweight endorsement   |
| `profile_click`  |         `+0.5` | Author interest           |
| `view`           |         `+0.0` | Tracked for reach / CTR   |
| `not_interested` |        `-74.0` | Strong negative signal    |
| `report`         |       `-369.0` | Heavy demotion            |

---

## API surface

Interactive docs are served via Swagger UI at **`/docs`** (raw OpenAPI 3.0.3 spec at **`/openapi.json`**).

> **Identity:** Endpoints that act on behalf of a user read a UUID from the `x-user-id` header (`requireUser` middleware). There are no login or session tables by design.

### Core endpoints

| Area        | Endpoint                               | Purpose                                                                        | Status |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| **System**  | `GET /health`                          | Liveness check                                                                 | Done   |
| **Docs**    | `GET /docs`, `GET /openapi.json`       | Swagger UI & OpenAPI spec                                                      | Done   |
| **Ingest**  | `POST /api/ingest/{users,posts,graph}` | Thin intake for users, posts (extracts `#topics`), and follow/block/mute edges | Done   |
| **Signals** | `POST /api/events`                     | Log an interaction and update `post_stats` + decaying affinities               | Done   |
| **Signals** | `GET /api/signals`                     | Inspect the caller's decayed top authors & topics                              | Done   |
| **Feed**    | `GET /api/feed`                        | Ranked, filtered, mixed feed (`?limit=20&cursor=...&debug=true`)               | Done   |
| **Tuning**  | `GET / PATCH /api/ranking/config`      | View, live-tweak, or reset weights, decay half-lives, and diversity knobs      | Done   |

---

## Project layout

```text
src/
├── app.ts                # Express 5 app setup (helmet, cors, pino-http, error handling)
├── index.ts              # HTTP server entrypoint & graceful shutdown
├── config/
│   ├── env.ts            # Zod-validated environment variables
│   └── ranking.ts        # Tunable weights, decay half-lives, mix ratios
├── db/
│   ├── index.ts          # node-postgres pool + Drizzle client (snake_case mapping)
│   └── schema.ts         # All tables: users, posts, topics, post_topics, graph,
│                         # interactions, affinities, post_stats, impressions
├── docs/                 # OpenAPI 3.0.3 builder (from Zod v4 schemas) + Swagger UI
├── lib/                  # Logger, hashtags, HttpError, Postgres error helpers
├── middleware/           # x-user-id auth guard & global error handler
└── modules/
    ├── ingest/           # Thin intake for users, posts (+hashtags), and graph edges
    ├── signals/          # Interaction logging + decaying affinity math
    ├── candidates/       # Multi-source candidate retrieval
    ├── ranking/          # Scoring formula, author diversity, debug breakdowns & config API
    └── feed/             # Pipeline orchestration, diversity mix, impressions
scripts/
└── seed.ts               # Clustered users, hashtagged posts, graph & interactions
```

---

## Stack

- **Runtime:** Node.js >= 22, TypeScript, Express 5
- **Database:** PostgreSQL 17, Drizzle ORM + `drizzle-kit`
- **Validation & Docs:** Zod v4 (single source of truth for request validation and OpenAPI schemas via `z.toJSONSchema`), `swagger-ui-express`
- **Testing & Tooling:** Vitest, Supertest, Pino, Prettier, Husky + Commitlint

---

## Getting started

### Prerequisites

- Node.js `>= 22`
- pnpm `>= 12`
- Docker (for local Postgres)

### Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env

# 3. Start Postgres (exposed on localhost:5434 to avoid conflicting with local 5432)
docker compose up -d

# 4. Run migrations
pnpm db:migrate

# 5. Start the dev server
pnpm dev
```

Once running:

- **API:** `http://localhost:4000`
- **Swagger UI:** `http://localhost:4000/docs`
- **OpenAPI JSON:** `http://localhost:4000/openapi.json`

---

## Scripts

| Command             | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `pnpm dev`          | Run API with `tsx watch`                                |
| `pnpm build`        | Compile TypeScript to `dist/`                           |
| `pnpm start`        | Run compiled server (`node dist/index.js`)              |
| `pnpm typecheck`    | Type-check without emitting                             |
| `pnpm test`         | Run Vitest test suite once                              |
| `pnpm test:watch`   | Run Vitest in watch mode                                |
| `pnpm format`       | Format codebase with Prettier                           |
| `pnpm format:check` | Check Prettier formatting                               |
| `pnpm db:generate`  | Generate Drizzle SQL migrations from `src/db/schema.ts` |
| `pnpm db:migrate`   | Apply pending migrations                                |
| `pnpm db:studio`    | Open Drizzle Studio                                     |
