import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Smartphone,
  QrCode,
  Radio,
  Play,
  Trash2,
  Clock,
  Shield,
  Activity,
  CheckCircle2,
  AlertTriangle,
  History,
  Settings,
  Server,
  Layers,
  PhoneOff,
  Video,
  Mic,
  Monitor,
  Search,
  X,
  Loader2,
  LayoutDashboard,
  ExternalLink,
  Edit2,
  Copy,
  Check,
  RefreshCw,
  Info,
  Globe,
  Sliders,
  ShieldCheck,
  ChevronRight,
  ArrowUpRight,
  Zap,
  MapPin,
  LocateFixed,
  Compass,
  Camera,
  Battery,
  BatteryCharging,
  Wifi,
  Lock,
  Terminal,
} from 'lucide-react';
import { Device, Session, SecurityAuditLog } from '../types';
import { auth, BOOTSTRAP_ADMIN_EMAIL } from '../firebase/config';
import {
  listenToAdminDevices,
  revokeDeviceRegistration,
  deleteDeviceFromFirestore,
  renameDeviceInFirestore,
  listenToSessionHistory,
  listenToSecurityLogs,
  requestDeviceLocationPing,
  updateDeviceHeartbeat,
} from '../services/deviceService';
import { PairingModal } from './PairingModal';
import { AdminLiveStreamModal } from './AdminLiveStreamModal';
import { DeviceMapViewer } from './DeviceMapViewer';
import {
  fetchIceServers,
  getStoredCustomIceServers,
  saveCustomIceServers,
  testIceConnectivity,
} from '../services/webrtc';
import QRCode from 'qrcode';
import { generatePairingToken } from '../services/pairingService';
import { createRemoteSession, recordSecurityAudit, sendSessionRemoteCommand, terminateSession } from '../services/signaling';

interface AdminDashboardProps {
  adminId: string;
  adminEmail: string;
  onSimulateDevicePair?: (token: string) => void;
}

