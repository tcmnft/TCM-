'use strict';

module.exports = function createReservationGuards({ readMicro, toMoney }) {
    const bands = { 1: [50, 500], 2: [500, 2000], 3: [2000, 5000],
        4: [5000, 10000], 5: [10000, 20000], 6: [20000, null] };
    const error = message => Object.assign(new Error(message), { statusCode: 409, code: 'NFT_RESERVATION_REVIEW_REQUIRED' });
    function level(value) {
        if (!['number', 'string'].includes(typeof value) || !/^[1-6]$/.test(String(value))) {
            throw Object.assign(new Error('Select a valid NFT level from 1 to 6.'), { statusCode: 400 });
        }
        return Number(value);
    }
    function priceInBand(priceMicro, selectedLevel) {
        const [minimum, maximum] = bands[level(selectedLevel)];
        if (priceMicro < BigInt(minimum) * 1000000n || maximum !== null && priceMicro > BigInt(maximum) * 1000000n) {
            throw error('NFT price is outside its configured level range. Contact support.');
        }
        return priceMicro;
    }
    function eligible(user, selectedLevel) {
        const rank = Number(user.Rank ?? 0);
        if (user.Account_Deleted || ['Banned', 'Pending_Deletion'].includes(user.Status)) {
            throw Object.assign(new Error('This account cannot create a new reservation.'), { statusCode: 403 });
        }
        if (!Number.isInteger(rank) || rank < level(selectedLevel) || rank > 6) {
            throw Object.assign(new Error('Your verified membership rank does not allow this NFT level.'), { statusCode: 403 });
        }
    }
    function create({ uid, orderId, selectedLevel, principalMicro, nft, blockchain, source = 'Committed_Reservation' }) {
        priceInBand(principalMicro, selectedLevel);
        return { Version: 1, UID: uid, Order_ID: orderId, Level: level(selectedLevel),
            Principal: toMoney(principalMicro), Principal_micro: principalMicro.toString(),
            NFT_ID: String(nft.NFT_ID || nft.Name || 'TCM NFT'),
            Image_URL: String(nft.Image_URL || nft.image || 'https://i.ibb.co/3sZxCqT/nft-placeholder.jpg'),
            Blockchain: blockchain || null, Source: source };
    }
    function read(snapshot, uid, suppliedOrderId) {
        if (!snapshot || snapshot.Version !== 1 || snapshot.UID !== uid ||
            typeof snapshot.Order_ID !== 'string' || !snapshot.Order_ID || snapshot.Order_ID.length > 120 ||
            suppliedOrderId !== undefined && suppliedOrderId !== snapshot.Order_ID ||
            typeof snapshot.Principal_micro !== 'string' || !/^[1-9]\d{0,15}$/.test(snapshot.Principal_micro)) {
            throw error('Reservation identity needs review. Refresh your collection or contact support.');
        }
        const principalMicro = BigInt(snapshot.Principal_micro);
        if (readMicro(snapshot.Principal, 'reservation principal') !== principalMicro) throw error('Reservation principal mismatch.');
        priceInBand(principalMicro, snapshot.Level);
        return { snapshot, principalMicro, level: level(snapshot.Level), orderId: snapshot.Order_ID };
    }
    async function resolve(transaction, db, nft, docId, uid, suppliedOrderId) {
        if (nft.Reservation) return read(nft.Reservation, uid, suppliedOrderId);
        // Legacy recovery uses the latest committed reserve and its original ledger debit.
        // Gallery.Price is never used to reconstruct a missing principal.
        const query = db.collection('NFT_History').where('UID', '==', uid)
            .where('docId', '==', docId).where('Type', '==', 'NFT Reserve')
            .orderBy('timestamp', 'desc').limit(2);
        const rows = await transaction.get(query);
        if (rows.empty) throw error('Legacy reservation has no verifiable reserve record. Administrator review required.');
        const record = rows.docs[0].data();
        const millis = value => typeof value?.toMillis === 'function' ? value.toMillis() : null;
        if (rows.size > 1 && (millis(record.timestamp) === null || millis(record.timestamp) === millis(rows.docs[1].data().timestamp))) {
            throw error('Legacy reservation ordering is ambiguous. Administrator review required.');
        }
        if (record.UID !== uid || record.docId !== docId || record.Type !== 'NFT Reserve' ||
            !/^[A-Za-z0-9_-]{1,80}$/.test(record.Main_Ledger_Entry_ID || '')) {
            throw error('Legacy reservation is missing its original ledger link. Administrator review required.');
        }
        const ledgerRef = db.collection('Main_Balance_Ledgers').doc(uid).collection('Entries').doc(record.Main_Ledger_Entry_ID);
        const ledger = await transaction.get(ledgerRef);
        const sold = await transaction.get(db.collection('NFT_History').where('UID', '==', uid)
            .where('Order_ID', '==', record.Order_ID).where('Type', '==', 'NFT Sold').limit(1));
        const row = ledger.exists ? ledger.data() : null;
        const principalMicro = readMicro(record.Amount, 'legacy reservation principal');
        if (!row || !sold.empty || row.UID !== uid || row.Type !== 'NFT reservation' ||
            row.Reference !== record.Order_ID || row.Status !== 'Posted' ||
            readMicro(row.Balance_Old, 'legacy balance before') - readMicro(row.Balance_New, 'legacy balance after') !== principalMicro) {
            throw error('Legacy reservation debit cannot be reconciled. No funds changed; administrator review required.');
        }
        const snapshot = create({ uid, orderId: record.Order_ID, selectedLevel: record.NFT_Level,
            principalMicro, nft: record, blockchain: record.Blockchain, source: 'Legacy_Ledger_Verified' });
        return read(snapshot, uid, suppliedOrderId);
    }
    return { level, priceInBand, eligible, create, read, resolve };
};
