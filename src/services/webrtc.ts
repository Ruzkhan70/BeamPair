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
  try {
    const res = await fetch('/api/webrtc/ice-servers');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        // Merge with our robust defaults to ensure fallback TURN is always present
        return [...data.iceServers, ...DEFAULT_STUN_TURN_SERVERS];
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

  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;
  public onIceConnectionStateChange: ((state: RTCIceConnectionState) => void) | null = null;
  public onRemoteStreamTrack: ((stream: MediaStream, track: MediaStreamTrack) => void) | null = null;
  public onScreenShareEnded: (() => void) | null = null;
  public onControlCommand: ((command: { action: string; value?: any }) => void) | null = null;

  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;
  private currentVideoTrack: MediaStreamTrack | null = null;
  private isTorchOn = false;

  async init(role: 'admin' | 'device'): Promise<void> {
    this.iceServers = await fetchIceServers();

    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 10,
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

  // Request screen wake lock so the Android phone screen doesn't turn off during support
  async requestWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock) {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
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

  // Camera capture with front or rear facing support & Android-resilient fallback
  async startCamera(
    facingMode: 'user' | 'environment' = 'environment',
    specificDeviceId?: string
  ): Promise<MediaStreamTrack> {
    // Stop any existing video tracks first
    this.localStream.getVideoTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });

    let stream: MediaStream | null = null;

    // Constraint strategy 1: Preferred facing or specific camera ID with 720p/1080p
    const constraintsPrimary: MediaStreamConstraints = {
      video: specificDeviceId
        ? { deviceId: { exact: specificDeviceId } }
        : {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
          },
      audio: false,
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraintsPrimary);
    } catch (primaryErr) {
      console.warn('Primary camera constraint failed, attempting basic fallback for Android compatibility:', primaryErr);
      // Constraint strategy 2: Relaxed fallback for legacy Android devices
      const fallbackConstraints: MediaStreamConstraints = {
        video: specificDeviceId
          ? { deviceId: { exact: specificDeviceId } }
          : { facingMode: { ideal: facingMode } },
        audio: false,
      };
      stream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
    }

    const videoTrack = stream.getVideoTracks()[0];
    this.currentVideoTrack = videoTrack;
    this.localStream.addTrack(videoTrack);
    this.replaceOrAddTrack(videoTrack);

    // Keep screen active on phone
    await this.requestWakeLock();

    return videoTrack;
  }

  // Toggle LED Flashlight / Torch on Android device if supported
  async toggleTorch(enabled?: boolean): Promise<boolean> {
    if (!this.currentVideoTrack) return false;
    const targetState = enabled !== undefined ? enabled : !this.isTorchOn;
    try {
      const capabilities = (this.currentVideoTrack.getCapabilities?.() || {}) as any;
      if (capabilities.torch) {
        await (this.currentVideoTrack as any).applyConstraints({
          advanced: [{ torch: targetState }],
        });
        this.isTorchOn = targetState;
        return true;
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
    this.replaceOrAddTrack(audioTrack);
    return audioTrack;
  }

  // Screen share capture using getDisplayMedia
  async startScreenShare(): Promise<MediaStreamTrack> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported by this browser.');
    }

    // Stop current camera tracks so screen becomes active video
    this.localStream.getVideoTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
      } as MediaTrackConstraints,
      audio: false,
    });

    const screenTrack = stream.getVideoTracks()[0];
    this.currentVideoTrack = screenTrack;

    // Detect when user stops sharing via browser/OS native controls
    screenTrack.onended = () => {
      this.localStream.removeTrack(screenTrack);
      if (this.onScreenShareEnded) {
        this.onScreenShareEnded();
      }
    };

    this.localStream.addTrack(screenTrack);
    this.replaceOrAddTrack(screenTrack);
    return screenTrack;
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
        match.sender.replaceTrack(track).catch((err) => {
          console.warn('replaceTrack warning:', err);
        });
        return;
      }
    }

    // 2. Fall back to existing senders
    const senders = this.peerConnection.getSenders();
    const existingSender = senders.find((s) => s.track && s.track.kind === track.kind);

    if (existingSender) {
      existingSender.replaceTrack(track).catch((err) => {
        console.warn('replaceTrack warning:', err);
      });
    } else {
      try {
        this.peerConnection.addTrack(track, this.localStream);
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

    // Ensure transceiver directions match local tracks before answering
    if (this.peerConnection.getTransceivers) {
      this.peerConnection.getTransceivers().forEach((t) => {
        if (t.sender && t.sender.track) {
          t.direction = 'sendonly';
        }
      });
    }

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  // Set Remote SDP
  async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) throw new Error('PeerConnection not initialized');
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    this.isRemoteDescriptionSet = true;

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
    this.pendingRemoteCandidates = [];
    this.isRemoteDescriptionSet = false;
  }
}
