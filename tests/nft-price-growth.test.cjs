'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const growth=require('../lib/nft-price-growth.cjs');
const createGallery=require('../lib/nft-mainnet-gallery.cjs');
const {routes,baseRows}=require('./nft-import-routes-fixture.cjs');
const {chainFixture,seeds,third}=require('./nft-import-fixture.cjs');

test('9/6/3/3 exactly conserves gross profit in micro-units including former cent-rounding edge cases',()=>{
    const expected=growth.math(2001000000n,3);
    assert.equal(expected.gross,46020000n);assert.equal(expected.fee,9664200n);assert.equal(expected.net,36355800n);
    assert.deepEqual(expected.team,[4141800n,2761200n,1380600n]);assert.equal(expected.growth,1380600n);
    for(let p=50000000n;p<55000000n;p+=7919n){
        const a=growth.math(p,1);assert.equal(a.fee,a.team.reduce((sum,n)=>sum+n,a.growth));assert.equal(a.gross,a.net+a.fee);
    }
    assert.equal(growth.math(50000000n,1).net,513500n);
    assert.throws(()=>growth.math(0n,1));assert.throws(()=>growth.math(50000000n,0));
});
test('promotion occurs only above each unchanged upper band, and an unsupported future quote pauses stock',()=>{
    for(const [level,max]of [[1,500],[2,2000],[3,5000],[4,10000],[5,20000]]){
        assert.equal(growth.tier(BigInt(max)*1000000n,level),level);
        assert.equal(growth.tier(BigInt(max)*1000000n+1n,level),level+1);
    }
    assert.equal(growth.tier(1000000000000n,1),6);
    const b=growth.base({...seeds[0],level:6,priceMicro:'9000000000000000'});
    const next=growth.next(b,9000000000000000n,0n,'ORDER','EVENT');
    assert.equal(next.State,'Review');assert.equal(next.Price_micro,b.Price_micro);
    assert.equal(next.Proposed_Price_micro,'18000000000000000');
    assert.throws(()=>growth.readPolicy({...growth.policy(0),Growth_BPS:400}));
    assert.doesNotThrow(()=>growth.readPolicy(Object.fromEntries(Object.entries(growth.policy(0)).reverse())));
});

function fixture({missing=false,duplicate=false,canonical=false,initialPrice}={}){
    const f=chainFixture(),a=f.registry.byId('TCM-003'),initial=baseRows();
    initial['Users/U'].Rank=3;initial['Wallets/U'].Main_Balance=10000;
    for(const id of ['A','B','C'])initial['Users/'+id]={Status:'Active',Name:id};
    if(missing)delete initial['Users/B'];
    if(duplicate)initial['Users/U'].Sponsor_B='A';
    initial['NFT_Mainnet_Config/approved-v1']={version:1,entries:[third]};
    const price=initialPrice||2001;
    initial['NFT_Gallery/N']={...initial['NFT_Gallery/N'],NFT_ID:a.assetId,Asset_ID:a.assetId,Name:a.name,Image_URI:a.imageURI,
        Price:price,Price_micro:BigInt(Math.round(price*1e6)).toString(),Level:'3',Blockchain:{Chain_ID:56,Contract_Address:a.contract,
            Token_ID:a.tokenId,Mint_TxHash:a.mintHash,Metadata_URI:a.metadataURI,Asset_Key:a.assetKey,
            Custody_Address:a.custody,Verification_Status:'Verified_Mainnet_Snapshot',Verified_At:new Date().toISOString()}};
    if(initialPrice){
        const total=BigInt(Math.round(price*1e6))-BigInt(a.priceMicro);
        initial['NFT_Price_State/N']={...growth.base(a),Price_micro:String(BigInt(Math.round(price*1e6))),Total_Growth_micro:String(total),Revision:1};
        initial['NFT_Gallery/N'].Price_Revision=1;
    }
    if(canonical){
        const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
        const text=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
        const fields=vm.runInNewContext(text.slice(text.indexOf('const moneyV7Fields ='),text.indexOf('function moneyV7Canonical('))+'moneyV7Fields.Wallet');
        for(const id of ['U','A','B','C']){
            const wallet=initial['Wallets/'+id];
            for(const field of fields)wallet[field]??=0;
            wallet.Money_Version=1;wallet.Money_Scope='Wallet';wallet.Money_micro=Object.fromEntries(fields.map(field=>[field,String(BigInt(Math.round(wallet[field]*1e6)))]));
        }
    }
    return routes(initial,{growthPolicy:growth,canonical,galleryFactory:db=>createGallery({ethers:f.ethers,db,
        FieldValue:{serverTimestamp:()=>({toMillis:()=>Date.now()})},clearMarketCache:async()=>{}})});
}
async function reserve(f){const r=await f.call('/api/nft/reserve',{uid:'U',level:3});assert(r.body.success,r.body.message);return r;}
async function sell(f){return f.call('/api/nft/sell',{uid:'U',docId:'N',orderId:'NFT-SERVER-ORDER'});}

