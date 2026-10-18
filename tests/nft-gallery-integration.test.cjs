'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ethers = require('ethers');
const createGuards = require('../lib/nft-reservation-guards.cjs');
const createGallery = require('../lib/nft-mainnet-gallery.cjs');
const artifact = require('../lib/tcm-mainnet-artifact.json');
const readMicro = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('Invalid money');
    return BigInt(Math.round(value * 1000000));
};
const toMoney = value => Number(value) / 1000000;
const guards = createGuards({ readMicro, toMoney });
const identity = createGallery({}).identity;
const ref = { Chain_ID: 56, Contract_Address: identity.contract, Token_ID: '1', Metadata_URI: identity.metadataURI,
    Mint_TxHash: identity.mintHash, Verification_Status: 'Verified_Mainnet_Snapshot', Verified_At: '2026-10-17T12:29:50.131Z' };
const keyAt = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const timestamp = value => ({ toMillis: () => value });
function database(initial = {}) {
    const rows = new Map(Object.entries(initial)), operations = [];
    let sequence = 0;
    function snapshot(name) {
        return { id: name.split('/').at(-1), ref: document(name), exists: rows.has(name), data: () => rows.get(name) };
    }
    function document(name) {
        return { path: name, id: name.split('/').at(-1), collection: sub => collection(name + '/' + sub),
            get: async () => snapshot(name) };
    }
    function collection(name, filters = [], orders = [], cap = Infinity) {
        return { path: name, filters, orders, cap,
            doc: id => document(name + '/' + (id || 'generated_' + ++sequence)),
            where: (field, op, value) => collection(name, [...filters, [field, op, value]], orders, cap),
            orderBy: (field, direction = 'asc') => collection(name, filters, [...orders, [field, direction]], cap),
            limit: limit => collection(name, filters, orders, limit),
            get: async () => {
                operations.push({ kind: 'query', name, filters, cap });
                let names = [...rows.keys()].filter(key => key.startsWith(name + '/') && key.slice(name.length + 1).indexOf('/') < 0);
                names = names.filter(key => filters.every(([field, op, expected]) => {
                    const value = keyAt(rows.get(key), field);
                    if (op === '==') return value === expected;
                    if (op === '<=') return value <= expected;
                    if (op === 'in') return expected.includes(value);
                    throw Error('Unexpected query operator ' + op);
                }));
                for (const [field, direction] of [...orders].reverse()) names.sort((a, b) => {
                    const normalize = value => typeof value?.toMillis === 'function' ? value.toMillis() : value;
                    const left = normalize(keyAt(rows.get(a), field)), right = normalize(keyAt(rows.get(b), field));
                    return (left < right ? -1 : left > right ? 1 : 0) * (direction === 'desc' ? -1 : 1);
                });
                const docs = names.slice(0, cap).map(snapshot);
                return { docs, empty: !docs.length, size: docs.length, forEach: fn => docs.forEach(fn) };
            }
        };
    }
    function updateRow(current, changes) {
        const next = { ...current };
        for (const [key, value] of Object.entries(changes)) {
            if (key.includes('.')) {
                const [parent, child] = key.split('.'); next[parent] = { ...next[parent] };
                next[parent][child] = value?.increment !== undefined ? (next[parent][child] || 0) + value.increment : value;
            } else next[key] = value;
        }
        return next;
    }
    const db = { collection, rows, operations,
        async runTransaction(fn) {
            const writes = []; let writing = false;
            const transaction = {
                async get(target) { assert.equal(writing, false, 'Firestore reads must precede every write'); return target.get(); },
                update(target, data) { writing = true; writes.push(['update', target.path, data]); },
                set(target, data) { writing = true; writes.push(['set', target.path, data]); },
                create(target, data) { writing = true; writes.push(['create', target.path, data]); }
            };
            const result = await fn(transaction);
            for (const [mode, name, data] of writes) {
                if (mode === 'create') assert(!rows.has(name), 'create conflict');
                if (mode === 'update') assert(rows.has(name), 'update missing document');
                rows.set(name, mode === 'update' ? updateRow(rows.get(name), data) : data);
            }
            operations.push(...writes.map(([kind, name]) => ({ kind, name })));
            return result;
        }
    };
    return db;
}
const FieldValue = { increment: value => ({ increment: value }), serverTimestamp: () => timestamp(Date.now()) };
function response() { return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, set() {} }; }

