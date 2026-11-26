import React, { useEffect, useState, useRef } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, BOOTSTRAP_ADMIN_EMAIL } from './firebase/config';
import { Navbar } from './components/Navbar';
import { AdminDashboard } from './components/AdminDashboard';
import { SecondaryDeviceView } from './components/SecondaryDeviceView';
import { OfflineIndicator } from './components/PWAControls';
import { ShieldCheck, Smartphone, LogIn, AlertCircle, Loader2, Lock, LogOut, ShieldAlert, ExternalLink } from 'lucide-react';

export default function App() {
  const [isClientOnly, setIsClientOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get('pair');
    const roleParam = urlParams.get('role');
    if (pairParam || roleParam === 'phone' || roleParam === 'secondary') {
      try {
        localStorage.setItem('beampair_client_locked', 'true');
      } catch {}
      return true;
    }
    try {
      return (
        localStorage.getItem('beampair_client_locked') === 'true' ||
        !!localStorage.getItem('beampair_device_registration')
      );
    } catch {
      return false;
    }
  });
  const [currentView, setCurrentView] = useState<'admin' | 'secondary'>(() => {
    if (typeof window === 'undefined') return 'admin';
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get('pair');
    const roleParam = urlParams.get('role');
    const isMobilePhone = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (
      pairParam ||
      roleParam === 'phone' ||
      roleParam === 'secondary' ||
      isMobilePhone ||
      localStorage.getItem('beampair_client_locked') === 'true' ||
      !!localStorage.getItem('beampair_device_registration')
    ) {
      return 'secondary';
    }
    return 'admin';
  });
  const [adminUser, setAdminUser] = useState<{ uid: string; email: string } | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [initialPairToken, setInitialPairToken] = useState<string>('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState<boolean>(false);
  const signingInRef = useRef<boolean>(false);

  useEffect(() => {
    const onQuota = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuota);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuota);
  }, []);

  // Check URL query parameters for pairing token or detect mobile device
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get('pair');
    const roleParam = urlParams.get('role');
    const isMobilePhone = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (pairParam) {
      setInitialPairToken(pairParam);
      setIsClientOnly(true);
      try {
        localStorage.setItem('beampair_client_locked', 'true');
      } catch {}
      setCurrentView('secondary');
    } else if (roleParam === 'phone' || roleParam === 'secondary') {
      setIsClientOnly(true);
      try {
        localStorage.setItem('beampair_client_locked', 'true');
      } catch {}
      setCurrentView('secondary');
    } else if (isMobilePhone) {
      setCurrentView('secondary');
    }
  }, []);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAdminUser({
          uid: user.uid,
          email: user.email || '',
        });
      } else {
        setAdminUser(null);
      }
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Handle Google Sign-In with popup & race condition protection
  const handleGoogleSignIn = async () => {
    if (signingInRef.current) return;
    signingInRef.current = true;
    setIsSigningIn(true);
    setSignInError(null);

    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({
      prompt: 'select_account',
    });

    try {
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        setAdminUser({
          uid: result.user.uid,
          email: result.user.email || '',
        });
      }
    } catch (err: unknown) {
      console.warn('Google Sign-In note:', err);
      const code = (err as any)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'auth/popup-closed-by-user' || msg.includes('popup-closed-by-user')) {
        setSignInError('Google sign-in popup was closed before completing. Click again to sign in.');
      } else if (code === 'auth/popup-blocked' || msg.includes('popup-blocked')) {
        setSignInError('Sign-in popup was blocked by your browser. Please allow popups or open in a new tab.');
      } else if (code === 'auth/cancelled-popup-request') {
        // Ignored duplicate action
      } else if (msg.includes('Pending promise was never set')) {
        setSignInError('Sign-in window closed or interrupted. Click to try again.');
      } else {
        setSignInError(msg);
      }
    } finally {
      signingInRef.current = false;
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.warn('Sign-out error:', err);
    }
    setAdminUser(null);
  };

  const isAuthorizedAdmin = !!(adminUser && adminUser.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar
        currentView={isClientOnly ? 'secondary' : currentView}
        onViewChange={(v) => {
          if (!isClientOnly) setCurrentView(v);
        }}
        adminEmail={isClientOnly ? null : (adminUser?.email || null)}
        onSignIn={handleGoogleSignIn}
        onSignOut={handleSignOut}
        isClientOnly={isClientOnly}
      />

      {mapsQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col">
        {isClientOnly ? (
          <div className="flex-1 py-6 flex items-start justify-center">
            <SecondaryDeviceView
              initialToken={initialPairToken}
              onClearInitialToken={() => setInitialPairToken('')}
            />
          </div>
        ) : !authReady ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin mb-3" />
            <p className="text-xs text-slate-400 font-mono">Initializing BeamPair secure environment...</p>
          </div>
        ) : currentView === 'admin' ? (
          !adminUser ? (
            /* Admin Sign-In Screen */
            <div className="flex-1 flex items-center justify-center p-6 animate-fade-in">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl space-y-5">
                <div className="w-16 h-16 bg-gradient-to-tr from-indigo-600/20 to-indigo-500/10 border border-indigo-500/30 text-indigo-400 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-indigo-500/10">
                  <ShieldCheck className="w-8 h-8" />
                </div>

                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Admin Authentication Required</h3>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    Sign in with your designated Google account to manage registered devices, generate pairing codes, and conduct live WebRTC remote support sessions.
                  </p>
                </div>

                {signInError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl space-y-2 text-left">
                    <div className="flex items-start space-x-2 text-rose-300 text-xs">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{signInError}</span>
                    </div>
                    {window.self !== window.top && (
                      <a
                        href={window.location.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center space-x-1 text-[11px] text-indigo-400 hover:text-indigo-300 underline font-medium pt-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>Open app in new tab to sign in directly</span>
                      </a>
                    )}
                  </div>
                )}

                <div className="space-y-2.5 pt-2">
                  <button
                    onClick={handleGoogleSignIn}
                    disabled={isSigningIn}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/25 transition cursor-pointer"
                  >
                    {isSigningIn ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-white" />
                        <span>Connecting with Google...</span>
                      </>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4" />
                        <span>Sign In with Google</span>
                      </>
                    )}
                  </button>

                  <button
                    onClick={() => setCurrentView('secondary')}
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl flex items-center justify-center space-x-2 transition border border-slate-700/80 cursor-pointer"
                  >
                    <Smartphone className="w-4 h-4 text-slate-400" />
                    <span>Switch to Secondary Phone View</span>
                  </button>
                </div>
              </div>
            </div>
          ) : !isAuthorizedAdmin ? (
            /* Strict Access Denied Screen for any other user */
            <div className="flex-1 flex items-center justify-center p-6 animate-fade-in">
              <div className="bg-slate-900 border border-rose-500/30 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl space-y-5">
                <div className="w-16 h-16 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-rose-500/10">
                  <Lock className="w-8 h-8" />
                </div>

                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Access Denied: Restricted Admin Portal</h3>
                  <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                    This administrator portal is strictly restricted. Only the designated administrator account is authorized to access device sessions and remote controls.
                  </p>
                </div>

                <div className="p-3.5 bg-slate-950 border border-rose-500/20 rounded-xl text-left text-xs space-y-2">
                  <div>
                    <span className="text-slate-400 block text-[11px]">Currently Signed In As:</span>
                    <span className="text-rose-400 font-mono font-medium truncate block">{adminUser.email || 'Unknown User'}</span>
                  </div>
                  <div className="border-t border-slate-800/80 pt-2">
                    <span className="text-slate-400 block text-[11px]">Access Status:</span>
                    <span className="text-rose-400 font-medium">Designated Administrator Only</span>
                  </div>
                </div>

                <div className="space-y-2.5 pt-2">
                  <button
                    onClick={handleSignOut}
                    className="w-full py-3 bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-rose-600/20 transition cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out & Switch Account</span>
                  </button>

                  <button
                    onClick={() => setCurrentView('secondary')}
                    className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl flex items-center justify-center space-x-2 transition border border-slate-700/80 cursor-pointer"
                  >
                    <Smartphone className="w-4 h-4 text-slate-400" />
                    <span>Switch to Secondary Phone View</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Authorized Admin Dashboard */
            <AdminDashboard
              adminId={adminUser.uid}
              adminEmail={adminUser.email}
              onSimulateDevicePair={(token) => {
                setInitialPairToken(token);
                setCurrentView('secondary');
              }}
            />
          )
        ) : (
          <div className="flex-1 py-6 flex items-start justify-center">
            <SecondaryDeviceView
              initialToken={initialPairToken}
              onClearInitialToken={() => setInitialPairToken('')}
            />
          </div>
        )}
      </main>

      {/* Footer Info */}
      <footer className="border-t border-slate-900 bg-slate-950/60 py-3 px-6 text-center text-[11px] text-slate-500 flex flex-col sm:flex-row items-center justify-between gap-2">
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>Real WebRTC PeerConnection & HTTPS Ready</span>
        </div>
        <div className="text-slate-400">
          BeamPair Remote Device Support • Enterprise P2P Session Security
        </div>
      </footer>
      <OfflineIndicator />
    </div>
  );
}
