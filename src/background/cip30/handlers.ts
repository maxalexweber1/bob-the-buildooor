// CIP-30 method dispatch (EXECUTION_PLAN T4.2/T4.4). Runs in the background for dApp requests that
// arrive via the content relay with a content-stamped trusted `origin` (CLAUDE.md §1.6).
//   - enable()/isEnabled gate on the origin allowlist; enable() prompts for consent (T4.1).
//   - every other method requires an enabled origin AND an unlocked wallet.
//   - all returns are hex (address bytes / cbor) per the CIP-30 spec.
//   - signTx (witness-set only) and signData (CIP-8 COSE) are per-call approval-gated (T4.3/T4.5).
import { Address, Tx, Value, type UTxO, type XPrv } from '@harmoniclabs/buildooor';
import { allowlist } from '../dapp/allowlist';
import { requestApproval } from '../dapp/approvals';
import {
  apiError,
  refused,
  internalError,
  txSendFailure,
  APIErrorCode,
  TxSignErrorCode,
  DataSignErrorCode,
  Cip30Error,
  PaginateError,
} from '../../shared/errors';
import { vault } from '../vault';
import { negotiateExtensions, extensionCipOf, type Extension } from '../../shared/extensions';
import { settings, type WalletSettings } from '../settings';
import { getProvider } from '../walletProvider';
import { touchAutoLock } from '../autolock';
import { mnemonicToRoot, deriveKey, Role } from '../../core/keys';
import {
  accountKeys,
  baseAddressFrom,
  bech32Network,
  rewardAddress,
  drepPublicKey,
  stakePublicKey,
  type AccountKeys,
} from '../../core/address';
import { summarizeTx } from '../../core/tx/summary';
import { valueView } from '../../core/balance';
import { buildCoseSign1 } from '../../core/cose/sign';
import { signTxWitnessSet } from '../signer';
import type { IChainProvider } from '../provider/index';
import { discoverChain, nextReceiveIndex } from '../discovery';
import { toHex, fromHex } from '../../core/crypto/encoding';

interface OwnerRef {
  role: number;
  index: number;
}

interface Paginate {
  page: number;
  limit: number;
}

/**
 * Only a well-formed secure web origin may drive the bridge. This rejects the empty/opaque origin
 * (`''`, `'null'` from sandboxed/`data:`/`file:` frames) BEFORE it could ever be persisted to the
 * allowlist — otherwise a single approval of an opaque origin would silently grant every opaque-origin
 * frame read access forever (security review #3). Localhost over http is allowed for local dApp dev.
 */
export function isValidDappOrigin(origin: string): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export async function handleCip30(method: string, params: unknown[], origin: string): Promise<unknown> {
  // Trust no opaque/malformed origin — never enable, query, or sign for one.
  if (!isValidDappOrigin(origin)) {
    if (method === 'isEnabled') return false;
    throw refused('refused: invalid or untrusted origin');
  }
  if (method === 'isEnabled') return allowlist.has(origin);
  if (method === 'enable') return enable(origin, params[0]);

  // Every other method is gated on an enabled origin.
  if (!(await allowlist.has(origin))) throw refused('origin not enabled — call enable() first');
  return authedMethod(method, params, origin);
}

/**
 * CIP-30 enable({extensions}): negotiate the granted extensions (requested ∩ supported), prompt for
 * consent on a not-yet-authorized origin, persist the origin + granted extensions, and return the
 * granted set so the inpage provider can expose exactly those namespaces. Re-enabling an already
 * authorized origin updates its extensions without re-prompting (governance methods are still
 * per-call approval-gated). `requestedExtensions` is untrusted page input — negotiate() validates it.
 */
async function enable(origin: string, requestedExtensions: unknown): Promise<Extension[]> {
  const granted = negotiateExtensions(requestedExtensions);
  if (!(await allowlist.has(origin))) {
    const approved = await requestApproval('connect', origin);
    if (!approved) throw refused('connection request declined');
  }
  await allowlist.add(origin, granted);
  return granted.map((cip) => ({ cip }));
}

