export const purchaseOrders = "/supply-chain/api/v1/orders";
export type OrderLine = {
  id: string;
  productId: string;
  quantity: number;
  receivedQuantity: number;
};
export type Receipt = {
  orderId: string;
  key: string;
  body: {
    warehouseId: string;
    receivedAt: string;
    note: string;
    items: { itemId: string; quantity: number }[];
  };
};
export function prepareReceipt(
  orderId: string,
  line: OrderLine,
  warehouseId: string,
  entered: string,
  note: string,
  key: string,
  receivedAt: string
): Receipt {
  const quantity = Number(entered);
  if (
    !warehouseId ||
    !/^[1-9]\d*$/.test(entered) ||
    !Number.isSafeInteger(quantity) ||
    quantity > line.quantity - line.receivedQuantity
  )
    throw Error(
      "Choose a warehouse and enter a whole quantity within the outstanding balance."
    );
  if (!note.trim() || note.trim().length > 300)
    throw Error("Enter a receiving note of up to 300 characters.");
  return {
    orderId,
    key,
    body: {
      warehouseId,
      receivedAt,
      note: note.trim(),
      items: [{ itemId: line.id, quantity }],
    },
  };
}
export async function postReceipt(
  pending: Receipt,
  post: (
    path: string,
    body: Receipt["body"],
    key: string
  ) => Promise<{ receiptId: string }>
) {
  const result = await post(
    purchaseOrders + "/" + pending.orderId + "/receipts",
    pending.body,
    pending.key
  );
  if (!result?.receiptId)
    throw Error(
      "The warehouse service did not confirm this receipt. Retry the saved entry."
    );
  return result.receiptId;
}
