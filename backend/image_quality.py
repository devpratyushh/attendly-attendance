"""Explainable image checks; these heuristics are not a trained occlusion detector."""
import hashlib
import cv2
import numpy as np


def image_fingerprint(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    block = cv2.dct(cv2.resize(gray, (32, 32)).astype(np.float32))[:8, :8].flatten()
    # Ignore DC brightness when identifying re-encoded/brightened duplicates.
    bits = block > np.median(block[1:])
    bits[0] = False
    value = sum(int(bit) << i for i, bit in enumerate(bits))
    return f"{value:016x}"


def assess_face(image, bbox, detection_score, landmarks, pose, limits):
    h, w = image.shape[:2]
    box = np.asarray(bbox, dtype=float)
    reasons = []
    if box.shape != (4,) or not np.isfinite(box).all():
        return {"accepted": False, "reasons": ["invalid_face_box"], "occlusion_assessed": False}
    x1, y1, x2, y2 = box.astype(int)
    width, height = max(0, x2 - x1), max(0, y2 - y1)
    if min(width, height) < limits["min_face_pixels"]:
        reasons.append("face_too_small")
    if x1 < 0 or y1 < 0 or x2 > w or y2 > h:
        reasons.append("face_cut_off")
    crop = image[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
    if not crop.size:
        return {"accepted": False, "reasons": ["empty_face_crop"], "occlusion_assessed": False}
    # Normalize measurement size so resolution alone does not inflate sharpness.
    gray = cv2.cvtColor(cv2.resize(crop, (112, 112)), cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    luminance = float(gray.mean())
    if sharpness < limits["min_sharpness"]:
        reasons.append("face_blurred")
    if luminance < limits["min_luminance"]:
        reasons.append("face_underexposed")
    if luminance > limits["max_luminance"]:
        reasons.append("face_overexposed")
    if not np.isfinite(detection_score) or detection_score < limits["min_detection_score"]:
        reasons.append("low_detection_score")
    eye_distance = None
    points = np.asarray(landmarks, dtype=float) if landmarks is not None else np.empty((0, 2))
    reliable = points.shape == (5, 2) and np.isfinite(points).all()
    if reliable:
        eye_distance = float(np.linalg.norm(points[0] - points[1]))
        reliable = (eye_distance >= limits["min_eye_distance"] and
                    (points[:, 0] >= x1).all() and (points[:, 0] <= x2).all() and
                    (points[:, 1] >= y1).all() and (points[:, 1] <= y2).all() and
                    points[2, 1] > min(points[0, 1], points[1, 1]) and
                    max(points[3, 1], points[4, 1]) > points[2, 1])
    if not reliable:
        reasons.append("landmarks_unreliable_or_obstructed")
    angles = np.asarray(pose, dtype=float) if pose is not None else np.empty(0)
    if angles.shape == (3,) and np.isfinite(angles).all():
        if abs(angles[0]) > limits["max_abs_pitch"] or abs(angles[1]) > limits["max_abs_yaw"]:
            reasons.append("extreme_face_angle")
    else:
        reasons.append("face_pose_unavailable")
    return {"accepted": not reasons, "reasons": reasons, "face_pixels": int(min(width, height)),
            "sharpness": round(sharpness, 2), "luminance": round(luminance, 2),
            "eye_distance": round(eye_distance, 2) if eye_distance is not None else None,
            "detection_score": float(detection_score) if np.isfinite(detection_score) else None,
            "pose": angles.tolist() if angles.shape == (3,) and np.isfinite(angles).all() else None,
            "occlusion_assessed": False,
            "note": "Landmark checks can flag possible obstruction; they cannot reliably detect all masks or occlusions."}