test('level bands and 501 USDT Level 2 are checked without changing the displayed boundaries', () => {
    for (const [level, min, max] of [[1, 50, 500], [2, 500, 2000], [3, 2000, 5000], [4, 5000, 10000], [5, 10000, 20000], [6, 20000, null]]) {
        guards.priceInBand(readMicro(min), level);
        if (max) guards.priceInBand(readMicro(max), level);
        assert.throws(() => guards.priceInBand(readMicro(min - 1), level));
        if (max) assert.throws(() => guards.priceInBand(readMicro(max + 1), level));
    }
    guards.priceInBand(501000000n, 2);
    for (const level of [null, 0, 7, '2x', [], {}, 2.5]) assert.throws(() => guards.level(level));
});
test('membership rank and closure restrictions are enforced on the server', () => {
    guards.eligible({ Rank: 2, Status: 'Active' }, 2);
    for (const user of [{ Rank: 1 }, { Rank: 0 }, { Rank: 2.5 }, { Rank: 2, Status: 'Pending_Deletion' },
        { Rank: 2, Status: 'Banned' }, { Rank: 2, Account_Deleted: true }]) assert.throws(() => guards.eligible(user, 2));
});
test('reservation snapshot rejects a different order, user, principal or level', () => {
    const snapshot = guards.create({ uid: 'U', orderId: 'NFT-1', selectedLevel: 2, principalMicro: 501000000n, nft: { Name: 'TCM' }, blockchain: ref });
    assert.equal(guards.read(snapshot, 'U', 'NFT-1').principalMicro, 501000000n);
    for (const [data, uid, order] of [[snapshot, 'V', 'NFT-1'], [snapshot, 'U', 'NFT-2'], [{ ...snapshot, Principal: 502 }, 'U', 'NFT-1'],
        [{ ...snapshot, Level: 3 }, 'U', 'NFT-1']]) assert.throws(() => guards.read(data, uid, order));
});

function routes(initial, options = {}) {
    const db = database(initial), handlers = new Map(), cache = new Map(), clear = [];
    const registry = require('../lib/nft-mainnet-registry.cjs')(options.reviewedAssets);
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const slice = server.slice(server.indexOf('// NFT MAINNET GALLERY START:'), server.indexOf("const cron = require('node-cron');"));
    const context = { console, Date, setTimeout, clearTimeout, Promise, Map, Set, BigInt,
        db, FieldValue, hdEthers: ethers, app: { get: (url, fn) => handlers.set('GET ' + url, fn), post: (url, fn) => handlers.set('POST ' + url, fn) },
        require(name) {
            if (name.includes('nft-price-growth')) return options.growthPolicy || {};
            if (name.includes('nft-admin-import')) return () => ({});
            if (name.includes('nft-reservation-guards')) return createGuards;
            if (name.includes('nft-mainnet-gallery')) return () => ({ identity,
                matches: raw => Boolean(registry.fromReference(raw)),
                verifyReference: async raw => {
                    const asset = registry.fromReference(raw);
                    if (!asset) throw Error('Unreviewed identity');
                    if (options.verifyReference) await options.verifyReference(db);
                    return { ...asset, hash: asset.mintHash, owner: asset.custody, checkedAt: new Date().toISOString() };
                },
                reference: snapshot => ({ ...ref, Token_ID: snapshot.tokenId, Metadata_URI: snapshot.metadataURI,
                    Mint_TxHash: snapshot.hash, Asset_Key: snapshot.assetKey, Custody_Address: identity.custody }) });
            throw Error('Unexpected dependency ' + name);
        },
        redisClient: { isReady: true, async del(key) { cache.delete(key); } },
        getCache: async key => cache.get(key), setCache: async (key, value) => { cache.set(key, value); },
        clearUserCache: async uid => { clear.push(uid); },
        m1RequireAdmin: () => true, m2NFTCycle: () => ({ key: '2026-10-17' }),
        m2CheckNFTCycle: async (_t, wallet) => { if (wallet.Last_NFT_Reserve_Cycle === '2026-10-17') throw Error('Daily Limit Reached'); },
        moneyV1ReadLegacy: value => ({ micro: readMicro(value) }), admS2Scale: 1000000n,
        admS2Money: toMoney, admS2Micro: readMicro, admS2Balance: (wallet, field) => readMicro(wallet[field] || 0),
        admS2Error: (message, statusCode) => Object.assign(Error(message), { statusCode }),
        moneyV7Amount: (row, field, micro) => {
            const value = readMicro(row[field]); if (row[micro] !== undefined) assert.equal(row[micro], value.toString()); return value;
        },
        moneyV7Updates: (_old, changes) => changes, moneyV7NextView: (wallet, updates) => ({ ...wallet, ...updates }),
        calculateRankUpdates: () => ({}), generateOrderId: () => 'NFT-SERVER-ORDER', parseSafeTimestamp: value => value?.toMillis?.() || Date.parse(value) || 0,
        incomeDayStates: new WeakMap(),
        moneyV4NFTDailyUpdates: (_t, _ref, wallet, amounts) => Object.fromEntries(Object.entries(amounts).map(([field, value]) => [field, toMoney(readMicro(wallet[field] || 0) + readMicro(value))]))
    };
    vm.createContext(context);
    // Run the real audit writers and NFT handlers; never load the production server.
    const audit = server.slice(server.indexOf('function t8MainEntry('), server.indexOf('function moneyV4NFTDailyUpdates('));
    const display = server.slice(server.indexOf('const t9AttemptAudits ='), server.indexOf('function admS2Level('));
    vm.runInContext(display + '\n' + audit + '\n' + slice, context);
    async function call(url, body = {}, uid = 'U', method = 'POST') {
        const res = response(), req = { body, query: body, authenticatedUid: uid };
        await handlers.get(method + ' ' + url)(req, res); return res;
    }
    return { db, call, cache, clear };
}
function baseRows() {
    return { 'Users/U': { Rank: 2, Status: 'Active', Sponsor_A: 'A', Sponsor_B: 'B', Sponsor_C: 'C', counters: { txCount: 0, activeReservations: 0 } },
        'Wallets/U': { Main_Balance: 1000, Locked_Balance: 0, Daily_Reserve: 0, Daily_Comp: 0, Total_Reserve: 0, Total_Comp: 0 },
        'Wallets/A': { Main_Balance: 0 }, 'Wallets/B': { Main_Balance: 0 }, 'Wallets/C': { Main_Balance: 0 },
        'NFT_Gallery/N': { NFT_ID: 'TCM-001', Name: 'TCM NFT 001', Level: '2', Price: 501, Price_micro: '501000000', Status: 'Available', Owner_UID: '', Blockchain: ref } };
}

