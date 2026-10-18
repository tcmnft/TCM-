'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const createRegistry = require('../lib/nft-mainnet-registry.cjs');
const first = createRegistry().byId('TCM-001');
const liveFile = path.join(__dirname, '../Dashboard.html');
const html = fs.readFileSync(fs.existsSync(liveFile) ? liveFile : path.join(__dirname, 'fixtures/Dashboard.html'), 'utf8');
const reference = { Chain_ID: 56, Contract_Address: first.contract, Token_ID: '2', Mint_TxHash: '0x' + '88'.repeat(32),
    Metadata_URI: first.metadataURI, Asset_Key: '0x' + '99'.repeat(32), Custody_Address: first.custody,
    Verification_Status: 'Verified_Mainnet_Snapshot', Verified_At: '2026-10-18T06:00:00.000Z' };
function renderers() {
    const start = html.indexOf('window.renderNFTBlockchainReference = raw => {');
    const end = html.indexOf('// NFT BLOCKCHAIN REFERENCE END', start);
    const helperStart = html.indexOf('const isChain = raw =>');
    const helperEnd = html.indexOf('const metadataLink = raw =>', helperStart);
    const context = { window: {}, Date, BigInt }; vm.createContext(context);
    vm.runInContext(html.slice(start, end) + '\n' + html.slice(helperStart, helperEnd) + '\nwindow.isSupported = isChain;', context);
    return context.window;
}
test('Dashboard cards and order details accept a second verified platform-custody token', () => {
    const ui = renderers();
    assert.equal(ui.isSupported(reference), true);
    const markup = ui.renderNFTBlockchainReference(reference);
    assert.match(markup, /Token 2/); assert(markup.includes('?a=2')); assert(markup.includes(reference.Mint_TxHash));
    assert.match(markup, /No on-chain user ownership transfer/);
});
test('Dashboard rejects unsupported new-token references instead of displaying a Mainnet badge', async t => {
    const ui = renderers();
    for (const change of [{ Chain_ID: 97 }, { Token_ID: '1001' }, { Token_ID: '0' }, { Mint_TxHash: first.mintHash },
        { Custody_Address: first.contract }, { Asset_Key: undefined }, { Verified_At: 'invalid' },
        { Verification_Status: 'Unverified_Reference' }, { Mint_TxHash: '0x74ac1c82cfdd43579edd68644b4c756a3c17b524c3be3b1a1a823f9e2cf2b6a5' }]) {
        await t.test(JSON.stringify(change), () => {
            const raw = { ...reference, ...change };
            assert.equal(Boolean(ui.isSupported(raw)), false); assert.equal(ui.renderNFTBlockchainReference(raw), '');
        });
    }
});
test('original token 1 historical reference compatibility is preserved', () => {
    const ui = renderers(), original = { ...reference, Token_ID: '1', Mint_TxHash: first.mintHash };
    delete original.Asset_Key; delete original.Custody_Address;
    assert.equal(ui.isSupported(original), true); assert.match(ui.renderNFTBlockchainReference(original), /Token 1/);
});
