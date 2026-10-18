'use strict';

const { keccak256, toUtf8Bytes } = require('ethers');
const COLLECTION = Object.freeze({ chainId: 56,
    contract: '0xc617c917bb594bB14F2A7EaD2d9b650Dd3754673',
    custody: '0x1E7d9Aa6922eb5CC6e91d289a4Bb5b45212cA2f3',
    deploymentHash: '0x5e91f1d5ec4456a90f1b3affecfb0a24e42c66667d870405d8d82c8b0d05aede' });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const bounds = [[50, 500], [500, 2000], [2000, 5000], [5000, 10000], [10000, 20000], [20000, null]];

// Accept only canonical CIDv1 raw SHA-256 roots. Paths and external URLs are never configuration.
function rawURI(value) {
    if (typeof value !== 'string' || !/^ipfs:\/\/b[a-z2-7]{58}$/.test(value)) throw Error('A raw SHA-256 IPFS root CID is required.');
    let accumulator = 0, bits = 0; const bytes = [];
    for (const char of value.slice(8)) {
        accumulator = (accumulator << 5) | 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(char); bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); accumulator &= (1 << bits) - 1; }
    }
    if (accumulator !== 0 || bytes.length !== 36 || bytes[0] !== 1 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 32) {
        throw Error('A canonical raw SHA-256 IPFS root CID is required.');
    }
    return value;
}

function createRegistry(entries = require('./nft-mainnet-assets.json')) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 1000) throw Error('Invalid reviewed Mainnet asset registry.');
    const ids = new Map(), tokens = new Map(), mintHashes = new Set();
    for (const row of entries) {
        if (!row || typeof row !== 'object' || typeof row.assetId !== 'string' ||
            !/^TCM-[A-Z0-9-]{1,48}$/.test(row.assetId) || row.assetId.startsWith('TCM-TEST-') ||
            typeof row.tokenId !== 'string' || !/^[1-9]\d{0,3}$/.test(row.tokenId) || BigInt(row.tokenId) > 1000n ||
            typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120 || /[\x00-\x1f<>]/.test(row.name) ||
            typeof row.mintHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(row.mintHash) ||
            !Number.isInteger(row.level) || row.level < 1 || row.level > 6 ||
            typeof row.priceMicro !== 'string' || !/^[1-9]\d{0,15}$/.test(row.priceMicro)) throw Error('Invalid reviewed Mainnet asset entry.');
        rawURI(row.metadataURI); rawURI(row.imageURI);
        const price = BigInt(row.priceMicro), [minimum, maximum] = bounds[row.level - 1];
        if (price > BigInt(Number.MAX_SAFE_INTEGER) || price < BigInt(minimum) * 1000000n ||
            (maximum !== null && price > BigInt(maximum) * 1000000n)) throw Error('Reviewed price is outside its level band.');
        const mintHash = row.mintHash.toLowerCase();
        if (ids.has(row.assetId) || tokens.has(row.tokenId) || mintHashes.has(mintHash)) throw Error('Duplicate reviewed asset, token or mint transaction.');
        const asset = Object.freeze({ ...COLLECTION, assetId: row.assetId, tokenId: row.tokenId, name: row.name,
            assetKey: keccak256(toUtf8Bytes(row.assetId)), mintHash, metadataURI: row.metadataURI,
            imageURI: row.imageURI, level: row.level, priceMicro: row.priceMicro, price: Number(price) / 1000000 });
        ids.set(asset.assetId, asset); tokens.set(asset.tokenId, asset); mintHashes.add(mintHash);
    }
    function byId(id) {
        const asset = ids.get(id);
        if (!asset) throw Object.assign(Error('This NFT is not in the reviewed Mainnet asset registry.'), { statusCode: 400 });
        return asset;
    }
    function fromReference(raw) {
        if (!raw || raw.Chain_ID !== 56 || !same(raw.Contract_Address, COLLECTION.contract)) return null;
        const asset = tokens.get(raw.Token_ID);
        return asset && same(raw.Mint_TxHash, asset.mintHash) && raw.Metadata_URI === asset.metadataURI &&
            (raw.Asset_Key === undefined || same(raw.Asset_Key, asset.assetKey)) &&
            (raw.Custody_Address === undefined || same(raw.Custody_Address, COLLECTION.custody)) ? asset : null;
    }
    return Object.freeze({ collection: COLLECTION, byId, fromReference,
        assets: Object.freeze([...ids.values()]) });
}
module.exports = createRegistry;
module.exports.rawURI = rawURI;