async function authedMethod(method: string, params: unknown[], origin: string): Promise<unknown> {
  const s = await settings.get();
  if (method === 'getNetworkId') return networkId(s);
  // getExtensions just reports the per-origin negotiated set — no keys/unlock required.
  if (method === 'getExtensions') return (await allowlist.getExtensions(origin)).map((cip) => ({ cip }));

  // Extension methods (cipNN.*) are only callable if that extension was negotiated for this origin.
  // The inpage provider already hides un-granted namespaces, but a hostile page can craft a raw
  // postMessage bypassing it (CLAUDE.md §6 — trust no page input), so enforce it here too.
  const extCip = extensionCipOf(method);
  if (extCip !== null && !(await allowlist.getExtensions(origin)).includes(extCip)) {
    throw apiError(APIErrorCode.InvalidRequest, `cip-${extCip} extension not enabled for this origin`);
  }

  // The rest need keys (unlocked) + chain data.
  if (!(await vault.isUnlocked())) throw internalError('wallet is locked');
  const provider = await getProvider();
  const root = mnemonicToRoot(await vault.getMnemonic());
  touchAutoLock();
  const net = bech32Network(s.network);
  const keys = accountKeys(root, 0);
  const addrHex = (bech32: string) => toHex(Address.fromString(bech32).toBuffer());

  switch (method) {
    case 'getUsedAddresses': {
      const ext = await discoverChain(root, s.network, Role.External, provider);
      return paginate(ext.map((a) => addrHex(a.address)), params[0] as Paginate | undefined);
    }
    case 'getUnusedAddresses': {
      const ext = await discoverChain(root, s.network, Role.External, provider);
      return [addrHex(baseAddressFrom(keys, net, nextReceiveIndex(ext), Role.External))];
    }
    case 'getChangeAddress': {
      const chg = await discoverChain(root, s.network, Role.Internal, provider);
      return addrHex(baseAddressFrom(keys, net, nextReceiveIndex(chg), Role.Internal));
    }
    case 'getRewardAddresses':
      return [toHex(rewardAddress(keys, net).toBuffer())];

    case 'getBalance': {
      const utxos = await collectUtxos(root, s, provider);
      return toHex(totalValue(utxos).toCborBytes());
    }
    case 'getUtxos': {
      const utxos = await collectUtxos(root, s, provider);
      const selected = selectUtxos(utxos, params[0] as string | undefined);
      if (selected === null) return null; // requested amount unattainable (CIP-30 semantics)
      return paginate(selected.map((u) => toHex(u.toCborBytes())), params[1] as Paginate | undefined);
    }
    // DEPRECATED in CIP-30 in favour of CIP-40 explicit collateral-output tx fields, but still
    // implemented: many shipping dApps continue to call it to source ADA-only collateral UTxOs.
    case 'getCollateral': {
      const requested = parseAmount(params[0] as string | undefined) ?? 5_000_000n;
      const utxos = await collectUtxos(root, s, provider);
      const adaOnly = utxos.filter((u) => valueView(u.resolved.value).assets.length === 0);
      adaOnly.sort((a, b) => (a.resolved.value.lovelaces > b.resolved.value.lovelaces ? 1 : -1)); // small first
      const picked: UTxO[] = [];
      let sum = 0n;
      for (const u of adaOnly) {
        picked.push(u);
        sum += u.resolved.value.lovelaces;
        if (sum >= requested) break;
      }
      return sum >= requested ? picked.map((u) => toHex(u.toCborBytes())) : [];
    }

    case 'submitTx':
      return submit(provider, params[0] as string);

    case 'signTx':
      return signTx(root, s, provider, keys, origin, params[0] as string, (params[1] as boolean) ?? false);

    case 'signData':
      return signData(root, s, provider, keys, origin, params[0] as string, params[1] as string);

    // ---- CIP-95 (Conway governance) ----
    case 'cip95.getPubDRepKey':
      return toHex(drepPublicKey(keys));
    case 'cip95.getRegisteredPubStakeKeys':
      // TODO(M6): query on-chain stake registration. Until then, none reported as registered.
      return [];
    case 'cip95.getUnregisteredPubStakeKeys':
      return [toHex(stakePublicKey(keys))];
    case 'cip95.signData':
      // TODO(M6): COSE-sign with the DRep key for a DRep credential / vote auth.
      throw apiError(APIErrorCode.InternalError, 'cip95.signData not yet implemented');

    default:
      throw apiError(APIErrorCode.InvalidRequest, `unknown method: ${method}`);
  }
}

