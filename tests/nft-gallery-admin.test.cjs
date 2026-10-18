'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createGallery = require('../lib/nft-mainnet-gallery.cjs');
const identity = createGallery({}).identity;
function fixture() {
    const liveFile = path.join(__dirname, '../admin.html');
    const html = fs.readFileSync(fs.existsSync(liveFile) ? liveFile : path.join(__dirname, 'fixtures/admin.html'), 'utf8');
    const marker = '/* TCM Mainnet Gallery: no wallet connection, signing or automatic publication. */';
    const start = html.indexOf(marker), end = html.indexOf('</script>', start);
    const nodes = new Map(), requests = [], state = { mode: 'ok', token: 'admin-test-session' };
    const reviewed = require('../lib/nft-mainnet-registry.cjs')([
        require('../lib/nft-mainnet-assets.json')[0],
        { ...require('../lib/nft-mainnet-assets.json')[0], assetId: 'TCM-002', name: 'TCM NFT 002', tokenId: '2', level: 1,
            priceMicro: '50000000', mintHash: '0x' + '88'.repeat(32), metadataURI: identity.imageURI }
    ]).assets;
    const node = name => {
        if (!nodes.has(name)) nodes.set(name, { handlers: {}, disabled: false, hidden: true, textContent: '',
            addEventListener(event, fn) { this.handlers[event] = fn; }, replaceChildren() {}, append() {} });
        return nodes.get(name);
    };
    const session = { ready: true, generation: 1 };
    const context = { Date, URL, AbortController, setTimeout, clearTimeout, JSON,
        document: { getElementById: () => ({ querySelector: selector => node(selector.match(/="(.+)"/)[1]) }), createElement: () => ({}) },
        localStorage: { getItem: () => state.token }, adminAuthState: session,
        BACKEND_URL: 'http://127.0.0.1:5000/', window: { confirm: () => true },
        async _nativeFetch(url, options) {
            requests.push({ url, options });
            assert(url.startsWith('http://127.0.0.1:5000/api/admin/nft-mainnet/'));
            assert.equal(options.headers.Authorization, 'Bearer admin-test-session');
            if (state.mode === 'session-change') session.generation++;
            if (state.hook) state.hook();
            const asset = reviewed.find(a => a.assetId === new URL(url).searchParams.get('assetId')) || reviewed[0];
            const list = reviewed.map(a => ({ ...a }));
            if (state.mode === 'bad-list') list[1].priceMicro = 'garbage';
            const data = url.endsWith('/assets') ? list : url.endsWith('/publish') ? { id: 'safe-id', alreadyPublished: false, status: 'Available' } : {
                status: 'Verified_Mainnet_Snapshot', chainId: state.mode === 'testnet' ? '97' : '56', contract: identity.contract,
                tokenId: asset.tokenId, assetId: asset.assetId, assetKey: asset.assetKey,
                owner: identity.custody, hash: asset.mintHash, metadataURI: asset.metadataURI,
                confirmations: 100, checkedAt: new Date().toISOString()
            };
            return { ok: true, headers: { get: () => state.mode === 'html' ? 'text/html' : 'application/json' },
                json: async () => ({ success: true, data, source: 'RPC' }) };
        }
    };
    vm.createContext(context); vm.runInContext(html.slice(start, end), context);
    return { node, requests, state, session, html, reviewed };
}
test('Admin Mainnet controls send no automatic request and always resolve to BACKEND_URL', async () => {
    const f = fixture(); assert.equal(f.requests.length, 0); assert.equal(f.node('publish').disabled, true);
    await f.node('verify').handlers.click(); assert.equal(f.requests.length, 1); assert.equal(f.node('publish').disabled, false);
    await f.node('publish').handlers.click(); assert.equal(f.requests.length, 2);
    assert.deepEqual(JSON.parse(f.requests[1].options.body), { assetId: 'TCM-001', level: 2, price: '501' });
    assert.match(f.node('status').textContent, /Published/);
    assert.equal((f.html.match(/id="tcmMainnetGallery"/g) || []).length, 1);
    assert.equal((f.html.match(/id="tcmTestGallery"/g) || []).length, 1);
});
test('Admin verification rejects HTML errors, chain 97 and session changes before publication', async t => {
    for (const mode of ['html', 'testnet', 'session-change']) await t.test(mode, async () => {
        const f = fixture(); f.state.mode = mode; await f.node('verify').handlers.click();
        assert.equal(f.node('publish').disabled, true); assert.match(f.node('status').textContent, /Not verified/);
        assert.equal(f.requests.length, 1);
    });
});
test('Admin candidate import rejects a Testnet candidate and never publishes by importing a JSON file', async () => {
    const f = fixture();
    await f.node('file').handlers.change({ target: { files: [{ size: 10, text: async () => JSON.stringify({ kind: 'Gallery_Candidate_Only', readyForProduction: false, Blockchain: { Chain_ID: 97 } }) }] } });
    assert.match(f.node('status').textContent, /does not match/); assert.equal(f.requests.length, 0);
    const candidate = { kind: 'Gallery_Candidate_Only', readyForProduction: false, Name: identity.name, Asset_ID: identity.assetId, Image_URI: identity.imageURI,
        Blockchain: { Chain_ID: 56, Contract_Address: identity.contract, Token_ID: '1', Metadata_URI: identity.metadataURI, Mint_TxHash: identity.mintHash } };
    await f.node('file').handlers.change({ target: { files: [{ size: 1000, text: async () => JSON.stringify(candidate) }] } });
    assert.match(f.node('status').textContent, /candidate matched/); assert.equal(f.requests.length, 0);
    assert.equal(f.node('publish').disabled, true);
});

