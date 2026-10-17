# Attendly: current system and practical deployment architecture

## What the code actually does

This is a React 19/Vite application connected to a working FastAPI server. The browser calls `/api/*`; Vite proxies these requests to `localhost:8000`. It is not a mock-data frontend.

| Data | Current source of truth |
| --- | --- |
| Teachers, students, password hashes, login sessions | SQLite: `backend/data/attendance.db` |
| Classes, class teachers, subject assignments | The same SQLite database |
| Lecture sessions, attendance, manual review reasons, audit metadata | The same SQLite database |
| Enrollment photos | `backend/data/photos/` |
| Pending biometric submissions | `backend/data/pending_biometric/` |
| Classroom photos, face crops, annotations | `backend/data/sessions/` |
| Recognition policy and calibration metadata | `backend/data/config.json` |
| New private device captures and upload queue | Encrypted blobs in IndexedDB (`attendly-offline-v1`) |
| Offline teacher identity and workspace | Last verified teacher identity metadata, plus encrypted assignment/roster snapshots in IndexedDB |
| Offline application code | Service-worker Cache Storage; API responses and biometric image URLs are excluded |

No attendance is stored in localStorage. IndexedDB is the durable device queue, not the official attendance database. The application has no cloud database, S3 account, campus SSO, or external processing service configured. Tests use separately named databases and explicitly simulated transports.

There is no timetable/academic-term model yet. Lectures are manually created for a subject assignment, with a period count and capture timestamp. This must not be described as an integration with the college timetable.

## Capture and review

Single Shot is the default. The split-button arrow offers Single Shot and 3-Shot Panorama. Panorama captures left, center, and right with overlap guidance, independent retakes, and a preview before upload. Captures use `getUserMedia` and canvas; the app does not write them to a public gallery. Importing an existing image remains an explicit fallback.

The three images are processed separately. Stitching can distort, resample, or lose faces near seams, so it is intentionally outside the recognition path. Identity assignment is one-to-one within each frame. Cross-frame evidence is reconciled by student ID; one student has one session attendance record. Ambiguities and contradictory face embeddings remain unresolved instead of being erased by a higher score elsewhere.

A new class does not require attendance history or multiple supporting frames. One good-quality, unambiguous Single Shot match can suggest presence. Additional frames check consistency wherever the same identity appears. A student visible only in the left frame can still match; the other frames do not count as negative evidence. Unknown/missing faces never automatically become absent.

Review focuses on unresolved students; resolved students can be expanded for inspection or correction. Present/absent actions record a standard teacher-verification reason with one click, with an optional custom note. A bulk absence review lists only unresolved students and requires an explicit roster-check acknowledgement. It preserves confident matches and previous manual decisions. Undo is persisted for queued reviews. Finalization still validates every record on the server; bulk-reviewed absence is manual, never an automatic inference from a missing face.

The v2 detector performs one whole-image pass and up to four overlapping tile passes for images larger than 1280 pixels on either axis. Coordinates and landmarks are translated into the original image, overlapping boxes are suppressed geometrically, and each remaining face is embedded once. Original-pixel quality checks still apply. This increases work for large photos; classroom detection recall and latency still require measurement on representative images. Unused age/gender and additional 2D-landmark models are skipped.

Multi-frame aggregation keeps all clear positive observations and checks their embedding consistency. A weak ambiguous observation does not veto a clear observation when its score trails the strongest support by at least 0.15. Strong competing observations, distinct-face identity collisions, inconsistent positive embeddings, and confident cross-identity switches remain unresolved. These extra margins are heuristic, versioned policy parameters, not validated accuracy guarantees. Calibration reports from v1 must be regenerated. Active sessions are reanalyzed from their saved images on first review using v2 while retaining their score and quality thresholds; finalized records are preserved.

Review analysis includes sanitized per-photo face boxes, labels, original dimensions, and stable upload identifiers, without face embeddings. The browser overlays these on the original capture, including encrypted-cache images while offline. The show-faces toggle affects display only. Loading analysis is shown as loading rather than incorrectly showing every student as undetected.

The portal shell uses neutral rounded surfaces with sage accents for teachers and blue-violet accents for students. Navigation can collapse on desktop; mobile navigation keeps the active page visible. Page search only exposes routes available to that user. Dashboard enrollment/readiness figures come from actual roster/consent/embedding data. Student charts use confirmed period counts, with subject summaries and searchable/filterable history. Regular teachers have an activity dashboard without management permissions. UI fixture routes under `frontend/tests/` use explicitly synthetic data and do not authenticate, upload, or commit attendance; these pages are excluded from the production build.

