'use strict';
const assert = require('node:assert/strict');
const ethers = require('ethers');
const createRegistry = require('../lib/nft-mainnet-registry.cjs');
const artifact = require('../lib/tcm-mainnet-artifact.json');
const candidateRules = require('../lib/nft-candidate.cjs');
const seeds = require('../lib/nft-mainnet-assets.json');
const bytes = Buffer.from(JSON.stringify({name:'TCM NFT 003',image:seeds[0].imageURI}));
const third = { ...seeds[0], assetId:'TCM-003',name:'TCM NFT 003',tokenId:'3',level:3,priceMicro:'2001000000',
 mintHash:'0x'+'ab'.repeat(32),metadataURI:candidateRules.encodeRawCID(bytes) };
const registry = () => createRegistry([...seeds,third]);
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


module.exports = { chainFixture, seeds, third, bytes };
