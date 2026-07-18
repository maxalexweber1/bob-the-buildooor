// Shared dev-harness submit helper for both demo pages. The wallet's dApp-facing submit error is
// DELIBERATELY generic (an untrusted page must not see provider internals) — so on failure we
// re-submit the identical CBOR straight to Blockfrost and log the node's real verdict. If
// Blockfrost ACCEPTS it, the tx is on-chain and the wallet-side provider was the problem.
import { fromHex, toArrayBuffer } from '../src/core/crypto/encoding';

export async function submitWithDiagnostics(
  bfKey: string | undefined,
  a: { submitTx(tx: string): Promise<string> },
  txHex: string,
  log: (msg: string, cls?: string) => void,
): Promise<string> {
  try {
    return await a.submitTx(txHex);
  } catch (e) {
    if (bfKey) {
      try {
        const res = await fetch('https://cardano-preview.blockfrost.io/api/v0/tx/submit', {
          method: 'POST',
          headers: { project_id: bfKey, 'Content-Type': 'application/cbor' },
          body: toArrayBuffer(fromHex(txHex)),
        });
        const body = (await res.text()).slice(0, 500);
        if (res.ok) {
          log(
            `   ⚠ direct Blockfrost submit ACCEPTED this tx (${body}) — it is ON-CHAIN; the wallet's provider rejected it, check the wallet's Provider settings`,
            'err',
          );
        } else {
          log(`   node verdict (direct Blockfrost): ${body}`, 'err');
        }
      } catch {
        // diagnostics only — never mask the original error
      }
    }
    throw e;
  }
}
