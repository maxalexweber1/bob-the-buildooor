// Privileged wallet command handlers (T1.7). Invoked by the router ONLY for trusted extension-page
// senders. Composes the vault (M1) with key/address derivation. Decrypted material (mnemonic, root)
// lives only in these function scopes and is discarded on return (CLAUDE.md §1.1).
import type { WalletCommand, WalletStatus, WalletOverview, BuiltTx, SubmitResult } from '../shared/internal';
import { vault } from './vault';
import { chromeSessionStore } from './storage';
import { touchAutoLock, cancelAutoLock } from './autolock';
import { mnemonicToRoot, deriveKey, Role } from '../core/keys';
import { accountKeys, baseAddress, baseAddressFrom, bech32Network } from '../core/address';
import { aggregateBalance } from '../core/balance';
import { buildSend } from '../core/tx/build';
import { summarizeTx } from '../core/tx/summary';
import { signTxCbor } from './signer';
import { toHex } from '../core/crypto/encoding';
import { settings } from './settings';
import { getProvider, clearProviderCache } from './walletProvider';
import { discoverChain, nextReceiveIndex } from './discovery';
import { getPendingApproval, respondApproval } from './dapp/approvals';

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
  const utxos = (await Promise.all(addresses.map((a) => provider.getUtxos(a)))).flat();

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

async function buildSendTx(toAddress: string, lovelace: string): Promise<BuiltTx> {
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
  const utxos = (await Promise.all(fundingAddrs.map((a) => provider.getUtxos(a)))).flat();

  const tx = buildSend(
    {
      protocolParameters: await provider.getProtocolParameters(),
      genesisInfos: await provider.getGenesisInfos(),
      utxos,
      changeAddress,
    },
    { toAddress, lovelace: BigInt(lovelace) },
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
      return buildSendTx(command.toAddress, command.lovelace);

    case 'approveSend':
      return approveSendTx(command.id);

    case 'cancelSend':
      return chromeSessionStore.remove(PENDING_KEY);

    case 'getPendingApproval':
      return getPendingApproval();

    case 'respondApproval':
      return respondApproval(command.reqId, command.approved);

    case 'getTxStatus': {
      const provider = await getProvider();
      if (!provider.isConfirmed) return 'unknown';
      return (await provider.isConfirmed(command.txHash)) ? 'confirmed' : 'pending';
    }

    default: {
      // Exhaustiveness guard — a new command type without a handler is a compile error.
      const _never: never = command;
      throw new Error(`unhandled command: ${JSON.stringify(_never)}`);
    }
  }
}