type TabType =
  | 'overview'
  | 'devices'
  | 'map'
  | 'pairing'
  | 'live'
  | 'history'
  | 'audit'
  | 'diagnostics'
  | 'settings';

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminId,
  adminEmail,
  onSimulateDevicePair,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceIdForMap, setSelectedDeviceIdForMap] = useState<string | null>(null);
  const [sessionHistory, setSessionHistory] = useState<Session[]>([]);
  const [auditLogs, setAuditLogs] = useState<SecurityAuditLog[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [deviceFilter, setDeviceFilter] = useState<'all' | 'online' | 'offline' | 'revoked'>('all');

  // Modals & Direct Camera Launch state
  const [isPairingModalOpen, setIsPairingModalOpen] = useState<boolean>(false);
  const [startingDeviceId, setStartingDeviceId] = useState<string | null>(null);
  const [activeLiveSession, setActiveLiveSession] = useState<{
    session: Session;
    device: Device;
  } | null>(null);

  // Device management modal state
  const [deviceToManage, setDeviceToManage] = useState<Device | null>(null);
  const [manageLoading, setManageLoading] = useState<boolean>(false);

  // Device renaming state
  const [deviceToRename, setDeviceToRename] = useState<Device | null>(null);
  const [newDeviceName, setNewDeviceName] = useState<string>('');
  const [renameLoading, setRenameLoading] = useState<boolean>(false);

  // Device details modal
  const [deviceDetails, setDeviceDetails] = useState<Device | null>(null);

  // STUN/TURN config & live probe state
  const [iceServers, setIceServers] = useState<any[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [customTurnUrl, setCustomTurnUrl] = useState<string>(() => {
    const existing = getStoredCustomIceServers();
    if (!existing.length) return '';
    return Array.isArray(existing[0].urls) ? existing[0].urls[0] || '' : String(existing[0].urls || '');
  });
  const [customTurnUser, setCustomTurnUser] = useState<string>(() => {
    const existing = getStoredCustomIceServers();
    return existing[0]?.username || '';
  });
  const [customTurnPass, setCustomTurnPass] = useState<string>(() => {
    const existing = getStoredCustomIceServers();
    return typeof existing[0]?.credential === 'string' ? existing[0].credential : '';
  });
  const [turnSavedFeedback, setTurnSavedFeedback] = useState<string | null>(null);
  const [iceTestRunning, setIceTestRunning] = useState<boolean>(false);
  const [iceTestResult, setIceTestResult] = useState<{
    hasHost: boolean;
    hasSrflx: boolean;
    hasRelay: boolean;
    rttMs: number;
  } | null>(null);

  // Embedded Pairing Tab state
  const [embedToken, setEmbedToken] = useState<string>('');
  const [embedQrSvg, setEmbedQrSvg] = useState<string>('');
  const [embedExpiresAt, setEmbedExpiresAt] = useState<number>(0);
  const [embedTimeLeft, setEmbedTimeLeft] = useState<number>(300);
  const [embedLoading, setEmbedLoading] = useState<boolean>(false);
  const [embedCopied, setEmbedCopied] = useState<boolean>(false);
  const [embedNetworkMode, setEmbedNetworkMode] = useState<'public' | 'current' | 'github' | 'custom'>('current');
  const [embedCustomHost, setEmbedCustomHost] = useState<string>('');
  const [sharedHostLive, setSharedHostLive] = useState<boolean | null>(null);

  // Diagnostics state
  const [diagRunning, setDiagRunning] = useState<boolean>(false);
  const [diagResults, setDiagResults] = useState<{
    secureContext: boolean;
    webrtcSupport: boolean;
    getUserMedia: boolean;
    getDisplayMedia: boolean;
    camPerm: string;
    micPerm: string;
    iceServersCount: number;
    latencyMs: number | null;
    timestamp: number;
  }>({
    secureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
    webrtcSupport: typeof window !== 'undefined' && 'RTCPeerConnection' in window,
    getUserMedia: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    getDisplayMedia: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia,
    camPerm: 'checking...',
    micPerm: 'checking...',
    iceServersCount: 0,
    latencyMs: null,
    timestamp: Date.now(),
  });

  // Host calculation for pairing (prefer Shared App URL so external phones never hit dev login)
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const currentPath = typeof window !== 'undefined' ? window.location.pathname.replace(/\/$/, '') : '';
  const currentHostBase = `${currentOrigin}${currentPath}`;
  const publicPhoneHostBase = currentHostBase.includes('https://ais-dev-')
    ? currentHostBase.replace('https://ais-dev-', 'https://ais-pre-')
    : currentHostBase;
  const embedTargetHost =
    embedNetworkMode === 'github'
      ? 'https://ruzkhan70.github.io/BeamPair'
      : embedNetworkMode === 'custom' && embedCustomHost.trim()
        ? embedCustomHost.trim().replace(/\/$/, '')
        : embedNetworkMode === 'public'
          ? publicPhoneHostBase
          : currentHostBase;
  const embedPairingUrl = embedToken ? `${embedTargetHost}/?pair=${embedToken}&role=phone` : '';

  useEffect(() => {
    fetch('/api/pairing/host-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.sharedHostLive === 'boolean') {
          setSharedHostLive(data.sharedHostLive);
          if (data.sharedHostLive && publicPhoneHostBase !== currentHostBase) {
            setEmbedNetworkMode('public');
          } else {
            setEmbedNetworkMode('current');
          }
        }
      })
      .catch(() => setSharedHostLive(false));
  }, [publicPhoneHostBase, currentHostBase]);

  // Copy helper
  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Run diagnostics check
  const runDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    const start = performance.now();

    let camPerm = 'unsupported';
    let micPerm = 'unsupported';

    if (navigator.permissions && navigator.permissions.query) {
      try {
        const cam = await navigator.permissions.query({ name: 'camera' as PermissionName });
        camPerm = cam.state;
      } catch {
        camPerm = 'prompt/unqueried';
      }
      try {
        const mic = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        micPerm = mic.state;
      } catch {
        micPerm = 'prompt/unqueried';
      }
    }

    let serversCount = 0;
    try {
      const servers = await fetchIceServers();
      serversCount = servers.length;
    } catch {
      serversCount = 1; // default Google STUN
    }

    const elapsed = Math.round(performance.now() - start);

    setDiagResults({
      secureContext: window.isSecureContext,
      webrtcSupport: 'RTCPeerConnection' in window,
      getUserMedia: !!navigator.mediaDevices?.getUserMedia,
      getDisplayMedia: !!navigator.mediaDevices?.getDisplayMedia,
      camPerm,
      micPerm,
      iceServersCount: serversCount,
      latencyMs: elapsed,
      timestamp: Date.now(),
    });

    setDiagRunning(false);
  }, []);

  // Generate Embedded Pairing Token
  const generateEmbedToken = useCallback(async () => {
    setEmbedLoading(true);
    try {
      const data = await generatePairingToken(adminId, BOOTSTRAP_ADMIN_EMAIL);
      setEmbedToken(data.token);
      setEmbedExpiresAt(data.expiresAt);
      const remaining = Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000));
      setEmbedTimeLeft(remaining);

      const targetUrl = `${embedTargetHost}/?pair=${data.token}&role=phone`;
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
      setEmbedQrSvg(svg);

      recordSecurityAudit({
        adminId,
        eventType: 'PAIRING_TOKEN_GENERATED',
        details: `Pairing token generated in dashboard with 5-minute TTL`,
      }).catch(console.warn);
    } catch (err) {
      console.warn('Embed token generation error:', err);
    } finally {
      setEmbedLoading(false);
    }
  }, [adminId, embedTargetHost]);

  // Re-render QR when host mode toggles on existing token
  useEffect(() => {
    if (embedToken && activeTab === 'pairing') {
      const targetUrl = `${embedTargetHost}/?pair=${embedToken}&role=phone`;
      QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      })
        .then(setEmbedQrSvg)
        .catch(() => {});
    }
  }, [embedTargetHost, embedToken, activeTab]);

  // Countdown timer for embed token
  useEffect(() => {
    if (!embedExpiresAt) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((embedExpiresAt - Date.now()) / 1000));
      setEmbedTimeLeft(remaining);
      if (remaining <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [embedExpiresAt]);

  // Generate embed token when pairing tab is chosen
  useEffect(() => {
    if (activeTab === 'pairing' && (!embedToken || embedTimeLeft <= 0)) {
      generateEmbedToken();
    }
  }, [activeTab, embedToken, embedTimeLeft, generateEmbedToken]);

  // Run initial diagnostics when diagnostics tab is chosen
  useEffect(() => {
    if (activeTab === 'diagnostics') {
      runDiagnostics();
    }
  }, [activeTab, runDiagnostics]);

  // Listen to Firestore real-time data
  useEffect(() => {
    if (!auth.currentUser || !adminId) return;

    const unsubDevices = listenToAdminDevices(adminId, (devs) => {
      setDevices(devs);
    });

    const unsubSessions = listenToSessionHistory(adminId, (sessions) => {
      setSessionHistory(sessions);
    });

    const unsubAudit = listenToSecurityLogs((logs) => {
      setAuditLogs(logs);
    });

    fetchIceServers()
      .then((servers) => setIceServers(servers))
      .catch(console.warn);

    return () => {
      unsubDevices();
      unsubSessions();
      unsubAudit();
    };
  }, [adminId]);

  // Handle Revoke Device Access
  const handleRevokeConfirm = async () => {
    if (!deviceToManage) return;
    setManageLoading(true);
    try {
      await revokeDeviceRegistration(adminId, deviceToManage.deviceId);
      setDeviceToManage(null);
    } catch (err) {
      console.error('Revoke error:', err);
    } finally {
      setManageLoading(false);
    }
  };

  // Handle Delete Device
  const handleDeleteConfirm = async () => {
    if (!deviceToManage) return;
    setManageLoading(true);
    try {
      await deleteDeviceFromFirestore(adminId, deviceToManage.deviceId);
      setDeviceToManage(null);
    } catch (err) {
      console.error('Delete error:', err);
    } finally {
      setManageLoading(false);
    }
  };

  // Handle Rename Device
  const handleRenameConfirm = async () => {
    if (!deviceToRename || !newDeviceName.trim()) return;
    setRenameLoading(true);
    try {
      await renameDeviceInFirestore(adminId, deviceToRename.deviceId, newDeviceName.trim());
      setDeviceToRename(null);
      setNewDeviceName('');
    } catch (err) {
      console.error('Rename error:', err);
    } finally {
      setRenameLoading(false);
    }
  };

  // Metrics
  const onlineDevicesCount = devices.filter((d) => d.status === 'online' && !d.isRevoked).length;
  const devicesWithLocation = useMemo(() => {
    return devices.filter((d) => !!d.location && typeof d.location.latitude === 'number');
  }, [devices]);

  const activeSessions = useMemo(() => {
    return sessionHistory.filter((s) => s.status === 'active' || s.status === 'connecting');
  }, [sessionHistory]);

  // Directly turn on phone camera & open full remote control viewer in one click
  const handleTurnOnCamera = async (targetDevice: Device) => {
    if (targetDevice.isRevoked || startingDeviceId) return;

    setStartingDeviceId(targetDevice.deviceId);
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    try {
      // Clean up any stale/orphaned active or connecting sessions for this device first
      const staleSessions = sessionHistory.filter(
        (s) =>
          s.deviceId === targetDevice.deviceId &&
          (s.status === 'requested' || s.status === 'connecting' || s.status === 'active')
      );
      if (staleSessions.length > 0) {
        await Promise.allSettled(
          staleSessions.map((s) =>
            terminateSession(s.sessionId, 'admin', 'Superseded by fresh camera connection')
          )
        );
      }

      await createRemoteSession({
        sessionId,
        adminId,
        deviceId: targetDevice.deviceId,
        requestCamera: true,
        cameraFacing: 'environment',
        requestMicrophone: true,
        requestScreen: false,
      });

      await updateDeviceHeartbeat(targetDevice.deviceId, { currentSessionId: sessionId });

      recordSecurityAudit({
        adminId,
        deviceId: targetDevice.deviceId,
        eventType: 'SESSION_REQUESTED',
        details: `Direct camera & remote controls session launched for ${targetDevice.deviceName}.`,
      }).catch(console.warn);

      const newSession: Session = {
        sessionId,
        adminId,
        deviceId: targetDevice.deviceId,
        status: 'requested',
        requestCamera: true,
        cameraFacing: 'environment',
        requestMicrophone: true,
        requestScreen: false,
        startedAt: Date.now(),
      };

      setActiveLiveSession({ session: newSession, device: targetDevice });
    } catch (err) {
      console.error('Failed to turn on camera session:', err);
    } finally {
      setStartingDeviceId(null);
    }
  };

  const handleRequestLocationPing = async (targetDeviceId: string) => {
    const dev = devices.find((d) => d.deviceId === targetDeviceId);
    await requestDeviceLocationPing(targetDeviceId).catch(console.warn);
    if (dev?.currentSessionId) {
      await sendSessionRemoteCommand(dev.currentSessionId, { action: 'requestLocation' }).catch(console.warn);
    }
    await recordSecurityAudit({
      adminId,
      deviceId: targetDeviceId,
      eventType: 'GPS_PING_REQUESTED',
      details: `Administrator requested remote GPS location ping for device ${dev?.deviceName || targetDeviceId}`,
    }).catch(console.warn);
  };

  const filteredDevices = useMemo(() => {
    return devices.filter((d) => {
      const matchesSearch =
        d.deviceName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.deviceId.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) return false;

      if (deviceFilter === 'online') return d.status === 'online' && !d.isRevoked;
      if (deviceFilter === 'offline') return d.status === 'offline' && !d.isRevoked;
      if (deviceFilter === 'revoked') return d.isRevoked;
      return true;
    });
  }, [devices, searchQuery, deviceFilter]);

  const navigationItems: { id: TabType; label: string; icon: React.ReactNode; badge?: number | string }[] = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'devices', label: 'Devices', icon: <Smartphone className="w-4 h-4" />, badge: devices.length },
    {
      id: 'map',
      label: 'GPS Map & Location',
      icon: <MapPin className="w-4 h-4" />,
      badge: devicesWithLocation.length > 0 ? `${devicesWithLocation.length} live` : undefined,
    },
    { id: 'pairing', label: 'Pair New Device', icon: <QrCode className="w-4 h-4" /> },
    {
      id: 'live',
      label: 'Live Sessions',
      icon: <Radio className="w-4 h-4" />,
      badge: activeSessions.length > 0 ? activeSessions.length : undefined,
    },
    { id: 'history', label: 'Session History', icon: <History className="w-4 h-4" />, badge: sessionHistory.length },
    { id: 'audit', label: 'Security Audit', icon: <ShieldCheck className="w-4 h-4" />, badge: auditLogs.length },
    { id: 'diagnostics', label: 'Connection Diagnostics', icon: <Activity className="w-4 h-4" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
  ];

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-[calc(100dvh-4rem)] bg-slate-950 text-slate-100 min-w-0">
      {/* MOBILE / TABLET HORIZONTAL NAVIGATION BAR */}
      <div className="lg:hidden bg-slate-900/95 border-b border-slate-800 shrink-0">
        <div className="px-3 pt-2.5 pb-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center space-x-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="text-xs font-semibold text-white truncate">Admin Console</span>
            <span className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[9px] font-mono rounded-md font-semibold shrink-0">
              LIVE
            </span>
          </div>
          <button
            onClick={() => setIsPairingModalOpen(true)}
            className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded-xl flex items-center space-x-1.5 transition cursor-pointer shrink-0 shadow-sm shadow-indigo-600/20"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Quick Pair</span>
          </button>
        </div>

        <nav className="flex items-center gap-1.5 px-3 pb-2.5 overflow-x-auto scrollbar-none">
          {navigationItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`shrink-0 whitespace-nowrap flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25 font-semibold'
                    : 'bg-slate-950/70 border border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.badge !== undefined && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono font-semibold ${
                      isActive ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* SIDEBAR NAVIGATION (Desktop lg+) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 bg-slate-900/90 border-r border-slate-800 p-4 justify-between shrink-0">
        <div className="space-y-6">
          {/* Admin Header Status */}
          <div className="px-3 py-2 bg-slate-950/80 border border-slate-800/90 rounded-xl flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <div>
                <span className="text-xs font-semibold text-white block">Authorized Admin</span>
                <span className="text-[10px] text-slate-400 font-mono">P2P Encrypted Session</span>
              </div>
            </div>
            <span className="px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[9px] font-mono rounded-md font-semibold">
              LIVE
            </span>
          </div>

          {/* Navigation Links */}
          <nav className="space-y-1">
            {navigationItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition cursor-pointer ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/25 font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    {item.icon}
                    <span>{item.label}</span>
                  </div>
                  {item.badge !== undefined && (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold ${
                        isActive ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Quick Footer Action */}
        <div className="pt-6 border-t border-slate-800/80 space-y-2.5">
          <button
            onClick={() => setIsPairingModalOpen(true)}
            className="w-full py-2.5 bg-indigo-600/90 hover:bg-indigo-600 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-indigo-600/20 cursor-pointer"
          >
            <QrCode className="w-4 h-4" />
            <span>Quick Pair Phone</span>
          </button>
          <div className="text-[10px] text-slate-500 text-center font-mono">
            BeamPair v2.4 • WebRTC 1.0 Ready
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-1 min-w-0 p-3 sm:p-6 lg:p-8 overflow-y-auto max-w-7xl w-full mx-auto space-y-5 sm:space-y-6">
        {/* ============================================================ */}
        {/* TAB 1: OVERVIEW */}
        {/* ============================================================ */}
        {activeTab === 'overview' && (
          <div className="space-y-5 sm:space-y-6 animate-fade-in">
            {/* Top Metric Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-lg flex items-center space-x-3">
                <div className="p-2.5 sm:p-3 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl shrink-0">
                  <Smartphone className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 font-medium block truncate">Registered</span>
                  <h4 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{devices.length}</h4>
                </div>
              </div>

              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-lg flex items-center space-x-3">
                <div className="p-2.5 sm:p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl shrink-0">
                  <Radio className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 font-medium block truncate">Online</span>
                  <div className="flex items-center space-x-2">
                    <h4 className="text-xl sm:text-2xl font-bold text-emerald-400 tracking-tight">{onlineDevicesCount}</h4>
                    <span className="flex h-2 w-2 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                    </span>
                  </div>
                </div>
              </div>

              <div
                onClick={() => setActiveTab('map')}
                className="bg-slate-900/90 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/40 rounded-2xl p-3.5 sm:p-4 shadow-lg flex items-center space-x-3 transition cursor-pointer group"
              >
                <div className="p-2.5 sm:p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl group-hover:scale-105 transition shrink-0">
                  <MapPin className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 font-medium block truncate">GPS Located</span>
                  <div className="flex items-center space-x-1.5">
                    <h4 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{devicesWithLocation.length}</h4>
                    <span className="text-[10px] text-emerald-400 font-medium ml-1 flex items-center whitespace-nowrap">
                      Map &rarr;
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-lg flex items-center space-x-3">
                <div className="p-2.5 sm:p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl shrink-0">
                  <History className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 font-medium block truncate">Sessions</span>
                  <h4 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{sessionHistory.length}</h4>
                </div>
              </div>

              <div className="col-span-2 lg:col-span-1 bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-lg flex items-center space-x-3">
                <div className="p-2.5 sm:p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl shrink-0">
                  <ShieldCheck className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <span className="text-[11px] sm:text-xs text-slate-400 font-medium block truncate">Security Audits</span>
                  <h4 className="text-xl sm:text-2xl font-bold text-white tracking-tight">{auditLogs.length}</h4>
                </div>
              </div>
            </div>

            {/* Quick Actions & Recent Devices Spotlight */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
              {/* Quick Pair Card */}
              <div className="bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-900 border border-indigo-500/30 rounded-2xl p-5 sm:p-6 shadow-xl flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="inline-flex items-center space-x-1.5 px-2.5 py-1 bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-[11px] font-medium rounded-lg">
                    <Zap className="w-3.5 h-3.5" />
                    <span>Zero Play Store App Required</span>
                  </div>
                  <h3 className="text-base font-bold text-white tracking-tight">Pair Any Mobile Phone</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Generate a single-use cryptographic QR code. The phone user scans it using their camera, Google Lens, or mobile browser to pair immediately.
                  </p>
                </div>
                <div className="pt-5 sm:pt-6">
                  <button
                    onClick={() => setActiveTab('pairing')}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-indigo-600/25 cursor-pointer"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>Open Pairing Console</span>
                  </button>
                </div>
              </div>

              {/* Online Devices Preview */}
              <div className="lg:col-span-2 bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white flex items-center space-x-2">
                    <Smartphone className="w-4 h-4 text-indigo-400 shrink-0" />
                    <span>Paired Devices Status</span>
                  </h3>
                  <button
                    onClick={() => setActiveTab('devices')}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 cursor-pointer font-medium shrink-0"
                  >
                    <span>View All ({devices.length})</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {devices.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">
                    No devices paired yet. Click &quot;Open Pairing Console&quot; to pair your first phone.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {devices.slice(0, 3).map((d) => {
                      const isOnline = d.status === 'online' && !d.isRevoked;
                      return (
                        <div
                          key={d.deviceId}
                          className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="flex items-center space-x-3 min-w-0">
                            <div
                              className={`p-2 rounded-lg shrink-0 ${
                                isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              <Smartphone className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <span className="text-xs font-bold text-white block truncate">{d.deviceName}</span>
                              <span className="text-[10px] text-slate-400 font-mono truncate block">
                                {d.deviceId}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center justify-between sm:justify-end space-x-2.5 shrink-0">
                            {isOnline ? (
                              <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold rounded-full flex items-center space-x-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                                <span>Online</span>
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 bg-slate-800 text-slate-400 text-[10px] rounded-full">
                                {d.isRevoked ? 'Revoked' : 'Offline'}
                              </span>
                            )}
                            <button
                              onClick={() => handleTurnOnCamera(d)}
                              disabled={d.isRevoked || startingDeviceId === d.deviceId}
                              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-[11px] font-semibold rounded-lg flex items-center space-x-1.5 transition cursor-pointer"
                            >
                              {startingDeviceId === d.deviceId ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Camera className="w-3 h-3" />
                              )}
                              <span>Turn On Camera</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Recent Security Activity */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white flex items-center space-x-2">
                  <Shield className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Recent Security Events</span>
                </h3>
                <button
                  onClick={() => setActiveTab('audit')}
                  className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center space-x-1 cursor-pointer font-medium shrink-0"
                >
                  <span>Full Audit</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {auditLogs.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-400">
                  No security events recorded yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {auditLogs.slice(0, 4).map((log, idx) => (
                    <div
                      key={log.id || idx}
                      className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="px-2 py-0.5 bg-slate-800 text-indigo-400 font-mono text-[10px] rounded-md font-semibold shrink-0">
                          {log.eventType}
                        </span>
                        <span className="text-slate-300 text-[11px] sm:text-xs break-words">{log.details || 'Event logged'}</span>
                      </div>
                      <span className="text-[11px] text-slate-500 font-mono shrink-0">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 2: DEVICES DIRECTORY */}
        {/* ============================================================ */}
        {activeTab === 'devices' && (
          <div className="space-y-4 animate-fade-in">
            {/* Search and Filters Bar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative w-full sm:max-w-sm flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search by device name or ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3.5 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center space-x-1.5 p-1 bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto scrollbar-none">
                {(['all', 'online', 'offline', 'revoked'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setDeviceFilter(filter)}
                    className={`flex-1 sm:flex-initial px-3 py-1.5 text-[11px] font-semibold rounded-lg capitalize transition cursor-pointer whitespace-nowrap ${
                      deviceFilter === filter
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>

            {filteredDevices.length === 0 ? (
              <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center">
                <div className="w-16 h-16 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-2xl flex items-center justify-center mb-4">
                  <Smartphone className="w-8 h-8" />
                </div>
                <h3 className="text-base font-semibold text-white">No Matching Devices Found</h3>
                <p className="text-xs text-slate-400 max-w-md mt-1 mb-6">
                  {devices.length === 0
                    ? 'No devices have been paired to your account yet. Generate a QR code to pair your first phone.'
                    : 'No devices matched your search or status filter.'}
                </p>
                {devices.length === 0 && (
                  <button
                    onClick={() => setActiveTab('pairing')}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-2 shadow-lg shadow-indigo-600/25 transition cursor-pointer"
                  >
                    <QrCode className="w-4 h-4" />
                    <span>Generate Pairing QR</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredDevices.map((device) => {
                  const isOnline = device.status === 'online' && !device.isRevoked;
                  const pairedDateStr = new Date(device.pairedAt).toLocaleDateString();

                  return (
                    <div
                      key={device.deviceId}
                      className={`bg-slate-900/90 border rounded-2xl p-4 sm:p-5 shadow-xl flex flex-col justify-between transition ${
                        device.isRevoked
                          ? 'border-rose-900/40 opacity-70'
                          : 'border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div>
                        {/* Device Header */}
                        <div className="flex items-start justify-between gap-2 mb-3">
                          <div className="flex items-center space-x-3 min-w-0 flex-1">
                            <div
                              className={`p-2.5 rounded-xl shrink-0 ${
                                isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              <Smartphone className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center space-x-1.5">
                                <h4 className="text-sm font-bold text-white tracking-wide truncate">{device.deviceName}</h4>
                                <button
                                  onClick={() => {
                                    setDeviceToRename(device);
                                    setNewDeviceName(device.deviceName);
                                  }}
                                  className="text-slate-500 hover:text-slate-300 transition p-0.5 cursor-pointer shrink-0"
                                  title="Rename device"
                                >
                                  <Edit2 className="w-3 h-3" />
                                </button>
                              </div>
                              <span
                                onClick={() => handleCopy(device.deviceId, device.deviceId)}
                                className="text-[10px] font-mono text-slate-400 truncate block cursor-pointer hover:text-indigo-300"
                                title="Click to copy Device ID"
                              >
                                {device.deviceId}{' '}
                                {copiedId === device.deviceId && (
                                  <span className="text-emerald-400">(copied)</span>
                                )}
                              </span>
                            </div>
                          </div>

                          {/* Status Badge */}
                          {device.isRevoked ? (
                            <span className="px-2 py-0.5 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-semibold rounded-full uppercase">
                              Revoked
                            </span>
                          ) : isOnline ? (
                            <span className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-semibold rounded-full flex items-center space-x-1">
                              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />
                              <span>Online</span>
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 bg-slate-800 text-slate-400 text-[10px] font-medium rounded-full">
                              Offline
                            </span>
                          )}
                        </div>

                        {/* Capabilities */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 py-3 border-y border-slate-800/80 my-3 text-[10px]">
                          <div className="flex items-center space-x-1 text-slate-400">
                            <Video className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Cam: <strong className="text-slate-300">{device.cameraPermission || 'ready'}</strong></span>
                          </div>
                          <div className="flex items-center space-x-1 text-slate-400">
                            <Mic className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Mic: <strong className="text-slate-300">{device.microphonePermission || 'ready'}</strong></span>
                          </div>
                          <div className="flex items-center space-x-1 text-slate-400">
                            <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Screen: <strong className="text-slate-300">{device.screenShareSupported ? 'Yes' : 'Ready'}</strong></span>
                          </div>
                          <div className="flex items-center space-x-1 text-slate-400">
                            <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                            <span>GPS: <strong className="text-slate-300">{device.location ? `±${Math.round(device.location.accuracy || 5)}m` : (device.locationPermission || 'standby')}</strong></span>
                          </div>
                        </div>

                        {/* Metadata */}
                        <div className="text-[11px] text-slate-400 space-y-1 mb-4">
                          <div className="flex justify-between">
                            <span>Platform:</span>
                            <span className="text-slate-300 font-medium">{device.platform.toUpperCase()}</span>
                          </div>
                          {(typeof device.batteryLevel === 'number' || device.networkType || device.deviceAuthUid) && (
                            <div className="flex justify-between items-center">
                              <span>Health &amp; Security:</span>
                              <span className="flex items-center space-x-2 font-mono text-[10px]">
                                {typeof device.batteryLevel === 'number' && (
                                  <span className={`inline-flex items-center space-x-0.5 ${device.batteryLevel <= 20 && !device.batteryCharging ? 'text-rose-400' : 'text-emerald-400'}`}>
                                    {device.batteryCharging ? <BatteryCharging className="w-3 h-3" /> : <Battery className="w-3 h-3" />}
                                    <span>{device.batteryLevel}%</span>
                                  </span>
                                )}
                                {device.networkType && (
                                  <span className="inline-flex items-center space-x-0.5 text-indigo-300">
                                    <Wifi className="w-3 h-3" />
                                    <span>{device.networkType.toUpperCase()}</span>
                                  </span>
                                )}
                                {device.deviceAuthUid && (
                                  <span className="inline-flex items-center space-x-0.5 text-emerald-400" title="Anonymous Auth UID Bound">
                                    <Lock className="w-3 h-3" />
                                    <span>UID</span>
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                          {device.location && (
                            <div className="flex justify-between">
                              <span>GPS Coordinates:</span>
                              <span className="text-emerald-400 font-mono text-[10px]">
                                {device.location.latitude.toFixed(5)}, {device.location.longitude.toFixed(5)}
                                {device.locationHistory && device.locationHistory.length > 0
                                  ? ` (${device.locationHistory.length} pts)`
                                  : ''}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span>Paired On:</span>
                            <span className="text-slate-300">{pairedDateStr}</span>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center space-x-2 pt-2">
                        <button
                          onClick={() => handleTurnOnCamera(device)}
                          disabled={device.isRevoked || startingDeviceId === device.deviceId}
                          className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-1.5 shadow-md shadow-indigo-600/20 transition cursor-pointer"
                        >
                          {startingDeviceId === device.deviceId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Camera className="w-3.5 h-3.5" />
                          )}
                          <span>Turn On Camera</span>
                        </button>
                        <button
                          onClick={() => {
                            setSelectedDeviceIdForMap(device.deviceId);
                            setActiveTab('map');
                          }}
                          className="p-2 bg-slate-800 hover:bg-emerald-950/40 border border-slate-700/60 hover:border-emerald-700/50 text-slate-300 hover:text-emerald-400 rounded-xl transition cursor-pointer"
                          title="View on GPS Map"
                        >
                          <MapPin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeviceDetails(device)}
                          className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition cursor-pointer"
                          title="View Technical Details"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeviceToManage(device)}
                          className="p-2 bg-slate-800 hover:bg-rose-950/40 border border-slate-700/60 hover:border-rose-800/50 text-slate-400 hover:text-rose-400 rounded-xl transition cursor-pointer"
                          title="Revoke or Delete Device"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB: GPS MAP & GEOLOCATION VIEWER */}
        {/* ============================================================ */}
        {activeTab === 'map' && (
          <div className="space-y-3 sm:space-y-4 animate-fade-in">
            <div className="flex flex-wrap items-center justify-between gap-2.5 bg-slate-900/90 border border-slate-800 rounded-2xl px-4 py-3 sm:px-6 sm:py-4 shadow-xl">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="p-2 sm:p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl shrink-0">
                  <MapPin className="w-4 h-4 sm:w-5 sm:h-5" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-xs sm:text-sm font-bold text-white tracking-wide truncate">
                    Phone Geolocation &amp; Precision GPS Map
                  </h2>
                  <p className="text-[11px] sm:text-xs text-slate-400 hidden sm:block">
                    Real-time GPS coordinate acquisition from paired phones with satellite / street mapping
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <span className="px-2.5 py-1 bg-slate-800 border border-slate-700/80 rounded-xl text-[11px] sm:text-xs font-mono text-emerald-400 flex items-center space-x-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{devicesWithLocation.length} / {devices.length} GPS Fix</span>
                </span>
              </div>
            </div>

            <DeviceMapViewer
              devices={devices}
              selectedDeviceId={selectedDeviceIdForMap}
              onSelectDevice={(d) => setSelectedDeviceIdForMap(d.deviceId)}
              onRequestLocationPing={handleRequestLocationPing}
              className="h-[68dvh] min-h-[430px] sm:h-[calc(100vh-14rem)] sm:min-h-[540px] shadow-2xl"
            />
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 3: PAIR NEW DEVICE (EMBEDDED CONSOLE) */}
        {/* ============================================================ */}
        {activeTab === 'pairing' && (
          <div className="max-w-2xl mx-auto bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-8 shadow-2xl space-y-5 sm:space-y-6 animate-fade-in">
            <div className="text-center space-y-2">
              <div className="w-12 h-12 sm:w-14 sm:h-14 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-2xl mx-auto flex items-center justify-center">
                <QrCode className="w-6 h-6 sm:w-7 sm:h-7" />
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white tracking-tight">Pair Any Mobile Smartphone</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                Scan the cryptographic QR code below using Camera, Google Lens, or a mobile browser. Once paired, the device will be registered to your dashboard.
              </p>
            </div>

            {/* Network mode selector */}
            <div className="p-3 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2.5 text-xs">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-slate-300 font-medium flex items-center">
                  <Globe className="w-3.5 h-3.5 mr-1.5 text-indigo-400" />
                  Target Phone URL:
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEmbedNetworkMode('current')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition cursor-pointer ${
                      embedNetworkMode === 'current'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Active App URL
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmbedNetworkMode('public')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition cursor-pointer ${
                      embedNetworkMode === 'public'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Shared Phone URL{' '}
                    {sharedHostLive === false ? '(404)' : sharedHostLive === true ? '(Live)' : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmbedNetworkMode('github')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition cursor-pointer ${
                      embedNetworkMode === 'github'
                        ? 'bg-purple-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    GitHub Pages
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmbedNetworkMode('custom')}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition cursor-pointer ${
                      embedNetworkMode === 'custom'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Custom
                  </button>
                </div>
              </div>
              <div className="text-[11px] text-slate-400 font-mono truncate">
                {embedTargetHost}
              </div>
              {embedNetworkMode === 'custom' && (
                <input
                  type="text"
                  placeholder="e.g. https://your-app.onrender.com or https://ruzkhan70.github.io/BeamPair"
                  value={embedCustomHost}
                  onChange={(e) => setEmbedCustomHost(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 text-slate-200 text-xs px-2.5 py-1.5 rounded-lg font-mono focus:outline-hidden focus:border-indigo-500"
                />
              )}
              {embedNetworkMode === 'current' && currentHostBase.includes('ais-dev-') && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[11px] text-amber-300 leading-relaxed">
                  <strong>403 on a new phone?</strong> The developer preview URL (<code>ais-dev</code>) only opens on phones signed into your Google account (<code>ruzkhanhazar@gmail.com</code>) — any other account or signed-out phone gets <strong>403 Forbidden</strong>. To pair any new phone: click <strong>Share</strong> in AI Studio (set visibility to <strong>Public</strong>) and use <strong>Shared Phone URL</strong>, or push &amp; build to <strong>GitHub Pages</strong>.
                </div>
              )}
              {embedNetworkMode === 'public' && sharedHostLive === false && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-[11px] text-amber-300 leading-relaxed">
                  The Shared URL (<code>ais-pre</code>) is returning <strong>404</strong> because this app hasn&apos;t been published via AI Studio&apos;s <strong>Share</strong> button yet. Click <strong>Share</strong> in AI Studio (Public) so any new phone can open it without 403/404, or switch to <strong>GitHub Pages</strong> once pushed &amp; built.
                </div>
              )}
            </div>

            {/* QR Code display */}
            <div className="flex flex-col items-center justify-center py-2">
              {embedLoading ? (
                <div className="w-56 h-56 sm:w-64 sm:h-64 bg-slate-950 border border-slate-800 rounded-2xl flex flex-col items-center justify-center space-y-3">
                  <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                  <span className="text-xs text-slate-400">Generating secure pairing token...</span>
                </div>
              ) : embedQrSvg ? (
                <div className="p-3 sm:p-4 bg-white rounded-2xl shadow-2xl flex flex-col items-center max-w-full">
                  <div
                    dangerouslySetInnerHTML={{ __html: embedQrSvg }}
                    className="w-48 h-48 sm:w-56 sm:h-56 [&>svg]:w-full [&>svg]:h-full flex items-center justify-center"
                  />
                  <span className="text-[10px] text-slate-800 font-mono font-bold mt-2 break-all text-center max-w-[210px]">
                    TOKEN: {embedToken}
                  </span>
                </div>
              ) : null}

              {/* Countdown Progress */}
              <div className="w-full max-w-xs mt-4 space-y-1.5 text-center">
                <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>Token Expiration:</span>
                  <span className={embedTimeLeft < 60 ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                    {Math.floor(embedTimeLeft / 60)}:{(embedTimeLeft % 60).toString().padStart(2, '0')}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 transition-all duration-1000"
                    style={{ width: `${Math.min(100, (embedTimeLeft / 300) * 100)}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Copyable URL */}
            <div className="space-y-2">
              <span className="text-xs text-slate-400">Direct Pairing Link (Copy to share via messaging/SMS):</span>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  readOnly
                  value={embedPairingUrl}
                  className="bg-slate-950 border border-slate-800 text-slate-300 text-xs px-3 py-2 rounded-xl flex-1 min-w-0 font-mono truncate focus:outline-hidden"
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(embedPairingUrl);
                    setEmbedCopied(true);
                    setTimeout(() => setEmbedCopied(false), 2000);
                  }}
                  className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center space-x-1.5 transition border border-slate-700 shrink-0 cursor-pointer"
                >
                  {embedCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{embedCopied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            {/* Regenerate Button */}
            <div className="pt-2 flex flex-col sm:flex-row gap-2">
              <button
                onClick={generateEmbedToken}
                disabled={embedLoading}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-indigo-600/20 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${embedLoading ? 'animate-spin' : ''}`} />
                <span>Generate New 5-Min Code</span>
              </button>
              {onSimulateDevicePair && embedToken && (
                <button
                  onClick={() => onSimulateDevicePair(embedToken)}
                  className="py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition border border-slate-700 cursor-pointer"
                >
                  Simulate Phone Pairing
                </button>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 4: LIVE SESSIONS */}
        {/* ============================================================ */}
        {activeTab === 'live' && (
          <div className="space-y-6 animate-fade-in">
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                    <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <span>Active Support Sessions</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Live WebRTC inspection streams currently in progress between your console and paired phones.
                  </p>
                </div>
                <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20 font-semibold">
                  {activeSessions.length} Active
                </span>
              </div>

              {activeSessions.length === 0 ? (
                <div className="py-12 text-center space-y-3">
                  <div className="w-14 h-14 bg-slate-800 text-slate-400 rounded-2xl mx-auto flex items-center justify-center">
                    <PhoneOff className="w-7 h-7" />
                  </div>
                  <h4 className="text-sm font-semibold text-white">No Live Sessions Active</h4>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto">
                    To start a live session, go to the Devices tab and click &quot;Turn On Camera&quot; next to any paired device.
                  </p>
                  <button
                    onClick={() => setActiveTab('devices')}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl inline-flex items-center space-x-2 transition cursor-pointer"
                  >
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>Go to Devices Directory</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {activeSessions.map((session) => {
                    const matchedDevice = devices.find((d) => d.deviceId === session.deviceId);
                    return (
                      <div
                        key={session.sessionId}
                        className="p-4 bg-slate-950 border border-emerald-500/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center space-x-2">
                            <span className="text-xs font-bold text-white">
                              {matchedDevice?.deviceName || 'Paired Device'}
                            </span>
                            <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-[10px] font-mono rounded-md font-semibold">
                              STREAMING
                            </span>
                          </div>
                          <p className="text-[11px] font-mono text-slate-400">ID: {session.sessionId}</p>
                          <p className="text-[11px] text-slate-500">
                            Started: {new Date(session.startedAt).toLocaleTimeString()}
                          </p>
                        </div>

                        <div className="flex items-center space-x-2">
                          <button
                            onClick={() => {
                              if (matchedDevice) {
                                setActiveLiveSession({ session, device: matchedDevice });
                              }
                            }}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 shadow-md shadow-emerald-600/20 transition cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>Open Stream Viewer</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 5: SESSION HISTORY */}
        {/* ============================================================ */}
        {activeTab === 'history' && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl animate-fade-in">
            <div className="px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-800 flex justify-between items-center gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">Remote Support Session History</h3>
                <p className="text-xs text-slate-400 hidden sm:block">Complete audit trail of all previous WebRTC support sessions</p>
              </div>
              <span className="text-xs text-slate-400 font-mono shrink-0">{sessionHistory.length} Recorded</span>
            </div>

            {sessionHistory.length === 0 ? (
              <div className="p-10 sm:p-12 text-center text-slate-400 text-xs">
                No past sessions recorded yet. Start a session from the Devices tab to inspect a phone.
              </div>
            ) : (
              <>
                {/* Mobile Card List */}
                <div className="md:hidden divide-y divide-slate-800">
                  {sessionHistory.map((s) => (
                    <div key={s.sessionId} className="p-4 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-indigo-400 text-[11px] truncate">
                          {s.sessionId.substring(0, 16)}...
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 ${
                            s.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : s.status === 'connecting'
                              ? 'bg-amber-500/10 text-amber-400'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          {s.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span className="font-mono truncate mr-2">{s.deviceId}</span>
                        <span className="shrink-0">{new Date(s.startedAt).toLocaleString()}</span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex space-x-1.5">
                          {s.requestCamera && (
                            <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                              Video
                            </span>
                          )}
                          {s.requestMicrophone && (
                            <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                              Audio
                            </span>
                          )}
                          {s.requestScreen && (
                            <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                              Screen
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-slate-400 truncate max-w-[190px]">
                          {s.terminationReason || s.endedBy || 'Normal completion'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop Table */}
                <div className="hidden md:block divide-y divide-slate-800 overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="px-5 py-3">Session ID</th>
                        <th className="px-5 py-3">Device ID</th>
                        <th className="px-5 py-3">Streams Requested</th>
                        <th className="px-5 py-3">Started</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Termination Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {sessionHistory.map((s) => (
                        <tr key={s.sessionId} className="hover:bg-slate-800/30 transition">
                          <td className="px-5 py-3.5 font-mono text-indigo-400 text-[11px]">
                            {s.sessionId.substring(0, 14)}...
                          </td>
                          <td className="px-5 py-3.5 font-mono text-slate-400 text-[11px]">{s.deviceId}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex space-x-1.5">
                              {s.requestCamera && (
                                <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                                  Video
                                </span>
                              )}
                              {s.requestMicrophone && (
                                <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                                  Audio
                                </span>
                              )}
                              {s.requestScreen && (
                                <span className="px-1.5 py-0.5 bg-indigo-500/10 text-indigo-400 rounded-md text-[10px]">
                                  Screen
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-slate-400 text-[11px]">
                            {new Date(s.startedAt).toLocaleString()}
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                s.status === 'active'
                                  ? 'bg-emerald-500/10 text-emerald-400'
                                  : s.status === 'connecting'
                                  ? 'bg-amber-500/10 text-amber-400'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {s.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-slate-400 text-[11px]">
                            {s.terminationReason || s.endedBy || 'Normal completion'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 6: SECURITY AUDIT */}
        {/* ============================================================ */}
        {activeTab === 'audit' && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl animate-fade-in">
            <div className="px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-800 flex justify-between items-center gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white">Cryptographic Security Audit Log</h3>
                <p className="text-xs text-slate-400 hidden sm:block">Immutable ledger of pairing, session, and administrative events</p>
              </div>
              <span className="text-xs text-slate-400 font-mono shrink-0">{auditLogs.length} Events</span>
            </div>

            {auditLogs.length === 0 ? (
              <div className="p-10 sm:p-12 text-center text-slate-400 text-xs">
                No audit events recorded yet.
              </div>
            ) : (
              <>
                {/* Mobile Audit Cards */}
                <div className="md:hidden divide-y divide-slate-800">
                  {auditLogs.map((log, idx) => (
                    <div key={log.id || idx} className="p-4 space-y-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 rounded-md font-mono text-[10px] font-semibold">
                          {log.eventType}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono shrink-0">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-300 leading-relaxed break-words">
                        {log.details || '—'}
                      </p>
                      <p className="text-[10px] font-mono text-slate-500 truncate">
                        Target: {log.deviceId || log.adminId || 'System'}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Desktop Table */}
                <div className="hidden md:block divide-y divide-slate-800 overflow-x-auto">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="px-5 py-3">Timestamp</th>
                        <th className="px-5 py-3">Event Type</th>
                        <th className="px-5 py-3">Device / Target</th>
                        <th className="px-5 py-3">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {auditLogs.map((log, idx) => (
                        <tr key={log.id || idx} className="hover:bg-slate-800/30 transition">
                          <td className="px-5 py-3.5 text-slate-400 font-mono text-[11px]">
                            {new Date(log.timestamp).toLocaleString()}
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 rounded-md font-mono text-[10px] font-semibold">
                              {log.eventType}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 font-mono text-slate-400 text-[11px]">
                            {log.deviceId || log.adminId || 'System'}
                          </td>
                          <td className="px-5 py-3.5 text-slate-300 text-[11px] max-w-md truncate">
                            {log.details || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 7: CONNECTION DIAGNOSTICS */}
        {/* ============================================================ */}
        {activeTab === 'diagnostics' && (
          <div className="space-y-6 animate-fade-in">
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center space-x-2">
                    <Activity className="w-4 h-4 text-indigo-400" />
                    <span>Connection & Browser Diagnostics</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Real-time verification of WebRTC APIs, media permissions, secure context, and STUN/TURN relays.
                  </p>
                </div>
                <button
                  onClick={runDiagnostics}
                  disabled={diagRunning}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center space-x-2 transition shadow-md shadow-indigo-600/20 shrink-0 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${diagRunning ? 'animate-spin' : ''}`} />
                  <span>Run Live Diagnostics</span>
                </button>
              </div>

              {/* Grid of Diagnostic Checks */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Secure Context */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Secure Context (HTTPS)</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        diagResults.secureContext
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      {diagResults.secureContext ? 'SECURE' : 'INSECURE'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Required for WebRTC, camera, microphone, and screen share access.
                  </p>
                </div>

                {/* RTCPeerConnection Support */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">WebRTC PeerConnection</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        diagResults.webrtcSupport
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      {diagResults.webrtcSupport ? 'SUPPORTED' : 'UNSUPPORTED'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">Native browser P2P video & audio streaming engine.</p>
                </div>

                {/* getUserMedia Camera Support */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">getUserMedia (Camera/Mic)</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        diagResults.getUserMedia
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                          : 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                      }`}
                    >
                      {diagResults.getUserMedia ? 'AVAILABLE' : 'UNAVAILABLE'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">Browser API for capturing video and microphone audio.</p>
                </div>

                {/* getDisplayMedia Screen Share Support */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">getDisplayMedia (Screen)</span>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        diagResults.getDisplayMedia
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {diagResults.getDisplayMedia ? 'AVAILABLE' : 'UNSUPPORTED'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">Enables high-definition remote screen mirroring.</p>
                </div>

                {/* Camera Permission State */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Camera Permission</span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 uppercase">
                      {diagResults.camPerm}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">Status reported by navigator.permissions query.</p>
                </div>

                {/* ICE Servers Count */}
                <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Active ICE Relays</span>
                    <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/20">
                      {diagResults.iceServersCount} SERVERS
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    STUN and TURN servers configured for cellular carrier traversal.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* TAB 8: SETTINGS */}
        {/* ============================================================ */}
        {activeTab === 'settings' && (
          <div className="space-y-6 animate-fade-in">
            {/* 1. Dedicated Low-Latency STUN / TURN Traversal & Live Tester */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-white">Dedicated TURN &amp; WebRTC Network Traversal</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Configure private TURN relays for near-zero cellular/strict-NAT latency and test live candidate gathering.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={iceTestRunning}
                  onClick={async () => {
                    setIceTestRunning(true);
                    try {
                      const res = await testIceConnectivity();
                      setIceTestResult(res);
                    } finally {
                      setIceTestRunning(false);
                    }
                  }}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shrink-0 shadow-md shadow-indigo-600/20"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${iceTestRunning ? 'animate-spin' : ''}`} />
                  <span>{iceTestRunning ? 'Probing Relays...' : 'Test STUN/TURN Live'}</span>
                </button>
              </div>

              {iceTestResult && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">Local Host</span>
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${iceTestResult.hasHost ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                      {iceTestResult.hasHost ? 'PASS' : 'NONE'}
                    </span>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">STUN (srflx)</span>
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${iceTestResult.hasSrflx ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                      {iceTestResult.hasSrflx ? 'PASS' : 'BLOCKED'}
                    </span>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">TURN (relay)</span>
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${iceTestResult.hasRelay ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}`}>
                      {iceTestResult.hasRelay ? 'PASS' : 'FAILED'}
                    </span>
                  </div>
                  <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">Probe Time</span>
                    <span className="text-[11px] font-mono font-bold text-indigo-300">
                      {iceTestResult.rttMs} ms
                    </span>
                  </div>
                </div>
              )}

              {/* Custom Browser TURN Relay Form (ideal for GitHub Pages or custom Coturn/Metered relays) */}
              <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Custom Dedicated TURN Relay (Client Override)</span>
                  <span className="text-[10px] text-slate-400 font-mono">Works on GitHub Pages &amp; Server</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                  <input
                    type="text"
                    placeholder="turn:relay.yourdomain.com:3478"
                    value={customTurnUrl}
                    onChange={(e) => setCustomTurnUrl(e.target.value)}
                    className="px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-slate-200 focus:border-indigo-500 focus:outline-hidden"
                  />
                  <input
                    type="text"
                    placeholder="TURN Username"
                    value={customTurnUser}
                    onChange={(e) => setCustomTurnUser(e.target.value)}
                    className="px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-slate-200 focus:border-indigo-500 focus:outline-hidden"
                  />
                  <input
                    type="password"
                    placeholder="TURN Password / Credential"
                    value={customTurnPass}
                    onChange={(e) => setCustomTurnPass(e.target.value)}
                    className="px-3 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs font-mono text-slate-200 focus:border-indigo-500 focus:outline-hidden"
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <p className="text-[11px] text-slate-400">
                    On backend hosts, set <code className="text-indigo-300">METERED_APP_NAME</code> + <code className="text-indigo-300">METERED_API_KEY</code> or <code className="text-indigo-300">TURN_URL</code> in env vars.
                  </p>
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={async () => {
                        setCustomTurnUrl('');
                        setCustomTurnUser('');
                        setCustomTurnPass('');
                        saveCustomIceServers([]);
                        setIceServers(await fetchIceServers());
                        setTurnSavedFeedback('Reset to default relays');
                        setTimeout(() => setTurnSavedFeedback(null), 2500);
                      }}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] rounded-lg transition cursor-pointer"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (customTurnUrl.trim()) {
                          saveCustomIceServers([
                            {
                              urls: customTurnUrl.trim(),
                              ...(customTurnUser.trim() ? { username: customTurnUser.trim() } : {}),
                              ...(customTurnPass.trim() ? { credential: customTurnPass.trim() } : {}),
                            },
                          ]);
                          setTurnSavedFeedback('Saved custom TURN relay');
                        } else {
                          saveCustomIceServers([]);
                          setTurnSavedFeedback('Saved default relays');
                        }
                        setIceServers(await fetchIceServers());
                        setTimeout(() => setTurnSavedFeedback(null), 2500);
                      }}
                      className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold rounded-lg transition cursor-pointer"
                    >
                      Save TURN Config
                    </button>
                  </div>
                </div>
                {turnSavedFeedback && (
                  <p className="text-[11px] text-emerald-400 font-medium">{turnSavedFeedback}</p>
                )}
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Active ICE Servers ({iceServers.length})
                </span>
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 sm:p-4 font-mono text-xs text-slate-300 space-y-2">
                  {iceServers.map((server, idx) => (
                    <div key={idx} className="p-2.5 bg-slate-900/80 rounded-lg flex flex-wrap sm:flex-nowrap items-center justify-between gap-2">
                      <span className="text-indigo-400 min-w-0 flex-1 break-all sm:truncate">
                        {Array.isArray(server.urls) ? server.urls.join(', ') : server.urls}
                      </span>
                      <span className="text-[10px] text-emerald-400 px-2 py-0.5 bg-emerald-500/10 rounded-md font-semibold shrink-0">
                        {server.urls.toString().includes('turn') ? 'TURN Relay' : 'STUN'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 2. Security Hardening & Anonymous Device UID Binding */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-white flex items-center space-x-2">
                  <Lock className="w-4 h-4 text-emerald-400" />
                  <span>Security Hardening: Anonymous Device Auth &amp; Hardened Rules</span>
                </h4>
                <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono rounded-md">
                  UID-Bound Rules Deployed
                </span>
              </div>
              <p className="text-slate-400 leading-relaxed text-[11px]">
                Paired phones sign in silently via Firebase Anonymous Authentication and lock their <code className="text-slate-200">deviceAuthUid</code> to their Firestore record so only that phone or your Admin account can modify its status or GPS history. Enable <strong className="text-slate-200">Anonymous</strong> inside <strong className="text-slate-200">Firebase Console &rarr; Authentication &rarr; Sign-in method</strong> to activate UID enforcement.
              </p>
            </div>

            {/* 3. Native Android APK Wrapper (Capacitor Foreground Service) */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-white flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-indigo-400" />
                  <span>Native Android APK Wrapper (Background Camera &amp; GPS)</span>
                </h4>
                <span className="px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-[10px] font-mono rounded-md">
                  Capacitor Template Included
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                Mobile Chrome enforces OS camera suspension when minimized. Package this app as a native Android APK with the included <code className="text-indigo-300">capacitor.config.json</code> and <code className="text-indigo-300">android-native-template/AndroidManifest.xml</code> foreground service permissions (<code className="text-slate-300">camera</code>, <code className="text-slate-300">microphone</code>, <code className="text-slate-300">location</code>) for true background streaming:
              </p>
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-[11px] text-emerald-300 space-y-1 overflow-x-auto">
                <div>npm install @capacitor/core @capacitor/cli @capacitor/android</div>
                <div>npm run build &amp;&amp; npx cap add android</div>
                <div>cp android-native-template/AndroidManifest.xml android/app/src/main/AndroidManifest.xml</div>
                <div>npx cap sync android &amp;&amp; npx cap open android</div>
              </div>
            </div>

            {/* 4. Privacy & Zero-Storage Architecture */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-3 text-xs">
              <h4 className="font-semibold text-white flex items-center space-x-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>Privacy &amp; Zero-Storage Architecture</span>
              </h4>
              <p className="text-slate-400 leading-relaxed text-[11px]">
                BeamPair transmits video, audio, and screen feeds directly between peers via end-to-end encrypted WebRTC channels (DTLS/SRTP). Recordings and snapshots are processed locally in your browser and never stored on cloud servers.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* QR Pairing Code Modal */}
      <PairingModal
        adminId={adminId}
        adminEmail={adminEmail}
        isOpen={isPairingModalOpen}
        onClose={() => setIsPairingModalOpen(false)}
        onSimulateDevicePair={onSimulateDevicePair}
      />

      {/* Admin Live WebRTC Stream Viewer Modal */}
      {activeLiveSession && (
        <AdminLiveStreamModal
          session={activeLiveSession.session}
          device={activeLiveSession.device}
          adminId={adminId}
          onClose={() => setActiveLiveSession(null)}
        />
      )}

      {/* Device Details Modal */}
      {deviceDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md max-h-[92dvh] shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-800 bg-slate-950/60 shrink-0">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">{deviceDetails.deviceName}</h3>
                  <p className="text-[11px] text-slate-400 font-mono truncate">{deviceDetails.deviceId}</p>
                </div>
              </div>
              <button
                onClick={() => setDeviceDetails(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg transition shrink-0 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-3 text-xs overflow-y-auto">
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Platform</span>
                <span className="text-slate-200 font-medium">{deviceDetails.platform.toUpperCase()}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Registration Status</span>
                <span className={deviceDetails.isRevoked ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                  {deviceDetails.isRevoked ? 'REVOKED' : 'ACTIVE'}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">First Paired</span>
                <span className="text-slate-200">{new Date(deviceDetails.pairedAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Last Seen</span>
                <span className="text-slate-200">
                  {deviceDetails.lastSeen ? new Date(deviceDetails.lastSeen).toLocaleTimeString() : 'Recent'}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Camera Permission</span>
                <span className="text-slate-200">{deviceDetails.cameraPermission || 'granted/prompt'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Microphone Permission</span>
                <span className="text-slate-200">{deviceDetails.microphonePermission || 'granted/prompt'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">Screen Sharing</span>
                <span className="text-slate-200">{deviceDetails.screenShareSupported ? 'Supported' : 'Available'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-800">
                <span className="text-slate-400">GPS Permission</span>
                <span className="text-slate-200">{deviceDetails.locationPermission || 'standby'}</span>
              </div>
              {deviceDetails.location && (
                <div className="p-3 bg-slate-950/80 border border-emerald-500/30 rounded-xl space-y-1">
                  <div className="flex items-center justify-between text-emerald-400 font-semibold">
                    <span className="flex items-center space-x-1">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>GPS Coordinates</span>
                    </span>
                    <span className="text-[10px] font-mono">±{Math.round(deviceDetails.location.accuracy || 5)}m</span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-300">
                    {deviceDetails.location.latitude.toFixed(6)}, {deviceDetails.location.longitude.toFixed(6)}
                  </p>
                  {deviceDetails.location.altitude != null && (
                    <p className="text-[10px] text-slate-400">
                      Alt: {Math.round(deviceDetails.location.altitude)}m • Speed: {deviceDetails.location.speed || 0} m/s
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-950/40 flex items-center space-x-2 shrink-0">
              <button
                onClick={() => {
                  const devId = deviceDetails.deviceId;
                  setDeviceDetails(null);
                  setSelectedDeviceIdForMap(devId);
                  setActiveTab('map');
                }}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <MapPin className="w-3.5 h-3.5" />
                <span>View on Map</span>
              </button>
              <button
                onClick={() => setDeviceDetails(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Device Modal */}
      {deviceToRename && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm shadow-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center space-x-2">
                <Edit2 className="w-4 h-4 text-indigo-400" />
                <span>Rename Paired Device</span>
              </h3>
              <button onClick={() => setDeviceToRename(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-slate-400">Device Name:</label>
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white focus:outline-hidden focus:border-indigo-500"
                placeholder="e.g. Work Samsung Galaxy S24"
              />
            </div>

            <div className="flex space-x-2 pt-2">
              <button
                onClick={handleRenameConfirm}
                disabled={renameLoading || !newDeviceName.trim()}
                className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                {renameLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Save Name</span>}
              </button>
              <button
                onClick={() => setDeviceToRename(null)}
                className="py-2 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-xl transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Revoke / Delete Confirmation Modal */}
      {deviceToManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md max-h-[92dvh] shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-2 px-4 py-3.5 sm:px-6 sm:py-4 border-b border-slate-800 bg-slate-950/60 shrink-0">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="p-2 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white truncate">Manage Device Access</h3>
                  <p className="text-xs text-slate-400 truncate">Revoke pairing or remove device</p>
                </div>
              </div>
              <button
                onClick={() => setDeviceToManage(null)}
                disabled={manageLoading}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg transition shrink-0 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-4 overflow-y-auto">
              <div className="p-3.5 bg-slate-950/70 border border-slate-800 rounded-xl space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-white truncate">{deviceToManage.deviceName}</span>
                  <span
                    className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                      deviceToManage.isRevoked
                        ? 'bg-rose-500/15 text-rose-400 border border-rose-500/20'
                        : deviceToManage.status === 'online'
                        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {deviceToManage.isRevoked ? 'REVOKED' : deviceToManage.status.toUpperCase()}
                  </span>
                </div>
                <p className="text-[11px] font-mono text-slate-400 truncate">ID: {deviceToManage.deviceId}</p>
                <p className="text-[11px] text-slate-500">Platform: {deviceToManage.platform.toUpperCase()}</p>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed">
                Choose an action for this device. <strong>Revoking</strong> disconnects any ongoing session and blocks future connection requests. <strong>Deleting</strong> completely erases the device record from your dashboard.
              </p>

              <div className="space-y-2 pt-2">
                {!deviceToManage.isRevoked && (
                  <button
                    onClick={handleRevokeConfirm}
                    disabled={manageLoading}
                    className="w-full py-2.5 bg-amber-600/90 hover:bg-amber-600 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shadow-md shadow-amber-600/20"
                  >
                    {manageLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        <Shield className="w-4 h-4" />
                        <span>Revoke Device Access</span>
                      </>
                    )}
                  </button>
                )}

                <button
                  onClick={handleDeleteConfirm}
                  disabled={manageLoading}
                  className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shadow-md shadow-rose-600/20"
                >
                  {manageLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      <span>Delete Device Permanently</span>
                    </>
                  )}
                </button>

                <button
                  onClick={() => setDeviceToManage(null)}
                  disabled={manageLoading}
                  className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
