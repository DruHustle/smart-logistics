-- External carrier services are not considered accepted merely because a connector is enabled.
-- An operator must record provider acceptance through a controlled database change after evidence review.
ALTER TABLE logistics_connectors
  ADD COLUMN provider_accepted_at timestamptz;
