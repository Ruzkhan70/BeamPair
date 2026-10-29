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
 * Generate pairing token: tries backend first, falls back to direct Firestore (for GitHub Pages static hosting)
 */
export async function generatePairingToken(
  adminId: string,
  adminEmail: string
): Promise<PairingGenerateResponse> {
  try {
    const res = await fetch('/api/pairing/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminId, adminEmail }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Backend API unavailable (e.g. running on static GitHub Pages)
  }

  // Direct Firestore fallback for GitHub Pages
  const token = generateClientCryptoToken();
  const ttlMs = 5 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;

  await setDoc(doc(db, 'pairingTokens', token), {
    token,
    adminId,
    adminEmail,
    status: 'pending',
    expiresAt,
    createdAt: new Date().toISOString(),
  });

  return {
    token,
    expiresAt,
    adminEmail,
    adminId,
  };
}

/**
 * Validate pairing token: tries backend first, falls back to direct Firestore
 */
export async function validatePairingToken(token: string): Promise<PairingValidateResponse> {
  const cleanToken = token.trim();
  try {
    const res = await fetch('/api/pairing/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cleanToken }),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Backend API unavailable (e.g. running on static GitHub Pages)
  }

  // Direct Firestore fallback
  const snap = await getDoc(doc(db, 'pairingTokens', cleanToken));
  if (!snap.exists()) {
    throw new Error('Pairing code not found or invalid');
  }

  const data = snap.data();
  if (data.status === 'redeemed') {
    throw new Error('This pairing QR code has already been redeemed');
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

/**
 * Redeem pairing token: tries backend first, falls back to direct Firestore
 */
export async function redeemPairingToken(params: {
  token: string;
  deviceId: string;
  deviceName: string;
  deviceModel?: string;
  platform?: string;
}): Promise<{ success: boolean; adminId: string; adminEmail: string }> {
  try {
    const res = await fetch('/api/pairing/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Backend API unavailable
  }

  // Direct Firestore fallback
  const ref = doc(db, 'pairingTokens', params.token);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    throw new Error('Pairing token not found');
  }
  const data = snap.data();
  if (data.status !== 'pending' || Date.now() > data.expiresAt) {
    throw new Error('Token is no longer valid or already redeemed');
  }

  await updateDoc(ref, {
    status: 'redeemed',
    redeemedAt: Date.now(),
    redeemedByDeviceId: params.deviceId,
  });

  return {
    success: true,
    adminId: data.adminId,
    adminEmail: data.adminEmail,
  };
}
