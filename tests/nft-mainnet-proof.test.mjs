import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interface, ZeroAddress } from 'ethers';
import { CUSTODY, FIRST_ASSET, FIRST_METADATA, assetKey } from '../lib/nft-mainnet-checks.mjs';
import { verifyDeployment, verifyMint } from '../lib/nft-mainnet-verify.mjs';

const artifact=JSON.parse(fs.readFileSync(new URL('../lib/tcm-mainnet-artifact.json',import.meta.url))),iface=new Interface(artifact.abi);
const deployHash='0x'+'11'.repeat(32),mintHash='0x'+'22'.repeat(32),address='0x3333333333333333333333333333333333333333';
const deployBlock='0x'+'44'.repeat(32),mintBlock='0x'+'55'.repeat(32),headHash='0x'+'66'.repeat(32);
function fixture(mode='ok'){
  const key=assetKey(FIRST_ASSET),calls=[];
  const logs=[iface.encodeEventLog(iface.getEvent('Transfer'),[ZeroAddress,CUSTODY,1n]),
    iface.encodeEventLog(iface.getEvent('AssetMinted'),[key,1n,CUSTODY,mode==='event-uri'?'ipfs://wrong':FIRST_METADATA])].map(log=>({...log,address}));
  const receipts={
    [deployHash]:{hash:deployHash,status:mode==='failed'?0:1,blockNumber:100,blockHash:deployBlock,contractAddress:address,logs:[]},
    [mintHash]:{hash:mintHash,status:1,blockNumber:200,blockHash:mintBlock,logs:mode==='logs'?[]:logs}
  };
  const transactions={
    [deployHash]:{hash:deployHash,from:CUSTODY,to:null,value:mode==='value'?1n:0n,chainId:56n,nonce:0,blockNumber:100,blockHash:deployBlock,
      data:mode==='build'?'0x00':artifact.bytecode+iface.encodeDeploy([CUSTODY]).slice(2)},
    [mintHash]:{hash:mintHash,from:mode==='sender'?ZeroAddress:CUSTODY,to:address,value:0n,chainId:56n,nonce:1,blockNumber:200,blockHash:mintBlock,
      data:iface.encodeFunctionData('mintOnce',[mode==='asset'?assetKey('TCM-002'):key,FIRST_METADATA])}
  };
  const provider={
    async send(method){assert.equal(method,'eth_chainId');calls.push(method);return mode==='testnet'?'0x61':'0x38'},
    async getNetwork(){calls.push('network');return {chainId:mode==='testnet'?97n:56n}},
    async getTransactionReceipt(hash){calls.push('receipt');return mode==='missing'?null:receipts[hash]},
    async getTransaction(hash){return transactions[hash]},
    async getBlock(number){
      if(number==='latest')return {number:mode==='low'?201:1000,hash:headHash};
      return {number,hash:number===100?deployBlock:number===200?(mode==='reorg'?headHash:mintBlock):(mode==='head-reorg'?mintBlock:headHash)};
    },async getCode(){return mode==='no-code'?'0x':'0x1234'}
  };
  const make=()=>({
    async custody(){return CUSTODY},async minter(){return CUSTODY},async ALLOWED_CHAIN_ID(){return 56n},
    async MAX_SUPPLY(){return mode==='cap'?20n:1000n},async supportsInterface(){return mode!=='interface'},
    async ownerOf(){return mode==='owner'?ZeroAddress:CUSTODY},async tokenURI(){return mode==='uri'?'ipfs://wrong':FIRST_METADATA},
    async tokenForAsset(){return mode==='mapping'?2n:1n}
  });
  return {provider,make,calls};
}

test('read-only verification accepts matching deployment and mint snapshots',async()=>{
  const f=fixture();const deployment=await verifyDeployment(f.provider,artifact,deployHash,f.make);
  assert.equal(deployment.address,address);assert.equal(deployment.chainId,'56');
  const minted=await verifyMint(f.provider,artifact,deployHash,mintHash,f.make);
  assert.equal(minted.tokenId,'1');assert.equal(minted.owner,CUSTODY);assert.equal(minted.confirmations,801);
  assert(!f.calls.some(key=>/sendTransaction|sendRawTransaction|sign/.test(key)));
});

test('verification blocks testnet before reading receipts',async()=>{
  const f=fixture('testnet');await assert.rejects(verifyDeployment(f.provider,artifact,deployHash,f.make),/Mainnet/);
  assert(!f.calls.includes('receipt'));
});

test('verification rejects failed, missing, altered deployment and contract identities',async t=>{
  for(const mode of ['failed','missing','value','build','cap','interface','no-code'])await t.test(mode,async()=>{
    const f=fixture(mode);await assert.rejects(verifyDeployment(f.provider,artifact,deployHash,f.make));
  });
});

test('verification rejects wrong mint sender, asset, events, URI, owner and mapping',async t=>{
  for(const mode of ['sender','asset','logs','event-uri','uri','owner','mapping'])await t.test(mode,async()=>{
    const f=fixture(mode);await assert.rejects(verifyMint(f.provider,artifact,deployHash,mintHash,f.make));
  });
});

test('verification rejects low confirmations and changed canonical blocks',async t=>{
  for(const mode of ['low','reorg','head-reorg'])await t.test(mode,async()=>{
    const f=fixture(mode);await assert.rejects(verifyMint(f.provider,artifact,deployHash,mintHash,f.make));
  });
});