/** Address → (role,index) for every wallet-owned address (used external/change + next receive/change). */
async function ownerMap(
  root: XPrv,
  s: WalletSettings,
  provider: IChainProvider,
  keys: AccountKeys,
): Promise<Map<string, OwnerRef>> {
  const net = bech32Network(s.network);
  const ext = await discoverChain(root, s.network, Role.External, provider);
  const chg = await discoverChain(root, s.network, Role.Internal, provider);
  const map = new Map<string, OwnerRef>();
  for (const a of ext) map.set(a.address, { role: Role.External, index: a.index });
  for (const a of chg) map.set(a.address, { role: Role.Internal, index: a.index });
  const ri = nextReceiveIndex(ext);
  const ci = nextReceiveIndex(chg);
  map.set(baseAddressFrom(keys, net, ri, Role.External), { role: Role.External, index: ri });
  map.set(baseAddressFrom(keys, net, ci, Role.Internal), { role: Role.Internal, index: ci });
  return map;
}

async function signTx(
  root: XPrv,
  s: WalletSettings,
  provider: IChainProvider,
  keys: AccountKeys,
  origin: string,
  txCbor: string,
  partialSign: boolean,
): Promise<string> {
  const tx = Tx.fromCbor(txCbor);
  const resolved = await provider.resolveUtxos([...tx.body.inputs].map((i) => i.utxoRef));
  const owners = await ownerMap(root, s, provider, keys);
  const summary = summarizeTx(tx, resolved, new Set(owners.keys()));

  if (!(await requestApproval('signTx', origin, summary))) {
    throw new Cip30Error(TxSignErrorCode.UserDeclined, 'user declined signing');
  }

  const signerRefs = new Map<string, OwnerRef>();
  for (const u of resolved) {
    const o = owners.get(u.resolved.address.toString());
    if (o) signerRefs.set(`${o.role}/${o.index}`, o);
  }
  if (signerRefs.size === 0 && !partialSign) {
    throw new Cip30Error(TxSignErrorCode.ProofGeneration, 'wallet owns none of the inputs');
  }
  const signingKeys = [...signerRefs.values()].map((o) => deriveKey(root, 0, o.role, o.index));

  // Conway (CIP-95): certificates, governance actions and reward withdrawals are authorized by the
  // STAKE (…/2/0) and DRep (…/3/0) keys, not a payment key. Offer them when the tx contains such
  // components — buildooor's signWith only adds a witness for keys the tx actually requires (T6.2).
  // NOTE: this path is implemented but UNVERIFIED on-chain: the installed buildooor's tx layer does
  // not yet recognize Conway governance certs (`isCertificate(CertVoteDeleg)` is false), so a vote-
  // delegation/DRep tx can't be built or round-tripped to test it here. Revisit when buildooor adds
  // Conway-governance-cert support (track alongside the keepRelevant PR).
  if (summary.flags.certificates || summary.flags.governance || summary.withdrawals.length > 0) {
    signingKeys.push(deriveKey(root, 0, Role.Staking, 0), deriveKey(root, 0, Role.DRep, 0));
  }
  return signTxWitnessSet(txCbor, signingKeys);
}

