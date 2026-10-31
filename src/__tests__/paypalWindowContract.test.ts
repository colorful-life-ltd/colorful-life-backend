import {it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Decimal} from '@prisma/client/runtime/client';
import {presentCustomerPaymentWindow,type PaymentWindowInput} from '../domain/payments/customerPaymentWindow.js';
it('old shared PayPal permission examples can no longer authorize initial/approval/capture',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../contracts/payment-window-v1.json',import.meta.url),'utf8'));
 const i:PaymentWindowInput={order:{status:'PENDING',reservationExpiresAt:new Date('2026-10-15T12:30:00Z'),totalAmount:new Decimal(1)},payment:null,resolution:{historical:false,quarantineReason:null,state:'INITIAL_OPEN',initialPaymentDeadline:new Date('2026-10-15T12:30:00Z'),retryDeadline:null,firstFailureVerifiedAt:null,paymentAdmissionClosedAt:null,reservationDisposition:'HELD'},attempts:[],hasUnresolvedInbox:false,hasSuccessEvidence:false,hasFinancialEvidence:false,admission:'OPEN',managedEnabled:true,stripeConfigured:false,paypalConfigured:true,preferredProvider:'PAYPAL',newInitiationEnabled:true,now:new Date('2026-10-15T12:00:00Z')};
 assert.equal(presentCustomerPaymentWindow(i).initiationEligibility,"INELIGIBLE");
 i.payment={id:1,provider:'PAYPAL',providerReference:'PP-fixture',status:'PENDING',paidAt:null};i.attempts=[{paymentId:1,providerReference:'PP-fixture',historical:false,successEvidenceId:null,finalityEvidenceId:null,operations:[{type:'CREATE',state:'POTENTIALLY_DISPATCHED'}]}];
 assert.equal(presentCustomerPaymentWindow(i).resumeEligibility,"INELIGIBLE");
 i.attempts[0].operations.push({type:'CAPTURE',state:'POTENTIALLY_DISPATCHED'});assert.equal(presentCustomerPaymentWindow(i).resumeEligibility,"INELIGIBLE");
 i.hasSuccessEvidence=true;assert.deepEqual(presentCustomerPaymentWindow(i),fixture.windows[3]);
});
