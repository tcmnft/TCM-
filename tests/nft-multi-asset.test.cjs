'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ethers = require('ethers');
const createRegistry = require('../lib/nft-mainnet-registry.cjs');
const createGallery = require('../lib/nft-mainnet-gallery.cjs');
const configured = require('../lib/nft-mainnet-assets.json');
const artifact = require('../lib/tcm-mainnet-artifact.json');
const first = configured[0];
// Synthetic fixtures only: these rows are never included in the production registry.
const second = { ...first, assetId: 'TCM-002', name: 'TCM NFT 002', tokenId: '2', level: 1,
    priceMicro: '50000000', mintHash: '0x' + '88'.repeat(32), metadataURI: first.imageURI };
const registry = () => createRegistry([first, second]);
const reference = asset => ({ Chain_ID: 56, Contract_Address: asset.contract, Token_ID: asset.tokenId,
    Mint_TxHash: asset.mintHash, Metadata_URI: asset.metadataURI, Asset_Key: asset.assetKey, Custody_Address: asset.custody });

test('shipped registry retains both operator-approved NFTs without auto-enrolling unknown tokens', () => {
    assert.equal(configured.length, 2);
    const r = createRegistry();
    assert.equal(r.byId('TCM-001').priceMicro, '501000000');
    assert.equal(r.byId('TCM-001').level, 2);
    assert.equal(r.byId('TCM-002').priceMicro, '50000000');
    assert.throws(() => r.byId('TCM-999'), /not in the reviewed/);
    assert.equal(r.fromReference(reference(registry().byId('TCM-002'))), null);
});

test('registry isolates reviewed assets and does not expose mutable configuration', () => {
    const entries = [{ ...first }, { ...second }], r = createRegistry(entries);
    entries[1].tokenId = '999'; entries.pop();
    assert.equal(r.assets.length, 2); assert.equal(r.byId('TCM-002').tokenId, '2');
    assert(Object.isFrozen(r.assets)); assert(Object.isFrozen(r.assets[0]));
    assert.equal(r.fromReference(reference(r.byId('TCM-002'))).assetId, 'TCM-002');
    assert.equal(r.fromReference({ ...reference(r.byId('TCM-002')), Mint_TxHash: first.mintHash }), null);
    assert.equal(r.fromReference({ ...reference(r.byId('TCM-002')), Chain_ID: 97 }), null);
    assert.equal(r.fromReference({ ...reference(r.byId('TCM-002')), Asset_Key: r.byId('TCM-001').assetKey }), null);
    assert.equal(r.fromReference({ ...reference(r.byId('TCM-002')), Custody_Address: ethers.ZeroAddress }), null);
});

test('invalid registry entries, duplicate identities, CID paths and out-of-band prices fail closed', async t => {
    const cases = {
        duplicateAsset: { assetId: first.assetId }, duplicateToken: { tokenId: '1' }, duplicateHash: { mintHash: first.mintHash },
        testAsset: { assetId: 'TCM-TEST-002' }, tokenZero: { tokenId: '0' }, numericToken: { tokenId: 2 },
        supplyCap: { tokenId: '1001' }, leadingZero: { tokenId: '02' }, html: { name: '<img>' },
        badPrice: { priceMicro: '50000000.1' }, floatingPrice: { priceMicro: 50000000 },
        unsafePrice: { level: 6, priceMicro: '9007199254740992' }, lowPrice: { priceMicro: '49999999' },
        wrongLevel: { level: 7 }, band: { level: 1, priceMicro: '501000000' },
        uriPath: { metadataURI: first.metadataURI + '/x' }, url: { imageURI: 'https://example.org/a.png' },
        padding: { metadataURI: first.metadataURI.slice(0, -1) + 'n' }
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
        assert.throws(() => createRegistry([first, { ...second, ...change }]));
    });
});