async function signData(
  root: XPrv,
  s: WalletSettings,
  provider: IChainProvider,
  keys: AccountKeys,
  origin: string,
  addressHex: string,
  payloadHex: string,
): Promise<{ signature: string; key: string }> {
  const address = Address.fromBytes(fromHex(addressHex));
  const owner = (await ownerMap(root, s, provider, keys)).get(address.toString());
  if (!owner) throw new Cip30Error(DataSignErrorCode.AddressNotPK, 'address is not a key address owned by this wallet');

  if (!(await requestApproval('signData', origin, { address: address.toString(), payloadHex }))) {
    throw new Cip30Error(DataSignErrorCode.UserDeclined, 'user declined');
  }

  const signingKey = deriveKey(root, 0, owner.role, owner.index);
  return buildCoseSign1(
    fromHex(payloadHex),
    address.toBuffer(),
    signingKey.toPrivateKeyBytes(),
    signingKey.public().toPubKeyBytes(),
  );
}

/** CIP-30 amount: a cbor<value> hex, or (loosely) a decimal lovelace string. Null if absent/unparseable. */
function parseAmount(amount?: string): bigint | null {
  if (!amount) return null;
  try {
    return Value.fromCbor(amount).lovelaces;
  } catch {
    try {
      return BigInt(amount);
    } catch {
      return null;
    }
  }
}

function networkId(s: WalletSettings): number {
  return s.network === 'mainnet' ? 1 : 0;
}

/** UTxOs across the wallet's used external+change addresses (and the next receive address). */
async function collectUtxos(
  root: ReturnType<typeof mnemonicToRoot>,
  s: WalletSettings,
  provider: IChainProvider,
): Promise<UTxO[]> {
  const ext = await discoverChain(root, s.network, Role.External, provider);
  const chg = await discoverChain(root, s.network, Role.Internal, provider);
  const keys = accountKeys(root, 0);
  const net = bech32Network(s.network);
  const receive = baseAddressFrom(keys, net, nextReceiveIndex(ext), Role.External);
  const addrs = new Set([...ext.map((a) => a.address), ...chg.map((a) => a.address), receive]);
  return (await Promise.all([...addrs].map((a) => provider.getUtxos(a)))).flat();
}

function totalValue(utxos: UTxO[]): Value {
  return utxos.reduce((acc, u) => Value.add(acc, u.resolved.value), Value.lovelaces(0n));
}

/** Greedy selection to cover a CIP-30 `amount` (cbor<value> hex) across ADA AND native assets.
 *  Returns null if the requested value is unattainable (CIP-30 semantics). */
export function selectUtxos(utxos: UTxO[], amountHex?: string): UTxO[] | null {
  if (!amountHex) return utxos;
  const want = valueView(Value.fromCbor(amountHex));
  const need = new Map<string, bigint>([['lovelace', BigInt(want.lovelace)]]);
  for (const a of want.assets) need.set(a.unit, BigInt(a.quantity));

  const have = new Map<string, bigint>();
  const covered = () => [...need].every(([u, q]) => (have.get(u) ?? 0n) >= q);

  const picked: UTxO[] = [];
  for (const u of utxos) {
    if (covered()) break;
    picked.push(u);
    const v = valueView(u.resolved.value);
    have.set('lovelace', (have.get('lovelace') ?? 0n) + BigInt(v.lovelace));
    for (const a of v.assets) have.set(a.unit, (have.get(a.unit) ?? 0n) + BigInt(a.quantity));
  }
  return covered() ? picked : null;
}

export function paginate<T>(items: T[], p?: Paginate): T[] {
  if (!p || typeof p.page !== 'number' || typeof p.limit !== 'number') return items;
  const maxSize = Math.ceil(items.length / p.limit);
  if (items.length > 0 && p.page >= maxSize) throw new PaginateError(maxSize);
  return items.slice(p.page * p.limit, p.page * p.limit + p.limit);
}

async function submit(provider: IChainProvider, txHex: string): Promise<string> {
  try {
    return await provider.submitTx(txHex);
  } catch (e) {
    throw txSendFailure(e instanceof Error ? e.message : 'submit failed');
  }
}
