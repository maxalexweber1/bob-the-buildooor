// Trezor device orchestration (EXECUTION_PLAN T6.4). Unlike Ledger (WebHID in the options page),
// @trezor/connect-webextension is built by Trezor FOR the MV3 service worker: it opens the
// Trezor-hosted popup (connect.trezor.io), which does all device IO (WebUSB/Bridge) on Trezor's
// origin — our extension never touches the device. Communication runs through the content script
// declared in manifest.config.ts for connect.trezor.io/9/* (the README's "manual injection" option —
// chosen over the broad `scripting` permission on purpose: a static, origin-scoped declaration is
// the smaller grant).
//
// Trust model is identical to Ledger: whatever the popup returns is verified in
// core/hw/ledgerTx.ts `applyHwWitnesses` against OUR body hash and OUR xpub-derived keys before
// anything is submitted. The Trezor popup + device screen provide the physical consent gate
// (CLAUDE.md §1.4); the options page shows the decoded summary first (§1.5).
import TrezorConnect from '@trezor/connect-webextension';
import type { PROTO } from '@trezor/connect';
import type { HwWitness, LedgerTxPayload } from '../../core/hw/ledgerTx';

// Runtime enum VALUES, typed against the SDK's enums via the type-only import above. Needed because
// the package's prebuilt UMD bundle (its `main`) exports only the default TrezorConnect object — a
// value import of PROTO would be `undefined` at runtime. A drifted value fails the typecheck.
const ORDINARY_TRANSACTION: PROTO.CardanoTxSigningMode = 0;
const ADDRESS_TYPE_BASE: PROTO.CardanoAddressType = 0;
const OUTPUT_FORMAT_MAP_BABBAGE: PROTO.CardanoTxOutputSerializationFormat = 1;

/**
 * Trezor Connect developer manifest (required by TrezorConnect.init — informational contact Trezor
 * uses to announce breaking changes; shown to nobody else).
 */
const TREZOR_MANIFEST = {
  appName: 'bob-the-buildooor',
  email: 'max@maxalexweber.de',
  appUrl: 'https://github.com/maxalexweber1/bob-the-buildooor',
};

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await TrezorConnect.init({ manifest: TREZOR_MANIFEST });
  initialized = true;
}

/** Read the CIP-1852 account xpub (m/1852'/1815'/account') as `publicKey || chainCode` hex. */
export async function trezorReadAccountXpub(account = 0): Promise<string> {
  await ensureInit();
  const res = await TrezorConnect.cardanoGetPublicKey({
    path: `m/1852'/1815'/${account}'`,
    showOnTrezor: false,
  });
  if (!res.success) throw new Error(`Trezor: ${res.payload.error}`);
  const pk = Array.isArray(res.payload) ? res.payload[0] : res.payload;
  if (!pk) throw new Error('Trezor: empty public-key response');
  return `${pk.node.public_key}${pk.node.chain_code}`;
}

/** Translate the device-neutral payload (core/hw/ledgerTx.ts) into Trezor's request shape. The same
 *  byte-layout constraints as Ledger apply: Babbage MAP outputs, no 258 set tags — see that module. */
function toTrezorParams(payload: LedgerTxPayload) {
  return {
    signingMode: ORDINARY_TRANSACTION,
    inputs: payload.inputs.map((i) => ({ path: i.path, prev_hash: i.txHashHex, prev_index: i.outputIndex })),
    outputs: payload.outputs.map((o) => ({
      format: OUTPUT_FORMAT_MAP_BABBAGE,
      amount: o.amount,
      ...(o.tokenBundle.length > 0
        ? {
            tokenBundle: o.tokenBundle.map((g) => ({
              policyId: g.policyIdHex,
              tokenAmounts: g.tokens.map((t) => ({ assetNameBytes: t.assetNameHex, amount: t.amount })),
            })),
          }
        : {}),
      ...(o.destination.kind === 'third_party'
        ? { address: o.destination.addressBech32 }
        : {
            addressParameters: {
              addressType: ADDRESS_TYPE_BASE,
              path: o.destination.spendingPath,
              stakingPath: o.destination.stakingPath,
            },
          }),
    })),
    fee: payload.fee,
    ...(payload.ttl !== undefined ? { ttl: payload.ttl } : {}),
    ...(payload.validityIntervalStart !== undefined
      ? { validityIntervalStart: payload.validityIntervalStart }
      : {}),
    ...(payload.auxDataHashHex !== undefined ? { auxiliaryData: { hash: payload.auxDataHashHex } } : {}),
    protocolMagic: payload.network.protocolMagic,
    networkId: payload.network.networkId,
    ...(payload.includeNetworkId !== undefined ? { includeNetworkId: payload.includeNetworkId } : {}),
    // buildooor does not 258-tag sets; the device must serialize identically or the witnesses fail
    // verification against our body hash (safe abort, but pointless — so pin it here).
    tagCborSets: false,
  };
}

/**
 * Sign on the Trezor (popup + device confirmation). Returns the device-computed tx hash and the
 * witnesses in the neutral shape — Trezor identifies keys by PUBKEY, not path; `applyHwWitnesses`
 * matches and verifies them against our xpub-derived keys.
 */
export async function trezorSignTx(
  payload: LedgerTxPayload,
): Promise<{ deviceTxHashHex: string; witnesses: HwWitness[] }> {
  await ensureInit();
  const res = await TrezorConnect.cardanoSignTransaction(toTrezorParams(payload));
  if (!res.success) throw new Error(`Trezor: ${res.payload.error}`);
  return {
    deviceTxHashHex: res.payload.hash,
    witnesses: res.payload.witnesses.map((w) => ({ pubKeyHex: w.pubKey, witnessSignatureHex: w.signature })),
  };
}
