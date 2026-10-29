# Security Specification: BeamPair Remote Device Support

## 1. Data Invariants

1. **Admin Master Gate**:
   - Only authenticated administrators with verified email (`ruzkhanhazar@gmail.com` or registered in `/admins/{adminId}`) can create pairing tokens, view all paired devices for their tenant, request remote sessions, and issue administrative disconnect commands.

2. **Single-Use Pairing Invariant**:
   - Pairing tokens cannot be redeemed more than once (`status == 'redeemed'`).
   - Pairing tokens cannot be redeemed after `expiresAt`.
   - Secondary devices can only update a token from `status == 'pending'` to `status == 'redeemed'` providing valid device registration.

3. **Device Authorization Invariant**:
   - Secondary devices must be paired to a valid `adminId`.
   - Only the owning admin can revoke device registration.
   - Devices cannot modify `adminId` or `isRevoked` once set.
   - Revoked devices (`isRevoked == true`) are blocked from participating in sessions or signaling.

4. **WebRTC Session Authorization**:
   - A session can only be created by the owning administrator.
   - Only the assigned secondary device or the owning admin can write to session signals (`sdpOffer`, `sdpAnswer`) and the `iceCandidates` subcollection.
   - Only the administrator can execute an admin-level disconnect (`endedBy == 'admin'`).

5. **Security Audit Log Immutability**:
   - Audit logs are append-only. Modification and deletion of audit logs are strictly denied for all parties.

---

## 2. The "Dirty Dozen" Threat Payloads

1. **Payload 1 (Ghost Field Injection)**:
   Attempting to add unauthorized field `role: "superadmin"` or `bypassAuth: true` to a device or token update.
   *Expected: PERMISSION_DENIED via `hasOnly()` validation.*

2. **Payload 2 (Unverified Email Admin Spoof)**:
   Attempting to create pairing tokens with `request.auth.token.email = "ruzkhanhazar@gmail.com"` but `email_verified = false`.
   *Expected: PERMISSION_DENIED via strict `email_verified == true` check.*

3. **Payload 3 (Replay Attack on Expired Token)**:
   Attempting to redeem a pairing token where `request.time.toMillis() > resource.data.expiresAt`.
   *Expected: PERMISSION_DENIED.*

4. **Payload 4 (Double-Redemption Race)**:
   Attempting to redeem a token whose existing status is already `'redeemed'`.
   *Expected: PERMISSION_DENIED via terminal state lock.*

5. **Payload 5 (Unauthenticated Admin Disconnect)**:
   A secondary device or unauthenticated entity trying to set `endedBy: "admin"` or cancel another admin's session.
   *Expected: PERMISSION_DENIED.*

6. **Payload 6 (Device Hijack / Admin ID Mutation)**:
   Attempting to update an existing registered device and modify its `adminId` to point to a different admin.
   *Expected: PERMISSION_DENIED via immutable field check `incoming().adminId == existing().adminId`.*

7. **Payload 7 (Un-Revoking Device by Secondary Client)**:
   Secondary device attempting to clear `isRevoked: false` after the administrator has set `isRevoked: true`.
   *Expected: PERMISSION_DENIED.*

8. **Payload 8 (Mass Data Scraping / Blanket Query)**:
   Unauthenticated user attempting to query `/devices` or `/sessions` without owning admin criteria.
   *Expected: PERMISSION_DENIED via secure list query restriction `resource.data.adminId == request.auth.uid`.*

9. **Payload 9 (Oversized SDP Buffer Overflow / Denial of Wallet)**:
   Injecting an SDP string exceeding 100,000 bytes or candidate string exceeding 4,096 bytes into signaling.
   *Expected: PERMISSION_DENIED via strict string length guards.*

10. **Payload 10 (Falsified Timestamps)**:
    Sending a client-side timestamp far in the past or future instead of `request.time`.
    *Expected: PERMISSION_DENIED.*

11. **Payload 11 (Audit Log Tampering or Erasure)**:
    Attempting to `update` or `delete` an existing document in `/securityAuditLogs`.
    *Expected: PERMISSION_DENIED (allow update: if false; allow delete: if false).*

12. **Payload 12 (Cross-Tenant ICE Candidate Injection)**:
    A rogue user attempting to write ICE candidates into a session belonging to another administrator.
    *Expected: PERMISSION_DENIED via parent session membership check.*
