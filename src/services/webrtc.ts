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
  // Fast public STUN (kept concise so ICE gathering completes quickly)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Public Open Relay TURN for strict NAT / mobile carrier traversal
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

export const CUSTOM_ICE_STORAGE_KEY = 'beampair_custom_ice_servers';

export function getStoredCustomIceServers(): RTCIceServer[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CUSTOM_ICE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => s && s.urls);
    }
  } catch {}
  return [];
}

export function saveCustomIceServers(servers: RTCIceServer[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (!servers || servers.length === 0) {
      localStorage.removeItem(CUSTOM_ICE_STORAGE_KEY);
    } else {
      localStorage.setItem(CUSTOM_ICE_STORAGE_KEY, JSON.stringify(servers));
    }
  } catch {}
}

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const customServers = getStoredCustomIceServers();
  const dedupe = (list: RTCIceServer[]): RTCIceServer[] => {
    const seen = new Set<string>();
    return list.filter((srv) => {
      const key = `${Array.isArray(srv.urls) ? srv.urls.join(',') : srv.urls}:${srv.username || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
    return dedupe([...customServers, ...DEFAULT_STUN_TURN_SERVERS]);
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch('/api/webrtc/ice-servers', { signal: controller.signal });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return dedupe([...customServers, ...data.iceServers, ...DEFAULT_STUN_TURN_SERVERS]);
      }
    }
  } catch (err) {
    console.warn('[WebRTC] Server ICE config route fallback:', err);
  } finally {
    clearTimeout(timeoutId);
  }
  return dedupe([...customServers, ...DEFAULT_STUN_TURN_SERVERS]);
}

export async function testIceConnectivity(
  servers?: RTCIceServer[]
): Promise<{ hasHost: boolean; hasSrflx: boolean; hasRelay: boolean; rttMs: number }> {
  const start = performance.now();
  const iceServers = servers && servers.length > 0 ? servers : await fetchIceServers();
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 0 });
  pc.createDataChannel('ice_probe');

  let hasHost = false;
  let hasSrflx = false;
  let hasRelay = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        pc.close();
      } catch {}
      resolve({
        hasHost,
        hasSrflx,
        hasRelay,
        rttMs: Math.round(performance.now() - start),
      });
    };

    const timer = setTimeout(finish, 3200);

    pc.onicecandidate = (evt) => {
      if (!evt.candidate) {
        clearTimeout(timer);
        finish();
        return;
      }
      const cand = evt.candidate.candidate || '';
      if (cand.includes(' typ host')) hasHost = true;
      if (cand.includes(' typ srflx')) hasSrflx = true;
      if (cand.includes(' typ relay')) hasRelay = true;
      if (hasSrflx && hasRelay) {
        clearTimeout(timer);
        finish();
      }
    };

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timer);
        finish();
      });
  });
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

  private lastStatsBytes = 0;
  private lastStatsTime = 0;
  private talkbackTrack: MediaStreamTrack | null = null;
  public currentQuality: 'saver' | 'balanced' | 'hd' = 'balanced';

  private preferHardwareVideoCodecs(transceiver: RTCRtpTransceiver): void {
    try {
      if (typeof (transceiver as any).setCodecPreferences !== 'function') return;
      const caps = RTCRtpReceiver.getCapabilities?.('video') || RTCRtpSender.getCapabilities?.('video');
      if (!caps?.codecs?.length) return;

      // Prioritize hardware-accelerated H264 and fast VP8 over software-heavy VP9/AV1 on mobile phones
      const h264 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
      const vp8 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8');
      const rest = caps.codecs.filter((c) => {
        const mime = c.mimeType.toLowerCase();
        return mime !== 'video/h264' && mime !== 'video/vp8';
      });
      const ordered = [...h264, ...vp8, ...rest];
      if (ordered.length > 0) {
        (transceiver as any).setCodecPreferences(ordered);
      }
    } catch {
      // Safely ignore on browsers that do not expose setCodecPreferences
    }
  }

  async init(role: 'admin' | 'device'): Promise<void> {
    this.role = role;
    this.iceServers = await fetchIceServers();

    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
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

    // Track handling: configure ultra-low-latency receiver playout and deliver stream to Admin/Phone UI
    this.peerConnection.ontrack = (event) => {
      if (event.receiver) {
        try {
          if ('playoutDelayHint' in event.receiver) {
            (event.receiver as any).playoutDelayHint = 0;
          }
          if ('jitterBufferTarget' in event.receiver) {
            (event.receiver as any).jitterBufferTarget = 0;
          }
        } catch {}
      }

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
      const streamToPass = event.streams && event.streams[0] ? event.streams[0] : this.remoteStream;
      if (this.onRemoteStreamTrack) {
        this.onRemoteStreamTrack(streamToPass, event.track);
      }
    };

    // Setup RTCDataChannel for instantaneous remote control commands (camera flip, torch, mute, quality, talkback)
    if (role === 'admin') {
      try {
        const dc = this.peerConnection.createDataChannel('support_control', {
          ordered: true,
        });
        this.setupDataChannel(dc);
      } catch (err) {
        console.warn('DataChannel create warning:', err);
      }

      // Add transceivers: recvonly video + sendrecv audio (supports instant Push-to-Talk without renegotiation)
      try {
        const videoTransceiver = this.peerConnection.addTransceiver('video', { direction: 'recvonly' });
        this.preferHardwareVideoCodecs(videoTransceiver);
        this.peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
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

    // Strategy 1: Force exact facingMode with smooth mobile hardware resolution (640x480 / 854x480 @ 30fps)
    const constraintsExact: MediaStreamConstraints = {
      video: specificDeviceId
        ? { deviceId: { exact: specificDeviceId }, width: { ideal: 854, max: 960 }, height: { ideal: 480, max: 720 }, frameRate: { ideal: 30, max: 30 } }
        : {
            facingMode: { exact: facingMode },
            width: { ideal: 854, max: 960 },
            height: { ideal: 480, max: 720 },
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
                  width: { ideal: 854, max: 960 },
                  height: { ideal: 480, max: 720 },
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
                  width: { ideal: 640, max: 960 },
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

  private getQualityProfile(quality: 'saver' | 'balanced' | 'hd') {
    if (quality === 'saver') {
      return { width: 640, height: 360, frameRate: 24, maxBitrate: 320_000, scaleDown: 1.5 };
    }
    if (quality === 'hd') {
      return { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_400_000, scaleDown: 1 };
    }
    return { width: 854, height: 480, frameRate: 30, maxBitrate: 650_000, scaleDown: 1 };
  }

  private async tuneVideoSenderParameters(sender: RTCRtpSender): Promise<void> {
    const profile = this.getQualityProfile(this.currentQuality);
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.degradationPreference = 'maintain-framerate';
      params.encodings[0].maxBitrate = profile.maxBitrate;
      params.encodings[0].maxFramerate = profile.frameRate;
      if ('scaleResolutionDownBy' in params.encodings[0]) {
        params.encodings[0].scaleResolutionDownBy = profile.scaleDown;
      }
      if ('networkPriority' in params.encodings[0]) {
        (params.encodings[0] as any).networkPriority = 'high';
      }
      await sender.setParameters(params);
    } catch {
      // Some mobile WebViews restrict sender.setParameters; ignore safely
    }
  }

  async setVideoQuality(quality: 'saver' | 'balanced' | 'hd'): Promise<void> {
    this.currentQuality = quality;
    const profile = this.getQualityProfile(quality);

    if (this.currentVideoTrack && !this.isScreenSharingActive) {
      try {
        await this.currentVideoTrack.applyConstraints({
          width: { ideal: profile.width, max: Math.max(profile.width, 960) },
          height: { ideal: profile.height, max: Math.max(profile.height, 720) },
          frameRate: { ideal: profile.frameRate, max: 30 },
        });
      } catch {}
    }

    if (this.peerConnection) {
      const sender = this.peerConnection
        .getSenders()
        .find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        await this.tuneVideoSenderParameters(sender);
      }
    }
  }

  // Two-Way Push-to-Talk Audio (Admin mic -> Phone speaker)
  async startTalkback(): Promise<MediaStreamTrack> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    this.stopTalkback();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    this.talkbackTrack = track;

    const audioTransceiver = this.peerConnection.getTransceivers().find((t) => {
      return t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio';
    });

    if (audioTransceiver) {
      audioTransceiver.direction = 'sendrecv';
      await audioTransceiver.sender.replaceTrack(track);
    }
    return track;
  }

  async stopTalkback(): Promise<void> {
    if (this.peerConnection) {
      const audioTransceiver = this.peerConnection.getTransceivers().find((t) => {
        return t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio';
      });
      if (audioTransceiver?.sender) {
        try {
          await audioTransceiver.sender.replaceTrack(null);
        } catch {}
      }
    }
    if (this.talkbackTrack) {
      try {
        this.talkbackTrack.stop();
      } catch {}
      this.talkbackTrack = null;
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
          this.preferHardwareVideoCodecs(t);
          t.direction = 'sendonly';
          try {
            if (typeof (t.sender as any).setStreams === 'function') {
              (t.sender as any).setStreams(this.localStream);
            }
          } catch {}
          if (t.sender?.track?.id !== videoTrack.id) {
            ops.push(
              t.sender
                .replaceTrack(videoTrack)
                .then(() => this.tuneVideoSenderParameters(t.sender))
                .catch((err) => console.warn('Video bind replaceTrack warning:', err))
            );
          }
        } else {
          t.direction = 'inactive';
        }
      } else if (kind === 'audio') {
        // Keep sendrecv so phone sends mic AND receives Admin Push-to-Talk audio seamlessly
        t.direction = audioTrack ? 'sendrecv' : 'recvonly';
        if (audioTrack) {
          try {
            if (typeof (t.sender as any).setStreams === 'function') {
              (t.sender as any).setStreams(this.localStream);
            }
          } catch {}
          if (t.sender?.track?.id !== audioTrack.id) {
            ops.push(
              t.sender
                .replaceTrack(audioTrack)
                .catch((err) => console.warn('Audio bind replaceTrack warning:', err))
            );
          }
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

  // Live WebRTC transport & playout metrics for Admin diagnostics
  async getConnectionStats(): Promise<{
    transport: 'direct' | 'relay' | 'unknown';
    fps: number | null;
    rttMs: number | null;
    bitrateKbps: number | null;
  }> {
    if (!this.peerConnection) {
      return { transport: 'unknown', fps: null, rttMs: null, bitrateKbps: null };
    }
    try {
      const stats = await this.peerConnection.getStats();
      let transport: 'direct' | 'relay' | 'unknown' = 'unknown';
      let fps: number | null = null;
      let rttMs: number | null = null;
      let bitrateKbps: number | null = null;
      let selectedPairId: string | null = null;
      let totalBytes = 0;

      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          if (typeof report.framesPerSecond === 'number') {
            fps = Math.round(report.framesPerSecond);
          }
          if (typeof report.bytesReceived === 'number') {
            totalBytes = report.bytesReceived;
          }
        }
      });

      if (totalBytes > 0) {
        const now = Date.now();
        if (this.lastStatsTime > 0 && now > this.lastStatsTime && totalBytes >= this.lastStatsBytes) {
          const dtSec = (now - this.lastStatsTime) / 1000;
          bitrateKbps = Math.round(((totalBytes - this.lastStatsBytes) * 8) / dtSec / 1000);
        }
        this.lastStatsBytes = totalBytes;
        this.lastStatsTime = now;
      }

      stats.forEach((report) => {
        const isPair =
          report.type === 'candidate-pair' &&
          (report.id === selectedPairId || report.nominated || report.state === 'succeeded');
        if (isPair) {
          if (typeof report.currentRoundTripTime === 'number') {
            rttMs = Math.round(report.currentRoundTripTime * 1000);
          }
          if (report.remoteCandidateId) {
            const remoteCand = stats.get(report.remoteCandidateId);
            if (remoteCand?.candidateType === 'relay') {
              transport = 'relay';
            } else if (remoteCand?.candidateType) {
              transport = 'direct';
            }
          }
          if (transport === 'unknown' && report.localCandidateId) {
            const localCand = stats.get(report.localCandidateId);
            if (localCand?.candidateType === 'relay') {
              transport = 'relay';
            } else if (localCand?.candidateType) {
              transport = 'direct';
            }
          }
        }
      });

      return { transport, fps, rttMs, bitrateKbps };
    } catch {
      return { transport: 'unknown', fps: null, rttMs: null, bitrateKbps: null };
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
    if (this.talkbackTrack) {
      try {
        this.talkbackTrack.stop();
      } catch {}
      this.talkbackTrack = null;
    }
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
