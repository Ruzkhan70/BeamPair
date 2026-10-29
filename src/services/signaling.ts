import {
  collection,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase/config';
import { Session, IceCandidateData, SecurityAuditLog } from '../types';

/**
 * Initiates a new remote session request in Firestore
 */
export async function createRemoteSession(params: {
  sessionId: string;
  adminId: string;
  deviceId: string;
  requestCamera: boolean;
  cameraFacing: 'user' | 'environment';
  requestMicrophone: boolean;
  requestScreen: boolean;
}): Promise<void> {
  const path = `sessions/${params.sessionId}`;
  try {
    const sessionData: Session = {
      sessionId: params.sessionId,
      adminId: params.adminId,
      deviceId: params.deviceId,
      status: 'requested',
      requestCamera: params.requestCamera,
      cameraFacing: params.cameraFacing,
      requestMicrophone: params.requestMicrophone,
      requestScreen: params.requestScreen,
      startedAt: Date.now(),
    };
    await setDoc(doc(db, 'sessions', params.sessionId), sessionData);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

/**
 * Listen for changes on a specific session document
 */
export function listenToSession(
  sessionId: string,
  onUpdate: (session: Session) => void
): () => void {
  const path = `sessions/${sessionId}`;
  return onSnapshot(
    doc(db, 'sessions', sessionId),
    (snapshot) => {
      if (snapshot.exists()) {
        onUpdate({ id: snapshot.id, ...(snapshot.data() as Session) });
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

/**
 * Save Admin's WebRTC Offer to Firestore
 */
export async function setSessionOffer(sessionId: string, offerSdp: string): Promise<void> {
  const path = `sessions/${sessionId}`;
  try {
    await updateDoc(doc(db, 'sessions', sessionId), {
      sdpOffer: offerSdp,
      status: 'connecting',
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Save Secondary Device's WebRTC Answer to Firestore
 */
export async function setSessionAnswer(sessionId: string, answerSdp: string): Promise<void> {
  const path = `sessions/${sessionId}`;
  try {
    await updateDoc(doc(db, 'sessions', sessionId), {
      sdpAnswer: answerSdp,
      status: 'active',
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Terminate a remote session in Firestore
 */
export async function terminateSession(
  sessionId: string,
  endedBy: 'admin' | 'device' | 'timeout' | 'error',
  reason: string = 'Session ended'
): Promise<void> {
  const path = `sessions/${sessionId}`;
  try {
    await updateDoc(doc(db, 'sessions', sessionId), {
      status: 'terminated',
      endedAt: Date.now(),
      endedBy,
      terminationReason: reason,
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

/**
 * Push an ICE candidate to the session's iceCandidates subcollection
 */
export async function addSessionIceCandidate(
  sessionId: string,
  candidate: RTCIceCandidate,
  sender: 'admin' | 'device'
): Promise<void> {
  const path = `sessions/${sessionId}/iceCandidates`;
  try {
    const candidateData: IceCandidateData = {
      candidate: JSON.stringify(candidate.toJSON()),
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      sender,
      createdAt: Date.now(),
    };
    await addDoc(collection(db, 'sessions', sessionId, 'iceCandidates'), candidateData);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

/**
 * Listen for incoming ICE candidates sent by the peer
 */
export function listenToIceCandidates(
  sessionId: string,
  mySenderRole: 'admin' | 'device',
  onCandidateReceived: (candidate: RTCIceCandidateInit) => void
): () => void {
  const peerSender = mySenderRole === 'admin' ? 'device' : 'admin';
  const path = `sessions/${sessionId}/iceCandidates`;

  const q = query(
    collection(db, 'sessions', sessionId, 'iceCandidates'),
    where('sender', '==', peerSender)
  );

  const seenIds = new Set<string>();

  return onSnapshot(
    q,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && !seenIds.has(change.doc.id)) {
          seenIds.add(change.doc.id);
          const data = change.doc.data() as IceCandidateData;
          try {
            const parsed = JSON.parse(data.candidate);
            onCandidateReceived(parsed);
          } catch (err) {
            console.warn('Error parsing ICE candidate:', err);
          }
        }
      });
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

/**
 * Record a security audit event in Firestore
 */
export async function recordSecurityAudit(log: Omit<SecurityAuditLog, 'id' | 'timestamp'>): Promise<void> {
  const path = 'securityAuditLogs';
  try {
    const logId = `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await setDoc(doc(db, 'securityAuditLogs', logId), {
      ...log,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn('Audit log write error:', err);
  }
}
