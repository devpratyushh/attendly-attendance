"""Isolated regression checks: backend/venv/bin/python backend/test_offboarding.py."""
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

TEMP = tempfile.TemporaryDirectory(prefix="attendly-offboarding-")
os.environ['ATTENDLY_DATA_DIR'] = TEMP.name

from models import (init_db, SessionLocal, Student, User, Classroom, SubjectAssignment,
                    Session, AttendanceRecord, LoginSession, EnrolledPhoto,
                    FaceEmbedding, PendingBiometric, BiometricLog, engine)
from administration import remove_user
from auth import visible_students
from session_evidence import session_roster
from fastapi import HTTPException
import settings


class OffboardingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Simulate a database created before archived_at existed.
        with sqlite3.connect(settings.DB_PATH) as connection:
            connection.execute('CREATE TABLE students (id INTEGER PRIMARY KEY, roll_no VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(100) NOT NULL, email VARCHAR(100), consent_given BOOLEAN, class_id INTEGER, created_at DATETIME)')
            connection.execute("INSERT INTO students (id,roll_no,name,consent_given) VALUES (99,'LEGACY','Legacy student',1)")
        init_db()
        init_db()  # Startup migrations must be repeatable.

    @classmethod
    def tearDownClass(cls):
        engine.dispose()
        TEMP.cleanup()

    def test_migration_preserves_existing_students(self):
        with SessionLocal() as db:
            student = db.get(Student, 99)
            self.assertEqual(student.name, 'Legacy student')
            self.assertIsNone(student.archived_at)

    def test_offboarding_preserves_history_and_removes_access(self):
        with SessionLocal() as db:
            admin = User(username='admin', name='Admin', role='admin', password_hash='unused')
            classroom = Classroom(name='Class A')
            student = Student(name='Graduate', roll_no='GRAD', consent_given=True)
            db.add_all([admin, classroom, student])
            db.flush()
            student.class_id = classroom.id
            user = User(username='graduate', name=student.name, role='student', password_hash='unused', student_id=student.id)
            assignment = SubjectAssignment(class_id=classroom.id, teacher_id=admin.id, subject_name='Math', subject_code='M1')
            db.add_all([user, assignment]); db.flush()
            session = Session(session_id='HISTORY', date=datetime.now(), status='confirmed', assignment_id=assignment.id)
            db.add(session); db.flush()
            record = AttendanceRecord(session_id=session.id, student_id=student.id, status='present', method='manual', manual_reason='Verified')
            db.add_all([record, LoginSession(user_id=user.id, token_hash='token', expires_at=datetime.now() + timedelta(days=1)),
                        EnrolledPhoto(student_id=student.id, photo_type='front', file_path='GRAD/front.jpg'),
                        FaceEmbedding(student_id=student.id, embedding=b'private'),
                        PendingBiometric(student_id=student.id, photo_type='front', file_path='GRAD/front.jpg')])
            db.commit()
            student_id, user_id, record_id = student.id, user.id, record.id
            for root in (settings.PHOTOS_DIR, settings.PENDING_DIR):
                folder = Path(root) / 'GRAD'; folder.mkdir(parents=True)
                (folder / 'front.jpg').write_bytes(b'private')
            db.info['user'] = types.SimpleNamespace(role='teacher', id=-1)
            with self.assertRaises(HTTPException) as forbidden:
                remove_user(user_id, db)
            self.assertEqual(forbidden.exception.status_code, 403)
            self.assertIsNone(student.archived_at)
            self.assertIsNotNone(db.get(AttendanceRecord, record_id))
            db.info['user'] = admin
            invalidated = Mock()
            with patch.dict(sys.modules, {'main': types.SimpleNamespace(invalidate_embeddings_cache=invalidated)}):
                remove_user(user_id, db)
            db.expire_all()
            self.assertIsNone(db.get(User, user_id))
            self.assertEqual(db.query(LoginSession).filter_by(user_id=user_id).count(), 0)
            archived = db.get(Student, student_id)
            self.assertIsNotNone(archived.archived_at)
            self.assertFalse(archived.consent_given)
            self.assertEqual((archived.name, archived.roll_no), ('Graduate', 'GRAD'))
            saved = db.get(AttendanceRecord, record_id)
            self.assertEqual((saved.status, saved.method, saved.manual_reason), ('present', 'manual', 'Verified'))
            self.assertEqual(session.records[0].student.name, 'Graduate')
            self.assertEqual(visible_students(db).filter_by(id=student_id).one().id, student_id)
            self.assertEqual(session_roster(db, session), [])
            for model in (EnrolledPhoto, FaceEmbedding, PendingBiometric):
                self.assertEqual(db.query(model).filter_by(student_id=student_id).count(), 0)
            self.assertEqual(db.query(BiometricLog).filter_by(student_id=student_id, action='archive').count(), 1)
            for root in (settings.PHOTOS_DIR, settings.PENDING_DIR):
                self.assertFalse((Path(root) / 'GRAD').exists())
            invalidated.assert_called_once()
            with self.assertRaises(HTTPException) as caught:
                remove_user(user_id, db)
            self.assertEqual(caught.exception.status_code, 404)


if __name__ == '__main__':
    unittest.main(verbosity=2)
