'use strict';

module.exports = function createMainnetGallery({ ethers, db, FieldValue, clearMarketCache, reviewedAssets }) {
    const createRegistry = require('./nft-mainnet-registry.cjs');
    const seed = reviewedAssets || require('./nft-mainnet-assets.json');
    let registry = createRegistry(seed), refreshedAt = 0, refreshFlight;
    const catalogRef = () => db.collection('NFT_Mainnet_Config').doc('approved-v1');
    function mergedRegistry(record) {
        if (record && (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length > 1000)) throw fail('Approved NFT catalog is invalid.', 503);
        const entries = [...seed];
        for (const entry of record?.entries || []) {
            const prior = entries.find(row => row.assetId === entry.assetId);
            if (prior) {
                if (!entryEqual(prior, entry)) throw fail('Approved NFT catalog conflicts with an existing asset.', 409);
            } else entries.push(entry);
        }
        return createRegistry(entries);
    }
    const fields = ['assetId', 'name', 'tokenId', 'mintHash', 'metadataURI', 'imageURI', 'level', 'priceMicro'];
    function entryEqual(a, b) { return fields.every(key => a[key] === b[key]); }
    async function refresh({ force = false } = {}) {
        if (!db || !force && Date.now() - refreshedAt < 30000) return;
        if (!refreshFlight) refreshFlight = (async () => {
            const saved = await catalogRef().get();
            registry = mergedRegistry(saved.exists ? saved.data() : null); refreshedAt = Date.now();
        })().finally(() => { refreshFlight = null; });
        return refreshFlight;
    }
    async function ensureReference(raw) {
        if (!registry.fromReference(raw)) await refresh({ force: true });
    }
    function adopt(record) { registry = mergedRegistry(record); refreshedAt = Date.now(); }
    function referenceFor(asset, snapshot) {
        if (snapshot.chainId !== '56' || !same(snapshot.contract, asset.contract) || snapshot.tokenId !== asset.tokenId ||
            !same(snapshot.hash, asset.mintHash) || snapshot.metadataURI !== asset.metadataURI ||
            snapshot.assetKey !== asset.assetKey || !same(snapshot.owner, asset.custody)) throw fail('Snapshot does not match its reviewed asset.');
        return { Chain_ID: 56, Contract_Address: asset.contract, Token_ID: asset.tokenId, Metadata_URI: asset.metadataURI,
            Mint_TxHash: asset.mintHash, Verification_Status: 'Verified_Mainnet_Snapshot',
            Custody_Address: asset.custody, Asset_Key: asset.assetKey, Verified_At: snapshot.checkedAt,
            Verification_Block: snapshot.snapshotBlockNumber, Verification_Block_Hash: snapshot.snapshotBlockHash };
    }
    async function verifyEntry(entry) {
        const asset = createRegistry([entry]).assets[0];
        if (!ethers) throw fail('Mainnet NFT verification is unavailable.', 503);
        const request = new ethers.FetchRequest(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
        request.timeout = 10000;
        const provider = new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
        let timer;
        try {
            const { verifyAssetMint } = await import('./nft-mainnet-verify.mjs');
            const proof = await Promise.race([
                verifyAssetMint(provider, require('./tcm-mainnet-artifact.json'), asset.deploymentHash, asset.mintHash, asset),
                new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Mainnet verification timed out.', 503)), 30000); })
            ]);
            referenceFor(asset, proof);
            return { ...proof, status: 'Verified_Mainnet_Snapshot' };
        } finally { clearTimeout(timer); provider.destroy(); }
    }
    // Keep the first-asset API compatible while all verification/cache state is keyed per reviewed asset.
    const identity = registry.byId('TCM-001');
    const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    const cache = new Map(), flights = new Map();
    const matches = raw => Boolean(registry.fromReference(raw));
    function assets() {
        return registry.assets.map(asset => ({ assetId: asset.assetId, name: asset.name, tokenId: asset.tokenId,
            level: asset.level, price: asset.price, priceMicro: asset.priceMicro,
            chainId: 56, contract: asset.contract, custody: asset.custody, assetKey: asset.assetKey, mintHash: asset.mintHash, metadataURI: asset.metadataURI, imageURI: asset.imageURI }));
    }
    async function verify({ fresh = false, assetId = identity.assetId } = {}) {
        const asset = registry.byId(assetId), saved = cache.get(assetId);
        if (!fresh && saved && Date.now() - saved.at < 30000) return { data: saved.data, source: 'cache' };
        if (!flights.has(assetId)) {
            const flight = (async () => {
                if (!ethers) throw fail('ethers is unavailable. Mainnet NFT verification is disabled.', 503);
                const request = new ethers.FetchRequest(process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/');
                request.timeout = 10000;
                const provider = new ethers.JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
                let timeout;
                try {
                    const operation = (async () => {
                        const { verifyAssetMint } = await import('./nft-mainnet-verify.mjs');
                        const artifact = require('./tcm-mainnet-artifact.json');
                        const result = await verifyAssetMint(provider, artifact, asset.deploymentHash, asset.mintHash,
                            { assetId, metadataURI: asset.metadataURI, tokenId: asset.tokenId, contract: asset.contract });
                        if (result.chainId !== '56' || !same(result.contract, asset.contract) || result.tokenId !== asset.tokenId ||
                            result.assetKey !== asset.assetKey || result.metadataURI !== asset.metadataURI ||
                            !same(result.owner, asset.custody)) throw fail('Mainnet NFT identity or custody mismatch.');
                        return { ...result, status: 'Verified_Mainnet_Snapshot', name: asset.name, imageURI: asset.imageURI,
                            sourceVerification: 'Not_Checked', verificationTTLSeconds: 30 };
                    })();
                    const result = await Promise.race([operation, new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(fail('Mainnet NFT verification timed out. No publication or financial change.', 503)), 30000);
                    })]);
                    cache.set(assetId, { data: result, at: Date.now() });
                    return { data: result, source: 'RPC' };
                } finally { clearTimeout(timeout); provider.destroy(); }
            })().finally(() => { flights.delete(assetId); });
            flights.set(assetId, flight);
        }
        return flights.get(assetId);
    }
    function reference(snapshot) {
        const asset = registry.byId(snapshot.assetId);
        if (!same(snapshot.contract, asset.contract) || snapshot.tokenId !== asset.tokenId ||
            !same(snapshot.hash, asset.mintHash) || snapshot.metadataURI !== asset.metadataURI ||
            snapshot.assetKey !== asset.assetKey || !same(snapshot.owner, asset.custody)) throw fail('Snapshot does not match its reviewed asset.');
        return { Chain_ID: 56, Contract_Address: asset.contract, Token_ID: asset.tokenId, Metadata_URI: asset.metadataURI,
            Mint_TxHash: asset.mintHash, Verification_Status: 'Verified_Mainnet_Snapshot',
            Custody_Address: asset.custody, Asset_Key: asset.assetKey,
            Verified_At: snapshot.checkedAt, Verification_Block: snapshot.snapshotBlockNumber,
            Verification_Block_Hash: snapshot.snapshotBlockHash };
    }
    async function verifyReference(raw) {
        const asset = registry.fromReference(raw);
        if (!asset) throw fail('This Mainnet NFT reference does not match a reviewed collection asset.');
        return (await verify({ assetId: asset.assetId })).data;
    }
    async function publish(req, res) {
        try {
            await refresh({ force: true });
            const asset = registry.byId(req.body?.assetId);
            if (req.body?.level !== asset.level || String(req.body?.price) !== String(asset.price)) {
                throw fail('Publication level and price must match the reviewed asset configuration.', 400);
            }
            const documentId = 'BSC_56_' + asset.contract.slice(2).toLowerCase() + '_' + asset.tokenId;
            const { data: snapshot } = await verify({ fresh: true, assetId: asset.assetId });
            const result = await db.runTransaction(async transaction => {
                const actor = await transaction.get(db.collection('Users').doc(req.authenticatedUid));
                if (!actor.exists || actor.data().Role !== 'Admin' || actor.data().Status !== 'Active' ||
                    actor.data().Account_Deleted || actor.data().Token !== req.authenticatedUserDoc.data().Token) {
                    throw fail('Active administrator required.', 403);
                }
                const ref = db.collection('NFT_Gallery').doc(documentId);
                const current = await transaction.get(ref);
                const priceState = await transaction.get(db.collection('NFT_Price_State').doc(documentId));
                const potentialDuplicates = await transaction.get(db.collection('NFT_Gallery')
                    .where('Blockchain.Token_ID', 'in', [asset.tokenId, Number(asset.tokenId)]).limit(21));
                if (potentialDuplicates.size > 20) throw fail('Duplicate review limit reached. Administrator reconciliation required.');
                for (const doc of potentialDuplicates.docs) {
                    const row = doc.data().Blockchain;
                    if (doc.id !== documentId && Number(row?.Chain_ID) === 56 && same(row.Contract_Address, asset.contract)) {
                        throw fail('This Mainnet token already has another Gallery record. Publication blocked.');
                    }
                }
                if (current.exists) {
                    const row = current.data();
                    if (registry.fromReference(row.Blockchain)?.assetId !== asset.assetId ||
                        !require('./nft-price-growth.cjs').existingListing(asset, row, priceState.exists ? priceState.data() : null)) {
                        throw fail('Existing Gallery record differs from this reviewed publication.');
                    }
                    return { id: documentId, alreadyPublished: true, status: row.Status, currentLevel: Number(row.Level), currentPrice: row.Price };
                }
                transaction.create(ref, { NFT_ID: asset.assetId, Asset_ID: asset.assetId, Name: asset.name,
                    Level: String(asset.level), Price: asset.price, Price_micro: asset.priceMicro,
                    Image_URI: asset.imageURI, Image_URL: 'https://gateway.pinata.cloud/ipfs/' + asset.imageURI.slice(7),
                    Status: 'Available', Owner_UID: '', Environment: 'BSC Mainnet',
                    Blockchain: reference(snapshot), Published_By: actor.id,
                    Published_At: FieldValue.serverTimestamp(), Reservation: null });
                transaction.create(db.collection('AdminLogs').doc(), { Actor_UID: actor.id,
                    Action_Type: 'Mainnet NFT Gallery Published', Target_ID: documentId,
                    Asset_ID: asset.assetId, Chain_ID: 56, Contract_Address: asset.contract, Token_ID: asset.tokenId,
                    Level: asset.level, Price: asset.price, Price_micro: asset.priceMicro,
                    Mint_TxHash: asset.mintHash, Verification_Checked_At: snapshot.checkedAt,
                    Date: new Date().toISOString(), timestamp: FieldValue.serverTimestamp() });
                return { id: documentId, alreadyPublished: false, status: 'Available' };
            });
            try { await clearMarketCache(); } catch { /* The committed Firestore listing is authoritative. */ }
            res.json({ success: true, data: result });
        } catch (error) {
            res.status([400, 403, 409, 503].includes(error.statusCode) ? error.statusCode : 503)
                .json({ success: false, message: error.message || 'Mainnet NFT publication unavailable.' });
        }
    }
    return { identity, assets, matches, verify, reference, verifyReference, publish,
        refresh, ensureReference, verifyEntry, referenceFor, catalogRef, mergedRegistry, adopt, entryEqual,
        assetFor: raw => registry.fromReference(raw) };
};
