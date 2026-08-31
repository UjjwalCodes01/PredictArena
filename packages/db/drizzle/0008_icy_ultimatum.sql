CREATE TYPE "public"."forecast_action" AS ENUM('PLACE', 'PASS');--> statement-breakpoint
CREATE TABLE "forecasts" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"window_id" text NOT NULL,
	"asset" text NOT NULL,
	"probability_up_bps" integer NOT NULL,
	"confidence" text NOT NULL,
	"rationale" text NOT NULL,
	"key_factors" text,
	"action" "forecast_action" NOT NULL,
	"pass_reason" text,
	"side" "direction",
	"ask_up" numeric(78, 0),
	"ask_down" numeric(78, 0),
	"edge" numeric(78, 0),
	"tx_hash" text,
	"closes_at" timestamp with time zone NOT NULL,
	"week_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "forecasts_wallet_idx" ON "forecasts" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "forecasts_window_idx" ON "forecasts" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "forecasts_created_idx" ON "forecasts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "forecasts_week_idx" ON "forecasts" USING btree ("week_id");