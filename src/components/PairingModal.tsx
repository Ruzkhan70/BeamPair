import React, { useEffect, useState } from 'react';
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
  ExternalLink,
} from 'lucide-react';
import { recordSecurityAudit } from '../services/signaling';

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

  const pairingUrl = token ? `${window.location.origin}/?pair=${token}` : '';

  // Generate pairing token from backend API
  const generateToken = async () => {
    setLoading(true);
    setError(null);
    setQrSvg('');
    setQrPngUrl('');

    const effectiveAdminEmail = adminEmail || 'ruzkhanhazar@gmail.com';
    const effectiveAdminId = adminId || 'admin_primary_bootstrapped';

    try {
      const res = await fetch('/api/pairing/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminId: effectiveAdminId, adminEmail: effectiveAdminEmail }),
      });

      if (!res.ok) {
        throw new Error('Failed to generate pairing token');
      }

      const data = await res.json();
      setToken(data.token);
      setExpiresAt(data.expiresAt);
      const remaining = Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000));
      setTimeLeftSeconds(remaining);

      const targetUrl = `${window.location.origin}/?pair=${data.token}`;

      // 1. Generate pure SVG vector representation (immune to canvas context bugs)
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

      // 2. Generate PNG Data URL as secondary fallback
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

      // Record security audit event
      await recordSecurityAudit({
        adminId: effectiveAdminId,
        eventType: 'PAIRING_TOKEN_GENERATED',
        details: `Generated pairing token ${data.token.substring(0, 8)}... with 5-minute TTL`,
      });
    } catch (err: unknown) {
      console.error('Error generating pairing code:', err);
      setError(err instanceof Error ? err.message : 'Error generating pairing token');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      generateToken();
    }
  }, [isOpen]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
              <QrCode className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Device Pairing QR Code</h3>
              <p className="text-xs text-slate-400">Scan with secondary Android phone camera</p>
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
          {loading ? (
            <div className="py-20 flex flex-col items-center">
              <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
              <p className="mt-4 text-xs font-mono text-slate-400">Generating cryptographic pairing token...</p>
            </div>
          ) : error ? (
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
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider block">Pairing Token</span>
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
                  Single-use cryptographic token bound to administrator <span className="text-emerald-400 font-medium">{adminEmail || 'ruzkhanhazar@gmail.com'}</span>.
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
                  <span>{copiedLink ? 'Copied Link' : 'Copy Link'}</span>
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
