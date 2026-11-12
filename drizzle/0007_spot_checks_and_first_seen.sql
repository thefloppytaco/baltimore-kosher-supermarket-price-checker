ALTER TABLE `catalog_products` ADD COLUMN `first_seen_at` integer;
--> statement-breakpoint
UPDATE `catalog_products` SET `first_seen_at` = `last_seen_at` - 2592000000 WHERE `first_seen_at` IS NULL;
--> statement-breakpoint
CREATE TABLE `spot_checks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `store` text DEFAULT 'maven' NOT NULL,
  `product_name` text NOT NULL,
  `external_id` text,
  `catalog_price` real NOT NULL,
  `live_price` real,
  `catalog_on_sale` integer DEFAULT 0 NOT NULL,
  `live_on_sale` integer,
  `result` text NOT NULL,
  `checked_at` integer NOT NULL
);
