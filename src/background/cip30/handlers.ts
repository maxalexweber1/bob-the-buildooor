// CIP-30 method dispatch (EXECUTION_PLAN T4.2/T4.4). Runs in the background for dApp requests that
// arrive via the content relay with a content-stamped trusted `origin` (CLAUDE.md §1.6).
//   - enable()/isEnabled gate on the origin allowlist; enable() prompts for consent (T4.1).
//   - every other method requires an enabled origin AND an unlocked wallet.
//   - all returns are hex (address bytes / cbor) per the CIP-30 spec.
//   - signTx (witness-set only) and signData (CIP-8 COSE) are per-call approval-gated (T4.3/T4.5).
import { Address, StakeAddress, Tx, Value, type UTxO, type XPrv } from '@harmoniclabs/buildooor';
import { allowlist } from '../dapp/allowlist';
import { requestApproval } from '../dapp/approvals';
import {
  apiError,
  refused,
  internalError,
  invalidRequest,
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
  addressFromCip30Input,
  baseAddressFrom,
  bech32Network,
  rewardAddress,
  drepPublicKey,
  stakePublicKey,
  keyHash28,
  type AccountKeys,
} from '../../core/address';
import { summarizeTx } from '../../core/tx/summary';
import { verifyTxOnNode } from '../../core/tx/plutusBuild';
import { valueView } from '../../core/balance';
import { buildCoseSign1 } from '../../core/cose/sign';
import { signTxWitnessSet } from '../signer';
import type { IChainProvider } from '../provider/index';
import { ProviderHttpError, ProviderTimeoutError } from '../provider/IChainProvider';
import { discoverChain, nextReceiveIndex } from '../discovery';
import { toHex, fromHex } from '../../core/crypto/encoding';
import { resolveHandle, HandleError } from '../../core/handle';

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

  // experimental.resolveHandle: read-only ADA Handle → address lookup (T8.1). No wallet keys involved,
  // so it needs no unlock — but it IS origin-gated (above) so a random page can't use the wallet as a
  // free resolution/fingerprinting proxy. The dApp builds its own tx; the user still approves the real
  // output address at signTx time (decode-before-sign), so resolution here grants no signing authority.
  if (method === 'resolveHandle') return resolveHandleForDapp(params[0]);

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
      return (await stakeKeyRegistered(provider, keys, s)) ? [toHex(stakePublicKey(keys))] : [];
    case 'cip95.getUnregisteredPubStakeKeys':
      return (await stakeKeyRegistered(provider, keys, s)) ? [] : [toHex(stakePublicKey(keys))];
    case 'cip95.signData':
      return signDataCip95(root, s, provider, keys, origin, params[0] as string, params[1] as string);

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
  // Resolve collateral inputs alongside spending inputs: they are value at risk that MUST show in the
  // approval, and a wallet-owned collateral input needs this wallet's witness.
  const resolved = await provider.resolveUtxos(
    [...tx.body.inputs, ...(tx.body.collateralInputs ?? [])].map((i) => i.utxoRef),
  );
  const owners = await ownerMap(root, s, provider, keys);
  const summary = summarizeTx(tx, resolved, new Set(owners.keys()));

  // Anti-blind-sign for Plutus (CLAUDE.md §1.5): when the tx carries scripts AND we have a node
  // (Ogmios `evaluateTx`), re-run the scripts on the USER's own node and show the authoritative
  // ex-units in the approval. Never blocks signing — 'unavailable' if no node / inputs unresolvable.
  const nodeEval = await verifyTxOnNode(provider, txCbor, tx.witnesses.redeemers?.length ?? 0);
  if (nodeEval) summary.nodeEval = nodeEval;

  if (!(await requestApproval('signTx', origin, summary))) {
    throw new Cip30Error(TxSignErrorCode.UserDeclined, 'user declined signing');
  }

  // `resolved` covers spending AND collateral inputs, so a wallet-owned collateral input contributes
  // its payment key here even when no spending input is ours.
  const signerRefs = new Map<string, OwnerRef>();
  for (const u of resolved) {
    const o = owners.get(u.resolved.address.toString());
    if (o) signerRefs.set(`${o.role}/${o.index}`, o);
  }

  // requiredSigners are bare key hashes (Plutus `extra_signatories` / multi-party flows): a tx may
  // need this wallet's signature without spending any wallet-owned input. Match every hash against
  // the key hashes this wallet controls — payment (per known address), stake, DRep.
  const requiredSigners = tx.body.requiredSigners ?? [];
  if (requiredSigners.length > 0) {
    const byHash = new Map<string, OwnerRef>();
    for (const [addr, o] of owners) {
      byHash.set(Address.fromString(addr).paymentCreds.hash.toString().toLowerCase(), o);
    }
    byHash.set(toHex(keys.stakeKeyHash), { role: Role.Staking, index: 0 });
    byHash.set(toHex(keyHash28(drepPublicKey(keys))), { role: Role.DRep, index: 0 });
    for (const rs of requiredSigners) {
      const o = byHash.get(rs.toString().toLowerCase());
      if (o) signerRefs.set(`${o.role}/${o.index}`, o);
    }
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
  addressInput: string,
  payloadHex: string,
): Promise<{ signature: string; key: string }> {
  // Trust-no-input: the address is accepted as bech32 OR hex (project rule); the payload
  // is decoded with the STRICT fromHex so malformed hex is rejected, never silently coerced and
  // signed as different bytes. Error mapping: malformed request input → APIError.InvalidRequest (-1);
  // a well-formed address the wallet doesn't own a payment key for → DataSignError.AddressNotPK (2).
  let address: Address;
  let payload: Uint8Array;
  try {
    if (typeof addressInput !== 'string' || typeof payloadHex !== 'string') throw new Error('not a string');
    address = addressFromCip30Input(addressInput);
    payload = fromHex(payloadHex);
  } catch {
    throw invalidRequest('signData: malformed address or payload');
  }
  const owner = (await ownerMap(root, s, provider, keys)).get(address.toString());
  if (!owner) throw new Cip30Error(DataSignErrorCode.AddressNotPK, 'address is not a key address owned by this wallet');

  return approveThenCoseSign(
    origin,
    { address: address.toString(), payloadHex, signerKind: 'payment' },
    address.toBuffer(),
    deriveKey(root, 0, owner.role, owner.index),
    payload,
  );
}

