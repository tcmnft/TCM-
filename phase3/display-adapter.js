(function(root){
 'use strict';
 const mode='READ_ONLY_SAMPLE_PREVIEW';
 const capabilities=Object.freeze({apply:false,claim:false,batch:false,publish:false,payout:false,disbursal:false});
 const time=1793707200;
 function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
 function read(scenario='partial'){
  if(!['partial','full'].includes(scenario))throw Error('Unknown sample scenario');
  return freeze({mode,sample:true,capabilities,scenario,sampleTime:time,policyVersion:'APPROVED-CONSTANTS-DISPLAY-ONLY',
   salary:{level:'L2',a:scenario==='full'?5:3,bc:scenario==='full'?26:18,targetA:5,targetBC:26,cap:'100.00',period:'SAMPLE · November 2026 IST'},
   referral:{range:'$3–$12',current:'$3.60',label:'SAMPLE current rate'},
   contracts:['ACTIVE','SUSPENDED_HOLDING','MATURED','PAID','PURGED'].map((state,i)=>({order:'PREVIEW-REF-'+(i+1),downline:'Fictional member ••'+(41+i),principal:'3.60',state,elapsed:state==='MATURED'||state==='PAID'?604800:172800,days:state==='MATURED'||state==='PAID'?3:2,activeSince:time,deadline:time+259200,receipt:state==='PAID'?'PREVIEW-RECEIPT-4':null})),
   receipts:[{reference:'PREVIEW-SALARY-90',gross:'100.00',deduction:'10.00',net:'90.00',debt:'0.00',status:'QUEUED'},{reference:'PREVIEW-SALARY-0',gross:'100.00',deduction:'100.00',net:'0.00',debt:'50.00',status:'NOT_REQUIRED'},{reference:'PREVIEW-HISTORY-CONFIRMED',gross:'100.00',deduction:'10.00',net:'90.00',debt:'0.00',status:'CONFIRMED'}],
   policies:[['L1','$3–$5','—'],['L2','$5–$7','$100'],['L3','$6–$8','$250'],['L4','$7–$9.50','$500'],['L5','$8–$11','$1,000'],['L6','$9–$12','$2,500']],
   queue:['AWAITING_REVIEW','BLOCKED','QUEUED','SUBMITTED','CONFIRMED','FAILED','RECONCILIATION_REQUIRED'].map((status,i)=>({order:'PREVIEW-SAL-'+(i+1),uid:'Fictional ••'+(61+i),amount:'90.00',status,audit:'PREVIEW-AUDIT-'+(i+1)}))});
 }
 root.TCMDisplayAdapter=Object.freeze({read});
})(globalThis);