test('Admin selects, independently verifies and publishes a second reviewed asset using its own level and price', async () => {
    const f = fixture();
    assert.equal(f.requests.length, 0);
    await f.node('load').handlers.click(); assert.equal(f.requests.length, 1);
    f.node('asset').value = 'TCM-002'; f.node('asset').handlers.change();
    assert.equal(f.node('publish').disabled, true);
    await f.node('verify').handlers.click(); assert.equal(f.node('publish').disabled, false, f.node('status').textContent);
    assert.match(f.requests[1].url, /assetId=TCM-002/);
    assert.match(f.node('token-link').href, /\?a=2$/);
    await f.node('publish').handlers.click();
    assert.deepEqual(JSON.parse(f.requests[2].options.body), { assetId: 'TCM-002', level: 1, price: '50' });
    assert.match(f.node('status').textContent, /TCM-002.*Level 1.*50 USDT/);
});

test('changing the selected NFT invalidates an earlier mint verification', async () => {
    const f = fixture(); await f.node('load').handlers.click(); await f.node('verify').handlers.click();
    assert.equal(f.node('publish').disabled, false);
    f.node('asset').value = 'TCM-002'; f.node('asset').handlers.change();
    assert.equal(f.node('publish').disabled, true);
    const count = f.requests.length; await f.node('publish').handlers.click(); assert.equal(f.requests.length, count);
});

test('a selection changed while verification is in flight cannot enable publication', async () => {
    const f = fixture(); await f.node('load').handlers.click();
    f.state.hook = () => { f.node('asset').value = 'TCM-002'; f.node('asset').handlers.change(); };
    await f.node('verify').handlers.click();
    assert.equal(f.node('publish').disabled, true); assert.match(f.node('status').textContent, /Not verified/);
});

test('invalid list data and unreviewed candidate imports never publish or retain a previous approval', async () => {
    const f = fixture(); await f.node('verify').handlers.click();
    f.state.mode = 'bad-list'; await f.node('load').handlers.click();
    assert.equal(f.node('publish').disabled, true); assert.match(f.node('status').textContent, /List not loaded/);
    f.state.mode = 'ok';
    await f.node('verify').handlers.click(); const count = f.requests.length;
    const candidate = { kind: 'Gallery_Candidate_Only', readyForProduction: false, Asset_ID: 'TCM-999',
        Blockchain: { Chain_ID: 56, Contract_Address: identity.contract } };
    await f.node('file').handlers.change({ target: { files: [{ size: 100, text: async () => JSON.stringify(candidate) }] } });
    assert.match(f.node('status').textContent, /not in the reviewed registry/);
    assert.equal(f.node('publish').disabled, true); assert.equal(f.requests.length, count);
});
