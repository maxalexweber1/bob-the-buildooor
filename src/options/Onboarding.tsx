// Onboarding (T1.7): create (generate → back up → confirm → password) or restore (paste → password).
// Privileged options-page context. The mnemonic is generated/held here transiently and only crosses
// to the background (with the password) on the final create call. We never log it, never auto-copy it
// to the clipboard (clipboard-hijack risk — IMPLEMENTATION_PLAN §10.6), and render it as text nodes.
import { useMemo, useState } from 'react';
import { generateMnemonic, isValidMnemonic } from '../core/mnemonic';
import { wallet } from '../shared/walletClient';

const MIN_PASSWORD = 8;

type Step =
  | { kind: 'choose' }
  | { kind: 'show'; mnemonic: string }
  | { kind: 'confirm'; mnemonic: string }
  | { kind: 'password'; mnemonic: string }
  | { kind: 'restore' }
  | { kind: 'done' };

export function Onboarding() {
  const [step, setStep] = useState<Step>({ kind: 'choose' });

  return (
    <div>
      <h1 style={{ fontSize: 22 }}>bob-the-buildooor</h1>
      {step.kind === 'choose' && (
        <Choose
          onCreate={() => setStep({ kind: 'show', mnemonic: generateMnemonic() })}
          onRestore={() => setStep({ kind: 'restore' })}
        />
      )}
      {step.kind === 'show' && (
        <ShowSeed
          mnemonic={step.mnemonic}
          onBack={() => setStep({ kind: 'choose' })}
          onNext={() => setStep({ kind: 'confirm', mnemonic: step.mnemonic })}
        />
      )}
      {step.kind === 'confirm' && (
        <ConfirmSeed
          mnemonic={step.mnemonic}
          onBack={() => setStep({ kind: 'show', mnemonic: step.mnemonic })}
          onNext={() => setStep({ kind: 'password', mnemonic: step.mnemonic })}
        />
      )}
      {step.kind === 'password' && (
        <Card title="Set a password">
          <p style={hint}>Encrypts your wallet on this device. You’ll enter it to unlock.</p>
          <PasswordForm
            submitLabel="Create wallet"
            onSubmit={async (pw) => {
              await wallet.create(step.mnemonic, pw);
              setStep({ kind: 'done' }); // drops the mnemonic reference
            }}
          />
        </Card>
      )}
      {step.kind === 'restore' && (
        <Restore onBack={() => setStep({ kind: 'choose' })} onDone={() => setStep({ kind: 'done' })} />
      )}
      {step.kind === 'done' && (
        <Card title="Wallet ready ✓">
          <p style={hint}>
            Your wallet is encrypted and ready. Open the bob-the-buildooor popup from the toolbar to
            unlock and use it.
          </p>
        </Card>
      )}
    </div>
  );
}

function Choose({ onCreate, onRestore }: { onCreate: () => void; onRestore: () => void }) {
  return (
    <Card title="Welcome">
      <p style={hint}>Create a new wallet or restore one from a 24-word recovery phrase.</p>
      <button type="button" style={primary} onClick={onCreate}>
        Create a new wallet
      </button>
      <button type="button" style={secondary} onClick={onRestore}>
        Restore from recovery phrase
      </button>
    </Card>
  );
}