test('new reservation locks policy, settlement credits exact shares and raises only the next price once',async()=>{
    const f=fixture();const r=await reserve(f);assert.equal(r.body.nftData.Price_Policy.Version,2);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2001);
    const s=await sell(f);assert(s.body.success,s.body.message);
    const bonuses=[...f.db.rows].filter(([key,value])=>key.startsWith('Transactions/') && /^Team Bonus/.test(value.Type||''));
    assert.equal(bonuses.length,3);
    for(const [,bonus] of bonuses){assert.equal(bonus.Source_UID,'U');assert.equal(bonus.Source_Name,f.db.rows.get('Users/U').Name || '');assert.equal(bonus.NFT_Policy_Version,2);assert.match(bonus.Admin_Remarks,/^From: .* \(UID: U\)$/);}
    assert.equal(s.body.data.net,36.3558);assert.equal(s.body.data.fee,9.6642);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,10036.3558);
    for(const [id,value]of [['A',4.1418],['B',2.7612],['C',1.3806]])assert.equal(f.db.rows.get('Wallets/'+id).Main_Balance,value);
    const n=f.db.rows.get('NFT_Gallery/N');assert.equal(n.Price,2002.3806);assert.equal(n.Price_micro,'2002380600');assert.equal(n.Status,'Available');
    assert.equal(s.body.orderReceipt.sale.Price_Growth.Growth_micro,'1380600');
    const events=[...f.db.rows].filter(([key])=>key.startsWith('NFT_Price_Events/'));assert.equal(events.length,1);
    assert.equal(events[0][1].Fee_micro,'9664200');
    const count=f.db.operations.filter(o=>o.kind!=='query').length;
    assert.equal((await sell(f)).body.success,false);assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2002.3806);
    assert.equal(f.db.operations.filter(o=>o.kind!=='query').length,count);
});
test('missing sponsor share is separately reserved and duplicate hands update one wallet with one combined audit',async()=>{
    const missing=fixture({missing:true});await reserve(missing);const s=await sell(missing);assert(s.body.success,s.body.message);
    assert.equal(missing.db.rows.get('NFT_Price_State/N').Missing_Team_micro,'2761200');
    const event=[...missing.db.rows].find(([key])=>key.startsWith('NFT_Price_Events/'))[1];
    assert.equal(BigInt(event.Team_Paid_micro)+BigInt(event.Missing_Team_micro)+BigInt(event.Growth_micro),BigInt(event.Fee_micro));
    const duplicate=fixture({duplicate:true});await reserve(duplicate);const result=await sell(duplicate);assert(result.body.success,result.body.message);
    assert.equal(duplicate.db.rows.get('Wallets/A').Main_Balance,6.903);
    const entries=[...duplicate.db.rows].filter(([key])=>key.startsWith('Main_Balance_Ledgers/A/Entries/'));
    assert.equal(entries.length,1);assert.equal(entries[0][1].Balance_Delta_micro,'6903000');
});
test('canonical wallets keep their Money_micro and numeric projections synchronized',async()=>{
    const f=fixture({canonical:true});await reserve(f);const s=await sell(f);assert(s.body.success,s.body.message);
    for(const [id,want]of [['U','10036355800'],['A','4141800'],['B','2761200'],['C','1380600']]){
        const w=f.db.rows.get('Wallets/'+id);assert.equal(w.Money_micro.Main_Balance,want);assert.equal(w.Main_Balance,Number(BigInt(want))/1e6);
    }
    assert.equal(f.db.rows.get('Wallets/U').Money_micro.Locked_Balance,'0');
});
test('a price crossing 5000 promotes the next quote to Level 4 while settling the saved Level 3 principal',async()=>{
    const f=fixture({initialPrice:5000});await reserve(f);const s=await sell(f);assert(s.body.success,s.body.message);
    assert.equal(s.body.data.principal,5000);assert.equal(s.body.data.gross,115);
    const n=f.db.rows.get('NFT_Gallery/N');assert.equal(n.Price,5003.45);assert.equal(n.Level,'4');assert.equal(n.Status,'Available');
    const blocked=await f.call('/api/nft/reserve',{uid:'U',level:4});assert.equal(blocked.body.success,false);
});
test('mutating a gallery price cannot change the reserved principal; an altered saved policy fails without writes',async()=>{
    const f=fixture();await reserve(f);f.db.rows.get('NFT_Gallery/N').Price=4999;
    const s=await sell(f);assert(s.body.success,s.body.message);assert.equal(s.body.data.principal,2001);assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2002.3806);
    const g=fixture();await reserve(g);g.db.rows.get('NFT_Gallery/N').Reservation.Price_Policy.Growth_BPS=400;
    const before=g.db.rows.get('Wallets/U').Main_Balance;assert.equal((await sell(g)).body.success,false);assert.equal(g.db.rows.get('Wallets/U').Main_Balance,before);
});

