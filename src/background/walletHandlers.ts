// Privileged wallet command handlers (T1.7). Invoked by the router ONLY for trusted extension-page
// senders. Composes the vault (M1) with key/address derivation. Decrypted material (mnemonic, root)
// lives only in these function scopes and is discarded on return (CLAUDE.md §1.1).
import type { WalletCommand, WalletStatus, WalletOverview, BuiltTx, SubmitResult, UtxoView } from '../shared/internal';
import { vault } from './vault';
import { chromeSessionStore, chromeLocalStore } from './storage';
import { touchAutoLock, cancelAutoLock } from './autolock';
import { mnemonicToRoot, deriveKey, Role } from '../core/keys';
import { accountKeys, baseAddress, baseAddressFrom, bech32Network } from '../core/address';
import { aggregateBalance, valueView } from '../core/balance';
import { buildSend } from '../core/tx/build';
import { summarizeTx } from '../core/tx/summary';
import { computeHistoryEntry, type HistoryEntry } from '../core/tx/history';
import type { AddressTxRef, AssetMetadata } from './provider/IChainProvider';
import { collectUtxos } from './provider/index';
import { signTxCbor } from './signer';
import { toHex } from '../core/crypto/encoding';
import { settings } from './settings';
import { getProvider, clearProviderCache } from './walletProvider';
import { discoverChain, nextReceiveIndex } from './discovery';
import { getPendingApproval, respondApproval } from './dapp/approvals';
import { fetchAssetImage } from './assetImage';
import { allowlist } from './dapp/allowlist';
import { resolveHandle, type ResolvedHandle } from '../core/handle';

async function status(): Promise<WalletStatus> {
  return { initialized: await vault.isInitialized(), unlocked: await vault.isUnlocked() };
}

// Short-lived overview cache: discovery is many provider round-trips, and React StrictMode fires
// effects twice on mount — without this the dashboard would double-scan. Module global → dies with SW.
const OVERVIEW_TTL_MS = 10_000;
const overviewCache = new Map<string, { at: number; data: WalletOverview }>();

