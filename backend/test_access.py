"""Real HTTP regression tests against an isolated, temporary school database.

Run: backend/venv/bin/python backend/test_access.py
"""
import os
import json
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
import requests


class SchoolAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='attendly-test-')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.url = f'http://127.0.0.1:{port}'
        cls.root = Path(__file__).resolve().parent
        cls.log = open(Path(cls.temp.name) / 'server.log', 'w+')
        env = dict(os.environ, ATTENDLY_DATA_DIR=cls.temp.name, ATTENDLY_PRELOAD_MODEL='0',
                   ADMIN_USERNAME='testadmin', ADMIN_PASSWORD='TestAdmin123!', PYTHONDONTWRITEBYTECODE='1')
        cls.server = subprocess.Popen([str(cls.root / 'venv/bin/python'), '-m', 'uvicorn',
                                       'main:app', '--host', '127.0.0.1', '--port', str(port)],
                                      cwd=cls.root, env=env, stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            if cls.server.poll() is not None:
                cls.log.seek(0)
                raise RuntimeError(cls.log.read())
            try:
                if requests.get(cls.url + '/api/config', timeout=.5).status_code == 401:
                    break
            except requests.RequestException:
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('Test server did not start')
        cls.admin = cls.login('testadmin', 'TestAdmin123!', 'admin')
        cls.lead = cls.create_account('lead', 'Class Teacher', 'teacher')
        cls.regular = cls.create_account('regular', 'Subject Teacher', 'teacher')
        cls.outsider = cls.create_account('outsider', 'Other Teacher', 'teacher')
        cls.class_a = cls.req(cls.admin, 'post', '/api/admin/classes', json={'name': 'Class A', 'class_teacher_id': cls.lead['id']}, expected=201)['id']
        cls.class_b = cls.req(cls.admin, 'post', '/api/admin/classes', json={'name': 'Class B'}, expected=201)['id']
        cls.student_a = cls.create_account('student.a', 'Student A', 'student', cls.class_a, 'S001')
        cls.student_b = cls.create_account('student.b', 'Student B', 'student', cls.class_b, 'S002')
        cls.lead_client = cls.login('lead', 'SchoolPass123!', 'teacher')
        cls.teacher = cls.login('regular', 'SchoolPass123!', 'teacher')
        cls.other = cls.login('outsider', 'SchoolPass123!', 'teacher')
        cls.student = cls.login('student.a', 'SchoolPass123!', 'student')
        cls.assignment = cls.req(cls.lead_client, 'post', '/api/admin/assignments', json={
            'class_id': cls.class_a, 'teacher_id': cls.regular['id'], 'subject_name': 'Mathematics', 'subject_code': 'MAT101'}, expected=201)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def req(cls, client, method, path, expected=200, **kwargs):
        response = getattr(client, method)(cls.url + path, timeout=10, **kwargs)
        if response.status_code != expected:
            raise AssertionError(f'{method} {path}: {response.status_code} {response.text}')
        return response.json() if response.headers.get('content-type', '').startswith('application/json') else response.text

    @classmethod
    def login(cls, username, password, portal):
        client = requests.Session()
        cls.req(client, 'post', '/api/auth/login', json={'username': username, 'password': password, 'portal': portal})
        return client

    @classmethod
    def create_account(cls, username, name, role, class_id=None, roll_no=None):
        return cls.req(cls.admin, 'post', '/api/admin/users', expected=201, json={
            'username': username, 'name': name, 'role': role, 'password': 'SchoolPass123!', 'class_id': class_id, 'roll_no': roll_no})

    def test_01_sign_in_and_cookie_security(self):
        anonymous = requests.Session()
        self.req(anonymous, 'get', '/api/students', expected=401)
        self.req(anonymous, 'get', '/api/admin/overview', expected=401)
        for password, portal in [('wrong', 'admin'), ('TestAdmin123!', 'teacher')]:
            self.req(anonymous, 'post', '/api/auth/login', expected=401,
                     json={'username': 'testadmin', 'password': password, 'portal': portal})
        response = anonymous.post(self.url + '/api/auth/login', json={
            'username': 'testadmin', 'password': 'TestAdmin123!', 'portal': 'admin'})
        self.assertIn('HttpOnly', response.headers['Set-Cookie'])
        self.assertIn('SameSite=strict', response.headers['Set-Cookie'])
        self.req(anonymous, 'post', '/api/auth/logout')
        self.req(anonymous, 'get', '/api/auth/me', expected=401)
        self.req(self.admin, 'post', '/api/admin/classes', expected=403,
                 headers={'Origin': 'https://other.example'}, json={'name': 'Cross-site'})

    def test_02_class_teacher_scope(self):
        overview = self.req(self.lead_client, 'get', '/api/admin/overview')
        self.assertEqual([c['id'] for c in overview['classes']], [self.class_a])
        self.assertEqual([u['username'] for u in overview['users']], ['student.a'])
        self.req(self.lead_client, 'post', '/api/admin/users', expected=403, json={
            'username': 'forbidden', 'name': 'No', 'password': 'Password123!', 'role': 'teacher'})
        self.req(self.lead_client, 'post', '/api/admin/users', expected=403, json={
            'username': 'forbidden', 'name': 'No', 'password': 'Password123!', 'role': 'student', 'roll_no': 'NO', 'class_id': self.class_b})
        self.req(self.lead_client, 'post', '/api/admin/assignments', expected=403, json={
            'class_id': self.class_b, 'teacher_id': self.regular['id'], 'subject_name': 'No', 'subject_code': 'NO'})
        self.req(self.lead_client, 'post', '/api/config/thresholds', expected=403,
                 data={'match_threshold': .5, 'uncertain_threshold': .3})
        self.req(self.lead_client, 'delete', f"/api/admin/users/{self.student_b['id']}", expected=403)
        self.req(self.lead_client, 'post', '/api/admin/classes', expected=403, json={'name': 'No'})
        created = self.req(self.lead_client, 'post', '/api/admin/users', expected=201, json={
            'username': 'managed', 'name': 'Managed Student', 'password': 'Password123!', 'role': 'student', 'class_id': self.class_a, 'roll_no': 'S003'})
        signed_in = self.login('managed', 'Password123!', 'student')
        self.req(self.lead_client, 'delete', f"/api/admin/users/{created['id']}")
        self.req(signed_in, 'get', '/api/auth/me', expected=401)

    def test_03_regular_teacher_is_not_administrator(self):
        for path in ['/api/admin/overview', '/api/biometrics/pending', '/api/biometrics/logs']:
            self.req(self.teacher, 'get', path, expected=403)
        self.req(self.teacher, 'post', '/api/config/thresholds', expected=403,
                 data={'match_threshold': .5, 'uncertain_threshold': .3})
        self.req(self.teacher, 'post', '/api/admin/classes', expected=403, json={'name': 'No'})
        self.assertEqual([s['roll_no'] for s in self.req(self.teacher, 'get', '/api/students')], ['S001'])
        self.assertEqual(self.req(self.other, 'get', '/api/assignments'), [])
        self.req(self.other, 'post', '/api/sessions/create', expected=403,
                 data={'periods': 1, 'assignment_id': self.assignment['id']})
        self.req(self.lead_client, 'post', '/api/sessions/create', expected=403,
                 data={'periods': 1, 'assignment_id': self.assignment['id']})

    def test_04_student_privacy(self):
        self.assertEqual([s['roll_no'] for s in self.req(self.student, 'get', '/api/students')], ['S001'])
        self.req(self.student, 'get', '/api/students/S002', expected=404)
        self.req(self.student, 'get', '/api/students/S002/attendance', expected=404)
        self.req(self.student, 'get', '/api/admin/overview', expected=403)
        self.req(self.student, 'post', '/api/sessions/create', expected=403, data={'assignment_id': self.assignment['id']})
        self.req(self.student, 'post', '/api/students/S001/consent')
        self.req(self.admin, 'post', '/api/students/S001/consent', expected=403)
        self.req(self.teacher, 'post', '/api/students/S001/consent', expected=403)

    def test_04b_enrollment_guide_is_private_and_ephemeral(self):
        import io
        from PIL import Image
        path = '/api/students/S001/biometric/guide'
        files = {'photo': ('preview.jpg', b'invalid', 'image/jpeg')}
        self.req(requests.Session(), 'post', path, files=files, expected=401)
        self.req(self.teacher, 'post', path, files=files, expected=403)
        self.req(self.student, 'post', '/api/students/S002/biometric/guide', files=files, expected=404)
        self.req(self.student, 'post', path, files=files, expected=400)
        self.req(self.student, 'post', path, files={'photo': ('preview.jpg', b'x' * (512 * 1024 + 1), 'image/jpeg')}, expected=413)
        oversized = io.BytesIO()
        Image.new('RGB', (641, 100)).save(oversized, format='JPEG')
        self.req(self.student, 'post', path, files={'photo': ('preview.jpg', oversized.getvalue(), 'image/jpeg')}, expected=400)
        before = {p.relative_to(self.temp.name) for p in Path(self.temp.name).rglob('*')}
        blank = io.BytesIO()
        Image.new('RGB', (320, 240)).save(blank, format='JPEG')
        response = self.req(self.student, 'post', path, files={'photo': ('preview.jpg', blank.getvalue(), 'image/jpeg')})
        self.assertEqual(response, {'face_count': 0, 'bbox': None})
        self.assertEqual(before, {p.relative_to(self.temp.name) for p in Path(self.temp.name).rglob('*')})

    def test_05_subject_attendance_end_to_end(self):
        self.req(self.teacher, 'post', '/api/sessions/create', expected=400, data={'assignment_id': self.assignment['id'], 'periods': -1})
        for invalid in (0, 5, 8):
            self.req(self.teacher, 'post', '/api/sessions/create', expected=400, data={'assignment_id': self.assignment['id'], 'periods': invalid})
        session = self.req(self.teacher, 'post', '/api/sessions/create', data={'assignment_id': self.assignment['id'], 'periods': 1})
        sid = session['session_id']
        self.req(self.other, 'get', f'/api/sessions/{sid}', expected=404)
        self.req(self.student, 'get', f'/api/sessions/{sid}', expected=404)
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=400, data={'records': 'invalid'})
        import json
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=400, data={'records': json.dumps([
            {'student_id': self.student_b['student_id'], 'status': 'present'}])})
        decisions = json.dumps([{'student_id': self.student_a['student_id'], 'status': 'present', 'method': 'manual', 'manual_reason': 'late'}])
        for invalid in (0, 5, 8):
            self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=400, data={'records': decisions, 'periods': invalid})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', data={'records': decisions, 'periods': 2})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', data={'records': decisions, 'periods': 2})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=409, data={'records': decisions, 'periods': 3})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=409, data={'records': '[]'})
        attendance = self.req(self.student, 'get', '/api/students/S001/attendance')
        self.assertEqual((attendance['total_periods'], attendance['attended_periods'], attendance['percentage']), (2, 2, 100))
        saved = next(item for item in attendance['sessions'] if item['session_id'] == sid)
        self.assertEqual(saved['subject_name'], 'Mathematics')
        self.assertEqual(saved['periods'], 2)
        self.assertIsNone(attendance['sessions'][0]['class_photo_url'])
        self.assertEqual(attendance['sessions'][0]['class_photos'], [])
        self.assertTrue(attendance['sessions'][0]['date'].endswith('+00:00'))
        photo_path = Path(self.temp.name) / 'sessions' / sid / 'class_test.jpg'
        photo_path.parent.mkdir(parents=True, exist_ok=True)
        photo_path.write_bytes(b'class-photo-fixture')
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as connection:
            faces = [{'student_id': self.student_a['student_id'], 'bbox': [10, 20, 60, 80], 'status': 'matched', 'confidence': .9, 'embedding': [1, 0]},
                     {'student_id': self.student_b['student_id'], 'bbox': [100, 20, 150, 80], 'status': 'matched', 'confidence': .8, 'embedding': [0, 1]}]
            connection.execute('INSERT INTO class_photos (session_id, file_path, analysis_json) VALUES (?, ?, ?)',
                               (session['id'], f'{sid}/class_test.jpg', json.dumps({'image_width': 200, 'image_height': 100, 'results': faces})))
        updated = self.req(self.student, 'get', '/api/students/S001/attendance')
        photo_url = updated['sessions'][0]['class_photos'][0]['url']
        photo = updated['sessions'][0]['class_photos'][0]
        self.assertEqual((photo['width'], photo['height']), (200, 100))
        self.assertEqual(photo['detections'], [{'bbox': [10, 20, 60, 80], 'label': 'Student A', 'status': 'matched', 'confidence': .9}])
        self.assertNotIn('embedding', json.dumps(photo))
        # A manual decision may retain a suggested face rather than an automatic match.
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as connection:
            faces[0].update(student_id=None, crop_path=f'{sid}/crop_own.jpg', status='uncertain')
            connection.execute('UPDATE class_photos SET analysis_json = ? WHERE session_id = ?',
                               (json.dumps({'image_width': 200, 'image_height': 100, 'results': faces}), session['id']))
            connection.execute('UPDATE attendance_records SET class_photo_id = (SELECT id FROM class_photos WHERE session_id = ?), matched_crop_path = ? WHERE session_id = ? AND student_id = ?',
                               (session['id'], f'{sid}/crop_own.jpg', session['id'], self.student_a['student_id']))
        manual = self.req(self.student, 'get', '/api/students/S001/attendance')['sessions'][0]['class_photos'][0]
        self.assertEqual(len(manual['detections']), 1)
        self.assertEqual(manual['detections'][0]['bbox'], [10, 20, 60, 80])
        self.assertEqual(manual['detections'][0]['status'], 'uncertain')

        self.assertEqual(self.student.get(self.url + photo_url).status_code, 200)
        other_student = self.login('student.b', 'SchoolPass123!', 'student')
        self.assertEqual(other_student.get(self.url + photo_url).status_code, 404)
        photo_path.with_name('crop_other.jpg').write_bytes(b'other-face-fixture')
        self.assertEqual(self.student.get(self.url + f'/static/sessions/{sid}/crop_other.jpg').status_code, 403)

        other_attendance = self.req(self.admin, 'get', '/api/students/S002/attendance')
        self.assertEqual(other_attendance['total_sessions'], 0)
        detail = self.req(self.student, 'get', f'/api/sessions/{sid}')
        self.assertEqual(len(detail['students']), 1)
        self.assertEqual(detail['photos'], [])
        csv = self.req(self.teacher, 'get', f'/api/sessions/{sid}/export')
        self.assertIn('Mathematics', csv)
        self.assertIn('Student A', csv)
        self.assertNotIn('Student B', csv)
        self.req(self.lead_client, 'delete', f"/api/admin/assignments/{self.assignment['id']}", expected=409)

    def test_05b_four_period_limit_and_legacy_drafts(self):
        boundary = self.req(self.teacher, 'post', '/api/sessions/create', data={'assignment_id': self.assignment['id'], 'periods': 4})
        self.assertEqual(boundary['periods'], 4)
        decisions = json.dumps([{'student_id': self.student_a['student_id'], 'status': 'present', 'method': 'manual', 'manual_reason': 'Teacher checked'}])
        self.req(self.teacher, 'post', f'/api/sessions/{boundary["session_id"]}/confirm', data={'records': decisions, 'periods': 4})
        legacy = self.req(self.teacher, 'post', '/api/sessions/create', data={'assignment_id': self.assignment['id'], 'periods': 1})
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as connection:
            connection.execute('UPDATE sessions SET periods = 8 WHERE id = ?', (legacy['id'],))
        self.req(self.teacher, 'post', f'/api/sessions/{legacy["session_id"]}/confirm', expected=400, data={'records': decisions})
        self.assertEqual(self.req(self.teacher, 'get', f'/api/sessions/{legacy["session_id"]}')['status'], 'active')
        self.req(self.teacher, 'post', f'/api/sessions/{legacy["session_id"]}/confirm', data={'records': decisions, 'periods': 4})

    def test_06_account_reset_invalidates_sessions(self):
        self.req(self.admin, 'post', f"/api/admin/users/{self.outsider['id']}/password", json={'password': 'NewPassword123!'})
        self.req(self.other, 'get', '/api/auth/me', expected=401)
        signed_in = self.login('outsider', 'NewPassword123!', 'teacher')
        self.req(signed_in, 'post', '/api/auth/password', expected=400, json={'current_password': 'wrong', 'new_password': 'ChangedPassword123!'})
        self.req(signed_in, 'post', '/api/auth/password', json={'current_password': 'NewPassword123!', 'new_password': 'ChangedPassword123!'})
        self.req(signed_in, 'get', '/api/auth/me', expected=401)

    def test_07_validation_and_password_storage(self):
        self.req(self.admin, 'post', '/api/admin/users', expected=409, json={
            'username': 'regular', 'name': 'Duplicate', 'role': 'teacher', 'password': 'Password123!'})
        self.req(self.admin, 'post', '/api/admin/users', expected=422, json={
            'username': 'bad/path', 'name': 'Unsafe', 'role': 'student', 'roll_no': '../escape', 'password': 'Password123!', 'class_id': self.class_a})
        self.req(self.admin, 'post', '/api/config/thresholds', expected=400,
                 data={'match_threshold': .3, 'uncertain_threshold': .5})
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            hashes = [row[0] for row in db.execute('select password_hash from users')]
            self.assertTrue(all(value.startswith('pbkdf2_sha256$') for value in hashes))
            self.assertNotIn('SchoolPass123!', hashes)

    def test_08_private_images_and_biometric_scope(self):
        # The class teacher also teaches another class, but cannot administer it.
        assignment = self.req(self.admin, 'post', '/api/admin/assignments', expected=201, json={
            'class_id': self.class_b, 'teacher_id': self.lead['id'], 'subject_name': 'Science', 'subject_code': 'SCI101'})
        image_path = Path(self.temp.name) / 'photos' / 'S002' / 'front.jpg'
        image_path.parent.mkdir(parents=True)
        image_path.write_bytes(b'test image content')
        pending_path = Path(self.temp.name) / 'pending_biometric' / 'S002' / 'front.jpg'
        pending_path.parent.mkdir(parents=True)
        pending_path.write_bytes(b'pending test image')
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            db.execute('insert into enrolled_photos(student_id, photo_type, file_path) values (?, ?, ?)',
                       (self.student_b['student_id'], 'front', 'S002/front.jpg'))
            pending_id = db.execute('insert into pending_biometrics(student_id, photo_type, file_path, status) values (?, ?, ?, ?)',
                                    (self.student_b['student_id'], 'front', 'S002/front.jpg', 'pending')).lastrowid
        self.req(requests.Session(), 'get', '/static/photos/S002/front.jpg', expected=401)
        self.req(self.student, 'get', '/static/photos/S002/front.jpg', expected=404)
        self.req(self.teacher, 'get', '/static/photos/S002/front.jpg', expected=404)
        self.req(self.admin, 'get', '/static/photos/S002/front.jpg')
        self.req(self.lead_client, 'get', '/static/pending/S002/front.jpg', expected=403)
        self.assertEqual(self.req(self.lead_client, 'get', '/api/biometrics/pending'), [])
        self.req(self.lead_client, 'post', f'/api/biometrics/pending/{pending_id}/reject', expected=403)
        self.req(self.admin, 'post', f'/api/biometrics/pending/{pending_id}/reject')
        self.req(self.admin, 'post', f'/api/biometrics/pending/{pending_id}/reject', expected=409)
        self.req(self.admin, 'delete', f"/api/admin/users/{self.regular['id']}", expected=409)

    def test_09_retry_ids_and_explicit_review(self):
        import uuid, json
        request_id = str(uuid.uuid4())
        body = {'assignment_id': self.assignment['id'], 'periods': 1, 'client_request_id': request_id, 'capture_mode': 'single'}
        first = self.req(self.teacher, 'post', '/api/sessions/create', data=body)
        second = self.req(self.teacher, 'post', '/api/sessions/create', data=body)
        self.assertEqual(first['session_id'], second['session_id'])
        sid = first['session_id']
        self.req(self.teacher, 'post', '/api/sessions/create', expected=409, data=dict(body, periods=2))
        analysis = self.req(self.teacher, 'get', f'/api/sessions/{sid}/analysis')
        self.assertEqual(analysis['unresolved_count'], 1)
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=409, data={'records': '[]'})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=409, data={'records': json.dumps([
            {'student_id': self.student_a['student_id'], 'status': 'absent', 'method': 'auto'}])})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=400, data={'records': json.dumps([
            {'student_id': self.student_a['student_id'], 'status': 'absent', 'method': 'manual', 'manual_reason': ''}])})
        records = [{'student_id': self.student_a['student_id'], 'status': 'absent', 'method': 'manual', 'manual_reason': 'Verified classroom absence'}]
        payload = {'records': json.dumps(records)}
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', data=payload)
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', data=payload)
        receipt = self.req(self.teacher, 'get', f'/api/sessions/{sid}')
        self.assertEqual(receipt['status'], 'confirmed')
        self.assertEqual(len(receipt['students']), 1)
        self.req(self.student, 'get', f'/api/sessions/{sid}/analysis', expected=403)
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/confirm', expected=409, data={'records': '[]'})

    def test_10_photo_upload_retry_and_retention_boundaries(self):
        import cv2, numpy as np
        session = self.req(self.teacher, 'post', '/api/sessions/create', data={'assignment_id': self.assignment['id'], 'periods': 1})
        sid = session['session_id']
        _, image = cv2.imencode('.jpg', np.zeros((100, 100, 3), np.uint8))
        files = {'photo': ('test.jpg', image.tobytes(), 'image/jpeg')}
        first = self.req(self.teacher, 'post', f'/api/sessions/{sid}/upload', files=files, data={'client_photo_id': 'test-view-0'})
        second = self.req(self.teacher, 'post', f'/api/sessions/{sid}/upload', files=files, data={'client_photo_id': 'test-view-0'})
        self.__class__.active_media_sid = sid
        self.assertEqual(first['class_photo_id'], second['class_photo_id'])
        self.assertTrue(second['already_uploaded'])
        self.assertEqual(first['session_analysis']['unresolved_count'], 1)
        preview = first['session_analysis']['photos'][0]
        self.assertEqual(preview['id'], first['class_photo_id'])
        self.assertEqual(preview['client_photo_id'], 'test-view-0')
        self.assertEqual((preview['width'], preview['height']), (100,100))
        self.assertEqual(preview['detections'], [])
        self.assertNotIn('embedding', json.dumps(preview))
        _, different = cv2.imencode('.jpg', np.full((100,100,3), 100, np.uint8))
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/upload', expected=409,
                 files={'photo': ('changed.jpg', different.tobytes(), 'image/jpeg')}, data={'client_photo_id': 'test-view-0'})
        self.req(self.teacher, 'post', f'/api/sessions/{sid}/upload', expected=400,
                 files={'photo': ('broken.jpg', b'not an image', 'image/jpeg')}, data={'client_photo_id': 'broken-view'})
        detail = self.req(self.teacher, 'get', f'/api/sessions/{sid}')
        self.assertEqual(len(detail['photos']), 1)
        self.assertEqual(detail['processed_photos'][0]['client_photo_id'], 'test-view-0')
        self.assertEqual(len(detail['processed_photos'][0]['content_hash']), 64)
        self.req(self.teacher, 'post', '/api/config/calibration', expected=403,
                 files={'report': ('invalid.json', b'{}', 'application/json')})
        self.req(self.admin, 'post', '/api/config/calibration', expected=400,
                 files={'report': ('invalid.json', b'{}', 'application/json')})

    def test_12_student_biometrics_are_pending_until_explicit_review(self):
        import cv2, numpy as np
        _, image = cv2.imencode('.jpg', np.zeros((100,100,3),np.uint8))
        files = {kind:(f'{kind}.jpg',image.tobytes(),'image/jpeg') for kind in ('front','left','right')}
        result = self.req(self.student,'post','/api/students/S001/biometric/update',files=files)
        self.assertEqual(set(result['accepted']), {'front','left','right'})
        self.assertEqual(len(result['warnings']),3)
        self.assertEqual(result['errors'],[])
        status = self.req(self.student,'get','/api/students/S001/biometric/status')
        self.assertEqual(len(status),3)
        self.assertTrue(all(p['status']=='pending' and p['reviewed_at'] is None for p in status))
        self.assertIsNone(self.req(self.student,'get','/api/auth/me')['profile_photo_url'])
        self.assertTrue(all(p['validation']['status']=='needs_retake' for p in status))
        photo = status[0]
        self.req(self.student,'post',f"/api/biometrics/pending/{photo['id']}/reject",expected=403)
        self.req(self.teacher,'post',f"/api/biometrics/pending/{photo['id']}/reject",expected=403)
        self.req(self.lead_client,'post',f"/api/biometrics/pending/{photo['id']}/approve",expected=400)
        unchanged = self.req(self.student,'get','/api/students/S001/biometric/status')
        self.assertTrue(all(p['status']=='pending' for p in unchanged))
        self.req(self.lead_client,'post',f"/api/biometrics/pending/{photo['id']}/reject",data={'reason':'Please retake with your face visible.'})
        reviewed = self.req(self.student,'get','/api/students/S001/biometric/status')
        rejected = next(p for p in reviewed if p['id']==photo['id'])
        self.assertEqual(rejected['status'],'rejected')
        self.assertEqual(rejected['review_note'],'Please retake with your face visible.')
        with sqlite3.connect(Path(self.temp.name)/'attendance.db') as db:
            self.assertEqual(db.execute('select count(*) from face_embeddings where student_id=?',(self.student_a['student_id'],)).fetchone()[0],0)
            before = db.execute('select count(*) from pending_biometrics').fetchone()[0]
        broken=dict(files,right=('right.jpg',b'broken-image','image/jpeg'))
        self.req(self.student,'post','/api/students/S001/biometric/update',expected=400,files=broken)
        with sqlite3.connect(Path(self.temp.name)/'attendance.db') as db:
            self.assertEqual(db.execute('select count(*) from pending_biometrics').fetchone()[0],before)

    def test_13_profile_uses_only_consented_enrollment_and_scoped_media(self):
        photo_dir = Path(self.temp.name) / 'photos' / 'S001'
        photo_dir.mkdir(parents=True, exist_ok=True)
        (photo_dir / 'profile.jpg').write_bytes(b'isolated profile fixture')
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            db.execute('INSERT INTO enrolled_photos (student_id, photo_type, file_path) VALUES (?, ?, ?)',
                       (self.student_a['student_id'], 'front', 'S001/profile.jpg'))
        profile = self.req(self.student, 'get', '/api/auth/me')
        self.assertEqual(profile['profile_photo_url'], '/static/photos/S001/profile.jpg')
        self.assertEqual(profile['class_name'], 'Class A')
        overview = self.req(self.lead_client, 'get', '/api/admin/overview')
        account = next(u for u in overview['users'] if u['student_id'] == self.student_a['student_id'])
        self.assertEqual(account['profile_photo_url'], profile['profile_photo_url'])
        self.assertEqual(self.student.get(self.url + profile['profile_photo_url']).status_code, 200)
        self.assertEqual(requests.get(self.url + profile['profile_photo_url']).status_code, 401)
        outsider = self.login('student.b', 'SchoolPass123!', 'student')
        self.assertEqual(outsider.get(self.url + profile['profile_photo_url']).status_code, 404)
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            db.execute('UPDATE students SET consent_given=0 WHERE id=?', (self.student_a['student_id'],))
        self.assertIsNone(self.req(self.student, 'get', '/api/auth/me')['profile_photo_url'])

    def test_11_retention_preserves_unfinished_sessions(self):
        import sys
        from datetime import datetime, timedelta
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            finalized = db.execute("select id, session_id from sessions where status='confirmed' limit 1").fetchone()
            folder = Path(self.temp.name) / 'sessions' / finalized[1]
            folder.mkdir(exist_ok=True)
            (folder / 'retention-test.jpg').write_bytes(b'isolated media fixture')
            db.execute('insert into class_photos(session_id,file_path,analysis_json) values (?,?,?)',
                       (finalized[0], finalized[1]+'/retention-test.jpg', '{"results":[]}'))
            db.execute('update sessions set confirmed_at=? where id=?', ((datetime.utcnow()-timedelta(days=2)).isoformat(), finalized[0]))
            count_before = db.execute('select count(*) from attendance_records').fetchone()[0]
        result = subprocess.run([sys.executable, '-c', 'from retention import cleanup_media; print(cleanup_media())'],
                                cwd=self.root, env=dict(os.environ, ATTENDLY_DATA_DIR=self.temp.name, PYTHONDONTWRITEBYTECODE='1'),
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(folder.exists())
        active_folder = Path(self.temp.name) / 'sessions' / self.active_media_sid
        self.assertTrue(any(active_folder.iterdir()), 'Unfinished session lost its only server images')
        with sqlite3.connect(Path(self.temp.name) / 'attendance.db') as db:
            self.assertEqual(db.execute('select count(*) from attendance_records').fetchone()[0], count_before)
            self.assertIsNotNone(db.execute('select images_deleted_at from sessions where id=?', (finalized[0],)).fetchone()[0])


if __name__ == '__main__':
    unittest.main(verbosity=2)