test('real reserve/sell handlers use the same 501 principal after a Gallery price/level edit and preserve fee/team math', async () => {
    const f = routes(baseRows()); f.cache.set('global_nft_market', ['stale']);
    let res = await f.call('/api/nft/reserve', { level: 2, uid: 'U' });
    assert.equal(res.body.success, true, res.body.message); assert.equal(res.body.nftData.price, 501);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 499); assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 501);
    assert.equal(f.cache.has('global_nft_market'), false);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Reservation.Principal_micro, '501000000');
    f.db.rows.set('NFT_Gallery/N', { ...f.db.rows.get('NFT_Gallery/N'), Price: 1999, Price_micro: '1999000000', Level: '6' });
    res = await f.call('/api/nft/sell', { uid: 'U', docId: 'N', orderId: 'NFT-SERVER-ORDER' });
    assert.equal(res.body.success, true, res.body.message);
    assert.deepEqual(JSON.parse(JSON.stringify(res.body.data)), { principal: 501, net: 7.13, ret: 508.13, fee: 1.89, gross: 9.02 });
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1007.13);
    assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 0);
    assert.equal(f.db.rows.get('Wallets/A').Main_Balance, 1.08); assert.equal(f.db.rows.get('Wallets/B').Main_Balance, 0.54); assert.equal(f.db.rows.get('Wallets/C').Main_Balance, 0.27);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status, 'Available'); assert.equal(f.db.rows.get('NFT_Gallery/N').Reservation, null);
    const sold = [...f.db.rows.values()].find(row => row.Type === 'NFT Sold');
    assert.equal(sold.Order_ID, 'NFT-SERVER-ORDER'); assert.equal(sold.Principal_micro, '501000000'); assert.equal(sold.Balance_Source, 'Committed_Record');
    const before = f.db.rows.get('Wallets/U').Main_Balance;
    res = await f.call('/api/nft/sell', { docId: 'N', orderId: 'NFT-SERVER-ORDER' });
    assert.equal(res.body.success, false); assert.equal(f.db.rows.get('Wallets/U').Main_Balance, before);
});
test('real reserve handler rejects low rank, wrong user, invalid level, wrong band and pending deletion without money writes', async t => {
    for (const mode of ['rank', 'uid', 'level', 'band', 'deletion']) await t.test(mode, async () => {
        const rows = baseRows(), body = { level: 2, uid: 'U' };
        if (mode === 'rank') rows['Users/U'].Rank = 1;
        if (mode === 'uid') body.uid = 'V';
        if (mode === 'level') body.level = 7;
        if (mode === 'band') { rows['NFT_Gallery/N'].Price = 499; rows['NFT_Gallery/N'].Price_micro = '499000000'; }
        if (mode === 'deletion') rows['Users/U'].Status = 'Pending_Deletion';
        const f = routes(rows), res = await f.call('/api/nft/reserve', body);
        assert.equal(res.body.success, false); assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1000);
        assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
    });
});
test('real sell rejects a stale client order and history reads reject a different UID', async () => {
    const f = routes(baseRows()); await f.call('/api/nft/reserve', { level: 2 });
    const res = await f.call('/api/nft/sell', { docId: 'N', orderId: 'OLD-ORDER' });
    assert.equal(res.body.success, false); assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 501);
    const history = await f.call('/api/nft/history', { uid: 'V' }, 'U', 'GET'); assert.equal(history.statusCode, 403);
});
test('legacy cooldown recovery releases only unowned, cleared records and never runs an idle timer', async () => {
    const rows = baseRows(); rows['NFT_Gallery/N'].Status = 'Cooldown'; rows['NFT_Gallery/N'].Next_Available_Time = Date.now() - 1;
    rows['NFT_Gallery/unsafe'] = { Status: 'Cooldown', Owner_UID: 'U', Next_Available_Time: Date.now() - 1 };
    const f = routes(rows); await f.call('/api/nft/market', {}, 'U', 'GET');
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status, 'Available'); assert.equal(f.db.rows.get('NFT_Gallery/unsafe').Status, 'Cooldown');
    const cooldown = f.db.operations.find(op => op.kind === 'query' && op.filters.some(filter => filter[2] === 'Cooldown'));
    assert.equal(cooldown.cap, 20);
});
test('legacy resolution uses the historical debit, never mutable Gallery.Price, and refuses missing or sold evidence', async t => {
    for (const mode of ['valid', 'missing-ledger', 'sold', 'bad-debit']) await t.test(mode, async () => {
        const rows = baseRows(); rows['NFT_Gallery/N'] = { ...rows['NFT_Gallery/N'], Status: 'Reserved', Owner_UID: 'U', Price: 1999 };
        rows['Wallets/U'] = { ...rows['Wallets/U'], Main_Balance: 499, Locked_Balance: 501 };
        rows['NFT_History/old'] = { UID: 'U', docId: 'N', Type: 'NFT Reserve', Amount: 501, NFT_Level: 2, Order_ID: 'OLD', NFT_ID: 'TCM-001', Main_Ledger_Entry_ID: 'debit', timestamp: timestamp(10) };
        if (mode !== 'missing-ledger') rows['Main_Balance_Ledgers/U/Entries/debit'] = { UID: 'U', Type: 'NFT reservation', Reference: 'OLD', Status: 'Posted', Balance_Old: 1000, Balance_New: mode === 'bad-debit' ? 500 : 499 };
        if (mode === 'sold') rows['NFT_History/sold'] = { UID: 'U', Order_ID: 'OLD', Type: 'NFT Sold' };
        const f = routes(rows), result = await f.call('/api/nft/sell', { docId: 'N', orderId: 'OLD' });
        assert.equal(result.body.success, mode === 'valid', result.body.message);
        if (mode === 'valid') assert.equal(result.body.data.principal, 501);
        else assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 499);
    });
});

