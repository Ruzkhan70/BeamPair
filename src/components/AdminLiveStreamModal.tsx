import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  X,
  PhoneOff,
  Volume2,
  VolumeX,
  RefreshCw,
  Camera,
  Maximize2,
  Minimize2,
  Activity,
  ShieldCheck,
  Zap,
  ZapOff,
  Download,
  Play,
  Pause,
  Smartphone,
  Expand,
  Loader2,
  AlertCircle,
  Wifi,
  Monitor,
  MapPin,
  Crosshair,
  LocateFixed,
  Mic,
  MicOff,
  Square,
  Battery,
  BatteryCharging,
} from 'lucide-react';
import { Device, Session, DeviceLocation } from '../types';
import { WebRTCManager } from '../services/webrtc';
import {
  listenToSession,
  setSessionOffer,
  addSessionIceCandidate,
  listenToIceCandidates,
  terminateSession,
  recordSecurityAudit,
  sendSessionRemoteCommand,
  cleanupSessionIceCandidates,
} from '../services/signaling';
import { updateDeviceHeartbeat, listenToDevice, requestDeviceLocationPing } from '../services/deviceService';
import { DeviceMapViewer } from './DeviceMapViewer';

interface AdminLiveStreamModalProps {
  session: Session;
  device: Device;
  adminId: string;
  onClose: () => void;
}

