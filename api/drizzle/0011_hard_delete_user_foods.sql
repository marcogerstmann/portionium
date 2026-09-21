PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`meal_id` text NOT NULL,
	`food_id` text,
	`category` text,
	`quantity` real,
	`position` integer NOT NULL,
	FOREIGN KEY (`meal_id`) REFERENCES `meal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`food_id`) REFERENCES `food`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "entry_food_or_category" CHECK("__new_entry"."food_id" is not null or "__new_entry"."category" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_entry`("id", "created_at", "updated_at", "deleted_at", "meal_id", "food_id", "category", "quantity", "position") SELECT "id", "created_at", "updated_at", "deleted_at", "meal_id", "food_id", "category", "quantity", "position" FROM `entry`;--> statement-breakpoint
DROP TABLE `entry`;--> statement-breakpoint
ALTER TABLE `__new_entry` RENAME TO `entry`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `entry_food_idx` ON `entry` (`food_id`);--> statement-breakpoint
CREATE TABLE `__new_food_classification_withdrawal` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`food_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `food`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_food_classification_withdrawal`("id", "created_at", "updated_at", "deleted_at", "food_id", "user_id") SELECT "id", "created_at", "updated_at", "deleted_at", "food_id", "user_id" FROM `food_classification_withdrawal`;--> statement-breakpoint
DROP TABLE `food_classification_withdrawal`;--> statement-breakpoint
ALTER TABLE `__new_food_classification_withdrawal` RENAME TO `food_classification_withdrawal`;--> statement-breakpoint
CREATE INDEX `food_classification_withdrawal_food_idx` ON `food_classification_withdrawal` (`food_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `__new_food_classification` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`food_id` text NOT NULL,
	`user_id` text,
	`category` text NOT NULL,
	`source` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`confidence` real,
	`reasoning` text,
	`assumptions` text,
	FOREIGN KEY (`food_id`) REFERENCES `food`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_food_classification`("id", "created_at", "updated_at", "deleted_at", "food_id", "user_id", "category", "source", "model", "prompt_version", "confidence", "reasoning", "assumptions") SELECT "id", "created_at", "updated_at", "deleted_at", "food_id", "user_id", "category", "source", "model", "prompt_version", "confidence", "reasoning", "assumptions" FROM `food_classification`;--> statement-breakpoint
DROP TABLE `food_classification`;--> statement-breakpoint
ALTER TABLE `__new_food_classification` RENAME TO `food_classification`;--> statement-breakpoint
CREATE INDEX `food_classification_food_idx` ON `food_classification` (`food_id`,`user_id`,"created_at" desc);