/**
 * CIP-95: is the wallet's (single-account) stake key registered on-chain? Unknown state — provider
 * without the capability, or a provider hiccup — counts as UNREGISTERED, which is what the spec
 * prescribes ("if the wallet does not know the registration status of its stake keys then it should
 * return them as part of getUnregisteredPubStakeKeys"). Never fails the dApp call.
 */
async function stakeKeyRegistered(
  provider: IChainProvider,
  keys: AccountKeys,
  s: WalletSettings,
): Promise<boolean> {
  if (!provider.getStakeRegistration) return false;
  try {
    return await provider.getStakeRegistration(rewardAddress(keys, bech32Network(s.network)).toString());
  } catch {
    return false;
  }
}

/** Payload shown by the trusted signData approval prompt (Connect.tsx `SignDataBody`). */
interface SignDataApprovalPayload {
  address: string;
  payloadHex: string;
  /** Which wallet key signs — the UI shows explicit governance wording for 'stake'/'drep' (CIP-95). */
  signerKind: 'payment' | 'stake' | 'drep';
}

/** Per-call consent, then CIP-8 COSE_Sign1 with the given key. Shared by CIP-30 and CIP-95 signData. */
async function approveThenCoseSign(
  origin: string,
  approval: SignDataApprovalPayload,
  addressHeaderBytes: Uint8Array,
  signingKey: XPrv,
  payload: Uint8Array,
): Promise<{ signature: string; key: string }> {
  if (!(await requestApproval('signData', origin, approval))) {
    throw new Cip30Error(DataSignErrorCode.UserDeclined, 'user declined');
  }
  return buildCoseSign1(payload, addressHeaderBytes, signingKey.toPrivateKeyBytes(), signingKey.public().toPubKeyBytes());
}

/**
 * CIP-95 signData (T6.1): extends CIP-30 signData with governance credentials. Accepted first-arg
 * forms per the spec:
 *  - DRepID — 28-byte hex (blake2b-224 of the CIP-105 DRep public key `…/3/0`) → signs with the DRep key,
 *    COSE address header = the raw 28 DRep-ID bytes;
 *  - reward (stake) address — bech32 `stake…` or 29-byte hex (header 0xe0/0xe1) → signs with the stake key;
 *  - payment address (CIP-19 types 0/2/4/6, bech32 or hex) → the plain CIP-30 signData path.
 * The wallet does NOT require the DRep to be registered on-chain (the spec doesn't — this signing also
 * serves the DRep-registration flow itself). Error mapping: malformed input → APIError.InvalidRequest;
 * a governance credential we don't hold → DataSignError.ProofGeneration (spec: "wallet does not have
 * the secret key"); script-credential reward address → DataSignError.AddressNotPK.
 */
