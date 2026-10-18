'use strict';
const crypto=require('node:crypto');
const POLICY_VERSION=2;
const SCALE=1000000n,MAX=BigInt(Number.MAX_SAFE_INTEGER);
const BANDS=[[50,500],[500,2000],[2000,5000],[5000,10000],[10000,20000],[20000,null]];
const RATES=[0n,130n,180n,230n,280n,330n,380n];
const fail=message=>Object.assign(Error(message),{statusCode:409,code:'NFT_PRICE_REVIEW_REQUIRED'});
function micro(raw){if(typeof raw!=='string'||!/^(?:0|[1-9]\d{0,30})$/.test(raw))throw fail('Invalid price-state amount.');return BigInt(raw);}
function representable(n){
    if(n<0n||n>MAX)return false;
    const value=String(Number(n)/1e6);
    if(!/^\d+(?:\.\d{1,6})?$/.test(value))return false;
    const [w,f='']=value.split('.');return BigInt(w)*SCALE+BigInt(f.padEnd(6,'0'))===n;
}
function money(n){if(!representable(n))throw fail('Amount exceeds the supported exact money range.');return Number(n)/1e6;}
function tier(n,initial=1){let level=initial;while(level<6&&n>BigInt(BANDS[level-1][1])*SCALE)level++;return level;}
function policy(revision){return {Version:2,Fee_BPS:2100,Team_BPS:[900,600,300],Growth_BPS:300,
    Gross_Rounding:'HalfUp_Cent',Fee_Rounding:'Exact_Micro',Quote_Revision:revision};}
function readPolicy(p){
    if(!p||!Number.isSafeInteger(p.Quote_Revision)||p.Quote_Revision<0)throw fail('Reservation pricing policy needs review.');
    const expected=policy(p.Quote_Revision);
    if(Object.keys(p).length!==Object.keys(expected).length||!Object.keys(expected).every(key=>JSON.stringify(p[key])===JSON.stringify(expected[key])))throw fail('Reservation pricing policy needs review.');
    return p;
}
function math(principal,level){
    if(!Number.isInteger(level)||level<1||level>6||principal<=0n||!representable(principal))throw fail('Invalid settlement principal or level.');
    // Preserve cent-based gross accrual using integer half-up, then split its exact micro-units.
    const gross=((principal*RATES[level]+50000000n)/100000000n)*10000n;
    const team=[9n,6n,3n].map(rate=>gross*rate/100n),growth=gross*3n/100n;
    const fee=team.reduce((sum,n)=>sum+n,growth),net=gross-fee;
    if(fee!==gross*21n/100n)throw fail('Fee allocation mismatch.');
    return {gross,fee,net,ret:principal+net,team,growth};
}
function base(asset){return {Version:1,Asset_ID:asset.assetId,Token_ID:asset.tokenId,Mint_TxHash:asset.mintHash,
    Initial_Price_micro:asset.priceMicro,Initial_Level:asset.level,Price_micro:asset.priceMicro,Level:asset.level,
    Revision:0,Total_Growth_micro:'0',Missing_Team_micro:'0',State:'Active'};}
function quote(asset,row,saved){
    const state=saved||base(asset);
    if(state.Version!==1||state.Asset_ID!==asset.assetId||state.Token_ID!==asset.tokenId||state.Mint_TxHash!==asset.mintHash||
        state.Initial_Price_micro!==asset.priceMicro||state.Initial_Level!==asset.level||state.State!=='Active'||
        !Number.isSafeInteger(state.Revision)||state.Revision<0||state.Revision>=Number.MAX_SAFE_INTEGER||
        state.Level!==tier(micro(state.Price_micro),asset.level)||micro(state.Price_micro)!==micro(asset.priceMicro)+micro(state.Total_Growth_micro)||
        !representable(micro(state.Price_micro))||row.Price_micro!==state.Price_micro||row.Price!==money(micro(state.Price_micro))||
        row.Level!==String(state.Level)||(row.Price_Revision??0)!==state.Revision)throw fail('NFT quote or price history changed. Administrator review required.');
    micro(state.Missing_Team_micro);
    return state;
}
function next(state,growth,missing,orderId,eventId){
    const total=micro(state.Total_Growth_micro)+growth,proposed=micro(state.Initial_Price_micro)+total;
    const paused=!representable(proposed);
    return {...state,Revision:state.Revision+1,Total_Growth_micro:total.toString(),
        Missing_Team_micro:(micro(state.Missing_Team_micro)+missing).toString(),
        Price_micro:paused?state.Price_micro:proposed.toString(),Level:paused?state.Level:tier(proposed,state.Initial_Level),
        State:paused?'Review':'Active',Proposed_Price_micro:proposed.toString(),Last_Order_ID:orderId,Last_Event_ID:eventId};
}
function eventId(docId,uid,orderId){return crypto.createHash('sha256').update(JSON.stringify(['NFT-GROWTH-V1',docId,uid,orderId])).digest('hex');}
function existingListing(asset,row,state){
    if(row.Asset_ID!==asset.assetId||row.Name!==asset.name||row.Image_URI!==asset.imageURI)return false;
    if(!state)return row.Level===String(asset.level)&&row.Price_micro===asset.priceMicro&&row.Price===asset.price;
    try {quote(asset,row,state);return true;}catch{
        return state?.State==='Review'&&state.Asset_ID===asset.assetId&&state.Token_ID===asset.tokenId&&
            state.Mint_TxHash===asset.mintHash&&row.Status==='PriceReview'&&row.Price_micro===state.Price_micro&&row.Price_Revision===state.Revision;
    }
}
module.exports={POLICY_VERSION,micro,money,representable,tier,policy,readPolicy,math,base,quote,next,eventId,existingListing};
