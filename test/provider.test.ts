import { describe, it, expect, vi, afterEach } from 'vitest';
import { TxBuilder, defaultPreviewGenesisInfos } from '@harmoniclabs/buildooor';
import { BlockfrostProvider } from '../src/background/provider/blockfrost';
import { KoiosProvider } from '../src/background/provider/koios';
import { OgmiosProvider } from '../src/background/provider/ogmios';
import { KupoClient, OgmiosKupoProvider, kupoValueToUnits } from '../src/background/provider/ogmios-kupo';
import { createProvider } from '../src/background/provider/index';
import { ogmiosValueToUnits, parseRatio } from '../src/background/provider/mappers';
import { fetchJson, sanitizeUrlForError } from '../src/background/provider/network';
import { ProviderHttpError } from '../src/background/provider/IChainProvider';
import { accountKeys, rewardAddress } from '../src/core/address';
import { mnemonicToRoot } from '../src/core/keys';
import { toHex } from '../src/core/crypto/encoding';

const ADDR =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const TXID = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';
const ASSET = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e4654';

// Minimal Response stub matching what fetchJson uses (ok/status/json/text).
function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const BF_PARAMS = {
  min_fee_a: 44,
  min_fee_b: 155381,
  max_tx_size: 16384,
  max_block_size: 90112,
  max_block_header_size: 1100,
  key_deposit: '2000000',
  pool_deposit: '500000000',
  min_pool_cost: '170000000',
  coins_per_utxo_size: '4310',
  max_val_size: '5000',
  collateral_percent: 150,
  max_collateral_inputs: 3,
  price_mem: 0.0577,
  price_step: 0.0000721,
  max_tx_ex_mem: '14000000',
  max_tx_ex_steps: '10000000000',
  max_block_ex_mem: '62000000',
  max_block_ex_steps: '20000000000',
  protocol_major_ver: 10,
  protocol_minor_ver: 0,
};

afterEach(() => vi.unstubAllGlobals());

describe('mappers', () => {
  it('parseRatio handles "n/d" strings and numbers', () => {
    expect(parseRatio('3/1000')).toBeCloseTo(0.003);
    expect(parseRatio(0.5)).toBe(0.5);
    expect(parseRatio('1/0')).toBe(0);
    expect(parseRatio(undefined)).toBe(0);
  });

  it('ogmiosValueToUnits flattens ada + native assets', () => {
    const units = ogmiosValueToUnits({
      ada: { lovelace: 4250000 },
      '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': { '534e4654': 7 },
    });
    expect(units).toContainEqual({ unit: 'lovelace', quantity: '4250000' });
    expect(units).toContainEqual({ unit: ASSET, quantity: '7' });
  });
});

describe('provider error sanitization', () => {
  it('sanitizeUrlForError strips credentials, query and hash but keeps host+port+path', () => {
    expect(sanitizeUrlForError('https://user:secret@example.com/api?token=abc#frag')).toBe('https://example.com/api');
    expect(sanitizeUrlForError('http://localhost:1442/matches?q=1')).toBe('http://localhost:1442/matches');
    expect(sanitizeUrlForError('not a url')).toBe('<invalid url>');
  });

  it('fetchJson HTTP errors never leak URL credentials or query tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res('upstream refused', 500)));
    const err = (await fetchJson('https://user:secret@example.com/api?token=abc').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.message).not.toContain('secret');
    expect(err.message).not.toContain('token=abc');
    expect(err.message).toContain('https://example.com/api');
    expect(err.message).toContain('500');
  });
});

