'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const review = require('../tools/review-nft-candidate.cjs');
const createRegistry = require('../lib/nft-mainnet-registry.cjs');
// Synthetic mint fixture is reviewed against the original first asset only.
const existing = [require('../lib/nft-mainnet-assets.json')[0]];
const first = createRegistry(existing).byId('TCM-001');
const bytes = Buffer.from(JSON.stringify({ name: 'TCM NFT 002', image: first.imageURI }));
const uri = review.encodeRawCID(bytes);
const candidate = { kind: 'Gallery_Candidate_Only', readyForProduction: false, Name: 'TCM NFT 002', Asset_ID: 'TCM-002',
    Image_URI: first.imageURI, Blockchain: { Chain_ID: 56, Contract_Address: first.contract, Token_ID: '2',
        Metadata_URI: uri, Mint_TxHash: '0x' + '88'.repeat(32), Custody_Address: first.custody } };
const entry = () => review.reviewEntry(candidate, '1', '50', existing).entry;

test('candidate review retains exact micro-units and enforces level bands before any network request', () => {
    assert.equal(review.amountMicro('50.000001'), '50000001');
    assert.equal(entry().priceMicro, '50000000');
    assert.equal(review.reviewEntry(candidate, '2', '501', existing).entry.priceMicro, '501000000');
    for (const value of ['5e1', '50.0000001', '-50', 'NaN', '50x', '050', '0', '9007199254.740991']) assert.throws(() => review.amountMicro(value));
    assert.throws(() => review.reviewEntry(candidate, '2', '50', existing), /band/);
    assert.throws(() => review.reviewEntry(candidate, '7', '50', existing), /Level/);
});

test('candidate review rejects testnet, wrong collection, duplicate tokens, changed originals and fake asset keys', () => {
    for (const change of [{ Chain_ID: 97 }, { Contract_Address: first.custody }, { Token_ID: '1' },
        { Asset_Key: '0x' + '00'.repeat(32) }, { Custody_Address: first.contract }]) {
        assert.throws(() => review.reviewEntry({ ...candidate, Blockchain: { ...candidate.Blockchain, ...change } }, '1', '50', existing));
    }
    assert.throws(() => review.reviewEntry({ ...candidate, Asset_ID: 'TCM-001' }, '1', '50', existing));
    assert.throws(() => review.reviewEntry({ ...candidate, Image_URI: first.imageURI + '/x' }, '1', '50', existing));
});

test('candidate metadata review validates actual raw CID bytes and content through fixed bounded gateways', async () => {
    let calls = 0;
    const result = await review.checkMetadata(entry(), async url => {
        assert(url.startsWith('https://')); assert(!url.includes('example.org'));
        calls++; return calls === 1 ? new Response('busy', { status: 429 }) : new Response(bytes);
    });
    assert.equal(calls, 2); assert.equal(result.integrity, 'Raw_CID_SHA256_Verified');
    await assert.rejects(review.checkMetadata(entry(), async () => new Response(bytes.toString() + ' ')), /all four/);
    await assert.rejects(review.checkMetadata(entry(), async () => new Response('x'.repeat(131073))), /all four/);
});

test('local registry apply requires the exact approval and baseline, keeps a backup and is idempotent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tcm-registry-review-'));
    const target = path.join(directory, 'assets.json');
    const sourceBytes = Buffer.from(JSON.stringify(existing, null, 2) + '\n'), next = entry();
    fs.writeFileSync(target, sourceBytes);
    const { planSHA256 } = review.planFor(sourceBytes, next);
    assert.throws(() => review.applyPlan({ sourceBytes, entry: next, approvedPlan: 'wrong', target }), /Approval/);
    assert.deepEqual(fs.readFileSync(target), sourceBytes);
    const applied = review.applyPlan({ sourceBytes, entry: next, approvedPlan: planSHA256, target });
    assert.equal(applied.alreadyRegistered, false); assert.deepEqual(fs.readFileSync(applied.backup), sourceBytes);
    assert.equal(JSON.parse(fs.readFileSync(target)).length, 2);
    assert.throws(() => review.applyPlan({ sourceBytes, entry: next, approvedPlan: planSHA256, target }), /changed/);
    const updated = fs.readFileSync(target), again = review.planFor(updated, next);
    assert.equal(review.applyPlan({ sourceBytes: updated, entry: next, approvedPlan: again.planSHA256, target }).alreadyRegistered, true);
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
});

test('candidate review preview and plan construction do not rewrite the current registry', () => {
    const target = path.resolve(__dirname, '../lib/nft-mainnet-assets.json'), before = fs.readFileSync(target);
    const reviewed = review.reviewEntry(candidate, '1', '50', existing);
    const a = review.planFor(before, reviewed.entry), b = review.planFor(before, reviewed.entry);
    assert.equal(a.planSHA256, b.planSHA256);
    assert.deepEqual(fs.readFileSync(target), before);
});
