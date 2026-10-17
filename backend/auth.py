"""Cookie authentication and server-side class/subject access rules."""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession
from models import (get_db, SessionLocal, User, LoginSession, Student, Classroom,
                    SubjectAssignment, Session as AttendanceSession, PendingBiometric)

router = APIRouter(prefix="/api/auth")
COOKIE = "facerecog_session"


def hash_password(password):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 600000).hex()
    return f"pbkdf2_sha256$600000${salt}${digest}"


def verify_password(password, stored):
    _, iterations, salt, expected = stored.split("$")
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    return hmac.compare_digest(actual, expected)


def ensure_admin():
    with SessionLocal() as db:
        if not db.query(User).filter(User.role == "admin").first():
            db.add(User(username=os.getenv("ADMIN_USERNAME", "admin").lower(), name="Administrator",
                        role="admin", password_hash=hash_password(os.getenv("ADMIN_PASSWORD", "Admin@12345"))))
            db.commit()


def managed_classes(db, user):
    return [c.id for c in db.query(Classroom).filter(Classroom.class_teacher_id == user.id).all()]


def user_data(db, user):
    student = db.get(Student, user.student_id) if user.student_id else None
    classroom = db.get(Classroom, student.class_id) if student and student.class_id else None
    photo = next((p for p in student.photos if p.photo_type == "front"), None) if student and student.consent_given else None
    if not photo and student and student.consent_given:
        photo = next(iter(student.photos), None)
    return {"id": user.id, "username": user.username, "name": user.name, "role": user.role,
            "student_id": user.student_id, "roll_no": student.roll_no if student else None,
            "class_id": student.class_id if student else None,
            "class_name": classroom.name if classroom else None,
            "email": student.email if student else None,
            "profile_photo_url": f"/static/photos/{photo.file_path}" if photo else None,
            "managed_class_ids": managed_classes(db, user)}


def current_user(request: Request, db: DBSession = Depends(get_db)):
    token = request.cookies.get(COOKIE, "")
    login = db.query(LoginSession).filter(
        LoginSession.token_hash == hashlib.sha256(token.encode()).hexdigest(),
        LoginSession.expires_at > datetime.utcnow()).first() if token else None
    user = db.get(User, login.user_id) if login else None
    if not user:
        raise HTTPException(401, "Please sign in to continue")
    return user


def visible_class_ids(db, user):
    if user.role == "admin":
        return [c.id for c in db.query(Classroom).all()]
    if user.role == "student":
        student = db.get(Student, user.student_id)
        return [student.class_id] if student else []
    assigned = [a.class_id for a in db.query(SubjectAssignment).filter(SubjectAssignment.teacher_id == user.id)]
    return list(set(assigned + managed_classes(db, user)))


def visible_students(db, class_id=None):
    user = db.info["user"]
    query = db.query(Student)
    if user.role == "student":
        query = query.filter(Student.id == user.student_id)
    elif user.role != "admin":
        query = query.filter(Student.class_id.in_(visible_class_ids(db, user)))
    if class_id is not None:
        query = query.filter(Student.class_id == class_id)
    return query


def visible_sessions(db):
    user = db.info["user"]
    query = db.query(AttendanceSession)
    if user.role == "teacher":
        ids = [a.id for a in db.query(SubjectAssignment).filter(SubjectAssignment.teacher_id == user.id)]
        query = query.filter(AttendanceSession.assignment_id.in_(ids))
    elif user.role == "student":
        from models import AttendanceRecord
        query = query.filter(AttendanceSession.id.in_(
            db.query(AttendanceRecord.session_id).filter(AttendanceRecord.student_id == user.student_id)))
    return query


def require_manager(db, class_id=None):
    user = db.info["user"]
    if user.role == "admin":
        return
    if user.role != "teacher" or class_id not in managed_classes(db, user):
        raise HTTPException(403, "Only the admin or this class's class teacher can manage it")


def require_session(db, session_id, write=False):
    session = visible_sessions(db).filter(AttendanceSession.session_id == session_id).first()
    if not session:
        raise HTTPException(404, "Session not found")
    if write and db.info["user"].role == "student":
        raise HTTPException(403, "Students cannot take attendance")
    if write and session.status == "confirmed":
        raise HTTPException(409, "This session is already confirmed")
    return session


