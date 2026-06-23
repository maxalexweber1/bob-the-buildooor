// Runs in the ISOLATED world. Injects the MAIN-world provider and relays messages between the page
// and the background service worker over a long-lived PORT (EXECUTION_PLAN T0.5 / M4). The port keeps
// the SW alive during user approval (IMPLEMENTATION_PLAN §4 rule 3) and reconnects if the SW recycles.
import injectedScript from '../inpage/provider?script&module';
import {
  TARGET_CONTENT,
  TARGET_INPAGE,
  DAPP_PORT,
  type RpcRequest,
  type RpcResponse,
} from '../shared/messages';

// 1) Inject the provider into the page's MAIN world via a web-accessible script tag.
const el = document.createElement('script');
el.src = chrome.runtime.getURL(injectedScript);
el.type = 'module';
el.onload = () => el.remove();
(document.head || document.documentElement).prepend(el);

// 2) Long-lived port to the background, with reconnect on SW recycle.
let port: chrome.runtime.Port | null = null;
function connect(): chrome.runtime.Port | null {
  try {
    const p = chrome.runtime.connect({ name: DAPP_PORT });
    p.onMessage.addListener((resp: Omit<RpcResponse, 'target'>) => {
      // Stamp the inpage target on the way back to the page.
      window.postMessage({ ...resp, target: TARGET_INPAGE }, window.location.origin);
    });
    p.onDisconnect.addListener(() => {
      port = null; // SW recycled or extension reloaded; reconnect lazily on next request
    });
    port = p;
    return p;
  } catch {
    // Extension context invalidated (e.g. reloaded) — stop relaying.
    return null;
  }
}

// 3) Relay page → background, stamping the trusted origin from the real MessageEvent.
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const req = e.data as RpcRequest | undefined;
  if (!req || req.target !== TARGET_CONTENT) return;
  const active = port ?? connect();
  active?.postMessage({ ...req, origin: e.origin });
});
