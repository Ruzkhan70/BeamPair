/**
 * Real WebRTC PeerConnection and Media Capture Service
 * Supports Camera (user/environment), Microphone, and Display Media (Screen Sharing)
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/webrtc/ice-servers');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        return data.iceServers;
      }
    }
  } catch (err) {
    console.warn('[WebRTC] Could not fetch server ICE config, using fallback STUN:', err);
  }
  return DEFAULT_STUN_SERVERS;
}

export class WebRTCManager {
  public peerConnection: RTCPeerConnection | null = null;
  public localStream: MediaStream = new MediaStream();
  public remoteStream: MediaStream = new MediaStream();
  private iceServers: RTCIceServer[] = DEFAULT_STUN_SERVERS;

  public onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  public onConnectionStateChange: ((state: RTCPeerConnectionState) => void) | null = null;
  public onIceConnectionStateChange: ((state: RTCIceConnectionState) => void) | null = null;
  public onRemoteStreamTrack: ((stream: MediaStream, track: MediaStreamTrack) => void) | null = null;
  public onScreenShareEnded: (() => void) | null = null;

  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;

  async init(role: 'admin' | 'device'): Promise<void> {
    this.iceServers = await fetchIceServers();
    
    const configuration: RTCConfiguration = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 10,
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
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

    this.peerConnection.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!this.remoteStream.getTracks().some((t) => t.id === track.id)) {
          this.remoteStream.addTrack(track);
        }
      });
      if (this.onRemoteStreamTrack) {
        this.onRemoteStreamTrack(this.remoteStream, event.track);
      }
    };

    // If Admin, add transceivers to receive video and audio
    if (role === 'admin') {
      try {
        this.peerConnection.addTransceiver('video', { direction: 'recvonly' });
        this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });
      } catch (err) {
        console.warn('Transceiver add warning:', err);
      }
    }
  }

  // Camera capture with front or rear facing support
  async startCamera(facingMode: 'user' | 'environment' = 'environment'): Promise<MediaStreamTrack> {
    // Stop any existing video tracks first
    this.localStream.getVideoTracks().forEach((track) => {
      track.stop();
      this.localStream.removeTrack(track);
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });

    const videoTrack = stream.getVideoTracks()[0];
    this.localStream.addTrack(videoTrack);
    this.replaceOrAddTrack(videoTrack);
    return videoTrack;
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

  private replaceOrAddTrack(track: MediaStreamTrack): void {
    if (!this.peerConnection) return;
    const senders = this.peerConnection.getSenders();
    const existingSender = senders.find((s) => s.track && s.track.kind === track.kind);

    if (existingSender) {
      existingSender.replaceTrack(track);
    } else {
      this.peerConnection.addTrack(track, this.localStream);
    }
  }

  setAudioMuted(muted: boolean): void {
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
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
      if (candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn('Error adding buffered ICE candidate:', err);
        }
      }
    }
  }

  // Add ICE Candidate
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
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

  // Teardown and cleanup
  close(): void {
    this.localStream.getTracks().forEach((track) => track.stop());
    this.remoteStream.getTracks().forEach((track) => track.stop());
    this.localStream = new MediaStream();
    this.remoteStream = new MediaStream();

    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.onicecandidate = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.pendingRemoteCandidates = [];
    this.isRemoteDescriptionSet = false;
  }
}
