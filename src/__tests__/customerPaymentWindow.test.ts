import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Decimal } from "@prisma/client/runtime/client";
import { presentCustomerPaymentWindow, type PaymentWindowInput } from "../domain/payments/customerPaymentWindow.js";

const now = new Date("2026-10-15T12:00:00Z");
const future = new Date(now.getTime() + 1800000);
const past = new Date(now.getTime() - 1);
function input(managed = false): PaymentWindowInput {
  return {
    order: { status: "PENDING", reservationExpiresAt: future, totalAmount: new Decimal(20) }, payment: null, attempts: [],
    resolution: managed ? { historical: false, quarantineReason: null, state: "INITIAL_OPEN", initialPaymentDeadline: future,
      retryDeadline: null, firstFailureVerifiedAt: null, paymentAdmissionClosedAt: null, reservationDisposition: "HELD" } : null,
    hasUnresolvedInbox: false, hasSuccessEvidence: false, hasFinancialEvidence: false, admission: "OPEN", managedEnabled: managed, stripeConfigured: true, now,
  };
}
function payment(i: PaymentWindowInput, status: "PROCESSING" | "FAILED" | "CANCELED" | "SUCCEEDED" = "PROCESSING") {
  i.payment = { id: 1, provider: "STRIPE", providerReference: "pi_fixture", status, paidAt: null };
  if (i.resolution) i.attempts.push({ paymentId: 1, providerReference: "pi_fixture", historical: false, successEvidenceId: null, finalityEvidenceId: null, operations: [{ type: "CONFIRM", state: "POTENTIALLY_DISPATCHED" }] });
  return i;
}
describe("customer payment window projection", () => {
  for (const managed of [false, true]) {
    it(`initial eligibility uses the authoritative deadline (managed=${managed})`, () => {
      const i = input(managed);
      if (managed) i.order.reservationExpiresAt = past;
      assert.equal(presentCustomerPaymentWindow(i).state, "INITIAL_PAYMENT");
      assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "ELIGIBLE");
      assert.equal(presentCustomerPaymentWindow(i).paymentDeadline, future.toISOString());
      if (managed) i.resolution!.initialPaymentDeadline = now; else i.order.reservationExpiresAt = now;
      assert.equal(presentCustomerPaymentWindow(i).state, "NOT_PAYABLE");
      assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "INELIGIBLE");
    });
    it(`processing survives admission closure (managed=${managed})`, () => {
      const i = payment(input(managed)); i.order.reservationExpiresAt = past; i.admission = "CLOSED";
      if (managed) i.resolution!.initialPaymentDeadline = past;
      const w = presentCustomerPaymentWindow(i);
      assert.equal(w.state, "PROCESSING"); assert.equal(w.paymentOutcome, "PENDING"); assert.equal(w.initiationEligibility, "INELIGIBLE");
    });
    it(`a failed payment without finality is not safely retryable (managed=${managed})`, () => {
      const i = payment(input(managed), "FAILED");
      if (managed) { i.resolution!.retryDeadline = future; i.resolution!.firstFailureVerifiedAt = now; }
      assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, managed ? "REQUIRES_PROVIDER_CHECK" : "INELIGIBLE");
      i.admission = "CLOSED";
      assert.equal(presentCustomerPaymentWindow(i).state, "OUTCOME_UNRESOLVED");
    });
  }
  it("resume is distinct from starting another payment and ignores read-only UNKNOWN", () => {
    const i = payment(input(true));
    i.attempts[0].operations.push({ type: "RETRIEVE", state: "UNKNOWN" });
    const w = presentCustomerPaymentWindow(i);
    assert.equal(w.state, "CHECKOUT_RESUMABLE"); assert.equal(w.resumeEligibility, "ELIGIBLE");
    assert.equal(w.initiationEligibility, "INELIGIBLE");
    i.attempts[0].operations[0].state = "UNKNOWN";
    assert.equal(presentCustomerPaymentWindow(i).state, "OUTCOME_UNRESOLVED");
    assert.equal(presentCustomerPaymentWindow(i).resumeEligibility, "INELIGIBLE");
  });
  it("unfinished termination and UNKNOWN financial operations cannot advertise resume", () => {
    for (const type of ["CREATE", "CONFIRM", "CAPTURE", "TERMINATE"] as const) {
      const i = payment(input(true)); i.attempts[0].operations.push({ type, state: "UNKNOWN" });
      assert.equal(presentCustomerPaymentWindow(i).resumeEligibility, "INELIGIBLE");
    }
    const i = payment(input(true)); i.attempts[0].operations.push({ type: "TERMINATE", state: "POTENTIALLY_DISPATCHED" });
    assert.equal(presentCustomerPaymentWindow(i).state, "OUTCOME_UNRESOLVED");
  });
  it("verified failure remains conditional after initiation overwrites local FAILED with PROCESSING", () => {
    const i = payment(input(true)); i.resolution!.firstFailureVerifiedAt = now; i.resolution!.retryDeadline = future;
    const w = presentCustomerPaymentWindow(i);
    assert.equal(w.state, "RETRY_REQUIRES_PROVIDER_CHECK"); assert.equal(w.resumeEligibility, "REQUIRES_PROVIDER_CHECK");
    assert.equal(w.paymentOutcome, "UNRESOLVED");
    i.resolution!.retryDeadline = past;
    assert.equal(presentCustomerPaymentWindow(i).state, "OUTCOME_UNRESOLVED");
    assert.equal(presentCustomerPaymentWindow(i).resumeEligibility, "INELIGIBLE");
  });
  it("an unverified failure stays unresolved even if Stripe is unavailable", () => {
    const i = payment(input(), "FAILED"); i.stripeConfigured = false;
    assert.equal(presentCustomerPaymentWindow(i).state, "OUTCOME_UNRESOLVED");
    assert.equal(presentCustomerPaymentWindow(i).paymentOutcome, "UNRESOLVED");
  });
  it("retry requires current verified finality and every operation resolved", () => {
    const i = payment(input(true), "CANCELED"); i.resolution!.retryDeadline = future;
    i.attempts[0].finalityEvidenceId = 1; i.attempts[0].operations[0].state = "RESULT_RECORDED";
    assert.equal(presentCustomerPaymentWindow(i).state, "RETRY_AVAILABLE");
    assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "ELIGIBLE");
    i.attempts[0].operations.push({ type: "CONFIRM", state: "POTENTIALLY_DISPATCHED" });
    assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "INELIGIBLE");
  });
  it("new operations cannot be advertised when database admission guards reject the resolution state", () => {
    for (const state of ["SAFETY_HOLD", "REVIEW_REQUIRED", "INITIAL_WAIT"] as const) {
      const i = input(true); i.resolution!.state = state;
      assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "INELIGIBLE");
      payment(i, "CANCELED"); i.resolution!.retryDeadline = future;
      i.attempts[0].finalityEvidenceId = 1; i.attempts[0].operations[0].state = "RESULT_RECORDED";
      assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "INELIGIBLE");
    }
  });
  it("retry deadline equality closes admission without extending it", () => {
    const i = payment(input(true), "CANCELED"); i.resolution!.retryDeadline = now;
    i.attempts[0].finalityEvidenceId = 1; i.attempts[0].operations[0].state = "RESULT_RECORDED";
    assert.equal(presentCustomerPaymentWindow(i).state, "NOT_PAYABLE");
  });
  for (const uncertainty of ["placeholder", "unknown-operation", "unresolved-inbox", "missing-attempt"] as const) {
    it(`fails closed for ${uncertainty}`, () => {
      const i = payment(input(true));
      if (uncertainty === "placeholder") i.payment!.providerReference = "pending:test";
      if (uncertainty === "unknown-operation") i.attempts[0].operations[0].state = "UNKNOWN";
      if (uncertainty === "unresolved-inbox") i.admission = "UNAVAILABLE";
      if (uncertainty === "missing-attempt") i.attempts = [];
      const w = presentCustomerPaymentWindow(i);
      assert.equal(w.state, "OUTCOME_UNRESOLVED"); assert.equal(w.initiationEligibility, "INELIGIBLE");
    });
  }
  it("missing or quarantined ledger coverage cannot advertise initial payment", () => {
    const i = input(true); i.resolution = null;
    assert.equal(presentCustomerPaymentWindow(i).mode, "UNAVAILABLE");
    assert.equal(presentCustomerPaymentWindow(i).initiationEligibility, "INELIGIBLE");
    const h = input(true); h.resolution!.historical = true; h.managedEnabled = false;
    assert.equal(presentCustomerPaymentWindow(h).mode, "UNAVAILABLE");
  });
  it("success evidence is independent of fulfilment and deadlines", () => {
    const i = payment(input(true), "SUCCEEDED"); i.order.reservationExpiresAt = past; i.admission = "CLOSED";
    assert.equal(presentCustomerPaymentWindow(i).state, "PAID");
    i.payment!.status = "PROCESSING"; i.hasSuccessEvidence = true;
    assert.equal(presentCustomerPaymentWindow(i).state, "PAID");
  });
  for (const status of ["CANCELLED", "EXPIRED", "CONFIRMED", "DISPATCHED", "COMPLETED", "RETURNED"] as const) {
    it(`never admits ${status} orders, retaining any unresolved outcome`, () => {
      const i = payment(input()); i.order.status = status;
      const w = presentCustomerPaymentWindow(i);
      assert.equal(w.state, "NOT_PAYABLE"); assert.equal(w.initiationEligibility, "INELIGIBLE");
    });
  }
  it("checks configuration, payable amount, and other providers", () => {
    const i = input(); i.stripeConfigured = false;
    assert.equal(presentCustomerPaymentWindow(i).reason, "STRIPE_UNAVAILABLE");
    i.stripeConfigured = true; i.order.totalAmount = new Decimal(0);
    assert.equal(presentCustomerPaymentWindow(i).reason, "INVALID_AMOUNT");
    payment(i, "FAILED"); i.order.totalAmount = new Decimal(20); i.payment!.provider = "PAYPAL";
    assert.equal(presentCustomerPaymentWindow(i).reason, "OTHER_PROVIDER");
  });
});
