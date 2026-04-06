CREATE TABLE "dns_provider_groups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"ns_hostnames" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_servers" ADD COLUMN "group_id" varchar(36);--> statement-breakpoint
ALTER TABLE "dns_servers" ADD COLUMN "role" varchar(20) DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dns_group_id" varchar(36);