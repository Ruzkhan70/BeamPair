import React from 'react';
import {
  ShieldCheck,
  Smartphone,
  LayoutDashboard,
  LogOut,
  LogIn,
} from 'lucide-react';
import { BOOTSTRAP_ADMIN_EMAIL } from '../firebase/config';
import { PWAInstallButton } from './PWAControls';

interface NavbarProps {
  currentView: 'admin' | 'secondary';
  onViewChange: (view: 'admin' | 'secondary') => void;
  adminEmail: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  isClientOnly?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentView,
  onViewChange,
  adminEmail,
  onSignIn,
  onSignOut,
  isClientOnly = false,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur-md sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
        {/* Brand */}
        <div className="flex items-center space-x-2.5 sm:space-x-3 min-w-0">
          <div className="w-8 h-8 sm:w-9 sm:h-9 bg-gradient-to-tr from-indigo-600 to-indigo-400 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/30 shrink-0">
            <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-bold text-white tracking-tight flex items-center space-x-1.5">
              <span>BeamPair</span>
              <span className="px-1.5 py-0.5 bg-indigo-500/20 text-indigo-400 text-[9px] sm:text-[10px] rounded-md font-mono font-medium whitespace-nowrap">
                {isClientOnly ? 'CLIENT' : 'SUPPORT'}
              </span>
            </span>
            <p className="text-[10px] text-slate-400 hidden sm:block truncate">
              {isClientOnly ? 'QR-Paired Remote Device Client' : 'QR-Paired Mobile & Desktop Remote Support'}
            </p>
          </div>
        </div>

        {/* Desktop View Switcher (Hidden completely for QR-scanned / paired client devices) */}
        {!isClientOnly && (
          <div className="hidden md:flex items-center space-x-1 p-1 bg-slate-900 border border-slate-800 rounded-xl shrink-0">
            <button
              onClick={() => onViewChange('admin')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition cursor-pointer ${
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
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition cursor-pointer ${
                currentView === 'secondary'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Secondary Phone</span>
            </button>
          </div>
        )}

        {/* Auth / Profile Area (Hidden completely for QR-scanned / paired client devices) */}
        <div className="flex items-center space-x-1.5 sm:space-x-3 shrink-0">
          <PWAInstallButton compact />
          {!isClientOnly && (
            adminEmail ? (
              <div className="flex items-center space-x-2">
                <div className="hidden md:flex flex-col text-right">
                  <span className="text-xs font-medium text-slate-200">Administrator</span>
                  {adminEmail.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase() ? (
                    <span className="text-[10px] text-emerald-400 flex items-center justify-end space-x-1">
                      <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
                      <span>Authorized</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-rose-400 flex items-center justify-end space-x-1">
                      <span className="w-1.5 h-1.5 bg-rose-400 rounded-full" />
                      <span>Unauthorized</span>
                    </span>
                  )}
                </div>
                <button
                  onClick={onSignOut}
                  className="p-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-rose-400 rounded-xl transition cursor-pointer"
                  title="Sign out of Admin Session"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={onSignIn}
                className="px-2.5 sm:px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 shadow-md shadow-indigo-600/20 transition cursor-pointer whitespace-nowrap"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span className="sm:hidden">Sign In</span>
                <span className="hidden sm:inline">Admin Sign In</span>
              </button>
            )
          )}
        </div>
      </div>

      {/* Mobile / Compact View Switcher Bar */}
      {!isClientOnly && (
        <div className="md:hidden px-3 pb-2.5">
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl">
            <button
              onClick={() => onViewChange('admin')}
              className={`py-2 px-2 rounded-lg text-xs font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer ${
                currentView === 'admin'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 shrink-0" />
              <span>Admin Console</span>
            </button>
            <button
              onClick={() => onViewChange('secondary')}
              className={`py-2 px-2 rounded-lg text-xs font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer ${
                currentView === 'secondary'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 shrink-0" />
              <span>Phone Client</span>
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
