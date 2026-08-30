DROP INDEX "calls_tx_direction_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "calls_tx_window_direction_uidx" ON "calls" USING btree ("tx_hash","window_id","direction");