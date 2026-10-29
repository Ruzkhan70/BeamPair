import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  Smartphone,
  Shield,
  Camera,
  Mic,
  Monitor,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  LogOut,
  PhoneCall,
  PhoneOff,
  Video,
  VideoOff,
  MicOff,
  Scan,
  Check,
  ChevronRight,
  Eye,
} from 'lucide-react';
import { Device, Session } from '../types';
import { WebRTCManager } from '../services/webrtc';
import {
  registerDeviceInFirestore,
  updateDeviceHeartbeat,
  listenToDevice,
} from '../services/deviceService';
import {
  listenToSession,
  setSessionAnswer,
  addSessionIceCandidate,
  listenToIceCandidates,
  terminateSession,
  recordSecurityAudit,
} from '../services/signaling';

interface SecondaryDeviceViewProps {
  initialToken?: string;
  onClearInitialToken?: () => void;
}

const STORAGE_KEY = 'beampair_device_registration';

export const SecondaryDeviceView: React.FC<SecondaryDeviceViewProps> = ({
  initialToken,
  onClearInitialToken,
}) => {
  // Device registration state
  const [device, setDevice] = useState<Device | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Pairing Flow states
  const [pairingTokenInput, setPairingTokenInput] = useState<string>(initialToken || '');
  const [isScanningQR, setIsScanningQR] = useState<boolean>(false);
  const [validationLoading, setValidationLoading] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validatedAdminInfo, setValidatedAdminInfo] = useState<{
    adminEmail: string;
    adminId: string;
    token: string;
  } | null>(null);
  const [customDeviceName, setCustomDeviceName] = useState<string>('Android Device');

  // Permission test states
  const [cameraState, setCameraState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  const [micState, setMicState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  const [screenSupported, setScreenSupported] = useState<boolean>(false);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);

  // Active Remote Session state
  const [incomingSession, setIncomingSession] = useState<Session | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [isConnectingMedia, setIsConnectingMedia] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [activeFacingMode, setActiveFacingMode] = useState<'user' | 'environment'>('environment');
  const [connectionStatusText, setConnectionStatusText] = useState<string>('Standby');

  // Preview elements
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerContainerId = 'qr-reader-container';
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const unsubscribeSessionRef = useRef<(() => void) | null>(null);
  const unsubscribeCandidatesRef = useRef<(() => void) | null>(null);

  // Detect platform and hardware capabilities
  useEffect(() => {
    setScreenSupported(typeof navigator.mediaDevices?.getDisplayMedia === 'function');

    // Auto-populate device name based on user agent
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) {
      setCustomDeviceName('Android Smartphone');
    } else if (/iPhone|iPad/i.test(ua)) {
      setCustomDeviceName('Apple iOS Device');
    } else {
      setCustomDeviceName('Remote Support Client');
    }

    // Check permissions if supported
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'camera' as PermissionName }).then((p) => {
        setCameraState(p.state as any);
        p.onchange = () => setCameraState(p.state as any);
      }).catch(() => {});

      navigator.permissions.query({ name: 'microphone' as PermissionName }).then((p) => {
        setMicState(p.state as any);
        p.onchange = () => setMicState(p.state as any);
      }).catch(() => {});
    }
  }, []);

  // If initial token passed from URL (?pair=TOKEN), automatically validate it
  useEffect(() => {
    if (initialToken && !device) {
      setPairingTokenInput(initialToken);
      validateToken(initialToken);
    }
  }, [initialToken]);

  // QR Camera Scanner using html5-qrcode
  const startQRScanner = async () => {
    setIsScanningQR(true);
    setValidationError(null);
    try {
      // Small timeout to allow container element to render
      setTimeout(async () => {
        const html5QrCode = new Html5Qrcode(scannerContainerId);
        qrScannerRef.current = html5QrCode;

        await html5QrCode.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 220, height: 220 },
          },
          (decodedText) => {
            // Found QR Code
            stopQRScanner();
            let tokenToUse = decodedText;
            if (decodedText.includes('?pair=')) {
              const urlParams = new URLSearchParams(decodedText.split('?')[1]);
              tokenToUse = urlParams.get('pair') || decodedText;
            }
            setPairingTokenInput(tokenToUse);
            validateToken(tokenToUse);
          },
          () => {
            // Ignore scan frames without QR
          }
        );
      }, 150);
    } catch (err: unknown) {
      console.error('Failed to start camera QR scanner:', err);
      setValidationError('Could not access camera for QR scanning. Please grant camera permission or enter token manually.');
      setIsScanningQR(false);
    }
  };

  const stopQRScanner = async () => {
    if (qrScannerRef.current) {
      try {
        await qrScannerRef.current.stop();
        qrScannerRef.current.clear();
      } catch (err) {
        console.warn('QR scanner stop error:', err);
      }
      qrScannerRef.current = null;
    }
    setIsScanningQR(false);
  };

  // Validate Pairing Token with Backend
  const validateToken = async (tokenString: string) => {
    const cleanToken = tokenString.trim();
    if (!cleanToken) {
      setValidationError('Please enter a valid pairing code');
      return;
    }

    setValidationLoading(true);
    setValidationError(null);
    try {
      const res = await fetch('/api/pairing/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleanToken }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Pairing token validation failed');
      }

      setValidatedAdminInfo({
        adminEmail: data.adminEmail,
        adminId: data.adminId,
        token: cleanToken,
      });
      if (onClearInitialToken) onClearInitialToken();
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : 'Invalid or expired pairing code');
      setValidatedAdminInfo(null);
    } finally {
      setValidationLoading(false);
    }
  };

  // Approve Pairing & Register Device
  const approvePairing = async () => {
    if (!validatedAdminInfo) return;
    setValidationLoading(true);
    setValidationError(null);

    const deviceId = `dev_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const platform = /Android/i.test(navigator.userAgent) ? 'android' : 'other';

    try {
      // 1. Redeem token atomically on trusted backend
      const res = await fetch('/api/pairing/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: validatedAdminInfo.token,
          deviceId,
          deviceName: customDeviceName,
          deviceModel: navigator.userAgent.slice(0, 80),
          platform,
        }),
      });

      const redeemData = await res.json();
      if (!res.ok) {
        throw new Error(redeemData.error || 'Redemption failed');
      }

      // 2. Register device record in Firestore
      const newDevice: Device = {
        deviceId,
        adminId: validatedAdminInfo.adminId,
        deviceName: customDeviceName,
        deviceModel: navigator.userAgent.slice(0, 80),
        platform,
        status: 'online',
        lastSeen: Date.now(),
        pairedAt: Date.now(),
        isRevoked: false,
        cameraPermission: cameraState,
        microphonePermission: micState,
        screenShareSupported: screenSupported,
      };

      await registerDeviceInFirestore(newDevice);

      // 3. Save locally for seamless reconnection without re-scanning QR
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newDevice));
      setDevice(newDevice);
      setValidatedAdminInfo(null);

      // Record audit
      await recordSecurityAudit({
        adminId: validatedAdminInfo.adminId,
        deviceId,
        eventType: 'DEVICE_REGISTERED',
        details: `Secondary phone "${customDeviceName}" successfully paired.`,
      });
    } catch (err: unknown) {
      setValidationError(err instanceof Error ? err.message : 'Failed to register paired device');
    } finally {
      setValidationLoading(false);
    }
  };

  // Unpair / Deregister
  const unpairDevice = async () => {
    if (device) {
      try {
        await updateDeviceHeartbeat(device.deviceId, { status: 'offline' });
      } catch {}
    }
    localStorage.removeItem(STORAGE_KEY);
    setDevice(null);
    setValidatedAdminInfo(null);
    setPairingTokenInput('');
  };

  // Real-time Heartbeat & Device Listener
  useEffect(() => {
    if (!device) return;

    // Send initial online heartbeat
    updateDeviceHeartbeat(device.deviceId, {
      status: 'online',
      cameraPermission: cameraState,
      microphonePermission: micState,
    });

    const interval = setInterval(() => {
      updateDeviceHeartbeat(device.deviceId, {
        status: 'online',
        cameraPermission: cameraState,
        microphonePermission: micState,
      });
    }, 12000);

    let unsubSessionFromDoc: (() => void) | null = null;

    // Listen to changes on our device document (e.g. if admin revokes us or initiates a session)
    const unsubDevice = listenToDevice(device.deviceId, (remoteDevice) => {
      if (!remoteDevice || remoteDevice.isRevoked) {
        alert('This device registration has been revoked by the administrator.');
        unpairDevice();
        return;
      }

      // Check if administrator has requested or started a session on this device
      if (remoteDevice.currentSessionId) {
        if (!unsubSessionFromDoc) {
          unsubSessionFromDoc = listenToSession(remoteDevice.currentSessionId, (session) => {
            if (session.status === 'requested') {
              setIncomingSession(session);
            } else if (session.status === 'active' || session.status === 'connecting') {
              setActiveSession(session);
            } else if (session.status === 'terminated') {
              handleSessionEndedLocally('Session ended by administrator');
            }
          });
        }
      } else {
        if (unsubSessionFromDoc) {
          unsubSessionFromDoc();
          unsubSessionFromDoc = null;
        }
        setIncomingSession(null);
        if (activeSession) {
          handleSessionEndedLocally('Session closed');
        }
      }
    });

    return () => {
      clearInterval(interval);
      unsubDevice();
      if (unsubSessionFromDoc) {
        unsubSessionFromDoc();
      }
    };
  }, [device]);

  // Teardown local media when session terminates
  const handleSessionEndedLocally = useCallback((reason: string) => {
    if (webrtcRef.current) {
      webrtcRef.current.close();
      webrtcRef.current = null;
    }
    if (unsubscribeSessionRef.current) {
      unsubscribeSessionRef.current();
      unsubscribeSessionRef.current = null;
    }
    if (unsubscribeCandidatesRef.current) {
      unsubscribeCandidatesRef.current();
      unsubscribeCandidatesRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setActiveSession(null);
    setIncomingSession(null);
    setIsConnectingMedia(false);
    setConnectionStatusText('Session ended: ' + reason);
  }, []);

  // Accept incoming support session and start authorized media capture
  const acceptSupportSession = async () => {
    if (!incomingSession || !device) return;
    setIsConnectingMedia(true);
    setConnectionStatusText('Initializing WebRTC media...');

    const session = incomingSession;
    setActiveSession(session);
    setIncomingSession(null);

    const webrtc = new WebRTCManager();
    webrtcRef.current = webrtc;

    try {
      await webrtc.init('device');

      // Bind ICE candidate handler to send to Firestore
      webrtc.onIceCandidate = (candidate) => {
        addSessionIceCandidate(session.sessionId, candidate, 'device');
      };

      webrtc.onConnectionStateChange = (state) => {
        setConnectionStatusText(`WebRTC: ${state}`);
        if (state === 'failed' || state === 'closed' || state === 'disconnected') {
          console.warn('WebRTC state change:', state);
        }
      };

      webrtc.onScreenShareEnded = () => {
        setPermissionNotice('Screen capture stopped via browser/OS controls.');
      };

      // 1. Capture authorized Camera
      if (session.requestCamera !== false) {
        try {
          const facing = session.cameraFacing || 'environment';
          setActiveFacingMode(facing);
          await webrtc.startCamera(facing);
          setCameraState('granted');
        } catch (camErr) {
          console.error('Camera capture error:', camErr);
          setCameraState('denied');
          setPermissionNotice('Camera permission was denied. You can re-request or use screen sharing.');
        }
      }

      // 2. Capture authorized Microphone
      if (session.requestMicrophone) {
        try {
          await webrtc.startMicrophone();
          setMicState('granted');
        } catch (micErr) {
          console.error('Microphone capture error:', micErr);
          setMicState('denied');
        }
      }

      // 3. Screen sharing if explicitly requested
      if (session.requestScreen) {
        try {
          await webrtc.startScreenShare();
        } catch (scrErr) {
          console.warn('Screen share canceled or failed:', scrErr);
        }
      }

      // Show local preview in UI
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtc.localStream;
      }

      // Listen for ICE candidates from Admin
      unsubscribeCandidatesRef.current = listenToIceCandidates(
        session.sessionId,
        'device',
        (candidate) => {
          webrtc.addIceCandidate(candidate);
        }
      );

      // Listen to Session document for Admin's SDP Offer
      unsubscribeSessionRef.current = listenToSession(session.sessionId, async (updatedSession) => {
        if (updatedSession.status === 'terminated') {
          handleSessionEndedLocally(updatedSession.terminationReason || 'Admin terminated session');
          return;
        }

        // When Admin writes SDP Offer, set remote description and respond with SDP Answer!
        if (updatedSession.sdpOffer && !webrtc.peerConnection?.remoteDescription) {
          try {
            await webrtc.setRemoteDescription({
              type: 'offer',
              sdp: updatedSession.sdpOffer,
            });

            const answer = await webrtc.createAnswer();
            if (answer.sdp) {
              await setSessionAnswer(session.sessionId, answer.sdp);
              setConnectionStatusText('WebRTC Active & Streaming');
            }
          } catch (sdpErr) {
            console.error('Error handling SDP offer/answer:', sdpErr);
          }
        }
      });
    } catch (err: unknown) {
      console.error('Session media initiation failed:', err);
      setConnectionStatusText('Media start failed');
      handleSessionEndedLocally(err instanceof Error ? err.message : 'Media error');
    } finally {
      setIsConnectingMedia(false);
    }
  };

  // Flip Camera between user (front) and environment (back)
  const toggleCameraFacing = async () => {
    if (!webrtcRef.current) return;
    const nextFacing = activeFacingMode === 'environment' ? 'user' : 'environment';
    try {
      await webrtcRef.current.startCamera(nextFacing);
      setActiveFacingMode(nextFacing);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
      }
    } catch (err) {
      console.error('Failed to flip camera:', err);
    }
  };

  // Toggle Mute Audio
  const toggleAudioMute = () => {
    if (!webrtcRef.current) return;
    const newMuted = !isMuted;
    webrtcRef.current.setAudioMuted(newMuted);
    setIsMuted(newMuted);
  };

  // Start Screen Share on demand
  const triggerScreenShare = async () => {
    if (!webrtcRef.current) return;
    try {
      await webrtcRef.current.startScreenShare();
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
      }
      setPermissionNotice(null);
    } catch (err: unknown) {
      console.warn('Screen share start failed:', err);
      setPermissionNotice('Screen sharing could not be started.');
    }
  };

  // Secondary device ends session
  const endActiveSession = async () => {
    if (activeSession) {
      try {
        await terminateSession(activeSession.sessionId, 'device', 'Ended by secondary phone user');
        if (device) {
          await updateDeviceHeartbeat(device.deviceId, { currentSessionId: null });
        }
      } catch (err) {
        console.warn('Termination write warning:', err);
      }
    }
    handleSessionEndedLocally('Ended by user');
  };

  // Quick Hardware Permissions Test
  const testCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      setCameraState('granted');
      setPermissionNotice('Camera permission verified successfully.');
    } catch {
      setCameraState('denied');
      setPermissionNotice('Camera access denied. Please enable camera in your browser site permissions.');
    }
  };

  const testMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicState('granted');
      setPermissionNotice('Microphone permission verified successfully.');
    } catch {
      setMicState('denied');
      setPermissionNotice('Microphone access denied. Please enable microphone in your browser settings.');
    }
  };

  return (
    <div className="w-full max-w-md mx-auto p-4 flex flex-col space-y-4">
      {/* Privacy Notice Banner */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl">
        <div className="flex items-center space-x-2 text-indigo-400 mb-1">
          <Smartphone className="w-5 h-5" />
          <h2 className="text-sm font-semibold tracking-wide uppercase">Secondary Phone Client</h2>
        </div>
        <p className="text-xs text-slate-400">
          Android remote support endpoint. No hidden capture: all camera, microphone, and screen access requires your active consent.
        </p>
      </div>

      {/* STATE 1: Unpaired -> Scan QR or Enter Code */}
      {!device && !validatedAdminInfo && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl flex flex-col space-y-4">
          <div className="text-center">
            <div className="w-12 h-12 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-2xl mx-auto flex items-center justify-center mb-3">
              <Scan className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-white">Pair with Administrator</h3>
            <p className="text-xs text-slate-400 mt-1">
              Scan the QR code displayed on the Admin Dashboard or enter the token.
            </p>
          </div>

          {/* QR Scanner Container */}
          {isScanningQR ? (
            <div className="flex flex-col items-center w-full">
              <div className="relative w-full max-w-xs overflow-hidden rounded-2xl border-2 border-indigo-500/70 bg-slate-950 shadow-inner min-h-[220px] flex items-center justify-center">
                <div
                  id={scannerContainerId}
                  className="w-full h-full min-h-[220px]"
                />
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 backdrop-blur-xs rounded text-[10px] text-slate-300 pointer-events-none">
                  Align camera with Admin QR code
                </div>
              </div>
              <button
                onClick={stopQRScanner}
                className="mt-3 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition cursor-pointer"
              >
                Cancel Camera Scan
              </button>
            </div>
          ) : (
            <button
              onClick={startQRScanner}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center space-x-2 shadow-lg shadow-indigo-600/20 transition cursor-pointer"
            >
              <Camera className="w-4 h-4" />
              <span>Scan QR with Camera</span>
            </button>
          )}

          <div className="flex items-center my-1">
            <div className="flex-1 border-t border-slate-800" />
            <span className="px-3 text-[10px] text-slate-500 uppercase tracking-wider">or enter pairing code</span>
            <div className="flex-1 border-t border-slate-800" />
          </div>

          {/* Manual Entry */}
          <div className="space-y-2">
            <div className="flex space-x-2">
              <input
                type="text"
                placeholder="Paste 48-char pairing token..."
                value={pairingTokenInput}
                onChange={(e) => setPairingTokenInput(e.target.value)}
                className="flex-1 px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-xs font-mono focus:border-indigo-500 focus:outline-hidden transition"
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                      let t = text.trim();
                      if (t.includes('?pair=')) {
                        const urlParams = new URLSearchParams(t.split('?')[1]);
                        t = urlParams.get('pair') || t;
                      }
                      setPairingTokenInput(t);
                      validateToken(t);
                    }
                  } catch {
                    // clipboard read permission may be restricted
                  }
                }}
                className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-xl border border-slate-700 transition cursor-pointer shrink-0"
                title="Paste from Clipboard"
              >
                Paste
              </button>
            </div>

            <button
              onClick={() => validateToken(pairingTokenInput)}
              disabled={validationLoading || !pairingTokenInput.trim()}
              className="w-full py-2.5 bg-indigo-600/90 hover:bg-indigo-600 disabled:opacity-50 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer shadow-md shadow-indigo-600/15"
            >
              {validationLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>Validate & Pair</span>
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>

          {validationError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start space-x-2 text-rose-300 text-xs">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{validationError}</span>
            </div>
          )}
        </div>
      )}

      {/* STATE 2: Pairing Approval Screen */}
      {!device && validatedAdminInfo && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl flex flex-col space-y-4 animate-fade-in">
          <div className="text-center">
            <div className="w-12 h-12 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-2xl mx-auto flex items-center justify-center mb-3">
              <Shield className="w-6 h-6" />
            </div>
            <h3 className="text-base font-semibold text-white">Approve Device Pairing</h3>
            <p className="text-xs text-slate-400 mt-1">
              Verify administrator identity before authorizing pairing.
            </p>
          </div>

          <div className="p-3 bg-slate-950/70 border border-slate-800 rounded-xl space-y-2 text-xs">
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Admin Email:</span>
              <span className="text-emerald-400 font-medium font-mono">{validatedAdminInfo.adminEmail}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400">Admin ID:</span>
              <span className="text-slate-300 font-mono text-[11px] truncate max-w-[180px]">{validatedAdminInfo.adminId}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-slate-300 font-medium">Device Name for Admin Dashboard</label>
            <input
              type="text"
              value={customDeviceName}
              onChange={(e) => setCustomDeviceName(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-xs focus:border-indigo-500 focus:outline-hidden"
              placeholder="e.g. Samsung Galaxy S24"
            />
          </div>

          <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs space-y-1">
            <p className="font-semibold flex items-center">
              <AlertTriangle className="w-3.5 h-3.5 mr-1 text-amber-400" />
              Authorization Separation
            </p>
            <p className="text-[11px] text-amber-200/80 leading-relaxed">
              Pairing authorizes this phone to receive support requests. Media capture (camera/mic/screen) requires individual consent for each session.
            </p>
          </div>

          <div className="flex space-x-2 pt-2">
            <button
              onClick={() => setValidatedAdminInfo(null)}
              className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-xl transition"
            >
              Cancel
            </button>
            <button
              onClick={approvePairing}
              disabled={validationLoading}
              className="flex-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 shadow-lg shadow-emerald-600/20 transition"
            >
              {validationLoading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>Approve & Pair Phone</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* STATE 3 & 4: Registered Device Standby & Incoming Call Modal */}
      {device && (
        <div className="space-y-4">
          {/* Incoming Session Prompt Modal */}
          {incomingSession && (
            <div className="p-5 bg-gradient-to-br from-indigo-950/90 to-slate-900 border-2 border-indigo-500 rounded-2xl shadow-2xl animate-bounce-subtle">
              <div className="flex items-center space-x-3 mb-3">
                <div className="p-2.5 bg-indigo-500 text-white rounded-xl animate-pulse">
                  <PhoneCall className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Incoming Remote Support Request</h4>
                  <p className="text-xs text-indigo-300">Administrator is requesting live media access</p>
                </div>
              </div>

              <div className="bg-slate-950/70 p-3 rounded-xl border border-indigo-500/30 text-xs space-y-1.5 mb-4">
                <p className="text-slate-300 font-medium">Requested Capabilities:</p>
                <div className="flex items-center space-x-4 text-slate-400 text-[11px]">
                  <span className="flex items-center">
                    <Camera className="w-3.5 h-3.5 mr-1 text-indigo-400" />
                    Camera ({incomingSession.cameraFacing || 'environment'})
                  </span>
                  <span className="flex items-center">
                    <Mic className="w-3.5 h-3.5 mr-1 text-indigo-400" />
                    Microphone
                  </span>
                  {incomingSession.requestScreen && (
                    <span className="flex items-center">
                      <Monitor className="w-3.5 h-3.5 mr-1 text-indigo-400" />
                      Screen
                    </span>
                  )}
                </div>
              </div>

              <div className="flex space-x-2">
                <button
                  onClick={() => terminateSession(incomingSession.sessionId, 'device', 'Declined by user')}
                  className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-rose-400 text-xs font-semibold rounded-xl transition flex items-center justify-center space-x-1"
                >
                  <PhoneOff className="w-4 h-4" />
                  <span>Decline</span>
                </button>
                <button
                  onClick={acceptSupportSession}
                  disabled={isConnectingMedia}
                  className="flex-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition shadow-lg shadow-emerald-600/25 flex items-center justify-center space-x-1"
                >
                  {isConnectingMedia ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      <span>Accept & Stream</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ACTIVE STREAMING HUD */}
          {activeSession && (
            <div className="bg-slate-900 border-2 border-rose-500/60 rounded-2xl p-4 shadow-2xl flex flex-col space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="w-3 h-3 bg-rose-500 rounded-full animate-ping" />
                  <span className="text-xs font-bold text-rose-400 uppercase tracking-wider">Live Support Active</span>
                </div>
                <span className="text-[11px] font-mono text-slate-400">{connectionStatusText}</span>
              </div>

              {/* Local Video Preview */}
              <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 backdrop-blur-xs rounded-md text-[10px] text-slate-300 flex items-center space-x-1">
                  <Eye className="w-3 h-3 text-indigo-400" />
                  <span>Your Live Broadcast Preview</span>
                </div>
              </div>

              {/* In-Session Controls */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={toggleCameraFacing}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl flex flex-col items-center justify-center space-y-1 transition"
                  title="Flip between front and rear camera"
                >
                  <RefreshCw className="w-4 h-4 text-indigo-400" />
                  <span className="text-[10px]">Flip Camera</span>
                </button>

                <button
                  onClick={toggleAudioMute}
                  className={`py-2.5 rounded-xl text-xs font-medium flex flex-col items-center justify-center space-y-1 transition ${
                    isMuted ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-slate-800 text-slate-200'
                  }`}
                >
                  {isMuted ? <MicOff className="w-4 h-4 text-rose-400" /> : <Mic className="w-4 h-4 text-emerald-400" />}
                  <span className="text-[10px]">{isMuted ? 'Muted' : 'Mute Mic'}</span>
                </button>

                {screenSupported && (
                  <button
                    onClick={triggerScreenShare}
                    className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl flex flex-col items-center justify-center space-y-1 transition"
                  >
                    <Monitor className="w-4 h-4 text-indigo-400" />
                    <span className="text-[10px]">Share Screen</span>
                  </button>
                )}
              </div>

              <button
                onClick={endActiveSession}
                className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl flex items-center justify-center space-x-2 transition shadow-lg shadow-rose-600/20"
              >
                <PhoneOff className="w-4 h-4" />
                <span>End Remote Support</span>
              </button>
            </div>
          )}

          {/* Device Info & Permissions Hub */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-sm font-semibold text-white">{device.deviceName}</h3>
                <p className="text-[11px] text-slate-400 font-mono">ID: {device.deviceId}</p>
              </div>
              <div className="flex items-center space-x-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">Registered</span>
              </div>
            </div>

            {/* Hardware Permissions Status */}
            <div className="space-y-2">
              <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Browser Permissions</span>
              
              <div className="flex items-center justify-between p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                <div className="flex items-center space-x-2.5">
                  <Camera className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs text-slate-300">Camera</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className={`text-[11px] font-medium ${
                    cameraState === 'granted' ? 'text-emerald-400' : 'text-slate-400'
                  }`}>
                    {cameraState}
                  </span>
                  <button
                    onClick={testCamera}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 rounded-md transition"
                  >
                    Test
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                <div className="flex items-center space-x-2.5">
                  <Mic className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs text-slate-300">Microphone</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className={`text-[11px] font-medium ${
                    micState === 'granted' ? 'text-emerald-400' : 'text-slate-400'
                  }`}>
                    {micState}
                  </span>
                  <button
                    onClick={testMicrophone}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 rounded-md transition"
                  >
                    Test
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
                <div className="flex items-center space-x-2.5">
                  <Monitor className="w-4 h-4 text-indigo-400" />
                  <span className="text-xs text-slate-300">Screen Sharing</span>
                </div>
                <span className={`text-[11px] font-medium ${
                  screenSupported ? 'text-emerald-400' : 'text-amber-400'
                }`}>
                  {screenSupported ? 'Supported' : 'Limited in this browser'}
                </span>
              </div>
            </div>

            {permissionNotice && (
              <div className="p-3 bg-slate-950 border border-indigo-500/30 rounded-xl text-xs text-slate-300">
                {permissionNotice}
              </div>
            )}

            {/* Unpair action */}
            <div className="pt-2">
              <button
                onClick={unpairDevice}
                className="w-full py-2 bg-slate-950 hover:bg-rose-950/30 border border-slate-800 hover:border-rose-800/50 text-slate-400 hover:text-rose-400 text-xs font-medium rounded-xl flex items-center justify-center space-x-1.5 transition"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Unpair This Device</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
