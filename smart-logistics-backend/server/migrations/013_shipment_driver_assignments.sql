CREATE TABLE shipment_driver_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  shipment_id integer NOT NULL REFERENCES shipments(id),
  version integer NOT NULL CHECK (version > 0),
  driver_id integer REFERENCES users(id),
  assigned_by integer NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, shipment_id, version),
  UNIQUE (workspace_id, request_id)
);
