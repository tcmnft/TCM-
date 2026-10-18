'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createGallery = require('../lib/nft-mainnet-gallery.cjs');
const createImport = require('../lib/nft-admin-import.cjs');
const rules = require('../lib/nft-candidate.cjs');
const { chainFixture, seeds, third, bytes } = require('./nft-import-fixture.cjs');

function database() {
    const rows = new Map([['Users/ADMIN', { Role: 'Admin', Status: 'Active', Token: 'session-A' }]]), writes = [];
    let id = 0, tail = Promise.resolve();
    const snapshot = path => ({ exists: rows.has(path), id: path.split('/').at(-1),
        data: () => structuredClone(rows.get(path)) });
    const doc = path => ({ path, id: path.split('/').at(-1), get: async () => snapshot(path) });
    function collection(name) {
        return { doc: key => doc(name + '/' + (key || 'audit-' + ++id)),
            where: (field, op, values) => ({ limit: cap => ({ get: async () => {
                assert.equal(field, 'Blockchain.Token_ID'); assert.equal(op, 'in');
                const docs = [...rows].filter(([key,row]) => key.startsWith(name + '/') && values.includes(row.Blockchain?.Token_ID))
                    .slice(0, cap).map(([key]) => snapshot(key));
                return { docs, size: docs.length };
            } }) }) };
    }
    const db = { collection, rows, writes, failCommit: false, async runTransaction(callback) {
        const before = tail; let release; tail = new Promise(done => { release = done; }); await before;
        try {
            let writing = false; const staged = [];
            const result = await callback({ get: target => { assert(!writing, 'all reads before writes'); return target.get(); },
                create(target, value) { writing = true; assert(!rows.has(target.path)); staged.push(['create',target.path,value]); },
                update(target, value) { writing = true; assert(rows.has(target.path)); staged.push(['update',target.path,value]); },
                set(target, value) { writing = true; staged.push(['set',target.path,value]); } });
            if (staged.length && db.failCommit) throw Error('Simulated atomic commit failure');
            for (const [kind,path,value] of staged) { rows.set(path, kind === 'update' ? { ...rows.get(path), ...structuredClone(value) } : structuredClone(value)); writes.push(path); }
            return result;
        } finally { release(); }
    } };
    return db;
}
const FieldValue = { serverTimestamp: () => 'server-time' };
function fixture(options = {}) {
    const chain = chainFixture(options), db = database();
    const state = { metadataFail: false, metadataCalls: 0, cacheCalls: 0, clock: Date.now(), chainFail: false };
    function worker() {
        const gallery = createGallery({ ethers: chain.ethers, db, FieldValue, clearMarketCache: async () => {} });
        const original = gallery.verifyEntry;
        gallery.verifyEntry = async entry => { if (state.chainFail) throw Error('RPC unavailable'); return original(entry); };
        const engine = createImport({ db, FieldValue, gallery, now: () => state.clock,
            clearMarketCache: async () => { state.cacheCalls++; if (options.cacheFailure) throw Error('Redis unavailable'); },
            checkMetadata: async entry => { state.metadataCalls++; return rules.checkMetadata(entry,
                async () => new Response(state.metadataFail ? Buffer.from('bad') : bytes)); } });
        return { gallery, engine };
    }
    const candidate = { kind:'Gallery_Candidate_Only', readyForProduction:false, Name:third.name, Asset_ID:third.assetId,
        Image_URI:third.imageURI, Image_URL:'http://127.0.0.1:1234/do-not-fetch', verificationSnapshot:{ owner:'forged' },
        Blockchain:{ Chain_ID:56,Contract_Address:chain.registry.collection.contract,Token_ID:'3',
            Custody_Address:chain.registry.collection.custody,Metadata_URI:third.metadataURI,Mint_TxHash:third.mintHash } };
    const req = (body, uid = 'ADMIN', token = 'session-A') => ({ body, authenticatedUid:uid,authenticatedUserDoc:{ data:()=>({Token:token}) } });
    const response = () => ({ code:200,status(code){this.code=code;return this;},json(body){this.body=body;} });
    const initial = worker();
    async function call(name, body, instance = initial.engine, uid, token) {
        const res=response();await instance[name](req(body,uid,token),res);return res;
    }
    const preview = (overrides = {}, instance) => call('preview',{candidate,level:3,price:'2001',...overrides},instance);
    const publish = (data, instance) => call('publish',{reviewId:data.reviewId,planSHA256:data.planSHA256},instance);
    return { ...initial, db, state, chain, worker, candidate, preview, publish, call };
}