describe('BlockfrostProvider (mocked fetch)', () => {
  it('maps address UTxOs to buildooor UTxO (with native assets)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res([
          { tx_hash: TXID, output_index: 0, amount: [{ unit: 'lovelace', quantity: '4250000' }, { unit: ASSET, quantity: '7' }] },
        ]),
      ),
    );
    const p = new BlockfrostProvider('preview', 'preview_key');
    const utxos = await p.getUtxos(ADDR);
    expect(utxos).toHaveLength(1);
    expect(utxos[0]?.resolved.value.lovelaces).toBe(4250000n);
    expect(utxos[0]?.utxoRef.toString()).toBe(`${TXID}#0`);
  });

  it('treats 404 (unused address) as empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.getUtxos(ADDR)).toEqual([]);
  });

  it('paginates until a short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      tx_hash: TXID,
      output_index: i,
      amount: [{ unit: 'lovelace', quantity: '1000000' }],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(page1))
      .mockResolvedValueOnce(res([{ tx_hash: TXID, output_index: 100, amount: [{ unit: 'lovelace', quantity: '1' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.getUtxos(ADDR)).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps protocol parameters into a usable TxBuilder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(BF_PARAMS)));
    const p = new BlockfrostProvider('preview', 'preview_key');
    const pp = await p.getProtocolParameters();
    expect(pp.txFeePerByte).toBe(44);
    expect(pp.txFeeFixed).toBe(155381);
    // The real goal: the result drives buildooor's TxBuilder directly.
    const tb = new TxBuilder(pp, defaultPreviewGenesisInfos);
    expect(Number(tb.protocolParamters.txFeePerByte)).toBe(44);
  });

  it('submitTx POSTs raw CBOR bytes and returns the hash', async () => {
    const fetchMock = vi.fn(async () => res(TXID));
    vi.stubGlobal('fetch', fetchMock);
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.submitTx('a1b2c3d4')).toBe(TXID);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tx/submit');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/cbor');
  });

  it('has no evaluateTx (capability gap detectable by absence)', () => {
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect((p as { evaluateTx?: unknown }).evaluateTx).toBeUndefined();
  });

  it('isUsed: 200 → used, 404 → unused', async () => {
    const p = new BlockfrostProvider('preview', 'preview_key');
    vi.stubGlobal('fetch', vi.fn(async () => res({ tx_count: 3 })));
    expect(await p.isUsed(ADDR)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    expect(await p.isUsed(ADDR)).toBe(false);
  });

  it('isConfirmed: tx on-chain (200) → true, 404 → false', async () => {
    const p = new BlockfrostProvider('preview', 'preview_key');
    vi.stubGlobal('fetch', vi.fn(async () => res({ hash: TXID })));
    expect(await p.isConfirmed(TXID)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    expect(await p.isConfirmed(TXID)).toBe(false);
  });

  it('getAssetMetadata: CIP-25 on-chain name/image/standard', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      onchain_metadata: { name: 'Bob #1', image: 'ipfs://Qm123', description: 'a test NFT' },
      onchain_metadata_standard: 'CIP25v2',
      metadata: null,
    })));
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.getAssetMetadata(ASSET)).toEqual({
      name: 'Bob #1',
      description: 'a test NFT',
      image: 'ipfs://Qm123',
      standard: 'CIP25v2',
    });
  });

  it('getAssetMetadata: joins a CIP-25 v1 chunked image array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      onchain_metadata: { name: 'Chunked', image: ['ipfs://Qm', 'abc', 'def'] },
    })));
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect((await p.getAssetMetadata(ASSET))?.image).toBe('ipfs://Qmabcdef');
  });

  it('getAssetMetadata: falls back to the off-chain registry (name/decimals/logo)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({
      onchain_metadata: null,
      metadata: { name: 'TestCoin', decimals: 6, logo: 'https://x/logo.png' },
    })));
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.getAssetMetadata(ASSET)).toEqual({ name: 'TestCoin', decimals: 6, image: 'https://x/logo.png' });
  });

  it('getAssetMetadata: 404 → null, and an asset with no useful fields → null', async () => {
    const p = new BlockfrostProvider('preview', 'preview_key');
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    expect(await p.getAssetMetadata(ASSET)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => res({ onchain_metadata: null, metadata: null })));
    expect(await p.getAssetMetadata(ASSET)).toBeNull();
  });

  it('Koios getAssetMetadata: CIP-25 from raw 721 minting metadata', async () => {
    const policy = ASSET.slice(0, 56);
    vi.stubGlobal('fetch', vi.fn(async () => res([{
      minting_tx_metadata: { '721': { [policy]: { SNFT: { name: 'Bob #1', image: 'ipfs://Qm', description: 'd' } } } },
      token_registry_metadata: null,
    }])));
    const p = new KoiosProvider('preview');
    expect(await p.getAssetMetadata(ASSET)).toEqual({ name: 'Bob #1', description: 'd', image: 'ipfs://Qm', standard: 'CIP25' });
  });

  it('Koios getAssetMetadata: off-chain registry fallback (name/decimals/logo)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res([{
      minting_tx_metadata: null,
      token_registry_metadata: { name: 'TestCoin', decimals: 6, logo: 'https://x/logo.png' },
    }])));
    const p = new KoiosProvider('preview');
    expect(await p.getAssetMetadata(ASSET)).toEqual({ name: 'TestCoin', decimals: 6, image: 'https://x/logo.png' });
  });

  it('Koios getAssetMetadata: no row or no useful fields → null', async () => {
    const p = new KoiosProvider('preview');
    vi.stubGlobal('fetch', vi.fn(async () => res([])));
    expect(await p.getAssetMetadata(ASSET)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => res([{ minting_tx_metadata: null, token_registry_metadata: null }])));
    expect(await p.getAssetMetadata(ASSET)).toBeNull();
  });

  it('getAddressTransactions maps refs (newest-first as the API returns them)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res([{ tx_hash: TXID, block_height: 100, block_time: 1700000000 }])));
    const p = new BlockfrostProvider('preview', 'preview_key');
    expect(await p.getAddressTransactions(ADDR)).toEqual([{ txHash: TXID, blockTime: 1700000000, blockHeight: 100 }]);
  });

  it('getTxDetail maps IO and excludes collateral/reference inputs', async () => {
    const utxos = {
      inputs: [
        { address: 'addr_a', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
        { address: 'addr_collat', amount: [{ unit: 'lovelace', quantity: '5000000' }], collateral: true },
        { address: 'addr_ref', amount: [{ unit: 'lovelace', quantity: '2000000' }], reference: true },
      ],
      outputs: [
        { address: 'addr_b', amount: [{ unit: 'lovelace', quantity: '3000000' }, { unit: ASSET, quantity: '1' }] },
        { address: 'addr_a', amount: [{ unit: 'lovelace', quantity: '6800000' }] },
      ],
    };
    const fetchMock = vi.fn(async (url: string) => (url.includes('/utxos') ? res(utxos) : res({ fees: '200000' })));
    vi.stubGlobal('fetch', fetchMock);
    const p = new BlockfrostProvider('preview', 'preview_key');
    const d = await p.getTxDetail(TXID);
    expect(d.inputs).toHaveLength(1); // collateral + reference excluded
    expect(d.inputs[0]?.address).toBe('addr_a');
    expect(d.outputs).toHaveLength(2);
    expect(d.fee).toBe('200000');
  });
});