The supporting palette in `src/color.css` adds sky, terracotta, plum, and warm cream across metrics, icons, charts, subject summaries, and capture panels. Portal identity colors remain consistent for primary actions. Attendance and warning badges retain their semantic colors. Metric text/background pairs and primary button text meet a measured 4.5:1 contrast ratio or better.

Teachers have a prominent fixed bottom-right attendance action on dashboard and management pages. On the capture page, the actual Single Shot / 3-Shot split button occupies that position. It is hidden while reviewing an active session to avoid replacing work in progress; capture and finalization remain explicit actions. Phone positioning includes the operating system's safe-area inset.

Student biometric uploads separate validation from staff decisions. Readable images are normalized to JPEG, stored privately, and queued as pending even if automatic quality checks suggest a retake. Validation notes are visible to student and reviewer. Unreadable/oversized files fail the upload transaction without creating a partial pending batch. Only explicit class-teacher/admin review can reject or activate a photo; approval requires one detectable face and a usable embedding, but the reviewer’s explicit approval overrides automatic quality suggestions. Overrides are recorded in the biometric audit log before replacing the active enrollment. Retake requests include a reason. The student status card displays the latest submission per angle, so older rejection history cannot obscure a new pending update. Camera capture waits for usable video dimensions, supports individual retakes, and stops late streams after cancellation.

A cosine score is not a probability. Blur, image size, exposure, detector score, pose, and landmark reliability are heuristic checks. Landmark checks do not provide a reliable general-purpose occlusion or spoof detector. Real-world baseline and calibration require independent human labels and held-out capture groups; no real accuracy claims can be inferred from unit-test fixtures.

## Page routing and deployment

React Router's BrowserRouter gives each portal page a real path. Navigation links support browser history and opening a page in another tab. Root links redirect to the account's home, protected links preserve their destination through sign-in, and unauthorized or unknown pages show a useful recovery screen. Client route guards prevent rendering a forbidden workspace; server authorization remains the security boundary.

Teacher session details use `/teacher/history/:sessionId`; students can open `/student/attendance/:sessionId` only from their own confirmed records. Capture/review context uses `/teacher/attendance?assignment=ID&session=SID` or `?assignment=ID&job=UUID`. Job IDs reference encrypted data on that device, are checked against the current owner, and are not portable share links. Session/subject mismatches fail instead of opening a different class. Manual review drafts are encrypted under the server session ID, survive a refresh, and are removed after verified confirmation.

Vite development/preview already supplies the SPA fallback. Production static hosting must serve real assets normally and rewrite other frontend page requests to `index.html` (for example, nginx `try_files $uri $uri/ /index.html;`). Route `/api/` to FastAPI before this fallback. A missing script must return an asset error rather than the HTML shell. The existing service worker supplies its cached app shell for offline navigation; private API/image responses remain excluded from its cache. It cannot replace an online host's routing configuration.

## Persistent offline workflow

1. A previously signed-in teacher selects a cached subject/class. A locally generated UUID identifies the capture before any network operation.
2. Every accepted frame is JPEG-encoded (quality 0.9, maximum long edge 2560 px, never upscaled), encrypted using AES-GCM with a fresh IV, and committed to IndexedDB. The UI says saved only after the transaction completes. Keeping full facial detail matters more than aggressively reducing file size.
3. The teacher checks the preview. Single Shot needs one slot; panorama needs all three. Retakes replace a slot only while the capture is still a draft. Each queued frame retains a stable photo request ID.
4. The persisted job moves through Capturing, Saved Offline/Waiting to Sync, Uploading, Processing, Ready for Review, Finalizing, and Completed. Failed and Sign in to Sync are explicit recoverable states. Uploading/Processing are stages of the local synchronous API pipeline, not a claim that a separate cloud worker exists.
5. The foreground synchronizer runs on opening the workspace, focus, reconnect, and a bounded timer. A service-worker Background Sync handler uses the same engine where the browser supports it. Background execution while the app is closed is best effort; it is not guaranteed on every browser or OS. Reopening the installed app reliably rechecks the persisted queue.
6. Synchronization verifies the authenticated teacher account before decrypting/uploading. Expired authentication retains images and pauses the job. Revoked subject permissions are enforced by the server even if an old offline roster remains on the device.
7. A transactional IndexedDB lease prevents two tabs/workers from handling the same job at once; leases expire after interruption and are renewed during long uploads. Network failures use exponential backoff and jitter, capped at five minutes. Validation/permission conflicts wait for user resolution rather than retrying forever.
8. Reviews can be saved locally. They are not official attendance until the server commits them. The client checks the server session status after confirmation. If the response is lost, the next retry checks the committed receipt before uploading again.
9. Only after a matching server receipt reports `confirmed` does one IndexedDB transaction remove the private frame blobs and review/analysis payloads and mark the local job Completed. Every local frame must also have a matching server processing receipt (request ID, acknowledged photo ID, or content hash). A different capture finalizing the same session cannot cause unprocessed local images to be deleted. If the process stops before cleanup, it is safe to repeat it.