const iface = new ethers.Interface(artifact.abi);

test('a reviewed second Level 1 asset reserves and settles with its own identity and principal', async () => {
    const first = require('../lib/nft-mainnet-assets.json')[0];
    const second = { ...first, assetId: 'TCM-002', name: 'TCM NFT 002', tokenId: '2', level: 1,
        priceMicro: '50000000', mintHash: '0x' + '88'.repeat(32), metadataURI: first.imageURI };
    const rows = baseRows();
    rows['NFT_Gallery/SECOND'] = { ...rows['NFT_Gallery/N'], NFT_ID: second.assetId, Name: second.name,
        Level: '1', Price: 50, Price_micro: second.priceMicro,
        Blockchain: { ...ref, Token_ID: '2', Mint_TxHash: second.mintHash, Metadata_URI: second.metadataURI } };
    const f = routes(rows, { reviewedAssets: [first, second] });
    const reserve = await f.call('/api/nft/reserve', { level: 1 });
    assert.equal(reserve.body.success, true, reserve.body.message);
    const saved = f.db.rows.get('NFT_Gallery/SECOND');
    assert.equal(saved.Reservation.Principal_micro, '50000000');
    assert.equal(saved.Reservation_Blockchain.Token_ID, '2');
    assert.equal(saved.Reservation_Blockchain.Mint_TxHash, second.mintHash);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status, 'Available');
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 950);
    const sell = await f.call('/api/nft/sell', { docId: 'SECOND', orderId: reserve.body.nftData.orderId });
    assert.equal(sell.body.success, true, sell.body.message);
    assert.equal(sell.body.data.principal, 50);
    assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 0);
    assert.equal(f.db.rows.get('NFT_Gallery/SECOND').Status, 'Available');
    assert.equal(sell.body.orderReceipt.sale.Blockchain.Token_ID, '2');
    assert.equal(sell.body.orderReceipt.sale.Blockchain.Asset_Key, ethers.keccak256(ethers.toUtf8Bytes(second.assetId)));
});

