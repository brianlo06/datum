-- Datum initial schema.
--
-- The object model follows the product brief: a Part is parametric source plus a
-- typed schema plus declared mechanical interfaces; a Build is a compiled,
-- measured instance of one version at one parameter set; a Made report is
-- evidence that a build was actually fabricated. Interfaces are modelled as
-- first-class rows because they are the intended dependency graph, not tags.

CREATE TABLE users (
    id           BIGSERIAL PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
    display_name TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE parts (
    id         BIGSERIAL PRIMARY KEY,
    owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
    title      TEXT NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    -- Licence is mandatory at publish time and chosen from a curated list;
    -- the brief is explicit that this is never a free-text field.
    license    TEXT NOT NULL,
    -- Fork ancestry. Structural, so attribution cannot be edited away.
    forked_from BIGINT REFERENCES parts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, slug)
);

CREATE TABLE part_versions (
    id           BIGSERIAL PRIMARY KEY,
    part_id      BIGINT NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
    -- Fit-based semver: major = mating surfaces moved, minor = new capability
    -- that still fits, patch = fix with no interface change.
    version      TEXT NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
    source       TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    -- The parsed Customizer schema, cached so the configurator never re-parses.
    schema       JSONB NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (part_id, version)
);

CREATE INDEX part_versions_part_created ON part_versions (part_id, created_at DESC);

-- A build is identified by hash(source_hash, parameters): the same inputs must
-- always yield the same geometry, which is what makes this table a cache.
CREATE TABLE builds (
    build_hash      TEXT PRIMARY KEY,
    part_version_id BIGINT NOT NULL REFERENCES part_versions(id) ON DELETE CASCADE,
    params          JSONB NOT NULL,
    ok              BOOLEAN NOT NULL,
    summary         TEXT NOT NULL,
    diagnostics     JSONB NOT NULL DEFAULT '[]'::jsonb,
    metrics         JSONB,
    stl_path        TEXT,
    png_path        TEXT,
    duration_ms     INTEGER NOT NULL DEFAULT 0,
    -- True when the requester changed at least one parameter from its default.
    -- This is the single number the landing-page experiment turns on, so it is
    -- recorded on the build rather than inferred from logs later.
    configured      BOOLEAN NOT NULL DEFAULT FALSE,
    download_count  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX builds_version_created ON builds (part_version_id, created_at DESC);
CREATE INDEX builds_configured ON builds (configured, created_at DESC);

-- The interface vocabulary: the intended network effect. A part declares what it
-- mates with, so parts become searchable by fit rather than by keyword.
CREATE TABLE interfaces (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9./-]{1,63}$'),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE part_interfaces (
    part_version_id BIGINT NOT NULL REFERENCES part_versions(id) ON DELETE CASCADE,
    interface_id    BIGINT NOT NULL REFERENCES interfaces(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('implements', 'consumes')),
    PRIMARY KEY (part_version_id, interface_id, role)
);

CREATE INDEX part_interfaces_lookup ON part_interfaces (interface_id, role);

-- Proof of fabrication. The high-information signal from the brief: not a star,
-- but "I made this, on this machine, and here is whether it fitted."
CREATE TABLE made_reports (
    id          BIGSERIAL PRIMARY KEY,
    build_hash  TEXT NOT NULL REFERENCES builds(build_hash) ON DELETE CASCADE,
    user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    machine     TEXT NOT NULL,
    material    TEXT NOT NULL,
    fitted      BOOLEAN NOT NULL,
    notes       TEXT NOT NULL DEFAULT '',
    photo_path  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX made_reports_build ON made_reports (build_hash, created_at DESC);
