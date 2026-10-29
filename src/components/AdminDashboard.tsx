import React, { useEffect, useState } from 'react';
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
} from 'lucide-react';
import { Device, Session, SecurityAuditLog } from '../types';
import { auth } from '../firebase/config';
import {
  listenToAdminDevices,
  revokeDeviceRegistration,
  listenToSessionHistory,
  listenToSecurityLogs,
} from '../services/deviceService';
import { PairingModal } from './PairingModal';
import { StartSessionModal } from './StartSessionModal';
import { AdminLiveStreamModal } from './AdminLiveStreamModal';

interface AdminDashboardProps {
  adminId: string;
  adminEmail: string;
  onSimulateDevicePair?: (token: string) => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminId,
  adminEmail,
  onSimulateDevicePair,
}) => {
  const [activeTab, setActiveTab] = useState<'devices' | 'history' | 'audit' | 'settings'>('devices');
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessionHistory, setSessionHistory] = useState<Session[]>([]);
  const [auditLogs, setAuditLogs] = useState<SecurityAuditLog[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Modals state
  const [isPairingModalOpen, setIsPairingModalOpen] = useState<boolean>(false);
  const [selectedDeviceForSession, setSelectedDeviceForSession] = useState<Device | null>(null);
  const [activeLiveSession, setActiveLiveSession] = useState<{
    session: Session;
    device: Device;
  } | null>(null);

  // STUN/TURN test state
  const [iceServers, setIceServers] = useState<any[]>([]);

  // Listen to Firestore real-time data only when auth is present
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

    // Fetch ICE servers for settings tab
    fetch('/api/webrtc/ice-servers')
      .then((res) => res.json())
      .then((data) => setIceServers(data.iceServers || []))
      .catch(console.warn);

    return () => {
      unsubDevices();
      unsubSessions();
      unsubAudit();
    };
  }, [adminId]);

  // Handle Revoke Device
  const handleRevokeDevice = async (device: Device) => {
    if (confirm(`Are you sure you want to revoke pairing for "${device.deviceName}"? This phone will immediately lose remote access.`)) {
      try {
        await revokeDeviceRegistration(adminId, device.deviceId);
      } catch (err) {
        console.error('Revoke error:', err);
      }
    }
  };

  const onlineDevicesCount = devices.filter((d) => d.status === 'online' && !d.isRevoked).length;
  const filteredDevices = devices.filter((d) =>
    d.deviceName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    d.deviceId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-8 max-w-7xl mx-auto w-full space-y-6">
      {/* Top Banner & Quick Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg flex items-center space-x-3.5">
          <div className="p-3 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl">
            <Smartphone className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-medium">Paired Devices</span>
            <h4 className="text-xl font-bold text-white">{devices.length}</h4>
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg flex items-center space-x-3.5">
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl">
            <Radio className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-medium">Online Devices</span>
            <div className="flex items-center space-x-2">
              <h4 className="text-xl font-bold text-emerald-400">{onlineDevicesCount}</h4>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            </div>
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg flex items-center space-x-3.5">
          <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-400 rounded-xl">
            <History className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-medium">Recorded Sessions</span>
            <h4 className="text-xl font-bold text-white">{sessionHistory.length}</h4>
          </div>
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-lg flex items-center space-x-3.5">
          <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-xl">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <span className="text-xs text-slate-400 font-medium">Security Audits</span>
            <h4 className="text-xl font-bold text-white">{auditLogs.length}</h4>
          </div>
        </div>
      </div>

      {/* Tabs and Actions Header */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        {/* Navigation Tabs */}
        <div className="flex space-x-1.5 p-1 bg-slate-900 border border-slate-800 rounded-xl">
          <button
            onClick={() => setActiveTab('devices')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'devices'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Paired Devices ({devices.length})
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Session History
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'audit'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Security Audit Logs
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition ${
              activeTab === 'settings'
                ? 'bg-indigo-600 text-white shadow-xs'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            STUN / TURN
          </button>
        </div>

        {/* Action Button */}
        <button
          onClick={() => setIsPairingModalOpen(true)}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/25 transition shrink-0"
        >
          <QrCode className="w-4 h-4" />
          <span>Generate Pairing QR</span>
        </button>
      </div>

      {/* TAB 1: PAIRED DEVICES */}
      {activeTab === 'devices' && (
        <div className="space-y-4">
          {/* Search bar */}
          <div className="relative max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search by device name or ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3.5 py-2 bg-slate-900/80 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-500 focus:outline-hidden focus:border-indigo-500"
            />
          </div>

          {filteredDevices.length === 0 ? (
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center flex flex-col items-center">
              <div className="w-16 h-16 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-2xl flex items-center justify-center mb-4">
                <QrCode className="w-8 h-8" />
              </div>
              <h3 className="text-base font-semibold text-white">No Registered Devices Yet</h3>
              <p className="text-xs text-slate-400 max-w-md mt-1 mb-6">
                Generate a single-use QR pairing code to register an Android smartphone. Once paired, you can start remote camera, audio, or screen support sessions at any time.
              </p>
              <button
                onClick={() => setIsPairingModalOpen(true)}
                className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-2 shadow-lg shadow-indigo-600/25 transition"
              >
                <QrCode className="w-4 h-4" />
                <span>Generate First Pairing QR</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredDevices.map((device) => {
                const isOnline = device.status === 'online' && !device.isRevoked;
                const pairedDateStr = new Date(device.pairedAt).toLocaleDateString();

                return (
                  <div
                    key={device.deviceId}
                    className={`bg-slate-900/90 border rounded-2xl p-5 shadow-xl flex flex-col justify-between transition ${
                      device.isRevoked
                        ? 'border-rose-900/40 opacity-70'
                        : 'border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div>
                      {/* Top status */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center space-x-3">
                          <div className={`p-2.5 rounded-xl ${
                            isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-800 text-slate-400'
                          }`}>
                            <Smartphone className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-white tracking-wide">{device.deviceName}</h4>
                            <span className="text-[11px] font-mono text-slate-400 truncate max-w-[170px] block">
                              {device.deviceId}
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

                      {/* Hardware Capabilities & Permissions */}
                      <div className="grid grid-cols-3 gap-1.5 py-3 border-y border-slate-800/80 my-3 text-[10px]">
                        <div className="flex items-center space-x-1 text-slate-400">
                          <Video className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Cam: <strong className="text-slate-300">{device.cameraPermission || 'prompt'}</strong></span>
                        </div>
                        <div className="flex items-center space-x-1 text-slate-400">
                          <Mic className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Mic: <strong className="text-slate-300">{device.microphonePermission || 'prompt'}</strong></span>
                        </div>
                        <div className="flex items-center space-x-1 text-slate-400">
                          <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Screen: <strong className="text-slate-300">{device.screenShareSupported ? 'Yes' : 'No'}</strong></span>
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-400 space-y-1 mb-4">
                        <div className="flex justify-between">
                          <span>Platform:</span>
                          <span className="text-slate-300 font-medium">{device.platform.toUpperCase()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Paired Date:</span>
                          <span className="text-slate-300">{pairedDateStr}</span>
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex space-x-2 pt-2">
                      <button
                        onClick={() => setSelectedDeviceForSession(device)}
                        disabled={device.isRevoked}
                        className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-1.5 shadow-md shadow-indigo-600/20 transition"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>Start Session</span>
                      </button>
                      <button
                        onClick={() => handleRevokeDevice(device)}
                        className="px-2.5 py-2 bg-slate-800 hover:bg-rose-950/40 border border-slate-700/60 hover:border-rose-800/50 text-slate-400 hover:text-rose-400 text-xs rounded-xl transition"
                        title="Revoke Device Access"
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

      {/* TAB 2: SESSION HISTORY */}
      {activeTab === 'history' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-white">Remote Support Session History</h3>
            <span className="text-xs text-slate-400 font-mono">{sessionHistory.length} Total Sessions</span>
          </div>
          {sessionHistory.length === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">
              No sessions recorded yet. Start a session from the Paired Devices tab.
            </div>
          ) : (
            <div className="divide-y divide-slate-800 overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider">
                  <tr>
                    <th className="px-5 py-3">Session ID</th>
                    <th className="px-5 py-3">Device ID</th>
                    <th className="px-5 py-3">Streams Requested</th>
                    <th className="px-5 py-3">Started</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Ended By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {sessionHistory.map((s) => (
                    <tr key={s.sessionId} className="hover:bg-slate-800/40 transition">
                      <td className="px-5 py-3.5 font-mono text-[11px] text-indigo-400">{s.sessionId}</td>
                      <td className="px-5 py-3.5 font-mono text-[11px] text-slate-400">{s.deviceId}</td>
                      <td className="px-5 py-3.5 text-slate-300">
                        {s.requestCamera && 'Camera '}
                        {s.requestMicrophone && 'Mic '}
                        {s.requestScreen && 'Screen'}
                      </td>
                      <td className="px-5 py-3.5 text-slate-400">
                        {new Date(s.startedAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          s.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : s.status === 'terminated'
                            ? 'bg-slate-800 text-slate-400'
                            : 'bg-amber-500/10 text-amber-400'
                        }`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-[11px] text-slate-400">
                        {s.endedBy || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: SECURITY AUDIT LOGS */}
      {activeTab === 'audit' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
          <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center">
            <div>
              <h3 className="text-sm font-semibold text-white">Security & Audit Compliance Trace</h3>
              <p className="text-xs text-slate-400">Immutable chronological record of administrative actions</p>
            </div>
            <span className="text-xs text-slate-400 font-mono">{auditLogs.length} Events</span>
          </div>

          <div className="divide-y divide-slate-800/80 max-h-[600px] overflow-y-auto">
            {auditLogs.map((log) => (
              <div key={log.id || String(log.timestamp)} className="p-4 hover:bg-slate-800/30 transition flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/25 text-indigo-300 font-mono text-[10px] rounded-md">
                      {log.eventType}
                    </span>
                    {log.deviceId && (
                      <span className="text-[11px] font-mono text-slate-400">
                        Device: {log.deviceId}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-200">{log.details}</p>
                </div>
                <span className="text-[11px] font-mono text-slate-500 whitespace-nowrap ml-4">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TAB 4: STUN / TURN CONFIG */}
      {activeTab === 'settings' && (
        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div>
            <h3 className="text-base font-semibold text-white">WebRTC Network Traversal & STUN/TURN</h3>
            <p className="text-xs text-slate-400 mt-1">
              Active ICE servers used for establishing P2P and TURN relay connectivity across cellular and restricted Wi-Fi networks.
            </p>
          </div>

          <div className="space-y-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Configured ICE Servers</span>
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 space-y-2">
              {iceServers.map((server, idx) => (
                <div key={idx} className="p-2 bg-slate-900/80 rounded-lg flex items-center justify-between">
                  <span className="text-indigo-400 truncate max-w-md">
                    {Array.isArray(server.urls) ? server.urls.join(', ') : server.urls}
                  </span>
                  <span className="text-[10px] text-emerald-400 px-2 py-0.5 bg-emerald-500/10 rounded-md">
                    {server.urls.toString().includes('turn') ? 'TURN Relay' : 'STUN'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-xs text-indigo-300 space-y-1">
            <p className="font-semibold flex items-center">
              <Server className="w-4 h-4 mr-1.5" />
              Dynamic Relay Traversal
            </p>
            <p className="text-[11px] text-indigo-200/80 leading-relaxed">
              When symmetric NATs prevent direct UDP peer-to-peer connections (common on 4G/5G mobile carriers), WebRTC automatically negotiates TURN relays configured on the trusted backend.
            </p>
          </div>
        </div>
      )}

      {/* QR Pairing Code Modal */}
      <PairingModal
        adminId={adminId}
        adminEmail={adminEmail}
        isOpen={isPairingModalOpen}
        onClose={() => setIsPairingModalOpen(false)}
        onSimulateDevicePair={onSimulateDevicePair}
      />

      {/* Session Request Configuration Modal */}
      {selectedDeviceForSession && (
        <StartSessionModal
          device={selectedDeviceForSession}
          adminId={adminId}
          isOpen={true}
          onClose={() => setSelectedDeviceForSession(null)}
          onSessionStarted={(newSession) => {
            setActiveLiveSession({
              session: newSession,
              device: selectedDeviceForSession,
            });
          }}
        />
      )}

      {/* Admin Live WebRTC Stream Viewer Modal */}
      {activeLiveSession && (
        <AdminLiveStreamModal
          session={activeLiveSession.session}
          device={activeLiveSession.device}
          adminId={adminId}
          onClose={() => setActiveLiveSession(null)}
        />
      )}
    </div>
  );
};
