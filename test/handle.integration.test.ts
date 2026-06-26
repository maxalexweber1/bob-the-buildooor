// Integration smoke test for ADA Handle resolution (T8.1) against LIVE preprod testnet data via Koios
// (keyless). Gated behind RUN_INTEGRATION=1 so it never runs in the default `npm test` (CLAUDE.md §7:
// integration is testnet-only and opt-in). Run with:
//   RUN_INTEGRATION=1 npx vitest run test/handle.integration.test.ts
//
// It drives the real code path end-to-end: KoiosProvider.getAssetAddresses + core/handle.resolveHandle.
//
// We deliberately do NOT discover handles from Koios `policy_asset_list`: that endpoint returns an
// unstable order and the preprod policy is dominated by hundreds of thousands of `@`-subhandle test
// mints, so root handles are often absent from the first many thousand rows. Instead we probe a curated
// pool of known preprod root handles and use whichever currently resolves — resilient to any single one
// being transferred/burned, and it's resolution (not discovery) we're validating.
import { describe, it, expect, beforeAll } from 'vitest';
import { KoiosProvider } from '../src/background/provider/koios';
import { resolveHandle, HandleError, HANDLE_POLICY_ID } from '../src/core/handle';
import { utf8ToBytes, toHex } from '../src/core/crypto/encoding';

const RUN = process.env.RUN_INTEGRATION === '1';
const KOIOS = 'https://preprod.koios.rest/api/v1';

// Known preprod root handles (verified live at authoring). The test picks whichever currently has a
// single holder, so it survives any individual one moving. `EMPTY` are handles with no current holder.
const CANDIDATES = ['buzzkill', 'codefly', 'auctionsniper', 'agent47', 'nabil_01', 'tpre0002'];
const EMPTY = 'bigbank'; // currently 0 holders → our resolver must treat as "not minted"

describe.runIf(RUN)('ADA Handle resolution — live preprod (Koios)', () => {
  const provider = new KoiosProvider('preprod');
  let live = '';
  let liveAddress = '';

  beforeAll(async () => {
    for (const name of CANDIDATES) {
      try {
        const r = await resolveHandle(`$${name}`, provider);
        live = r.handle;
        liveAddress = r.address;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    // eslint-disable-next-line no-console
    console.log(`resolved live preprod handle → $${live} = ${liveAddress.slice(0, 24)}…`);
  }, 60_000);

  it('resolved at least one curated handle to a testnet address', () => {
    expect(live).not.toBe(''); // none resolved → Koios down, or the whole pool moved (refresh CANDIDATES)
    expect(liveAddress).toMatch(/^addr_test1/);
  });

  it('matches a direct Koios asset_addresses lookup for the legacy unit', async () => {
    const an = toHex(utf8ToBytes(live));
    const res = await fetch(`${KOIOS}/asset_addresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _asset_policy: HANDLE_POLICY_ID, _asset_name: an }),
    });
    const holders = (await res.json()) as Array<{ payment_address: string }>;
    expect(holders).toHaveLength(1);
    const [holder] = holders;
    expect(holder?.payment_address).toBe(liveAddress);
  }, 30_000);

  it('throws HandleError ("not minted") for a handle with no current holder', async () => {
    await expect(resolveHandle(`$${EMPTY}`, provider)).rejects.toBeInstanceOf(HandleError);
    await expect(resolveHandle(`$${EMPTY}`, provider)).rejects.toThrow(/not minted/i);
  }, 30_000);

  it('throws HandleError for a handle that was never minted', async () => {
    const nonce = ('zzz' + Date.now().toString(36)).slice(0, 15); // ≤15 chars, vanishingly unlikely to exist
    await expect(resolveHandle(`$${nonce}`, provider)).rejects.toThrow(/not minted/i);
  }, 30_000);
});
