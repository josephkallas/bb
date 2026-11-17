PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sweep_item_failures` (
	`sweep` text NOT NULL,
	`item_key` text NOT NULL,
	`attempts` integer NOT NULL,
	`first_failed_at` integer NOT NULL,
	`retry_at` integer,
	`last_error` text NOT NULL,
	PRIMARY KEY(`sweep`, `item_key`)
);
--> statement-breakpoint
INSERT INTO `__new_sweep_item_failures`("sweep", "item_key", "attempts", "first_failed_at", "retry_at", "last_error") SELECT "sweep", "item_key", "attempts", "first_failed_at", "retry_at", "last_error" FROM `sweep_item_failures`;--> statement-breakpoint
DROP TABLE `sweep_item_failures`;--> statement-breakpoint
ALTER TABLE `__new_sweep_item_failures` RENAME TO `sweep_item_failures`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `hosts` DROP COLUMN `suspend_retry_at`;