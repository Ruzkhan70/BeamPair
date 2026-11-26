/**
 * Real WebRTC PeerConnection, STUN/TURN, and Media Capture Service
 * Supports Camera (user/environment), Microphone, Screen Sharing, and Remote DataChannel Controls
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_STUN_TURN_SERVERS: RTCIceServer[] = [
  // Google Public STUN
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  // Cloudflare & Mozilla & Twilio STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  // Public Open Relay STUN & TURN
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
    return DEFAULT_STUN_TURN_SERVERS;
  }
  try {
    const res = await fetch('/api/webrtc/ice-servers');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        // Combine and deduplicate by serialized URLs so ICE checks don't stall on duplicates
        const merged = [...data.iceServers, ...DEFAULT_STUN_TURN_SERVERS];
        const seen = new Set<string>();
        return merged.filter((srv) => {
          const key = Array.isArray(srv.urls) ? srv.urls.join(',') : srv.urls;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }
  } catch (err) {
    console.warn('[WebRTC] Server ICE config route not reachable, using resilient STUN+TURN defaults:', err);
  }
  return DEFAULT_STUN_TURN_SERVERS;
}

export class WebRTCManager {
  public peerConnection: RTCPeerConnection | null = null;
  public dataChannel: RTCDataChannel | null = null;
  public localStream: MediaStream = new MediaStream();
  public remoteStream: MediaStream = new MediaStream();
  private iceServers: RTCIceServer[] = DEFAULT_STUN_TURN_SERVERS;
  private role: 'admin' | 'device' = 'device';

  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;
  public onIceConnectionStateChange: ((state: RTCIceConnectionState) => void) | null = null;
  public onRemoteStreamTrack: ((stream: MediaStream, track: MediaStreamTrack) => void) | null = null;
  public onScreenShareEnded: (() => void) | null = null;
  public onControlCommand: ((command: { action: string; value?: any }) => void) | null = null;

  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;
  private currentVideoTrack: MediaStreamTrack | null = null;
  public isTorchOn = false;
  public lastFacingMode: 'user' | 'environment' = 'environment';
  public isScreenSharingActive = false;
  private keepAliveAudioCtx: AudioContext | null = null;
  private keepAliveAudioEl: HTMLAudioElement | null = null;
  private webLockAbortController: AbortController | null = null;
  private isClosing = false;

  async init(role: 'admin' | 'device'): Promise<void> {
    this.role = role;
    this.iceServers = await fetchIceServers();

    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection && this.onConnectionStateChange) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (this.peerConnection && this.onIceConnectionStateChange) {
        this.onIceConnectionStateChange(this.peerConnection.iceConnectionState);
      }
    };

    // Track handling: add event.track directly into remoteStream and trigger listener
    this.peerConnection.ontrack = (event) => {
      if (event.track) {
        if (!this.remoteStream.getTracks().some((t) => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
      }
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!this.remoteStream.getTracks().some((t) => t.id === track.id)) {
            this.remoteStream.addTrack(track);
          }
        });
      }
      const streamToPass = (event.streams && event.streams[0]) ? event.streams[0] : this.remoteStream;
      if (this.onRemoteStreamTrack) {
        this.onRemoteStreamTrack(streamToPass, event.track);
      }
    };

    // Setup RTCDataChannel for instantaneous remote control commands (camera flip, torch, mute)
    if (role === 'admin') {
      try {
        const dc = this.peerConnection.createDataChannel('support_control', {
          ordered: true,
        });
        this.setupDataChannel(dc);
      } catch (err) {
        console.warn('DataChannel create warning:', err);
      }

      // Add transceivers for receiving video and audio from secondary device
      try {
        this.peerConnection.addTransceiver('video', { direction: 'recvonly' });
        this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      } catch (err) {
        console.warn('Transceiver add warning:', err);
      }
    } else {
      // Device listens for incoming DataChannel
      this.peerConnection.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
    }
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.onControlCommand) {
          this.onControlCommand(data);
        }
      } catch (err) {
        console.warn('Error parsing data channel message:', err);
      }
    };
  }

  sendControlCommand(action: string, value?: any): boolean {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({ action, value, timestamp: Date.now() }));
        return true;
      } catch (err) {
        console.warn('DataChannel send error:', err);
      }
    }
    return false;
  }

  private wakeLock: any = null;

  // Enumerate all available camera lenses on the device (wide, ultra-wide, telephoto, front)
  static async getAvailableCameras(): Promise<MediaDeviceInfo[]> {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  // Expose active local video track for direct ImageCapture background frame reading
  getActiveVideoTrack(): MediaStreamTrack | null {
    return this.currentVideoTrack || this.localStream.getVideoTracks()[0] || null;
  }

  // Request screen wake lock so the Android phone screen doesn't time out during support
  async requestWakeLock(): Promise<void> {
    try {
      if (this.isClosing || document.visibilityState !== 'visible') return;
      if ('wakeLock' in navigator && (navigator as any).wakeLock && !this.wakeLock) {
        const lock = await (navigator as any).wakeLock.request('screen');
        this.wakeLock = lock;
        lock.addEventListener?.('release', () => {
          if (this.wakeLock === lock) {
            this.wakeLock = null;
          }
        });
      }
    } catch (err) {
      console.warn('WakeLock note:', err);
    }
  }

  releaseWakeLock(): void {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch {}
      this.wakeLock = null;
    }
  }

  // Hold Web Lock so Android Chrome avoids freezing/discarding background streaming tabs
  acquireWebLock(): void {
    try {
      if (this.webLockAbortController || !('locks' in navigator) || !navigator.locks) return;
      const controller = new AbortController();
      this.webLockAbortController = controller;
      navigator.locks
        .request(
          'beampair_live_streaming_lock',
          { signal: controller.signal },
          () =>
            new Promise<void>((resolve) => {
              controller.signal.addEventListener('abort', () => resolve(), { once: true });
            })
        )
        .catch(() => {});
    } catch {
      // Ignore if Web Locks unsupported
    }
  }

  releaseWebLock(): void {
    if (this.webLockAbortController) {
      try {
        this.webLockAbortController.abort();
      } catch {}
      this.webLockAbortController = null;
    }
  }

  // Configure background video playback without triggering an automatic PiP popup window
  enableAutoPiP(videoEl: HTMLVideoElement | null, onPiPChange?: (active: boolean) => void): void {
    if (!videoEl) return;
    try {
      (videoEl as any).autoPictureInPicture = false;
      videoEl.disablePictureInPicture = false;
    } catch {}

    if (onPiPChange) {
      videoEl.onenterpictureinpicture = () => onPiPChange(true);
      videoEl.onleavepictureinpicture = () => onPiPChange(false);
    }
  }

  // Keep Android foreground media service & WebRTC streaming active when middle/home button is pressed
  startKeepAliveAudio(): void {
    if (this.isClosing) return;
    this.acquireWebLock();

    try {
      if (!this.keepAliveAudioCtx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          this.keepAliveAudioCtx = new AudioCtx();
          const osc = this.keepAliveAudioCtx.createOscillator();
          const gain = this.keepAliveAudioCtx.createGain();
          gain.gain.value = 0.00002; // virtually inaudible, keeps mobile OS audio pipeline live
          osc.connect(gain);

          // Route into MediaStream -> real <audio> tag so Android promotes tab to Media Foreground Notification
          const dest = this.keepAliveAudioCtx.createMediaStreamDestination();
          gain.connect(dest);
          osc.start();

          if (!this.keepAliveAudioEl) {
            const audio = document.createElement('audio');
            audio.srcObject = dest.stream;
            audio.loop = true;
            audio.muted = false;
            audio.volume = 0.01;
            audio.setAttribute('playsinline', '');
            this.keepAliveAudioEl = audio;
          }
        }
      }

      if (this.keepAliveAudioCtx && this.keepAliveAudioCtx.state === 'suspended') {
        this.keepAliveAudioCtx.resume().catch(() => {});
      }

      if (this.keepAliveAudioEl && this.keepAliveAudioEl.paused) {
        this.keepAliveAudioEl.play().catch(() => {});
      }

      if ('mediaSession' in navigator && navigator.mediaSession) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'BeamPair Live Camera Stream',
            artist: 'Remote Session Active in Background',
            album: 'BeamPair Remote Support',
          });
          navigator.mediaSession.playbackState = 'playing';
        } catch {}
      }
    } catch (err) {
      console.warn('Keep-alive audio warning:', err);
    }
  }

  stopKeepAliveAudio(): void {
    this.releaseWebLock();
    if (this.keepAliveAudioEl) {
      try {
        this.keepAliveAudioEl.pause();
        this.keepAliveAudioEl.srcObject = null;
      } catch {}
      this.keepAliveAudioEl = null;
    }
    if (this.keepAliveAudioCtx) {
      try {
        this.keepAliveAudioCtx.close();
      } catch {}
      this.keepAliveAudioCtx = null;
    }
    if ('mediaSession' in navigator && navigator.mediaSession) {
      try {
        navigator.mediaSession.playbackState = 'none';
        navigator.mediaSession.setActionHandler('enterpictureinpicture' as any, null);
      } catch {}
    }
  }

  // Camera capture with deterministic front/rear switching & low-latency Android constraints
  async startCamera(
    facingMode: 'user' | 'environment' = 'environment',
    specificDeviceId?: string
  ): Promise<MediaStreamTrack> {
    this.lastFacingMode = facingMode;
    this.isScreenSharingActive = false;
    this.isTorchOn = false;

    const currentDeviceId = this.currentVideoTrack?.getSettings?.().deviceId;

    // Stop any existing video tracks first so Android releases the previous camera lens cleanly
    this.localStream.getVideoTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });
    this.currentVideoTrack = null;

    let stream: MediaStream | null = null;

    // Strategy 1: Force exact facingMode with smooth 540p/720p @ 30fps so upload & TURN never lag
    const constraintsExact: MediaStreamConstraints = {
      video: specificDeviceId
        ? { deviceId: { exact: specificDeviceId }, width: { ideal: 960, max: 1280 }, height: { ideal: 540, max: 720 }, frameRate: { ideal: 30, max: 30 } }
        : {
            facingMode: { exact: facingMode },
            width: { ideal: 960, max: 1280 },
            height: { ideal: 540, max: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraintsExact);
    } catch (exactErr) {
      // Strategy 2: Match camera lens by deviceId label (handles multi-lens Androids where exact facingMode fails)
      if (!specificDeviceId) {
        try {
          const cameras = await WebRTCManager.getAvailableCameras();
          if (cameras.length > 1) {
            const wantFront = facingMode === 'user';
            const matchedCam =
              cameras.find((c) => {
                const lbl = (c.label || '').toLowerCase();
                return wantFront
                  ? lbl.includes('front') || lbl.includes('user') || lbl.includes('selfie')
                  : lbl.includes('back') || lbl.includes('rear') || lbl.includes('environment');
              }) || cameras.find((c) => c.deviceId && c.deviceId !== currentDeviceId);

            if (matchedCam?.deviceId) {
              stream = await navigator.mediaDevices.getUserMedia({
                video: {
                  deviceId: { exact: matchedCam.deviceId },
                  width: { ideal: 960, max: 1280 },
                  height: { ideal: 540, max: 720 },
                  frameRate: { ideal: 30, max: 30 },
                },
                audio: false,
              });
            }
          }
        } catch {
          // Continue to ideal fallback
        }
      }

      if (!stream) {
        console.warn('Exact camera constraint failed, using ideal fallback:', exactErr);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: specificDeviceId
              ? { deviceId: { exact: specificDeviceId } }
              : {
                  facingMode: { ideal: facingMode },
                  width: { ideal: 854, max: 1280 },
                  height: { ideal: 480, max: 720 },
                  frameRate: { ideal: 30, max: 30 },
                },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: specificDeviceId ? { deviceId: { exact: specificDeviceId } } : { facingMode: { ideal: facingMode } },
            audio: false,
          });
        }
      }
    }

    const videoTrack = stream.getVideoTracks()[0];
    try {
      if ('contentHint' in videoTrack) {
        videoTrack.contentHint = 'motion';
      }
    } catch {}
    this.currentVideoTrack = videoTrack;
    this.localStream.addTrack(videoTrack);

    // Push onto PeerConnection if remote offer already set transceivers (or we're admin)
    if (this.role === 'admin' || this.isRemoteDescriptionSet) {
      this.replaceOrAddTrack(videoTrack);
    }

    // Keep screen awake and keep background audio session alive
    await this.requestWakeLock();
    this.startKeepAliveAudio();

    return videoTrack;
  }

  // Toggle LED Flashlight / Torch on Android device if supported
  async toggleTorch(enabled?: boolean | any): Promise<boolean> {
    if (!this.currentVideoTrack) return false;
    
    // Normalize target state from boolean or object wrapper { enabled?: boolean, value?: boolean }
    let targetState = !this.isTorchOn;
    if (typeof enabled === 'boolean') {
      targetState = enabled;
    } else if (typeof enabled === 'object' && enabled !== null) {
      if ('enabled' in enabled) targetState = Boolean(enabled.enabled);
      else if ('value' in enabled) targetState = Boolean(enabled.value);
    }

    try {
      const capabilities = (this.currentVideoTrack.getCapabilities?.() || {}) as any;
      if (capabilities && capabilities.torch) {
        await (this.currentVideoTrack as any).applyConstraints({
          advanced: [{ torch: targetState }],
        });
        this.isTorchOn = targetState;
        return true;
      } else {
        console.warn('Torch is not supported by current active camera track (may be front camera or unexposed)');
      }
    } catch (err) {
      console.warn('Torch applyConstraints failed:', err);
    }
    return false;
  }

  getTorchState(): boolean {
    return this.isTorchOn;
  }

  // Microphone capture
  async startMicrophone(): Promise<MediaStreamTrack> {
    this.localStream.getAudioTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const audioTrack = stream.getAudioTracks()[0];
    this.localStream.addTrack(audioTrack);
    if (this.role === 'admin' || this.isRemoteDescriptionSet) {
      this.replaceOrAddTrack(audioTrack);
    }
    return audioTrack;
  }

  // Screen share capture using getDisplayMedia with Android mobile support
  async startScreenShare(): Promise<MediaStreamTrack> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported by this browser.');
    }

    // Stop current camera tracks so screen becomes active video
    this.localStream.getVideoTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });

    // Android Chrome requires simple { video: true } constraints
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      });
    } catch (err) {
      console.warn('getDisplayMedia primary failed, retrying minimal options:', err);
      stream = await (navigator.mediaDevices as any).getDisplayMedia();
    }

    const screenTrack = stream.getVideoTracks()[0];
    try {
      if ('contentHint' in screenTrack) {
        screenTrack.contentHint = 'detail';
      }
    } catch {}
    this.currentVideoTrack = screenTrack;
    this.isScreenSharingActive = true;

    // Detect when user stops sharing via browser/OS native controls
    screenTrack.onended = () => {
      this.localStream.removeTrack(screenTrack);
      this.isScreenSharingActive = false;
      if (this.onScreenShareEnded) {
        this.onScreenShareEnded();
      }
    };

    this.localStream.addTrack(screenTrack);
    if (this.role === 'admin' || this.isRemoteDescriptionSet) {
      this.replaceOrAddTrack(screenTrack);
    }

    await this.requestWakeLock();
    this.startKeepAliveAudio();

    return screenTrack;
  }

  private async tuneVideoSenderParameters(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.degradationPreference = 'maintain-framerate';
      params.encodings[0].maxBitrate = 950_000;
      params.encodings[0].maxFramerate = 30;
      await sender.setParameters(params);
    } catch {
      // Some mobile WebViews restrict sender.setParameters; ignore safely
    }
  }

  public async bindLocalTracksToPeerConnection(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.getTransceivers) return;
    const videoTrack = this.localStream.getVideoTracks()[0] || null;
    const audioTrack = this.localStream.getAudioTracks()[0] || null;

    const transceivers = this.peerConnection.getTransceivers();
    const ops: Promise<void>[] = [];

    transceivers.forEach((t) => {
      const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
      if (kind === 'video') {
        if (videoTrack) {
          t.direction = 'sendonly';
          try {
            if (typeof (t.sender as any).setStreams === 'function') {
              (t.sender as any).setStreams(this.localStream);
            }
          } catch {}
          ops.push(
            t.sender
              .replaceTrack(videoTrack)
              .then(() => this.tuneVideoSenderParameters(t.sender))
              .catch((err) => console.warn('Video bind replaceTrack warning:', err))
          );
        } else {
          t.direction = 'inactive';
        }
      } else if (kind === 'audio') {
        if (audioTrack) {
          t.direction = 'sendonly';
          try {
            if (typeof (t.sender as any).setStreams === 'function') {
              (t.sender as any).setStreams(this.localStream);
            }
          } catch {}
          ops.push(
            t.sender
              .replaceTrack(audioTrack)
              .catch((err) => console.warn('Audio bind replaceTrack warning:', err))
          );
        } else {
          t.direction = 'inactive';
        }
      }
    });

    await Promise.all(ops);
  }

  public replaceOrAddTrack(track: MediaStreamTrack): void {
    if (!this.peerConnection) return;

    // 1. Check existing transceivers first (Unified Plan standard)
    if (this.peerConnection.getTransceivers) {
      const transceivers = this.peerConnection.getTransceivers();
      const match = transceivers.find((t) => {
        return (t.sender && t.sender.track && t.sender.track.kind === track.kind) ||
               (t.receiver && t.receiver.track && t.receiver.track.kind === track.kind);
      });
      if (match && match.sender) {
        match.direction = 'sendonly';
        try {
          if (typeof (match.sender as any).setStreams === 'function') {
            (match.sender as any).setStreams(this.localStream);
          }
        } catch {}
        match.sender.replaceTrack(track).then(() => {
          if (track.kind === 'video') {
            this.tuneVideoSenderParameters(match.sender);
          }
        }).catch((err) => {
          console.warn('replaceTrack warning:', err);
        });
        return;
      }
    }

    // 2. Fall back to existing senders
    const senders = this.peerConnection.getSenders();
    const existingSender = senders.find((s) => s.track && s.track.kind === track.kind);

    if (existingSender) {
      try {
        if (typeof (existingSender as any).setStreams === 'function') {
          (existingSender as any).setStreams(this.localStream);
        }
      } catch {}
      existingSender.replaceTrack(track).then(() => {
        if (track.kind === 'video') {
          this.tuneVideoSenderParameters(existingSender);
        }
      }).catch((err) => {
        console.warn('replaceTrack warning:', err);
      });
    } else {
      try {
        const sender = this.peerConnection.addTrack(track, this.localStream);
        if (track.kind === 'video') {
          this.tuneVideoSenderParameters(sender);
        }
      } catch (err) {
        console.warn('addTrack warning:', err);
      }
    }
  }

  setAudioMuted(muted: boolean): void {
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setVideoPaused(paused: boolean): void {
    this.localStream.getVideoTracks().forEach((track) => {
      track.enabled = !paused;
    });
  }

  // Create WebRTC Offer
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    const offer = await this.peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  // Create WebRTC Answer
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');

    // Bind local media tracks to Admin's transceivers cleanly before generating Answer
    await this.bindLocalTracksToPeerConnection();

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  // Set Remote SDP (supports initial setup & ICE restart renegotiation)
  async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    this.isRemoteDescriptionSet = true;

    if (this.role === 'device' && sdp.type === 'offer') {
      await this.bindLocalTracksToPeerConnection();
    }

    // Flush any pending remote ICE candidates that arrived before SDP
    while (this.pendingRemoteCandidates.length > 0) {
      const candidate = this.pendingRemoteCandidates.shift();
      if (candidate && candidate.candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('Error adding buffered ICE candidate:', err);
        }
      }
    }
  }

  // Add ICE Candidate safely
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!candidate || !candidate.candidate) return;
    if (!this.peerConnection || !this.isRemoteDescriptionSet) {
      this.pendingRemoteCandidates.push(candidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('Failed to add ICE candidate:', err);
    }
  }

  // Restart ICE if connection dropped or failed
  async restartIce(): Promise<RTCSessionDescriptionInit | null> {
    if (!this.peerConnection) return null;
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      return offer;
    } catch (err) {
      console.warn('restartIce error:', err);
      return null;
    }
  }

  // Teardown and cleanup
  close(): void {
    this.isClosing = true;
    if (this.currentVideoTrack) {
      try {
        if (this.isTorchOn) {
          (this.currentVideoTrack as any).applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
        }
      } catch {}
      this.currentVideoTrack = null;
    }

    this.localStream.getTracks().forEach((track) => track.stop());
    this.remoteStream.getTracks().forEach((track) => track.stop());
    this.localStream = new MediaStream();
    this.remoteStream = new MediaStream();

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.ondatachannel = null;
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.releaseWakeLock();
    this.stopKeepAliveAudio();
    this.isTorchOn = false;
    this.isScreenSharingActive = false;
    this.pendingRemoteCandidates = [];
    this.isRemoteDescriptionSet = false;
  }
}
