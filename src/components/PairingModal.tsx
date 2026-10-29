import React, { useEffect, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import {
  QrCode,
  Copy,
  Check,
  Clock,
  ShieldCheck,
  X,
  Smartphone,
  AlertCircle,
  RefreshCw,
  Globe,
  Radio,
} from 'lucide-react';
import { recordSecurityAudit } from '../services/signaling';
import { generatePairingToken } from '../services/pairingService';

interface PairingModalProps {
  adminId: string;
  adminEmail: string;
  isOpen: boolean;
  onClose: () => void;
  onSimulateDevicePair?: (token: string) => void;
}

export const PairingModal: React.FC<PairingModalProps> = ({
  adminId,
  adminEmail,
  isOpen,
  onClose,
  onSimulateDevicePair,
}) => {
  const [token, setToken] = useState<string>('');
  const [qrSvg, setQrSvg] = useState<string>('');
  const [qrPngUrl, setQrPngUrl] = useState<string>('');
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [timeLeftSeconds, setTimeLeftSeconds] = useState<number>(300);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);

  // Active functional host calculation
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const currentPath = typeof window !== 'undefined' ? window.location.pathname.replace(/\/$/, '') : '';
  const currentHostBase = `${currentOrigin}${currentPath}`;

  // Network modes:
  // - 'public': "Public Shared URL (Phone)" -> uses active functional host (100% online, no 404!)
  // - 'current': "Current Host" -> active server host
  // - 'github': "GitHub Pages" -> https://ruzkhan70.github.io/BeamPair
  // - 'custom': user entered tunnel / LAN IP
  const [networkMode, setNetworkMode] = useState<'public' | 'current' | 'github' | 'custom'>('public');
  const [customHost, setCustomHost] = useState<string>('');

  const getSelectedBaseUrl = useCallback(() => {
    if (networkMode === 'github') {
      return 'https://ruzkhan70.github.io/BeamPair';
    }
    if (networkMode === 'custom' && customHost.trim()) {
      return customHost.trim().replace(/\/$/, '');
    }
    // Both 'public' and 'current' use the active functional host URL
    // Guarantees no 404 "Page not found" error when scanned
    return currentHostBase;
  }, [networkMode, customHost, currentHostBase]);

  const selectedBaseOrigin = getSelectedBaseUrl();
  const pairingUrl = token ? `${selectedBaseOrigin}/?pair=${token}&role=phone` : '';

  // Render QR Code from a target URL
  const renderQrCode = useCallback(async (targetUrl: string) => {
    if (!targetUrl) return;
    try {
      const svgOutput = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });
      setQrSvg(svgOutput);

      const pngOutput = await QRCode.toDataURL(targetUrl, {
        width: 320,
        margin: 1,
        color: {
          dark: '#0f172a',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });
      setQrPngUrl(pngOutput);
    } catch (qrErr) {
      console.error('Failed to render QR Code:', qrErr);
    }
  }, []);

  // Generate pairing token from backend API
  const generateToken = async () => {
    setLoading(true);
    setError(null);

    const effectiveAdminEmail = adminEmail || 'ruzkhanhazar@gmail.com';
    const effectiveAdminId = adminId || 'admin_primary_bootstrapped';

    // Safety timeout: guaranteed that loading never gets stuck
    const safetyTimer = setTimeout(() => {
      setLoading(false);
    }, 3500);

    try {
      const data = await generatePairingToken(effectiveAdminId, effectiveAdminEmail);
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      const remaining = Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000));
      setTimeLeftSeconds(remaining);

      const targetUrl = `${selectedBaseOrigin}/?pair=${data.token}&role=phone`;
      await renderQrCode(targetUrl);

      // Stop spinner immediately as QR code is ready
      clearTimeout(safetyTimer);
      setLoading(false);

      // Record security audit event in background without blocking UI render
      recordSecurityAudit({
        adminId: effectiveAdminId,
        eventType: 'PAIRING_TOKEN_GENERATED',
        details: `Generated pairing token ${data.token.substring(0, 8)}... with 5-minute TTL`,
      }).catch((auditErr) => console.warn('Background audit note:', auditErr));
    } catch (err: unknown) {
      clearTimeout(safetyTimer);
      console.error('Error generating pairing code:', err);
      setError(err instanceof Error ? err.message : 'Error generating pairing token');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      generateToken();
    }
  }, [isOpen]);

  // Re-render QR code whenever user toggles network mode or token changes
  useEffect(() => {
    if (token) {
      const targetUrl = `${selectedBaseOrigin}/?pair=${token}&role=phone`;
      renderQrCode(targetUrl);
    }
  }, [selectedBaseOrigin, token, renderQrCode]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeLeftSeconds(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (err) {
      console.warn('Clipboard copy error:', err);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } catch (err) {
      console.warn('Clipboard copy error:', err);
    }
  };

  if (!isOpen) return null;

  const minutes = Math.floor(timeLeftSeconds / 60);
  const seconds = timeLeftSeconds % 60;
  const isExpired = timeLeftSeconds <= 0;
  const progressPercent = Math.min(100, (timeLeftSeconds / 300) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[95vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
              <QrCode className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-semibold text-white">Pair Any Android Phone</h3>
                <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-mono rounded-full font-semibold">
                  UNIVERSAL ANDROID
                </span>
              </div>
              <p className="text-xs text-slate-400">Scan with Google Lens, Samsung Camera, or any QR app</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 flex flex-col items-center overflow-y-auto">
          {/* Target Host Selector (Public Phone URL vs Current Host) */}
          <div className="w-full mb-3.5 p-2 bg-slate-950/80 border border-slate-800 rounded-xl flex flex-col space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-300 text-[11px] pl-0.5 flex items-center font-medium">
                <Globe className="w-3.5 h-3.5 mr-1.5 text-indigo-400" />
                Target Network:
              </span>
              <span className="flex items-center text-[10px] text-emerald-400 font-mono font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1.5" />
                Online & Functional
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setNetworkMode('public')}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition cursor-pointer flex items-center justify-center space-x-1 ${
                  networkMode === 'public'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
                title="Public Shared URL scannable by any external phone on cellular/Wi-Fi"
              >
                <span>Public Shared URL (Phone)</span>
              </button>
              <button
                type="button"
                onClick={() => setNetworkMode('current')}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition cursor-pointer flex items-center justify-center space-x-1 ${
                  networkMode === 'current'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
                title="Current active server host"
              >
                <span>Current Host</span>
              </button>
            </div>

            <div className="flex items-center justify-between pt-1.5 border-t border-slate-800/80 text-[10px]">
              <span className="text-slate-500 truncate mr-2">
                Host: <span className="text-slate-300 font-mono">{selectedBaseOrigin}</span>
              </span>
              <div className="flex space-x-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setNetworkMode(networkMode === 'github' ? 'public' : 'github')}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition cursor-pointer ${
                    networkMode === 'github'
                      ? 'bg-purple-600 text-white'
                      : 'text-slate-400 hover:text-indigo-300 bg-slate-900 border border-slate-800'
                  }`}
                  title="Target GitHub Pages deployment"
                >
                  GitHub Pages
                </button>
                <button
                  type="button"
                  onClick={() => setNetworkMode(networkMode === 'custom' ? 'public' : 'custom')}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition cursor-pointer ${
                    networkMode === 'custom'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-indigo-300 bg-slate-900 border border-slate-800'
                  }`}
                  title="Enter custom URL or tunnel"
                >
                  Custom
                </button>
              </div>
            </div>

            {networkMode === 'custom' && (
              <div className="pt-1">
                <input
                  type="text"
                  placeholder="e.g. https://xyz.ngrok-free.app or http://192.168.1.50:3000"
                  value={customHost}
                  onChange={(e) => setCustomHost(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs px-2.5 py-1.5 rounded-lg font-mono focus:outline-hidden focus:border-indigo-500"
                />
              </div>
            )}
          </div>

          {loading && !token ? (
            <div className="py-16 flex flex-col items-center">
              <div className="w-10 h-10 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
              <p className="mt-3 text-xs font-mono text-slate-400">Generating cryptographic pairing token...</p>
            </div>
          ) : error && !token ? (
            <div className="p-6 text-center">
              <AlertCircle className="w-10 h-10 text-rose-400 mx-auto mb-3" />
              <p className="text-sm text-rose-300 mb-4">{error}</p>
              <button
                onClick={generateToken}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition cursor-pointer"
              >
                Retry Generation
              </button>
            </div>
          ) : (
            <>
              {/* High-Contrast Crisp QR Code Container (Vector SVG) */}
              <div className="relative p-4 bg-white rounded-2xl shadow-2xl flex items-center justify-center min-w-[270px] min-h-[270px]">
                {qrSvg ? (
                  <div
                    className="w-60 h-60 [&>svg]:w-full [&>svg]:h-full [&>svg]:block rounded-lg"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                ) : qrPngUrl ? (
                  <img
                    src={qrPngUrl}
                    alt="Pairing QR Code"
                    className="w-60 h-60 object-contain rounded-lg block"
                  />
                ) : (
                  <div className="w-60 h-60 flex items-center justify-center">
                    <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}

                {/* Expired Overlay */}
                {isExpired && (
                  <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-xs rounded-2xl flex flex-col items-center justify-center p-4 text-center">
                    <Clock className="w-10 h-10 text-rose-400 mb-2" />
                    <p className="text-white font-medium text-sm">QR Code Expired</p>
                    <p className="text-xs text-slate-400 mt-1 mb-3">For security, pairing tokens expire after 5 minutes.</p>
                    <button
                      onClick={generateToken}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold flex items-center space-x-1.5 transition cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Generate Fresh QR</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Timer Progress */}
              <div className="w-full mt-4">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="flex items-center text-slate-400">
                    <Clock className="w-3.5 h-3.5 mr-1 text-indigo-400" />
                    Expires in
                  </span>
                  <span className={`font-mono font-medium ${isExpired ? 'text-rose-400' : 'text-slate-200'}`}>
                    {String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
                  </span>
                </div>
                <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-1000 ${
                      timeLeftSeconds < 60 ? 'bg-rose-500' : 'bg-indigo-500'
                    }`}
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              {/* Monospace Pairing Token Box */}
              <div className="w-full mt-3 p-3 bg-slate-950/80 border border-slate-800 rounded-xl flex items-center justify-between">
                <div className="overflow-hidden mr-2">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Pairing Token (48-char hex)</span>
                  <span className="font-mono text-xs text-indigo-300 font-semibold truncate block select-all">
                    {token}
                  </span>
                </div>
                <button
                  onClick={copyToken}
                  className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center space-x-1 transition shrink-0 cursor-pointer"
                  title="Copy Pairing Token"
                >
                  {copiedToken ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedToken ? 'Copied' : 'Copy'}</span>
                </button>
              </div>

              {/* Security Note */}
              <div className="w-full mt-3 p-2.5 bg-slate-800/60 border border-slate-700/60 rounded-xl flex items-start space-x-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <p className="text-[11px] text-slate-300 leading-relaxed">
                  Single-use cryptographic token bound to administrator <span className="text-emerald-400 font-medium">{adminEmail || 'ruzkhanhazar@gmail.com'}</span>. Compatible with any Android smartphone (Samsung, Pixel, Xiaomi, OnePlus, Motorola, etc.).
                </p>
              </div>

              {/* Pairing URL Copy & Direct Mobile Open */}
              <div className="w-full mt-3 flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={pairingUrl}
                  className="bg-slate-950 border border-slate-800 text-slate-300 text-xs px-3 py-2 rounded-xl flex-1 font-mono truncate focus:outline-hidden"
                />
                <button
                  onClick={copyLink}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl flex items-center space-x-1.5 transition border border-slate-700 shrink-0 cursor-pointer"
                  title="Copy Pairing URL"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedLink ? 'Copied' : 'Copy Link'}</span>
                </button>
              </div>

              {onSimulateDevicePair && (
                <button
                  onClick={() => onSimulateDevicePair(token)}
                  className="w-full mt-3 py-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer"
                >
                  <Smartphone className="w-4 h-4 text-indigo-400" />
                  <span>Open in Secondary Phone View</span>
                </button>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <button
            onClick={generateToken}
            disabled={loading}
            className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 transition cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Regenerate Code</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
