"""
SQLAlchemy models for the attendance app.
Single-class design: one subject, one teacher, all local.
"""
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, Text, DateTime, Boolean,
    ForeignKey, LargeBinary, inspect, text
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from datetime import datetime, timezone
import os
from settings import DB_PATH, DATA_DIR

def utc_now():
    return datetime.now(timezone.utc)

# Ensure data directory exists
os.makedirs(DATA_DIR, exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Student(Base):
    __tablename__ = "students"

    id = Column(Integer, primary_key=True, index=True)
    roll_no = Column(String(20), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    email = Column(String(100), default="")
    consent_given = Column(Boolean, default=False)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=utc_now)

    photos = relationship("EnrolledPhoto", back_populates="student", cascade="all, delete-orphan")
    embeddings = relationship("FaceEmbedding", back_populates="student", cascade="all, delete-orphan")
    attendance_records = relationship("AttendanceRecord", back_populates="student", cascade="all, delete-orphan")
    pending_updates = relationship("PendingBiometric", back_populates="student", cascade="all, delete-orphan")


class EnrolledPhoto(Base):
    """Stores metadata for enrolled biometric photos."""
    __tablename__ = "enrolled_photos"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    photo_type = Column(String(20), nullable=False)  # front, left, right
    file_path = Column(String(500), nullable=False)   # relative to PHOTOS_DIR
    uploaded_at = Column(DateTime, default=utc_now)
    uploaded_by = Column(String(50), default="system")  # system, teacher, student

    student = relationship("Student", back_populates="photos")


class FaceEmbedding(Base):
    """Stores face embeddings computed from enrolled photos."""
    __tablename__ = "face_embeddings"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    photo_id = Column(Integer, ForeignKey("enrolled_photos.id"), nullable=True)
    embedding = Column(LargeBinary, nullable=False)  # numpy array stored as bytes
    computed_at = Column(DateTime, default=utc_now)

    student = relationship("Student", back_populates="embeddings")


class Session(Base):
    """Attendance session: one per class taken."""
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String(50), unique=True, nullable=False, index=True)  # e.g. SES-20261004-1
    date = Column(DateTime, nullable=False)
    periods = Column(Integer, default=1)
    status = Column(String(20), default="active")  # active, confirmed
    created_at = Column(DateTime, default=utc_now)
    confirmed_at = Column(DateTime, nullable=True)
    assignment_id = Column(Integer, ForeignKey("subject_assignments.id"), nullable=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    recognition_policy_json = Column(Text, nullable=True)
    client_request_id = Column(String(64), nullable=True)
    capture_mode = Column(String(20), default="single")
    confirmation_digest = Column(String(64), nullable=True)
    images_deleted_at = Column(DateTime, nullable=True)

    class_photos = relationship("ClassPhoto", back_populates="session", cascade="all, delete-orphan")
    records = relationship("AttendanceRecord", back_populates="session", cascade="all, delete-orphan")


class ClassPhoto(Base):
    """Photos uploaded for a session (class photos)."""
    __tablename__ = "class_photos"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    file_path = Column(String(500), nullable=False)
    annotated_path = Column(String(500), nullable=True)  # labeled-box version
    uploaded_at = Column(DateTime, default=utc_now)

    analysis_json = Column(Text, nullable=True)
    content_hash = Column(String(64), nullable=True)
    client_photo_id = Column(String(100), nullable=True)

    session = relationship("Session", back_populates="class_photos")


class AttendanceRecord(Base):
    """Per-student attendance result for a session."""
    __tablename__ = "attendance_records"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    status = Column(String(20), nullable=False)  # present, absent, uncertain
    method = Column(String(20), default="auto")  # auto, manual
    confidence = Column(Float, nullable=True)
    matched_crop_path = Column(String(500), nullable=True)
    class_photo_id = Column(Integer, ForeignKey("class_photos.id"), nullable=True)
    manual_reason = Column(String(200), nullable=True)  # not_in_frame, late, other
    decision_detail = Column(Text, nullable=True)
    created_at = Column(DateTime, default=utc_now)

    session = relationship("Session", back_populates="records")
    student = relationship("Student", back_populates="attendance_records")


class PendingBiometric(Base):
    """Student-submitted biometric update requests."""
    __tablename__ = "pending_biometrics"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    photo_type = Column(String(20), nullable=False)
    file_path = Column(String(500), nullable=False)
    status = Column(String(20), default="pending")  # pending, approved, rejected
    submitted_at = Column(DateTime, default=utc_now)
    reviewed_at = Column(DateTime, nullable=True)
    reviewed_by = Column(String(50), nullable=True)
    validation_json = Column(Text, nullable=True)
    review_note = Column(Text, nullable=True)

    student = relationship("Student", back_populates="pending_updates")


class BiometricLog(Base):
    """Audit trail for every biometric change."""
    __tablename__ = "biometric_logs"

    id = Column(Integer, primary_key=True, index=True)
    student_id = Column(Integer, ForeignKey("students.id"), nullable=False)
    action = Column(String(50), nullable=False)  # add, replace, delete, approve, reject
    detail = Column(Text, nullable=True)
    performed_by = Column(String(50), nullable=False)  # teacher, student, system
    performed_at = Column(DateTime, default=utc_now)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(80), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    password_hash = Column(String(300), nullable=False)
    role = Column(String(20), nullable=False)
    student_id = Column(Integer, ForeignKey("students.id"), unique=True, nullable=True)
    created_at = Column(DateTime, default=utc_now)


class LoginSession(Base):
    __tablename__ = "login_sessions"
    id = Column(Integer, primary_key=True)
    token_hash = Column(String(64), unique=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    expires_at = Column(DateTime, nullable=False)


class Classroom(Base):
    __tablename__ = "classrooms"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), unique=True, nullable=False)
    class_teacher_id = Column(Integer, ForeignKey("users.id"), nullable=True)


class SubjectAssignment(Base):
    __tablename__ = "subject_assignments"
    id = Column(Integer, primary_key=True)
    class_id = Column(Integer, ForeignKey("classrooms.id"), nullable=False)
    subject_name = Column(String(100), nullable=False)
    subject_code = Column(String(30), nullable=False)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False)


def init_db():
    """Create all tables."""
    Base.metadata.create_all(bind=engine)
    # Add the new scope columns without discarding an existing database.
    additions = {
        "students": {"class_id": "INTEGER REFERENCES classrooms(id)"},
        "sessions": {
            "assignment_id": "INTEGER REFERENCES subject_assignments(id)",
            "created_by": "INTEGER REFERENCES users(id)",
            "recognition_policy_json": "TEXT",
            "client_request_id": "VARCHAR(64)", "capture_mode": "VARCHAR(20) DEFAULT 'single'",
            "confirmation_digest": "VARCHAR(64)", "images_deleted_at": "DATETIME",
        },
        "class_photos": {"analysis_json": "TEXT", "content_hash": "VARCHAR(64)", "client_photo_id": "VARCHAR(100)"},
        "attendance_records": {"decision_detail": "TEXT"},
        "pending_biometrics": {"validation_json": "TEXT", "review_note": "TEXT"},
    }
    with engine.begin() as connection:
        for table, columns in additions.items():
            existing = {column["name"] for column in inspect(connection).get_columns(table)}
            for column, definition in columns.items():
                if column not in existing:
                    connection.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {definition}'))
        connection.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_session_request ON sessions(created_by, client_request_id)'))
        connection.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_photo_request ON class_photos(session_id, client_photo_id)'))
        connection.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_student_session ON attendance_records(session_id, student_id)'))


def get_db():
    """Dependency for FastAPI routes."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
