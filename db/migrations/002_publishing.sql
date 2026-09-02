-- Publishing.
--
-- Three additions: multi-file parts (so `include <>` can resolve against files
-- published alongside the source), a pointer to the canonical default build that
-- proved a version compiles, and a minimal ownership token so a handle cannot be
-- published to by anyone who knows its name.

-- Files published with the part, keyed by relative filename. The entry source
-- stays in part_versions.source; this holds everything it includes.
ALTER TABLE part_versions
    ADD COLUMN files JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The build that satisfied the publish gate. Nullable and set after insert,
-- because a build row references the version it belongs to.
ALTER TABLE part_versions
    ADD COLUMN default_build_hash TEXT REFERENCES builds(build_hash) ON DELETE SET NULL;

-- Minimal ownership. This is deliberately not an account system: no email, no
-- password, no recovery. It exists so that publishing to a handle requires
-- holding the token minted when that handle was claimed, and it should be
-- replaced before anything is exposed publicly.
ALTER TABLE users
    ADD COLUMN publish_token_hash TEXT;

CREATE INDEX users_publish_token ON users (publish_token_hash)
    WHERE publish_token_hash IS NOT NULL;
