-- 0006: external sign-in identities (Google, Microsoft, GitHub) per member.
-- One identity per provider per member; a provider account maps to one member.
-- users.google_sub is copied here and no longer read or written (kept so an
-- older Worker version can still be rolled back to).
CREATE TABLE user_identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'github', 'dev')),
  subject    TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email      TEXT,             -- as reported by the provider (informational)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX user_identities_user_provider_uq ON user_identities (user_id, provider);

INSERT INTO user_identities (provider, subject, user_id, email, created_at)
SELECT CASE WHEN google_sub LIKE 'dev:%' THEN 'dev' ELSE 'google' END, google_sub, id, email, created_at
FROM users WHERE google_sub IS NOT NULL;

-- Which provider a pending sign-in belongs to, and (for "connect a sign-in
-- method" from the account page) which signed-in member it links to.
ALTER TABLE oauth_states ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
ALTER TABLE oauth_states ADD COLUMN link_user_id TEXT;
