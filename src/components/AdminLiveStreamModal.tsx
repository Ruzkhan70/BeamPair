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
} from 'lucide-react';
import { Device, Session } from '../types';
import { WebRTCManager } from '../services/webrtc';
import {
  listenToSession,
  setSessionOffer,
  addSessionIceCandidate,
  listenToIceCandidates,
  terminateSession,
  recordSecurityAudit,
  sendSessionRemoteCommand,
} from '../services/signaling';
import { updateDeviceHeartbeat } from '../services/deviceService';

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
  const [commandFeedback, setCommandFeedback] = useState<string | null>(null);
  const [snapshotSuccess, setSnapshotSuccess] = useState<boolean>(false);
  const [audioNeedsClick, setAudioNeedsClick] = useState<boolean>(false);
  const [activeRemoteStream, setActiveRemoteStream] = useState<MediaStream | null>(null);
  const [isWebRtcPlaying, setIsWebRtcPlaying] = useState<boolean>(false);
  const [liveFallbackFrame, setLiveFallbackFrame] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const unsubscribeSessionRef = useRef<(() => void) | null>(null);
  const unsubscribeCandidatesRef = useRef<(() => void) | null>(null);

  // Timer for session duration
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - streamStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [streamStartedAt]);

  const showTemporaryFeedback = (msg: string) => {
    setCommandFeedback(msg);
    setTimeout(() => setCommandFeedback(null), 3000);
  };

  const handleTeardown = useCallback(() => {
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
    if (videoRef.current) videoRef.current.srcObject = null;
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  // WebRTC Peer Connection Setup for Admin (Receiver)
  useEffect(() => {
    const webrtc = new WebRTCManager();
    webrtcRef.current = webrtc;

    async function startAdminConnection() {
      try {
        setConnectionState('Configuring ICE & STUN/TURN relays...');
        await webrtc.init('admin');

        // ICE candidate handler
        webrtc.onIceCandidate = (candidate) => {
          addSessionIceCandidate(session.sessionId, candidate, 'admin');
        };

        webrtc.onConnectionStateChange = (state) => {
          setConnectionState(state);
        };

        webrtc.onIceConnectionStateChange = (state) => {
          setIceState(state);
        };

        // When remote stream tracks arrive from secondary phone
        webrtc.onRemoteStreamTrack = (remoteStream, track) => {
          setActiveRemoteStream(remoteStream);
          if (track.kind === 'video' && videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            videoRef.current.play().catch((err) => {
              console.warn('Video play notice:', err);
            });
          }
          if (track.kind === 'audio' && audioRef.current) {
            audioRef.current.srcObject = remoteStream;
            audioRef.current.play().catch((err) => {
              console.warn('Audio autoplay blocked, requires gesture:', err);
              setAudioNeedsClick(true);
            });
          }
        };

        // Create WebRTC Offer
        setConnectionState('Generating SDP Offer...');
        const offer = await webrtc.createOffer();
        if (offer.sdp) {
          await setSessionOffer(session.sessionId, offer.sdp);
          setConnectionState('Offer sent, awaiting phone broadcast...');
        }

        // Listen for ICE candidates from secondary phone
        unsubscribeCandidatesRef.current = listenToIceCandidates(
          session.sessionId,
          'admin',
          (candidate) => {
            webrtc.addIceCandidate(candidate);
          }
        );

        // Listen to Session document for device's SDP Answer, status & live frame
        unsubscribeSessionRef.current = listenToSession(session.sessionId, async (updatedSession) => {
          if (updatedSession.status === 'terminated') {
            setConnectionState('Session terminated by ' + (updatedSession.endedBy || 'peer'));
            handleTeardown();
            return;
          }

          if (updatedSession.liveFrame) {
            setLiveFallbackFrame(updatedSession.liveFrame);
          }

          // If answer is present and not yet set
          if (updatedSession.sdpAnswer && !webrtc.peerConnection?.remoteDescription) {
            try {
              await webrtc.setRemoteDescription({
                type: 'answer',
                sdp: updatedSession.sdpAnswer,
              });
              setConnectionState('connected');
            } catch (err) {
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
      handleTeardown();
    };
  }, [session.sessionId, handleTeardown]);

  // Fast frame polling from server relay
  useEffect(() => {
    let isMounted = true;
    const pollInterval = setInterval(async () => {
      if (!isMounted) return;
      try {
        const res = await fetch(`/api/stream/frame/${session.sessionId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.frame && isMounted) {
            setLiveFallbackFrame(data.frame);
          }
        }
      } catch {
        // server poll note
      }
    }, 280);

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
    };
  }, [session.sessionId]);

  // Synchronize remote stream to video element whenever viewMode or stream changes
  useEffect(() => {
    if (videoRef.current && activeRemoteStream) {
      videoRef.current.srcObject = activeRemoteStream;
      videoRef.current.play().catch(console.warn);
    }
  }, [activeRemoteStream, viewMode]);

  // Video resolution metadata detector
  const handleVideoLoadedMetadata = () => {
    if (videoRef.current) {
      const w = videoRef.current.videoWidth;
      const h = videoRef.current.videoHeight;
      if (w > 0 && h > 0) {
        setVideoResolution(`${w} × ${h}px`);
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

  // 3. Remotely Switch Phone Camera (Front vs Rear)
  const handleRemoteSwitchCamera = async () => {
    showTemporaryFeedback('Requesting phone to switch camera...');
    const sent = webrtcRef.current?.sendControlCommand('switchCamera');
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'switchCamera' });
    }
  };

  // 4. Remotely Toggle Phone Flashlight / Torch
  const handleRemoteToggleTorch = async () => {
    const nextTorch = !isTorchOn;
    setIsTorchOn(nextTorch);
    showTemporaryFeedback(nextTorch ? 'Turned flashlight ON' : 'Turned flashlight OFF');
    const sent = webrtcRef.current?.sendControlCommand('toggleTorch', { enabled: nextTorch });
    if (!sent) {
      await sendSessionRemoteCommand(session.sessionId, { action: 'toggleTorch', value: nextTorch });
    }
  };

  // 5. Take High-Resolution Snapshot
  const handleTakeSnapshot = () => {
    if (videoRef.current && videoRef.current.videoWidth > 0) {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
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
        console.error('Failed to capture snapshot from video:', err);
      }
    }

    if (liveFallbackFrame) {
      const a = document.createElement('a');
      a.href = liveFallbackFrame;
      a.download = `beampair_snapshot_${device.deviceName.replace(/\s+/g, '_')}_${Date.now()}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setSnapshotSuccess(true);
      showTemporaryFeedback('Snapshot captured from phone stream!');
      setTimeout(() => setSnapshotSuccess(false), 2500);
      return;
    }

    showTemporaryFeedback('No active video feed to capture');
  };

  // 6. Retry / Restart ICE Renegotiation
  const handleRetryIce = async () => {
    showTemporaryFeedback('Re-negotiating ICE connection...');
    if (webrtcRef.current) {
      const offer = await webrtcRef.current.restartIce();
      if (offer?.sdp) {
        await setSessionOffer(session.sessionId, offer.sdp);
      }
    }
  };

  // 7. Toggle Fullscreen
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

  // 8. Admin-Only Disconnect Command
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in">
      <div
        ref={containerRef}
        className="relative bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-5xl h-[92vh] max-h-[900px] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Stream Top Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-slate-800/80 bg-slate-900/90 shrink-0">
          <div className="flex items-center space-x-3">
            <span className="flex h-3 w-3 relative">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-amber-400'} opacity-75`} />
              <span className={`relative inline-flex rounded-full h-3 w-3 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </span>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-white tracking-wide">{device.deviceName}</h3>
                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 font-mono text-[10px] rounded-md">
                  {device.platform.toUpperCase()}
                </span>
                <span className="px-2 py-0.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-mono text-[10px] rounded-md">
                  {timeFormatted}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">
                WebRTC: <span className={isConnected ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>{connectionState}</span> • ICE: {iceState}
              </p>
            </div>
          </div>

          {/* Quick Toolbar */}
          <div className="flex items-center space-x-2">
            {/* Viewport Aspect Ratio Toggle */}
            <div className="flex items-center bg-slate-800/80 border border-slate-700/80 rounded-xl p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('phone')}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition cursor-pointer ${
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
                className={`px-2.5 py-1 rounded-lg text-xs font-medium flex items-center space-x-1.5 transition cursor-pointer ${
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
              className="p-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl transition cursor-pointer"
              title="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Admin Disconnect Button */}
            <button
              onClick={handleAdminDisconnect}
              disabled={isEnding}
              className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 shadow-lg shadow-rose-600/25 transition cursor-pointer"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              <span>End Session</span>
            </button>
          </div>
        </div>

        {/* Audio prompt banner if autoplay prevented */}
        {audioNeedsClick && (
          <div className="bg-amber-500/15 border-b border-amber-500/30 px-5 py-2 flex items-center justify-between text-xs text-amber-300">
            <div className="flex items-center space-x-2">
              <VolumeX className="w-4 h-4 text-amber-400" />
              <span>Browser muted audio playback to prevent auto-noise. Click to hear live phone audio.</span>
            </div>
            <button
              onClick={handleEnableAudio}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition cursor-pointer"
            >
              Unmute Audio
            </button>
          </div>
        )}

        {/* Feedback Alert toast */}
        {commandFeedback && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 px-4 py-2 bg-indigo-600/90 text-white text-xs font-semibold rounded-xl shadow-2xl backdrop-blur-sm animate-fade-in flex items-center space-x-2">
            <Activity className="w-4 h-4" />
            <span>{commandFeedback}</span>
          </div>
        )}

        {/* Main Center Stage */}
        <div className="relative flex-1 bg-slate-950 flex items-center justify-center p-3 sm:p-6 overflow-hidden">
          {/* Background Ambient Glow */}
          <div className="absolute inset-0 bg-radial from-indigo-950/20 via-transparent to-transparent pointer-events-none" />

          {/* VIEW MODE 1: REALISTIC PHONE FRAME (Requested: camera ratio should be the size of the phone) */}
          {viewMode === 'phone' ? (
            <div className="relative h-full max-h-[640px] aspect-[9/18.5] max-w-full flex items-center justify-center">
              {/* Smartphone Outer Metallic Bezel */}
              <div className="relative w-full h-full bg-slate-900 border-4 border-slate-700/80 rounded-[38px] p-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.8)] flex flex-col ring-1 ring-white/10 overflow-hidden">
                {/* Phone Speaker Slit & Front Camera Punch Hole */}
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center space-x-2 pointer-events-none">
                  <div className="w-12 h-1 bg-slate-800 rounded-full" />
                  <div className="w-2.5 h-2.5 bg-slate-950 rounded-full border border-slate-800" />
                </div>

                {/* Phone Screen Display Area */}
                <div className="relative flex-1 w-full bg-black rounded-[28px] overflow-hidden flex items-center justify-center">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onPlaying={() => setIsWebRtcPlaying(true)}
                    onTimeUpdate={() => setIsWebRtcPlaying(true)}
                    className={`w-full h-full object-cover ${isWebRtcPlaying ? 'block' : (liveFallbackFrame ? 'hidden' : 'block')}`}
                  />

                  {/* Fallback Live Camera Feed from Phone */}
                  {!isWebRtcPlaying && liveFallbackFrame && (
                    <img
                      src={liveFallbackFrame}
                      alt="Phone Live Camera"
                      className="w-full h-full object-cover animate-fade-in"
                    />
                  )}

                  {/* Audio receiver element */}
                  <audio ref={audioRef} autoPlay />

                  {/* Connecting / Standby State Overlay inside Phone Screen (only shown if neither WebRTC nor frame relay has arrived) */}
                  {!isWebRtcPlaying && !liveFallbackFrame && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-950/85 backdrop-blur-xs text-center z-10">
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
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between pointer-events-none z-10">
                    <span className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-md text-[10px] font-mono text-emerald-400 flex items-center space-x-1">
                      <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />
                      <span>{isWebRtcPlaying ? 'LIVE (WebRTC)' : (liveFallbackFrame ? 'LIVE (Relay)' : 'CONNECTING')}</span>
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
                onPlaying={() => setIsWebRtcPlaying(true)}
                onTimeUpdate={() => setIsWebRtcPlaying(true)}
                className={`w-full h-full object-contain ${isWebRtcPlaying ? 'block' : (liveFallbackFrame ? 'hidden' : 'block')}`}
              />

              {!isWebRtcPlaying && liveFallbackFrame && (
                <img
                  src={liveFallbackFrame}
                  alt="Phone Live Camera"
                  className="w-full h-full object-contain animate-fade-in"
                />
              )}

              <audio ref={audioRef} autoPlay />

              {!isWebRtcPlaying && !liveFallbackFrame && (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-950/85 backdrop-blur-xs text-center z-10">
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
              <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between pointer-events-none z-10">
                <span className="px-2.5 py-1 bg-black/70 backdrop-blur-md border border-white/10 rounded-md text-xs font-mono text-emerald-400 flex items-center space-x-1.5">
                  <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
                  <span>{isWebRtcPlaying ? 'LIVE (WebRTC 60fps)' : (liveFallbackFrame ? 'LIVE (Relay)' : 'CONNECTING')}</span>
                </span>
                <span className="px-2.5 py-1 bg-black/70 backdrop-blur-md border border-white/10 rounded-md text-xs font-mono text-slate-300">
                  {videoResolution}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM ACTION BUTTONS CONSOLE (make all these buttons work) */}
        <div className="px-5 py-3 bg-slate-900 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3 shrink-0">
          {/* Left: Remote Control Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Switch Camera */}
            <button
              type="button"
              onClick={handleRemoteSwitchCamera}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold flex items-center space-x-2 transition cursor-pointer shadow-xs active:scale-95"
              title="Flip between Rear and Front phone camera"
            >
              <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
              <span>Switch Camera</span>
            </button>

            {/* Toggle Flashlight / Torch */}
            <button
              type="button"
              onClick={handleRemoteToggleTorch}
              className={`px-3.5 py-2 border rounded-xl text-xs font-semibold flex items-center space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isTorchOn
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Toggle Phone LED Flashlight / Torch"
            >
              {isTorchOn ? <Zap className="w-3.5 h-3.5 text-amber-400 fill-amber-400" /> : <ZapOff className="w-3.5 h-3.5 text-slate-400" />}
              <span>Flashlight {isTorchOn ? 'ON' : 'OFF'}</span>
            </button>

            {/* Mute Audio */}
            <button
              type="button"
              onClick={toggleAudio}
              className={`px-3.5 py-2 border rounded-xl text-xs font-semibold flex items-center space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                isAudioMuted
                  ? 'bg-rose-500/20 border-rose-500/30 text-rose-300'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title={isAudioMuted ? 'Unmute Phone Speaker Audio' : 'Mute Phone Audio'}
            >
              {isAudioMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400" />}
              <span>{isAudioMuted ? 'Unmute Audio' : 'Mute Audio'}</span>
            </button>

            {/* Pause / Resume Video */}
            <button
              type="button"
              onClick={toggleVideoPlayback}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs font-semibold flex items-center space-x-2 transition cursor-pointer shadow-xs active:scale-95"
              title="Pause or Resume Video Stream"
            >
              {isVideoPaused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
              <span>{isVideoPaused ? 'Resume Video' : 'Pause Video'}</span>
            </button>

            {/* HD Snapshot */}
            <button
              type="button"
              onClick={handleTakeSnapshot}
              className={`px-3.5 py-2 border rounded-xl text-xs font-semibold flex items-center space-x-2 transition cursor-pointer shadow-xs active:scale-95 ${
                snapshotSuccess
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
              }`}
              title="Save high-resolution photo from stream"
            >
              <Download className="w-3.5 h-3.5 text-indigo-400" />
              <span>{snapshotSuccess ? 'Snapshot Saved!' : 'Take Snapshot'}</span>
            </button>
          </div>

          {/* Right: Diagnostics & Disconnect */}
          <div className="flex items-center space-x-3 text-xs">
            <button
              type="button"
              onClick={handleRetryIce}
              className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded-lg text-[11px] font-mono flex items-center space-x-1.5 transition cursor-pointer border border-slate-700/60"
              title="Reconnect WebRTC PeerConnection"
            >
              <Wifi className="w-3.5 h-3.5 text-indigo-400" />
              <span>Reconnect ICE</span>
            </button>

            <span className="text-slate-500 font-mono text-[11px]">
              Res: <strong className="text-slate-300 font-normal">{videoResolution}</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
