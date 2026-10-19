import { it } from 'node:test';
import assert from 'node:assert/strict';
import { logOperationalError } from '../utils/operationalLog.js';
it('operational logs retain safe codes without error messages, stacks, input or provider secrets', () => {
    const original = console.error;
    const values: string[] = [];
    console.error = (v: string) => { values.push(v); };
    try {
        logOperationalError('test-operation', Object.assign(new Error('secret-canary-person@example.test'), { code: 'P2002', input: { token: 'secret-canary' } }));
        logOperationalError('test-operation', { code: 'secret-canary', stack: 'secret-canary' });
        assert.equal(JSON.parse(values[0]).code, 'P2002');
        assert.equal(JSON.parse(values[1]).code, 'UNCLASSIFIED');
        assert.doesNotMatch(values.join(''), /secret-canary|stack|input/);
    }
    finally {
        console.error = original;
    }
});
