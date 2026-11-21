// Drizzle wraps driver errors in DrizzleQueryError, so the pg error may sit on `.cause`.
function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  if ('code' in err) return err as { code?: string; constraint?: string };
  return 'cause' in err ? pgError(err.cause) : undefined;
}

export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgError(err);
  return pg?.code === '23505' && pg.constraint === constraint;
}