test('changing a selected NFT into another reviewed token before commit cannot reuse the first proof', async () => {
    const first = require('../lib/nft-mainnet-assets.json')[0];
    const second = { ...first, assetId: 'TCM-002', name: 'TCM NFT 002', tokenId: '2',
        mintHash: '0x' + '88'.repeat(32), metadataURI: first.imageURI };
    const f = routes(baseRows(), { reviewedAssets: [first, second], verifyReference: async db => {
        const row = db.rows.get('NFT_Gallery/N');
        db.rows.set('NFT_Gallery/N', { ...row, Blockchain: { ...ref,
            Token_ID: '2', Metadata_URI: second.metadataURI, Mint_TxHash: second.mintHash } });
    } });
    const result = await f.call('/api/nft/reserve', { level: 2 });
    assert.equal(result.body.success, false); assert.match(result.body.message, /identity changed/);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1000);
    assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
});

test('Mainnet-only reservations refuse legacy stock without a fallback query or balance changes', async t => {
    for (const mode of ['legacy-only', 'legacy-level-one', 'reserved-mainnet']) await t.test(mode, async () => {
        const rows = baseRows();
        rows['NFT_Gallery/legacy'] = { NFT_ID: 'OLD', Level: mode === 'legacy-level-one' ? '1' : '2',
            Status: 'Available', Owner_UID: '', Price: 100, Price_micro: '100000000' };
        if (mode === 'legacy-only') delete rows['NFT_Gallery/N'];
        if (mode === 'reserved-mainnet') rows['NFT_Gallery/N'].Status = 'Reserved';
        const f = routes(rows), result = await f.call('/api/nft/reserve', { level: mode === 'legacy-level-one' ? 1 : 2 });
        assert.equal(result.statusCode, 503);
        assert.equal(result.body.message, 'No verified Mainnet NFT available for this level.');
        assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1000);
        assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 0);
        assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
        const selections = f.db.operations.filter(op => op.kind === 'query' && op.filters.some(filter => filter[2] === 'Available'));
        assert.equal(selections.length, 1);
        assert(selections[0].filters.some(filter => filter[0] === 'Blockchain.Verification_Status' && filter[2] === 'Verified_Mainnet_Snapshot'));
    });
});

test('Mainnet-only reservations reject forged verification labels and unsupported identities without writes', async t => {
    for (const change of [{ Chain_ID: 97 }, { Token_ID: '2' }, { Contract_Address: ethers.ZeroAddress },
        { Metadata_URI: 'ipfs://wrong' }, { Mint_TxHash: '0x' + '11'.repeat(32) }]) await t.test(Object.keys(change)[0], async () => {
        const rows = baseRows(); rows['NFT_Gallery/N'].Blockchain = { ...ref, ...change };
        const f = routes(rows), result = await f.call('/api/nft/reserve', { level: 2 });
        assert.equal(result.body.success, false);
        assert.match(result.body.message, /Mainnet identity is not supported/);
        assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
    });
});

test('Mainnet-only transaction rechecks verification and identity after the RPC check', async t => {
    for (const change of [{ Verification_Status: 'Unverified' }, { Chain_ID: 97 }, { Token_ID: '2' }]) await t.test(Object.keys(change)[0], async () => {
        const f = routes(baseRows(), { verifyReference: async db => {
            const row = db.rows.get('NFT_Gallery/N');
            db.rows.set('NFT_Gallery/N', { ...row, Blockchain: { ...ref, ...change } });
        } });
        const result = await f.call('/api/nft/reserve', { level: 2 });
        assert.equal(result.body.success, false);
        assert.match(result.body.message, /identity changed/);
        assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1000);
        assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
    });
});

test('Mainnet RPC failure cannot fall back to available legacy stock or debit money', async () => {
    const rows = baseRows(); rows['NFT_Gallery/legacy'] = { Level: '2', Status: 'Available', Price: 501 };
    const f = routes(rows, { verifyReference: async () => { throw Error('RPC unavailable'); } });
    const result = await f.call('/api/nft/reserve', { level: 2 });
    assert.equal(result.body.success, false); assert.match(result.body.message, /RPC unavailable/);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1000);
    assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
});

