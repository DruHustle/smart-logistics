import { Response } from "express";
import { z } from "zod";
import { AuthRequest } from "../middleware/auth";
import { connection } from "../config/db";
export const operatorShipmentInput = z
  .object({
    trackingNumber: z.string().trim().min(1).max(100),
    origin: z.string().trim().min(1).max(255),
    destination: z.string().trim().min(1).max(255),
    provider: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
const localSource = "workspace-operator";
export async function shipmentProviders(req: AuthRequest, res: Response) {
  const rows = await connection.query(
    "SELECT provider FROM logistics_connectors WHERE workspace_id=$1 AND enabled AND provider_accepted_at IS NOT NULL AND provider<>$2 ORDER BY provider",
    [req.user!.workspaceId, localSource],
  );
  res.json({ providers: rows.rows.map((r) => r.provider) });
}
export async function createOperatorShipment(req: AuthRequest, res: Response) {
  const key = z.string().uuid().safeParse(req.header("Idempotency-Key"));
  if (!key.success)
    return res
      .status(400)
      .json({ error: "A stable shipment creation reference is required" });
  const input = operatorShipmentInput.parse(req.body),
    who = req.user!,
    workspace = who.workspaceId!,
    provider = input.provider ?? localSource;
  const eventId = "operator-create:" + key.data;
  const tx = await connection.connect();
  try {
    await tx.query("BEGIN");
    const stop = async (status: number, error: string) => {
      await tx.query("ROLLBACK");
      return res.status(status).json({ error });
    };
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      workspace + ":" + eventId,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      workspace + ":" + provider + ":" + input.trackingNumber,
    ]);
    const prior = (
      await tx.query(
        "SELECT e.payload,s.id FROM logistics_events e JOIN shipments s ON s.workspace_id=e.workspace_id AND s.provider=e.provider AND s.tracking_number=e.tracking_number WHERE e.workspace_id=$1 AND e.event_id=$2",
        [workspace, eventId],
      )
    ).rows[0];
    if (prior) {
      const old = JSON.parse(prior.payload);
      if (
        old.operatorId !== who.id ||
        JSON.stringify(old.entered) !== JSON.stringify(input)
      )
        return await stop(
          409,
          "Creation reference was used for different shipment details",
        );
      await tx.query("COMMIT");
      return res.json({ id: prior.id, duplicate: true });
    }
    if (
      input.provider &&
      (input.provider === localSource ||
        !(
          await tx.query(
            "SELECT 1 FROM logistics_connectors WHERE workspace_id=$1 AND provider=$2 AND enabled AND provider_accepted_at IS NOT NULL FOR SHARE",
            [workspace, provider],
          )
        ).rowCount)
    )
      return await stop(
        404,
        "Carrier connector is unavailable in this workspace",
      );
    if (
      (
        await tx.query(
          "SELECT id FROM shipments WHERE workspace_id=$1 AND provider=$2 AND tracking_number=$3",
          [workspace, provider, input.trackingNumber],
        )
      ).rowCount
    )
      return await stop(
        409,
        "A shipment with this tracking reference already exists for this source",
      );
    const observedAt = new Date().toISOString();
    const event = {
      eventId,
      eventType: "shipment.created",
      trackingNumber: input.trackingNumber,
      origin: input.origin,
      destination: input.destination,
      status: "pending",
      occurredAt: observedAt,
      operatorId: who.id,
      entered: input,
    };
    const eventRow = (
      await tx.query(
        "INSERT INTO logistics_events(workspace_id,provider,event_id,tracking_number,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,received_at",
        [
          workspace,
          provider,
          eventId,
          input.trackingNumber,
          event.eventType,
          JSON.stringify(event),
          observedAt,
        ],
      )
    ).rows[0];
    const provenance = {
      origin: eventRow.id,
      destination: eventRow.id,
      status: eventRow.id,
    };
    const row = (
      await tx.query(
        "INSERT INTO shipments(workspace_id,provider,tracking_number,origin,destination,status,snapshot_event_id,observed_at,received_at,projection_version,projection_provenance) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,2,$9) RETURNING id",
        [
          workspace,
          provider,
          input.trackingNumber,
          input.origin,
          input.destination,
          eventRow.id,
          observedAt,
          eventRow.received_at,
          provenance,
        ],
      )
    ).rows[0];
    await tx.query("COMMIT");
    res.status(201).json({ id: row.id, duplicate: false });
  } catch {
    await tx.query("ROLLBACK");
    res
      .status(503)
      .json({
        error:
          "Shipment creation could not be confirmed; retry the saved request.",
      });
  } finally {
    tx.release();
  }
}
