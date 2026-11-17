-- Preserve existing locally assigned Logistics roles, including explicit demotions.
ALTER TABLE users
  ADD COLUMN identity_managed_role varchar(50),
  ADD COLUMN identity_role_issued_at bigint,
  ADD CONSTRAINT valid_identity_role_source CHECK (
    (identity_managed_role IS NULL AND identity_role_issued_at IS NULL) OR
    (identity_managed_role IS NOT NULL AND identity_managed_role IN ('user','admin')
     AND identity_managed_role = role AND identity_role_issued_at IS NOT NULL
     AND identity_role_issued_at > 0 AND onesa_subject IS NOT NULL)
  );

-- A local role assignment takes ownership, even if an operator reassigns the same role.
CREATE FUNCTION preserve_logistics_role_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity_managed_role IS NOT DISTINCT FROM OLD.identity_managed_role
     AND NEW.identity_role_issued_at IS NOT DISTINCT FROM OLD.identity_role_issued_at THEN
    NEW.identity_managed_role := NULL;
    NEW.identity_role_issued_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER logistics_role_assignment BEFORE UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION preserve_logistics_role_assignment();
