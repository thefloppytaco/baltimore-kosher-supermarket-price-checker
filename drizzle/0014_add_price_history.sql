CREATE TABLE `price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`store` text NOT NULL,
	`price` real NOT NULL,
	`on_sale` integer DEFAULT 0 NOT NULL,
	`deal_text` text,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `price_history_product_idx` ON `price_history` (`product_id`, `observed_at`);
