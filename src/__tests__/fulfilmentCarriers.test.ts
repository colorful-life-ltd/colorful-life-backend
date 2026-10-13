import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidTrackingNumber, normalizeTrackingNumber, resolveCarrierName, trackingLink } from "../domain/fulfilment/carriers.js";
import { DispatchShipmentSchema, StartPreparingSchema } from "../domain/fulfilment/fulfilmentValidator.js";
import { fulfilmentStage } from "../domain/fulfilment/fulfilmentService.js";
import { presentFulfilment } from "../domain/fulfilment/fulfilmentPresenter.js";

const at = new Date("2026-10-13T10:00:00.000Z");

describe("trusted carriers and tracking numbers", () => {
  it("normalises printed tracking numbers and validates them per carrier", () => {
    assert.equal(normalizeTrackingNumber(" ab 123-456 789 gb "), "AB123456789GB");
    assert.ok(isValidTrackingNumber("ROYAL_MAIL", "AB123456789GB"));
    for (const invalid of ["AB12345678GB", "AB123456789US", "1Z999AA10123456784", "AB123456789GB/../x"]) {
      assert.ok(!isValidTrackingNumber("ROYAL_MAIL", invalid), invalid);
    }
    assert.ok(isValidTrackingNumber("EVRI", "H01ABC2345678901"));
    assert.ok(!isValidTrackingNumber("EVRI", "H01ABC234567890"));
    assert.ok(isValidTrackingNumber("DPD", "15501234567890"));
    assert.ok(!isValidTrackingNumber("DPD", "1550123456789A"));
    assert.ok(isValidTrackingNumber("OTHER", "TRACK123"));
    assert.ok(!isValidTrackingNumber("OTHER", "https://evil.example/track"));
  });

  it("maps only unambiguous legacy carrier names", () => {
    assert.equal(resolveCarrierName(" Royal  Mail "), "ROYAL_MAIL");
    assert.equal(resolveCarrierName("hermes"), "EVRI");
    assert.equal(resolveCarrierName("DPD UK"), "DPD");
    for (const name of ["UPS", "Royal Mail Tracked 24 via https://x", "", null, undefined]) assert.equal(resolveCarrierName(name), null);
  });

  it("builds tracking links only from trusted templates and valid numbers", () => {
    assert.deepEqual(trackingLink("ROYAL_MAIL", "ab123456789gb"), {
      url: "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB", includesTrackingNumber: true,
    });
    assert.deepEqual(trackingLink("EVRI", "H01ABC2345678901"), { url: "https://www.evri.com/track-a-parcel", includesTrackingNumber: false });
    assert.deepEqual(trackingLink("DPD", "15501234567890"), { url: "https://www.dpd.co.uk/", includesTrackingNumber: false });
    assert.equal(trackingLink("OTHER", "TRACK123"), null);
    assert.equal(trackingLink(null, "AB123456789GB"), null);
    assert.equal(trackingLink("ROYAL_MAIL", null), null);
    assert.equal(trackingLink("ROYAL_MAIL", "<script>"), null, "invalid stored data never yields a link");
  });
});

describe("dispatch request validation", () => {
  it("accepts a trusted carrier and returns normalised, display-ready shipment data", () => {
    const parsed = DispatchShipmentSchema.parse({ carrier: "ROYAL_MAIL", trackingNumber: "ab 123 456 789 gb", actualShippingCost: 3.2 });
    assert.deepEqual(parsed, { carrier: "ROYAL_MAIL", carrierName: "Royal Mail", trackingNumber: "AB123456789GB", actualShippingCost: 3.2 });
    assert.deepEqual(DispatchShipmentSchema.parse({ carrier: "OTHER", carrierName: " Local Courier ", trackingNumber: "lc-123456", actualShippingCost: 0 }),
      { carrier: "OTHER", carrierName: "Local Courier", trackingNumber: "LC123456", actualShippingCost: 0 });
  });

  it("rejects untrusted carriers, URLs, bad tracking numbers and inconsistent carrier names", () => {
    const base = { carrier: "ROYAL_MAIL", trackingNumber: "AB123456789GB", actualShippingCost: 1 };
    for (const body of [
      { ...base, carrier: "UPS" },
      { ...base, trackingUrl: "https://evil.example" },
      { ...base, trackingNumber: "AB123" },
      { ...base, trackingNumber: undefined },
      { ...base, carrierName: "Royal Mail" },
      { ...base, carrier: "OTHER", trackingNumber: "TRACK123" },
      { ...base, actualShippingCost: -1 },
      { ...base, actualShippingCost: "1" },
      { ...base, dispatchedAt: "2026-01-01T00:00:00Z" },
    ]) {
      assert.equal(DispatchShipmentSchema.safeParse(body).success, false, JSON.stringify(body));
    }
    assert.equal(StartPreparingSchema.safeParse({}).success, true);
    assert.equal(StartPreparingSchema.safeParse({ preparingAt: "now" }).success, false);
  });
});

describe("fulfilment stage", () => {
  it("derives progress from order status without marking unshipped orders dispatched", () => {
    const cases: Array<[string, Date | null, Date | null, string | null]> = [
      ["PENDING", null, null, null],
      ["EXPIRED", null, null, null],
      ["CANCELLED", null, null, null],
      ["CONFIRMED", null, null, "CONFIRMED"],
      ["CONFIRMED", at, null, "PREPARING"],
      ["DISPATCHED", at, at, "DISPATCHED"],
      ["DISPATCHED", null, null, null],
      ["COMPLETED", null, at, "DISPATCHED"],
      ["COMPLETED", null, null, null],
      ["RETURNED", null, at, "DISPATCHED"],
    ];
    for (const [status, preparingAt, dispatchedAt, expected] of cases) {
      assert.equal(fulfilmentStage({ status, preparingAt, dispatchedAt }), expected, `${status}/${preparingAt}/${dispatchedAt}`);
    }
  });

  it("presents legacy dispatches from order fields with links only for trusted carriers", () => {
    const legacy = { status: "DISPATCHED", preparingAt: null, dispatchedAt: at, shipments: [] };
    const royalMail = presentFulfilment({ ...legacy, shippingCarrier: "Royal Mail", trackingNumber: "AB123456789GB" });
    assert.deepEqual(royalMail, { stage: "DISPATCHED", preparingAt: null, dispatchedAt: at, shipments: [{
      sequence: 1, carrier: "ROYAL_MAIL", carrierName: "Royal Mail", trackingNumber: "AB123456789GB", dispatchedAt: at,
      trackingUrl: "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB", trackingUrlIncludesNumber: true,
    }] });
    const ups = presentFulfilment({ ...legacy, shippingCarrier: "UPS", trackingNumber: "1Z999AA10123456784" });
    assert.deepEqual([ups.shipments[0].carrier, ups.shipments[0].trackingUrl], [null, null]);
    const confirmed = presentFulfilment({ status: "CONFIRMED", preparingAt: null, dispatchedAt: null, shippingCarrier: null, trackingNumber: null, shipments: [] });
    assert.deepEqual(confirmed, { stage: "CONFIRMED", preparingAt: null, dispatchedAt: null, shipments: [] });
  });
});
