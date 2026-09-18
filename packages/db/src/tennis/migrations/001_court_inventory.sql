CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA tennis;

CREATE TABLE tennis.courts (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  venue_id text NOT NULL CHECK (length(btrim(venue_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0)
);

CREATE TABLE tennis.occupancies (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  court_id text NOT NULL REFERENCES tennis.courts(id),
  kind text NOT NULL CHECK (kind IN ('BOOKING', 'COURSE', 'MAINTENANCE')),
  source_id text NOT NULL CHECK (length(btrim(source_id)) > 0),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (isfinite(start_at) AND isfinite(end_at) AND end_at > start_at),
  CHECK (date_trunc('minute', start_at) = start_at AND date_trunc('minute', end_at) = end_at),
  CONSTRAINT court_occupancy_no_overlap EXCLUDE USING gist (
    court_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (released_at IS NULL)
);
