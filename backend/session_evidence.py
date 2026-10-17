"""Persisted server-side evidence shared by uploads, review, and confirmation."""
import json
from fastapi import HTTPException
from models import ClassPhoto, Student, EnrolledPhoto, SubjectAssignment
from recognition import aggregate_evidence
import settings


def session_policy(session):
    policy = json.loads(session.recognition_policy_json) if session.recognition_policy_json else settings.recognition_policy()
    if session.status == 'active':
        current = settings.recognition_policy()
        # Preserve the session's score/quality thresholds, but upgrade the faulty
        # aggregation/detection implementation and single-shot support rule.
        for key in ('algorithm_version', 'detector_strategy', 'cross_identity_threshold', 'evidence_dominance_margin', 'min_supporting_photos'):
            policy[key] = current[key]
    return policy


def session_roster(db, session):
    assignment = db.get(SubjectAssignment, session.assignment_id)
    if not assignment:
        raise HTTPException(409, "This session has no valid subject assignment")
    return db.query(Student).filter(Student.class_id == assignment.class_id).order_by(Student.roll_no).all()


def review_analysis(db, session):
    ensure_photo_analysis(db, session)
    roster = session_roster(db, session)
    photos = db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id).order_by(ClassPhoto.id).all()
    evidence = []
    for photo in photos:
        if photo.analysis_json:
            analysis = json.loads(photo.analysis_json)
            evidence.append(dict(analysis, id=photo.id, content_hash=photo.content_hash))
    policy = session_policy(session)
    result = aggregate_evidence(evidence, [s.id for s in roster], policy)
    front = {p.student_id: p.file_path for p in db.query(EnrolledPhoto).filter(
        EnrolledPhoto.student_id.in_([s.id for s in roster]), EnrolledPhoto.photo_type == "front")}
    profiles = {s.id: s for s in roster}
    for row in result["results"]:
        student = profiles[row["student_id"]]
        row.update(name=student.name, roll_no=student.roll_no,
                   enrolled_photo_url=f"/static/photos/{front[student.id]}" if student.id in front else None,
                   crop_url=f"/static/sessions/{row['crop_path']}" if row.get("crop_path") else None)
        if not student.consent_given:
            row.update(status="unresolved", reasons=["biometric_consent_required"])
        elif not student.embeddings:
            row.update(status="unresolved", reasons=["enrollment_required"])
    result["unresolved_count"] = sum(r["status"] != "matched" for r in result["results"])
    result["unprocessed_photo_count"] = len(photos) - len(evidence)
    result["policy"] = policy
    result["retake_recommended"] = any(row['status'] != 'matched' and
        profiles[row['student_id']].consent_given and profiles[row['student_id']].embeddings
        for row in result['results'])
    result["quality_rejections"] = [{"class_photo_id": p["id"], "face_index": f["face_index"],
                                      "reasons": f["reasons"]} for p in evidence for f in p["results"] if f["status"] == "quality_rejected"]
    result["unknown_face_count"] = sum(f["status"] == "not_found" for p in evidence for f in p["results"])
    # Geometry and labels only: embeddings remain private on the server. This
    # metadata is cached encrypted with offline review and overlays local blobs.
    result['photos'] = []
    attendance_by_student = {row['student_id']: row for row in result['results']}
    for photo in photos:
        data = json.loads(photo.analysis_json or '{}')
        detections = []
        for face in data.get('results', []):
            student = profiles.get(face.get('student_id'))
            detections.append({key: face.get(key) for key in ('bbox', 'status', 'confidence', 'student_id', 'reasons')})
            attendance = attendance_by_student.get(face.get('student_id'))
            if face.get('status') == 'matched' and attendance and attendance['status'] != 'matched':
                detections[-1].update(status='uncertain', reasons=attendance['reasons'])
            detections[-1]['label'] = student.name if student else 'Unclear face' if face.get('status') == 'quality_rejected' else 'Unknown'
        result['photos'].append({'id': photo.id, 'client_photo_id': photo.client_photo_id,
                                'content_hash': photo.content_hash, 'width': data.get('image_width'),
                                'height': data.get('image_height'), 'detections': detections,
                                'url': f'/static/sessions/{photo.file_path}',
                                'annotated_url': f'/static/sessions/{photo.annotated_path}' if photo.annotated_path else None})
    return result


def ensure_photo_analysis(db, session):
    """Upgrade active photos from the older API without discarding a teacher's capture."""
    import hashlib
    import os
    import uuid
    import cv2
    import numpy as np
    from models import FaceEmbedding
    from settings import SESSIONS_DIR
    from face_engine import detect_faces, save_face_crop, annotate_class_photo
    from image_quality import image_fingerprint
    from recognition import match_faces, policy_digest
    if session.status != 'active':
        return
    policy = session_policy(session)
    pending = [p for p in db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id).all()
               if not p.analysis_json or json.loads(p.analysis_json).get('algorithm_version') != policy['algorithm_version']]
    if not pending:
        return
    session.recognition_policy_json = json.dumps(policy)
    roster = {s.id: s for s in session_roster(db, session) if s.consent_given}
    gallery = {}
    for row in db.query(FaceEmbedding).filter(FaceEmbedding.student_id.in_(roster)):
        gallery.setdefault(row.student_id, []).append(np.frombuffer(row.embedding, dtype=np.float32))
    for photo in pending:
        path = os.path.join(SESSIONS_DIR, photo.file_path)
        image = cv2.imread(path)
        if image is None:
            continue
        faces, error = detect_faces(path, policy=policy)
        if faces is None:
            continue
        results = match_faces(faces, gallery, policy)
        annotations = []
        for face, result in zip(faces, results):
            crop = os.path.join(session.session_id, f'crop_{uuid.uuid4().hex[:12]}.jpg')
            valid = save_face_crop(path, face['bbox'], os.path.join(SESSIONS_DIR, crop))
            result.update(embedding=np.asarray(face['embedding']).tolist(), crop_path=crop if valid else None,
                          bbox=face['bbox'], det_score=face['det_score'])
            student = roster.get(result['student_id'])
            annotations.append(dict(result, label=student.name if student else 'Needs review'))
        annotated = os.path.join(session.session_id, 'annotated_' + os.path.basename(path))
        annotate_class_photo(path, annotations, os.path.join(SESSIONS_DIR, annotated))
        photo.annotated_path = annotated
        if not photo.content_hash:
            photo.content_hash = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        photo.analysis_json = json.dumps({'results': results, 'fingerprint': image_fingerprint(image),
                                         'image_width': image.shape[1], 'image_height': image.shape[0],
                                         'algorithm_version': policy['algorithm_version'],
                                         'policy_digest': policy_digest(policy)}, allow_nan=False)
    db.commit()
