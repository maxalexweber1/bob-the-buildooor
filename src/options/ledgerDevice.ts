// Ledger device IO (EXECUTION_PLAN T6.3). PAGE CONTEXT ONLY — WebHID's device chooser needs a user
// gesture in a real page and is unavailable/unreliable in the MV3 service worker and the action
// popup (the native chooser steals focus and closes the popup). This module therefore runs in the
// options page (a full tab): it owns the transport, translates the background's neutral
// `LedgerTxPayload` into the SDK's enum-typed request, and returns raw device output. All
// TRUST decisions (witness verification, hash comparison) happen in the background
// (core/hw/ledgerTx.ts `applyHwWitnesses`) — nothing returned here is treated as authoritative.
import './nodeBuffer'; // MUST run before the SDK: installs the Buffer global it depends on
import Ada, {
  AddressType,
  TransactionSigningMode,
  TxAuxiliaryDataType,
  TxOutputDestinationType,
  TxOutputFormat,
  type SignTransactionRequest,
  type Transaction,
  type TxOutput,
} from '@cardano-foundation/ledgerjs-hw-app-cardano';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import type Transport from '@ledgerhq/hw-transport';
import type { HwWitness, LedgerTxPayload } from '../shared/internal';
import { accountPath } from '../core/hw/ledgerTx';

/**
 * Open a transport, run `fn` against the Cardano app, always close the transport. `create()` reuses
 * an already-granted device silently; the WebHID permission chooser (`request()`) appears only when
 * no granted device is available — both require this page context.
 */
export async function withLedger<T>(fn: (app: Ada) => Promise<T>): Promise<T> {
  let transport: Transport | undefined;
  try {
    transport = await TransportWebHID.create().catch(() => TransportWebHID.request());
    return await fn(new Ada(transport));
  } finally {
    // Best-effort close — a dangling HID handle blocks the next connect until the tab dies.
    await transport?.close().catch(() => undefined);
  }
}

/** Read the CIP-1852 account xpub (m/1852'/1815'/account') as `publicKey || chainCode` hex. */
export async function readAccountXpub(app: Ada, account = 0): Promise<string> {
  const { publicKeyHex, chainCodeHex } = await app.getExtendedPublicKey({ path: accountPath(account) });
  return `${publicKeyHex}${chainCodeHex}`;
}

/** Translate one neutral output into the SDK shape. buildooor serializes outputs in Babbage MAP
 *  format, so the request MUST say MAP_BABBAGE — see core/hw/ledgerTx.ts for why this is critical. */
function toLedgerOutput(o: LedgerTxPayload['outputs'][number]): TxOutput {
  return {
    format: TxOutputFormat.MAP_BABBAGE,
    amount: o.amount,
    tokenBundle: o.tokenBundle.length > 0 ? o.tokenBundle : null,
    destination:
      o.destination.kind === 'third_party'
        ? {
            type: TxOutputDestinationType.THIRD_PARTY,
            params: { addressHex: o.destination.addressHex },
          }
        : {
            type: TxOutputDestinationType.DEVICE_OWNED,
            params: {
              type: AddressType.BASE_PAYMENT_KEY_STAKE_KEY,
              params: { spendingPath: o.destination.spendingPath, stakingPath: o.destination.stakingPath },
            },
          },
  };
}

/**
 * Have the device display and sign the transaction. Returns the device-computed tx hash and the
 * witnesses; the background verifies both before anything is submitted.
 */
export async function signOnLedger(
  app: Ada,
  payload: LedgerTxPayload,
): Promise<{ deviceTxHashHex: string; witnesses: HwWitness[] }> {
  const tx: Transaction = {
    network: payload.network,
    inputs: payload.inputs,
    outputs: payload.outputs.map(toLedgerOutput),
    fee: payload.fee,
    ttl: payload.ttl ?? null,
    validityIntervalStart: payload.validityIntervalStart ?? null,
    auxiliaryData: payload.auxDataHashHex
      ? { type: TxAuxiliaryDataType.ARBITRARY_HASH, params: { hashHex: payload.auxDataHashHex } }
      : null,
    includeNetworkId: payload.includeNetworkId ?? null,
  };
  const request: SignTransactionRequest = {
    tx,
    signingMode: TransactionSigningMode.ORDINARY_TRANSACTION,
    additionalWitnessPaths: [],
    // buildooor does not tag CBOR sets (no 258) — the device must serialize the same way or the
    // resulting witnesses fail verification against our body hash.
    options: { tagCborSets: false },
  };
  const signed = await app.signTransaction(request);
  return {
    deviceTxHashHex: signed.txHashHex,
    witnesses: signed.witnesses.map((w) => ({ path: [...w.path], witnessSignatureHex: w.witnessSignatureHex })),
  };
}
