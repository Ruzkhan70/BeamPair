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
  PhoneCall,
  PhoneOff,
  Video,
  VideoOff,
  MicOff,
  Scan,
  Check,
  ChevronRight,
  Eye,
  Zap,
  PictureInPicture,
  Sparkles,
  MapPin,
  Crosshair,
  Moon,
} from 'lucide-react';
import { Device, Session, DeviceLocation } from '../types';
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
  updateSessionLiveFrame,
  updateSessionRemoteState,
} from '../services/signaling';
import { validatePairingToken, redeemPairingToken } from '../services/pairingService';

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

  // Permission test & persistent memory states
  const [cameraState, setCameraState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  const [micState, setMicState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
  const [screenSupported, setScreenSupported] = useState<boolean>(false);
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null);
  const [locationState, setLocationState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('prompt');
  const [currentLocation, setCurrentLocation] = useState<DeviceLocation | null>(null);
  const locationWatchIdRef = useRef<number | null>(null);
  const [locationHelpNotice, setLocationHelpNotice] = useState<string | null>(null);
  const [autoBroadcastEnabled, setAutoBroadcastEnabled] = useState<boolean>(() => {
    return localStorage.getItem('beampair_auto_broadcast') === 'true';
  });

  // Active Remote Session state
  const [incomingSession, setIncomingSession] = useState<Session | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [isConnectingMedia, setIsConnectingMedia] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isPipActive, setIsPipActive] = useState<boolean>(false);
  const [isBlackoutMode, setIsBlackoutMode] = useState<boolean>(false);
  const [activeFacingMode, setActiveFacingMode] = useState<'user' | 'environment'>('environment');
  const [connectionStatusText, setConnectionStatusText] = useState<string>('Standby');

  // Preview elements & signaling refs
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerContainerId = 'qr-reader-container';
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const unsubscribeSessionRef = useRef<(() => void) | null>(null);
  const unsubscribeCandidatesRef = useRef<(() => void) | null>(null);
  const activeSessionRef = useRef<Session | null>(null);
  activeSessionRef.current = activeSession;
  const activeFacingModeRef = useRef<'user' | 'environment'>(activeFacingMode);
  activeFacingModeRef.current = activeFacingMode;
  const isScreenSharingRef = useRef<boolean>(isScreenSharing);
  isScreenSharingRef.current = isScreenSharing;
  const currentLocationRef = useRef<DeviceLocation | null>(null);
  currentLocationRef.current = currentLocation;
  const cameraStateRef = useRef(cameraState);
  cameraStateRef.current = cameraState;
  const micStateRef = useRef(micState);
  micStateRef.current = micState;
  const locationStateRef = useRef(locationState);
  locationStateRef.current = locationState;
  const lastLocationPingHandledRef = useRef<number>(0);
  const isWebRtcConnectedRef = useRef<boolean>(false);
  const lastHandledOfferSdpRef = useRef<string | null>(null);
  const startedSessionIdRef = useRef<string | null>(null);

  // Background / Middle Button Keep-Alive & Auto Camera Resume when unlocking screen
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'hidden') {
        // User clicked middle/home button or switched apps
        webrtcRef.current?.startKeepAliveAudio();
        if (
          localVideoRef.current &&
          document.pictureInPictureEnabled &&
          !document.pictureInPictureElement
        ) {
          localVideoRef.current.requestPictureInPicture().catch(() => {});
        }
      } else if (document.visibilityState === 'visible') {
        webrtcRef.current?.requestWakeLock();
        webrtcRef.current?.startKeepAliveAudio();

        // If Android OS paused/ended the camera track while screen was physically locked, hot-restore it immediately
        if (activeSessionRef.current && webrtcRef.current && !isScreenSharingRef.current) {
          const track = webrtcRef.current.getActiveVideoTrack();
          if (!track || track.readyState === 'ended' || track.muted) {
            try {
              await new Promise((r) => setTimeout(r, 250));
              await webrtcRef.current.startCamera(activeFacingModeRef.current);
              if (localVideoRef.current) {
                localVideoRef.current.srcObject = webrtcRef.current.localStream;
                localVideoRef.current.play().catch(() => {});
                webrtcRef.current.enableAutoPiP(localVideoRef.current, setIsPipActive);
              }
            } catch (err) {
              console.warn('Auto camera resume note:', err);
            }
          } else if (localVideoRef.current && localVideoRef.current.paused) {
            localVideoRef.current.play().catch(console.warn);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Detect platform and hardware capabilities
  useEffect(() => {
    setScreenSupported(typeof navigator.mediaDevices?.getDisplayMedia === 'function');

    // Auto-populate device name based on Android device brand and user agent
    const ua = navigator.userAgent;
    if (/Samsung|SM-|Galaxy/i.test(ua)) {
      setCustomDeviceName('Samsung Galaxy Phone');
    } else if (/Pixel/i.test(ua)) {
      setCustomDeviceName('Google Pixel Phone');
    } else if (/Xiaomi|Redmi|POCO/i.test(ua)) {
      setCustomDeviceName('Xiaomi / Redmi Phone');
    } else if (/OnePlus/i.test(ua)) {
      setCustomDeviceName('OnePlus Phone');
    } else if (/Moto|Motorola/i.test(ua)) {
      setCustomDeviceName('Motorola Phone');
    } else if (/Oppo|Realme/i.test(ua)) {
      setCustomDeviceName('Oppo / Realme Phone');
    } else if (/Vivo|iQOO/i.test(ua)) {
      setCustomDeviceName('Vivo Phone');
    } else if (/Android/i.test(ua)) {
      setCustomDeviceName('Android Smartphone');
    } else if (/iPhone|iPad/i.test(ua)) {
      setCustomDeviceName('Apple iOS Device');
    } else {
      setCustomDeviceName('Android Support Client');
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

      navigator.permissions.query({ name: 'geolocation' as PermissionName }).then((p) => {
        setLocationState(p.state as any);
        p.onchange = () => setLocationState(p.state as any);
      }).catch(() => {});
    }

    return () => {
      if (locationWatchIdRef.current !== null && 'geolocation' in navigator) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
        locationWatchIdRef.current = null;
      }
    };
  }, []);

  // Precise Geolocation Capture with automatic Wi-Fi/Network fallback & OS-toggle retry
  const requestLocationAccess = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setLocationState('denied');
      setLocationHelpNotice('Geolocation is not supported by this browser.');
      return;
    }

    const handlePositionSuccess = (pos: GeolocationPosition) => {
      setLocationState('granted');
      setLocationHelpNotice(null);
      const loc: DeviceLocation = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy),
        altitude: pos.coords.altitude,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
        timestamp: pos.timestamp || Date.now(),
      };
      setCurrentLocation(loc);
      currentLocationRef.current = loc;
      if (device) {
        updateDeviceHeartbeat(device.deviceId, {
          location: loc,
          locationPermission: 'granted',
        });
      }
    };

    navigator.geolocation.getCurrentPosition(
      handlePositionSuccess,
      (err) => {
        if (err.code === 1) {
          setLocationState('denied');
          setLocationHelpNotice('Location permission is blocked in browser site settings.');
          return;
        }
        // Fallback to balanced/network accuracy (Wi-Fi/Cell) if high-accuracy GPS isn't available yet
        navigator.geolocation.getCurrentPosition(
          handlePositionSuccess,
          (fallbackErr) => {
            if (fallbackErr.code === 1) {
              setLocationState('denied');
              setLocationHelpNotice('Location permission is blocked in browser site settings.');
            } else {
              setLocationState('prompt');
              setLocationHelpNotice(
                'Phone Location service appears OFF in Android settings. Turn on Location in Quick Settings — BeamPair will lock on automatically.'
              );
            }
          },
          { enableHighAccuracy: false, timeout: 12000, maximumAge: 30000 }
        );
      },
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 }
    );

    // Watch position in real time
    if (locationWatchIdRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchIdRef.current);
    }
    locationWatchIdRef.current = navigator.geolocation.watchPosition(
      handlePositionSuccess,
      (err) => {
        if (err.code === 1) {
          setLocationState('denied');
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  }, [device]);

  // Automatically start and retry GPS acquisition when paired (also picks up Android Location toggle when app returns to focus)
  useEffect(() => {
    if (!device?.deviceId || locationState === 'denied') return;

    requestLocationAccess();

    const retryInterval = setInterval(() => {
      if (!currentLocationRef.current && locationStateRef.current !== 'denied') {
        requestLocationAccess();
      }
    }, 12000);

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible' && !currentLocationRef.current && locationStateRef.current !== 'denied') {
        requestLocationAccess();
      }
    };
    document.addEventListener('visibilitychange', onFocusOrVisible);

    return () => {
      clearInterval(retryInterval);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [device?.deviceId, locationState, requestLocationAccess]);

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
      const data = await validatePairingToken(cleanToken);

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

  // Approve Pairing & Register Device (requests camera/mic once inside tap gesture so Turn On Camera works immediately)
  const approvePairing = async () => {
    if (!validatedAdminInfo) return;
    setValidationLoading(true);
    setValidationError(null);

    let grantedCam = cameraState;
    let grantedMic = micState;
    try {
      const testStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      testStream.getTracks().forEach((t) => t.stop());
      grantedCam = 'granted';
      grantedMic = 'granted';
      setCameraState('granted');
      setMicState('granted');
      localStorage.setItem('beampair_permissions_granted', 'true');
      localStorage.setItem('beampair_auto_broadcast', 'true');
      setAutoBroadcastEnabled(true);
    } catch {
      try {
        const camOnly = await navigator.mediaDevices.getUserMedia({ video: true });
        camOnly.getTracks().forEach((t) => t.stop());
        grantedCam = 'granted';
        setCameraState('granted');
        localStorage.setItem('beampair_permissions_granted', 'true');
        localStorage.setItem('beampair_auto_broadcast', 'true');
        setAutoBroadcastEnabled(true);
      } catch {
        // User can still grant when tapping Accept & Stream
      }
    }

    const deviceId = `dev_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const platform = /Android/i.test(navigator.userAgent) ? 'android' : 'other';

    try {
      // 1. Redeem token atomically in Firestore
      await redeemPairingToken({
        token: validatedAdminInfo.token,
        deviceId,
        deviceName: customDeviceName,
        deviceModel: navigator.userAgent.slice(0, 80),
        platform,
      });

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
        cameraPermission: grantedCam,
        microphonePermission: grantedMic,
        locationPermission: locationState,
        ...(currentLocation ? { location: currentLocation } : {}),
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
      cameraPermission: cameraStateRef.current,
      microphonePermission: micStateRef.current,
      locationPermission: locationStateRef.current,
      ...(currentLocationRef.current ? { location: currentLocationRef.current } : {}),
    });

    const interval = setInterval(() => {
      updateDeviceHeartbeat(device.deviceId, {
        status: 'online',
        cameraPermission: cameraStateRef.current,
        microphonePermission: micStateRef.current,
        locationPermission: locationStateRef.current,
        ...(currentLocationRef.current ? { location: currentLocationRef.current } : {}),
      });
    }, 12000);

    let unsubSessionFromDoc: (() => void) | null = null;
    let subscribedSessionId: string | null = null;

    // Listen to changes on our device document (e.g. if admin revokes us, requests GPS ping, or initiates a session)
    const unsubDevice = listenToDevice(device.deviceId, (remoteDevice) => {
      if (!remoteDevice || remoteDevice.isRevoked) {
        setPermissionNotice('This device registration has been revoked by the administrator.');
        unpairDevice();
        return;
      }

      // Respond immediately to out-of-session Admin GPS ping requests
      if (
        remoteDevice.locationPingRequestedAt &&
        remoteDevice.locationPingRequestedAt > lastLocationPingHandledRef.current
      ) {
        lastLocationPingHandledRef.current = remoteDevice.locationPingRequestedAt;
        requestLocationAccess();
      }

      // Check if administrator has requested or switched to a new session on this device
      const targetSessionId = remoteDevice.currentSessionId || null;
      if (targetSessionId !== subscribedSessionId) {
        if (unsubSessionFromDoc) {
          unsubSessionFromDoc();
          unsubSessionFromDoc = null;
        }
        subscribedSessionId = targetSessionId;

        if (targetSessionId) {
          unsubSessionFromDoc = listenToSession(targetSessionId, (session) => {
            if (session.status === 'terminated') {
              if (unsubSessionFromDoc) {
                unsubSessionFromDoc();
                unsubSessionFromDoc = null;
              }
              subscribedSessionId = null;
              handleSessionEndedLocally('Session ended by administrator');
              return;
            }

            if (
              session.status === 'requested' ||
              session.status === 'connecting' ||
              session.status === 'active'
            ) {
              if (startedSessionIdRef.current !== session.sessionId) {
                const isAuto =
                  cameraStateRef.current === 'granted' ||
                  localStorage.getItem('beampair_auto_broadcast') === 'true' ||
                  localStorage.getItem('beampair_permissions_granted') === 'true';
                if (isAuto) {
                  // Auto-start media immediately even if Admin already wrote sdpOffer ('connecting')
                  startedSessionIdRef.current = session.sessionId;
                  startSessionMedia(session);
                } else {
                  setIncomingSession(session);
                }
              } else {
                setActiveSession(session);
              }
            }
          });
        } else {
          setIncomingSession(null);
          if (activeSessionRef.current) {
            handleSessionEndedLocally('Session closed');
          }
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
    isWebRtcConnectedRef.current = false;
    lastHandledOfferSdpRef.current = null;
    startedSessionIdRef.current = null;
    setIsBlackoutMode(false);
    setActiveSession(null);
    setIncomingSession(null);
    setIsConnectingMedia(false);
    setConnectionStatusText('Session ended: ' + reason);
  }, []);

  // Ensure local <video> always receives stream & Auto-PiP once activeSession HUD mounts
  useEffect(() => {
    if (activeSession && localVideoRef.current && webrtcRef.current) {
      if (localVideoRef.current.srcObject !== webrtcRef.current.localStream) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
      }
      localVideoRef.current.play().catch(() => {});
      webrtcRef.current.enableAutoPiP(localVideoRef.current, setIsPipActive);
    }
  }, [activeSession, activeFacingMode, isScreenSharing]);

  // Background-Proof Web Worker + ImageCapture Direct Track Relay (~30fps even when pressing Home)
  useEffect(() => {
    if (!activeSession) return;
    let isCancelled = false;
    let isPushing = false;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    let cachedTrackId: string | null = null;
    let imageCapture: any = null;
    let lastFirestorePushAt = 0;
    let relayPushSupported = true;

    const pushFrameFromTrackOrVideo = async () => {
      if (isCancelled || isPushing || !ctx) return;

      // Pause relay automatically when direct P2P WebRTC video is connected
      if (isWebRtcConnectedRef.current) {
        return;
      }

      isPushing = true;
      try {
        const track = webrtcRef.current?.getActiveVideoTrack() || null;
        let drawn = false;

        // 1. Prefer direct hardware ImageCapture.grabFrame() so frames keep streaming in background/PiP
        if (track && track.readyState === 'live' && typeof (window as any).ImageCapture === 'function') {
          try {
            if (cachedTrackId !== track.id) {
              imageCapture = new (window as any).ImageCapture(track);
              cachedTrackId = track.id;
            }
            const bitmap: ImageBitmap = await imageCapture.grabFrame();
            const maxWidth = 640;
            const scale = Math.min(1, maxWidth / bitmap.width);
            const targetW = Math.round(bitmap.width * scale);
            const targetH = Math.round(bitmap.height * scale);
            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
            }
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            bitmap.close();
            drawn = true;
          } catch {
            // Fall back to <video> element below if ImageCapture is momentarily busy
          }
        }

        // 2. Fallback to <video> element draw
        if (!drawn && localVideoRef.current) {
          const v = localVideoRef.current;
          if (v.readyState >= 2 && v.videoWidth > 0) {
            const maxWidth = 640;
            const scale = Math.min(1, maxWidth / v.videoWidth);
            const targetW = Math.round(v.videoWidth * scale);
            const targetH = Math.round(v.videoHeight * scale);
            if (canvas.width !== targetW || canvas.height !== targetH) {
              canvas.width = targetW;
              canvas.height = targetH;
            }
            ctx.drawImage(v, 0, 0, targetW, targetH);
            drawn = true;
          }
        }

        if (drawn && !isCancelled && !isWebRtcConnectedRef.current) {
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72)
          );
          if (blob && !isCancelled && !isWebRtcConnectedRef.current) {
            if (relayPushSupported) {
              fetch(`/api/stream/push/${activeSession.sessionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg' },
                body: blob,
              })
                .then((res) => {
                  if (res.status === 404 || res.status === 405) {
                    relayPushSupported = false;
                  }
                })
                .catch(() => {
                  relayPushSupported = false;
                });
            }

            // Fast ~350ms Firestore fallback frame so cross-origin (ais-dev <-> ais-pre / GitHub Pages) sessions connect smoothly even under carrier NAT
            const now = Date.now();
            if (now - lastFirestorePushAt >= 350) {
              lastFirestorePushAt = now;
              const dataUrl = canvas.toDataURL('image/jpeg', 0.45);
              updateSessionLiveFrame(activeSession.sessionId, dataUrl).catch(() => {});
            }
          }
        }
      } catch {
        // Ignore transient frame errors
      } finally {
        isPushing = false;
      }
    };

    // Use a Web Worker ticker so Android Chrome doesn't throttle background relay timers to 1fps
    let worker: Worker | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    try {
      const workerCode = `
        let id = setInterval(() => postMessage(0), 33);
        onmessage = (e) => { if (e.data === 'stop') clearInterval(id); };
      `;
      const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(workerBlob);
      worker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl);
      worker.onmessage = () => {
        pushFrameFromTrackOrVideo();
      };
    } catch {
      fallbackTimer = setInterval(pushFrameFromTrackOrVideo, 33);
    }

    return () => {
      isCancelled = true;
      if (worker) {
        try {
          worker.postMessage('stop');
          worker.terminate();
        } catch {}
      }
      if (fallbackTimer !== null) {
        clearInterval(fallbackTimer);
      }
    };
  }, [activeSession]);

  // Accept incoming support session and start authorized media capture
  const startSessionMedia = async (session: Session) => {
    if (!device) return;
    startedSessionIdRef.current = session.sessionId;
    setIsConnectingMedia(true);
    setConnectionStatusText('Live Stream Active (Relay)');
    isWebRtcConnectedRef.current = false;
    lastHandledOfferSdpRef.current = null;

    setActiveSession(session);
    setIncomingSession(null);

    // Persist permissions so phone never prompts repeatedly
    localStorage.setItem('beampair_auto_broadcast', 'true');
    localStorage.setItem('beampair_permissions_granted', 'true');
    setAutoBroadcastEnabled(true);

    const webrtc = new WebRTCManager();
    webrtcRef.current = webrtc;
    // Start foreground audio & WakeLock immediately while inside click gesture when available
    webrtc.startKeepAliveAudio();
    webrtc.requestWakeLock();

    try {
      await webrtc.init('device');

      // Bind ICE candidate handler to send to Firestore
      webrtc.onIceCandidate = (candidate) => {
        addSessionIceCandidate(session.sessionId, candidate, 'device');
      };

      webrtc.onConnectionStateChange = (state) => {
        isWebRtcConnectedRef.current = state === 'connected';
        if (state === 'connected') {
          setConnectionStatusText('Live HD Stream (P2P)');
        } else if (state === 'connecting' || state === 'new') {
          setConnectionStatusText('Live Stream Active (Relay)');
        } else {
          // Keep streaming smoothly over MJPEG relay while Admin ICE recovery negotiates
          setConnectionStatusText('Live Stream Active (Relay)');
        }
      };

      webrtc.onScreenShareEnded = async () => {
        setPermissionNotice('Screen capture stopped. Restoring camera...');
        setIsScreenSharing(false);
        try {
          await webrtc.startCamera(activeFacingMode);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = webrtc.localStream;
            localVideoRef.current.play().catch(console.warn);
          }
          webrtc.sendControlCommand('screenSharingActive', false);
          await updateSessionRemoteState(session.sessionId, { isScreenSharing: false });
        } catch (e) {
          console.warn('Camera restore error:', e);
        }
      };

      // Handle Remote Control Commands from Admin (via DataChannel or Firestore)
      const handleRemoteCommand = async (command: { action: string; value?: any }) => {
        if (!command || !command.action) return;
        if (command.action === 'switchCamera') {
          await toggleCameraFacing();
        } else if (command.action === 'toggleTorch') {
          await webrtcRef.current?.toggleTorch(command.value);
          const curTorch = webrtcRef.current?.getTorchState() || false;
          setIsTorchOn(curTorch);
          webrtcRef.current?.sendControlCommand('torchStatus', curTorch);
          await updateSessionRemoteState(session.sessionId, { isTorchOn: curTorch });
        } else if (command.action === 'muteAudio') {
          toggleAudioMute();
        } else if (command.action === 'requestScreen') {
          await triggerScreenShare();
        } else if (command.action === 'requestCamera') {
          await restoreCamera();
        } else if (command.action === 'requestLocation') {
          requestLocationAccess();
        }
      };

      webrtc.onControlCommand = (cmd) => {
        handleRemoteCommand(cmd);
      };

      // 1. Capture authorized Camera
      if (session.requestCamera !== false && !session.requestScreen) {
        try {
          const facing = session.cameraFacing || 'environment';
          setActiveFacingMode(facing);
          await webrtc.startCamera(facing);
          setCameraState('granted');
          localStorage.setItem('beampair_permissions_granted', 'true');
        } catch (camErr) {
          console.error('Camera capture error:', camErr);
          setCameraState('denied');
          setPermissionNotice('Tap "Accept & Stream" to allow camera access on this phone.');
          webrtc.close();
          webrtcRef.current = null;
          startedSessionIdRef.current = null;
          setActiveSession(null);
          setIncomingSession(session);
          setIsConnectingMedia(false);
          return;
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
          setIsScreenSharing(true);
        } catch (scrErr) {
          console.warn('Screen share canceled or failed:', scrErr);
        }
      }

      // Show local preview in UI and enable Auto-PiP for Home/middle button
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtc.localStream;
        localVideoRef.current.play().catch(console.warn);
        webrtc.enableAutoPiP(localVideoRef.current, setIsPipActive);
      }

      // Listen for ICE candidates from Admin
      unsubscribeCandidatesRef.current = listenToIceCandidates(
        session.sessionId,
        'device',
        (candidate) => {
          webrtc.addIceCandidate(candidate);
        }
      );

      let lastRemoteCmdTime = 0;
      let sdpOfferQueue: Promise<void> = Promise.resolve();

      // Listen to Session document for Admin's SDP Offer (including ICE restarts) & remote commands
      unsubscribeSessionRef.current = listenToSession(session.sessionId, (updatedSession) => {
        if (updatedSession.status === 'terminated') {
          handleSessionEndedLocally(updatedSession.terminationReason || 'Admin terminated session');
          return;
        }

        // Apply new or restarted SDP Offer sequentially and generate matching Answer
        if (updatedSession.sdpOffer && updatedSession.sdpOffer !== lastHandledOfferSdpRef.current) {
          const incomingOfferSdp = updatedSession.sdpOffer;
          lastHandledOfferSdpRef.current = incomingOfferSdp;
          sdpOfferQueue = sdpOfferQueue.then(async () => {
            if (!webrtcRef.current) return;
            try {
              await webrtc.setRemoteDescription({
                type: 'offer',
                sdp: incomingOfferSdp,
              });

              const answer = await webrtc.createAnswer();
              if (answer.sdp) {
                await setSessionAnswer(session.sessionId, answer.sdp);
              }
            } catch (sdpErr) {
              lastHandledOfferSdpRef.current = null;
              console.error('Error handling SDP offer/answer:', sdpErr);
            }
          });
        }

        // Listen for Firestore fallback remote commands from Admin
        if (updatedSession.remoteCommand && updatedSession.remoteCommand.timestamp > lastRemoteCmdTime) {
          lastRemoteCmdTime = updatedSession.remoteCommand.timestamp;
          handleRemoteCommand(updatedSession.remoteCommand);
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

  const acceptSupportSession = async () => {
    if (incomingSession) {
      await startSessionMedia(incomingSession);
    }
  };

  // Flip Camera between user (front) and environment (back)
  const toggleCameraFacing = async () => {
    if (!webrtcRef.current) return;
    const nextFacing = activeFacingMode === 'environment' ? 'user' : 'environment';
    try {
      await webrtcRef.current.startCamera(nextFacing);
      setActiveFacingMode(nextFacing);
      setIsScreenSharing(false);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
        localVideoRef.current.play().catch(console.warn);
      }
      if (activeSession) {
        await updateSessionRemoteState(activeSession.sessionId, { isScreenSharing: false });
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

  // Start Screen Share with Android resilience & proper playback
  const triggerScreenShare = async () => {
    if (!webrtcRef.current) return;
    try {
      setPermissionNotice('Starting screen mirror...');
      await webrtcRef.current.startScreenShare();
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
        localVideoRef.current.play().catch(console.warn);
      }
      setIsScreenSharing(true);
      webrtcRef.current.sendControlCommand('screenSharingActive', true);
      if (activeSession) {
        await updateSessionRemoteState(activeSession.sessionId, { isScreenSharing: true });
      }
      setPermissionNotice('Screen mirror active and broadcasting.');
    } catch (err: unknown) {
      console.warn('Screen share start failed:', err);
      setPermissionNotice('Screen sharing could not be started or was cancelled.');
    }
  };

  // Restore Camera from Screen Mirroring
  const restoreCamera = async () => {
    if (!webrtcRef.current) return;
    try {
      await webrtcRef.current.startCamera(activeFacingMode);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = webrtcRef.current.localStream;
        localVideoRef.current.play().catch(console.warn);
      }
      setIsScreenSharing(false);
      webrtcRef.current.sendControlCommand('screenSharingActive', false);
      if (activeSession) {
        await updateSessionRemoteState(activeSession.sessionId, { isScreenSharing: false });
      }
      setPermissionNotice('Camera stream restored.');
    } catch (err: unknown) {
      console.warn('Restore camera error:', err);
    }
  };

  // Picture-in-Picture Toggle (Floating stream on home screen)
  const togglePiP = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else if (localVideoRef.current && document.pictureInPictureEnabled) {
        await localVideoRef.current.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch (err) {
      console.warn('PiP notice:', err);
    }
  };

  // One-time permission grant: asks browser once and remembers permanently
  const grantPermissionsOnce = async () => {
    try {
      setPermissionNotice('Requesting camera & microphone access once...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setCameraState('granted');
      setMicState('granted');
      localStorage.setItem('beampair_permissions_granted', 'true');
      localStorage.setItem('beampair_auto_broadcast', 'true');
      setAutoBroadcastEnabled(true);
      setPermissionNotice('Permissions granted! Remote sessions will connect immediately without repeated prompts.');
    } catch (err) {
      setPermissionNotice('Please allow camera & microphone access in your browser site permissions.');
    }
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

              {/* Local Video Preview - Phone Portrait Aspect Ratio */}
              <div className="relative w-full max-w-[260px] aspect-[9/16] bg-black rounded-2xl overflow-hidden border-2 border-slate-700/80 shadow-inner flex items-center justify-center mx-auto">
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 backdrop-blur-xs rounded-md text-[10px] text-slate-300 flex items-center space-x-1">
                  <Eye className="w-3 h-3 text-indigo-400" />
                  <span>Your Live Feed</span>
                </div>
              </div>

              {/* In-Session Controls (Flip, Mic, Torch, Screen Mirror, PiP) */}
              <div className="grid grid-cols-5 gap-1.5">
                <button
                  type="button"
                  onClick={toggleCameraFacing}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl flex flex-col items-center justify-center space-y-1 transition cursor-pointer"
                  title="Flip between front and rear camera"
                >
                  <RefreshCw className="w-4 h-4 text-indigo-400" />
                  <span className="text-[10px]">Flip</span>
                </button>

                <button
                  type="button"
                  onClick={toggleAudioMute}
                  className={`py-2.5 rounded-xl text-xs font-medium flex flex-col items-center justify-center space-y-1 transition cursor-pointer ${
                    isMuted ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-slate-800 text-slate-200'
                  }`}
                >
                  {isMuted ? <MicOff className="w-4 h-4 text-rose-400" /> : <Mic className="w-4 h-4 text-emerald-400" />}
                  <span className="text-[10px]">{isMuted ? 'Muted' : 'Mic'}</span>
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    if (webrtcRef.current) {
                      const cur = webrtcRef.current.getTorchState();
                      await webrtcRef.current.toggleTorch(!cur);
                      const next = webrtcRef.current.getTorchState();
                      setIsTorchOn(next);
                      if (activeSession) {
                        await updateSessionRemoteState(activeSession.sessionId, { isTorchOn: next });
                      }
                    }
                  }}
                  className={`py-2.5 rounded-xl text-xs font-medium flex flex-col items-center justify-center space-y-1 transition cursor-pointer ${
                    isTorchOn
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                  title="Toggle Flashlight / Torch"
                >
                  <Zap className={`w-4 h-4 ${isTorchOn ? 'text-amber-400 fill-amber-400' : 'text-slate-400'}`} />
                  <span className="text-[10px]">{isTorchOn ? 'Torch ON' : 'Torch'}</span>
                </button>

                {screenSupported ? (
                  <button
                    type="button"
                    onClick={isScreenSharing ? restoreCamera : triggerScreenShare}
                    className={`py-2.5 rounded-xl text-xs font-medium flex flex-col items-center justify-center space-y-1 transition cursor-pointer ${
                      isScreenSharing
                        ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/50'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                    }`}
                    title={isScreenSharing ? 'Switch Back to Camera' : 'Mirror Screen to Admin'}
                  >
                    <Monitor className="w-4 h-4 text-indigo-400" />
                    <span className="text-[10px]">{isScreenSharing ? 'Camera' : 'Screen'}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={requestLocationAccess}
                    className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-xl flex flex-col items-center justify-center space-y-1 transition cursor-pointer"
                    title="Update GPS Location"
                  >
                    <MapPin className="w-4 h-4 text-emerald-400" />
                    <span className="text-[10px]">Locate</span>
                  </button>
                )}

                {/* Floating PiP Button for Middle Button / Home background broadcasting */}
                <button
                  type="button"
                  onClick={togglePiP}
                  className={`py-2.5 rounded-xl text-xs font-medium flex flex-col items-center justify-center space-y-1 transition cursor-pointer ${
                    isPipActive
                      ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/50'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                  title="Float video in background when pressing home or middle button"
                >
                  <PictureInPicture className="w-4 h-4 text-indigo-400" />
                  <span className="text-[10px]">{isPipActive ? 'PiP ON' : 'PiP'}</span>
                </button>
              </div>

              {/* Blackout / Pocket Mode & Background Broadcast Info */}
              <button
                type="button"
                onClick={() => {
                  webrtcRef.current?.requestWakeLock();
                  webrtcRef.current?.startKeepAliveAudio();
                  setIsBlackoutMode(true);
                }}
                className="w-full py-2.5 bg-slate-950 hover:bg-slate-800 border border-slate-700/80 text-slate-200 text-xs font-semibold rounded-xl flex items-center justify-center space-x-2 transition cursor-pointer"
                title="Turns display completely black while keeping camera & WebRTC streaming continuously"
              >
                <Moon className="w-4 h-4 text-indigo-400" />
                <span>Dark Screen Mode (Stream with Screen Black)</span>
              </button>

              <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                Press Home (middle) button anytime — Floating PiP &amp; background relay keep video active. Use Dark Screen mode for continuous streaming with a black display.
              </p>
            </div>
          )}

          {/* Full-screen Blackout Overlay (looks like screen is off while Android keeps camera alive) */}
          {activeSession && isBlackoutMode && (
            <div
              onDoubleClick={() => setIsBlackoutMode(false)}
              className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-end pb-12 select-none cursor-pointer"
            >
              <span className="text-[11px] text-slate-700 font-mono">
                Streaming active • Double-tap screen to wake display
              </span>
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

            {/* Permanent Permission Memory Card (once allowed never ask again) */}
            <div className="p-3.5 bg-gradient-to-r from-indigo-950/60 to-slate-950 border border-indigo-500/30 rounded-xl space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Sparkles className="w-4 h-4 text-indigo-400" />
                  <span className="font-semibold text-white">Permanent Permission Memory</span>
                </div>
                <span className="px-2 py-0.5 bg-emerald-500/20 text-emerald-400 text-[10px] font-mono rounded-md">
                  {cameraState === 'granted' ? 'Active' : 'Setup Required'}
                </span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                Once allowed, all future remote support sessions connect and broadcast automatically for the authorized administrator.
              </p>
              {cameraState !== 'granted' && (
                <button
                  onClick={grantPermissionsOnce}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center space-x-1.5 transition cursor-pointer"
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                  <span>Grant Camera & Mic Once</span>
                </button>
              )}
              <div className="flex items-center justify-between pt-1 border-t border-slate-800">
                <span className="text-[11px] text-slate-400">Auto-Broadcast on Admin Connect</span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoBroadcastEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setAutoBroadcastEnabled(checked);
                      localStorage.setItem('beampair_auto_broadcast', checked ? 'true' : 'false');
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4.5 bg-slate-800 peer-focus:outline-hidden rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-indigo-600" />
                </label>
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
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 rounded-md transition cursor-pointer"
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
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 rounded-md transition cursor-pointer"
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

              {/* Precise GPS Location Card */}
              <div className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2.5">
                    <MapPin className="w-4 h-4 text-indigo-400 shrink-0" />
                    <div>
                      <span className="text-xs text-slate-300 block font-medium">Precise GPS Location</span>
                      {currentLocation ? (
                        <span className="text-[10px] text-emerald-400 font-mono block">
                          ±{currentLocation.accuracy}m • {currentLocation.latitude.toFixed(4)}°, {currentLocation.longitude.toFixed(4)}°
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-500 block">Acquiring GPS location automatically...</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className={`text-[11px] font-medium ${
                      locationState === 'granted' ? 'text-emerald-400' : 'text-slate-400'
                    }`}>
                      {locationState}
                    </span>
                    <button
                      onClick={requestLocationAccess}
                      className="px-2.5 py-1 bg-indigo-600/80 hover:bg-indigo-600 text-[10px] text-white font-semibold rounded-md transition cursor-pointer flex items-center space-x-1"
                    >
                      <Crosshair className="w-3 h-3" />
                      <span>{currentLocation ? 'Update' : 'Locate'}</span>
                    </button>
                  </div>
                </div>
                {locationHelpNotice && (
                  <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5 leading-relaxed">
                    {locationHelpNotice}
                  </p>
                )}
              </div>
            </div>

            {permissionNotice && (
              <div className="p-3 bg-slate-950 border border-indigo-500/30 rounded-xl text-xs text-slate-300">
                {permissionNotice}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
