// Keystone verification: build a real Plutus V3 spend (always-succeeds validator) with the LIVE
// preview cost models, then run it through Ogmios evaluateTransaction (HTTP JSON-RPC) and confirm
// authoritative ex-units come back. Proves the M5 2-pass eval path against a real Conway node.
const b = require('@harmoniclabs/buildooor');
const { mnemonicToEntropy } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const http = require('http');

const OGMIOS = { host: 'localhost', port: 1337 };
const toHex = (u) => Buffer.from(u).toString('hex');

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: '1' });
    const req = http.request({ ...OGMIOS, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // 1) real protocol params + cost models from the live node
  const pp = (await rpc('queryLedgerState/protocolParameters', {})).result;
  const cm = pp.plutusCostModels;
  const costModels = {
    PlutusScriptV1: b.toCostModelV1(cm['plutus:v1']),
    PlutusScriptV2: b.toCostModelV2(cm['plutus:v2']),
    PlutusScriptV3: b.toCostModelV3(cm['plutus:v3']),
  };
  const ratioNum = (s) => { const [n, d] = String(s).split('/'); return Number(n) / Number(d); };
  const protocolParameters = {
    ...b.defaultProtocolParameters,
    txFeePerByte: pp.minFeeCoefficient,
    txFeeFixed: Number(pp.minFeeConstant.ada.lovelace),
    utxoCostPerByte: BigInt(pp.minUtxoDepositCoefficient),
    maxTxSize: pp.maxTransactionSize.bytes,
    collateralPercentage: pp.collateralPercentage,
    maxCollateralInputs: pp.maxCollateralInputs,
    maxValueSize: BigInt(pp.maxValueSize.bytes),
    executionUnitPrices: { priceMemory: ratioNum(pp.scriptExecutionPrices.memory), priceSteps: ratioNum(pp.scriptExecutionPrices.cpu) },
    maxTxExecutionUnits: { memory: pp.maxExecutionUnitsPerTransaction.memory, steps: pp.maxExecutionUnitsPerTransaction.cpu },
    costModels,
  };

  // 2) always-succeeds Plutus V3 validator + its script address
  const prog = new b.UPLCProgram([1, 1, 0], new b.Lambda(b.UPLCConst.unit));
  const script = b.Script.plutusV3(b.compileUPLC(prog));
  const scriptAddr = b.Address.testnet(b.Credential.script(script.hash)); // enterprise script address
  console.log('validator hash :', script.hash.toString());
  console.log('script address :', scriptAddr.toString().slice(0, 24) + '…');

  // 3) our address + a fabricated script UTxO and collateral UTxO (additionalUtxo for eval)
  const root = b.XPrv.fromEntropy(mnemonicToEntropy('abandon '.repeat(23) + 'art', wordlist));
  const ourAddr = b.Address.fromXPrv(root, 'testnet', 0, 0);
  const scriptUtxo = new b.UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 0 }, resolved: { address: scriptAddr, value: b.Value.lovelaces(10_000_000n) } });
  const collateralUtxo = new b.UTxO({ utxoRef: { id: 'cc'.repeat(32), index: 0 }, resolved: { address: ourAddr, value: b.Value.lovelaces(5_000_000n) } });

  // 4) build the spend tx (buildooor runs the local CEK with real cost models)
  const tb = new b.TxBuilder(protocolParameters, b.defaultPreviewGenesisInfos);
  const tx = tb.buildSync({
    inputs: [{ utxo: scriptUtxo, inputScript: { script, redeemer: new b.DataConstr(0, []) } }],
    collaterals: [collateralUtxo],
    outputs: [{ address: ourAddr, value: b.Value.lovelaces(5_000_000n) }],
    changeAddress: ourAddr,
  });
  const cbor = toHex(tx.toCborBytes());
  console.log('built tx ok, cbor len:', cbor.length, '| #redeemers:', (tx.witnesses.redeemers || []).length);

  // 5) live Ogmios evaluateTransaction with the fabricated inputs as additionalUtxo
  const additionalUtxo = [
    { transaction: { id: 'bb'.repeat(32) }, index: 0, address: scriptAddr.toString(), value: { ada: { lovelace: 10_000_000 } } },
    { transaction: { id: 'cc'.repeat(32) }, index: 0, address: ourAddr.toString(), value: { ada: { lovelace: 5_000_000 } } },
  ];
  const res = await rpc('evaluateTransaction', { transaction: { cbor }, additionalUtxo });
  console.log('--- Ogmios evaluateTransaction ---');
  console.log(JSON.stringify(res.result || res.error, null, 2));
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
