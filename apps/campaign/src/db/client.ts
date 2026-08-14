/**
 * src/db/client.ts
 *
 * Drizzle client for campaign's OWN tables (the "campaign" schema).
 * Same pattern as packages/db/src/client.ts: accepts databaseUrl as a
 * parameter, one client instantiated once at startup and reused.
 *
 * This is a separate client instance from @aeternum/db's createDbClient —
 * they point at the same Postgres database but different schemas
 * (public/default for Ponder's tables, "campaign" for these). Keeping them
 * separate means a change to one schema's shape can never accidentally
 * affect the other's client typing.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type CampaignDbClient = ReturnType<typeof createCampaignDbClient>;

export function createCampaignDbClient(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  return drizzle(sql, { schema });
}