describe('getStakeRegistration — Blockfrost & Koios (CIP-95 T6.1)', () => {
  it('Blockfrost: active → true, deregistered → false, never-seen (404) → false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ active: true })));
    expect(await new BlockfrostProvider('preview', 'k').getStakeRegistration('stake_test1x')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res({ active: false })));
    expect(await new BlockfrostProvider('preview', 'k').getStakeRegistration('stake_test1x')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    expect(await new BlockfrostProvider('preview', 'k').getStakeRegistration('stake_test1x')).toBe(false);
  });

  it('Koios: status registered → true; not registered / empty → false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res([{ status: 'registered' }])));
    expect(await new KoiosProvider('preview').getStakeRegistration('stake_test1x')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res([{ status: 'not registered' }])));
    expect(await new KoiosProvider('preview').getStakeRegistration('stake_test1x')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => res([])));
    expect(await new KoiosProvider('preview').getStakeRegistration('stake_test1x')).toBe(false);
  });
});

// ---- Ogmios over a fake WebSocket ----

type Responder = (method: string, params: unknown) => unknown;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  readonly sent: string[] = [];
  constructor(
    readonly url: string,
    private readonly responder: Responder,
  ) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as { id: string; method: string; params: unknown };
    const result = this.responder(msg.method, msg.params);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) }));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const OGMIOS_PARAMS = {
  minFeeCoefficient: 44,
  minFeeConstant: { ada: { lovelace: 155381 } },
  maxTransactionSize: { bytes: 16384 },
  minUtxoDepositCoefficient: 4310,
  scriptExecutionPrices: { memory: '577/10000', cpu: '721/10000000' },
  maxExecutionUnitsPerTransaction: { memory: 14000000, cpu: 10000000000 },
  maxExecutionUnitsPerBlock: { memory: 62000000, cpu: 20000000000 },
  version: { major: 10, minor: 0 },
};

