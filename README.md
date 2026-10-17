# Attendly

College attendance management with role-based portals, face recognition, and persistent offline capture.

Attendly helps teachers capture a classroom, review uncertain matches, and finalize attendance. Students can see their own confirmed records and submit enrollment photos; administrators and class teachers manage the school community.

> **Project status:** working local application with a real FastAPI/SQLite backend. Cloud hosting, managed databases, object storage, campus SSO, and timetable integration are not configured. Recognition accuracy must be evaluated on representative classroom data before operational use.

## Features

- Separate **Student**, **Teacher**, and **Administrator** sign-in pages and protected routes.
- Class teacher appointments, student accounts, classes, and subject assignments with server-side access checks.
- **Single Shot** attendance by default; **3-Shot Panorama** captures left, center, and right independently, with preview and individual retakes.
- One attendance record per student per session; overlapping images and retried uploads are deduplicated.
- Face quality checks, runner-up identity margins, global one-to-one assignment, unknown faces, and cross-frame consistency checks.
- Face overlays and a review screen focused on uncertain students. Missing detection never automatically means absence.
- **1–4 periods per session**, enforced in the interface, offline capture, and backend.
- Encrypted IndexedDB capture queue, restart recovery, retry backoff, and explicit synchronization states.
- Local image cleanup only after verified processing and finalization receipts.
- Student attendance summaries, subject trends, session history, and CSV exports for authorized teachers.
- Consent-based biometric enrollment, grouped approval queues, retake notes, and compact profiles using approved student photos.
- Responsive layouts with teacher and student accent colors, page search, and a prominent attendance action.

## Stack

| Layer | Implementation |
| --- | --- |
| Frontend | React 19, Vite 8, React Router, Recharts, CSS |
| Backend | FastAPI, SQLAlchemy, SQLite |
| Recognition | InsightFace `buffalo_l`, ONNX Runtime CPU, OpenCV, SciPy |
| Device storage | IndexedDB, WebCrypto AES-GCM, service worker |
| Authentication | Revocable HttpOnly cookie sessions; salted password hashes |

## Run locally

### Prerequisites

- Python 3.9+ with `venv`; a C/C++ build toolchain may be needed for recognition dependencies.
- Node.js 22.12+ and npm.
- Internet access for dependency installation and the first recognition-model download.

The pinned backend dependencies reflect the current tested local environment. Linux/ARM deployment compatibility and resource usage still need verification.

### 1. Install dependencies

From the repository root:

```bash
python3 -m venv backend/venv
backend/venv/bin/python -m pip install --upgrade pip
backend/venv/bin/python -m pip install -r backend/requirements.txt
```

```bash
cd frontend
npm ci
cd ..
```

### 2. Configure the initial administrator

Set these variables **before the first backend startup**:

```bash
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD='replace-this-with-a-unique-password'
```

They initialize a new database only; restarting does not overwrite an existing account. Without overrides, the development bootstrap is `admin` / `Admin@12345`. Replace the development credentials before exposing the application online. Environment variables must be exported explicitly; the launcher does not automatically load a `.env` file.

### 3. Start the application

```bash
./run.sh
```

Or start each service in its own terminal:

```bash
./run.sh backend
```

```bash
./run.sh frontend
```

| Service | Address |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend | http://localhost:8000 |
| API documentation | http://localhost:8000/docs |

Vite proxies `/api/*` and authenticated `/static/*` image requests to FastAPI. The first model initialization can take longer while weights download. Runtime directories and the database are created automatically; this repository contains no school database, enrolled faces, or classroom photos.

## Set up a college

1. Sign in at `/login/admin` and create teacher accounts.
2. Create classes and appoint their class teachers.
3. Create students with unique roll numbers and assign them to classes.
4. Connect each subject and class to a teacher under **Subject assignments**.
5. Students give consent and submit enrollment photos under **My biometrics**. Their class teacher or an administrator reviews submissions.
6. Teachers select an assigned subject, choose 1–4 periods, capture attendance, review exceptions, and confirm.
7. Students see attendance only after the server has committed the finalized session.

| Role | Access |
| --- | --- |
| Administrator | Staff/student accounts, classes, class teacher appointments, subject assignments, biometrics, recognition settings |
| Class teacher | Student management, biometric review, and subject assignments within their managed classes; attendance for their assigned subjects |
| Teacher | Capture, review, history, and export for assigned subjects |
| Student | Own confirmed attendance, own profile, biometric consent and submissions |

Class teacher is a responsibility assigned to a teacher, not unrestricted administrative access. Profile pictures use an approved front enrollment photo, or another approved angle if necessary. Pending/rejected photos are excluded; accounts without an available photo use initials.

## Routes

| Portal | Main paths |
| --- | --- |
| Sign in | `/login/student`, `/login/teacher`, `/login/admin` |
| Teacher | `/teacher/dashboard`, `/teacher/attendance`, `/teacher/history`, `/teacher/history/:sessionId` |
| Class management | `/teacher/students`, `/teacher/classes`, `/teacher/subjects`, `/teacher/biometrics` |
| Student | `/student/attendance`, `/student/attendance/:sessionId`, `/student/biometrics` |
| Administrator | `/admin/dashboard`, `/admin/accounts`, `/admin/classes`, `/admin/subjects`, `/admin/biometrics`, `/admin/settings` |

