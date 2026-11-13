ALTER TABLE `catalog_sections` ADD COLUMN `department` text;--> statement-breakpoint
ALTER TABLE `catalog_sections` ADD COLUMN `path` text;--> statement-breakpoint
ALTER TABLE `catalog_sections` ADD COLUMN `aisle` text;--> statement-breakpoint
ALTER TABLE `catalog_sections` ADD COLUMN `hidden` integer DEFAULT 0 NOT NULL;
