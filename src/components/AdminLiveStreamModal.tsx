import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  PhoneOff,
  Volume2,
  VolumeX,
  RefreshCw,
  Monitor,
  Maximize2,
  Minimize2,
  Activity,
  ShieldCheck,
  AlertCircle,
  Camera,
  Mic,
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
  const [connectionState, setConnectionState] = useState<string>('Initializing WebRTC...');
  const [iceState, setIceState] = useState<string>('new');
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isEnding, setIsEnding] = useState<boolean>(false);
  const [videoResolution, setVideoResolution] = useState<string>('Awaiting stream...');
  const [streamStartedAt] = useState<number>(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

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

  // WebRTC Peer Connection Setup for Admin (Receiver)
  useEffect(() => {
    const webrtc = new WebRTCManager();
    webrtcRef.current = webrtc;

    async function startAdminConnection() {
      try {
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
          if (track.kind === 'video' && videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            videoRef.current.play().catch(console.warn);
          }
          if (track.kind === 'audio' && audioRef.current) {
            audioRef.current.srcObject = remoteStream;
            audioRef.current.play().catch(console.warn);
          }
        };

        // Create WebRTC Offer
        const offer = await webrtc.createOffer();
        if (offer.sdp) {
          await setSessionOffer(session.sessionId, offer.sdp);
          setConnectionState('Offer sent, awaiting device answer...');
        }

        // Listen for ICE candidates from secondary phone
        unsubscribeCandidatesRef.current = listenToIceCandidates(
          session.sessionId,
          'admin',
          (candidate) => {
            webrtc.addIceCandidate(candidate);
          }
        );

        // Listen to Session document for device's SDP Answer & status
        unsubscribeSessionRef.current = listenToSession(session.sessionId, async (updatedSession) => {
          if (updatedSession.status === 'terminated') {
            setConnectionState('Session terminated by ' + (updatedSession.endedBy || 'peer'));
            handleTeardown();
            return;
          }

          // If answer is present and not yet set
          if (updatedSession.sdpAnswer && !webrtc.peerConnection?.remoteDescription) {
            try {
              await webrtc.setRemoteDescription({
                type: 'answer',
                sdp: updatedSession.sdpAnswer,
              });
              setConnectionState('Connected');
            } catch (err) {
              console.error('Error applying remote answer:', err);
            }
          }
        });
      } catch (err) {
        console.error('Admin WebRTC initiation failed:', err);
        setConnectionState('Connection failed');
      }
    }

    startAdminConnection();

    return () => {
      handleTeardown();
    };
  }, [session.sessionId]);

  const handleTeardown = () => {
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
  };

  // Listen for video metadata to show real resolution
  const handleVideoLoadedMetadata = () => {
    if (videoRef.current) {
      const w = videoRef.current.videoWidth;
      const h = videoRef.current.videoHeight;
      setVideoResolution(`${w} x ${h}px`);
    }
  };

  // Toggle Admin speaker audio mute
  const toggleAudio = () => {
    if (audioRef.current) {
      audioRef.current.muted = !isAudioMuted;
      setIsAudioMuted(!isAudioMuted);
    }
  };

  // Toggle fullscreen
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

  // Admin-Only Disconnect Command
  const handleAdminDisconnect = async () => {
    setIsEnding(true);
    try {
      // 1. Contact trusted backend security disconnect endpoint
      await fetch('/api/admin/disconnect-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session.sessionId,
          adminId,
          reason: 'Terminated by administrator from live stream console',
        }),
      });

      // 2. Mark session as terminated in Firestore
      await terminateSession(session.sessionId, 'admin', 'Administrative disconnect command');

      // 3. Clear active session on device document
      await updateDeviceHeartbeat(device.deviceId, { currentSessionId: null });

      // 4. Record security audit log
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-md animate-fade-in">
      <div
        ref={containerRef}
        className="relative bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-5xl h-[88vh] max-h-[850px] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Stream Top Header Bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800/80 bg-slate-900/90">
          <div className="flex items-center space-x-3">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500" />
            </span>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-white tracking-wide">{device.deviceName}</h3>
                <span className="px-2 py-0.5 bg-slate-800 text-slate-300 font-mono text-[10px] rounded-md">
                  {device.platform.toUpperCase()}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">
                Duration: {timeFormatted} • WebRTC: {connectionState}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={toggleAudio}
              className={`p-2 rounded-xl text-xs font-medium border transition ${
                isAudioMuted
                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-400'
                  : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
              title={isAudioMuted ? 'Unmute Audio Playback' : 'Mute Audio Playback'}
            >
              {isAudioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>

            <button
              onClick={toggleFullscreen}
              className="p-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl transition"
              title="Toggle Fullscreen"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            {/* Admin Disconnect Button */}
            <button
              onClick={handleAdminDisconnect}
              disabled={isEnding}
              className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center space-x-1.5 shadow-lg shadow-rose-600/25 transition"
            >
              <PhoneOff className="w-4 h-4" />
              <span>Admin Disconnect</span>
            </button>
          </div>
        </div>

        {/* Video Stage Area */}
        <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            onLoadedMetadata={handleVideoLoadedMetadata}
            className="w-full h-full object-contain"
          />
          {/* Audio element for receiver */}
          <audio ref={audioRef} autoPlay />

          {/* Placeholder when waiting for media */}
          {connectionState !== 'Connected' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-slate-950/80 backdrop-blur-xs text-center">
              <div className="w-12 h-12 border-3 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin mb-4" />
              <h4 className="text-white text-sm font-semibold">Establishing Real WebRTC PeerConnection</h4>
              <p className="text-xs text-slate-400 mt-1 max-w-sm">
                Negotiating SDP Offer/Answer with secondary device over Firestore signaling and ICE STUN/TURN servers.
              </p>
              <span className="mt-3 px-3 py-1 bg-slate-900 border border-slate-800 text-indigo-400 font-mono text-[11px] rounded-lg">
                Status: {connectionState} (ICE: {iceState})
              </span>
            </div>
          )}

          {/* Stream Info Overlay */}
          <div className="absolute bottom-3 left-3 bg-slate-950/80 backdrop-blur-md border border-slate-800/80 px-3 py-2 rounded-xl flex items-center space-x-3 text-xs text-slate-300">
            <span className="flex items-center space-x-1 text-emerald-400">
              <Activity className="w-3.5 h-3.5" />
              <span className="font-mono text-[11px]">{videoResolution}</span>
            </span>
            <span className="text-slate-600">•</span>
            <span className="flex items-center space-x-1 text-slate-400 text-[11px]">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
              <span>Authorized Support Session</span>
            </span>
          </div>
        </div>

        {/* Bottom Diagnostics Strip */}
        <div className="px-5 py-2.5 bg-slate-900/90 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <span>ICE State: <strong className="text-slate-200 font-mono">{iceState}</strong></span>
            <span>Session ID: <strong className="text-slate-200 font-mono truncate max-w-[140px] inline-block align-bottom">{session.sessionId}</strong></span>
          </div>
          <div className="text-slate-500 text-[10px]">
            Real-time peer-to-peer / TURN relayed WebRTC stream
          </div>
        </div>
      </div>
    </div>
  );
};
