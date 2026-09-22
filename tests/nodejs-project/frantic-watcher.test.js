#!/usr/bin/env node
'use strict';

const assert = require('assert');
const frantic = require('../../app/src/main/assets/nodejs-project/frantic');

const { candidateBounties, callbackNumber, absoluteUrl } = frantic._test;

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('candidateBounties keeps funded claimable work inside price range', () => {
    const board = {
        open_bounties: [
            {
                number: 135,
                title: 'Good',
                funded: true,
                price_usd: 1.05,
                work_status: 'open',
                claim_slots: { available: 3, capacity: 10 },
                actions: { claim: { available: true } },
            },
            {
                number: 136,
                title: 'Unfunded',
                funded: false,
                price_usd: 5,
                work_status: 'open',
                claim_slots: { available: 1, capacity: 1 },
                actions: { claim: { available: true } },
            },
            {
                number: 137,
                title: 'Too expensive',
                funded: true,
                price_usd: 50,
                work_status: 'open',
                claim_slots: { available: 1, capacity: 1 },
                actions: { claim: { available: true } },
            },
            {
                number: 138,
                title: 'No slots',
                funded: true,
                price_usd: 2,
                work_status: 'open',
                claim_slots: { available: 0, capacity: 1 },
                actions: { claim: { available: true } },
            },
        ],
    };

    const got = candidateBounties(board, { minUsd: 0.01, maxUsd: 10 });
    assert.deepStrictEqual(got.map((b) => b.number), [135]);
});

t('candidateBounties sorts by payout descending', () => {
    const base = {
        funded: true,
        work_status: 'open',
        claim_slots: { available: 1, capacity: 1 },
        actions: { claim: { available: true } },
    };
    const board = {
        open_bounties: [
            { ...base, number: 1, price_usd: 1 },
            { ...base, number: 2, price_usd: 7 },
            { ...base, number: 3, price_usd: 3 },
        ],
    };
    const got = candidateBounties(board, { minUsd: 0, maxUsd: 10 });
    assert.deepStrictEqual(got.map((b) => b.number), [2, 3, 1]);
});

t('callbackNumber only accepts exact Frantic action callbacks', () => {
    assert.strictEqual(callbackNumber('frantic:claim:135', 'claim'), 135);
    assert.strictEqual(callbackNumber('frantic:skip:42', 'skip'), 42);
    assert.strictEqual(callbackNumber('frantic:claim:not-a-number', 'claim'), null);
    assert.strictEqual(callbackNumber('quick:claim:135', 'claim'), null);
});

t('absoluteUrl normalizes bounty paths', () => {
    assert.strictEqual(absoluteUrl('/bounties/135', 135), 'https://gofrantic.com/bounties/135');
    assert.strictEqual(absoluteUrl('', 135), 'https://gofrantic.com/bounties/135');
    assert.strictEqual(absoluteUrl('https://gofrantic.com/bounties/9', 9), 'https://gofrantic.com/bounties/9');
});

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log(`  ok  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}\n    ${e.stack || e.message}`);
        failed++;
    }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
