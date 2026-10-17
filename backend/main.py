"""
Main FastAPI application.
Face-Recognition Attendance App — single subject, single teacher.
"""
import os
import sys
import shutil
import uuid
import logging
import hashlib
import json
import time
import asyncio
import cv2
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import List, Optional, Literal

import numpy as np
from fastapi import FastAPI, Depends, UploadFile, File, Form, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy.orm import Session as DBSession
from sqlalchemy import func

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import settings
from settings import (
    SUBJECT_NAME, SUBJECT_CODE, TEACHER_NAME,
    PHOTOS_DIR, SESSIONS_DIR, PENDING_DIR, DATA_DIR,
    HOST, PORT
)
from models import (
    init_db, get_db,
    Student, EnrolledPhoto, FaceEmbedding, Session as SessionModel,
    ClassPhoto, AttendanceRecord, PendingBiometric, BiometricLog, SubjectAssignment, Classroom, User
)
from face_engine import (
    detect_faces, extract_single_face_embedding,
    match_face_to_students, annotate_class_photo, save_face_crop,
    cosine_similarity, get_face_app, locate_preview_face
)
from auth import (authorize, ensure_admin, visible_students, visible_sessions, require_session,
                  managed_classes, visible_class_ids, router as auth_router)
from administration import router as admin_router, assignment_data
from recognition import match_faces, policy_digest
from image_quality import image_fingerprint
from session_evidence import session_policy, session_roster, review_analysis

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Maximum upload limit: 20MB
MAX_FILE_SIZE = 20 * 1024 * 1024


def validate_image_file(file: UploadFile):
    """Validate uploaded file is an image and does not exceed size limit."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"File '{file.filename}' is not a valid image.")
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File '{file.filename}' exceeds maximum allowed size (20MB).")


def get_student_or_404(roll_no: str, db: DBSession) -> Student:
    """Retrieve student by roll number or raise HTTP 404."""
    student = db.query(Student).filter(Student.roll_no == roll_no).first()
    if not student:
        raise HTTPException(status_code=404, detail=f"Student '{roll_no}' not found")
    return student


def get_session_or_404(session_id: str, db: DBSession) -> SessionModel:
    """Retrieve session by session_id or raise HTTP 404."""
    session = db.query(SessionModel).filter(SessionModel.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return session


# ── Lifespan Handler ───────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize DB and pre-warm face recognition model."""
    init_db()
    ensure_admin()
    try:
        # Pre-load InsightFace model to prevent long hangs on first photo upload
        if os.getenv("ATTENDLY_PRELOAD_MODEL", "1") == "1":
            get_face_app()
        logger.info("InsightFace model pre-loaded successfully at startup.")
    except Exception as e:
        logger.warning("Could not pre-load InsightFace model at startup: %s", e)
    logger.info("App started. Subject: %s (%s)", settings.SUBJECT_NAME, settings.SUBJECT_CODE)
    async def retention_loop():
        from retention import cleanup_media
        while True:
            try:
                await asyncio.to_thread(cleanup_media)
            except Exception:
                logger.exception("Image retention cleanup failed; will retry")
            await asyncio.sleep(3600)
    retention_task = asyncio.create_task(retention_loop())
    try:
        yield
    finally:
        retention_task.cancel()
        try:
            await retention_task
        except asyncio.CancelledError:
            pass
    logger.info("App shutting down.")


app = FastAPI(title="FaceRecog Attendance", version="2.0.0", lifespan=lifespan,
              dependencies=[Depends(authorize)])
