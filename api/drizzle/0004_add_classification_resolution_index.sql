DROP INDEX `food_classification_food_idx`;--> statement-breakpoint
CREATE INDEX `food_classification_food_idx` ON `food_classification` (`food_id`,`user_id`,"created_at" desc);