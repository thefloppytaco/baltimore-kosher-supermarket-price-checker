CREATE TABLE `barcode_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`barcode` text NOT NULL,
	`product_name` text NOT NULL,
	`brand` text,
	`quantity_text` text,
	`image_url` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`last_seen_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `barcode_mappings_barcode_unique` ON `barcode_mappings` (`barcode`);