app.include_router(auth_router)
app.include_router(admin_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure directories exist
for d in [DATA_DIR, PHOTOS_DIR, SESSIONS_DIR, PENDING_DIR]:
    os.makedirs(d, exist_ok=True)

# Every image uses the same authenticated, scoped access as the API.
@app.get("/static/{kind}/{file_path:path}")
def private_image(kind: str, file_path: str, db: DBSession = Depends(get_db)):
    from pathlib import Path
    roots = {"photos": PHOTOS_DIR, "sessions": SESSIONS_DIR, "pending": PENDING_DIR}
    if kind not in roots:
        raise HTTPException(404, "Image not found")
    root = Path(roots[kind]).resolve()
    target = (root / file_path).resolve()
    if root not in target.parents or not target.is_file():
        raise HTTPException(404, "Image not found")
    user = db.info["user"]
    if kind in ("photos", "pending"):
        model = EnrolledPhoto if kind == "photos" else PendingBiometric
        record = db.query(model).filter(model.file_path == file_path).first()
        if not record or not visible_students(db).filter(Student.id == record.student_id).first():
            raise HTTPException(404, "Image not found")
        if kind == "pending" and user.role == "teacher":
            student = db.get(Student, record.student_id)
            if student.class_id not in managed_classes(db, user):
                raise HTTPException(403, "Only the class teacher can review biometric updates")
    else:
        session = require_session(db, file_path.split("/")[0])
        if user.role == "student":
            record = db.query(AttendanceRecord).filter(
                AttendanceRecord.session_id == session.id, AttendanceRecord.student_id == user.student_id,
                AttendanceRecord.matched_crop_path == file_path).first()
            class_photo = db.query(ClassPhoto).filter(
                ClassPhoto.session_id == session.id, ClassPhoto.file_path == file_path).first()
            if not record and not class_photo:
                raise HTTPException(403, "Only your own face crop and class photos are available")
    return FileResponse(target, headers={"Cache-Control": "private, no-store"})


@app.middleware("http")
async def private_responses(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/api/assignments")
def my_assignments(db: DBSession = Depends(get_db)):
    user = db.info["user"]
    query = db.query(SubjectAssignment)
    if user.role == "teacher":
        query = query.filter(SubjectAssignment.teacher_id == user.id)
    elif user.role == "student":
        query = query.filter(SubjectAssignment.class_id.in_(visible_class_ids(db, user)))
    return [assignment_data(db, a) for a in query.all()]


# ── Helper: Load all embeddings with in-memory caching ──────────────
_EMBEDDINGS_CACHE = None


def invalidate_embeddings_cache():
    """Clear in-memory embeddings cache when photos/embeddings change."""
    global _EMBEDDINGS_CACHE
    _EMBEDDINGS_CACHE = None


def load_all_embeddings(db: DBSession, force_reload: bool = False) -> dict:
    """Load all student embeddings as {student_id: [np.array, ...]}. Cached in memory."""
    global _EMBEDDINGS_CACHE
    if _EMBEDDINGS_CACHE is not None and not force_reload:
        return _EMBEDDINGS_CACHE

    result = {}
    rows = db.query(FaceEmbedding).all()
    for row in rows:
        emb = np.frombuffer(row.embedding, dtype=np.float32)
        if row.student_id not in result:
            result[row.student_id] = []
        result[row.student_id].append(emb)

    _EMBEDDINGS_CACHE = result
    return result


# ═══════════════════════════════════════════════════════════════════
# CONFIG & SETTINGS
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/config")
async def get_config():
    """Return current app configuration."""
    return {
        "subject_name": settings.SUBJECT_NAME,
        "subject_code": settings.SUBJECT_CODE,
        "teacher_name": settings.TEACHER_NAME,
        "match_threshold": settings.MATCH_THRESHOLD,
        "uncertain_threshold": settings.UNCERTAIN_THRESHOLD,
        "recognition_policy": settings.recognition_policy(),
        "calibration": settings.load_config().get("calibration"),
    }


@app.post("/api/config/thresholds")
async def update_thresholds(
    match_threshold: float = Form(...),
    uncertain_threshold: float = Form(...),
    min_match_margin: float = Form(0.08),
):
    """Update match thresholds (persists to config.json and active immediately)."""
    if not 0 <= uncertain_threshold < match_threshold <= 1:
        raise HTTPException(400, "Thresholds must satisfy 0 ≤ uncertain < match ≤ 1")
    if not 0.01 <= min_match_margin <= 0.5:
        raise HTTPException(400, "Identity margin must be between 0.01 and 0.5")
    settings.save_thresholds(match_threshold, uncertain_threshold, min_match_margin)
    return {
        "message": "Thresholds updated",
        "match": settings.MATCH_THRESHOLD,
        "uncertain": settings.UNCERTAIN_THRESHOLD,
    }


@app.post("/api/config/calibration")
async def activate_calibration(report: UploadFile = File(...), db: DBSession = Depends(get_db)):
    from evaluate_recognition import validate_calibration_report
    content = await report.read(2 * 1024 * 1024 + 1)
    if len(content) > 2 * 1024 * 1024:
        raise HTTPException(400, "Calibration reports must be smaller than 2 MB")
    try:
        data = json.loads(content)
        if not isinstance(data, dict):
            raise ValueError("Expected a calibration report object")
        policy = validate_calibration_report(data)
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise HTTPException(400, str(error))
    settings.save_thresholds(policy["match_threshold"], policy["uncertain_threshold"], policy["min_match_margin"])
    config = settings.load_config()
    config["calibration"] = {
        "dataset_id": data["dataset_id"], "dataset_digest": data["dataset_digest"],
        "activated_at": datetime.now(timezone.utc).isoformat(), "activated_by": db.info["user"].username,
        "target_error_group_rate": data["target_error_group_rate"],
        "calibration_metrics": data["calibration"]["calibration_metrics"],
        "evaluation_metrics": data["calibration"]["evaluation_metrics"],
    }
    settings.save_config(config)
    return {"message": "Validated profile activated for new sessions", "recognition_policy": policy,
            "calibration": config["calibration"]}


# ═══════════════════════════════════════════════════════════════════
# STUDENTS
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/students")
async def list_students(class_id: Optional[int] = None, db: DBSession = Depends(get_db)):
    """List all enrolled students."""
    students = visible_students(db, class_id).order_by(Student.roll_no).all()
    result = []
    for s in students:
        photos = [
            {"id": p.id, "type": p.photo_type, "url": f"/static/photos/{p.file_path}"}
            for p in s.photos
        ]
        result.append({
            "id": s.id,
            "roll_no": s.roll_no,
            "name": s.name,
            "email": s.email,
            "consent_given": s.consent_given,
            "class_id": s.class_id,
            "photos": photos if db.info["user"].role != "student" else [],
            "has_embeddings": len(s.embeddings) > 0,
        })
    return result


@app.get("/api/students/{roll_no}")
async def get_student(roll_no: str, db: DBSession = Depends(get_db)):
    """Get student details by roll number."""
    student = db.query(Student).filter(Student.roll_no == roll_no).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    photos = [
        {"id": p.id, "type": p.photo_type, "url": f"/static/photos/{p.file_path}"}
        for p in student.photos
    ]
    pending = [
        {
            "id": p.id,
            "type": p.photo_type,
            "url": f"/static/pending/{p.file_path}",
            "status": p.status,
            "submitted_at": p.submitted_at.isoformat() if p.submitted_at else None,
        }
        for p in student.pending_updates
    ]

    return {
        "id": student.id,
        "roll_no": student.roll_no,
        "name": student.name,
        "email": student.email,
        "consent_given": student.consent_given,
        "photos": photos,
        "pending_updates": pending,
        "has_embeddings": len(student.embeddings) > 0,
    }


@app.post("/api/students/{roll_no}/consent")
async def give_consent(roll_no: str, db: DBSession = Depends(get_db)):
    """Record student consent for biometric use."""
    student = db.query(Student).filter(Student.roll_no == roll_no).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")
    student.consent_given = True
    db.commit()
    return {"message": "Consent recorded"}


# ═══════════════════════════════════════════════════════════════════
# STUDENT ATTENDANCE
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/students/{roll_no}/attendance")
async def get_student_attendance(roll_no: str, db: DBSession = Depends(get_db)):
    """Get attendance summary and detail for a student."""
    student = db.query(Student).filter(Student.roll_no == roll_no).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    # Get all confirmed sessions
    confirmed_sessions = db.query(SessionModel).filter(
        SessionModel.status == "confirmed",
        SessionModel.id.in_(db.query(AttendanceRecord.session_id).filter(AttendanceRecord.student_id == student.id))
    ).order_by(SessionModel.date).all()

    total_periods = sum(s.periods for s in confirmed_sessions)
    attended_periods = 0
    sessions_data = []

    for session in confirmed_sessions:
        record = db.query(AttendanceRecord).filter(
            AttendanceRecord.session_id == session.id,
            AttendanceRecord.student_id == student.id,
        ).first()

        status = "absent"
        method = None
        confidence = None
        manual_reason = None
        matched_crop_url = None
        class_photo_url = None
        enrolled_photo_url = None

        if record:
            status = record.status
            method = record.method
            confidence = record.confidence
            manual_reason = record.manual_reason

            if record.matched_crop_path:
                matched_crop_url = f"/static/sessions/{record.matched_crop_path}"

            if record.class_photo_id:
                cp = db.query(ClassPhoto).filter(ClassPhoto.id == record.class_photo_id).first()
                if cp:
                    class_photo_url = f"/static/sessions/{cp.file_path}"

            # Get enrolled front photo
            front_photo = db.query(EnrolledPhoto).filter(
                EnrolledPhoto.student_id == student.id,
                EnrolledPhoto.photo_type == "front"
            ).first()
            if front_photo:
                enrolled_photo_url = f"/static/photos/{front_photo.file_path}"

        if status == "present":
            attended_periods += session.periods

        class_photos = []
        for photo in sorted(session.class_photos, key=lambda photo: photo.id):
            analysis = json.loads(photo.analysis_json or '{}')
            detections = []
            for face in analysis.get('results', []):
                own_crop = (record and record.class_photo_id == photo.id and record.matched_crop_path
                            and face.get('crop_path') == record.matched_crop_path)
                if face.get('student_id') == student.id or own_crop:
                    detections.append({"bbox": face.get('bbox'), "label": student.name,
                                       "status": face.get('status'), "confidence": face.get('confidence')})
            class_photos.append({"id": photo.id, "url": f"/static/sessions/{photo.file_path}",
                                 "width": analysis.get('image_width'), "height": analysis.get('image_height'),
                                 "detections": detections})

        sessions_data.append({
            "session_id": session.session_id,
            "date": session.date.replace(tzinfo=timezone.utc).isoformat() if session.date.tzinfo is None else session.date.isoformat(),
            "periods": session.periods,
            "status": status,
            "method": method,
            "confidence": confidence,
            "manual_reason": manual_reason,
            "matched_crop_url": matched_crop_url,
            "class_photo_url": class_photo_url,
            "class_photos": class_photos,
            "subject_name": db.get(SubjectAssignment, session.assignment_id).subject_name if session.assignment_id else "",
            "enrolled_photo_url": enrolled_photo_url,
        })

    percentage = (attended_periods / total_periods * 100) if total_periods > 0 else 0

    return {
        "student_id": student.id,
        "roll_no": student.roll_no,
        "name": student.name,
        "total_periods": total_periods,
        "attended_periods": attended_periods,
        "percentage": round(percentage, 1),
        "total_sessions": len(confirmed_sessions),
        "sessions": sessions_data,
    }


# ═══════════════════════════════════════════════════════════════════
# STUDENT BIOMETRIC UPDATE
# ═══════════════════════════════════════════════════════════════════

@app.post("/api/students/{roll_no}/biometric/guide")
async def biometric_face_guide(roll_no: str, photo: UploadFile = File(...), db: DBSession = Depends(get_db)):
    """Ephemeral enrollment preview. Authorization scopes this to the student."""
    student = get_student_or_404(roll_no, db)
    if not student.consent_given:
        raise HTTPException(403, "Give biometric consent before using the face guide")
    content = await photo.read(512 * 1024 + 1)
    if len(content) > 512 * 1024:
        raise HTTPException(413, "Preview frame is too large")
    # Check dimensions before decoding compressed pixels.
    import io
    from PIL import Image
    try:
        with Image.open(io.BytesIO(content)) as preview:
            if max(preview.size) > 640 or min(preview.size) < 1:
                raise HTTPException(400, "Preview dimensions must be at most 640 pixels")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Invalid preview image")
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "Invalid preview image")
    try:
        return await run_in_threadpool(locate_preview_face, image)
    except Exception:
        raise HTTPException(503, "Face guide temporarily unavailable")


@app.post("/api/students/{roll_no}/biometric/update")
async def submit_biometric_update(
    roll_no: str,
    front: UploadFile = File(...),
    left: UploadFile = File(...),
    right: UploadFile = File(...),
    db: DBSession = Depends(get_db),
):
    """Student submits new biometric photos. Goes to pending state."""
    student = get_student_or_404(roll_no, db)

    if not student.consent_given:
        raise HTTPException(400, "Give biometric consent before submitting photos")

    for upload_file in (front, left, right):
        validate_image_file(upload_file)

    # Create pending directory for this student
    pending_student_dir = os.path.join(PENDING_DIR, roll_no, uuid.uuid4().hex)
    os.makedirs(pending_student_dir, exist_ok=True)

    warnings = []
    pending_records = []

    for photo_type, upload_file in [("front", front), ("left", left), ("right", right)]:
        # Save uploaded file
        filename = f"{photo_type}.jpg"
        file_path = os.path.join(pending_student_dir, filename)

        with open(file_path, "wb") as f:
            content = await upload_file.read()
            f.write(content)

        image = cv2.imread(file_path)
        if image is None or image.shape[0] * image.shape[1] > 40_000_000:
            shutil.rmtree(pending_student_dir, ignore_errors=True)
            db.rollback()
            raise HTTPException(400, f"The {photo_type} photo cannot be read or is too large. Capture it again.")
        if not cv2.imwrite(file_path, image):
            shutil.rmtree(pending_student_dir, ignore_errors=True)
            db.rollback()
            raise HTTPException(500, "Could not save your photo. Please retry.")
        # Quality checks are advice, not a teacher's rejection decision. Keep
        # readable submissions private and pending; validate again on approval.
        try:
            embedding, error = extract_single_face_embedding(file_path)
            validation = {"status": "needs_retake" if error or embedding is None else "ready",
                          "message": error or ("Could not compute a face embedding" if embedding is None else "One clear face detected")}
        except Exception:
            logger.exception("Enrollment precheck unavailable")
            validation = {"status": "unchecked", "message": "Automatic checks are temporarily unavailable. Your teacher can review this photo."}
        if validation['status'] != 'ready':
            warnings.append({"photo_type": photo_type, "message": validation['message']})

        # Create pending record
        rel_path = os.path.relpath(file_path, PENDING_DIR)
        pending = PendingBiometric(
            student_id=student.id,
            photo_type=photo_type,
            file_path=rel_path,
            status="pending", validation_json=json.dumps(validation)
        )
        db.add(pending)
        pending_records.append(photo_type)

    db.commit()

    return {
        "message": "Biometric update submitted for review",
        "accepted": pending_records,
        "errors": [], "warnings": warnings,
    }


@app.get("/api/students/{roll_no}/biometric/status")
async def get_biometric_status(roll_no: str, db: DBSession = Depends(get_db)):
    """Check the status of pending biometric updates for a student."""
    student = db.query(Student).filter(Student.roll_no == roll_no).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    pending = db.query(PendingBiometric).filter(
        PendingBiometric.student_id == student.id
    ).order_by(PendingBiometric.submitted_at.desc(), PendingBiometric.id.desc()).all()

    return [{
        "id": p.id,
        "photo_type": p.photo_type,
        "url": f"/static/pending/{p.file_path}",
        "status": p.status,
        "submitted_at": p.submitted_at.isoformat() if p.submitted_at else None,
        "reviewed_at": p.reviewed_at.isoformat() if p.reviewed_at else None,
        "validation": json.loads(p.validation_json) if p.validation_json else None,
        "review_note": p.review_note,
    } for p in pending]


# ═══════════════════════════════════════════════════════════════════
# TEACHER: TAKE ATTENDANCE
# ═══════════════════════════════════════════════════════════════════

@app.post("/api/sessions/create")
async def create_session(
    periods: int = Form(1),
    assignment_id: int = Form(...),
    client_request_id: Optional[str] = Form(None),
    capture_mode: Literal["single", "panorama"] = Form("single"),
    captured_at: Optional[str] = Form(None),
    db: DBSession = Depends(get_db),
):
    """Create a new attendance session with date-based ID."""
    assignment = db.get(SubjectAssignment, assignment_id)
    user = db.info["user"]
    if not assignment or (user.role != "admin" and assignment.teacher_id != user.id):
        raise HTTPException(403, "You can only take attendance for your assigned subjects")
    if not 1 <= periods <= 4:
        raise HTTPException(400, "Periods must be between 1 and 4")
    if not db.query(Student).filter(Student.class_id == assignment.class_id).count():
        raise HTTPException(400, "Add students to this class before taking attendance")
    if client_request_id:
        try:
            uuid.UUID(client_request_id)
        except ValueError:
            raise HTTPException(400, "Invalid session request ID")
        previous = db.query(SessionModel).filter(SessionModel.created_by == user.id, SessionModel.client_request_id == client_request_id).first()
        if previous:
            if previous.assignment_id != assignment_id or previous.periods != periods or previous.capture_mode != capture_mode:
                raise HTTPException(409, "This request ID belongs to a different attendance capture")
            return {"id": previous.id, "session_id": previous.session_id, "date": previous.date.isoformat(),
                    "periods": previous.periods, "status": previous.status, "capture_mode": previous.capture_mode}
    now = datetime.now(timezone.utc)
    if captured_at:
        try:
            captured = datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
            if not captured.tzinfo or abs((now - captured).total_seconds()) > 30 * 86400 or (captured - now).total_seconds() > 300:
                raise ValueError()
            now = captured
        except ValueError:
            raise HTTPException(400, "Capture time must be a valid timestamp within the last 30 days")
    date_str = now.strftime("%Y%m%d")

    session_id = f"SES-{date_str}-{uuid.uuid4().hex[:8]}"

    session = SessionModel(
        session_id=session_id,
        date=now,
        periods=periods,
        status="active",
        assignment_id=assignment_id,
        created_by=user.id,
        recognition_policy_json=json.dumps(dict(settings.recognition_policy(), capture_mode=capture_mode)),
        client_request_id=client_request_id, capture_mode=capture_mode,
    )
    db.add(session)
    db.commit()
    db.refresh(session)

    # Create session directory for photos
    session_dir = os.path.join(SESSIONS_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    return {
        "id": session.id,
        "session_id": session.session_id,
        "date": session.date.isoformat(),
        "periods": session.periods,
        "status": session.status,
    }


@app.get("/api/sessions/{session_id}/analysis")
async def get_session_analysis(session_id: str, db: DBSession = Depends(get_db)):
    if db.info["user"].role == "student":
        raise HTTPException(403, "Class review is only available to the assigned teacher")
    return review_analysis(db, get_session_or_404(session_id, db))


@app.post("/api/sessions/{session_id}/upload")
async def upload_class_photo(session_id: str, photo: UploadFile = File(...), client_photo_id: Optional[str] = Form(None), db: DBSession = Depends(get_db)):
    """Save quality, global assignment, and evidence on the server, never the browser."""
    started = time.perf_counter()
    validate_image_file(photo)
    session = get_session_or_404(session_id, db)
    content = await photo.read()
    digest = hashlib.sha256(content).hexdigest()
    previous = None
    if client_photo_id:
        import re
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", client_photo_id):
            raise HTTPException(400, "Invalid photo request ID")
        previous = db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id, ClassPhoto.client_photo_id == client_photo_id).first()
        if previous and previous.content_hash != digest:
            raise HTTPException(409, "This photo request ID belongs to different image content")
    duplicate = db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id, ClassPhoto.content_hash == digest).first()
    previous = previous or (duplicate if client_photo_id else None)
    if previous:
        return {"class_photo_id": previous.id, "class_photo_url": f"/static/sessions/{previous.file_path}",
                "annotated_photo_url": f"/static/sessions/{previous.annotated_path}", "already_uploaded": True,
                "session_analysis": review_analysis(db, session)}
    if duplicate:
        raise HTTPException(409, "This photo is already in the session. Take a new view for independent evidence.")
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "This file cannot be decoded as an image")
    if image.shape[0] * image.shape[1] > 40_000_000:
        raise HTTPException(400, "Use a photo smaller than 40 megapixels")
    policy = session_policy(session)
    if not session.recognition_policy_json:
        session.recognition_policy_json = json.dumps(policy)
    session_dir = os.path.join(SESSIONS_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    filename = f"class_{uuid.uuid4().hex[:12]}.jpg"
    photo_path = os.path.join(session_dir, filename)
    # Decode and save consistently: submitted extensions/EXIF never control paths.
    if not cv2.imwrite(photo_path, image):
        raise HTTPException(500, "Could not store the classroom image")
    detection_started = time.perf_counter()
    try:
        faces, error = detect_faces(photo_path, policy=policy)
    except Exception:
        os.remove(photo_path)
        logger.exception("Face processing failed")
        raise HTTPException(503, "Face processing is unavailable. Try again or review attendance manually.")
    detection_ms = (time.perf_counter() - detection_started) * 1000
    if faces is None:
        os.remove(photo_path)
        raise HTTPException(400, error)
    roster = session_roster(db, session)
    roster_ids = {student.id for student in roster if student.consent_given}
    gallery = {sid: entries for sid, entries in load_all_embeddings(db).items() if sid in roster_ids}
    matching_started = time.perf_counter()
    matches = match_faces(faces, gallery, policy)
    matching_ms = (time.perf_counter() - matching_started) * 1000
    students = {student.id: student for student in roster}
    front = {p.student_id: p.file_path for p in db.query(EnrolledPhoto).filter(
        EnrolledPhoto.student_id.in_(roster_ids), EnrolledPhoto.photo_type == "front")}
    results, annotations = [], []
    for face, match in zip(faces, matches):
        crop_filename = f"crop_{uuid.uuid4().hex[:12]}.jpg"
        crop_path = os.path.join(session_dir, crop_filename)
        cropped = save_face_crop(photo_path, face["bbox"], crop_path)
        relative_crop = os.path.join(session_id, crop_filename) if cropped else None
        student = students.get(match["student_id"])
        label = student.name if student else "Retake face" if match["status"] == "quality_rejected" else "Unknown"
        row = dict(match, bbox=face["bbox"], det_score=face["det_score"], crop_path=relative_crop,
                   crop_url=f"/static/sessions/{relative_crop}" if relative_crop else None,
                   name=label, roll_no=student.roll_no if student else "",
                   enrolled_photo_url=f"/static/photos/{front[student.id]}" if student and student.id in front else None,
                   embedding=np.asarray(face["embedding"]).tolist() if np.isfinite(face["embedding"]).all() else [])
        results.append(row)
        annotations.append(dict(row, label=label))
    annotated = f"annotated_{filename}"
    annotate_class_photo(photo_path, annotations, os.path.join(session_dir, annotated))
    timings = {"detection_ms": round(detection_ms, 2), "matching_ms": round(matching_ms, 2),
               "total_ms": round((time.perf_counter() - started) * 1000, 2)}
    analysis = {"results": results, "fingerprint": image_fingerprint(image), "timings": timings,
                "image_width": image.shape[1], "image_height": image.shape[0],
                "policy_digest": policy_digest(policy), "algorithm_version": policy["algorithm_version"]}
    class_photo = ClassPhoto(session_id=session.id, file_path=os.path.join(session_id, filename),
                             annotated_path=os.path.join(session_id, annotated), content_hash=digest,
                             analysis_json=json.dumps(analysis, allow_nan=False), client_photo_id=client_photo_id)
    db.add(class_photo)
    db.commit()
    db.refresh(class_photo)
    public_results = [{key: value for key, value in row.items() if key != "embedding"} for row in results]
    return {"class_photo_id": class_photo.id, "class_photo_url": f"/static/sessions/{class_photo.file_path}",
            "annotated_photo_url": f"/static/sessions/{class_photo.annotated_path}",
            "faces_detected": len(faces), "results": public_results, "timings": timings,
            "message": error or ("Some faces need a clearer photo" if any(not f["quality"]["accepted"] for f in faces) else "Photo processed"),
            "session_analysis": review_analysis(db, session)}


@app.post("/api/sessions/{session_id}/confirm")
async def confirm_session(session_id: str, records: str = Form(...), periods: Optional[int] = Form(None), db: DBSession = Depends(get_db)):
    session = get_session_or_404(session_id, db)
    try:
        submitted = json.loads(records)
    except (ValueError, TypeError):
        raise HTTPException(400, "Attendance records must be valid JSON")
    if not isinstance(submitted, list):
        raise HTTPException(400, "Attendance records must be a list")
    if periods is not None and not 1 <= periods <= 4:
        raise HTTPException(400, "Periods must be between 1 and 4")
    confirmation = {"records": submitted, "periods": periods} if periods is not None else submitted
    digest = hashlib.sha256(json.dumps(confirmation, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if session.status == "confirmed":
        if session.confirmation_digest == digest:
            return {"message": "Attendance was already committed", "session_id": session.session_id, "status": "confirmed"}
        raise HTTPException(409, "Attendance is already finalized. It cannot be overwritten by a retry.")
    if not 1 <= (periods if periods is not None else session.periods) <= 4:
        raise HTTPException(400, "Choose between 1 and 4 periods before confirming attendance")
    if session.capture_mode == "panorama" and db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id).count() < 3:
        raise HTTPException(409, "Panorama mode requires three different captured views before finalization")
    analysis = review_analysis(db, session)
    evidence = {row["student_id"]: row for row in analysis["results"]}
    seen = set()
    for row in submitted:
        if not isinstance(row, dict) or row.get("student_id") not in evidence:
            raise HTTPException(400, "Attendance contains a student outside this class")
        if row["student_id"] in seen:
            raise HTTPException(400, "A student cannot appear twice in one submission")
        seen.add(row["student_id"])
        if row.get("status") not in ("present", "absent") or row.get("method") not in ("manual", "auto"):
            raise HTTPException(400, "Choose a valid attendance status and method")
        current = evidence[row["student_id"]]
        if row["method"] == "auto":
            if row["status"] != "present" or current["status"] != "matched":
                raise HTTPException(409, "Automatic attendance needs consistent independent photo evidence. Review this student manually.")
        elif not isinstance(row.get("manual_reason"), str) or not 1 <= len(row["manual_reason"].strip()) <= 200:
            raise HTTPException(400, "Every manual present or absent decision needs a reason")
    if seen != set(evidence):
        raise HTTPException(409, "Review every student before confirming. Missing detections never prove absence.")
    for row in submitted:
        current = evidence[row["student_id"]]
        decision = {"analysis": current, "policy": analysis["policy"], "policy_digest": analysis["policy_digest"],
                    "reviewed_by": db.info["user"].username, "reviewed_at": datetime.now(timezone.utc).isoformat()}
        record = db.query(AttendanceRecord).filter(AttendanceRecord.session_id == session.id,
                                                   AttendanceRecord.student_id == row["student_id"]).first()
        if record is None:
            record = AttendanceRecord(session_id=session.id, student_id=row["student_id"])
            db.add(record)
        record.status, record.method = row["status"], row["method"]
        record.confidence = current.get("confidence")
        record.matched_crop_path = current.get("crop_path")
        record.class_photo_id = current.get("class_photo_id")
        record.manual_reason = row["manual_reason"].strip() if row["method"] == "manual" else None
        record.decision_detail = json.dumps(decision, allow_nan=False)
    if periods is not None:
        session.periods = periods
    session.status, session.confirmed_at = "confirmed", datetime.now(timezone.utc)
    session.confirmation_digest = digest
    db.commit()
    return {"message": "Session confirmed", "session_id": session.session_id}


@app.post("/api/sessions/{session_id}/manual-mark")
async def manual_mark(
    session_id: str,
    student_id: int = Form(...),
    reason: str = Form(...),
    db: DBSession = Depends(get_db),
):
    """Manually mark a student as present with a reason."""
    session = get_session_or_404(session_id, db)
    if student_id not in {s.id for s in session_roster(db, session)}:
        raise HTTPException(400, "Student is not in this class")
    if not reason.strip():
        raise HTTPException(400, "A manual decision needs a reason")

    return {
        "student_id": student_id,
        "status": "present",
        "method": "manual",
        "manual_reason": reason,
    }


# ═══════════════════════════════════════════════════════════════════
# TEACHER: SESSION HISTORY & EXPORT
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/sessions")
async def list_sessions(db: DBSession = Depends(get_db)):
    """List all sessions with aggregate statistics (O(1) queries instead of N+1)."""
    sessions = visible_sessions(db).order_by(SessionModel.date.desc()).all()

    # Pre-aggregate present counts across all sessions in a single GROUP BY query
    present_counts_raw = (
        db.query(AttendanceRecord.session_id, func.count(AttendanceRecord.id))
        .filter(AttendanceRecord.status == "present")
        .group_by(AttendanceRecord.session_id)
        .all()
    )
    present_counts = {sess_id: count for sess_id, count in present_counts_raw}

    result = []
    for s in sessions:
        photos = [
            {
                "id": p.id,
                "url": f"/static/sessions/{p.file_path}",
                "annotated_url": f"/static/sessions/{p.annotated_path}" if p.annotated_path else None,
            }
            for p in s.class_photos
        ]

        result.append({
            "id": s.id,
            "session_id": s.session_id,
            "date": s.date.isoformat(),
            "periods": s.periods,
            "status": s.status,
            "total_students": len(s.records),
            "subject_name": db.get(SubjectAssignment, s.assignment_id).subject_name if s.assignment_id else "",
            "class_name": db.get(Classroom, db.get(SubjectAssignment, s.assignment_id).class_id).name if s.assignment_id else "",
            "present_count": present_counts.get(s.id, 0),
            "photos": photos if db.info["user"].role != "student" else [],
        })
    return result


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str, db: DBSession = Depends(get_db)):
    """Get detailed session info including per-student attendance with eager loading."""
    session = get_session_or_404(session_id, db)

    records_query = db.query(AttendanceRecord).filter(AttendanceRecord.session_id == session.id)
    if db.info["user"].role == "student":
        records_query = records_query.filter(AttendanceRecord.student_id == db.info["user"].student_id)
    records = records_query.all()

    # Pre-fetch all students and front photos in batch to eliminate N+1 queries
    all_students = {s.id: s for s in db.query(Student).all()}
    front_photos = {
        p.student_id: p.file_path
        for p in db.query(EnrolledPhoto).filter(EnrolledPhoto.photo_type == "front").all()
    }

    students_data = []
    for rec in records:
        student = all_students.get(rec.student_id)
        front_file = front_photos.get(rec.student_id)

        students_data.append({
            "student_id": rec.student_id,
            "roll_no": student.roll_no if student else "",
            "name": student.name if student else "",
            "status": rec.status,
            "method": rec.method,
            "confidence": rec.confidence,
            "manual_reason": rec.manual_reason,
            "crop_url": f"/static/sessions/{rec.matched_crop_path}" if rec.matched_crop_path else None,
            "enrolled_photo_url": f"/static/photos/{front_file}" if front_file else None,
        })

    photos = [
        {
            "id": p.id,
            "url": f"/static/sessions/{p.file_path}",
            "annotated_url": f"/static/sessions/{p.annotated_path}" if p.annotated_path else None,
        }
        for p in session.class_photos
    ]

    return {
        "id": session.id,
        "session_id": session.session_id,
        "assignment_id": session.assignment_id,
        "processed_photos": [{"id": p.id, "client_photo_id": p.client_photo_id, "content_hash": p.content_hash} for p in session.class_photos] if db.info["user"].role != "student" else [],
        "capture_mode": session.capture_mode,
        "images_deleted_at": session.images_deleted_at.isoformat() if session.images_deleted_at else None,
        "date": session.date.isoformat(),
        "periods": session.periods,
        "status": session.status,
        "photos": photos if db.info["user"].role != "student" and not session.images_deleted_at else [],
        "students": students_data,
    }


@app.get("/api/sessions/{session_id}/export")
async def export_session_attendance(session_id: str, db: DBSession = Depends(get_db)):
    """Export session attendance records to a downloadable CSV file."""
    import io
    import csv
    from fastapi.responses import Response

    session = get_session_or_404(session_id, db)
    records_query = db.query(AttendanceRecord).filter(AttendanceRecord.session_id == session.id)
    if db.info["user"].role == "student":
        records_query = records_query.filter(AttendanceRecord.student_id == db.info["user"].student_id)
    records = records_query.all()
    all_students = {s.id: s for s in db.query(Student).all()}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Roll No", "Student Name", "Status", "Method", "Confidence",
        "Manual Reason", "Session ID", "Date", "Subject", "Periods"
    ])

    for rec in records:
        st = all_students.get(rec.student_id)
        writer.writerow([
            st.roll_no if st else "N/A",
            st.name if st else "N/A",
            rec.status,
            rec.method,
            f"{rec.confidence:.4f}" if rec.confidence is not None else "",
            rec.manual_reason or "",
            session.session_id,
            session.date.strftime("%Y-%m-%d %H:%M"),
            db.get(SubjectAssignment, session.assignment_id).subject_name if session.assignment_id else "",
            session.periods,
        ])

    csv_data = output.getvalue()
    filename = f"attendance_{session.session_id}.csv"
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# ═══════════════════════════════════════════════════════════════════
# TEACHER: BIOMETRIC MANAGEMENT
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/biometrics/pending")
async def list_pending_biometrics(db: DBSession = Depends(get_db)):
    """List all pending biometric updates."""
    roster = visible_students(db)
    if db.info["user"].role != "admin":
        roster = roster.filter(Student.class_id.in_(managed_classes(db, db.info["user"])))
    pending = db.query(PendingBiometric).filter(
        PendingBiometric.status == "pending",
        PendingBiometric.student_id.in_(roster.with_entities(Student.id))
    ).all()

    result = []
    for p in pending:
        student = db.query(Student).filter(Student.id == p.student_id).first()
        result.append({
            "id": p.id,
            "student_id": p.student_id,
            "roll_no": student.roll_no if student else "",
            "name": student.name if student else "",
            "photo_type": p.photo_type,
            "url": f"/static/pending/{p.file_path}",
            "submitted_at": p.submitted_at.isoformat() if p.submitted_at else None,
            "validation": json.loads(p.validation_json) if p.validation_json else None,
        })
    return result


