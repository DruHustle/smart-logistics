import test from "node:test";
import assert from "node:assert/strict";
import { prepareReceipt, postReceipt } from "../src/receipt";
const line = {
  id: "line-one",
  productId: "part",
  quantity: 5,
  receivedQuantity: 2,
};
const create = (n: string) =>
  prepareReceipt(
    "order",
    line,
    "warehouse",
    n,
    " Dock 7 ",
    "stable-key",
    "2026-11-14T15:00:00.000Z"
  );
test("receiving rejects a fractional or excess quantity", () => {
  for (const n of ["4", "1.5", "0", "-1", ""]) assert.throws(() => create(n));
});
test("replaying a persisted receipt sends the exact original content and idempotency key", async () => {
  const receipt = create("3"),
    requests: unknown[][] = [];
  await assert.rejects(
    postReceipt(receipt, async (...args) => {
      requests.push(args);
      throw Error("lost response");
    })
  );
  const id = await postReceipt(
    JSON.parse(JSON.stringify(receipt)),
    async (...args) => {
      requests.push(args);
      return { receiptId: "saved" };
    }
  );
  assert.equal(id, "saved");
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[0], [
    "/supply-chain/api/v1/orders/order/receipts",
    {
      warehouseId: "warehouse",
      receivedAt: "2026-11-14T15:00:00.000Z",
      note: "Dock 7",
      items: [{ itemId: "line-one", quantity: 3 }],
    },
    "stable-key",
  ]);
});
