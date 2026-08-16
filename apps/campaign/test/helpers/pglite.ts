/**
 * test/helpers/pglite.ts
 *
 * Spins up a real, in-process Postgres (via @electric-sql/pglite — a
 * WASM-compiled Postgres, not a mock) for tests that need actual
 * constraint behavior: unique-constraint idempotency, real upserts, real
 * aggregation. Mocking `db.select().from().where()` chains can verify the
 * code *called* the right thing; it can't verify a unique constraint
 * actually rejects a duplicate the way the app's idempotency guarantees
 * depend on. This runs the real SQL instead.
 *
 * The schema below is the literal output of `drizzle-kit generate` run
 * against the real src/db/schema.ts (confirmed to produce the same 7
 * tables / same column counts as the project's own migration). If
 * schema.ts changes, regenerate this by running `pnpm db:generate` and
 * copying the new migration's CREATE TABLE statements in below — this
 * intentionally does NOT read the live ./drizzle/*.sql file at test time,
 * since that file's name includes a random suffix per generation and
 * pinning to a specific migration file would break the moment a new one
 * is generated.
 *
 * Instance creation is slow (~4.5s) — WASM cold start. Create ONE
 * instance per test file in beforeAll, and truncate between tests in
 * beforeEach (truncation is ~3ms) rather than creating a fresh instance
 * per test.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../src/db/schema.js";

const SCHEMA_SQL = `
CREATE SCHEMA "campaign";
CREATE TABLE "campaign"."bug_reports" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "severity" text NOT NULL,
  "status" text DEFAULT 'submitted' NOT NULL,
  "reviewed_by" text,
  "points_awarded" integer,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reviewed_at" timestamp with time zone
);
CREATE TABLE "campaign"."points_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "phase" text NOT NULL,
  "action_type" text NOT NULL,
  "base_points" integer NOT NULL,
  "weight" numeric(10, 4) NOT NULL,
  "weighted_points" integer NOT NULL,
  "reference" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "points_ledger_wallet_action_reference" UNIQUE("wallet","action_type","reference")
);
CREATE TABLE "campaign"."redemptions" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "points_redeemed" integer NOT NULL,
  "eth_amount_wei" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "approved_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "tx_hash" text,
  CONSTRAINT "redemptions_wallet_unique" UNIQUE("wallet")
);
CREATE TABLE "campaign"."referral_codes" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "code" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "referral_codes_wallet_unique" UNIQUE("wallet"),
  CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
CREATE TABLE "campaign"."referral_credits" (
  "id" text PRIMARY KEY NOT NULL,
  "referrer_wallet" text NOT NULL,
  "referred_wallet" text NOT NULL,
  "tier" text NOT NULL,
  "base_points" integer NOT NULL,
  "weighted_points" integer NOT NULL,
  "credited_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "referral_credits_referred_wallet_unique" UNIQUE("referred_wallet")
);
CREATE TABLE "campaign"."snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "total_points" integer NOT NULL,
  "frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "snapshots_wallet_unique" UNIQUE("wallet")
);
CREATE TABLE "campaign"."social_bonus" (
  "id" text PRIMARY KEY NOT NULL,
  "wallet" text NOT NULL,
  "galxe_quest_id" text NOT NULL,
  "points" integer NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
`;

const TABLES = [
  "campaign.bug_reports",
  "campaign.points_ledger",
  "campaign.redemptions",
  "campaign.referral_codes",
  "campaign.referral_credits",
  "campaign.snapshots",
  "campaign.social_bonus",
] as const;

export async function createTestDb() {
  const client = new PGlite();
  await client.exec(SCHEMA_SQL);
  const db = drizzle(client, { schema });
  return { db, client };
}

export async function truncateAll(client: PGlite): Promise<void> {
  await client.exec(`TRUNCATE ${TABLES.join(", ")};`);
}
