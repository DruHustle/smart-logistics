ALTER TABLE users ADD COLUMN onesa_issuer text, ADD COLUMN onesa_subject uuid,
  ADD CONSTRAINT users_onesa_identity UNIQUE (onesa_issuer, onesa_subject),
  ADD CONSTRAINT users_onesa_identity_pair CHECK ((onesa_issuer IS NULL) = (onesa_subject IS NULL));
ALTER TABLE auth_sessions ADD COLUMN onesa_token text;
CREATE TABLE onesa_login_transactions (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL, verifier text NOT NULL,
  link_user_id integer REFERENCES users(id) ON DELETE CASCADE, link_version integer,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE INDEX onesa_login_expiry ON onesa_login_transactions(expires_at);
