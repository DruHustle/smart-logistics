-- Old Portal-backed rows retain their issuer on users.onesa_issuer.
ALTER TABLE auth_sessions ADD COLUMN onesa_token_issuer text;
