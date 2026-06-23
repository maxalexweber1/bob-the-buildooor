// Unlock screen (T1.7). Sends the password to the background to derive the key + decrypt the vault.
// The password lives only in this component's transient state and the single RPC call — never logged.
import { useState } from 'react';
import { useWallet } from './store';
import { primaryButton } from './App';

export function Unlock() {
  const { unlock, error } = useWallet();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    const ok = await unlock(password);
    setBusy(false);
    if (ok) setPassword(''); // clear from component memory on success
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="pw" style={{ fontSize: 13, color: '#444' }}>
        Password
      </label>
      <input
        id="pw"
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={input}
      />
      {error && (
        <p style={{ color: '#c53030', fontSize: 13, margin: '8px 0' }}>{error}</p>
      )}
      <button type="submit" disabled={!password || busy} style={primaryButton}>
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  );
}

const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  margin: '6px 0 4px',
  fontSize: 14,
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
