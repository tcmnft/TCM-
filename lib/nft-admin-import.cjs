'use strict';

// Admin-only, durable candidate review. No signer, wallet key, money writer or mint call.
const crypto = require('node:crypto');
const createRegistry = require('./nft-mainnet-registry.cjs');
const candidateRules = require('./nft-candidate.cjs');
const fields = ['assetId', 'name', 'tokenId', 'mintHash', 'metadataURI', 'imageURI', 'level', 'priceMicro'];
const plainEntry = asset => Object.fromEntries(fields.map(key => [key, asset[key]]));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, statusCode = 409) => Object.assign(Error(message), { statusCode });

module.exports = function createImport({ db, FieldValue, gallery, clearMarketCache,
    checkMetadata = candidateRules.checkMetadata, now = Date.now }) {
    const busy = new Set();
    const ttl = 15 * 60 * 1000;
    const reviewRef = id => db.collection('NFT_Mainnet_Reviews').doc(id);
    function session(req) {
        const token = req.authenticatedUserDoc?.data()?.Token;
        if (typeof req.authenticatedUid !== 'string' || !req.authenticatedUid ||
            req.authenticatedUid.includes('/') || typeof token !== 'string' || !token) throw fail('Administrator login required.', 403);
        return { uid: req.authenticatedUid, token, sessionHash: digest(token) };
    }
    async function actor(transaction, auth) {
        const doc = await transaction.get(db.collection('Users').doc(auth.uid));
        const user = doc.exists && doc.data();
        if (!user || user.Role !== 'Admin' || user.Status !== 'Active' || user.Account_Deleted || user.Token !== auth.token) {
            throw fail('Active administrator session required.', 403);
        }
        return doc;
    }
    async function active(auth) { await db.runTransaction(t => actor(t, auth)); }
    function summary(proof) {
        return { chainId: proof.chainId, contract: proof.contract, tokenId: proof.tokenId, assetId: proof.assetId,
            owner: proof.owner, assetKey: proof.assetKey, hash: proof.hash, metadataURI: proof.metadataURI,
            checkedAt: proof.checkedAt, confirmations: proof.confirmations,
            snapshotBlockNumber: proof.snapshotBlockNumber, snapshotBlockHash: proof.snapshotBlockHash };
    }
    function fresh(asset, proof) {
        const stamp = Date.parse(proof.checkedAt), age = now() - stamp;
        if (!Number.isSafeInteger(proof.confirmations) || proof.confirmations < 3 ||
            !Number.isFinite(stamp) || age < -5000 || age > 30000) throw fail('Verification expired. Verify again.');
        return gallery.referenceFor(asset, proof);
    }
    function dto(asset) {
        return { ...plainEntry(asset), chainId: 56, contract: asset.contract, custody: asset.custody,
            assetKey: asset.assetKey, price: asset.price };
    }
    function reviewMatches(row, auth, body) {
        if (!row || row.version !== 1 || row.actorUid !== auth.uid || row.sessionHash !== auth.sessionHash ||
            row.plan?.version !== 1 || row.plan.actorUid !== auth.uid || !Number.isSafeInteger(row.plan.createdAt) ||
            row.plan.expiresAt !== row.plan.createdAt + ttl ||
            row.planSHA256 !== body.planSHA256 || digest(row.plan) !== row.planSHA256 ||
            !gallery.entryEqual(row.plan.entry, row.entry)) throw fail('Preview does not match this administrator session or approved plan.', 403);
        if (row.state !== 'Published' && (row.state !== 'Preview' || now() >= row.plan.expiresAt)) {
            throw fail('Preview expired. Verify this candidate again.');
        }
    }
    async function limits(auth, task) {
        if (busy.has(auth.uid) || busy.size >= 4) throw fail('NFT verification is busy. Please wait and retry.', 429);
        busy.add(auth.uid);
        try { return await task(); } finally { busy.delete(auth.uid); }
    }
    function error(res, err) {
        res.status([400, 403, 409, 413, 429, 503].includes(err.statusCode) ? err.statusCode : 503)
            .json({ success: false, message: err.message || 'NFT review unavailable. No confirmed publication.' });
    }
    async function preview(req, res) {
        try {
            const auth = session(req);
            const result = await limits(auth, async () => {
                await active(auth);
                const body = req.body;
                if (!body || typeof body.price !== 'string' || !Number.isInteger(body.level)) throw fail('Choose a level and enter a decimal price.', 400);
                if (!body.candidate || Buffer.byteLength(JSON.stringify(body.candidate), 'utf8') > 32768) throw fail('Candidate must be at most 32 KB.', 413);
                await gallery.refresh({ force: true });
                let reviewed;
                try { reviewed = candidateRules.reviewEntry(body.candidate, String(body.level), body.price, gallery.assets().map(plainEntry)); }
                catch (err) { throw fail(err.message, 400); }
                const { entry, normalized: asset } = reviewed;
                // Imported verificationSnapshot, URLs and status labels are never evidence.
                const metadata = await checkMetadata(entry);
                const proof = await gallery.verifyEntry(entry);
                fresh(asset, proof);
                const id = crypto.randomUUID(), createdAt = now();
                const plan = { version: 1, actorUid: auth.uid, entry, createdAt, expiresAt: createdAt + ttl,
                    action: 'Approve this NFT configuration and create one off-chain Gallery listing. No mint, transfer or financial credit.' };
                const planSHA256 = digest(plan);
                await db.runTransaction(async t => {
                    await actor(t, auth);
                    const saved = await t.get(gallery.catalogRef());
                    const merged = gallery.mergedRegistry(saved.exists ? saved.data() : null);
                    candidateRules.reviewEntry(body.candidate, String(body.level), body.price, merged.assets.map(plainEntry));
                    fresh(asset, proof);
                    t.create(reviewRef(id), { version: 1, actorUid: auth.uid, sessionHash: auth.sessionHash,
                        entry, plan, planSHA256, state: 'Preview', verification: summary(proof),
                        Metadata_Integrity: metadata.integrity, Created_At: FieldValue.serverTimestamp() });
                });
                return { reviewId: id, planSHA256, asset: dto(asset), verification: summary(proof), metadata,
                    expiresAt: plan.expiresAt, action: plan.action };
            });
            res.json({ success: true, data: result });
        } catch (err) { error(res, err); }
    }
    async function publish(req, res) {
        try {
            const auth = session(req), body = req.body;
            if (!body || typeof body.reviewId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.reviewId) ||
                typeof body.planSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.planSHA256)) throw fail('A verified preview and exact plan are required.', 400);
            const result = await limits(auth, async () => {
                await active(auth);
                const saved = await reviewRef(body.reviewId).get();
                if (!saved.exists) throw fail('Preview not found. Verify the candidate again.');
                const row = saved.data(); reviewMatches(row, auth, body);
                const asset = createRegistry([row.entry]).assets[0];
                let proof;
                if (row.state !== 'Published') {
                    await checkMetadata(row.entry);
                    proof = await gallery.verifyEntry(row.entry);
                    fresh(asset, proof);
                }
                const output = await db.runTransaction(async t => {
                    await actor(t, auth);
                    const currentReview = await t.get(reviewRef(body.reviewId));
                    const currentRow = currentReview.exists ? currentReview.data() : null;
                    reviewMatches(currentRow, auth, body);
                    if (!gallery.entryEqual(currentRow.entry, row.entry)) throw fail('Preview entry changed. Verify again.');
                    const savedCatalog = await t.get(gallery.catalogRef());
                    const catalog = savedCatalog.exists ? savedCatalog.data() : null;
                    const merged = gallery.mergedRegistry(catalog);
                    const existing = merged.assets.map(plainEntry);
                    const prior = existing.find(entry => entry.assetId === asset.assetId);
                    if (prior && !gallery.entryEqual(prior, row.entry)) throw fail('This NFT already has a different approved configuration.');
                    if (!prior) createRegistry([...existing, row.entry]);
                    const documentId = 'BSC_56_' + asset.contract.slice(2).toLowerCase() + '_' + asset.tokenId;
                    const listingRef = db.collection('NFT_Gallery').doc(documentId);
                    const listing = await t.get(listingRef);
                    const priceState = await t.get(db.collection('NFT_Price_State').doc(documentId));
                    const duplicates = await t.get(db.collection('NFT_Gallery')
                        .where('Blockchain.Token_ID', 'in', [asset.tokenId, Number(asset.tokenId)]).limit(21));
                    if (duplicates.size > 20) throw fail('Duplicate review limit reached. Administrator reconciliation required.');
                    for (const doc of duplicates.docs) {
                        const chain = doc.data().Blockchain;
                        if (doc.id !== documentId && Number(chain?.Chain_ID) === 56 &&
                            String(chain.Contract_Address).toLowerCase() === asset.contract.toLowerCase()) throw fail('This token already has another Gallery record.');
                    }
                    if (listing.exists) {
                        const data = listing.data();
                        if (!createRegistry([row.entry]).fromReference(data.Blockchain) || data.Asset_ID !== asset.assetId ||
                            !require('./nft-price-growth.cjs').existingListing(asset, data, priceState.exists ? priceState.data() : null) ||
                            data.Image_URI !== asset.imageURI || data.Name !== asset.name) throw fail('Existing Gallery record differs. No listing will be overwritten.');
                    }
                    if (currentRow.state === 'Published') {
                        if (!listing.exists || !prior) throw fail('Published record needs administrator reconciliation.');
                        return { id: documentId, assetId: asset.assetId, alreadyPublished: true, status: listing.data().Status, currentLevel: Number(listing.data().Level), currentPrice: listing.data().Price, catalog };
                    }
                    const blockchain = fresh(asset, proof);
                    const nextCatalog = catalog || { version: 1, entries: [] };
                    if (!prior) {
                        // One shared document makes asset/token/hash uniqueness transactional across workers.
                        nextCatalog.entries = [...nextCatalog.entries, row.entry];
                        t.set(gallery.catalogRef(), { ...nextCatalog, Updated_By: auth.uid, Updated_At: FieldValue.serverTimestamp() });
                    }
                    if (!listing.exists) t.create(listingRef, { NFT_ID: asset.assetId, Asset_ID: asset.assetId, Name: asset.name,
                        Level: String(asset.level), Price: asset.price, Price_micro: asset.priceMicro,
                        Image_URI: asset.imageURI, Image_URL: 'https://gateway.pinata.cloud/ipfs/' + asset.imageURI.slice(7),
                        Status: 'Available', Owner_UID: '', Environment: 'BSC Mainnet', Blockchain: blockchain,
                        Published_By: auth.uid, Published_At: FieldValue.serverTimestamp(), Reservation: null });
                    t.update(reviewRef(body.reviewId), { state: 'Published', documentId,
                        verification: summary(proof), Published_At: FieldValue.serverTimestamp() });
                    t.create(db.collection('AdminLogs').doc(), { Actor_UID: auth.uid,
                        Action_Type: 'Mainnet NFT Candidate Approved And Published', Target_ID: documentId,
                        Review_ID: body.reviewId, Plan_SHA256: body.planSHA256, Asset_ID: asset.assetId,
                        Chain_ID: 56, Contract_Address: asset.contract, Token_ID: asset.tokenId,
                        Level: asset.level, Price: asset.price, Price_micro: asset.priceMicro, Mint_TxHash: asset.mintHash,
                        Verification_Checked_At: proof.checkedAt, Date: new Date(now()).toISOString(), timestamp: FieldValue.serverTimestamp() });
                    return { id: documentId, assetId: asset.assetId, alreadyPublished: listing.exists,
                        status: listing.exists ? listing.data().Status : 'Available', currentLevel: listing.exists ? Number(listing.data().Level) : asset.level,
                        currentPrice: listing.exists ? listing.data().Price : asset.price, catalog: nextCatalog };
                });
                gallery.adopt(output.catalog);
                try { await clearMarketCache(); } catch { /* Publication is committed; same preview retry is idempotent. */ }
                const { catalog, ...publicResult } = output;
                return publicResult;
            });
            res.json({ success: true, data: result });
        } catch (err) { error(res, err); }
    }
    return { preview, publish };
};