test('import preview uses real proof verification and metadata bytes, writes only a session-bound review', async () => {
    const f=fixture(), res=await f.preview();
    assert.equal(res.body.success,true,res.body.message);
    const data=res.body.data;
    assert.equal(data.asset.tokenId,'3');assert.equal(data.asset.level,3);assert.equal(data.asset.priceMicro,'2001000000');
    assert.equal(data.metadata.integrity,'Raw_CID_SHA256_Verified');assert.equal(data.verification.owner,f.chain.registry.collection.custody);
    assert.equal(f.db.writes.length,1);assert.match(f.db.writes[0],/^NFT_Mainnet_Reviews\//);
    assert.equal(f.gallery.matches({Chain_ID:56,Contract_Address:data.asset.contract,Token_ID:'3',Metadata_URI:third.metadataURI,Mint_TxHash:third.mintHash}),false);
    assert(!JSON.stringify(data).includes('session-A'));assert(!JSON.stringify(data).includes('127.0.0.1'));
});

test('approve atomically saves catalog/listing/audit, survives restart and preserves reserved state on retry', async () => {
    const f=fixture({cacheFailure:true}), preview=await f.preview(), res=await f.publish(preview.body.data);
    assert.equal(res.body.success,true,res.body.message);
    const id=res.body.data.id,path='NFT_Gallery/'+id,row=f.db.rows.get(path);
    assert.equal(row.Price_micro,'2001000000');assert.equal(row.Level,'3');assert.equal(row.Status,'Available');
    assert.equal(row.Blockchain.Token_ID,'3');assert.equal(row.Blockchain.Verification_Status,'Verified_Mainnet_Snapshot');
    assert.equal(f.db.rows.get('NFT_Mainnet_Config/approved-v1').entries.length,1);
    assert(!f.db.writes.some(p=>/^(Wallets|Transactions|NFT_History)\//.test(p)));
    const reloaded=f.worker();await reloaded.gallery.ensureReference(row.Blockchain);
    assert(reloaded.gallery.matches(row.Blockchain));assert.equal((await reloaded.gallery.verify({assetId:'TCM-003'})).data.tokenId,'3');
    assert.equal(reloaded.gallery.assets().length,seeds.length+1);
    f.db.rows.set(path,{...row,Status:'Reserved',Owner_UID:'USER',Reservation:{Order_ID:'KEEP'}});
    const count=f.db.writes.length;f.state.clock+=3600000;
    const retry=await f.publish(preview.body.data,reloaded.engine);
    assert.equal(retry.body.success,true,retry.body.message);assert.equal(retry.body.data.status,'Reserved');
    assert.equal(f.db.rows.get(path).Reservation.Order_ID,'KEEP');assert.equal(f.db.writes.length,count);
    assert.equal(f.db.writes.filter(p=>p.startsWith('AdminLogs/')).length,1);
});

test('candidate validation rejects bad chains, identity, price and duplicate tokens without preview writes', async t => {
    for(const change of ['testnet','token','key','custody','metadata','band','fraction','duplicate','size']) await t.test(change,async()=>{
        const f=fixture(), candidate=structuredClone(f.candidate), body={candidate};
        if(change==='testnet')candidate.Blockchain.Chain_ID=97;
        if(change==='token')candidate.Blockchain.Token_ID='1001';
        if(change==='key')candidate.Blockchain.Asset_Key='0x'+'00'.repeat(32);
        if(change==='custody')candidate.Blockchain.Custody_Address=f.chain.registry.collection.contract;
        if(change==='metadata')candidate.Blockchain.Metadata_URI='http://127.0.0.1/private';
        if(change==='band')body.price='50';if(change==='fraction')body.price='2001.0000001';
        if(change==='duplicate')candidate.Blockchain.Token_ID='2';if(change==='size')candidate.junk='x'.repeat(33000);
        const res=await f.preview(body);assert.equal(res.body.success,false);assert.equal(f.db.writes.length,0);
    });
});

test('metadata or on-chain failures cannot create a preview or publish', async t => {
    for(const mode of ['metadata','custody','testnet','receipt','rpc-after-preview'])await t.test(mode,async()=>{
        const f=fixture({changedOwner:mode==='custody',chainId:mode==='testnet'?97:56,failAsset:mode==='receipt'?'TCM-003':undefined});
        if(mode==='metadata')f.state.metadataFail=true;
        if(mode==='rpc-after-preview'){
            const p=await f.preview();assert(p.body.success);const count=f.db.writes.length;f.state.chainFail=true;
            const result=await f.publish(p.body.data);assert.equal(result.body.success,false);assert.equal(f.db.writes.length,count);
        }else {const res=await f.preview();assert.equal(res.body.success,false);assert.equal(f.db.writes.length,0);}
    });
});

test('role, account, session, expiration and altered plan gates are enforced at publication', async t=>{
    for(const mode of ['role','deleted','banned','session','uid','expiry','hash','entry'])await t.test(mode,async()=>{
        const f=fixture(), p=await f.preview();assert(p.body.success,p.body.message);const data=p.body.data,count=f.db.writes.length;
        if(['role','deleted','banned','session'].includes(mode)){
            const a=f.db.rows.get('Users/ADMIN');if(mode==='role')a.Role='User';if(mode==='deleted')a.Account_Deleted=true;
            if(mode==='banned')a.Status='Banned';if(mode==='session')a.Token='changed';
        }
        if(mode==='uid')f.db.rows.set('Users/OTHER',{Role:'Admin',Status:'Active',Token:'session-A'});
        if(mode==='expiry')f.state.clock+=16*60000;
        if(mode==='hash')data.planSHA256='0'.repeat(64);
        if(mode==='entry')f.db.rows.get('NFT_Mainnet_Reviews/'+data.reviewId).entry.priceMicro='2002000000';
        const res=mode==='uid'?await f.call('publish',{reviewId:data.reviewId,planSHA256:data.planSHA256},f.engine,'OTHER'):await f.publish(data);
        assert.equal(res.body.success,false);assert.equal(f.db.writes.length,count);
    });
});

test('commit failure leaves catalog and listing absent; exact retry succeeds',async()=>{
    const f=fixture(), p=await f.preview();f.db.failCommit=true;const count=f.db.writes.length;
    const res=await f.publish(p.body.data);assert.equal(res.body.success,false);assert.equal(f.db.writes.length,count);
    assert(!f.db.rows.has('NFT_Mainnet_Config/approved-v1'));
    f.db.failCommit=false;assert.equal((await f.publish(p.body.data)).body.success,true);
});

test('two workers cannot approve conflicting prices or create duplicate listings',async()=>{
    const f=fixture(), other=f.worker();
    const [a,b]=await Promise.all([f.preview(),f.preview({price:'2002'},other.engine)]);
    assert(a.body.success,a.body.message);assert(b.body.success,b.body.message);
    const results=await Promise.all([f.publish(a.body.data),f.publish(b.body.data,other.engine)]);
    assert.equal(results.filter(r=>r.body.success).length,1);
    assert.equal([...f.db.rows.keys()].filter(p=>p.startsWith('NFT_Gallery/')).length,1);
    assert.equal(f.db.rows.get('NFT_Mainnet_Config/approved-v1').entries.length,1);
});

test('duplicate existing token record and malformed persistent catalog fail closed',async t=>{
    for(const mode of ['duplicate','catalog'])await t.test(mode,async()=>{
        const f=fixture(), p=await f.preview();
        if(mode==='duplicate')f.db.rows.set('NFT_Gallery/OTHER',{Blockchain:{Chain_ID:56,Contract_Address:f.chain.registry.collection.contract,Token_ID:3}});
        else f.db.rows.set('NFT_Mainnet_Config/approved-v1',{version:1,entries:[{...third,tokenId:'1'}]});
        const count=f.db.writes.length,res=await f.publish(p.body.data);assert.equal(res.body.success,false);assert.equal(f.db.writes.length,count);
    });
});

test('a restarted server reserves and settles a dynamically approved Level 3 token using the real financial handlers',async()=>{
    const {routes,baseRows}=require('./nft-import-routes-fixture.cjs');
    const chain=chainFixture(), a=chain.registry.byId('TCM-003'), initial=baseRows();
    initial['Users/U'].Rank=3; initial['Wallets/U'].Main_Balance=3000;
    initial['NFT_Mainnet_Config/approved-v1']={version:1,entries:[third]};
    initial['NFT_Gallery/N']={...initial['NFT_Gallery/N'],NFT_ID:a.assetId,Asset_ID:a.assetId,Name:a.name,
        Level:'3',Price:2001,Price_micro:a.priceMicro,Blockchain:{Chain_ID:56,Contract_Address:a.contract,Token_ID:a.tokenId,
            Mint_TxHash:a.mintHash,Metadata_URI:a.metadataURI,Asset_Key:a.assetKey,Custody_Address:a.custody,
            Verification_Status:'Verified_Mainnet_Snapshot',Verified_At:new Date().toISOString()}};
    let engine;
    const f=routes(initial,{galleryFactory(db){
        engine=createGallery({ethers:chain.ethers,db,FieldValue,clearMarketCache:async()=>{}});return engine;
    }});
    assert.equal(engine.matches(initial['NFT_Gallery/N'].Blockchain),false);
    const reserve=await f.call('/api/nft/reserve',{level:3,uid:'U'});
    assert.equal(reserve.body.success,true,reserve.body.message);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,999);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Reservation_Blockchain.Token_ID,'3');
    const sell=await f.call('/api/nft/sell',{uid:'U',docId:'N',orderId:'NFT-SERVER-ORDER'});
    assert.equal(sell.body.success,true,sell.body.message);assert.equal(sell.body.data.principal,2001);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Available');
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,3000+sell.body.data.net);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Owner_UID,'');
});

