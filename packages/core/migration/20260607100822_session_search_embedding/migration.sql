CREATE TABLE `session_search_embedding` (
	`fingerprint` text PRIMARY KEY,
	`vector` blob NOT NULL,
	`dimensions` integer NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_accessed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_embedding_lru` ON `session_search_embedding` (`model`,`last_accessed_at`);