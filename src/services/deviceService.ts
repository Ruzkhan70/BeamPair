import {
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
} from 'firebase/firestore';
import { db, auth, handleFirestoreError, OperationType } from '../firebase/config';
import { Device, Session, SecurityAuditLog } from '../types';

/**
 * Register a new device in Firestore after QR pairing validation
 */
export async function registerDeviceInFirestore(device: Device): Promise<void> {
  const path = `devices/${device.deviceId}`;
  try {
    await setDoc(doc(db, 'devices', device.deviceId), device);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

/**
 * Update device heartbeat, permissions, or status from secondary device
 */
export async function updateDeviceHeartbeat(
  deviceId: string,
  update: Partial<Device>
): Promise<void> {
  const path = `devices/${deviceId}`;
  try {
    await updateDoc(doc(db, 'devices', deviceId), {
      ...update,
      lastSeen: Date.now(),
    });
  } catch (err) {
    // Only fail gracefully if revoked or not found
    console.warn('Heartbeat update note:', err);
  }
}

/**
 * Listen for all registered devices for an administrator
 * Only attaches onSnapshot listener when auth is verified
 */
export function listenToAdminDevices(
  adminId: string,
  onDevices: (devices: Device[]) => void
): () => void {
  if (!auth.currentUser || !adminId) {
    onDevices([]);
    return () => {};
  }

  const path = 'devices';
  const q = query(collection(db, 'devices'), where('adminId', '==', adminId));

  return onSnapshot(
    q,
    (snapshot) => {
      const devices: Device[] = [];
      snapshot.forEach((docSnap) => {
        devices.push({ id: docSnap.id, ...(docSnap.data() as Device) });
      });
      // Sort newest paired first
      devices.sort((a, b) => b.pairedAt - a.pairedAt);
      onDevices(devices);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

/**
 * Listen to a single device's state (used by the secondary device itself)
 */
export function listenToDevice(
  deviceId: string,
  onDevice: (device: Device | null) => void
): () => void {
  const path = `devices/${deviceId}`;
  return onSnapshot(
    doc(db, 'devices', deviceId),
    (snapshot) => {
      if (snapshot.exists()) {
        onDevice({ id: snapshot.id, ...(snapshot.data() as Device) });
      } else {
        onDevice(null);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

/**
 * Listen for incoming session requests targeted at a specific device
 */
export function listenForIncomingSessionRequests(
  deviceId: string,
  onSession: (session: Session | null) => void
): () => void {
  const path = 'sessions';
  const q = query(
    collection(db, 'sessions'),
    where('deviceId', '==', deviceId),
    where('status', 'in', ['requested', 'connecting', 'active'])
  );

  return onSnapshot(
    q,
    (snapshot) => {
      if (!snapshot.empty) {
        const docSnap = snapshot.docs[0];
        onSession({ id: docSnap.id, ...(docSnap.data() as Session) });
      } else {
        onSession(null);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

/**
 * Revoke device registration (Admin action)
 */
export async function revokeDeviceRegistration(
  adminId: string,
  deviceId: string
): Promise<void> {
  const path = `devices/${deviceId}`;
  // 1. Notify backend security endpoint
  try {
    await fetch('/api/admin/revoke-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, adminId }),
    });
  } catch (err) {
    console.warn('Backend revocation error:', err);
  }

  // 2. Mark device as revoked in Firestore
  try {
    await updateDoc(doc(db, 'devices', deviceId), {
      isRevoked: true,
      status: 'offline',
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Listen to past session history for an admin
 */
export function listenToSessionHistory(
  adminId: string,
  onSessions: (sessions: Session[]) => void
): () => void {
  if (!auth.currentUser || !adminId) {
    onSessions([]);
    return () => {};
  }

  const path = 'sessions';
  const q = query(
    collection(db, 'sessions'),
    where('adminId', '==', adminId),
    orderBy('startedAt', 'desc'),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const sessions: Session[] = [];
      snapshot.forEach((d) => sessions.push({ id: d.id, ...(d.data() as Session) }));
      onSessions(sessions);
    },
    (error) => {
      // If composite index is pending, fallback query
      console.warn('Session query note, falling back:', error);
      if (!auth.currentUser) return;
      const fallbackQ = query(collection(db, 'sessions'), where('adminId', '==', adminId));
      onSnapshot(fallbackQ, (snap) => {
        const s: Session[] = [];
        snap.forEach((d) => s.push({ id: d.id, ...(d.data() as Session) }));
        s.sort((a, b) => b.startedAt - a.startedAt);
        onSessions(s);
      });
    }
  );
}

/**
 * Listen to security audit logs for an admin
 */
export function listenToSecurityLogs(
  onLogs: (logs: SecurityAuditLog[]) => void
): () => void {
  if (!auth.currentUser) {
    onLogs([]);
    return () => {};
  }

  const path = 'securityAuditLogs';
  const q = query(
    collection(db, 'securityAuditLogs'),
    orderBy('timestamp', 'desc'),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const logs: SecurityAuditLog[] = [];
      snapshot.forEach((d) => logs.push({ id: d.id, ...(d.data() as SecurityAuditLog) }));
      onLogs(logs);
    },
    (error) => {
      console.warn('Security logs listener note:', error);
      if (!auth.currentUser) return;
      // Fallback
      onSnapshot(collection(db, 'securityAuditLogs'), (snap) => {
        const l: SecurityAuditLog[] = [];
        snap.forEach((d) => l.push({ id: d.id, ...(d.data() as SecurityAuditLog) }));
        l.sort((a, b) => b.timestamp - a.timestamp);
        onLogs(l);
      });
    }
  );
}
