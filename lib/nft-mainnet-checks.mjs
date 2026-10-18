import { getAddress, keccak256, toUtf8Bytes } from 'ethers';

export const CHAIN_ID = 56n;
export const CUSTODY = getAddress('0x1E7d9Aa6922eb5CC6e91d289a4Bb5b45212cA2f3');
export const EXPLORER = 'https://bscscan.com';
export const RPC = 'https://bsc-dataseed.bnbchain.org';

export function requireMainnet(chainId) {
  if (BigInt(chainId) !== CHAIN_ID) throw new Error('BSC Mainnet (56) required. Other networks are blocked.');
}

export function assetKey(value) {
  if (typeof value !== 'string' || (!/^TCM-[A-Z0-9-]{1,48}$/.test(value) || value.startsWith('TCM-TEST-'))) {
    throw new Error('Use a stable TCM- asset ID; testnet asset IDs are blocked.');
  }
  return keccak256(toUtf8Bytes(value));
}

export function deploymentMatches(artifact, tx, custody, iface) {
  if (tx.to !== null || BigInt(tx.value) !== 0n) throw new Error('Not a zero-value contract deployment.');
  const encoded = iface.encodeDeploy([custody]);
  if (tx.data.toLowerCase() !== (artifact.bytecode + encoded.slice(2)).toLowerCase()) {
    throw new Error('Deployment input does not match this build and custody address.');
  }
}

export function verifyMintLogs(receipt, iface, contract, key, custody) {
  const events = receipt.logs.filter(l => l.address.toLowerCase() === contract.toLowerCase())
    .map(l => { try { return iface.parseLog(l); } catch { return null; } });
  const custom = events.filter(e => e?.name === 'AssetMinted' && e.args.assetKey === key);
  if (custom.length !== 1) throw new Error('Expected one matching AssetMinted event.');
  const event = custom[0];
  if (getAddress(event.args.recipient) !== getAddress(custody)) throw new Error('Wrong mint recipient.');
  const transfer = events.filter(e => e?.name === 'Transfer' &&
    e.args.from === '0x0000000000000000000000000000000000000000' &&
    getAddress(e.args.to) === getAddress(custody) && e.args.tokenId === event.args.tokenId);
  if (transfer.length !== 1) throw new Error('Expected one matching ERC-721 mint Transfer event.');
  return event.args.tokenId;
}

export const FIRST_ASSET = 'TCM-001';
export const FIRST_METADATA = 'ipfs://bafkreicclrukvzu4b3xffcjmiusg3tfdllgmzphndxqcth5ghsjwjtgcrm';
export const FIRST_IMAGE = 'ipfs://bafkreifqldbwckt7rtkztrub62p3sqc3lo3pcvpb4maacs6lizo6vr77ky';
