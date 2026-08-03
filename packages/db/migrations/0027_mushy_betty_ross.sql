ALTER TABLE "saved_grid_views" DROP CONSTRAINT "saved_grid_views_filter_shape";--> statement-breakpoint
ALTER TABLE "saved_grid_views" ALTER COLUMN "filters" SET DEFAULT '{"children":[],"combinator":"and"}'::jsonb;--> statement-breakpoint
UPDATE "saved_grid_views"
SET "filters" = jsonb_build_object('children', "filters", 'combinator', 'and')
WHERE jsonb_typeof("filters") = 'array';--> statement-breakpoint
ALTER TABLE "saved_grid_views" ADD CONSTRAINT "saved_grid_views_filter_shape" CHECK (jsonb_typeof("saved_grid_views"."filters") = 'object' and "saved_grid_views"."filters" ? 'combinator' and jsonb_typeof("saved_grid_views"."filters"->'children') = 'array');
