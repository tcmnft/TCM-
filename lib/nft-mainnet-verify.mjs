import { Contract, Interface, getAddress, keccak256 } from 'ethers';
import { CHAIN_ID, CUSTODY, requireMainnet, deploymentMatches, verifyMintLogs, assetKey, FIRST_ASSET, FIRST_METADATA } from './nft-mainnet-checks.mjs';

export function requireArtifact(artifact) {
  if (artifact.chainId !== 56 || artifact.maxSupply !== 1000 || keccak256(artifact.bytecode) !== artifact.bytecodeHash) {
    throw new Error('Unexpected Mainnet build.');
  }
}
async function snapshotReceipt(provider, hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('A complete transaction hash is required.');
  requireMainnet(await provider.send('eth_chainId', []));
  requireMainnet((await provider.getNetwork()).chainId);
  const [receipt, tx, head] = await Promise.all([
    provider.getTransactionReceipt(hash), provider.getTransaction(hash), provider.getBlock('latest')
  ]);
  if (!receipt || !tx || !head) throw new Error('Transaction unavailable or not mined. Recover later; do not resend.');
  if (receipt.status !== 1) throw new Error('Transaction reverted. Preserve evidence and review before another attempt.');
  if (tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.hash.toLowerCase() !== hash.toLowerCase() ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Error('Transaction / receipt identity mismatch.');
  const confirmations = head.number - receipt.blockNumber + 1;
  if (!Number.isSafeInteger(confirmations) || confirmations < 3) throw new Error('At least 3 confirmations required. Use recovery later.');
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) throw new Error('Receipt block is not canonical.');
  return { receipt, tx, head, confirmations };
}
async function finishSnapshot(provider, head) {
  const block = await provider.getBlock(head.number);
  requireMainnet(await provider.send('eth_chainId', []));
  requireMainnet((await provider.getNetwork()).chainId);
  if (!block || block.hash !== head.hash) throw new Error('Snapshot block changed during verification.');
}

export async function verifyDeployment(provider, artifact, hash, makeContract = (address, abi, p) => new Contract(address, abi, p)) {
  requireArtifact(artifact);
  const { receipt, tx, head, confirmations } = await snapshotReceipt(provider, hash);
  const iface = new Interface(artifact.abi);
  deploymentMatches(artifact, tx, CUSTODY, iface);
  if (BigInt(tx.chainId) !== CHAIN_ID || getAddress(tx.from) !== CUSTODY || !receipt.contractAddress) throw new Error('Wrong deployment sender or chain.');
  const address = getAddress(receipt.contractAddress);
  const contract = makeContract(address, artifact.abi, provider);
  const at = { blockTag: head.number };
  const [code, custody, minter, chain, cap, erc721, metadata] = await Promise.all([
    provider.getCode(address, head.number), contract.custody(at), contract.minter(at),
    contract.ALLOWED_CHAIN_ID(at), contract.MAX_SUPPLY(at),
    contract.supportsInterface('0x80ac58cd', at), contract.supportsInterface('0x5b5e139f', at)
  ]);
  if (!code || code === '0x' || getAddress(custody) !== CUSTODY || getAddress(minter) !== CUSTODY ||
      chain !== CHAIN_ID || cap !== 1000n || !erc721 || !metadata) throw new Error('Contract identity or custody mismatch.');
  await finishSnapshot(provider, head);
  return { hash, address, from: tx.from, nonce: tx.nonce, chainId: '56', custody: CUSTODY,
    buildHash: artifact.bytecodeHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    snapshotBlockNumber: head.number, snapshotBlockHash: head.hash, confirmations, checkedAt: new Date().toISOString() };
}

// Compatibility wrapper: callers without an asset expectation still verify TCM-001 only.
export async function verifyMint(provider, artifact, deploymentHash, mintHash, makeContract) {
  return verifyAssetMint(provider, artifact, deploymentHash, mintHash,
    { assetId: FIRST_ASSET, metadataURI: FIRST_METADATA }, makeContract);
}

export async function verifyAssetMint(provider, artifact, deploymentHash, mintHash, expected,
  makeContract = (address, abi, p) => new Contract(address, abi, p)) {
  const expectedAsset = expected?.assetId, expectedMetadata = expected?.metadataURI;
  const key = assetKey(expectedAsset);
  if (typeof expectedMetadata !== 'string' || !/^ipfs:\/\/[A-Za-z0-9]{10,120}$/.test(expectedMetadata) ||
      (expected.tokenId !== undefined && (typeof expected.tokenId !== 'string' ||
       !/^[1-9]\d{0,3}$/.test(expected.tokenId) || BigInt(expected.tokenId) > 1000n))) {
    throw new Error('Invalid expected Mainnet asset identity.');
  }
  const deployment = await verifyDeployment(provider, artifact, deploymentHash, makeContract);
  if (expected.contract !== undefined && getAddress(expected.contract) !== deployment.address) {
    throw new Error('Deployment contract does not match the expected collection.');
  }
  const { receipt, tx, head, confirmations } = await snapshotReceipt(provider, mintHash);
  const iface = new Interface(artifact.abi);
  if (BigInt(tx.chainId) !== CHAIN_ID || tx.value !== 0n || getAddress(tx.from) !== CUSTODY ||
      !tx.to) throw new Error('Mint sender, network, value or destination mismatch.');
  const direct = getAddress(tx.to) === deployment.address;
  if (direct) {
    const input = iface.parseTransaction({ data: tx.data, value: tx.value });
    if (!input || input.name !== 'mintOnce' || input.args[0] !== key || input.args[1] !== expectedMetadata) throw new Error('Mint input mismatch.');
  } else if (![2, 4].includes(Number(tx.type))) {
    throw new Error('Unsupported wrapped mint envelope.');
  }
  // Wrapped execution is proven by this deployed contract's canonical mint events
  // and pinned custody/URI/mapping reads below, not by the outer wrapper input.
  const executionMode = direct ? 'Direct_Input_And_Events' : 'Wallet_Wrapped_Events';
  const tokenId = verifyMintLogs(receipt, iface, deployment.address, key, CUSTODY);
  if (tokenId < 1n || tokenId > 1000n || (expected.tokenId !== undefined && tokenId.toString() !== expected.tokenId)) throw new Error('Invalid token ID.');
  const minted = receipt.logs.filter(log => log.address.toLowerCase() === deployment.address.toLowerCase())
    .map(log => { try { return iface.parseLog(log); } catch { return null; } })
    .find(event => event?.name === 'AssetMinted' && event.args.assetKey === key);
  if (!minted || minted.args.metadataURI !== expectedMetadata) throw new Error('Mint event metadata mismatch.');
  const contract = makeContract(deployment.address, artifact.abi, provider);
  const at = { blockTag: head.number };
  const [owner, uri, mapped] = await Promise.all([
    contract.ownerOf(tokenId, at), contract.tokenURI(tokenId, at), contract.tokenForAsset(key, at)
  ]);
  if (getAddress(owner) !== CUSTODY || uri !== expectedMetadata || mapped !== tokenId) throw new Error('Current token custody, metadata or asset mapping mismatch.');
  await finishSnapshot(provider, head);
  return { hash: mintHash, contract: deployment.address, tokenId: tokenId.toString(), assetId: expectedAsset,
    assetKey: key, metadataURI: uri, owner: CUSTODY, from: tx.from, nonce: tx.nonce,
    executionMode, outerTo: getAddress(tx.to), outerType: Number(tx.type ?? 0),
    chainId: '56', deploymentHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    snapshotBlockNumber: head.number, snapshotBlockHash: head.hash, confirmations, checkedAt: new Date().toISOString() };
}
