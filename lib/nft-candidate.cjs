'use strict';
const crypto = require('node:crypto');
const createRegistry = require('./nft-mainnet-registry.cjs');
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function amountMicro(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) throw Error('Price must be a plain positive decimal with at most six decimal places.');
    const [whole, fraction = ''] = value.split('.');
    const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Invalid price.');
    if (BigInt(Math.round((Number(amount) / 1000000) * 1000000)) !== amount) throw Error('Price cannot be represented exactly by the existing numeric mirror. Use a representable six-decimal amount.');
    return amount.toString();
}
function reviewEntry(candidate, levelText, priceText, existing) {
    if (!candidate || Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 32768) throw Error('Candidate must be at most 32 KB.');
    const collection = createRegistry(existing).collection, chain = candidate?.Blockchain;
    if (candidate?.kind !== 'Gallery_Candidate_Only' || candidate.readyForProduction !== false || chain?.Chain_ID !== 56 ||
        !same(chain.Contract_Address, collection.contract) || !same(chain.Custody_Address || collection.custody, collection.custody)) {
        throw Error('Candidate must reference the existing BSC Mainnet collection and platform custody.');
    }
    if (!/^[1-6]$/.test(levelText || '')) throw Error('Level must be 1 through 6.');
    const entry = { assetId: candidate.Asset_ID, name: candidate.Name, tokenId: chain.Token_ID,
        mintHash: chain.Mint_TxHash, metadataURI: chain.Metadata_URI, imageURI: candidate.Image_URI,
        level: Number(levelText), priceMicro: amountMicro(priceText) };
    const normalized = createRegistry([entry]).assets[0];
    entry.mintHash = normalized.mintHash;
    if (chain.Asset_Key !== undefined && !same(chain.Asset_Key, normalized.assetKey)) throw Error('Candidate asset key mismatch.');
    const prior = existing.find(row => row.assetId === entry.assetId);
    if (prior) {
        const exact = keys => keys.every(key => prior[key] === entry[key]);
        if (!exact(Object.keys(entry))) throw Error('This asset already has a different approved configuration. It will not be overwritten.');
    } else createRegistry([...existing, entry]);
    return { entry, normalized, alreadyRegistered: Boolean(prior) };
}
function encodeRawCID(bytes) {
    const digest = crypto.createHash('sha256').update(bytes).digest();
    const source = Buffer.concat([Buffer.from([1, 0x55, 0x12, 32]), digest]);
    let accumulator = 0, bits = 0, text = 'b';
    for (const byte of source) {
        accumulator = (accumulator << 8) | byte; bits += 8;
        while (bits >= 5) { bits -= 5; text += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator >>> bits) & 31]; }
        accumulator &= (1 << bits) - 1;
    }
    if (bits) text += 'abcdefghijklmnopqrstuvwxyz234567'[(accumulator << (5 - bits)) & 31];
    return 'ipfs://' + text;
}
async function checkMetadata(entry, fetcher = fetch) {
    createRegistry.rawURI(entry.metadataURI); createRegistry.rawURI(entry.imageURI);
    const cid = entry.metadataURI.slice(7);
    const gateways = [`https://gateway.pinata.cloud/ipfs/${cid}`, `https://${cid}.ipfs.inbrowser.link/`,
        `https://${cid}.ipfs.dweb.link/`, `https://ipfs.io/ipfs/${cid}`];
    for (const gateway of gateways) {
        let reader;
        try {
            const response = await fetcher(gateway, { signal: AbortSignal.timeout(8000), credentials: 'omit', redirect: 'error' });
            if (!response.ok || !response.body) throw Error('Metadata gateway unavailable.');
            reader = response.body.getReader(); let length = 0; const chunks = [];
            for (;;) { const { done, value } = await reader.read(); if (done) break;
                length += value.byteLength; if (length > 131072) throw Error('Metadata exceeds 128 KiB.'); chunks.push(Buffer.from(value)); }
            const bytes = Buffer.concat(chunks);
            if (encodeRawCID(bytes) !== entry.metadataURI) throw Error('Metadata bytes do not match their raw CID.');
            const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (data?.name !== entry.name || data.image !== entry.imageURI) throw Error('Metadata name or image URI mismatch.');
            return { integrity: 'Raw_CID_SHA256_Verified', name: data.name, imageURI: data.image,
                limitation: 'Image bytes, image rights and long-term pinning are not established.' };
        } catch { /* Retry only fixed public gateways; never a candidate-provided HTTP URL. */ }
        finally { if (reader) await reader.cancel().catch(() => {}); }
    }
    throw Error('Metadata unavailable or mismatched at all four fixed gateways. Registry unchanged.');
}

module.exports = { amountMicro, reviewEntry, encodeRawCID, checkMetadata };
