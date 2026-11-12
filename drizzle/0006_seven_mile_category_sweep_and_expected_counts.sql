ALTER TABLE `catalog_sections` ADD COLUMN `expected_count` integer;
--> statement-breakpoint
CREATE TABLE `catalog_section_products` (
	`section_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	PRIMARY KEY (`section_id`, `product_id`)
);
--> statement-breakpoint
CREATE INDEX `section_products_product_idx` ON `catalog_section_products` (`product_id`);
--> statement-breakpoint
UPDATE `catalog_sections` SET `status` = 'pending', `attempts` = 0, `last_error` = 'Re-queued: the first sweep capped sections at 40 products, so every finished section is being re-swept in full.' WHERE `store` = 'seven' AND `status` = 'done';