function chainFixture({ mode = 'direct', failAsset, changedOwner, chainId = 56 } = {}) {
    const r = registry(), assets = r.assets, collection = r.collection;
    const iface = new ethers.Interface(artifact.abi), counts = new Map();
    const hashes = { deployment: '0x' + '44'.repeat(32), mint: '0x' + '55'.repeat(32), head: '0x' + '66'.repeat(32) };
    class Provider {
        async send(method) { assert.equal(method, 'eth_chainId'); return '0x' + chainId.toString(16); }
        async getNetwork() { return { chainId: BigInt(chainId) }; }
        async getTransaction(hash) {
            const asset = assets.find(a => a.mintHash === hash), deploy = hash === collection.deploymentHash;
            assert(deploy || asset, 'only configured transactions may be read');
            return { hash, chainId: 56n, from: collection.custody, to: deploy ? null : mode === 'direct' ? collection.contract : '0x' + '77'.repeat(20),
                type: deploy ? 0 : mode === 'direct' ? 2 : 4, nonce: deploy ? 0 : Number(asset.tokenId), value: 0n,
                blockNumber: deploy ? 100 : 200, blockHash: deploy ? hashes.deployment : hashes.mint,
                data: deploy ? artifact.bytecode + iface.encodeDeploy([collection.custody]).slice(2) : mode === 'direct'
                    ? iface.encodeFunctionData('mintOnce', [asset.assetKey, asset.metadataURI]) : '0x1234' };
        }
        async getTransactionReceipt(hash) {
            counts.set(hash, (counts.get(hash) || 0) + 1);
            const deploy = hash === collection.deploymentHash, asset = assets.find(a => a.mintHash === hash);
            assert(deploy || asset);
            const logs = deploy ? [] : [
                iface.encodeEventLog(iface.getEvent('Transfer'), [ethers.ZeroAddress, collection.custody, BigInt(asset.tokenId)]),
                iface.encodeEventLog(iface.getEvent('AssetMinted'), [asset.assetKey, BigInt(asset.tokenId), collection.custody, asset.metadataURI])
            ].map(log => ({ ...log, address: collection.contract }));
            return { hash, status: asset && asset.assetId === failAsset ? 0 : 1, contractAddress: deploy ? collection.contract : null,
                blockNumber: deploy ? 100 : 200, blockHash: deploy ? hashes.deployment : hashes.mint, logs };
        }
        async getBlock(number) { return { number: number === 'latest' ? 1000 : number,
            hash: number === 100 ? hashes.deployment : number === 200 ? hashes.mint : hashes.head }; }
        async getCode() { return '0x1234'; }
        async call(tx) {
            const input = iface.parseTransaction({ data: tx.data });
            const argument = input.args.length ? input.args[0] : undefined;
            const byToken = assets.find(a => a.tokenId === argument?.toString());
            const byKey = assets.find(a => a.assetKey === argument);
            const values = { custody: collection.custody, minter: collection.custody, ALLOWED_CHAIN_ID: 56n,
                MAX_SUPPLY: 1000n, supportsInterface: true,
                ownerOf: changedOwner ? ethers.ZeroAddress : collection.custody,
                tokenURI: byToken?.metadataURI, tokenForAsset: byKey ? BigInt(byKey.tokenId) : 0n };
            return iface.encodeFunctionResult(input.name, [values[input.name]]);
        }
        destroy() {}
    }
    return { registry: r, provider: new Provider(), ethers: { ...ethers, JsonRpcProvider: Provider }, counts };
}

test('direct and wrapped mint verification use the selected second asset, never the first asset defaults', async t => {
    const { verifyAssetMint } = await import('../lib/nft-mainnet-verify.mjs');
    for (const mode of ['direct', 'wrapped']) await t.test(mode, async () => {
        const f = chainFixture({ mode }), asset = f.registry.byId('TCM-002');
        const proof = await verifyAssetMint(f.provider, artifact, asset.deploymentHash, asset.mintHash, asset);
        assert.equal(proof.tokenId, '2'); assert.equal(proof.assetId, 'TCM-002');
        assert.equal(proof.assetKey, asset.assetKey); assert.equal(proof.metadataURI, second.metadataURI);
    });
});

test('generic mint proof rejects wrong expected token, metadata, asset key, collection and ownership', async t => {
    const { verifyAssetMint } = await import('../lib/nft-mainnet-verify.mjs');
    for (const change of [{ tokenId: '1' }, { metadataURI: first.metadataURI }, { assetId: 'TCM-003' }, { contract: ethers.ZeroAddress }]) {
        await t.test(Object.keys(change)[0], async () => {
            const f = chainFixture(), asset = f.registry.byId('TCM-002');
            await assert.rejects(verifyAssetMint(f.provider, artifact, asset.deploymentHash, asset.mintHash, { ...asset, ...change }));
        });
    }
    const f = chainFixture({ changedOwner: true }), asset = f.registry.byId('TCM-002');
    await assert.rejects(verifyAssetMint(f.provider, artifact, asset.deploymentHash, asset.mintHash, asset), /custody/);
});

test('per-asset RPC cache, single-flight deduplication and reference snapshots cannot leak between tokens', async () => {
    const f = chainFixture(), engine = createGallery({ ethers: f.ethers, reviewedAssets: [first, second] });
    const proofs = await Promise.all([engine.verify({ assetId: 'TCM-001' }), engine.verify({ assetId: 'TCM-002' }), engine.verify({ assetId: 'TCM-002' })]);
    assert.equal(proofs[0].data.tokenId, '1'); assert.equal(proofs[1].data.tokenId, '2');
    assert.equal(f.counts.get(first.mintHash), 1); assert.equal(f.counts.get(second.mintHash), 1);
    const cached = await engine.verify({ assetId: 'TCM-002' }); assert.equal(cached.source, 'cache');
    const snapshot = engine.reference(cached.data); assert.equal(snapshot.Token_ID, '2');
    assert.equal(snapshot.Mint_TxHash, second.mintHash);
    await assert.rejects(engine.verify({ assetId: 'TCM-003' }), /reviewed/);
    const isolated = engine.assets(); isolated[0].name = 'changed'; assert.notEqual(engine.assets()[0].name, 'changed');
    assert.throws(() => engine.reference({ ...cached.data, tokenId: '1' }), /does not match/);
    await engine.verify({ assetId: 'TCM-002', fresh: true }); assert.equal(f.counts.get(second.mintHash), 2);
});

