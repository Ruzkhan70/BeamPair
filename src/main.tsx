import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Prevent Firebase Auth popup race-condition internal assertion error from crashing Vite/React
window.addEventListener('error', (event) => {
  const msg = event?.message || event?.error?.message || '';
  if (
    msg.includes('Pending promise was never set') ||
    msg.includes('INTERNAL ASSERTION FAILED')
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    console.warn('[Firebase Auth] Intercepted internal popup race condition assertion error.');
    return true;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason;
  const msg = typeof reason === 'string' ? reason : (reason?.message || '');
  if (
    msg.includes('Pending promise was never set') ||
    msg.includes('INTERNAL ASSERTION FAILED')
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    console.warn('[Firebase Auth] Intercepted internal popup race condition rejection.');
  }
});

// Tier-1 Google Maps Platform auth, billing, & quota failure listener
(window as any).__gmpFallbackReason = (window as any).__gmpFallbackReason || null;
(window as any).gm_authFailure = () => {
  if (!(window as any).__gmpFallbackReason) {
    (window as any).__gmpFallbackReason = 'auth';
  }
  window.dispatchEvent(
    new CustomEvent('gmp-fallback-map', { detail: { reason: (window as any).__gmpFallbackReason } })
  );
};
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const msg = args.map((a) => String(a)).join(' ');
  if (
    msg.includes('BillingNotEnabledMapError') ||
    msg.includes('must enable Billing on the Google Cloud Project')
  ) {
    (window as any).__gmpFallbackReason = 'billing';
    window.dispatchEvent(
      new CustomEvent('gmp-fallback-map', { detail: { reason: 'billing' } })
    );
    console.warn('[BeamPair Maps] Google Cloud Billing is not enabled on the active API key; using interactive fallback map.');
    return;
  }
  if (
    msg.includes('ApiNotActivatedMapError') ||
    msg.includes('InvalidKeyMapError') ||
    msg.includes('RefererNotAllowedMapError') ||
    msg.includes('MissingKeyMapError')
  ) {
    (window as any).__gmpFallbackReason = 'auth';
    window.dispatchEvent(
      new CustomEvent('gmp-fallback-map', { detail: { reason: 'auth' } })
    );
    console.warn('[BeamPair Maps] Google Maps key unavailable for this host; using interactive fallback map.');
    return;
  }
  if (msg.includes('OverQuotaMapError') || msg.includes('QuotaExceededError')) {
    (window as any).__gmpFallbackReason = 'quota';
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    window.dispatchEvent(
      new CustomEvent('gmp-fallback-map', { detail: { reason: 'quota' } })
    );
  }
  origConsoleError.apply(console, args);
};

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
