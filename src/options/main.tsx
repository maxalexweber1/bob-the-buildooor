import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';

const root = document.getElementById('root');
if (!root) throw new Error('options root element missing');

createRoot(root).render(
  <StrictMode>
    <Options />
  </StrictMode>,
);