function ogmiosProvider(responder: Responder): OgmiosProvider {
  return new OgmiosProvider('preview', 'ws://localhost:1337', {
    wsFactory: (u) => new FakeWebSocket(u, responder) as unknown as WebSocket,
  });
}

describe('OgmiosProvider (fake WebSocket JSON-RPC)', () => {
  it('queries UTxOs by address and converts the value', async () => {
    const p = ogmiosProvider((method) => {
      if (method === 'queryLedgerState/utxo')
        return [
          {
            transaction: { id: TXID },
            index: 0,
            address: ADDR,
            value: { ada: { lovelace: 4250000 }, '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': { '534e4654': 7 } },
          },
        ];
      return null;
    });
    const utxos = await p.getUtxos(ADDR);
    expect(utxos).toHaveLength(1);
    expect(utxos[0]?.resolved.value.lovelaces).toBe(4250000n);
  });

  it('getUtxosForAddresses batches every address into ONE query (the discovery fix)', async () => {
    let calls = 0;
    let sentAddresses: unknown;
    const p = ogmiosProvider((method, params) => {
      if (method === 'queryLedgerState/utxo') {
        calls++;
        sentAddresses = (params as { addresses: string[] }).addresses;
        return [
          { transaction: { id: TXID }, index: 0, address: ADDR, value: { ada: { lovelace: 1_000_000 } } },
          { transaction: { id: TXID }, index: 1, address: ADDR, value: { ada: { lovelace: 2_000_000 } } },
        ];
      }
      return null;
    });
    const utxos = await p.getUtxosForAddresses([ADDR, ADDR]);
    expect(calls).toBe(1); // one ledger-set scan for the whole batch — the whole point of T-batched
    expect(sentAddresses).toEqual([ADDR, ADDR]);
    expect(utxos).toHaveLength(2);
  });

  it('getUtxosForAddresses with no addresses makes no query', async () => {
    let calls = 0;
    const p = ogmiosProvider((method) => {
      if (method === 'queryLedgerState/utxo') calls++;
      return [];
    });
    expect(await p.getUtxosForAddresses([])).toEqual([]);
    expect(calls).toBe(0);
  });

  it('maps protocol parameters (ratio prices) into a usable TxBuilder', async () => {
    const p = ogmiosProvider((m) => (m === 'queryLedgerState/protocolParameters' ? OGMIOS_PARAMS : null));
    const pp = await p.getProtocolParameters();
    expect(pp.txFeePerByte).toBe(44);
    expect(pp.executionUnitPrices).toMatchObject({ priceMemory: expect.closeTo(0.0577, 4) });
    const tb = new TxBuilder(pp, defaultPreviewGenesisInfos);
    expect(Number(tb.protocolParamters.txFeePerByte)).toBe(44);
  });

  it('submitTx returns the transaction id', async () => {
    const p = ogmiosProvider((m) => (m === 'submitTransaction' ? { transaction: { id: TXID } } : null));
    expect(await p.submitTx('deadbeef')).toBe(TXID);
  });

  it('evaluateTx returns redeemer ex-units (Ogmios capability)', async () => {
    const p = ogmiosProvider((m) =>
      m === 'evaluateTransaction' ? [{ validator: { purpose: 'spend', index: 0 }, budget: { memory: 1700, cpu: 476468 } }] : null,
    );
    const evald = await p.evaluateTx('deadbeef');
    expect(evald[0]?.budget).toEqual({ memory: 1700, cpu: 476468 });
  });

  it('getTip resolves slot/height (and origin → 0)', async () => {
    const p = ogmiosProvider((m) =>
      m === 'queryLedgerState/tip' ? { slot: 42, id: 'abc' } : m === 'queryNetwork/blockHeight' ? 100 : null,
    );
    expect(await p.getTip()).toEqual({ slot: 42, hash: 'abc', height: 100 });

    const p2 = ogmiosProvider((m) =>
      m === 'queryLedgerState/tip' ? 'origin' : m === 'queryNetwork/blockHeight' ? 'origin' : null,
    );
    expect(await p2.getTip()).toEqual({ slot: 0, hash: '', height: 0 });
  });

  it('getStakeRegistration queries rewardAccountSummaries with the stake KEY HASH and maps entry-presence', async () => {
    // CIP-95 T6.1: the Ogmios query takes stake credentials (key hashes), not bech32 reward addresses;
    // a registered account comes back as an entry, an unregistered one is simply absent.
    const keys = accountKeys(mnemonicToRoot('abandon '.repeat(23) + 'art'), 0);
    const stakeAddr = rewardAddress(keys, 'testnet').toString();
    const expectedHash = toHex(keys.stakeKeyHash);
    let seenKeys: unknown;
    const p = ogmiosProvider((method, params) => {
      if (method === 'queryLedgerState/rewardAccountSummaries') {
        seenKeys = (params as { keys: string[] }).keys;
        return { [expectedHash]: { rewards: { ada: { lovelace: 0 } } } };
      }
      return null;
    });
    expect(await p.getStakeRegistration(stakeAddr)).toBe(true);
    expect(seenKeys).toEqual([expectedHash]);

    const unregistered = ogmiosProvider(() => ({}));
    expect(await unregistered.getStakeRegistration(stakeAddr)).toBe(false);
  });

  it('rejects (not hangs) when the WebSocket never opens — connect timeout (review #5)', async () => {
    vi.useFakeTimers();
    try {
      // A socket that accepts construction but never fires onopen/onerror/onclose.
      const neverOpen = (u: string): WebSocket =>
        ({ url: u, onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0, send() {}, close() {} }) as unknown as WebSocket;
      const p = new OgmiosProvider('preview', 'ws://localhost:1337', { timeoutMs: 5000, wsFactory: neverOpen });
      const pending = p.getProtocolParameters();
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

const KUPO_MATCH = {
  transaction_id: TXID,
  output_index: 0,
  address: ADDR,
  value: { coins: 4250000, assets: { '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f.534e4654': 7 } },
  datum_hash: null,
  script_hash: null,
};

describe('Kupo + Ogmios composite (mocked fetch)', () => {
  it('kupoValueToUnits maps coins + dot-separated assets to the concatenated unit form', () => {
    expect(kupoValueToUnits({ coins: 1_000_000, assets: { 'aa.bb': 3, 'cc.': 1 } })).toEqual([
      { unit: 'lovelace', quantity: '1000000' },
      { unit: 'aabb', quantity: '3' },
      { unit: 'cc', quantity: '1' }, // nameless asset: the trailing dot is dropped, not kept
    ]);
  });

  it('KupoClient.unspentAt queries /matches/{addr}?unspent and maps the UTxO', async () => {
    const fetchMock = vi.fn(async () => res([KUPO_MATCH]));
    vi.stubGlobal('fetch', fetchMock);
    const utxos = await new KupoClient('http://localhost:1442/').unspentAt(ADDR); // trailing slash tolerated
    expect(utxos).toHaveLength(1);
    expect(utxos[0]?.resolved.value.lovelaces).toBe(4250000n);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/matches/');
    expect(url).toContain('?unspent');
    expect(url).not.toContain('//matches'); // base trailing slash was normalized
  });

  it('hasMatch is true when Kupo returns rows, false on 404 (unused address)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res([KUPO_MATCH])));
    expect(await new KupoClient('http://localhost:1442').hasMatch(ADDR)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res('Not Found', 404)));
    expect(await new KupoClient('http://localhost:1442').hasMatch(ADDR)).toBe(false);
  });

  it('composite routes getUtxos + isUsed to Kupo HTTP (the Ogmios socket is never opened)', async () => {
    const fetchMock = vi.fn(async () => res([KUPO_MATCH]));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OgmiosKupoProvider('preview', 'ws://localhost:1337', 'http://localhost:1442', {
      wsFactory: (u) => new FakeWebSocket(u, () => null) as unknown as WebSocket,
    });
    expect((await p.getUtxos(ADDR))[0]?.resolved.value.lovelaces).toBe(4250000n);
    expect(await p.isUsed(ADDR)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // both served by Kupo; Ogmios ws untouched
  });

  it('rejects a non-http(s) Kupo URL', () => {
    expect(() => new KupoClient('ws://localhost:1442')).toThrow(/http/);
  });
});

describe('CompositeProvider (capability split / dual mode)', () => {
  // A bare primary: implements only core + evaluateTx/getTip, NO history/metadata (like Ogmios+Kupo).
  function localPrimary(overrides: Partial<IChainProvider> = {}): IChainProvider {
    return {
      name: 'local',
      network: 'preview',
      getGenesisInfos: () => Promise.reject(new Error('genesis')),
      getProtocolParameters: () => Promise.reject(new Error('params')),
      getUtxos: () => Promise.resolve([]),
      isUsed: () => Promise.resolve(false),
      resolveUtxos: () => Promise.resolve([]),
      submitTx: () => Promise.resolve('LOCAL_TXID'),
      evaluateTx: () => Promise.resolve([{ validator: { purpose: 'spend', index: 0 }, budget: { memory: 1, cpu: 2 } }]),
      ...overrides,
    };
  }
  // A remote indexer: implements the history/metadata extras (like Blockfrost).
  function remoteSecondary(): IChainProvider {
    return {
      name: 'remote',
      network: 'preview',
      getGenesisInfos: () => Promise.reject(new Error('should not be used')),
      getProtocolParameters: () => Promise.reject(new Error('should not be used')),
      getUtxos: () => Promise.reject(new Error('core must come from primary')),
      isUsed: () => Promise.reject(new Error('core must come from primary')),
      resolveUtxos: () => Promise.reject(new Error('core must come from primary')),
      submitTx: () => Promise.reject(new Error('core must come from primary')),
      getAssetMetadata: () => Promise.resolve({ name: 'RemoteToken' }),
      getAssetAddresses: () => Promise.resolve([{ address: ADDR, quantity: '1' }]),
      isConfirmed: () => Promise.resolve(true),
    };
  }

  it('routes core reads/writes to the primary, history/metadata to the secondary', async () => {
    const { CompositeProvider } = await import('../src/background/provider/composite');
    const p = new CompositeProvider(localPrimary(), remoteSecondary());
    expect(await p.submitTx('cbor')).toBe('LOCAL_TXID'); // submit → primary (local node)
    expect(await p.getAssetMetadata?.('a'.repeat(56))).toEqual({ name: 'RemoteToken' }); // → secondary
    expect((await p.getAssetAddresses?.('a'.repeat(56)))?.[0]?.address).toBe(ADDR); // → secondary
    expect(await p.isConfirmed?.('tx')).toBe(true); // → secondary
    expect(p.name).toBe('local+remote');
  });

  it('prefers the primary when it implements an optional capability', async () => {
    const { CompositeProvider } = await import('../src/background/provider/composite');
    // primary implements evaluateTx; secondary does NOT — composite must use the primary's.
    const p = new CompositeProvider(localPrimary(), remoteSecondary());
    const ev = await p.evaluateTx?.('cbor');
    expect(ev?.[0]?.budget).toEqual({ memory: 1, cpu: 2 });
  });

  it('only exposes a capability when some backend implements it', async () => {
    const { CompositeProvider } = await import('../src/background/provider/composite');
    const localOnly = new CompositeProvider(localPrimary()); // no secondary
    expect(localOnly.getAssetMetadata).toBeUndefined(); // neither side has it → stays unsupported
    expect(localOnly.getAssetAddresses).toBeUndefined();
    expect(typeof localOnly.evaluateTx).toBe('function'); // primary has it
  });

  it('reads option routes UTxO reads away from the primary (Ogmios-without-Kupo + Blockfrost)', async () => {
    const { CompositeProvider } = await import('../src/background/provider/composite');
    // primary = "ogmios": its address scan must NEVER be used for reads (that's the slow path).
    const ogmios = localPrimary({
      getUtxos: () => Promise.reject(new Error('ogmios scan must not serve reads')),
      isUsed: () => Promise.reject(new Error('ogmios scan must not serve reads')),
    });
    const remote: IChainProvider = {
      ...remoteSecondary(),
      getUtxos: () => Promise.resolve([]),
      isUsed: () => Promise.resolve(true),
    };
    const p = new CompositeProvider(ogmios, remote, { reads: remote });
    expect(await p.isUsed('addr')).toBe(true); // → reads (remote), not the throwing primary
    expect(await p.getUtxos('addr')).toEqual([]); // → reads (remote)
    expect(await p.submitTx('cbor')).toBe('LOCAL_TXID'); // submit still → primary (local node)
    expect(await p.evaluateTx?.('cbor')).toBeDefined(); // eval still → primary (Ogmios)
  });
});

describe('KoiosProvider (mocked fetch)', () => {
  const KOIOS_CLI = {
    txFeePerByte: 44,
    txFeeFixed: 155381,
    maxTxSize: 16384,
    maxBlockBodySize: 90112,
    maxBlockHeaderSize: 1100,
    stakeAddressDeposit: 2000000,
    stakePoolDeposit: 500000000,
    minPoolCost: 170000000,
    utxoCostPerByte: 4310,
    maxValueSize: 5000,
    collateralPercentage: 150,
    maxCollateralInputs: 3,
    executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
    maxTxExecutionUnits: { memory: 14000000, steps: 10000000000 },
    maxBlockExecutionUnits: { memory: 62000000, steps: 20000000000 },
    protocolVersion: { major: 10, minor: 0 },
  };

  it('maps /address_utxos (value + asset_list) to buildooor UTxO', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res([{ tx_hash: TXID, tx_index: 0, value: '4250000', asset_list: [{ policy_id: ASSET.slice(0, 56), asset_name: ASSET.slice(56), quantity: '7' }] }]),
      ),
    );
    const p = createProvider({ kind: 'koios', network: 'preview' });
    const utxos = await p.getUtxos(ADDR);
    expect(utxos[0]?.resolved.value.lovelaces).toBe(4250000n);
  });

  it('isUsed reflects /address_txs history', async () => {
    const p = createProvider({ kind: 'koios', network: 'preview' });
    vi.stubGlobal('fetch', vi.fn(async () => res([{ tx_hash: TXID }])));
    expect(await p.isUsed(ADDR)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => res([])));
    expect(await p.isUsed(ADDR)).toBe(false);
  });

  it('maps /cli_protocol_params into a usable TxBuilder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(KOIOS_CLI)));
    const p = createProvider({ kind: 'koios', network: 'preview' });
    const pp = await p.getProtocolParameters();
    expect(pp.txFeePerByte).toBe(44);
    const tb = new TxBuilder(pp, defaultPreviewGenesisInfos);
    expect(Number(tb.protocolParamters.txFeePerByte)).toBe(44);
  });

  it('submitTx trims quotes from the returned hash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(`"${TXID}"`)));
    const p = createProvider({ kind: 'koios', network: 'preview' });
    expect(await p.submitTx('deadbeef')).toBe(TXID);
  });

  it('getTip reads /tip abs_slot + block_no', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res([{ hash: 'abc', abs_slot: 42, block_no: 100 }])));
    const p = createProvider({ kind: 'koios', network: 'preview' });
    expect(await p.getTip?.()).toEqual({ slot: 42, hash: 'abc', height: 100 });
  });
});

