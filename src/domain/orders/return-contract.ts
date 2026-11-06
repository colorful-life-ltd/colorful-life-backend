/** Return Management V1 wire contract. ISO timestamps; no payment-provider operations. */
export const returnStatuses = [
  "REQUESTED",
  "AUTHORIZED",
  "RECEIVED",
  "INSPECTED",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
] as const;
export type ReturnStatus = (typeof returnStatuses)[number];
export const returnReasons = [
  "CHANGE_OF_MIND",
  "DAMAGED",
  "DEFECTIVE",
  "WRONG_ITEM",
  "NOT_AS_DESCRIBED",
  "OTHER",
] as const;
export type ReturnReason = (typeof returnReasons)[number];
export type ReturnInstructions = {
  reference: string;
  address: string[];
  instructions: string;
  postageInstructions: string;
  shippingPayer: "CUSTOMER" | "SELLER";
};
export type ReturnLine = {
  id: number;
  orderItemId: number;
  quantity: number;
  reason: ReturnReason;
  reasonNote: string | null;
  status: ReturnStatus;
  requestedAt: string;
  authorizedAt: string | null;
  receivedAt: string | null;
  inspectedAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  rejectionNote: string | null;
  shippingPayer: "CUSTOMER" | "SELLER" | null;
  instructions: ReturnInstructions | null;
  receiptNote?: string | null;
  receivedByUserId?: number | null;
  decisionByUserId?: number | null;
  inspectionNote?: string | null;
  condition?: string | null;
  restockQuantity?: number;
  notification?: { state: string; lastErrorCode: string | null } | null;
};
export type ReturnCaseView = {
  orderId: number;
  reference: string | null;
  caseId: string | null;
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    remainingQuantity: number;
    condition: string | null;
  }>;
  submissions: Array<{ id: string; requestedAt: string; lines: ReturnLine[] }>;
  customer?: {
    id: number;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    deleted: boolean;
  };
  defaultInstructions?: { address: string[]; instructions: string };
};
export type ReturnRequest = {
  idempotencyKey: string;
  lines: Array<{
    orderItemId: number;
    quantity: number;
    reason: ReturnReason;
    reasonNote?: string;
  }>;
};
export type ReturnAction =
  | "authorize"
  | "reject"
  | "receive"
  | "cancel"
  | "inspect"
  | "complete";
export type ReturnQueue = {
  page: number;
  pageSize: number;
  total: number;
  cases: Array<{
    orderId: number;
    reference: string;
    createdAt: string;
    customer: {
      email: string;
      firstName: string | null;
      lastName: string | null;
      deletedAt: string | null;
    } | null;
    statuses: ReturnStatus[];
  }>;
};
export const returnLabel = (value: string) =>
  value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
