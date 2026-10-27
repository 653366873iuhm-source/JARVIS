import path from "node:path";
import fs from "node:fs";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";

/** The DB handle. Typed as the libSQL flavour; the Postgres handle is runtime-compatible for every builder call
 *  used in this codebase (select/insert/update/delete, onConflictDoUpdate/DoNothing, returning, sql``). */
export type DB = LibSQLDatabase<typeof sqliteSchema.schema>;
export type Tables = typeof sqliteSchema.schema;

export interface Database {
  db: DB;
  t: Tables;
  dialect: "postgres" | "sqlite" | "pglite";
  close(): Promise<void>;
}

function migrationsDir(sub: "pg" | "sqlite") {
  const base = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle");
  return path.join(base, sub);
}

/**
 * DATABASE_URL:
 *   postgres://user:pass@host:5432/db  -> node-postgres (production)
 *   file:./data/agentpad.db | :memory: -> libSQL / SQLite (local dev fallback, tests)
 *   pglite://memory | pglite://./dir   -> embedded Postgres (WASM) — used by tests to exercise the pg schema
 */
export async function openDatabase(url: string, migrate = true): Promise<Database> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: 10 });
    const db = drizzle(pool, { schema: pgSchema.schema });
    if (migrate) {
      const { migrate: m } = await import("drizzle-orm/node-postgres/migrator");
      await m(db, { migrationsFolder: migrationsDir("pg") });
    }
    return { db: db as unknown as DB, t: pgSchema.schema as unknown as Tables, dialect: "postgres", close: () => pool.end() };
  }
  if (url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const loc = url.slice("pglite://".length);
    const client = loc === "memory" ? new PGlite() : new PGlite(loc);
    const db = drizzle(client, { schema: pgSchema.schema });
    if (migrate) {
      const { migrate: m } = await import("drizzle-orm/pglite/migrator");
      await m(db, { migrationsFolder: migrationsDir("pg") });
    }
    return { db: db as unknown as DB, t: pgSchema.schema as unknown as Tables, dialect: "pglite", close: () => client.close() };
  }
  // SQLite via libSQL
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  let u = url === ":memory:" ? ":memory:" : url.startsWith("file:") ? url : `file:${url}`;
  if (u.startsWith("file:")) {
    const p = u.slice(5);
    if (p && p !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  }
  // `timeout` (busy timeout, ms) is applied by @libsql/client to EVERY connection it opens. The PRAGMA below only
  // reaches the first one: while a transaction holds that connection (indexer batches), concurrent API reads run on a
  // fresh connection with busy_timeout=0 and fail fast with SQLITE_BUSY (seen in the local stage-2 E2E run).
  const client = createClient({ url: u, timeout: 5000 } as Parameters<typeof createClient>[0]);
  await client.execute("PRAGMA journal_mode=WAL").catch(() => undefined);
  await client.execute("PRAGMA busy_timeout=5000").catch(() => undefined);
  const db = drizzle(client, { schema: sqliteSchema.schema });
  if (migrate) {
    const { migrate: m } = await import("drizzle-orm/libsql/migrator");
    await m(db, { migrationsFolder: migrationsDir("sqlite") });
  }
  return { db, t: sqliteSchema.schema, dialect: "sqlite", close: async () => client.close() };
}