async def authorize(request: Request, db: DBSession = Depends(get_db)):
    path = request.url.path
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        trusted_origins = os.getenv("ATTENDLY_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
        if origin and urlsplit(origin).netloc != request.headers.get("host") and origin not in trusted_origins:
            raise HTTPException(403, "Request origin is not allowed")
    if path == "/api/auth/login":
        return
    user = current_user(request, db)
    db.info["user"] = user
    if path.startswith("/api/auth/"):
        return
    if path.startswith("/api/admin"):
        if user.role != "admin" and not managed_classes(db, user):
            raise HTTPException(403, "Administrative access required")
    if path in ("/api/config/thresholds", "/api/config/calibration") and user.role != "admin":
        raise HTTPException(403, "Only the admin can change recognition settings")
    if path.startswith("/api/students/"):
        roll = request.path_params.get("roll_no")
        student = visible_students(db).filter(Student.roll_no == roll).first()
        if not student:
            raise HTTPException(404, "Student not found")
        if request.method != "GET" and (user.role != "student" or user.student_id != student.id):
            raise HTTPException(403, "Only the student can give consent or submit their photos")
    if path.startswith("/api/sessions"):
        if request.method != "GET" and user.role not in ("admin", "teacher"):
            raise HTTPException(403, "Only assigned teachers can take attendance")
        session_id = request.path_params.get("session_id")
        if session_id:
            require_session(db, session_id, write=request.method != "GET" and not path.endswith("/confirm"))
    if path.startswith("/api/biometrics"):
        if user.role != "admin" and not managed_classes(db, user):
            raise HTTPException(403, "Biometric administration is restricted to class teachers and admin")
        student_id = request.path_params.get("student_id")
        pending_id = request.path_params.get("pending_id")
        if pending_id:
            pending = db.get(PendingBiometric, pending_id)
            if not pending:
                raise HTTPException(404, "Pending update not found")
            student_id = pending.student_id
        if student_id:
            student = db.get(Student, student_id)
            if not student:
                raise HTTPException(404, "Student not found")
            require_manager(db, student.class_id)


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)
    portal: str


@router.post("/login")
def login(data: LoginInput, request: Request, response: Response, db: DBSession = Depends(get_db)):
    user = db.query(User).filter(User.username == data.username.strip().lower()).first()
    # A dummy hash makes unknown usernames follow the same expensive verification path.
    stored = user.password_hash if user else DUMMY_HASH
    valid = verify_password(data.password, stored)
    if not user or not valid or user.role != data.portal:
        raise HTTPException(401, "The username or password is incorrect for this portal")
    token = secrets.token_urlsafe(48)
    db.query(LoginSession).filter(LoginSession.expires_at <= datetime.utcnow()).delete()
    db.add(LoginSession(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(),
                        expires_at=datetime.utcnow() + timedelta(hours=12)))
    db.commit()
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=43200,
                        secure=request.url.scheme == "https")
    response.headers["Cache-Control"] = "no-store"
    return user_data(db, user)


@router.get("/me")
def me(db: DBSession = Depends(get_db)):
    return user_data(db, db.info["user"])


@router.post("/logout")
def logout(request: Request, response: Response, db: DBSession = Depends(get_db)):
    token = request.cookies.get(COOKIE, "")
    db.query(LoginSession).filter(LoginSession.token_hash == hashlib.sha256(token.encode()).hexdigest()).delete()
    db.commit()
    response.delete_cookie(COOKIE)
    return {"message": "Signed out"}


class PasswordInput(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=200)


@router.post("/password")
def change_password(data: PasswordInput, response: Response, db: DBSession = Depends(get_db)):
    user = db.info["user"]
    if not verify_password(data.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_password(data.new_password)
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.commit()
    response.delete_cookie(COOKIE)
    return {"message": "Password updated. Please sign in again."}


DUMMY_HASH = hash_password(secrets.token_urlsafe(24))
