CREATE SCHEMA "campaign";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."bug_reports" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."points_ledger" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."redemptions" (
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."referral_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_wallet_unique" UNIQUE("wallet"),
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."referral_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"referrer_wallet" text NOT NULL,
	"referred_wallet" text NOT NULL,
	"tier" text NOT NULL,
	"base_points" integer NOT NULL,
	"weighted_points" integer NOT NULL,
	"credited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_credits_referred_wallet_unique" UNIQUE("referred_wallet")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"total_points" integer NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_wallet_unique" UNIQUE("wallet")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaign"."social_bonus" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"galxe_quest_id" text NOT NULL,
	"points" integer NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
