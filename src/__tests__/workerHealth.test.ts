import {it} from 'node:test';
import assert from 'node:assert/strict';
import {completedSweep,sweepAge,sweepTimes} from '../operations/health.js';
it('sweep health records completed work and exposes elapsed age without resetting other workers',()=>{
 sweepTimes.clear();completedSweep('payment');
 const done=sweepTimes.get('payment')!;
 assert.equal(sweepAge('payment',done+181000),181);
 completedSweep('paypal');
 assert.equal(sweepTimes.get('payment'),done);
 assert.equal(sweepAge('payment',done-1),0);
 assert.ok(Number.isFinite(sweepAge('cart')));
});
