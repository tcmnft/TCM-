(function(root){
'use strict';
const targets={L2:[5,26,100],L3:[9,68,250],L4:[16,148,500],L5:[28,325,1000],L6:[45,550,2500]};
const states=['ACTIVE','SUSPENDED_HOLDING','AWAITING_RESERVATION_PROOF','MATURED','PAID','PURGED','POLICY_BLOCKED','ERROR'];
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function amount(s){if(typeof s!=='string'||! /^(0|[1-9][0-9]{0,39})$/.test(s))throw Error('Invalid amount');return BigInt(s);}
function money(s){const n=amount(s);return (n/1000000n).toString()+'.'+(n%1000000n/10000n).toString().padStart(2,'0');}
function progress(count,target){if(!integer(count)||!integer(target)||target===0)throw Error('Invalid progress');return {count,target,remaining:Math.max(0,target-count),percent:Math.min(100,count/target*100)};}
function envelope(x,uid){if(!x||x.schemaVersion!==1||typeof x.policyVersion!=='string'||!integer(x.revision)||!integer(x.serverTime)||!['fresh','stale'].includes(x.freshness)||x.uid!==uid)throw Error('Invalid response');return x;}
function capability(c){return !!c&&typeof c.allowed==='boolean'&&typeof c.reason==='string';}
function summary(x,uid){envelope(x,uid);const s=x.salary;if(!s||!targets[s.level]||!integer(s.a)||!integer(s.bc)||typeof s.period!=='string'||!capability(s.apply)||!['eligible','ineligible','policy-blocked'].includes(s.state))throw Error('Invalid salary summary');if(s.receipt!==undefined&&s.receipt!==null){receipt(s.receipt);if(s.receipt.uid!==uid)throw Error('Receipt ownership mismatch');}if(typeof x.referralRate!=='string'&&x.referralRate!==null)throw Error('Invalid rate');if(x.referralRate!==null){const rate=amount(x.referralRate);if(rate<3000000n||rate>12000000n)throw Error('Invalid rate range');}return x;}
function contract(c){if(!c||typeof c.order!=='string'||typeof c.downlineLabel!=='string'||!states.includes(c.state)||!integer(c.revision)||!integer(c.elapsed)||c.elapsed>604800||!integer(c.days)||!capability(c.claim)||typeof c.yieldStatus!=='string')throw Error('Invalid contract');amount(c.principal);if(c.state==='ACTIVE'&&!integer(c.activeSince))throw Error('Invalid active anchor');if(c.state==='SUSPENDED_HOLDING'&&!integer(c.deadline))throw Error('Invalid deadline');return c;}
function remaining(c,serverNow){return Math.max(0,c.state==='SUSPENDED_HOLDING'?c.deadline-serverNow:604800-c.elapsed-Math.max(0,serverNow-c.activeSince));}
function clock(serverTime,mono){return ()=>serverTime+Math.max(0,(performance.now()-mono)/1000);}
function receipt(x){if(!x||typeof x.reference!=='string'||!['NOT_REQUIRED','QUEUED','SUBMITTED','CONFIRMED','FAILED','RECONCILIATION_REQUIRED'].includes(x.payoutStatus)||!integer(x.at))throw Error('Invalid receipt');const g=amount(x.gross),d=amount(x.debtDeducted),n=amount(x.net),left=amount(x.remainingDebt);if(d>g||g-d!==n||n===0n&&x.payoutStatus!=='NOT_REQUIRED'||n>0n&&x.payoutStatus==='NOT_REQUIRED'||x.kind==='CLAIM_RESULT'&&n>0n&&x.payoutStatus!=='QUEUED')throw Error('Invalid receipt accounting');return x;}
function debtExample(g,d){g=amount(g);d=amount(d);const cut=g<d?g:d;return {gross:String(g),debtDeducted:String(cut),net:String(g-cut),remainingDebt:String(d-cut)};}
class Store{
 constructor(){this.switchUser(null);}
 switchUser(uid){this.uid=uid;this.generation=(this.generation||0)+1;this.revision=-1;this.pending=new Map();this.versions=new Map();}
 ticket(channel='summary'){const seq=(this.versions.get(channel)||0)+1;this.versions.set(channel,seq);return {uid:this.uid,generation:this.generation,seq,channel};}
 accept(t,x){if(t.uid!==this.uid||t.generation!==this.generation||this.versions.get(t.channel)!==t.seq)return false;envelope(x,this.uid);if(x.revision<this.revision)return false;this.revision=x.revision;return true;}
 request(order){if(!this.pending.has(order))this.pending.set(order,{key:crypto.randomUUID(),state:'pending'});return this.pending.get(order);}
}
const api={targets,states,integer,amount,money,progress,envelope,summary,contract,remaining,clock,receipt,debtExample,Store};if(typeof module!=='undefined')module.exports=api;root.TCMModel=api;
})(globalThis);
