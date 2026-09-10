CREATE TABLE `food_classification_withdrawal` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`food_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `food`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `food_classification_withdrawal_food_idx` ON `food_classification_withdrawal` (`food_id`,`user_id`);