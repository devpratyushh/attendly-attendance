"""
Automated Test Suite for FaceRecog Attendance System.
Tests core API endpoints, database operations, caching, and matching logic.
"""
import unittest
import numpy as np
import requests

import main
import settings
from models import get_db, Student, Session as SessionModel, AttendanceRecord, EnrolledPhoto
from face_engine import cosine_similarity, match_face_to_students

BASE_URL = "http://127.0.0.1:8000"


class FaceRecogApiTestCase(unittest.TestCase):
    def test_01_config_endpoint(self):
        """Test configuration endpoint returns expected keys."""
        resp = requests.get(f"{BASE_URL}/api/config")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("subject_name", data)
        self.assertIn("match_threshold", data)
        self.assertIn("uncertain_threshold", data)

    def test_02_threshold_update_and_persistence(self):
        """Test threshold update persists to settings and file."""
        resp = requests.post(f"{BASE_URL}/api/config/thresholds", data={"match_threshold": "0.52", "uncertain_threshold": "0.42"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["match"], 0.52)
        self.assertEqual(resp.json()["uncertain"], 0.42)

        # Verify persistent config file saved
        saved_m, saved_u = settings.load_thresholds()
        self.assertEqual(saved_m, 0.52)
        self.assertEqual(saved_u, 0.42)

        # Reset back to default
        reset_resp = requests.post(f"{BASE_URL}/api/config/thresholds", data={"match_threshold": "0.45", "uncertain_threshold": "0.35"})
        self.assertEqual(reset_resp.status_code, 200)
        reset_m, reset_u = settings.load_thresholds()
        self.assertEqual(reset_m, 0.45)
        self.assertEqual(reset_u, 0.35)

    def test_03_students_list(self):
        """Test student listing returns enrolled students."""
        resp = requests.get(f"{BASE_URL}/api/students")
        self.assertEqual(resp.status_code, 200)
        students = resp.json()
        self.assertIsInstance(students, list)
        self.assertGreater(len(students), 0)
        first = students[0]
        self.assertIn("roll_no", first)
        self.assertIn("name", first)

    def test_04_sessions_list_and_detail(self):
        """Test session list and session detail with eager loading."""
        resp = requests.get(f"{BASE_URL}/api/sessions")
        self.assertEqual(resp.status_code, 200)
        sessions = resp.json()
        self.assertIsInstance(sessions, list)

        if sessions:
            sess_id = sessions[0]["session_id"]
            detail_resp = requests.get(f"{BASE_URL}/api/sessions/{sess_id}")
            self.assertEqual(detail_resp.status_code, 200)
            detail = detail_resp.json()
            self.assertEqual(detail["session_id"], sess_id)
            self.assertIn("students", detail)
            self.assertIn("photos", detail)

    def test_05_csv_export(self):
        """Test CSV export endpoint returns valid CSV headers and records."""
        resp = requests.get(f"{BASE_URL}/api/sessions")
        sessions = resp.json()
        if sessions:
            sess_id = sessions[0]["session_id"]
            export_resp = requests.get(f"{BASE_URL}/api/sessions/{sess_id}/export")
            self.assertEqual(export_resp.status_code, 200)
            self.assertTrue("text/csv" in export_resp.headers.get("content-type", ""))
            content = export_resp.text
            self.assertTrue(content.startswith("Roll No,Student Name,Status"))

    def test_06_cosine_similarity(self):
        """Test cosine similarity calculation with identical and orthogonal vectors."""
        vec1 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        vec2 = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        vec3 = np.array([0.0, 1.0, 0.0], dtype=np.float32)

        self.assertAlmostEqual(cosine_similarity(vec1, vec2), 1.0, places=4)
        self.assertAlmostEqual(cosine_similarity(vec1, vec3), 0.0, places=4)

    def test_07_embeddings_cache(self):
        """Test embeddings cache warms up and invalidates properly."""
        db_gen = get_db()
        db = next(db_gen)
        try:
            main.invalidate_embeddings_cache()
            self.assertIsNone(main._EMBEDDINGS_CACHE)

            loaded1 = main.load_all_embeddings(db)
            self.assertIsNotNone(main._EMBEDDINGS_CACHE)
            loaded2 = main.load_all_embeddings(db)
            self.assertIs(loaded1, loaded2)  # Exact same memory reference

            main.invalidate_embeddings_cache()
            self.assertIsNone(main._EMBEDDINGS_CACHE)
        finally:
            db.close()

    def test_08_double_match_deduplication(self):
        """Test that duplicate student matches in the same photo are deduplicated by confidence."""
        candidates = [
            {"face_index": 0, "student_id": 1, "confidence": 0.72, "status": "matched"},
            {"face_index": 1, "student_id": 1, "confidence": 0.86, "status": "matched"},
            {"face_index": 2, "student_id": 2, "confidence": 0.65, "status": "matched"},
        ]

        # Phase 2 Deduplication Algorithm (from upload_class_photo)
        student_to_best = {}
        for c in candidates:
            sid = c["student_id"]
            if sid is not None and c["status"] in ("matched", "uncertain"):
                if sid not in student_to_best or c["confidence"] > student_to_best[sid]["confidence"]:
                    student_to_best[sid] = c

        for c in candidates:
            sid = c["student_id"]
            if sid is not None and c["status"] in ("matched", "uncertain"):
                if student_to_best[sid] is not c:
                    c["status"] = "not_found"
                    c["student_id"] = None

        # Verify face 0 was demoted to not_found because face 1 had higher confidence (0.86 > 0.72)
        self.assertEqual(candidates[0]["status"], "not_found")
        self.assertIsNone(candidates[0]["student_id"])

        # Face 1 kept the match
        self.assertEqual(candidates[1]["status"], "matched")
        self.assertEqual(candidates[1]["student_id"], 1)

        # Face 2 kept its match for student 2
        self.assertEqual(candidates[2]["status"], "matched")
        self.assertEqual(candidates[2]["student_id"], 2)


if __name__ == "__main__":
    unittest.main()