test('an existing off-chain reservation can still settle after Mainnet-only selection is enabled', async () => {
    const rows = baseRows();
    rows['NFT_Gallery/N'] = { ...rows['NFT_Gallery/N'], Blockchain: null, Status: 'Reserved', Owner_UID: 'U',
        Reservation: guards.create({ uid: 'U', orderId: 'OLD', selectedLevel: 2, principalMicro: 501000000n,
            nft: rows['NFT_Gallery/N'], blockchain: null }) };
    rows['Wallets/U'] = { ...rows['Wallets/U'], Main_Balance: 499, Locked_Balance: 501 };
    const f = routes(rows), result = await f.call('/api/nft/sell', { docId: 'N', orderId: 'OLD' });
    assert.equal(result.body.success, true, result.body.message);
    assert.equal(result.body.data.principal, 501);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance, 1007.13);
    assert.equal(f.db.rows.get('Wallets/U').Locked_Balance, 0);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status, 'Available');
    const denied = await f.call('/api/nft/reserve', { level: 2 });
    assert.equal(denied.body.success, false); assert.match(denied.body.message, /No verified Mainnet NFT/);
});

function verifiedEthers(mode = 'ok') {
    const mintBlock = '0x' + '55'.repeat(32), deploymentBlock = '0x' + '44'.repeat(32), headHash = '0x' + '66'.repeat(32);
    class Provider {
        async send(method) { assert.equal(method, 'eth_chainId'); return mode === 'testnet' ? '0x61' : '0x38'; }
        async getNetwork() { return { chainId: 56n }; }
        async getTransaction(hash) {
            const deploy = hash === identity.deploymentHash;
            return { hash, chainId: 56n, from: identity.custody, to: deploy ? null : '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
                type: deploy ? 0 : 4, nonce: deploy ? 0 : 1, value: 0n, blockNumber: deploy ? 100 : 200,
                blockHash: deploy ? deploymentBlock : mintBlock,
                data: deploy ? artifact.bytecode + iface.encodeDeploy([identity.custody]).slice(2) : '0x1234' };
        }
        async getTransactionReceipt(hash) {
            const deploy = hash === identity.deploymentHash;
            const logs = [iface.encodeEventLog(iface.getEvent('Transfer'), [ethers.ZeroAddress, identity.custody, 1n]),
                iface.encodeEventLog(iface.getEvent('AssetMinted'), [identity.assetKey, 1n, identity.custody, identity.metadataURI])]
                .map(log => ({ ...log, address: identity.contract }));
            return { hash, status: mode === 'failed' && !deploy ? 0 : 1, contractAddress: deploy ? identity.contract : null,
                blockNumber: deploy ? 100 : 200, blockHash: deploy ? deploymentBlock : mintBlock, logs: deploy || mode === 'no-logs' ? [] : logs };
        }
        async getBlock(number) { return { number: number === 'latest' ? 1000 : number, hash: number === 100 ? deploymentBlock : number === 200 ? mintBlock : headHash }; }
        async getCode() { return '0x1234'; }
        async call(tx) {
            const input = iface.parseTransaction({ data: tx.data });
            const value = { custody: identity.custody, minter: identity.custody, ALLOWED_CHAIN_ID: 56n,
                MAX_SUPPLY: 1000n, supportsInterface: true, ownerOf: mode === 'owner' ? ethers.ZeroAddress : identity.custody,
                tokenURI: identity.metadataURI, tokenForAsset: 1n }[input.name];
            return iface.encodeFunctionResult(input.name, [value]);
        }
        destroy() {}
    }
    return { ...ethers, JsonRpcProvider: Provider };
}
function publisher(mode = 'ok', initial = {}) {
    const actor = { Role: 'Admin', Status: 'Active', Token: 'secret-test-session' };
    const db = database({ 'Users/ADMIN': actor, ...initial }); let clears = 0;
    const engine = createGallery({ ethers: verifiedEthers(mode), db, FieldValue, clearMarketCache: async () => { clears++; } });
    const req = { authenticatedUid: 'ADMIN', authenticatedUserDoc: { data: () => actor }, body: { assetId: 'TCM-001', level: 2, price: '501' } };
    return { engine, db, req, clears: () => clears };
}
test('Mainnet publisher independently verifies type-4 events, creates one listing/audit and preserves reserved state on retry', async () => {
    const f = publisher(), res = response(); await f.engine.publish(f.req, res);
    assert.equal(res.body.success, true, res.body.message); assert.equal(res.body.data.alreadyPublished, false);
    const name = 'NFT_Gallery/' + res.body.data.id, row = f.db.rows.get(name);
    assert.equal(row.Price_micro, '501000000'); assert.equal(row.Level, '2'); assert.equal(row.Blockchain.Verification_Status, 'Verified_Mainnet_Snapshot');
    f.db.rows.set(name, { ...row, Status: 'Reserved', Owner_UID: 'U' });
    const again = response(); await f.engine.publish(f.req, again);
    assert.equal(again.body.data.alreadyPublished, true); assert.equal(f.db.rows.get(name).Owner_UID, 'U');
    assert.equal([...f.db.rows.keys()].filter(key => key.startsWith('AdminLogs/')).length, 1);
    assert(![...f.db.rows.keys()].some(key => key.startsWith('Wallets/')));
});
test('publisher rejects wrong chain, failed proof, changed custody, duplicate token and changed requested price without writes', async t => {
    for (const mode of ['testnet', 'failed', 'no-logs', 'owner', 'duplicate', 'price', 'inactive']) await t.test(mode, async () => {
        const f = publisher(mode, mode === 'duplicate' ? { 'NFT_Gallery/other': { Blockchain: { ...ref, Contract_Address: identity.contract.toLowerCase() } } } : {});
        if (mode === 'price') f.req.body.price = '500';
        if (mode === 'inactive') f.db.rows.get('Users/ADMIN').Status = 'Banned';
        const res = response(); await f.engine.publish(f.req, res); assert.equal(res.body.success, false);
        assert(!f.db.operations.some(op => ['create', 'set', 'update'].includes(op.kind)));
    });
});

