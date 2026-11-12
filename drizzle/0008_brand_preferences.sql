CREATE TABLE `brand_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`keyword` text NOT NULL,
	`brand` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_preferences_keyword_brand_idx` ON `brand_preferences` (`keyword`, `brand`);
