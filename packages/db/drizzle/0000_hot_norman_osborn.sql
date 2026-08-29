CREATE TYPE "public"."call_status" AS ENUM('PENDING', 'WON', 'LOST', 'VOID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('UP', 'DOWN');--> statement-breakpoint
CREATE TYPE "public"."window_status" AS ENUM('OPEN', 'LOCKED', 'RESOLVED', 'VOIDED');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"window_id" text NOT NULL,
	"asset" text NOT NULL,
	"direction" "direction" NOT NULL,
	"stake" numeric(78, 0) NOT NULL,
	"quantity" numeric(78, 0) DEFAULT '0' NOT NULL,
	"tx_hash" text NOT NULL,
	"idempotency_key" numeric(78, 0),
	"status" "call_status" DEFAULT 'PENDING' NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"payout" numeric(78, 0),
	"redeem_tx_hash" text,
	"week_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"key" text NOT NULL,
	"block_number" bigint,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_key_pk" PRIMARY KEY("key")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text
);
--> statement-breakpoint
CREATE TABLE "windows" (
	"id" text PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"venue_id" text,
	"interval_sec" integer,
	"strike" numeric(78, 0),
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" "window_status" DEFAULT 'OPEN' NOT NULL,
	"winning_outcome" integer,
	"resolved_at" timestamp with time zone,
	"week_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_window_id_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_tx_hash_uidx" ON "calls" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "calls_wallet_window_idx" ON "calls" USING btree ("wallet","window_id");--> statement-breakpoint
CREATE INDEX "calls_week_status_idx" ON "calls" USING btree ("week_id","status");--> statement-breakpoint
CREATE INDEX "calls_status_idx" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "calls_wallet_idx" ON "calls" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "windows_asset_closes_idx" ON "windows" USING btree ("asset","closes_at");--> statement-breakpoint
CREATE INDEX "windows_week_idx" ON "windows" USING btree ("week_id");--> statement-breakpoint
CREATE INDEX "windows_status_idx" ON "windows" USING btree ("status");