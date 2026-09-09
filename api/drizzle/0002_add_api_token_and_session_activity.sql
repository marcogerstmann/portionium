CREATE TABLE `api_token` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_token_hash_unique` ON `api_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_token_user_idx` ON `api_token` (`user_id`);--> statement-breakpoint
-- SQLite refuses to add a NOT NULL column with no default, whatever is in the table, so the
-- column arrives with one and every existing row is then backfilled from its own created_at:
-- the last activity anybody can actually prove happened. New rows get their value from the
-- application, see baseColumns and touchSession.
ALTER TABLE `session` ADD `last_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `session` SET `last_activity_at` = `created_at`;