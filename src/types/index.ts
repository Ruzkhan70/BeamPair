export interface Device {
  id?: string;
  deviceId: string;
  adminId: string;
  deviceName: string;
  deviceModel?: string;
  platform: 'android' | 'ios' | 'desktop' | 'other';
  status: 'online' | 'offline';
  lastSeen?: number;
  pairedAt: number;
  isRevoked: boolean;
  cameraPermission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  microphonePermission?: 'granted' | 'denied' | 'prompt' | 'unknown';
  screenShareSupported?: boolean;
  currentSessionId?: string | null;
}

export interface PairingToken {
  token: string;
  adminId: string;
  adminEmail: string;
  status: 'pending' | 'redeemed' | 'expired' | 'cancelled';
  expiresAt: number;
  redeemedAt?: number;
  redeemedByDeviceId?: string;
  createdAt?: string | number;
}

export interface Session {
  id?: string;
  sessionId: string;
  adminId: string;
  deviceId: string;
  status: 'requested' | 'connecting' | 'active' | 'terminated';
  requestCamera?: boolean;
  cameraFacing?: 'user' | 'environment';
  requestMicrophone?: boolean;
  requestScreen?: boolean;
  sdpOffer?: string;
  sdpAnswer?: string;
  startedAt: number;
  endedAt?: number;
  endedBy?: 'admin' | 'device' | 'timeout' | 'error';
  terminationReason?: string;
}

export interface IceCandidateData {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  sender: 'admin' | 'device';
  createdAt: number;
}

export interface SecurityAuditLog {
  id?: string;
  adminId?: string;
  deviceId?: string;
  eventType:
    | 'PAIRING_TOKEN_GENERATED'
    | 'PAIRING_TOKEN_REDEEMED'
    | 'PAIRING_TOKEN_CANCELLED'
    | 'DEVICE_REGISTERED'
    | 'DEVICE_REVOKED'
    | 'SESSION_REQUESTED'
    | 'SESSION_CONNECTED'
    | 'SESSION_DISCONNECTED_BY_ADMIN'
    | 'SESSION_DISCONNECTED_BY_DEVICE'
    | 'UNAUTHORIZED_ACCESS_ATTEMPT';
  details?: string;
  ipAddress?: string;
  timestamp: number;
}

export interface MediaStreamState {
  hasCamera: boolean;
  hasMicrophone: boolean;
  hasScreen: boolean;
  cameraFacing: 'user' | 'environment';
  isAudioMuted: boolean;
}
