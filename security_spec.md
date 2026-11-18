# Security Specification — LensLink Downloadable Bundles

## 1. Data Invariants
1. Every document in `/download_bundles/{bundleId}` MUST match one of the four canonical bundle IDs: `browser-webcam`, `windows-vcam`, `pc-windows`, `android-studio`.
2. `download_bundles` contains zero Personally Identifiable Information (PII): no emails, phone numbers, or addresses are stored in publicly readable bundle documents.
3. Only the verified administrator (`sourav3d1@gmail.com` with `email_verified == true` or UID present in `/admins/{uid}`) may create, update, or delete bundles.
4. `bundleId` and `createdAt` are immutable after creation; `updatedAt` and `createdAt` MUST equal `request.time`.
5. `uploadedBy` MUST match `request.auth.uid`, preventing identity spoofing.
6. `list` queries on `download_bundles` and `admins` are disabled (`allow list: if false;`) — clients only read known document IDs via `get`.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with PERMISSION_DENIED)
1. **Unauthenticated Create**: Anonymous/signed-out client attempts `setDoc('/download_bundles/browser-webcam', {...})`.
2. **Unverified Admin Email Spoof**: Signed-in account with `email: 'sourav3d1@gmail.com'` and `email_verified: false`.
3. **Non-Admin Signed-In Write**: Valid verified Gmail user (`other@gmail.com`) attempts to overwrite `windows-vcam`.
4. **Ghost / Shadow Field Injection**: Admin create includes extra field `{ isOfficial: true }` rejected by `hasOnly(...)`.
5. **Identity Spoofing**: Admin create sets `uploadedBy: 'other-uid-123'` instead of `request.auth.uid`.
6. **Path-Field Mismatch**: Admin creates `/download_bundles/windows-vcam` with `data.bundleId: 'pc-windows'`.
7. **Invalid Bundle ID Poisoning**: Client writes to `/download_bundles/malicious_id` or 1.5KB ID string.
8. **Size Exhaustion / Value Poisoning**: `sizeBytes: 99999999` or `zipBase64` exceeding 900,000 chars or invalid `contentType: 'text/html'`.
9. **Client Timestamp Forgery**: `createdAt` or `updatedAt` set to a client clock timestamp instead of `request.time`.
10. **Immortal Field Mutation on Update**: Admin update attempts to alter `createdAt` or `bundleId`.
11. **Unauthorized Collection Scrape (`list`)**: Client runs `getDocs(collection(db, 'download_bundles'))` or `getDocs(collection(db, 'admins'))`.
12. **Self-Assigned Admin Escalation**: Signed-in user attempts `setDoc('/admins/' + uid, { uid, role: 'admin' })`.