test('a failed second proof is never cached and cannot reuse the successful first proof', async () => {
    const f = chainFixture({ failAsset: 'TCM-002' }), engine = createGallery({ ethers: f.ethers, reviewedAssets: [first, second] });
    assert.equal((await engine.verify()).data.tokenId, '1');
    await assert.rejects(engine.verify({ assetId: 'TCM-002' }), /reverted/);
    await assert.rejects(engine.verify({ assetId: 'TCM-002' }), /reverted/);
    assert.equal(f.counts.get(second.mintHash), 2); assert.equal((await engine.verify()).source, 'cache');
});

function publicationFixture(options = {}) {
    const f = chainFixture(options), actor = { Role: 'Admin', Status: 'Active', Token: 'test-session' };
    const rows = new Map([['Users/ADMIN', actor]]), writes = [];
    let serial = 0;
    const doc = path => ({ path, id: path.split('/').at(-1), get: async () => ({ exists: rows.has(path), id: path.split('/').at(-1), data: () => rows.get(path) }) });
    const collection = name => ({ doc: id => doc(name + '/' + (id || ++serial)),
        where: (field, operation, wanted) => ({ limit: cap => ({ get: async () => {
            assert.equal(field, 'Blockchain.Token_ID'); assert.equal(operation, 'in');
            const docs = [...rows].filter(([key, row]) => key.startsWith(name + '/') && wanted.includes(row.Blockchain?.Token_ID))
                .slice(0, cap).map(([key, row]) => ({ id: key.split('/').at(-1), data: () => row }));
            return { size: docs.length, docs };
        } }) }) });
    const db = { collection, async runTransaction(callback) {
        const staged = []; let writing = false;
        const result = await callback({ get: target => { assert.equal(writing, false); return target.get(); },
            create(target, value) { writing = true; assert(!rows.has(target.path)); staged.push([target.path, value]); } });
        for (const [path, value] of staged) { assert(!rows.has(path)); rows.set(path, value); writes.push(path); }
        return result;
    } };
    const engine = createGallery({ ethers: f.ethers, reviewedAssets: [first, second], db,
        FieldValue: { serverTimestamp: () => 'server-time' }, clearMarketCache: async () => {} });
    const req = asset => ({ authenticatedUid: 'ADMIN', authenticatedUserDoc: { data: () => ({ Token: 'test-session' }) },
        body: { assetId: asset.assetId, level: asset.level, price: asset.priceMicro === first.priceMicro ? '501' : '50' } });
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } });
    return { engine, rows, writes, actor, req, response };
}

test('publisher creates independent first/second listings and audit records; retry never resets a reserved token', async () => {
    const f = publicationFixture(), firstResult = f.response(), secondResult = f.response();
    await f.engine.publish(f.req(first), firstResult); await f.engine.publish(f.req(second), secondResult);
    assert.equal(firstResult.body.success, true, firstResult.body.message);
    assert.equal(secondResult.body.success, true, secondResult.body.message);
    assert.notEqual(firstResult.body.data.id, secondResult.body.data.id);
    const path = 'NFT_Gallery/' + secondResult.body.data.id, saved = f.rows.get(path);
    assert.equal(saved.Blockchain.Token_ID, '2'); assert.equal(saved.Asset_ID, 'TCM-002');
    assert.equal(saved.Price_micro, '50000000'); assert.equal(saved.Level, '1');
    assert.equal(f.writes.length, 4); assert(!f.writes.some(p => p.startsWith('Wallets/')));
    f.rows.set(path, { ...saved, Status: 'Reserved', Owner_UID: 'U', Reservation: { Order_ID: 'KEPT' } });
    const retry = f.response(); await f.engine.publish(f.req(second), retry);
    assert.equal(retry.body.data.alreadyPublished, true); assert.equal(f.rows.get(path).Owner_UID, 'U');
    assert.equal(f.rows.get(path).Reservation.Order_ID, 'KEPT'); assert.equal(f.writes.length, 4);
});

test('multi-asset publication rejects unreviewed input, price edits, session changes and duplicate second tokens', async t => {
    for (const mode of ['unknown', 'price', 'level', 'session', 'duplicate', 'custody']) await t.test(mode, async () => {
        const f = publicationFixture({ changedOwner: mode === 'custody' }), req = f.req(second), res = f.response();
        if (mode === 'unknown') req.body.assetId = 'TCM-999';
        if (mode === 'price') req.body.price = '51';
        if (mode === 'level') req.body.level = 2;
        if (mode === 'session') f.actor.Token = 'revoked';
        if (mode === 'duplicate') f.rows.set('NFT_Gallery/duplicate', { Blockchain: reference(registry().byId('TCM-002')) });
        await f.engine.publish(req, res);
        assert.equal(res.body.success, false); assert.equal(f.writes.length, 0);
    });
});