The queue survives browser/application restarts through IndexedDB, not a React state variable. Runtime object URLs are only previews and are revoked when no longer needed. Empty or abandoned captures can be discarded explicitly; unsynchronized photographs are not silently aged out. Upload failures and low storage never trigger cleanup of the only local copy.

### Device-storage boundaries

- IndexedDB and service workers require a supported browser; camera and WebCrypto require HTTPS in deployment (localhost works for development).
- The app requests persistent storage, but browsers can decline. Site data can still be removed by the user, private browsing may not persist it, and storage pressure can evict nonpersistent data. The UI reports this limitation instead of promising unbreakable offline storage.
- Quota checks are advisory. Actual transaction failure is also handled; a failed retake preserves the preceding saved image.
- AES-GCM keys are non-extractable CryptoKeys stored in the origin's IndexedDB. This reduces exposure of stored blobs; it is not an OS keystore, a separate password vault, or protection against same-origin XSS. Use trusted devices, a strong CSP, dependency hygiene, and OS disk encryption in production. Do not share a logged-in teacher device.
- A cached teacher identity permits local capture for twelve hours after its last online verification. It does not authorize server writes. Full first-time login, recognition, and finalization still require connectivity to the backend. Offline revocation cannot be instantaneous.
- Local sign-out stops queued synchronization and locks out the cached workspace. HttpOnly server-cookie revocation needs connectivity; the app retries logout when reopened online.
- A web app cannot generally delete a photo already saved by a separate camera/gallery app. In-app captures avoid creating those gallery files. Imported gallery originals remain under the user's control.
- A native app could use app-private files plus Keychain/Keystore and stronger background-job scheduling. That is a future platform option, not implemented here.

## Duplicate prevention and authorization

The backend uses stable request IDs and database constraints:

- Unique `(created_by, client_request_id)` for lecture creation retries.
- Unique `(session_id, client_photo_id)` for photo retries. Reusing an ID with changed image bytes fails. A repeated image cannot contribute additional recognition evidence.
- Unique `(session_id, student_id)` for attendance records.
- Repeated confirmation with the same request digest returns the committed result; conflicting updates to finalized attendance are rejected.
- Backend confirmation recomputes the permitted decision from saved server evidence. Client-supplied confidence scores and crop identifiers cannot manufacture automatic presence.
- Every record must be present in the review submission. Manual decisions need a reason. The assigned teacher/admin is reauthorized on every request; students read only their own confirmed records.

These keys prevent retries and overlapping frames from duplicating attendance. Two independently created captures of the same scheduled lecture need a canonical timetable occurrence ID to merge automatically. That timetable feature is not implemented yet; do not treat client UUIDs as a substitute for a college scheduling system.

## Image retention

Private local attendance images are deleted automatically only after verified server finalization. Capturing/failed/unsynchronized jobs keep their images until resolved or explicitly discarded; a user cannot discard an uploaded job through the abandoned-draft action.

On the server, the default classroom-image retention is **24 hours after successful confirmation**, configurable with `ATTENDLY_IMAGE_RETENTION_HOURS`. An hourly cleaner removes original photos, crops, annotations, and persisted face vectors for eligible finalized sessions. Attendance records, policy fingerprints, and manual audit reasons remain. The cleaner also runs at startup and can be inspected with `python retention.py --dry-run`.

