ALTER TABLE `catalog_sections` ADD COLUMN `batch_id` text;--> statement-breakpoint
ALTER TABLE `catalog_sections` ADD COLUMN `claimed_at` integer;--> statement-breakpoint
CREATE INDEX `catalog_sections_batch_idx` ON `catalog_sections` (`batch_id`, `status`);