Refresh and browser Back/Forward preserve the current page. Sign-in returns users to an authorized requested path. Device job links refer to encrypted storage on that particular device and are not portable share links.

## Data, offline operation, and privacy

Official accounts, assignments, sessions, and attendance live in `backend/data/attendance.db`. Enrollment, pending submissions, and classroom media are stored in private subdirectories of `backend/data/`. All image delivery remains authenticated and scoped to the requesting account.

A previously verified teacher can capture against cached assignments while offline. Each frame is compressed, encrypted, and committed to IndexedDB before it is reported saved. Stable request IDs, transactional worker leases, and retry backoff prevent duplicate uploads. Local reviews remain drafts until the backend commits attendance.

Background synchronization depends on browser support. Reopening the app also checks its persistent queue. Browser eviction, cleared site data, and private browsing can affect storage; device encryption does not protect against malicious same-origin JavaScript.

Camera captures are not written to the public gallery. Local images are removed only after a matching confirmed server receipt acknowledges every frame. Confirmed server classroom media expires after 24 hours by default; unfinished sessions are retained for safe resolution. A browser cannot remove gallery originals imported by the user.

See [architecture, offline workflow, retention, and deployment notes](docs/architecture-and-offline.md) for the complete design and limitations.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Administrator bootstrap for a new database |
| `ATTENDLY_DATA_DIR` | Runtime database/media directory; defaults to `backend/data` |
| `ATTENDLY_PRELOAD_MODEL=0` | Skip model prewarming, useful for isolated access tests |
| `ATTENDLY_IMAGE_RETENTION_HOURS` | Confirmed classroom-media retention; default 24 hours |
| `ATTENDLY_SOURCE_CSV` | Optional legacy student import CSV path |
| `ATTENDLY_SOURCE_BIOMETRIC` | Optional legacy import enrollment-photo directory |
| `ATTENDLY_SOURCE_CLASSROOM` | Optional legacy classroom-image source directory |

Sample school data is not imported at startup. `backend/seed.py` is a legacy opt-in import utility; normal setup uses the administrator portal.

## Validation

Run from the repository root:

```bash
backend/venv/bin/python backend/test_access.py
backend/venv/bin/python backend/test_recognition.py
```

The access tests start an isolated server with a temporary database and test media. They do not modify the live school database. `backend/test_suite.py` is an older pre-authentication suite and is not the current regression entry point.

```bash
cd frontend
npm run build
npm run lint
node --test tests/*.test.js
```

With the development server running, open `/tests/offline.html` and select **Run isolated tests**. It uses a temporary IndexedDB database and simulated transport to check persistence, encryption, invalid period counts, retries, worker leases, storage failures, and commit-gated cleanup. `/tests/responsive.html` and the other fixture pages use synthetic data. These pages are excluded from the production build.

### Recognition evaluation

Use [the example manifest](backend/evaluation/example_manifest.json) to prepare separately labeled enrollment, calibration, and evaluation captures, including unknown people. The example references nonexistent files intentionally; it is not a benchmark dataset.

```bash
backend/venv/bin/python backend/evaluate_recognition.py --manifest /absolute/path/manifest.json --output /absolute/path/report.json
```

Cosine scores are not identity probabilities. Quality and consistency rules are heuristics, not general anti-spoof protection or guarantees of accuracy. Evaluate real classroom conditions and validate thresholds before relying on automatic matches. Model and dependency licenses must also be checked for the intended deployment.

## Project structure

```text
backend/
  main.py                  # API, attendance lifecycle, authenticated media
  auth.py                  # Authentication and access control
  administration.py        # Accounts, classes, teacher assignments
  models.py                # Database schema
  face_engine.py           # Model loading and detection
  recognition.py           # Assignment and cross-frame matching policy
  image_quality.py         # Face-quality checks
  retention.py             # Confirmed-session media cleanup
  evaluate_recognition.py  # Labeled-data evaluation
  evaluation/              # Synthetic manifest template
  test_access.py           # Isolated HTTP integration tests
  test_recognition.py      # Recognition regressions
frontend/
  src/views/               # Role-specific portals
  src/components/          # Capture, reviews, profiles, dashboards
  src/offline/             # Durable capture client and review helpers
  src/AppRoutes.jsx        # Protected page routes
  public/offline-core.js   # Encrypted IndexedDB storage
  public/sync-engine.js    # Restart-safe upload and confirmation retries
  public/sw.js             # Offline shell and supported Background Sync
  tests/                   # Unit tests and isolated browser fixtures
docs/                      # Architecture and deployment design
run.sh                     # Local development launcher
```

## Deployment status

The development launcher is not a production deployment. Hosting requires a production frontend build, HTTPS, correct proxy/hostname configuration, persistent database/media storage, unique credentials, backups, and recognition resource testing. A static frontend host alone cannot run the Python recognition backend. No cloud services, paid subscriptions, or public deployment are provisioned by this repository.

## Repository contents

Only application source, design assets, synthetic fixtures, and documentation belong in Git. `.gitignore` excludes runtime school data, databases, credentials, dependencies, build output, and downloaded model weights. Keep backups of real attendance and biometric data outside the code repository.
