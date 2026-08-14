/**
 * drizzle.config.ts
 *
 * Config for drizzle-kit, scoped to apps/campaign's OWN tables only —
 * points_ledger, bug_reports, referral_codes, referral_credits,
 * social_bonus, snapshots, redemptions — all under the "campaign" Postgres
 * schema (see src/db/schema.ts).
 *
 * This does NOT touch the tables Ponder owns (vaults, vault_transactions,
 * balance_events). Those are migrated by Ponder itself when apps/indexer
 * starts — never run drizzle-kit against them.
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["campaign"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
