import type { CarrierTrackingAdapter, TrackingObservation, TrackingRequest } from "./trackingContract.js";
import { TrackingProviderError } from "./trackingContract.js";
import type { ShippingCarrier } from "../../generated/prisma-client/enums.js";

/** Offline fixtures are deliberately unusable outside the guarded test runtime. Never impersonates a real API. */
export class FakeCarrierTrackingAdapter implements CarrierTrackingAdapter {
  readonly mode = "TEST" as const;
  calls = 0;
  constructor(readonly carrier: ShippingCarrier, readonly providerIdentity: string,
    private readonly responses: Array<TrackingObservation | TrackingProviderError | ((request: TrackingRequest, signal: AbortSignal) => Promise<TrackingObservation>)>,
    private readonly available = true) {}
  isAvailable() { return this.available && process.env.NODE_ENV === "test"; }
  async track(request: TrackingRequest, signal: AbortSignal) {
    if (!this.isAvailable()) throw new TrackingProviderError("PERMANENT");
    this.calls++;
    const next = this.responses.shift();
    if (!next) throw new TrackingProviderError("PERMANENT");
    if (next instanceof TrackingProviderError) throw next;
    return typeof next === "function" ? next(request, signal) : next;
  }
}
