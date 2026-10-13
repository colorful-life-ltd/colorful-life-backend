import assert from "node:assert/strict";
import { it } from "node:test";
import type Stripe from "stripe";
import { canSafelyCancelStripeIntent, isTerminalUnpaidStripeIntent } from "../domain/payments/stripeResolutionService.js";
function intent(status: string, received=0, capturable=0) { return {status,amount_received:received,amount_capturable:capturable} as Stripe.PaymentIntent; }
it("only safe unreceived/unauthed Stripe states permit cancellation",()=>{
 for(const status of ["requires_payment_method","requires_confirmation","requires_action"]) assert.equal(canSafelyCancelStripeIntent(intent(status)),true);
 for(const status of ["succeeded","processing","requires_capture","canceled","unknown"]) assert.equal(canSafelyCancelStripeIntent(intent(status)),false);
 assert.equal(canSafelyCancelStripeIntent(intent("requires_action",1)),false);assert.equal(canSafelyCancelStripeIntent(intent("requires_confirmation",0,1)),false);
});
it("only confirmed cancellation with zero received and capturable funds proves terminal unpaid",()=>{
 assert.equal(isTerminalUnpaidStripeIntent(intent("canceled")),true);
 for(const status of ["succeeded","processing","requires_capture","requires_payment_method","unknown"]) assert.equal(isTerminalUnpaidStripeIntent(intent(status)),false);
 assert.equal(isTerminalUnpaidStripeIntent(intent("canceled",1)),false);assert.equal(isTerminalUnpaidStripeIntent(intent("canceled",0,1)),false);
});