describe('createProvider factory', () => {
  it('builds a Blockfrost provider from explicit config', () => {
    const p = createProvider({ kind: 'blockfrost', network: 'preview', blockfrostProjectId: 'k' });
    expect(p.name).toBe('blockfrost');
    expect(p.network).toBe('preview');
  });

  it('builds an Ogmios provider from a ws url', () => {
    const p = createProvider({ kind: 'ogmios', network: 'preview', ogmiosUrl: 'ws://localhost:1337' });
    expect(p.name).toBe('ogmios');
  });

  it('throws when required config is missing', () => {
    expect(() => createProvider({ kind: 'ogmios', network: 'preview' })).toThrow(/ogmiosUrl/);
  });

  it('routes Koios to a custom base URL (self-hosted / env-provided)', async () => {
    const fetchMock = vi.fn(async () => res([{ hash: 'abc', abs_slot: 1, block_no: 2 }]));
    vi.stubGlobal('fetch', fetchMock);
    const p = createProvider({ kind: 'koios', network: 'preview', koiosUrl: 'https://my-koios.example/api/v1' });
    await p.getTip?.();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://my-koios.example/api/v1')).toBe(true);
  });

  it('falls back to the public Koios base when the custom URL is empty (unset .env line)', async () => {
    const fetchMock = vi.fn(async () => res([{ hash: 'abc', abs_slot: 1, block_no: 2 }]));
    vi.stubGlobal('fetch', fetchMock);
    const p = createProvider({ kind: 'koios', network: 'preview', koiosUrl: '' });
    await p.getTip?.();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://preview.koios.rest/api/v1')).toBe(true);
  });
});