test('Dashboard renders the correct Mainnet identity while excluding chain 97 and the recorded Testnet mint', () => {
    const liveFile = path.join(__dirname, '../Dashboard.html');
    const html = fs.readFileSync(fs.existsSync(liveFile) ? liveFile : path.join(__dirname, 'fixtures/Dashboard.html'), 'utf8');
    const code = html.slice(html.indexOf('window.renderNFTBlockchainReference = raw => {'), html.indexOf('// NFT BLOCKCHAIN REFERENCE END'));
    const context = { window: {}, Date, BigInt }; vm.createContext(context); vm.runInContext(code, context);
    assert.match(context.window.renderNFTBlockchainReference(ref), /Mint and platform custody checked at/);
    assert.equal(context.window.renderNFTBlockchainReference({ ...ref, Chain_ID: 97 }), '');
    assert.equal(context.window.renderNFTBlockchainReference({ ...ref, Mint_TxHash: '0x74ac1c82cfdd43579edd68644b4c756a3c17b524c3be3b1a1a823f9e2cf2b6a5' }), '');
    assert.match(html, /Processing platform settlement/); assert.match(html, /Settlement completed/);
    assert(!html.includes('BUYER FOUND!')); assert(!html.includes('Scanning P2P Network for Buyers'));
    assert(html.includes("2:'500 - 2,000 ₮'")); assert(html.includes("1:'50 - 500 ₮'"));
});

test('successful sale immediately releases stock for another eligible user, keeping history and daily limit', async()=>{
    const rows=baseRows();rows['Users/V']={Rank:2,Status:'Active',counters:{txCount:0,activeReservations:0}};
    rows['Wallets/V']={Main_Balance:1000,Locked_Balance:0};
    const f=routes(rows);const first=await f.call('/api/nft/reserve',{level:2},'U');
    assert.equal(first.body.success,true,first.body.message);
    const oldOrder=first.body.nftData.orderId;
    const sold=await f.call('/api/nft/sell',{docId:'N',orderId:oldOrder},'U');
    assert.equal(sold.body.success,true,sold.body.message);
    const released=f.db.rows.get('NFT_Gallery/N');
    assert.equal(released.Status,'Available');assert.equal(released.Owner_UID,'');
    assert.equal(released.Reservation,null);assert.equal(released.Reservation_Blockchain,null);assert.equal(released.Next_Available_Time,null);
    assert.equal(sold.body.orderReceipt.sale.Principal_micro,'501000000');
    const repeat=await f.call('/api/nft/reserve',{level:2},'U');assert.equal(repeat.body.success,false);assert.match(repeat.body.message,/Daily Limit/);
    const next=await f.call('/api/nft/reserve',{level:2},'V');assert.equal(next.body.success,true,next.body.message);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Owner_UID,'V');assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Reserved');
    const retry=await f.call('/api/nft/sell',{docId:'N',orderId:oldOrder},'U');assert.equal(retry.body.success,false);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,1007.13);assert.equal(f.db.rows.get('Wallets/V').Main_Balance,499);
    const history=[...f.db.rows.values()].filter(r=>r.Type==='NFT Sold'&&r.UID==='U');assert.equal(history.length,1);assert.equal(history[0].Principal_micro,'501000000');
});