@app.post("/api/biometrics/pending/{pending_id}/approve")
async def approve_pending_biometric(pending_id: int, db: DBSession = Depends(get_db)):
    """Approve a pending biometric update. Replaces the old photo and recomputes embedding."""
    pending = db.query(PendingBiometric).filter(PendingBiometric.id == pending_id).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Pending update not found")

    student = db.query(Student).filter(Student.id == pending.student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    if pending.status == "approved":
        return {"message": f"Already approved {pending.photo_type} photo for {student.name}"}
    if pending.status != "pending":
        raise HTTPException(409, "This update has already been reviewed")
    src_path = os.path.join(PENDING_DIR, pending.file_path)
    embedding, error = extract_single_face_embedding(src_path, allow_quality_override=True)
    if error or embedding is None:
        raise HTTPException(400, "Cannot activate this photo because a usable single-face embedding could not be extracted. " + (error or "Please submit another photo."))
    # Validate the update before replacing an existing enrollment photo.
    student_photo_dir = os.path.join(PHOTOS_DIR, student.roll_no)
    os.makedirs(student_photo_dir, exist_ok=True)
    dst_filename = f"{pending.photo_type}.jpg"
    dst_path = os.path.join(student_photo_dir, dst_filename)

    shutil.copy2(src_path, dst_path)

    # Update or create enrolled photo record
    existing_photo = db.query(EnrolledPhoto).filter(
        EnrolledPhoto.student_id == student.id,
        EnrolledPhoto.photo_type == pending.photo_type,
    ).first()

    rel_path = os.path.join(student.roll_no, dst_filename)
    if existing_photo:
        existing_photo.file_path = rel_path
        existing_photo.uploaded_at = datetime.now(timezone.utc)
        existing_photo.uploaded_by = "student"
        photo_id = existing_photo.id
    else:
        new_photo = EnrolledPhoto(
            student_id=student.id,
            photo_type=pending.photo_type,
            file_path=rel_path,
            uploaded_by="student",
        )
        db.add(new_photo)
        db.flush()
        photo_id = new_photo.id

    # Remove old embedding for this photo type
    if existing_photo:
        db.query(FaceEmbedding).filter(
            FaceEmbedding.student_id == student.id,
            FaceEmbedding.photo_id == existing_photo.id,
        ).delete()

    # Store the validated embedding.
    if embedding is not None:
        emb_record = FaceEmbedding(
            student_id=student.id,
            photo_id=photo_id,
            embedding=embedding.tobytes(),
        )
        db.add(emb_record)

    # Invalidate cached embeddings
    invalidate_embeddings_cache()

    # Update pending status
    pending.status = "approved"
    pending.reviewed_at = datetime.now(timezone.utc)
    pending.reviewed_by = db.info["user"].username
    validation = json.loads(pending.validation_json or '{}')
    quality_override = validation.get('status') == 'needs_retake'
    pending.review_note = "Approved by reviewer despite automatic quality suggestions." if quality_override else None

    # Log
    log = BiometricLog(
        student_id=student.id,
        action="approve",
        detail=f"Approved {pending.photo_type} photo update" + ("; reviewer overrode quality suggestions: " + str(validation.get('message', '')) if quality_override else ""),
        performed_by=db.info["user"].username,
    )
    db.add(log)

    db.commit()
    return {"message": f"Approved {pending.photo_type} photo for {student.name}"}


@app.post("/api/biometrics/pending/{pending_id}/reject")
async def reject_pending_biometric(pending_id: int, reason: str = Form("Please submit a clearer photo showing one face."), db: DBSession = Depends(get_db)):
    """Reject a pending biometric update."""
    pending = db.query(PendingBiometric).filter(PendingBiometric.id == pending_id).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Pending update not found")

    if pending.status != "pending":
        raise HTTPException(409, "This update has already been reviewed")
    if not reason.strip() or len(reason.strip()) > 200:
        raise HTTPException(400, "Give a review reason of 1–200 characters")
    pending.status = "rejected"
    pending.review_note = reason.strip()
    pending.reviewed_at = datetime.now(timezone.utc)
    pending.reviewed_by = db.info["user"].username

    student = db.query(Student).filter(Student.id == pending.student_id).first()

    log = BiometricLog(
        student_id=pending.student_id,
        action="reject",
        detail=f"Rejected {pending.photo_type} photo update",
        performed_by=db.info["user"].username,
    )
    db.add(log)
    db.commit()

    return {"message": f"Rejected {pending.photo_type} photo for {student.name if student else 'unknown'}"}


@app.post("/api/biometrics/{student_id}/upload")
async def teacher_upload_photo(
    student_id: int,
    photo_type: str = Form(...),
    photo: UploadFile = File(...),
    db: DBSession = Depends(get_db),
):
    """Teacher adds/replaces a biometric photo for a student."""
    validate_image_file(photo)
    if photo_type not in ("front", "left", "right"):
        raise HTTPException(400, "Photo type must be front, left, or right")
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    if not student.consent_given:
        raise HTTPException(400, "This student must give biometric consent in their portal first")

    # Save photo
    student_photo_dir = os.path.join(PHOTOS_DIR, student.roll_no)
    os.makedirs(student_photo_dir, exist_ok=True)
    dst_filename = f"{photo_type}.jpg"
    dst_path = os.path.join(student_photo_dir, dst_filename)

    staging_path = os.path.join(student_photo_dir, f"upload_{uuid.uuid4().hex}.jpg")
    with open(staging_path, "wb") as f:
        content = await photo.read()
        f.write(content)

    # Validate face
    embedding, error = extract_single_face_embedding(staging_path)
    if error:
        os.remove(staging_path)
        raise HTTPException(status_code=400, detail=error)

    os.replace(staging_path, dst_path)

    # Update or create photo record
    existing = db.query(EnrolledPhoto).filter(
        EnrolledPhoto.student_id == student.id,
        EnrolledPhoto.photo_type == photo_type,
    ).first()

    rel_path = os.path.join(student.roll_no, dst_filename)
    if existing:
        existing.file_path = rel_path
        existing.uploaded_at = datetime.now(timezone.utc)
        existing.uploaded_by = "teacher"
        photo_id = existing.id

        # Remove old embedding
        db.query(FaceEmbedding).filter(
            FaceEmbedding.student_id == student.id,
            FaceEmbedding.photo_id == existing.id,
        ).delete()
    else:
        new_photo = EnrolledPhoto(
            student_id=student.id,
            photo_type=photo_type,
            file_path=rel_path,
            uploaded_by="teacher",
        )
        db.add(new_photo)
        db.flush()
        photo_id = new_photo.id

    # Store embedding
    emb_record = FaceEmbedding(
        student_id=student.id,
        photo_id=photo_id,
        embedding=embedding.tobytes(),
    )
    db.add(emb_record)

    # Invalidate cached embeddings
    invalidate_embeddings_cache()

    # Log
    log = BiometricLog(
        student_id=student.id,
        action="add" if not existing else "replace",
        detail=f"Teacher uploaded {photo_type} photo",
        performed_by=db.info["user"].username,
    )
    db.add(log)

    db.commit()
    return {"message": f"Photo {photo_type} uploaded for {student.name}"}


@app.delete("/api/biometrics/{student_id}/photos/{photo_type}")
async def teacher_delete_photo(
    student_id: int,
    photo_type: str,
    db: DBSession = Depends(get_db),
):
    """Teacher deletes a specific biometric photo."""
    student = db.query(Student).filter(Student.id == student_id).first()
    if not student:
        raise HTTPException(status_code=404, detail="Student not found")

    photo = db.query(EnrolledPhoto).filter(
        EnrolledPhoto.student_id == student.id,
        EnrolledPhoto.photo_type == photo_type,
    ).first()

    if not photo:
        raise HTTPException(status_code=404, detail=f"No {photo_type} photo found")

    # Remove embedding
    db.query(FaceEmbedding).filter(FaceEmbedding.photo_id == photo.id).delete()

    # Invalidate cached embeddings
    invalidate_embeddings_cache()

    # Remove file
    file_path = os.path.join(PHOTOS_DIR, photo.file_path)
    if os.path.exists(file_path):
        os.remove(file_path)

    # Remove record
    db.delete(photo)

    # Log
    log = BiometricLog(
        student_id=student.id,
        action="delete",
        detail=f"Teacher deleted {photo_type} photo",
        performed_by=db.info["user"].username,
    )
    db.add(log)

    db.commit()
    return {"message": f"Deleted {photo_type} photo for {student.name}"}


@app.get("/api/biometrics/logs")
async def get_biometric_logs(
    student_id: Optional[int] = None,
    db: DBSession = Depends(get_db),
):
    """Get biometric change audit trail."""
    roster = visible_students(db)
    if db.info["user"].role != "admin":
        roster = roster.filter(Student.class_id.in_(managed_classes(db, db.info["user"])))
    query = db.query(BiometricLog).filter(BiometricLog.student_id.in_(roster.with_entities(Student.id))).order_by(BiometricLog.performed_at.desc())
    if student_id:
        query = query.filter(BiometricLog.student_id == student_id)

    logs = query.limit(100).all()
    result = []
    for log in logs:
        student = db.query(Student).filter(Student.id == log.student_id).first()
        result.append({
            "id": log.id,
            "student_id": log.student_id,
            "roll_no": student.roll_no if student else "",
            "student_name": student.name if student else "",
            "action": log.action,
            "detail": log.detail,
            "performed_by": log.performed_by,
            "performed_at": log.performed_at.isoformat() if log.performed_at else None,
        })
    return result


# ═══════════════════════════════════════════════════════════════════
# DASHBOARD STATS
# ═══════════════════════════════════════════════════════════════════

@app.get("/api/stats/overview")
async def get_overview_stats(db: DBSession = Depends(get_db)):
    """Overall attendance stats for teacher dashboard."""
    sessions = visible_sessions(db).filter(SessionModel.status == "confirmed").all()
    return {
        "total_students": visible_students(db).count(),
        "total_sessions": len(sessions),
        "total_periods": sum(s.periods for s in sessions),
    }


# ═══════════════════════════════════════════════════════════════════
# RUN
# ═══════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
