CREATE TABLE `catalog_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`category` text,
	`price` real NOT NULL,
	`price_text` text,
	`on_sale` integer DEFAULT 0 NOT NULL,
	`image_url` text,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_store_idx` ON `catalog_products` (`store`);
--> statement-breakpoint
CREATE INDEX `catalog_name_norm_idx` ON `catalog_products` (`name_norm`);
--> statement-breakpoint
CREATE TABLE `catalog_sync` (
	`store` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'none' NOT NULL,
	`product_count` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `catalog_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`term` text NOT NULL,
	`kind` text DEFAULT 'search' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`product_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer
);
