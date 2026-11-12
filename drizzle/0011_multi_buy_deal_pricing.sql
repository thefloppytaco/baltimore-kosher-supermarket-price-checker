ALTER TABLE `catalog_products` ADD COLUMN `deal_text` text;
--> statement-breakpoint
ALTER TABLE `catalog_products` ADD COLUMN `deal_qty` integer;
--> statement-breakpoint
ALTER TABLE `catalog_products` ADD COLUMN `deal_total` real;
--> statement-breakpoint
ALTER TABLE `catalog_products` ADD COLUMN `regular_price` real;
--> statement-breakpoint
ALTER TABLE `cart_items` ADD COLUMN `deal_text` text;
--> statement-breakpoint
ALTER TABLE `cart_items` ADD COLUMN `deal_qty` integer;
--> statement-breakpoint
ALTER TABLE `cart_items` ADD COLUMN `deal_total` real;
--> statement-breakpoint
ALTER TABLE `cart_items` ADD COLUMN `regular_price` real;
