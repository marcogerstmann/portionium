ALTER TABLE `meal_item` RENAME TO `entry`;--> statement-breakpoint
ALTER TABLE `meal_favourite` RENAME COLUMN "items" TO "entries";--> statement-breakpoint
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
	FOREIGN KEY (`food_id`) REFERENCES `food`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entry_food_or_category" CHECK("__new_entry"."food_id" is not null or "__new_entry"."category" is not null)
);
--> statement-breakpoint
INSERT INTO `__new_entry`("id", "created_at", "updated_at", "deleted_at", "meal_id", "food_id", "category", "quantity", "position") SELECT "id", "created_at", "updated_at", "deleted_at", "meal_id", "food_id", NULL, "quantity", "position" FROM `entry`;--> statement-breakpoint
DROP TABLE `entry`;--> statement-breakpoint
ALTER TABLE `__new_entry` RENAME TO `entry`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `entry_food_idx` ON `entry` (`food_id`);--> statement-breakpoint
UPDATE `entry`
SET `category` = (
  SELECT `c`.`category`
  FROM `food_classification` `c`
  WHERE `c`.`food_id` = `entry`.`food_id`
    AND (`c`.`user_id` IS NULL OR `c`.`user_id` = `m`.`user_id`)
    AND (
      (
        `c`.`source` = 'user'
        AND `c`.`user_id` = `m`.`user_id`
        AND NOT EXISTS (
          SELECT 1
          FROM `food_classification_withdrawal` `w`
          WHERE `w`.`food_id` = `c`.`food_id`
            AND `w`.`user_id` = `m`.`user_id`
            AND `w`.`created_at` >= `c`.`created_at`
        )
      )
      OR `c`.`source` IN ('ai_text', 'ai_vision')
      OR `c`.`source` = 'seed'
    )
  ORDER BY
    CASE `c`.`source` WHEN 'user' THEN 0 WHEN 'seed' THEN 2 ELSE 1 END,
    `c`.`created_at` DESC,
    `c`.`id` DESC
  LIMIT 1
)
FROM `meal` `m`
WHERE `m`.`id` = `entry`.`meal_id` AND `entry`.`food_id` IS NOT NULL;