async function signDataCip95(
  root: XPrv,
  s: WalletSettings,
  provider: IChainProvider,
  keys: AccountKeys,
  origin: string,
  input: string,
  payloadHex: string,
): Promise<{ signature: string; key: string }> {
  let payload: Uint8Array;
  try {
    if (typeof input !== 'string' || typeof payloadHex !== 'string') throw new Error('not a string');
    payload = fromHex(payloadHex);
  } catch {
    throw invalidRequest('cip95.signData: malformed payload');
  }
  const hexBody = (input.startsWith('0x') ? input.slice(2) : input).toLowerCase();

  // DRep ID: exactly 28 bytes of hex (a bare key-hash — no address header byte).
  if (/^[0-9a-f]{56}$/.test(hexBody)) {
    if (hexBody !== toHex(keyHash28(drepPublicKey(keys)))) {
      throw new Cip30Error(DataSignErrorCode.ProofGeneration, "DRep ID does not match this wallet's DRep key");
    }
    return approveThenCoseSign(
      origin,
      { address: hexBody, payloadHex, signerKind: 'drep' },
      fromHex(hexBody),
      deriveKey(root, 0, Role.DRep, 0),
      payload,
    );
  }

  // Reward (stake) address: bech32 `stake…`, or 29-byte hex. Script-credential reward addresses
  // (header 0xf0/0xf1) have no signing key at all → AddressNotPK.
  if (input.startsWith('stake') || /^[ef][01][0-9a-f]{56}$/.test(hexBody)) {
    if (/^f[01]/.test(hexBody)) {
      throw new Cip30Error(DataSignErrorCode.AddressNotPK, 'script-credential reward address has no signing key');
    }
    let stakeAddr: StakeAddress;
    try {
      stakeAddr = input.startsWith('stake') ? StakeAddress.fromString(input) : StakeAddress.fromBytes(fromHex(hexBody));
    } catch {
      throw invalidRequest('cip95.signData: malformed stake address');
    }
    const own = rewardAddress(keys, bech32Network(s.network));
    if (stakeAddr.toString() !== own.toString()) {
      throw new Cip30Error(DataSignErrorCode.ProofGeneration, 'stake address is not owned by this wallet');
    }
    return approveThenCoseSign(
      origin,
      { address: own.toString(), payloadHex, signerKind: 'stake' },
      own.toBuffer(),
      deriveKey(root, 0, Role.Staking, 0),
      payload,
    );
  }

  // Anything else is a payment address — identical semantics to plain CIP-30 signData.
  return signData(root, s, provider, keys, origin, input, payloadHex);
}

/**
 * Resolve an ADA $handle to the current holder's address, returned as CIP-30 hex bytes (consistent
 * with getChangeAddress/getUsedAddresses). The handle string is untrusted page input → `resolveHandle`
 * validates it before any lookup. Errors are mapped to CIP-30 `{code,info}`: a bad/unminted/ambiguous
 * handle is an InvalidRequest (-1); a provider without an asset index is an InternalError (-2).
 */
async function resolveHandleForDapp(handleParam: unknown): Promise<string> {
  if (typeof handleParam !== 'string') throw invalidRequest('resolveHandle: handle must be a string');
  const provider = await getProvider();
  const getAssetAddresses = provider.getAssetAddresses?.bind(provider);
  if (!getAssetAddresses) throw internalError(`${provider.name} cannot resolve handles (no asset index)`);
  try {
    const { address } = await resolveHandle(handleParam, { getAssetAddresses });
    return toHex(Address.fromString(address).toBuffer());
  } catch (e) {
    if (e instanceof HandleError) throw invalidRequest(e.message);
    if (e instanceof Cip30Error) throw e;
    throw internalError(e instanceof Error ? e.message : 'resolveHandle failed');
  }
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
    // dApp-facing error info is GENERIC on purpose: raw provider messages
    // can reflect the configured endpoint URL or upstream response bodies to an untrusted page.
    // Full (sanitized) diagnostics stay in the trusted wallet UI / console paths.
    if (e instanceof ProviderTimeoutError) throw txSendFailure('provider timed out');
    if (e instanceof ProviderHttpError) throw txSendFailure('provider rejected transaction');
    throw txSendFailure('submit failed');
  }
}
