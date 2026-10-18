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
            if (db.retryOnce) { db.retryOnce = false; return db.runTransaction(fn); }
            if (db.failCommit && writes.length) throw Error('Simulated financial commit failure');
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
            if (name.includes('nft-mainnet-gallery') && options.galleryFactory) return () => options.galleryFactory(db);
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
    if(options.canonical) vm.runInContext(server.slice(server.indexOf('const moneyV7Fields ='),server.indexOf('function moneyV7NewWallet(')),context);
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


module.exports={routes,baseRows};
