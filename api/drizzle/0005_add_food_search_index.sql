CREATE INDEX `meal_item_food_idx` ON `meal_item` (`food_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `food_search` USING fts5(
  food_id UNINDEXED,
  name,
  tokenize='trigram'
);--> statement-breakpoint
INSERT INTO `food_search`(rowid, food_id, name) SELECT rowid, id, name FROM `food`;--> statement-breakpoint
CREATE TRIGGER `food_search_after_insert` AFTER INSERT ON `food` BEGIN
  INSERT INTO `food_search`(rowid, food_id, name) VALUES (new.rowid, new.id, new.name);
END;--> statement-breakpoint
CREATE TRIGGER `food_search_after_delete` AFTER DELETE ON `food` BEGIN
  DELETE FROM `food_search` WHERE rowid = old.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `food_search_after_rename` AFTER UPDATE OF `name` ON `food` BEGIN
  DELETE FROM `food_search` WHERE rowid = old.rowid;
  INSERT INTO `food_search`(rowid, food_id, name) VALUES (new.rowid, new.id, new.name);
END;
