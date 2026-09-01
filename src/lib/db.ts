import { PrismaClient } from "@prisma/client";

/**
 * Standard Next.js Prisma singleton pattern — avoids exhausting Postgres connections
 * from hot-reloading a new PrismaClient on every dev-server file change.
 *
 * STILL NOT EXECUTED IN THIS SANDBOX, but for a narrower reason than before: a real
 * Postgres 16 instance now runs here, and the RELATIONAL SCHEMA has been executed and
 * validated against it — see db/schema.sql and db/validate.sql. What's still missing
 * is `@prisma/client` itself: this sandbox has no outbound access to the npm registry,
 * so the Prisma Client this file imports can't be installed or generated here, which
 * means this file — and every route under src/app/api/ that imports it — still can't
 * actually run in this environment. Once you have real npm access, `npm install` +
 * `npx prisma generate` should make this work as written; verify it against your own
 * Supabase/Postgres connection string at that point.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
