CREATE TABLE `cart_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store` text NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`price` real NOT NULL,
	`category` text,
	`qty` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_store_name_idx` ON `cart_items` (`store`, `name_norm`);
