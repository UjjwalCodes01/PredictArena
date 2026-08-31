CREATE TABLE "duels" (
	"id" text PRIMARY KEY NOT NULL,
	"challenger" text NOT NULL,
	"opponent" text NOT NULL,
	"window_id" text NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"week_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "duels_challenger_idx" ON "duels" USING btree ("challenger");--> statement-breakpoint
CREATE INDEX "duels_opponent_idx" ON "duels" USING btree ("opponent");--> statement-breakpoint
CREATE INDEX "duels_window_idx" ON "duels" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "duels_week_idx" ON "duels" USING btree ("week_id");