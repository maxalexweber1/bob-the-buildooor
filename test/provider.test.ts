import { describe, it, expect, vi, afterEach } from 'vitest';
import { TxBuilder, defaultPreviewGenesisInfos } from '@harmoniclabs/buildooor';
import { BlockfrostProvider } from '../src/background/provider/blockfrost';
import { OgmiosProvider } from '../src/background/provider/ogmios';
import { createProvider } from '../src/background/provider/index';
import { ogmiosValueToUnits, parseRatio } from '../src/background/provider/mappers';

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
