CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "bulk_run_batches" ALTER COLUMN "selection_snapshot" SET DEFAULT '{"kind":"all_rows","searchQuery":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "cells" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE FUNCTION byok_grid_private.canonical_cell_search_text(
  value_type public.cell_value_type,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_timestamp timestamp with time zone,
  value_json jsonb
) RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT left(
    CASE value_type
      WHEN 'text' THEN coalesce(value_text, '')
      WHEN 'number' THEN coalesce(value_number::text, '')
      WHEN 'boolean' THEN CASE
        WHEN value_boolean IS TRUE THEN 'true'
        WHEN value_boolean IS FALSE THEN 'false'
        ELSE ''
      END
      WHEN 'timestamp' THEN coalesce(
        to_char(value_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        ''
      )
      WHEN 'json' THEN coalesce(value_json::text, '')
      ELSE ''
    END,
    8192
  )
$$;--> statement-breakpoint
CREATE FUNCTION byok_grid_private.refresh_cell_search_text()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.search_text := byok_grid_private.canonical_cell_search_text(
    NEW.value_type,
    NEW.value_text,
    NEW.value_number,
    NEW.value_boolean,
    NEW.value_timestamp,
    NEW.value_json
  );
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER cells_refresh_search_text
BEFORE INSERT OR UPDATE OF value_type, value_text, value_number, value_boolean, value_timestamp, value_json
ON cells
FOR EACH ROW
EXECUTE FUNCTION byok_grid_private.refresh_cell_search_text();--> statement-breakpoint
UPDATE cells
SET search_text = byok_grid_private.canonical_cell_search_text(
  value_type,
  value_text,
  value_number,
  value_boolean,
  value_timestamp,
  value_json
);--> statement-breakpoint
CREATE INDEX "cells_search_text_trgm_idx" ON "cells" USING gin ("search_text" gin_trgm_ops) WHERE "cells"."search_text" <> '';
