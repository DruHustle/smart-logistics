CREATE TABLE shipment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  shipment_id integer NOT NULL REFERENCES shipments(id),
  provider varchar(100) NOT NULL,
  reference varchar(120) NOT NULL,
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  valid_through date,
  recorded_by integer NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, request_id),
  UNIQUE (workspace_id, shipment_id, provider, reference),
  UNIQUE (workspace_id, shipment_id, id)
);
CREATE INDEX shipment_quotes_by_shipment ON shipment_quotes (workspace_id, shipment_id, recorded_at DESC, id DESC);

CREATE TABLE shipment_quote_selections (
  workspace_id uuid NOT NULL,
  shipment_id integer NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  quote_id uuid NOT NULL,
  selected_by integer NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, shipment_id, version),
  UNIQUE (workspace_id, request_id),
  FOREIGN KEY (workspace_id, shipment_id, quote_id) REFERENCES shipment_quotes(workspace_id, shipment_id, id)
);
