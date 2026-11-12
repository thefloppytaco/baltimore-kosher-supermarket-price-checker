ALTER TABLE `catalog_sections` ADD COLUMN `attempts` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `catalog_sections` ADD COLUMN `last_error` text;
--> statement-breakpoint
ALTER TABLE `catalog_sync` ADD COLUMN `last_kick_at` integer;
