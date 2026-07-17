// Minimal Koios-shaped mock chain provider for e2e (T7.3 follow-up). The extension's service-worker
// fetches can't be intercepted by Playwright routing, but the Koios provider takes a custom base URL
// — so specs point it at this local server. Permissive CORS headers stand in for the host permission
// a real custom host would need (localhost is a potentially-trustworthy origin, so the fetch works).
//
// It serves ONE funded UTxO at a wallet address and records whatever CBOR gets submitted, so tests
// can decode the actual bytes the wallet signed.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockChain {
  url: string;
  /** Raw CBOR (hex) bodies received on /submittx, in order. */
  submitted: string[];
  close(): Promise<void>;
}

export interface MockChainConfig {
  /** The (single) funded wallet address. */
  fundedAddress: string;
  /** Its UTxO value in lovelace. */
  lovelace: string;
  /** txHash#index of the funding UTxO. */
  txHash: string;
  /** Hash returned for a successful submit. */
  submitHashHex: string;
}

/** Realistic preview-net cli-shaped protocol params (camelCase, as Koios /cli_protocol_params). */
const CLI_PARAMS = {
  txFeePerByte: 44,
  txFeeFixed: 155381,
  maxTxSize: 16384,
  maxBlockBodySize: 90112,
  maxBlockHeaderSize: 1100,
  stakeAddressDeposit: '2000000',
  stakePoolDeposit: '500000000',
  minPoolCost: '170000000',
  utxoCostPerByte: '4310',
  maxValueSize: '5000',
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  executionUnitPrices: { priceMemory: 0.0577, priceSteps: 0.0000721 },
  maxTxExecutionUnits: { memory: 14_000_000, steps: 10_000_000_000 },
  maxBlockExecutionUnits: { memory: 62_000_000, steps: 20_000_000_000 },
  protocolVersion: { major: 9, minor: 0 },
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startMockChain(config: MockChainConfig): Promise<MockChain> {
  const submitted: string[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      // CORS: the SW fetches from a chrome-extension:// origin; allow everything, incl. preflights.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      const path = (req.url ?? '').split('?')[0] ?? '';
      const body = await readBody(req);
      const json = (data: unknown, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      switch (path) {
        case '/address_utxos': {
          const { _addresses } = JSON.parse(body.toString() || '{}') as { _addresses?: string[] };
          const funded = (_addresses ?? []).includes(config.fundedAddress);
          json(
            funded
              ? [
                  {
                    tx_hash: config.txHash,
                    tx_index: 0,
                    address: config.fundedAddress,
                    value: config.lovelace,
                    asset_list: [],
                  },
                ]
              : [],
          );
          return;
        }
        case '/address_txs': {
          const { _addresses } = JSON.parse(body.toString() || '{}') as { _addresses?: string[] };
          const used = (_addresses ?? []).includes(config.fundedAddress);
          json(used ? [{ tx_hash: config.txHash, block_height: 1, block_time: 1_700_000_000 }] : []);
          return;
        }
        case '/cli_protocol_params':
          json(CLI_PARAMS);
          return;
        case '/tip':
          json([{ hash: 'bb'.repeat(32), abs_slot: 60_000_000, block_no: 1_000_000 }]);
          return;
        case '/submittx':
          submitted.push(body.toString('hex'));
          json(config.submitHashHex); // Koios returns the hash as a JSON string
          return;
        case '/tx_status':
          json([{ num_confirmations: 3 }]);
          return;
        case '/account_info':
          json([{ status: 'not registered' }]);
          return;
        default:
          json({ error: `mock: unhandled ${req.method} ${path}` }, 404);
      }
    })().catch(() => {
      res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    submitted,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