test('both publication APIs preserve a grown and reserved token on repeat publication',async()=>{
    const growth=require('../lib/nft-price-growth.cjs');
    const f=fixture(),p=await f.preview(),published=await f.publish(p.body.data);
    assert(published.body.success,published.body.message);
    const id=published.body.data.id,path='NFT_Gallery/'+id,asset=f.chain.registry.byId('TCM-003');
    const state=growth.next(growth.base(asset),1380600n,0n,'OLD-ORDER','OLD-EVENT');
    f.db.rows.set('NFT_Price_State/'+id,state);
    f.db.rows.set(path,{...f.db.rows.get(path),Price:2002.3806,Price_micro:'2002380600',Price_Revision:1,
        Status:'Reserved',Owner_UID:'USER',Reservation:{Order_ID:'KEEP'}});
    const retry=await f.publish(p.body.data);assert(retry.body.success,retry.body.message);
    assert.equal(retry.body.data.currentPrice,2002.3806);
    const old=await f.call('publish',{assetId:'TCM-003',level:3,price:'2001'},f.gallery);
    assert(old.body.success,old.body.message);assert.equal(old.body.data.currentPrice,2002.3806);
    const preview=await f.preview();assert(preview.body.success,preview.body.message);
    const repeated=await f.publish(preview.body.data);assert(repeated.body.success,repeated.body.message);
    assert.equal(f.db.rows.get(path).Price,2002.3806);assert.equal(f.db.rows.get(path).Reservation.Order_ID,'KEEP');
});
