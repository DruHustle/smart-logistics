import { Response } from "express";
import { z } from "zod";
import { connection } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { numericId } from "./operationalReads";

const pageSize = 25;
const finishedStatuses = new Set(["canceled", "cancelled", "delivered"]);
export const shipmentDriverInput = z.object({
  driverId: z.number().int().positive().max(2147483647).nullable(),
  expectedVersion: z.number().int().nonnegative().max(2147483646),
}).strict();

export async function shipmentDriver(req: AuthRequest, res: Response) {
  const id = numericId(req.params.id);
  const offset = req.query.offset ?? "0";
  if (!id || typeof offset !== "string" || !/^\d{1,7}$/.test(offset)) {
    return res.status(400).json({ error: "Invalid shipment or driver page." });
  }
  const workspace = req.user!.workspaceId;
  const pageOffset = Number(offset);
  const { rows: [assignment] } = await connection.query(
    `SELECT coalesce(a.version,0) AS version, s.status,
      u.id AS "driverId", u.name AS "driverName", a.recorded_at AS "recordedAt",
      (a.driver_id IS NOT NULL AND u.id IS NULL) AS "driverUnavailable"
    FROM shipments s
    LEFT JOIN LATERAL (
      SELECT version,driver_id,recorded_at FROM shipment_driver_assignments
      WHERE workspace_id=s.workspace_id AND shipment_id=s.id
      ORDER BY version DESC LIMIT 1
    ) a ON true
    LEFT JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=a.driver_id
    LEFT JOIN users u ON u.id=m.user_id AND NOT u.disabled
    WHERE s.id=$1 AND s.workspace_id=$2`,
    [id, workspace],
  );
  if (!assignment) return res.status(404).json({ error: "Shipment not found." });
  const editable = !finishedStatuses.has(String(assignment.status).toLowerCase());
  const candidates = editable ? (
    await connection.query(
      `SELECT u.id,u.name FROM workspace_memberships m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 AND NOT u.disabled
      ORDER BY u.name,u.id LIMIT $2 OFFSET $3`,
      [workspace, pageSize + 1, pageOffset],
    )
  ).rows : [];
  const { status: _status, ...current } = assignment;
  return res.json({
    assignment: current,
    editable,
    candidates: candidates.slice(0, pageSize),
    previousOffset: pageOffset ? Math.max(0, pageOffset - pageSize) : null,
    nextOffset: candidates.length > pageSize ? pageOffset + pageSize : null,
  });
}

export async function assignShipmentDriver(req: AuthRequest, res: Response) {
  const id = numericId(req.params.id);
  const key = z.uuid().safeParse(req.header("Idempotency-Key"));
  if (!id || !key.success)
    return res.status(400).json({ error: "A valid shipment and assignment request reference are required." });
  const user = req.user!;
  const { driverId, expectedVersion } = shipmentDriverInput.parse(req.body);
  const tx = await connection.connect();
  try {
    await tx.query("BEGIN");
    const stop = async (status: number, error: string) => {
      await tx.query("ROLLBACK");
      return res.status(status).json({ error });
    };
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${user.workspaceId}:shipment-driver:${key.data}`,
    ]);
    const { rows: [shipment] } = await tx.query(
      "SELECT status FROM shipments WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
      [id, user.workspaceId],
    );
    if (!shipment) return await stop(404, "Shipment not found.");
    const { rows: [prior] } = await tx.query(
      `SELECT shipment_id,version,driver_id,assigned_by FROM shipment_driver_assignments
      WHERE workspace_id=$1 AND request_id=$2`,
      [user.workspaceId, key.data],
    );
    if (prior) {
      if (prior.shipment_id !== id || prior.version !== expectedVersion + 1 ||
          prior.driver_id !== driverId || prior.assigned_by !== user.id)
        return await stop(409, "This request reference was used for a different assignment.");
      await tx.query("COMMIT");
      return res.json({ version: prior.version, duplicate: true });
    }
    if (finishedStatuses.has(String(shipment.status).toLowerCase()))
      return await stop(409, "A completed or cancelled shipment cannot be reassigned.");
    const { rows: [current] } = await tx.query(
      `SELECT version FROM shipment_driver_assignments
      WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY version DESC LIMIT 1`,
      [user.workspaceId, id],
    );
    if ((current?.version ?? 0) !== expectedVersion)
      return await stop(409, "The assignment changed. Reload it before saving.");
    if (driverId !== null) {
      const allowed = await tx.query(
        `SELECT 1 FROM workspace_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=$1 AND m.user_id=$2 AND NOT u.disabled FOR SHARE OF m,u`,
        [user.workspaceId, driverId],
      );
      if (!allowed.rowCount) return await stop(400, "Choose an active member of this workspace.");
    }
    const version = expectedVersion + 1;
    await tx.query(
      `INSERT INTO shipment_driver_assignments
        (workspace_id,shipment_id,version,driver_id,assigned_by,request_id)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [user.workspaceId, id, version, driverId, user.id, key.data],
    );
    await tx.query("COMMIT");
    return res.json({ version, duplicate: false });
  } catch {
    await tx.query("ROLLBACK");
    return res.status(503).json({ error: "Assignment could not be confirmed. Retry the saved request." });
  } finally {
    tx.release();
  }
}