test('commit failure, Firestore callback retry and a competing reservation never double-pay or double-grow',async()=>{
    const f=fixture();await reserve(f);const before=f.db.rows.get('Wallets/U').Main_Balance;
    f.db.failCommit=true;assert.equal((await sell(f)).body.success,false);
    assert.equal(f.db.rows.get('Wallets/U').Main_Balance,before);assert.equal(f.db.rows.get('NFT_Gallery/N').Status,'Reserved');
    assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2001);assert.equal([...f.db.rows.keys()].filter(k=>k.startsWith('NFT_Price_Events/')).length,0);
    f.db.failCommit=false;f.db.retryOnce=true;const result=await sell(f);assert(result.body.success,result.body.message);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2002.3806);assert.equal([...f.db.rows.keys()].filter(k=>k.startsWith('NFT_Price_Events/')).length,1);
    f.db.rows.set('Users/V',{Rank:3,Status:'Active'});f.db.rows.set('Wallets/V',{Main_Balance:5000,Locked_Balance:0});
    const next=await f.call('/api/nft/reserve',{uid:'V',level:3},'V');assert(next.body.success,next.body.message);
    assert.equal(next.body.nftData.price,2002.3806);
    const competing=await f.call('/api/nft/reserve',{uid:'U',level:3});assert.equal(competing.body.success,false);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Owner_UID,'V');
});
test('pre-upgrade open orders keep their 12/6/3 and cent fee terms and do not grow retrospectively',async()=>{
    const f=fixture();await reserve(f);
    delete f.db.rows.get('NFT_Gallery/N').Reservation.Price_Policy;f.db.rows.delete('NFT_Price_State/N');
    const s=await sell(f);assert(s.body.success,s.body.message);assert.equal(s.body.data.net,36.36);assert.equal(s.body.data.fee,9.66);
    assert.equal(f.db.rows.get('NFT_Gallery/N').Price,2001);assert.equal(f.db.rows.get('Wallets/A').Main_Balance,5.52);
    assert.equal([...f.db.rows.keys()].filter(k=>k.startsWith('NFT_Price_Events/')).length,0);
});

test('an existing grown listing is recognized without resetting its quote or reservation',()=>{
    const a=chainFixture().registry.byId('TCM-003'),state=growth.next(growth.base(a),1380600n,0n,'O','E');
    const row={Asset_ID:a.assetId,Name:a.name,Image_URI:a.imageURI,Price:2002.3806,Price_micro:'2002380600',
        Level:'3',Price_Revision:1,Status:'Reserved',Owner_UID:'U'};
    assert.equal(growth.existingListing(a,row,state),true);
    assert.equal(growth.existingListing(a,{...row,Price:2003},state),false);
    assert.equal(growth.existingListing(a,{...row,Level:'4'},state),false);
});