test('failed settlement commit keeps NFT reserved and never exposes Available stock',async()=>{
    const f=routes(baseRows());await f.call('/api/nft/reserve',{level:2});
    const original=f.db.runTransaction.bind(f.db);
    f.db.runTransaction=fn=>original(async tx=>{await fn(tx);throw Error('Commit failed');});
    const result=await f.call('/api/nft/sell',{docId:'N',orderId:'NFT-SERVER-ORDER'});
    assert.equal(result.body.success,false);assert.equal(result.body.orderReceipt,undefined);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Reserved');assert.equal(f.db.rows.get('NFT_Gallery/N').Owner_UID,'U');
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,499);assert.equal(f.db.rows.get('Wallets/U').Locked_Balance,501);
    assert(![...f.db.rows.values()].some(r=>r.Type==='NFT Sold'));
});

test('legacy recovery retires the future deadline but skips owned, reserved or malformed records',async()=>{
    const rows=baseRows();Object.assign(rows['NFT_Gallery/N'],{Status:'Cooldown',Next_Available_Time:Date.now()+120000,Reservation:null,Reservation_Blockchain:null});
    for(const [id,extra]of Object.entries({owned:{Owner_UID:'U'},reserved:{Reservation:{UID:'U'}},blockchain:{Reservation_Blockchain:{Chain_ID:56}},malformed:{Next_Available_Time:'invalid'}})) {
        rows['NFT_Gallery/'+id]={Status:'Cooldown',Owner_UID:'',Reservation:null,Reservation_Blockchain:null,Next_Available_Time:Date.now()+120000,...extra};
    }
    const f=routes(rows);await f.call('/api/nft/market',{},'U','GET');
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Available');
    for(const id of ['owned','reserved','blockchain','malformed'])assert.equal(f.db.rows.get('NFT_Gallery/'+id).Status,'Cooldown',id);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,1000);
    assert(![...f.db.rows.values()].some(r=>r.Type==='NFT Sold'));
});

test('legacy recovery rechecks ownership inside its transaction before releasing stock',async()=>{
    const rows=baseRows();Object.assign(rows['NFT_Gallery/N'],{Status:'Cooldown',Next_Available_Time:Date.now()-1000});
    const f=routes(rows),original=f.db.runTransaction.bind(f.db);
    f.db.runTransaction=async fn=>{f.db.rows.set('NFT_Gallery/N',{...f.db.rows.get('NFT_Gallery/N'),Status:'Reserved',Owner_UID:'U',Reservation:{UID:'U'}});return original(fn);};
    await f.call('/api/nft/market',{},'U','GET');
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Reserved');assert.equal(f.db.rows.get('NFT_Gallery/N').Owner_UID,'U');
});

test('two concurrent reservations cannot allocate the same immediately available NFT twice',async()=>{
    const rows=baseRows();rows['Users/V']={Rank:2,Status:'Active'};rows['Wallets/V']={Main_Balance:1000,Locked_Balance:0};
    const f=routes(rows),original=f.db.runTransaction.bind(f.db),conflict=Symbol('conflict');
    let barrierResolve,arrivals=0,tail=Promise.resolve();const barrier=new Promise(r=>barrierResolve=r);
    f.db.runTransaction=async fn=>{
        for(let attempt=0;attempt<2;attempt++){
            let release;
            try{
                const result=await original(async tx=>{
                    const reads=new Map();
                    const wrapper={...tx,get:async target=>{const snap=await tx.get(target);if(target.path&&!target.filters)reads.set(target.path,snap.exists?snap.data():undefined);return snap;}};
                    const output=await fn(wrapper);
                    if(attempt===0){arrivals++;if(arrivals===2)barrierResolve();await barrier;}
                    const previous=tail;tail=new Promise(r=>release=r);await previous;
                    for(const [key,value]of reads)if(f.db.rows.get(key)!==value)throw conflict;
                    return output;
                });
                return result;
            }catch(error){if(error!==conflict)throw error;}
            finally{release?.();}
        }
        throw Error('Conflict retries exhausted');
    };
    const results=await Promise.all([f.call('/api/nft/reserve',{level:2},'U'),f.call('/api/nft/reserve',{level:2},'V')]);
    assert.equal(results.filter(r=>r.body.success).length,1);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance+f.db.rows.get('Wallets/V').Main_Balance,1499);
    assert.equal(f.db.rows.get('Wallets/U').Locked_Balance+f.db.rows.get('Wallets/V').Locked_Balance,501);
    assert.equal([...f.db.rows.values()].filter(r=>r.Type==='NFT Reserve').length,1);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Reserved');
});
