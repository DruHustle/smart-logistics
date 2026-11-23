import { Response } from "express";
import { z } from "zod";
import { connection } from "../config/db";
import { AuthRequest } from "../middleware/auth";
import { numericId } from "./operationalReads";

const pageSize = 25;
const closedStatuses = new Set(["canceled", "cancelled", "delivered"]);
export const shipmentQuoteInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record"),
    provider: z.string().trim().min(1).max(100),
    reference: z.string().trim().min(1).max(120),
    amount: z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/)
      .refine(amount => /[1-9]/.test(amount), { message: "Enter a positive amount." }),
    currency: z.string().regex(/^[A-Z]{3}$/),
    validThrough: z.iso.date().nullable(),
  }).strict(),
  z.object({
    action: z.literal("select"),
    quoteId: z.uuid(),
    expectedVersion: z.number().int().nonnegative().max(2147483646),
  }).strict(),
]);

export async function getShipmentQuotes(req: AuthRequest, res: Response) {
  const shipmentId = numericId(req.params.id);
  const offset = req.query.offset ?? "0";
  if (!shipmentId || typeof offset !== "string" || !/^\d{1,7}$/.test(offset))
    return res.status(400).json({ error: "Invalid shipment or quote page." });
  const workspace = req.user!.workspaceId;
  const { rows: [shipment] } = await connection.query(
    `SELECT s.status, a.version, a.quote_id AS "selectedQuoteId"
     FROM shipments s LEFT JOIN LATERAL (
       SELECT version,quote_id FROM shipment_quote_selections
       WHERE workspace_id=s.workspace_id AND shipment_id=s.id ORDER BY version DESC LIMIT 1
     ) a ON true WHERE s.workspace_id=$1 AND s.id=$2`,
    [workspace, shipmentId],
  );
  if (!shipment) return res.status(404).json({ error: "Shipment not found." });
  const pageOffset = Number(offset);
  const { rows: items } = await connection.query(
    `SELECT id, provider, reference, amount::text, currency, valid_through::text AS "validThrough",
       (valid_through < (now() at time zone 'UTC')::date) IS TRUE AS expired,
       recorded_at AS "recordedAt"
     FROM shipment_quotes WHERE workspace_id=$1 AND shipment_id=$2
     ORDER BY recorded_at DESC,id DESC LIMIT $3 OFFSET $4`,
    [workspace, shipmentId, pageSize + 1, pageOffset],
  );
  return res.json({
    items: items.slice(0, pageSize),
    editable: !closedStatuses.has(String(shipment.status).toLowerCase()),
    version: shipment.version ?? 0,
    selectedQuoteId: shipment.selectedQuoteId,
    previousOffset: pageOffset ? Math.max(0, pageOffset - pageSize) : null,
    nextOffset: items.length > pageSize ? pageOffset + pageSize : null,
  });
}

export async function saveShipmentQuote(req: AuthRequest, res: Response) {
  const shipmentId = numericId(req.params.id);
  const key = z.uuid().safeParse(req.header("Idempotency-Key"));
  if (!shipmentId || !key.success)
    return res.status(400).json({ error: "A valid shipment and quote request reference are required." });
  const input = shipmentQuoteInput.parse(req.body);
  const user = req.user!;
  const workspace = user.workspaceId;
  const tx = await connection.connect();
  try {
    await tx.query("BEGIN");
    const stop = async (status: number, error: string) => {
      await tx.query("ROLLBACK");
      return res.status(status).json({ error });
    };
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${workspace}:shipment-quote:${input.action}:${key.data}`,
    ]);
    const { rows: [shipment] } = await tx.query(
      "SELECT status FROM shipments WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspace, shipmentId],
    );
    if (!shipment) return await stop(404, "Shipment not found.");
    const closed = closedStatuses.has(String(shipment.status).toLowerCase());

    if (input.action === "record") {
      const { amount, currency, provider, reference, validThrough } = input;
      const { rows: [prior] } = await tx.query(
        `SELECT id, shipment_id=$3 AND recorded_by=$4 AND provider=$5 AND reference=$6 AND currency=$7
          AND amount=$8::numeric AND valid_through IS NOT DISTINCT FROM $9::date AS matches
         FROM shipment_quotes WHERE workspace_id=$1 AND request_id=$2`,
        [workspace, key.data, shipmentId, user.id, provider, reference, currency, amount, validThrough],
      );
      if (prior) {
        if (!prior.matches) return await stop(409, "That request reference was used for a different quote.");
        await tx.query("COMMIT");
        return res.json({ quoteId: prior.id, duplicate: true });
      }
      if (closed) return await stop(409, "Quotes are closed for this shipment.");
      const { rows: [created] } = await tx.query(
        `INSERT INTO shipment_quotes (workspace_id,shipment_id,recorded_by,provider,reference,currency,amount,valid_through,request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id,shipment_id,provider,reference) DO NOTHING RETURNING id`,
        [workspace, shipmentId, user.id, provider, reference, currency, amount, validThrough, key.data],
      );
      if (!created) return await stop(409, "This provider quote reference is already recorded for the shipment.");
      await tx.query("COMMIT");
      return res.status(201).json({ quoteId: created.id, duplicate: false });
    }

    const { quoteId, expectedVersion } = input;
    const { rows: [prior] } = await tx.query(
      `SELECT shipment_id, quote_id, version, selected_by FROM shipment_quote_selections
       WHERE workspace_id=$1 AND request_id=$2`, [workspace, key.data],
    );
    if (prior) {
      if (prior.shipment_id !== shipmentId || prior.quote_id !== quoteId ||
          prior.version !== expectedVersion + 1 || prior.selected_by !== user.id)
        return await stop(409, "That request reference was used for a different selection.");
      await tx.query("COMMIT");
      return res.json({ quoteId, version: prior.version, duplicate: true });
    }
    if (closed) return await stop(409, "Quotes are closed for this shipment.");
    const { rows: [current] } = await tx.query(
      `SELECT version FROM shipment_quote_selections WHERE workspace_id=$1 AND shipment_id=$2
       ORDER BY version DESC LIMIT 1`, [workspace, shipmentId],
    );
    if ((current?.version ?? 0) !== expectedVersion)
      return await stop(409, "The quote selection changed. Reload the quotes before saving.");
    const { rows: [quote] } = await tx.query(
      `SELECT (valid_through < (now() at time zone 'UTC')::date) IS TRUE AS expired
       FROM shipment_quotes WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,
      [workspace, shipmentId, quoteId],
    );
    if (!quote) return await stop(404, "Quote not found.");
    if (quote.expired) return await stop(409, "This quote has expired.");
    const version = expectedVersion + 1;
    await tx.query(
      `INSERT INTO shipment_quote_selections (workspace_id,shipment_id,version,quote_id,selected_by,request_id)
       VALUES ($1,$2,$3,$4,$5,$6)`, [workspace, shipmentId, version, quoteId, user.id, key.data],
    );
    await tx.query("COMMIT");
    return res.json({ quoteId, version, duplicate: false });
  } catch {
    await tx.query("ROLLBACK");
    return res.status(503).json({ error: "The quote change could not be confirmed. Retry the saved request." });
  } finally {
    tx.release();
  }
}