export const AdminLiveStreamModal: React.FC<AdminLiveStreamModalProps> = ({
  session,
  device,
  adminId,
  onClose,
}) => {
  const [connectionState, setConnectionState] = useState<string>('Connecting...');
  const [iceState, setIceState] = useState<string>('new');
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [isVideoPaused, setIsVideoPaused] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isEnding, setIsEnding] = useState<boolean>(false);
  const [videoResolution, setVideoResolution] = useState<string>('Detecting feed...');
  const [streamStartedAt] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [viewMode, setViewMode] = useState<'phone' | 'fit'>('phone');
  const [isTorchOn, setIsTorchOn] = useState<boolean>(false);
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(session.requestScreen || false);
  const [remoteCameraFacing, setRemoteCameraFacing] = useState<'user' | 'environment'>(
    session.cameraFacing || 'environment'
  );
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [snapshotSuccess, setSnapshotSuccess] = useState<boolean>(false);
  const [audioNeedsClick, setAudioNeedsClick] = useState<boolean>(false);
  const [activeRemoteStream, setActiveRemoteStream] = useState<MediaStream | null>(null);
  const [isWebRtcPlaying, setIsWebRtcPlaying] = useState<boolean>(false);
  const [hasRelayFrame, setHasRelayFrame] = useState<boolean>(false);
  const [liveFallbackFrame, setLiveFallbackFrame] = useState<string | null>(null);
  const [streamStats, setStreamStats] = useState<{
    transport: 'direct' | 'relay' | 'unknown';
    fps: number | null;
    rttMs: number | null;
    bitrateKbps: number | null;
  }>({ transport: 'unknown', fps: null, rttMs: null, bitrateKbps: null });
  const [showMiniMap, setShowMiniMap] = useState<boolean>(false);
  const [liveDeviceLocation, setLiveDeviceLocation] = useState<DeviceLocation | undefined>(device.location);
  const [liveLocationHistory, setLiveLocationHistory] = useState<DeviceLocation[] | undefined>(device.locationHistory);
  const [liveBatteryLevel, setLiveBatteryLevel] = useState<number | null | undefined>(device.batteryLevel);
  const [liveBatteryCharging, setLiveBatteryCharging] = useState<boolean | null | undefined>(device.batteryCharging);
  const [liveNetworkType, setLiveNetworkType] = useState<string | null | undefined>(device.networkType);
  const [streamQuality, setStreamQuality] = useState<'saver' | 'balanced' | 'hd'>('balanced');
  const [isTalkbackActive, setIsTalkbackActive] = useState<boolean>(false);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingSeconds, setRecordingSeconds] = useState<number>(0);
  const isStaticHost = typeof window !== 'undefined' && window.location.hostname.endsWith('github.io');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const relayImgRef = useRef<HTMLImageElement | null>(null);
  const fallbackImgRef = useRef<HTMLImageElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const unsubscribeSessionRef = useRef<(() => void) | null>(null);
  const unsubscribeCandidatesRef = useRef<(() => void) | null>(null);
  const lastAppliedAnswerRef = useRef<string | null>(null);
  const iceRetryCountRef = useRef<number>(0);
  const lastIceRetryAtRef = useRef<number>(0);
  const isWebRtcPlayingRef = useRef<boolean>(false);
  const lastResolutionRef = useRef<string>('Detecting feed...');

  // Timer for session duration
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - streamStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [streamStartedAt]);

  // Recording timer
  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0);
      return;
    }
    const timer = setInterval(() => {
      setRecordingSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isRecording]);

  // Real-time Device Location & Health Telemetry Sync
  useEffect(() => {
    const unsub = listenToDevice(device.deviceId, (updatedDev) => {
      if (!updatedDev) return;
      if (updatedDev.location) {
        setLiveDeviceLocation(updatedDev.location);
      }
      if (updatedDev.locationHistory) {
        setLiveLocationHistory(updatedDev.locationHistory);
      }
      if (updatedDev.batteryLevel !== undefined) {
        setLiveBatteryLevel(updatedDev.batteryLevel);
      }
      if (updatedDev.batteryCharging !== undefined) {
        setLiveBatteryCharging(updatedDev.batteryCharging);
      }
      if (updatedDev.networkType !== undefined) {
        setLiveNetworkType(updatedDev.networkType);
      }
    });
    return () => unsub();
  }, [device.deviceId]);

  const showTemporaryFeedback = (msg: string) => {
    setCommandFeedback(msg);
    setTimeout(() => setCommandFeedback(null), 3000);
  };

  const handleTeardown = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setIsTalkbackActive(false);

    if (webrtcRef.current) {
      webrtcRef.current.stopTalkback().catch(() => {});
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
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const markWebRtcPlaying = useCallback(() => {
    const vid = videoRef.current;
    if (!isWebRtcPlayingRef.current) {
      isWebRtcPlayingRef.current = true;
      setIsWebRtcPlaying(true);
      setLiveFallbackFrame(null);
      setHasRelayFrame(false);
    }
    if (vid && vid.videoWidth > 0) {
      const nextRes = `${vid.videoWidth} × ${vid.videoHeight}px`;
      if (lastResolutionRef.current !== nextRes) {
        lastResolutionRef.current = nextRes;
        setVideoResolution(nextRes);
      }
    }
  }, []);

  // WebRTC Peer Connection Setup for Admin (Receiver)
  useEffect(() => {
    const webrtc = new WebRTCManager();
    webrtcRef.current = webrtc;
    lastAppliedAnswerRef.current = null;
    iceRetryCountRef.current = 0;
    lastIceRetryAtRef.current = 0;
    isWebRtcPlayingRef.current = false;

    async function attemptAutoIceRestart() {
      const now = Date.now();
      if (iceRetryCountRef.current >= 3 || now - lastIceRetryAtRef.current < 4000) return;
      if (!webrtcRef.current) return;
      iceRetryCountRef.current += 1;
      lastIceRetryAtRef.current = now;
      try {
        const offer = await webrtcRef.current.restartIce();
        if (offer?.sdp) {
          await setSessionOffer(session.sessionId, offer.sdp);
        }
      } catch (err) {
        console.warn('Auto ICE restart warning:', err);
      }
    }

    const startupWatchdog = setTimeout(() => {
      if (!isWebRtcPlayingRef.current && webrtcRef.current) {
        const st = webrtcRef.current.peerConnection?.iceConnectionState;
        if (st !== 'connected' && st !== 'completed') {
          attemptAutoIceRestart();
        }
      }
    }, 6000);

    async function startAdminConnection() {
      try {
        setConnectionState('connecting');
        await webrtc.init('admin');

        // ICE candidate handler
        webrtc.onIceCandidate = (candidate) => {
          addSessionIceCandidate(session.sessionId, candidate, 'admin');
        };

        webrtc.onConnectionStateChange = (state) => {
          setConnectionState(state);
          if (state === 'failed' || state === 'disconnected' || state === 'closed') {
            isWebRtcPlayingRef.current = false;
            setIsWebRtcPlaying(false);
          }
        };

        webrtc.onIceConnectionStateChange = (state) => {
          setIceState(state);
          if (state === 'failed') {
            isWebRtcPlayingRef.current = false;
            setIsWebRtcPlaying(false);
            attemptAutoIceRestart();
          }
        };

        // Attach remote stream tracks cleanly without resetting srcObject on duplicate track events
        const attachMediaElements = (remoteStream: MediaStream, track: MediaStreamTrack) => {
          if (track.kind === 'video' && videoRef.current) {
            if (videoRef.current.srcObject !== remoteStream) {
              videoRef.current.srcObject = remoteStream;
            }
            if (videoRef.current.paused) {
              videoRef.current.play().catch(() => {});
            }
          }
          if (track.kind === 'audio' && audioRef.current) {
            if (audioRef.current.srcObject !== remoteStream) {
              audioRef.current.srcObject = remoteStream;
            }
            if (audioRef.current.paused) {
              audioRef.current.play().catch(() => setAudioNeedsClick(true));
            }
          }
        };

        webrtc.onRemoteStreamTrack = (remoteStream, track) => {
          setActiveRemoteStream((prev) => (prev === remoteStream ? prev : remoteStream));
          attachMediaElements(remoteStream, track);
          track.onunmute = () => attachMediaElements(remoteStream, track);
        };

        webrtc.onControlCommand = (cmd) => {
          if (cmd.action === 'torchStatus') {
            setIsTorchOn(Boolean(cmd.value));
          } else if (cmd.action === 'screenSharingActive') {
            setIsScreenSharing(Boolean(cmd.value));
          } else if (cmd.action === 'cameraFacingStatus') {
            if (cmd.value === 'user' || cmd.value === 'environment') {
              setRemoteCameraFacing(cmd.value);
            }
          } else if (cmd.action === 'qualityStatus') {
            if (cmd.value === 'saver' || cmd.value === 'balanced' || cmd.value === 'hd') {
              setStreamQuality(cmd.value);
            }
          }
        };

        // Create WebRTC Offer & listen for Answer/ICE concurrently
        const offer = await webrtc.createOffer();
        if (offer.sdp) {
          await setSessionOffer(session.sessionId, offer.sdp);
        }

        // Listen for ICE candidates from secondary phone
        unsubscribeCandidatesRef.current = listenToIceCandidates(
          session.sessionId,
          'admin',
          (candidate) => {
            webrtc.addIceCandidate(candidate);
          }
        );

        // Listen to Session document for device's SDP Answer (supports ICE restart updates), status & torch
        unsubscribeSessionRef.current = listenToSession(session.sessionId, async (updatedSession) => {
          if (updatedSession.status === 'terminated') {
            setConnectionState('terminated');
            isWebRtcPlayingRef.current = false;
            setIsWebRtcPlaying(false);
            handleTeardown();
            return;
          }

          // Ignore heavy fallback snapshots once live WebRTC video is rendering smoothly
          if (updatedSession.liveFrame && !isWebRtcPlayingRef.current) {
            setLiveFallbackFrame(updatedSession.liveFrame);
          }

          if (typeof updatedSession.isTorchOn === 'boolean') {
            setIsTorchOn(updatedSession.isTorchOn);
          }

          if (typeof updatedSession.isScreenSharing === 'boolean') {
            setIsScreenSharing(updatedSession.isScreenSharing);
          }

          // Apply initial or renegotiated SDP Answer cleanly
          if (updatedSession.sdpAnswer && updatedSession.sdpAnswer !== lastAppliedAnswerRef.current) {
            const answerSdp = updatedSession.sdpAnswer;
            lastAppliedAnswerRef.current = answerSdp;
            try {
              await webrtc.setRemoteDescription({
                type: 'answer',
                sdp: answerSdp,
              });
            } catch (err) {
              lastAppliedAnswerRef.current = null;
              console.error('Error applying remote answer:', err);
            }
          }
        });
      } catch (err) {
        console.error('Admin WebRTC initiation failed:', err);
        setConnectionState('failed');
      }
    }

    startAdminConnection();

    return () => {
      clearTimeout(startupWatchdog);
      handleTeardown();
    };
  }, [session.sessionId, handleTeardown]);

  // Detect WebRTC or multipart MJPEG stream readiness without causing idle React re-renders
  useEffect(() => {
    const detector = setInterval(() => {
      const vid = videoRef.current;
      if (vid && vid.videoWidth > 0) {
        if (vid.paused && !isVideoPaused) {
          vid.play().catch(() => {});
        }
        if (!vid.paused) {
          markWebRtcPlaying();
          return;
        }
      }
      if (!isWebRtcPlayingRef.current) {
        const img = relayImgRef.current;
        if (img && img.naturalWidth > 0) {
          setHasRelayFrame(true);
          const nextRes = `${img.naturalWidth} × ${img.naturalHeight}px`;
          if (lastResolutionRef.current !== nextRes) {
            lastResolutionRef.current = nextRes;
            setVideoResolution(nextRes);
          }
        }
      }
    }, 150);
    return () => clearInterval(detector);
  }, [viewMode, isVideoPaused, markWebRtcPlaying]);

  // Poll live WebRTC transport/FPS/latency metrics when connected
  useEffect(() => {
    if (!isWebRtcPlaying) return;
    const statsTimer = setInterval(async () => {
      if (!webrtcRef.current) return;
      const next = await webrtcRef.current.getConnectionStats();
      setStreamStats(next);
    }, 1500);
    return () => clearInterval(statsTimer);
  }, [isWebRtcPlaying]);

  // Synchronize remote stream to video element whenever viewMode or stream changes
  useEffect(() => {
    if (videoRef.current && activeRemoteStream) {
      if (videoRef.current.srcObject !== activeRemoteStream) {
        videoRef.current.srcObject = activeRemoteStream;
      }
      if (videoRef.current.paused && !isVideoPaused) {
        videoRef.current.play().catch(console.warn);
      }
    }
  }, [activeRemoteStream, viewMode, isVideoPaused]);

  // Video resolution metadata detector
  const handleVideoLoadedMetadata = () => {
    if (videoRef.current) {
      const w = videoRef.current.videoWidth;
      const h = videoRef.current.videoHeight;
      if (w > 0 && h > 0) {
        const nextRes = `${w} × ${h}px`;
        if (lastResolutionRef.current !== nextRes) {
          lastResolutionRef.current = nextRes;
          setVideoResolution(nextRes);
        }
      }
    }
  };

  // 1. Toggle Audio Mute
  const toggleAudio = () => {
    if (audioRef.current) {
      const nextMuted = !isAudioMuted;
      audioRef.current.muted = nextMuted;
      setIsAudioMuted(nextMuted);
      showTemporaryFeedback(nextMuted ? 'Remote audio muted' : 'Remote audio active');
    }
  };

  // Unlock audio if browser blocked initial autoplay
  const handleEnableAudio = () => {
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        setAudioNeedsClick(false);
        setIsAudioMuted(false);
      }).catch(console.warn);
    }
  };

  // 2. Pause / Resume Remote Video
  const toggleVideoPlayback = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(console.warn);
        setIsVideoPaused(false);
        showTemporaryFeedback('Video resumed');
      } else {
        videoRef.current.pause();
        setIsVideoPaused(true);
        showTemporaryFeedback('Video paused');
      }
    }
  };

  // 3. Remotely Switch Phone Camera (Front vs Rear) deterministically
  const handleRemoteSwitchCamera = async () => {
    const nextFacing: 'user' | 'environment' =
      remoteCameraFacing === 'environment' ? 'user' : 'environment';
    setRemoteCameraFacing(nextFacing);
    if (nextFacing === 'user') {
      setIsTorchOn(false);
    }
    showTemporaryFeedback(
      nextFacing === 'user' ? 'Switching phone to Front Camera...' : 'Switching phone to Back Camera...'
    );
    const sent = webrtcRef.current?.sendControlCommand('switchCamera', nextFacing);
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'switchCamera', value: nextFacing });
    }
  };

  // 4. Remotely Toggle Phone Flashlight / Torch
  const handleRemoteToggleTorch = async () => {
    const nextTorch = !isTorchOn;
    setIsTorchOn(nextTorch);
    showTemporaryFeedback(nextTorch ? 'Turned flashlight ON' : 'Turned flashlight OFF');
    const sent = webrtcRef.current?.sendControlCommand('toggleTorch', nextTorch);
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'toggleTorch', value: nextTorch });
    }
  };

  // Remotely Request Phone Screen Mirroring
  const handleRemoteRequestScreen = async () => {
    showTemporaryFeedback('Requesting phone to mirror screen...');
    const sent = webrtcRef.current?.sendControlCommand('requestScreen');
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'requestScreen' });
    }
  };

  // Remotely Switch Phone Back to Camera Stream
  const handleRemoteRequestCamera = async () => {
    showTemporaryFeedback('Switching phone back to camera stream...');
    const sent = webrtcRef.current?.sendControlCommand('requestCamera');
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'requestCamera' });
    }
  };

  // Remotely Request Phone Precise GPS Location
  const handleRemoteRequestLocation = async () => {
    showTemporaryFeedback('Requesting precise phone GPS coordinates...');
    await requestDeviceLocationPing(device.deviceId).catch(console.warn);
    const sent = webrtcRef.current?.sendControlCommand('requestLocation');
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'requestLocation' });
    }
    setShowMiniMap(true);
    await recordSecurityAudit({
      adminId,
      deviceId: device.deviceId,
      eventType: 'GPS_PING_REQUESTED',
      details: `Administrator requested remote GPS location ping for session ${session.sessionId}.`,
    }).catch(console.warn);
  };

  // 5. Take High-Resolution Snapshot
  const handleTakeSnapshot = () => {
    const sourceEl =
      isWebRtcPlaying && videoRef.current && videoRef.current.videoWidth > 0
        ? videoRef.current
        : hasRelayFrame && relayImgRef.current && relayImgRef.current.naturalWidth > 0
          ? relayImgRef.current
          : fallbackImgRef.current && fallbackImgRef.current.naturalWidth > 0
            ? fallbackImgRef.current
            : null;

    if (sourceEl) {
      try {
        const canvas = document.createElement('canvas');
        const w = sourceEl instanceof HTMLVideoElement ? sourceEl.videoWidth : sourceEl.naturalWidth;
        const h = sourceEl instanceof HTMLVideoElement ? sourceEl.videoHeight : sourceEl.naturalHeight;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(sourceEl, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = `beampair_snapshot_${device.deviceName.replace(/\s+/g, '_')}_${Date.now()}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setSnapshotSuccess(true);
          showTemporaryFeedback('HD Snapshot captured and downloaded!');
          setTimeout(() => setSnapshotSuccess(false), 2500);
          return;
        }
      } catch (err) {
        console.error('Failed to capture snapshot from stream:', err);
      }
    }

    showTemporaryFeedback('No active video feed to capture');
  };

  // 6. Change Remote Stream Quality (360p / 480p / 720p)
  const handleChangeQuality = async (quality: 'saver' | 'balanced' | 'hd') => {
    setStreamQuality(quality);
    const label = quality === 'saver' ? '360p Saver' : quality === 'hd' ? '720p HD' : '480p Balanced';
    showTemporaryFeedback(`Switching stream quality to ${label}...`);
    const sent = webrtcRef.current?.sendControlCommand('setQuality', quality);
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'setQuality', value: quality });
    }
  };

  // 7. Toggle Two-Way Push-to-Talk (Admin Mic -> Phone Speaker)
  const handleToggleTalkback = async () => {
    if (!webrtcRef.current) return;
    if (isTalkbackActive) {
      await webrtcRef.current.stopTalkback();
      setIsTalkbackActive(false);
      webrtcRef.current.sendControlCommand('talkbackStatus', false);
      showTemporaryFeedback('Push-to-Talk ended');
      return;
    }

    try {
      await webrtcRef.current.startTalkback();
      setIsTalkbackActive(true);
      webrtcRef.current.sendControlCommand('talkbackStatus', true);
      showTemporaryFeedback('Microphone live — speaking to phone');
    } catch (err) {
      console.warn('Push-to-Talk microphone error:', err);
      showTemporaryFeedback('Allow browser microphone to speak to the phone');
      setIsTalkbackActive(false);
    }
  };

  // 8. Record & Download Live Video Clip via MediaRecorder
  const handleToggleRecording = () => {
    if (isRecording && mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
      setIsRecording(false);
      return;
    }

    if (!activeRemoteStream || activeRemoteStream.getVideoTracks().length === 0) {
      showTemporaryFeedback('Wait for live WebRTC video stream before recording');
      return;
    }

    try {
      recordedChunksRef.current = [];
      const mimeTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ];
      const supportedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = supportedMime
        ? new MediaRecorder(activeRemoteStream, { mimeType: supportedMime })
        : new MediaRecorder(activeRemoteStream);

      recorder.ondataavailable = (evt) => {
        if (evt.data && evt.data.size > 0) {
          recordedChunksRef.current.push(evt.data);
        }
      };

      recorder.onstop = () => {
        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: supportedMime || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `beampair_clip_${device.deviceName.replace(/\s+/g, '_')}_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showTemporaryFeedback('Recorded video clip downloaded!');
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      setIsRecording(true);
      showTemporaryFeedback('Recording live video clip...');
    } catch (err) {
      console.error('Recording error:', err);
      showTemporaryFeedback('Video recording is unavailable in this browser');
    }
  };

  // 9. Retry / Restart ICE Renegotiation
  const handleRetryIce = async () => {
    showTemporaryFeedback('Re-negotiating ICE connection...');
    if (webrtcRef.current) {
      const offer = await webrtcRef.current.restartIce();
      if (offer?.sdp) {
        await setSessionOffer(session.sessionId, offer.sdp);
      }
    }
  };

  // 10. Toggle Fullscreen
  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(console.warn);
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(console.warn);
      setIsFullscreen(false);
    }
  };

  // 11. Admin-Only Disconnect Command (+ ICE Candidate Subcollection Cleanup)
  const handleAdminDisconnect = async () => {
    setIsEnding(true);
    try {
      await fetch('/api/admin/disconnect-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          adminId,
          reason: 'Terminated by administrator from live stream console',
        }),
      }).catch(() => {});

      await terminateSession(session.sessionId, 'admin', 'Administrative disconnect command');
      await updateDeviceHeartbeat(device.deviceId, { currentSessionId: null });
      await cleanupSessionIceCandidates(session.sessionId).catch(() => {});

      await recordSecurityAudit({
        adminId,
        deviceId: device.deviceId,
        eventType: 'SESSION_DISCONNECTED_BY_ADMIN',
        details: `Administrator disconnected remote session ${session.sessionId} after ${elapsedSeconds}s.`,
      });
    } catch (err) {
      console.error('Error during administrative disconnect:', err);
    } finally {
      handleTeardown();
      setIsEnding(false);
      onClose();
    }
  };

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const timeFormatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const isConnected = connectionState === 'connected' || connectionState === 'completed';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-1 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in">
      <div
        ref={containerRef}
        className="relative bg-slate-950 border border-slate-800 rounded-xl sm:rounded-2xl w-full max-w-5xl h-[96dvh] sm:h-[92vh] max-h-[900px] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Stream Top Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-5 sm:py-3 border-b border-slate-800/80 bg-slate-900/90 shrink-0">
          <div className="flex items-center space-x-2.5 sm:space-x-3 min-w-0 flex-1">
            <span className="flex h-2.5 w-2.5 sm:h-3 sm:w-3 relative shrink-0">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-amber-400'} opacity-75`} />
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 sm:h-3 sm:w-3 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <h3 className="text-xs sm:text-sm font-bold text-white tracking-wide truncate max-w-[140px] sm:max-w-none">{device.deviceName}</h3>
                <span className="hidden xs:inline-block px-1.5 sm:px-2 py-0.5 bg-slate-800 text-slate-300 font-mono text-[9px] sm:text-[10px] rounded-md shrink-0">
                  {device.platform.toUpperCase()}
                </span>
                <span className="px-1.5 sm:px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-mono text-[10px] rounded-md shrink-0">
                  {timeFormatted}
                </span>
                {typeof liveBatteryLevel === 'number' && (
                  <span
                    className={`hidden md:inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md font-mono text-[10px] border shrink-0 ${
                      liveBatteryLevel <= 20 && !liveBatteryCharging
                        ? 'bg-rose-500/15 border-rose-500/30 text-rose-300'
                        : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    {liveBatteryCharging ? (
                      <BatteryCharging className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Battery className="w-3 h-3 text-indigo-400" />
                    )}
                    <span>{liveBatteryLevel}%</span>
                    {liveNetworkType ? <span className="text-slate-400">• {liveNetworkType.toUpperCase()}</span> : null}
                  </span>
                )}
              </div>
              <p className="text-[10px] sm:text-[11px] text-slate-400 font-mono truncate">
                WebRTC: <span className={isConnected ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>{connectionState}</span> • ICE: {iceState}
              </p>
            </div>
          </div>

          {/* Quick Toolbar */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            {/* Quality Selector */}
            <div className="hidden sm:flex items-center bg-slate-800/80 border border-slate-700/80 rounded-xl p-0.5 text-[10px] font-mono">
              {(
                [
                  { id: 'saver', label: '360p' },
                  { id: 'balanced', label: '480p' },
                  { id: 'hd', label: '720p' },
                ] as const
              ).map((q) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => handleChangeQuality(q.id)}
                  className={`px-2 py-1 rounded-lg font-semibold transition cursor-pointer ${
                    streamQuality === q.id
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title={`Stream Quality: ${q.label}`}
                >
                  {q.label}
                </button>
              ))}
            </div>

            {/* Viewport Aspect Ratio Toggle */}
            <div className="flex items-center bg-slate-800/80 border border-slate-700/80 rounded-xl p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('phone')}
                className={`px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1 transition cursor-pointer ${
                  viewMode === 'phone'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Phone Screen (9:16 portrait viewport)"
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Phone Size</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('fit')}
                className={`px-2 sm:px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1 transition cursor-pointer ${
                  viewMode === 'fit'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Fill & Expand View"
              >
                <Expand className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Expanded</span>
              </button>
            </div>

            <button
              onClick={toggleFullscreen}
              className="hidden sm:inline-flex p-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl transition cursor-pointer"
              title="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Admin Disconnect Button */}
            <button
              onClick={handleAdminDisconnect}
              disabled={isEnding}
              className="px-2.5 sm:px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 shadow-lg shadow-rose-600/25 transition cursor-pointer whitespace-nowrap"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span className="sm:hidden">End</span>
              <span className="hidden sm:inline">End Session</span>
            </button>
          </div>
        </div>

        {/* Audio prompt banner if autoplay prevented */}
        {audioNeedsClick && (
          <div className="bg-amber-500/15 border-b border-amber-500/30 px-3 sm:px-5 py-2 flex items-center justify-between gap-2 text-xs text-amber-300 shrink-0">
            <div className="flex items-center space-x-2 min-w-0">
              <VolumeX className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="truncate sm:whitespace-normal">Audio muted by browser. Tap Unmute to hear phone audio.</span>
            </div>
            <button
              onClick={handleEnableAudio}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition cursor-pointer shrink-0"
            >
              Unmute
            </button>
          </div>
        )}

        {/* Feedback Alert toast */}
        {commandFeedback && (
          <div className="absolute top-14 sm:top-16 left-1/2 -translate-x-1/2 z-30 px-3.5 py-2 bg-indigo-600/95 text-white text-xs font-semibold rounded-xl shadow-2xl backdrop-blur-sm animate-fade-in flex items-center space-x-2 max-w-[90%]">
            <Activity className="w-4 h-4 shrink-0" />
            <span className="truncate">{commandFeedback}</span>
          </div>
        )}

        {/* Main Center Stage */}
        <div className="relative flex-1 min-h-0 bg-slate-950 flex items-center justify-center p-2 sm:p-6 overflow-hidden">
          {/* Background Ambient Glow */}
          <div className="absolute inset-0 bg-radial from-indigo-950/20 via-transparent to-transparent pointer-events-none" />

          {/* Floating Live GPS Mini-Map Overlay */}
          {showMiniMap && (
            <div className="absolute top-2 left-2 right-2 sm:top-4 sm:left-auto sm:right-4 sm:w-80 z-40 shadow-2xl rounded-2xl overflow-hidden border border-slate-700 bg-slate-950 animate-fade-in">
              <div className="px-3 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
                <div className="flex items-center space-x-1.5 text-white font-bold">
                  <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Phone Live GPS</span>
                </div>
                <div className="flex items-center space-x-1">
                  <button
                    onClick={async () => {
                      await sendSessionRemoteCommand(session.sessionId, { action: 'requestLocation' });
                      showTemporaryFeedback('Requested live GPS ping from phone');
                    }}
                    className="p-1 hover:bg-slate-800 text-indigo-400 rounded-md transition cursor-pointer"
                    title="Ping phone for fresh GPS location"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setShowMiniMap(false)}
                    className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded-md transition cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <DeviceMapViewer
                devices={[{ ...device, location: liveDeviceLocation, locationHistory: liveLocationHistory }]}
                selectedDeviceId={device.deviceId}
                onRequestLocationPing={async () => {
                  await handleRemoteRequestLocation();
                }}
                compact={true}
              />
            </div>
          )}

          {/* VIEW MODE 1: REALISTIC PHONE FRAME (Requested: camera ratio should be the size of the phone) */}
          {viewMode === 'phone' ? (
            <div className="relative h-full max-h-[620px] aspect-[9/18.5] max-w-full flex items-center justify-center">
              {/* Smartphone Outer Metallic Bezel */}
              <div className="relative w-full h-full bg-slate-900 border-[3px] sm:border-4 border-slate-700/80 rounded-[28px] sm:rounded-[38px] p-1.5 sm:p-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.8)] flex flex-col ring-1 ring-white/10 overflow-hidden">
                {/* Phone Speaker Slit & Front Camera Punch Hole */}
                <div className="absolute top-2.5 sm:top-3 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-2 pointer-events-none">
                  <div className="w-10 sm:w-12 h-1 bg-slate-800 rounded-full" />
                  <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 bg-slate-950 rounded-full border border-slate-800" />
                </div>

                {/* Phone Screen Display Area */}
                <div className="relative flex-1 w-full bg-black rounded-[22px] sm:rounded-[28px] overflow-hidden flex items-center justify-center">
                  {/* Live WebRTC <video> kept visible at full opacity underneath overlays so hardware decoder starts on Frame 1 */}
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onLoadedData={() => {
                      if (videoRef.current && videoRef.current.videoWidth > 0) {
                        markWebRtcPlaying();
                      }
                    }}
                    onCanPlay={() => {
                      if (videoRef.current && videoRef.current.videoWidth > 0) {
                        markWebRtcPlaying();
                      }
                    }}
                    onPlaying={markWebRtcPlaying}
                    className="absolute inset-0 w-full h-full object-cover z-10"
                  />

                  {/* Smooth High-FPS MJPEG Live Stream Fallback when WebRTC isn't playing */}
                  {!isWebRtcPlaying && !isStaticHost && (
                    <img
                      ref={relayImgRef}
                      src={`/api/stream/live/${session.sessionId}`}
                      alt="Phone Live Camera"
                      onLoad={() => {
                        setHasRelayFrame(true);
                        if (relayImgRef.current && relayImgRef.current.naturalWidth > 0) {
                          const nextRes = `${relayImgRef.current.naturalWidth} × ${relayImgRef.current.naturalHeight}px`;
                          lastResolutionRef.current = nextRes;
                          setVideoResolution(nextRes);
                        }
                      }}
                      onError={() => setHasRelayFrame(false)}
                      className={`absolute inset-0 w-full h-full object-cover ${
                        hasRelayFrame ? 'opacity-100 z-[15]' : 'opacity-0 pointer-events-none z-0'
                      }`}
                    />
                  )}

                  {/* Cross-Origin Firestore Frame Backup if MJPEG server & WebRTC haven't delivered yet */}
                  {!isWebRtcPlaying && !hasRelayFrame && liveFallbackFrame && (
                    <img
                      ref={fallbackImgRef}
                      src={liveFallbackFrame}
                      alt="Phone Live Camera"
                      onLoad={() => {
                        if (fallbackImgRef.current && fallbackImgRef.current.naturalWidth > 0 && lastResolutionRef.current === 'Detecting feed...') {
                          const nextRes = `${fallbackImgRef.current.naturalWidth} × ${fallbackImgRef.current.naturalHeight}px`;
                          lastResolutionRef.current = nextRes;
                          setVideoResolution(nextRes);
                        }
                      }}
                      className="absolute inset-0 w-full h-full object-cover z-[15]"
                    />
                  )}

                  {/* Audio receiver element */}
                  <audio ref={audioRef} autoPlay />

                  {/* Connecting / Standby State Overlay inside Phone Screen */}
                  {!isWebRtcPlaying && !hasRelayFrame && !liveFallbackFrame && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-950/90 backdrop-blur-xs text-center z-20">
                      <Loader2 className="w-8 h-8 text-indigo-400 animate-spin mb-3" />
                      <h4 className="text-white text-xs font-semibold">Connecting to Android Phone</h4>
                      <p className="text-[11px] text-slate-400 mt-1 max-w-[200px] leading-relaxed">
                        Awaiting camera stream from {device.deviceName}...
                      </p>
                      <button
                        onClick={handleRetryIce}
                        className="mt-4 px-3 py-1.5 bg-indigo-600/80 hover:bg-indigo-600 text-white text-[10px] font-semibold rounded-lg flex items-center space-x-1 transition cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Retry Connection</span>
                      </button>
                    </div>
                  )}

                  {/* Live Watermark on Phone Screen */}
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between pointer-events-none z-30">
                    <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-md text-[10px] font-mono text-emerald-400 flex items-center space-x-1">
                      <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />
                      <span>
                        {isWebRtcPlaying
                          ? `LIVE (${streamStats.transport === 'relay' ? 'Relay' : 'P2P'}${streamStats.fps !== null ? ` • ${streamStats.fps}fps` : ''}${streamStats.rttMs !== null ? ` • ${streamStats.rttMs}ms` : ''})`
                          : hasRelayFrame
                            ? 'LIVE (HD Relay)'
                            : liveFallbackFrame
                              ? 'LIVE (Sync)'
                              : 'CONNECTING'}
                      </span>
                    </span>
                    <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-md text-[10px] font-mono text-slate-300">
                      {videoResolution}
                    </span>
                  </div>
                </div>

                {/* Phone Bottom Home Indicator Bar */}
                <div className="h-4 flex items-center justify-center shrink-0">
                  <div className="w-24 h-1 bg-slate-600 rounded-full" />
                </div>
              </div>
            </div>
          ) : (
            /* VIEW MODE 2: EXPANDED / FIT VIEW */
            <div className="relative w-full h-full flex items-center justify-center bg-black rounded-2xl overflow-hidden border border-slate-800">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={handleVideoLoadedMetadata}
                onLoadedData={() => {
                  if (videoRef.current && videoRef.current.videoWidth > 0) {
                    markWebRtcPlaying();
                  }
                }}
                onCanPlay={() => {
                  if (videoRef.current && videoRef.current.videoWidth > 0) {
                    markWebRtcPlaying();
                  }
                }}
                onPlaying={markWebRtcPlaying}
                className="absolute inset-0 w-full h-full object-contain z-10"
              />

              {!isWebRtcPlaying && !isStaticHost && (
                <img
                  ref={relayImgRef}
                  src={`/api/stream/live/${session.sessionId}`}
                  alt="Phone Live Camera"
                  onLoad={() => {
                    setHasRelayFrame(true);
                    if (relayImgRef.current && relayImgRef.current.naturalWidth > 0) {
                      const nextRes = `${relayImgRef.current.naturalWidth} × ${relayImgRef.current.naturalHeight}px`;
                      lastResolutionRef.current = nextRes;
                      setVideoResolution(nextRes);
                    }
                  }}
                  onError={() => setHasRelayFrame(false)}
                  className={`absolute inset-0 w-full h-full object-contain ${
                    hasRelayFrame ? 'opacity-100 z-[15]' : 'opacity-0 pointer-events-none z-0'
                  }`}
                />
              )}

              {!isWebRtcPlaying && !hasRelayFrame && liveFallbackFrame && (
                <img
                  ref={fallbackImgRef}
                  src={liveFallbackFrame}
                  alt="Phone Live Camera"
                  className="absolute inset-0 w-full h-full object-contain z-[15]"
                />
              )}

              <audio ref={audioRef} autoPlay />

              {!isWebRtcPlaying && !hasRelayFrame && !liveFallbackFrame && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-950/90 backdrop-blur-xs text-center z-20">
                  <Loader2 className="w-10 h-10 text-indigo-400 animate-spin mb-3" />
                  <h4 className="text-white text-sm font-semibold">Connecting to Android Phone</h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm">
                    Connecting to secondary phone {device.deviceName}...
                  </p>
                  <button
                    onClick={handleRetryIce}
                    className="mt-4 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 transition cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Reconnect Stream</span>
                  </button>
                </div>
              )}

              {/* Live Watermark for Expanded View */}
              <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none z-30">
                <span className="px-2.5 py-1 bg-black/70 backdrop-blur-md border border-white/10 rounded-md text-xs font-mono text-emerald-400 flex items-center space-x-1.5">
                  <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
                  <span>
                    {isWebRtcPlaying
                      ? `LIVE (${streamStats.transport === 'relay' ? 'Relay' : 'P2P'}${streamStats.fps !== null ? ` • ${streamStats.fps}fps` : ''}${streamStats.rttMs !== null ? ` • ${streamStats.rttMs}ms` : ''})`
                      : hasRelayFrame
                        ? 'LIVE (HD Relay)'
                        : liveFallbackFrame
                          ? 'LIVE (Sync)'
                          : 'CONNECTING'}
                  </span>
                </span>
                <span className="px-2.5 py-1 bg-black/70 backdrop-blur-md border border-white/10 rounded-md text-xs font-mono text-slate-300">
                  {videoResolution}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM ACTION BUTTONS CONSOLE (make all these buttons work) */}
        <div className="px-2.5 py-2.5 sm:px-5 sm:py-3 bg-slate-900 border-t border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-2 sm:gap-3 shrink-0 pb-[calc(0.625rem+env(safe-area-inset-bottom))] sm:pb-3">
          {/* Left: Remote Control Actions */}
          <div className="grid grid-cols-4 sm:flex sm:flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Switch Camera */}
            <button
              type="button"
              onClick={handleRemoteSwitchCamera}
              className="px-1.5 py-2 sm:px-3.5 sm:py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95"
              title="Flip between Rear and Front phone camera"
            >
              <RefreshCw className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="sm:hidden leading-tight text-center">{remoteCameraFacing === 'environment' ? 'Front' : 'Back'}</span>
              <span className="hidden sm:inline">{remoteCameraFacing === 'environment' ? 'Switch to Front' : 'Switch to Back'}</span>
            </button>

            {/* Mirror Phone Screen */}
            <button
              type="button"
              onClick={isScreenSharing ? handleRemoteRequestCamera : handleRemoteRequestScreen}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isScreenSharing
                  ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Mirror Phone Screen / Switch Back to Camera"
            >
              <Monitor className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="sm:hidden leading-tight text-center">{isScreenSharing ? 'Camera' : 'Screen'}</span>
              <span className="hidden sm:inline">{isScreenSharing ? 'Switch to Camera' : 'Mirror Screen'}</span>
            </button>

            {/* Toggle Flashlight / Torch */}
            <button
              type="button"
              onClick={handleRemoteToggleTorch}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isTorchOn
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Toggle Phone LED Flashlight / Torch"
            >
              {isTorchOn ? <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0" /> : <ZapOff className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
              <span className="sm:hidden leading-tight text-center">{isTorchOn ? 'Light ON' : 'Light'}</span>
              <span className="hidden sm:inline">Flashlight {isTorchOn ? 'ON' : 'OFF'}</span>
            </button>

            {/* Mute Audio */}
            <button
              type="button"
              onClick={toggleAudio}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isAudioMuted
                  ? 'bg-rose-500/20 border-rose-500/30 text-rose-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title={isAudioMuted ? 'Unmute Phone Speaker Audio' : 'Mute Phone Audio'}
            >
              {isAudioMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400 shrink-0" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              <span className="sm:hidden leading-tight text-center">{isAudioMuted ? 'Unmute' : 'Audio'}</span>
              <span className="hidden sm:inline">{isAudioMuted ? 'Unmute Audio' : 'Mute Audio'}</span>
            </button>

            {/* Pause / Resume Video */}
            <button
              type="button"
              onClick={toggleVideoPlayback}
              className="px-1.5 py-2 sm:px-3.5 sm:py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95"
              title="Pause or Resume Video Stream"
            >
              {isVideoPaused ? <Play className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> : <Pause className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
              <span className="sm:hidden leading-tight text-center">{isVideoPaused ? 'Resume' : 'Pause'}</span>
              <span className="hidden sm:inline">{isVideoPaused ? 'Resume Video' : 'Pause Video'}</span>
            </button>

            {/* Push-to-Talk (Admin Mic -> Phone Speaker) */}
            <button
              type="button"
              onClick={handleToggleTalkback}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isTalkbackActive
                  ? 'bg-amber-500/25 border-amber-400 text-amber-200 animate-pulse'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Speak from Admin microphone through Phone speaker"
            >
              {isTalkbackActive ? (
                <Mic className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              ) : (
                <MicOff className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              )}
              <span className="sm:hidden leading-tight text-center">{isTalkbackActive ? 'Talking' : 'Talk'}</span>
              <span className="hidden sm:inline">{isTalkbackActive ? 'Mic Live' : 'Talk to Phone'}</span>
            </button>

            {/* Record Live Video Clip */}
            <button
              type="button"
              onClick={handleToggleRecording}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isRecording
                  ? 'bg-rose-600/30 border-rose-500 text-rose-200'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Record live stream clip and save locally"
            >
              {isRecording ? (
                <Square className="w-3.5 h-3.5 text-rose-400 fill-rose-400 shrink-0" />
              ) : (
                <Camera className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              )}
              <span className="sm:hidden leading-tight text-center">
                {isRecording ? `${recordingSeconds}s` : 'Rec'}
              </span>
              <span className="hidden sm:inline">
                {isRecording ? `Stop (${recordingSeconds}s)` : 'Record Clip'}
              </span>
            </button>

            {/* HD Snapshot */}
            <button
              type="button"
              onClick={handleTakeSnapshot}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                snapshotSuccess
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Save high-resolution photo from stream"
            >
              <Download className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="sm:hidden leading-tight text-center">{snapshotSuccess ? 'Saved' : 'Snap'}</span>
              <span className="hidden sm:inline">{snapshotSuccess ? 'Snapshot Saved!' : 'Take Snapshot'}</span>
            </button>

            {/* GPS Location & Mini-Map Toggle */}
            <button
              type="button"
              onClick={() => {
                setShowMiniMap(!showMiniMap);
                if (!showMiniMap && !liveDeviceLocation) {
                  handleRemoteRequestLocation();
                }
              }}
              className={`px-1.5 py-2 sm:px-3.5 sm:py-2 border rounded-xl text-[10px] sm:text-xs font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                showMiniMap
                  ? 'bg-emerald-600/30 border-emerald-500/50 text-emerald-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Toggle Live GPS Location Mini-Map & Ping Location"
            >
              <MapPin className={`w-3.5 h-3.5 shrink-0 ${showMiniMap ? 'text-emerald-400' : 'text-slate-400'}`} />
              <span className="sm:hidden leading-tight text-center">{showMiniMap ? 'Hide Map' : 'Location'}</span>
              <span className="hidden sm:inline">{showMiniMap ? 'Hide GPS Map' : 'Phone Location'}</span>
              {liveDeviceLocation && (
                <span className="hidden sm:inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>

            {/* Mobile Quality Cycle + Reconnect inside mobile grid */}
            <button
              type="button"
              onClick={() => {
                const next =
                  streamQuality === 'saver' ? 'balanced' : streamQuality === 'balanced' ? 'hd' : 'saver';
                handleChangeQuality(next);
              }}
              className="sm:hidden px-1.5 py-2 bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 rounded-xl text-[10px] font-semibold flex flex-col items-center justify-center gap-1 transition cursor-pointer shadow-xs active:scale-95"
              title="Cycle stream quality"
            >
              <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="leading-tight text-center">
                {streamQuality === 'saver' ? '360p' : streamQuality === 'hd' ? '720p' : '480p'}
              </span>
            </button>

            {/* Mobile quick Reconnect button inside the 4x2 grid */}
            <button
              type="button"
              onClick={handleRetryIce}
              className="sm:hidden px-1.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-[10px] font-semibold flex flex-col items-center justify-center gap-1 transition cursor-pointer shadow-xs active:scale-95"
              title="Reconnect WebRTC PeerConnection"
            >
              <Wifi className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="leading-tight text-center">Reconnect</span>
            </button>
          </div>

          {/* Right: Diagnostics & Disconnect (Desktop + Compact Mobile Bar) */}
          <div className="flex items-center justify-between sm:justify-end space-x-3 text-xs pt-0.5 sm:pt-0">
            <button
              type="button"
              onClick={handleRetryIce}
              className="hidden sm:flex px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg text-[11px] font-mono items-center space-x-1.5 transition cursor-pointer border border-slate-700/60"
              title="Reconnect WebRTC PeerConnection"
            >
              <Wifi className="w-3.5 h-3.5 text-indigo-400" />
              <span>Reconnect ICE</span>
            </button>

            <span className="text-slate-500 font-mono text-[10px] sm:text-[11px]">
              Res: <strong className="text-slate-300 font-normal">{videoResolution}</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