Unfinalized server sessions are not automatically deleted, because the server cannot know whether they contain the only recoverable copy. Staff should review abandoned sessions rather than applying a destructive timer. Enrollment photos/embeddings are a separate consent-governed lifecycle: retain while enrollment is active and needed, remove through authorized student/biometric management. Approved/rejected pending biometric retention should be configured with the college's privacy/appeal process before deployment. Backups and object-storage versions also need explicit expiry; deleting the live object alone is insufficient.

## Practical online architecture

Start with one maintainable application, not a microservice fleet:

```
Installed PWA / browser
    | HTTPS, same-origin cookie authentication
FastAPI web/API service
    |-- Managed PostgreSQL: users, memberships, timetable, sessions, attendance, jobs, audits
    |-- Private S3-compatible object bucket: temporary images and enrollment media
    `-- Bounded recognition worker: persistent jobs, InsightFace/ONNX, CPU or GPU
```

Use PostgreSQL for relational constraints, transactional commits, concurrent faculty use, backups, and row locking. Keep the current SQLAlchemy data layer, replace ad-hoc SQLite additions with versioned migrations, and add a persistent processing-jobs table. An initial worker can claim jobs transactionally from PostgreSQL; Redis is unnecessary until throughput justifies it. Return `202` and a job ID for asynchronous recognition, persist status/results, and limit worker concurrency so a large class does not block login or student reads. Recognition is currently synchronous in the local FastAPI request; that worker integration is future deployment work.

Use a private S3-compatible bucket because application disks are not reliable shared storage across replicas. Permit uploads only after the API authorizes the teacher, class, occurrence, content type, size, and request ID. Short-lived signed URLs or authorized API streaming should control reads. Store object keys in PostgreSQL and apply lifecycle deletion only after the session is committed. No public bucket or permanent public facial-image URLs. A storage abstraction and provider configuration are needed; no cloud provider has been connected by this change.

For a college, model academic terms, courses/subjects, sections, effective-dated enrollments, faculty teaching assignments, and actual scheduled lecture occurrences. Reference the canonical occurrence in attendance, and enforce one record per student/occurrence. Snapshot the relevant roster at the lecture's capture time so later enrollments do not rewrite history. Use soft-deleted identities and effective-dated memberships instead of deleting academic history when someone leaves. The current local account-removal workflow is not yet a college records-retention system. Define a controlled correction process with version checks and append-only audit entries for finalized attendance.

Keep same-origin secure HttpOnly/SameSite session cookies, add login throttling and staff MFA, and integrate the institution's OIDC/SAML identity provider if available. Admin/class-teacher/teacher/student privileges stay enforced on the API and private media endpoints. Do not put administrator powers or bearer tokens into offline browser metadata. Add tenant/college scope before serving multiple institutions.

Student and teacher portals must read the same committed database rows. The current student portal refreshes every 30 seconds while visible and on focus, plus manual refresh. A future asynchronous worker should publish a committed version/event; polling remains adequate initially, with SSE as an optional later improvement. Never publish a "final" event before the database transaction succeeds.

Before public deployment: HTTPS, managed secrets, secure cookies, trusted-origin configuration, CSP/security headers, migrations, transaction locking for multiple API workers, upload malware/type/size controls, backups with restore tests, metrics/job alerts, retention enforcement, and institutional privacy/consent review. This is a deployment checklist, not a claim that these services already exist.

## Validation and honest limits

- `backend/test_recognition.py`: assignment, ambiguity, quality, one-shot acceptance, panorama deduplication/conflicts, and calibration/report logic. Synthetic vectors exercise logic, not real recognition accuracy.
- `backend/test_access.py`: real HTTP tests on an isolated SQLite database, including roles, privacy, explicit review, retry IDs, and upload decoding.
- `frontend/tests/offline.html`: real IndexedDB/WebCrypto and compression tests with an explicitly simulated transport for offline, lost responses, expiry, retry deduplication, leases, low storage, and cleanup. It is a development test harness, not shipped as a cloud integration.
- Physical camera behavior, OS permission dialogs, browser eviction, and background wakeups still need acceptance testing on actual faculty Android/iOS devices.
- Offline images cannot be recognized until they reach the backend; this implementation does not run InsightFace on the phone.
- Real classroom baseline and calibrated thresholds are still pending a properly labeled dataset. The evaluator and validated-report activation are implemented; fabricated sample metrics are never installed as a production calibration.

Primary references: [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), [persistent-storage requests](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), [Background Sync compatibility](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API), and [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).