function ShowSeed({
  mnemonic,
  onBack,
  onNext,
}: {
  mnemonic: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const words = mnemonic.split(' ');
  const [acked, setAcked] = useState(false);
  return (
    <Card title="Your recovery phrase">
      <p style={{ ...hint, color: '#c05621' }}>
        Write these 24 words down in order and keep them offline. Anyone with this phrase can steal
        your funds. We can’t recover it for you.
      </p>
      <ol style={seedGrid}>
        {words.map((w, i) => (
          <li key={i} style={seedWord}>
            <span style={{ color: '#a0aec0' }}>{i + 1}.</span> {w}
          </li>
        ))}
      </ol>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0', fontSize: 13 }}>
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
        I have written down my recovery phrase.
      </label>
      <button type="button" style={primary} disabled={!acked} onClick={onNext}>
        Continue
      </button>
      <button type="button" style={secondary} onClick={onBack}>
        Back
      </button>
    </Card>
  );
}

function ConfirmSeed({
  mnemonic,
  onBack,
  onNext,
}: {
  mnemonic: string;
  onBack: () => void;
  onNext: () => void;
}) {
  const words = mnemonic.split(' ');
  // Two random positions to verify the user actually recorded the phrase. Chosen once per mount.
  const [a, b] = useMemo(() => pickTwo(words.length), [words.length]);
  const [wa, setWa] = useState('');
  const [wb, setWb] = useState('');
  const ok = wa.trim().toLowerCase() === words[a] && wb.trim().toLowerCase() === words[b];

  return (
    <Card title="Confirm your phrase">
      <p style={hint}>Enter the requested words to confirm your backup.</p>
      <Field label={`Word #${a + 1}`} value={wa} onChange={setWa} />
      <Field label={`Word #${b + 1}`} value={wb} onChange={setWb} />
      <button type="button" style={primary} disabled={!ok} onClick={onNext}>
        Continue
      </button>
      <button type="button" style={secondary} onClick={onBack}>
        Back
      </button>
    </Card>
  );
}

function Restore({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [raw, setRaw] = useState('');
  const normalized = raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
  const valid = normalized.length > 0 && isValidMnemonic(normalized);
  const showInvalid = normalized.split(' ').length >= 12 && !valid;

  return (
    <Card title="Restore wallet">
      <p style={hint}>Paste your 12- or 24-word recovery phrase.</p>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        style={{ ...inputBase, fontFamily: 'monospace', resize: 'vertical' }}
      />
      {showInvalid && (
        <p style={{ color: '#c53030', fontSize: 13 }}>That recovery phrase isn’t valid.</p>
      )}
      {valid && (
        <PasswordForm
          submitLabel="Restore wallet"
          onSubmit={async (pw) => {
            await wallet.create(normalized, pw);
            onDone();
          }}
        />
      )}
      <button type="button" style={secondary} onClick={onBack}>
        Back
      </button>
    </Card>
  );
}

function PasswordForm({
  submitLabel,
  onSubmit,
}: {
  submitLabel: string;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tooShort = pw.length > 0 && pw.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== pw;
  const valid = pw.length >= MIN_PASSWORD && pw === confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pw);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Field label={`Password (min ${MIN_PASSWORD} characters)`} type="password" value={pw} onChange={setPw} />
      {tooShort && <p style={warn}>Use at least {MIN_PASSWORD} characters.</p>}
      <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} />
      {mismatch && <p style={warn}>Passwords don’t match.</p>}
      {err && <p style={warn}>{err}</p>}
      <button type="submit" style={primary} disabled={!valid || busy}>
        {busy ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label style={{ display: 'block', margin: '8px 0' }}>
      <span style={{ fontSize: 13, color: '#444' }}>{label}</span>
      <input
        type={type}
        value={value}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        style={inputBase}
      />
    </label>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

function pickTwo(n: number): [number, number] {
  // CSPRNG even though this only picks which backup words to confirm (not key material) — a wallet
  // codebase should never contain Math.random, so nothing weak can creep into a security path later.
  const rand = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % n;
  const a = rand();
  let b = rand();
  while (b === a) b = rand();
  return [a, b];
}

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: 20,
};
const hint: React.CSSProperties = { fontSize: 13, color: '#4a5568', lineHeight: 1.5 };
const warn: React.CSSProperties = { color: '#c53030', fontSize: 13, margin: '4px 0' };
const inputBase: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  marginTop: 4,
  fontSize: 14,
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
const primary: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  marginTop: 12,
  fontSize: 14,
  fontWeight: 600,
  color: '#fff',
  background: '#2b6cb0',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const secondary: React.CSSProperties = {
  ...primary,
  color: '#2b6cb0',
  background: 'transparent',
  border: '1px solid #cbd5e0',
};
const seedGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 8,
  listStyle: 'none',
  padding: 12,
  margin: '12px 0',
  background: '#f7fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
};
const seedWord: React.CSSProperties = { fontSize: 13, fontFamily: 'monospace' };