async function overview(): Promise<WalletOverview> {
  const s = await settings.get();
  const cacheKey = `${s.network}:${s.providerKind}`;
  const hit = overviewCache.get(cacheKey);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.data;

  const provider = await getProvider();
  const mnemonic = await vault.getMnemonic(); // transient secret — discarded on return
  const root = mnemonicToRoot(mnemonic);
  touchAutoLock();

  // Gap-limit discovery over the external (receive) and internal (change) chains.
  const external = await discoverChain(root, s.network, Role.External, provider);
  const change = await discoverChain(root, s.network, Role.Internal, provider);
  const receiveAddress = baseAddress(root, bech32Network(s.network), 0, nextReceiveIndex(external), Role.External);

  const addresses = [...external, ...change].map((a) => a.address);
  // Include the next receive address so a freshly-funded new wallet still shows a balance.
  if (!addresses.includes(receiveAddress)) addresses.push(receiveAddress);
  const utxos = await collectUtxos(provider, addresses);

  const data: WalletOverview = {
    network: s.network,
    receiveAddress,
    usedExternal: external.length,
    usedChange: change.length,
    balance: aggregateBalance(utxos),
  };
  overviewCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---- Transaction history (read-only; needs historic state → Blockfrost/Koios, not Ogmios) ----
const HISTORY_TTL_MS = 15_000;
const HISTORY_LIMIT = 15;
const historyCache = new Map<string, { at: number; data: HistoryEntry[] }>();

async function history(): Promise<HistoryEntry[]> {
  const s = await settings.get();
  const cacheKey = `${s.network}:${s.providerKind}`;
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.data;

  const provider = await getProvider();
  // Bind so the optional methods keep their `this` and TS narrows away `undefined` (no non-null `!`).
  const getTxs = provider.getAddressTransactions?.bind(provider);
  const getDetail = provider.getTxDetail?.bind(provider);
  if (!getTxs || !getDetail) {
    throw new Error(`${provider.name} has no transaction history — switch to Blockfrost or Koios in Settings`);
  }

  const mnemonic = await vault.getMnemonic();
  const root = mnemonicToRoot(mnemonic);
  touchAutoLock();

  const external = await discoverChain(root, s.network, Role.External, provider);
  const change = await discoverChain(root, s.network, Role.Internal, provider);
  const receiveAddress = baseAddress(root, bech32Network(s.network), 0, nextReceiveIndex(external), Role.External);
  const ownAddrs = [...external, ...change].map((a) => a.address);
  if (!ownAddrs.includes(receiveAddress)) ownAddrs.push(receiveAddress);
  const ownSet = new Set(ownAddrs);

  // Collect recent tx refs across all own addresses, dedup by hash (newest blockTime wins).
  const refLists = await Promise.all(ownAddrs.map((a) => getTxs(a)));
  const byHash = new Map<string, AddressTxRef>();
  for (const list of refLists) {
    for (const r of list) {
      const prev = byHash.get(r.txHash);
      if (!prev || r.blockTime > prev.blockTime) byHash.set(r.txHash, r);
    }
  }
  const top = [...byHash.values()].sort((a, b) => b.blockTime - a.blockTime).slice(0, HISTORY_LIMIT);

  const data = await Promise.all(
    top.map(async (ref) => computeHistoryEntry(await getDetail(ref.txHash), ownSet, ref.blockTime)),
  );
  historyCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---- UTxO listing (read-only; the wallet's current unspent outputs across its HD addresses) ----
const UTXO_TTL_MS = 10_000;
const utxoCache = new Map<string, { at: number; data: UtxoView[] }>();

async function listUtxos(): Promise<UtxoView[]> {
  const s = await settings.get();
  const cacheKey = `${s.network}:${s.providerKind}`;
  const hit = utxoCache.get(cacheKey);
  if (hit && Date.now() - hit.at < UTXO_TTL_MS) return hit.data;

  const provider = await getProvider();
  const mnemonic = await vault.getMnemonic();
  const root = mnemonicToRoot(mnemonic);
  touchAutoLock();

  const external = await discoverChain(root, s.network, Role.External, provider);
  const change = await discoverChain(root, s.network, Role.Internal, provider);
  const receiveAddress = baseAddress(root, bech32Network(s.network), 0, nextReceiveIndex(external), Role.External);
  const addrs = [...external, ...change].map((a) => a.address);
  if (!addrs.includes(receiveAddress)) addrs.push(receiveAddress);

  const utxos = await collectUtxos(provider, addrs);
  const data: UtxoView[] = utxos.map((u) => ({
    txHash: u.utxoRef.id.toString(),
    outputIndex: u.utxoRef.index,
    address: u.resolved.address.toString(),
    value: valueView(u.resolved.value),
  }));
  utxoCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---- Asset display metadata (CIP-25/68 token names) ----
// Persisted in chrome.storage.local: NFT on-chain metadata is immutable, so a long TTL avoids
// re-fetching on every dashboard render and across SW respawns. A `null` result is cached too, so an
// asset with no metadata isn't re-queried each time.
const ASSET_META_KEY = 'bob:assetMeta';
const ASSET_META_TTL_MS = 24 * 60 * 60 * 1000; // 24h
type AssetMetaCache = Record<string, { md: AssetMetadata | null; at: number }>;

async function assetMetadata(unit: string): Promise<AssetMetadata | null> {
  // unit = policyId(56 hex) + assetName(≤64 hex). Reject anything malformed before it reaches a URL.
  if (!/^[0-9a-f]{56,120}$/i.test(unit)) return null;
  const s = await settings.get();
  const key = `${s.network}:${unit}`; // a unit can resolve differently per network — don't cross networks
  const cache = (await chromeLocalStore.get<AssetMetaCache>(ASSET_META_KEY)) ?? {};
  const hit = cache[key];
  if (hit && Date.now() - hit.at < ASSET_META_TTL_MS) return hit.md;
  const provider = await getProvider();
  const md = provider.getAssetMetadata ? await provider.getAssetMetadata(unit) : null;
  cache[key] = { md, at: Date.now() };
  await chromeLocalStore.set(ASSET_META_KEY, cache);
  return md;
}

// ---- Send flow (build → approve → submit) ----
// The unsigned tx is held in session keyed by a random id; approval references the id so the user
// can only sign the exact tx whose decoded summary they were shown (CLAUDE.md §1.5 integrity).
const PENDING_KEY = 'bob:pendingTx';

interface SignerRef {
  role: number;
  index: number;
}
interface PendingTx {
  id: string;
  txCbor: string; // unsigned
  signers: SignerRef[]; // distinct input owners
}

async function buildSendTx(toAddress: string, lovelace: string, memo?: string): Promise<BuiltTx> {
  const s = await settings.get();
  const provider = await getProvider();
  const mnemonic = await vault.getMnemonic();
  const root = mnemonicToRoot(mnemonic);
  touchAutoLock();

  const net = bech32Network(s.network);
  const keys = accountKeys(root, 0);

  // Discover wallet addresses (external + change) and build an address → (role,index) owner map.
  const external = await discoverChain(root, s.network, Role.External, provider);
  const change = await discoverChain(root, s.network, Role.Internal, provider);
  const receiveIdx = nextReceiveIndex(external);
  const changeIdx = nextReceiveIndex(change);
  const receiveAddress = baseAddressFrom(keys, net, receiveIdx, Role.External);
  const changeAddress = baseAddressFrom(keys, net, changeIdx, Role.Internal);

  const ownerByAddress = new Map<string, SignerRef>();
  for (const a of external) ownerByAddress.set(a.address, { role: Role.External, index: a.index });
  for (const a of change) ownerByAddress.set(a.address, { role: Role.Internal, index: a.index });
  ownerByAddress.set(receiveAddress, { role: Role.External, index: receiveIdx });
  ownerByAddress.set(changeAddress, { role: Role.Internal, index: changeIdx });

  // Candidate UTxOs to fund the tx: everything at our known addresses (+ next receive addr).
  const fundingAddrs = [...ownerByAddress.keys()];
  const utxos = await collectUtxos(provider, fundingAddrs);

  const tx = buildSend(
    {
      protocolParameters: await provider.getProtocolParameters(),
      genesisInfos: await provider.getGenesisInfos(),
      utxos,
      changeAddress,
    },
    { toAddress, lovelace: BigInt(lovelace) },
    memo !== undefined ? { memo } : {},
  );

  // Which keys must sign? The distinct owners of the inputs buildooor actually selected.
  const utxoByRef = new Map(utxos.map((u) => [u.utxoRef.toString(), u]));
  const signerByKey = new Map<string, SignerRef>();
  for (const inp of tx.body.inputs) {
    const u = utxoByRef.get(inp.utxoRef.toString());
    const owner = u && ownerByAddress.get(u.resolved.address.toString());
    if (owner) signerByKey.set(`${owner.role}/${owner.index}`, owner);
  }

  const summary = summarizeTx(tx, utxos, new Set(ownerByAddress.keys()));
  const pending: PendingTx = { id: crypto.randomUUID(), txCbor: toHex(tx.toCborBytes()), signers: [...signerByKey.values()] };
  await chromeSessionStore.set(PENDING_KEY, pending);
  return { id: pending.id, summary };
}

// ---- ADA Handle resolution (T8.1) ----
// Read-only: maps `$handle` → current holder address via the provider's asset-holder index. No secret
// access. The popup shows the resolved address for the user to verify before it ever reaches buildSend.
async function resolveHandleCmd(input: string): Promise<ResolvedHandle> {
  const provider = await getProvider();
  // Bind so `this` survives and TS narrows away the optional — no non-null `!` (CLAUDE.md §2).
  const getAssetAddresses = provider.getAssetAddresses?.bind(provider);
  if (!getAssetAddresses) {
    throw new Error(`${provider.name} can't resolve ADA Handles — switch to Blockfrost or Koios in Settings`);
  }
  return resolveHandle(input, { getAssetAddresses });
}

async function approveSendTx(id: string): Promise<SubmitResult> {
  const pending = await chromeSessionStore.get<PendingTx>(PENDING_KEY);
  if (!pending || pending.id !== id) throw new Error('no matching pending transaction');

  const provider = await getProvider();
  const root = mnemonicToRoot(await vault.getMnemonic());
  touchAutoLock();

  const keys = pending.signers.map((sgn) => deriveKey(root, 0, sgn.role, sgn.index));
  const signedCbor = signTxCbor(pending.txCbor, keys);
  const txHash = await provider.submitTx(signedCbor);

  await chromeSessionStore.remove(PENDING_KEY);
  overviewCache.clear(); // balance changed
  return { txHash };
}

export async function handleWalletCommand(command: WalletCommand): Promise<unknown> {
  switch (command.type) {
    case 'getStatus':
      return status();

    case 'create': {
      await vault.create(command.mnemonic, command.password); // throws if invalid / already exists
      touchAutoLock();
      return status();
    }

    case 'unlock': {
      await vault.unlock(command.password); // throws WrongPasswordError on bad password
      touchAutoLock();
      return status();
    }

    case 'lock': {
      await vault.lock();
      cancelAutoLock();
      return status();
    }

    case 'getAddress': {
      // Transiently decrypt → derive → return a bech32 address. No secret leaves this scope.
      const mnemonic = await vault.getMnemonic(); // throws VaultLockedError if locked
      const root = mnemonicToRoot(mnemonic);
      const net = bech32Network((await settings.get()).network);
      touchAutoLock(); // user activity
      return baseAddress(root, net, 0, command.index);
    }

    case 'getOverview':
      return overview();

    case 'getSettings':
      return settings.get();

    case 'updateSettings': {
      const next = await settings.update(command.patch);
      clearProviderCache();
      overviewCache.clear();
      return next;
    }

    case 'pingProvider': {
      // Connectivity check for the Settings UI: hit the chain tip with the current provider config.
      const provider = await getProvider();
      if (!provider.getTip) throw new Error(`${provider.name} cannot report a tip`);
      return provider.getTip();
    }

    case 'buildSend':
      return buildSendTx(command.toAddress, command.lovelace, command.memo);

    case 'approveSend':
      return approveSendTx(command.id);

    case 'cancelSend':
      return chromeSessionStore.remove(PENDING_KEY);

    case 'getPendingApproval':
      return getPendingApproval(command.reqId);

    case 'respondApproval':
      return respondApproval(command.reqId, command.approved);

    case 'listConnectedDapps':
      return allowlist.list();

    case 'revokeDapp':
      return allowlist.remove(command.origin);

    case 'getHistory':
      return history();

    case 'listUtxos':
      return listUtxos();

    case 'getTxStatus': {
      const provider = await getProvider();
      if (!provider.isConfirmed) return 'unknown';
      return (await provider.isConfirmed(command.txHash)) ? 'confirmed' : 'pending';
    }

    case 'getAssetMetadata':
      return assetMetadata(command.unit);

    case 'getAssetImage': {
      // Privacy gate: when NFT images are off, never contact the gateway at all.
      if ((await settings.get()).nftImages === false) return null;
      return fetchAssetImage(command.uri);
    }

    case 'resolveHandle':
      return resolveHandleCmd(command.handle);

    default: {
      // Exhaustiveness guard — a new command type without a handler is a compile error.
      const _never: never = command;
      throw new Error(`unhandled command: ${JSON.stringify(_never)}`);
    }
  }
}
