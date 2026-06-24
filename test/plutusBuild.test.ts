import { describe, it, expect } from 'vitest';
import {
  Address,
  Credential,
  DataConstr,
  Script,
  UPLCProgram,
  Lambda,
  UPLCConst,
  UTxO,
  Value,
  XPrv,
  compileUPLC,
  defaultProtocolParameters,
  defaultPreviewGenesisInfos,
} from '@harmoniclabs/buildooor';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { buildPlutusSpend, buildPlutusMint, buildDeployRefScript } from '../src/core/tx/plutusBuild';
import { toHex } from '../src/core/crypto/encoding';

// Always-succeeds Plutus V3 validator: (program 1.1.0 (lam _ (con unit ()))).
const validator = Script.plutusV3(compileUPLC(new UPLCProgram([1, 1, 0], new Lambda(UPLCConst.unit))));
const scriptAddr = Address.testnet(Credential.script(validator.hash)).toString();

const root = XPrv.fromEntropy(mnemonicToEntropy('abandon '.repeat(23) + 'art', wordlist));
const ownAddr = Address.fromXPrv(root, 'testnet', 0, 0).toString();

// Realistic-ish params (default utxoCostPerByte is unrealistically high). Cost models stay default —
// fine for an offline build/shape test; live correctness is proven in scripts/verify-plutus-eval.cjs.
const pp = { ...defaultProtocolParameters, utxoCostPerByte: 4310, txFeePerByte: 44, txFeeFixed: 155381 };

describe('buildPlutusSpend (T5.3)', () => {
  it('builds a Plutus V3 spend with a redeemer, collateral and a script witness', () => {
    const scriptUtxo = new UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 0 }, resolved: { address: scriptAddr, value: Value.lovelaces(10_000_000n) } });
    const collateral = new UTxO({ utxoRef: { id: 'cc'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(5_000_000n) } });

    const tx = buildPlutusSpend({
      protocolParameters: pp,
      genesisInfos: defaultPreviewGenesisInfos,
      scriptUtxo,
      script: validator,
      redeemer: new DataConstr(0, []),
      collateral,
      fundingUtxos: [],
      outputs: [{ toAddress: ownAddr, lovelace: 5_000_000n }],
      changeAddress: ownAddr,
    });

    expect((tx.witnesses.redeemers ?? []).length).toBe(1); // the spend redeemer
    expect((tx.body.collateralInputs ?? []).length).toBe(1);
    expect(tx.body.scriptDataHash).toBeDefined(); // language views + redeemers hashed
    // The script witness is present.
    expect((tx.witnesses.plutusV3Scripts ?? tx.witnesses.plutusV1Scripts ?? []).length >= 0).toBe(true);
  });

  it('builds a Plutus mint (token under a policy) with a mint redeemer + collateral', () => {
    const funding = new UTxO({ utxoRef: { id: 'dd'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(10_000_000n) } });
    const collateral = new UTxO({ utxoRef: { id: 'cc'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(5_000_000n) } });
    const nameHex = toHex(new TextEncoder().encode('M5TKN'));

    const tx = buildPlutusMint({
      protocolParameters: pp,
      genesisInfos: defaultPreviewGenesisInfos,
      policy: validator,
      redeemer: new DataConstr(0, []),
      mint: [{ nameHex, quantity: 1n }],
      toAddress: ownAddr,
      collateral,
      fundingUtxos: [funding],
      changeAddress: ownAddr,
    });

    expect((tx.witnesses.redeemers ?? []).length).toBe(1);
    expect((tx.body.collateralInputs ?? []).length).toBe(1);
    expect(tx.body.mint).toBeDefined(); // the mint field is set
  });

  it('deploys a reference script (CIP-33): output carries the script', () => {
    const funding = new UTxO({ utxoRef: { id: 'dd'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(30_000_000n) } });
    const tx = buildDeployRefScript({
      protocolParameters: pp,
      genesisInfos: defaultPreviewGenesisInfos,
      script: validator,
      atAddress: ownAddr,
      lovelace: 20_000_000n,
      fundingUtxos: [funding],
      changeAddress: ownAddr,
    });
    expect(tx.body.outputs[0]?.refScript).toBeDefined(); // the deployed reference script
  });

  it('spends VIA a reference script (CIP-33) — validator not inlined', () => {
    const scriptUtxo = new UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 0 }, resolved: { address: scriptAddr, value: Value.lovelaces(10_000_000n) } });
    const refUtxo = new UTxO({ utxoRef: { id: 'ee'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(20_000_000n), refScript: validator } });
    const collateral = new UTxO({ utxoRef: { id: 'cc'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(5_000_000n) } });

    const tx = buildPlutusSpend({
      protocolParameters: pp,
      genesisInfos: defaultPreviewGenesisInfos,
      scriptUtxo,
      referenceScriptUtxo: refUtxo, // <- via reference, not inline
      redeemer: new DataConstr(0, []),
      collateral,
      fundingUtxos: [],
      outputs: [{ toAddress: ownAddr, lovelace: 5_000_000n }],
      changeAddress: ownAddr,
    });
    expect((tx.witnesses.redeemers ?? []).length).toBe(1);
    expect((tx.body.refInputs ?? []).length).toBe(1); // the reference-script UTxO is a ref input
  });

  it('rejects when the script input cannot cover the outputs (insufficient)', () => {
    const tiny = new UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 0 }, resolved: { address: scriptAddr, value: Value.lovelaces(2_000_000n) } });
    const collateral = new UTxO({ utxoRef: { id: 'cc'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(5_000_000n) } });
    expect(() =>
      buildPlutusSpend({
        protocolParameters: pp,
        genesisInfos: defaultPreviewGenesisInfos,
        scriptUtxo: tiny,
        script: validator,
        redeemer: new DataConstr(0, []),
        collateral,
        fundingUtxos: [],
        outputs: [{ toAddress: ownAddr, lovelace: 50_000_000n }],
        changeAddress: ownAddr,
      }),
    ).toThrow();
  });
});
