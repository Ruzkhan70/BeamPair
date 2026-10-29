import React from 'react';
import {
  ShieldCheck,
  Smartphone,
  LayoutDashboard,
  LogOut,
  LogIn,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';

interface NavbarProps {
  currentView: 'admin' | 'secondary';
  onViewChange: (view: 'admin' | 'secondary') => void;
  adminEmail: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onViewChange,
  adminEmail,
  onSignIn,
  onSignOut,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 bg-gradient-to-tr from-indigo-600 to-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/30">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <span className="text-sm font-bold text-white tracking-tight flex items-center space-x-1.5">
              <span>BeamPair</span>
              <span className="px-1.5 py-0.2 bg-indigo-500/20 text-indigo-400 text-[10px] rounded-md font-mono font-medium">
                REMOTE SUPPORT
              </span>
            </span>
            <p className="text-[10px] text-slate-400 hidden sm:block">QR-Paired Android Remote Device Support</p>
          </div>
        </div>

        {/* View Switcher (Desktop and Mobile) */}
        <div className="flex items-center space-x-1 p-1 bg-slate-900 border border-slate-800 rounded-xl">
          <button
            onClick={() => onViewChange('admin')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              currentView === 'admin'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span>Admin Console</span>
          </button>
          <button
            onClick={() => onViewChange('secondary')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition ${
              currentView === 'secondary'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            <span>Secondary Phone</span>
          </button>
        </div>

        {/* Auth / Profile Area */}
        <div className="flex items-center space-x-3">
          {adminEmail ? (
            <div className="flex items-center space-x-2">
              <div className="hidden md:flex flex-col text-right">
                <span className="text-xs font-medium text-slate-200 truncate max-w-[150px]">{adminEmail}</span>
                <span className="text-[10px] text-emerald-400 flex items-center justify-end space-x-1">
                  <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                  <span>Authenticated Admin</span>
                </span>
              </div>
              <button
                onClick={onSignOut}
                className="p-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-rose-400 rounded-xl transition"
                title="Sign out of Admin Session"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={onSignIn}
              className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 shadow-md shadow-indigo-600/20 transition"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Admin Sign In</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
