// Unlocked-wallet view router (dashboard ↔ send). Kept tiny — popup has only two screens for now.
import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { Send } from './Send';

export function Home() {
  const [view, setView] = useState<'dashboard' | 'send'>('dashboard');
  return view === 'send' ? (
    <Send onBack={() => setView('dashboard')} />
  ) : (
    <Dashboard onSend={() => setView('send')} />
  );
}
