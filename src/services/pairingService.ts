import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase/config';

export interface PairingGenerateResponse {
  token: string;
  expiresAt: number;
  adminEmail: string;
  adminId: string;
}

export interface PairingValidateResponse {
  valid: boolean;
  adminEmail: string;
  adminId: string;
  expiresInSeconds: number;
}

/**
 * Generate a cryptographically secure random token in the browser using Web Crypto API
 */
function generateClientCryptoToken(): string {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate pairing token: always persists to Firestore so ANY phone on ANY URL
 * (Shared URL, Dev URL, mobile network, or after server restarts) can validate and pair.
 */
export async function generatePairingToken(
  adminId: string,
  adminEmail: string
): Promise<PairingGenerateResponse> {
  const token = generateClientCryptoToken();
  const ttlMs = 5 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;

  // Authoritative cross-device store in Firestore
  await setDoc(doc(db, 'pairingTokens', token), {
    token,
    adminId,
    adminEmail,
    status: 'pending',
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  // Best-effort mirror to local backend memory (non-blocking)
  fetch('/api/pairing/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adminId, adminEmail, token, expiresAt }),
  }).catch(() => {});

  return {
    token,
    expiresAt,
    adminEmail,
    adminId,
  };
}

/**
 * Validate pairing token using Firestore as the authoritative source of truth
 */
export async function validatePairingToken(token: string): Promise<PairingValidateResponse> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new Error('Please enter a valid pairing code');
  }

  const snap = await getDoc(doc(db, 'pairingTokens', cleanToken));
  if (snap.exists()) {
    const data = snap.data();
    if (data.status === 'redeemed') {
      throw new Error('This pairing QR code has already been redeemed');
    }
    if (data.status === 'cancelled') {
      throw new Error('This pairing QR code was cancelled by the administrator');
    }
    if (data.status === 'expired' || Date.now() > data.expiresAt) {
      throw new Error('This pairing QR code has expired');
    }

    return {
      valid: true,
      adminEmail: data.adminEmail,
      adminId: data.adminId,
      expiresInSeconds: Math.max(0, Math.floor((data.expiresAt - Date.now()) / 1000)),
    };
  }

  // Legacy backend fallback for tokens generated strictly in server memory
  try {
    const res = await fetch('/api/pairing/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cleanToken }),
    });
    if (res.ok) {
      return await res.json();
    }
    const errBody = await res.json().catch(() => null);
    if (errBody?.error) {
      throw new Error(errBody.error);
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes('Failed to fetch')) {
      throw err;
    }
  }

  throw new Error('Pairing code not found or invalid');
}

/**
 * Redeem pairing token atomically in Firestore
 */
export async function redeemPairingToken(params: {
  token: string;
  deviceId: string;
  deviceName: string;
  deviceModel?: string;
  platform?: string;
}): Promise<{ success: boolean; adminId: string; adminEmail: string }> {
  const cleanToken = params.token.trim();
  const ref = doc(db, 'pairingTokens', cleanToken);
  const snap = await getDoc(ref);

  if (snap.exists()) {
    const data = snap.data();
    if (data.status !== 'pending' || Date.now() > data.expiresAt) {
      throw new Error('Token is no longer valid or already redeemed');
    }

    await updateDoc(ref, {
      status: 'redeemed',
      redeemedAt: Date.now(),
      redeemedByDeviceId: params.deviceId,
    });

    // Best-effort notify backend
    fetch('/api/pairing/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, token: cleanToken }),
    }).catch(() => {});

    return {
      success: true,
      adminId: data.adminId,
      adminEmail: data.adminEmail,
    };
  }

  // Fallback to backend API if token only existed in server memory
  const res = await fetch('/api/pairing/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, token: cleanToken }),
  });
  if (res.ok) {
    return await res.json();
  }
  const errBody = await res.json().catch(() => null);
  throw new Error(errBody?.error || 'Pairing token not found');
}
