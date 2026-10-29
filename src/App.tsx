import React, { useEffect, useState } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, BOOTSTRAP_ADMIN_EMAIL } from './firebase/config';
import { Navbar } from './components/Navbar';
import { AdminDashboard } from './components/AdminDashboard';
import { SecondaryDeviceView } from './components/SecondaryDeviceView';
import { ShieldCheck, Smartphone, LogIn, AlertCircle, Loader2 } from 'lucide-react';

export default function App() {
  const [currentView, setCurrentView] = useState<'admin' | 'secondary'>('admin');
  const [adminUser, setAdminUser] = useState<{ uid: string; email: string } | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [initialPairToken, setInitialPairToken] = useState<string>('');
  const [signInError, setSignInError] = useState<string | null>(null);

  // Check URL query parameters for pairing token or detect mobile device
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const pairParam = urlParams.get('pair');
    const isMobilePhone = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (pairParam) {
      setInitialPairToken(pairParam);
      setCurrentView('secondary');
    } else if (isMobilePhone) {
      // Any physical phone defaults to Secondary Phone pairing view
      setCurrentView('secondary');
    }
  }, []);

  // Listen to Firebase Auth state (only attach listeners when auth is confirmed)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAdminUser({
          uid: user.uid,
          email: user.email || BOOTSTRAP_ADMIN_EMAIL,
        });
      } else {
        setAdminUser(null);
      }
      setAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Handle Google Sign-In with popup
  const handleGoogleSignIn = async () => {
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
          email: result.user.email || BOOTSTRAP_ADMIN_EMAIL,
        });
      }
    } catch (err: unknown) {
      console.warn('Google Sign-In note:', err);
      const msg = err instanceof Error ? err.message : 'Sign-in was cancelled or blocked by browser.';
      setSignInError(msg);
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Navbar
        currentView={currentView}
        onViewChange={(v) => setCurrentView(v)}
        adminEmail={adminUser?.email || null}
        onSignIn={handleGoogleSignIn}
        onSignOut={handleSignOut}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col">
        {!authReady ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin mb-3" />
            <p className="text-xs text-slate-400 font-mono">Initializing BeamPair secure environment...</p>
          </div>
        ) : currentView === 'admin' ? (
          adminUser ? (
            <AdminDashboard
              adminId={adminUser.uid}
              adminEmail={adminUser.email}
              onSimulateDevicePair={(token) => {
                setInitialPairToken(token);
                setCurrentView('secondary');
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 animate-fade-in">
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 max-w-md w-full text-center shadow-2xl space-y-5">
                <div className="w-16 h-16 bg-gradient-to-tr from-indigo-600/20 to-indigo-500/10 border border-indigo-500/30 text-indigo-400 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-indigo-500/10">
                  <ShieldCheck className="w-8 h-8" />
                </div>

                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Admin Authentication Required</h3>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    Sign in with your administrator account to manage registered devices, generate single-use QR pairing tokens, and conduct live WebRTC remote support sessions.
                  </p>
                </div>

                <div className="p-3 bg-slate-950 border border-slate-800/80 rounded-xl text-left text-xs space-y-1">
                  <span className="text-slate-400 block text-[11px]">Authorized Administrator:</span>
                  <span className="text-emerald-400 font-mono font-medium">{BOOTSTRAP_ADMIN_EMAIL}</span>
                </div>

                {signInError && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start space-x-2 text-rose-300 text-xs text-left">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{signInError}</span>
                  </div>
                )}

                <div className="space-y-2.5 pt-2">
                  <button
                    onClick={handleGoogleSignIn}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/25 transition cursor-pointer"
                  >
                    <LogIn className="w-4 h-4" />
                    <span>Sign In with Google</span>
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
          BeamPair Remote Device Support • Authorized Admin: <span className="text-indigo-400 font-mono">{BOOTSTRAP_ADMIN_EMAIL}</span>
        </div>
      </footer>
    </div>
  );
}
