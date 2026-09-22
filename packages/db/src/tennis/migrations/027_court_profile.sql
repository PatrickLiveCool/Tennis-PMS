ALTER TABLE tennis.courts DROP CONSTRAINT courts_surface_check;
ALTER TABLE tennis.courts ADD CONSTRAINT courts_surface_check CHECK (surface IN (
  'UNSPECIFIED','ACRYLIC','CUSHIONED_ACRYLIC','CLAY','ARTIFICIAL_CLAY','GRASS','ARTIFICIAL_GRASS',
  'POLYURETHANE','RUBBER','CARPET','ASPHALT','CONCRETE','TILE','OTHER'
));
ALTER TABLE tennis.courts ADD COLUMN covered boolean NOT NULL DEFAULT false;
ALTER TABLE tennis.courts ADD CONSTRAINT courts_cover_check CHECK (NOT (indoor AND covered));
ALTER TABLE tennis.courts ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile)='object');
