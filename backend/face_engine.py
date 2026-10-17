"""
Face detection, embedding extraction, and matching engine.
Uses InsightFace (buffalo_l) with ONNX Runtime.
"""
import os
import numpy as np
import cv2
from insightface.app import FaceAnalysis
from insightface.app.common import Face
from threading import RLock
from detection_geometry import detection_windows, merge_detections
import settings
from settings import FACE_MODEL_NAME, FACE_DET_SIZE
import logging
from image_quality import assess_face
from recognition import match_faces

logger = logging.getLogger(__name__)

# Global model instance (singleton)
_face_app = None
_face_lock = RLock()


def locate_preview_face(image):
    """Detection only for the enrollment guide; no embeddings or disk writes."""
    app = get_face_app()
    with _face_lock:
        boxes, _ = app.det_model.detect(image, input_size=(640, 640))
    boxes = [box for box in boxes if float(box[4]) >= .7]
    if len(boxes) != 1:
        return {"face_count": len(boxes), "bbox": None}
    height, width = image.shape[:2]
    box = boxes[0]
    return {"face_count": 1, "bbox": [float(box[0] / width), float(box[1] / height),
                                      float(box[2] / width), float(box[3] / height)]}


def get_face_app() -> FaceAnalysis:
    """Lazy-load and return the InsightFace model."""
    global _face_app
    with _face_lock:
        if _face_app is None:
            logger.info("Loading InsightFace model '%s'...", FACE_MODEL_NAME)
            _face_app = FaceAnalysis(name=FACE_MODEL_NAME,
                                     allowed_modules=['detection', 'recognition', 'landmark_3d_68'],
                                     providers=["CPUExecutionProvider"])
            _face_app.prepare(ctx_id=-1, det_size=FACE_DET_SIZE)
            logger.info("InsightFace model loaded successfully.")
    return _face_app


def detect_faces(image_path: str, policy=None):
    """
    Detect all faces in an image.
    Returns list of dicts: {bbox, embedding, face_image}
    Returns (None, error_message) if image can't be read.
    """
    app = get_face_app()

    img = cv2.imread(image_path)
    if img is None:
        return None, f"Cannot read image: {image_path}"

    h, w = img.shape[:2]
    # Detect on the whole image plus overlapping crops for large classrooms.
    # Translate landmarks before extracting embeddings from the original image.
    # Do not upscale tiny faces into passing the original-pixel quality gate.
    with _face_lock:
        candidates = []
        for x1, y1, x2, y2 in [(0, 0, w, h)] + detection_windows(w, h):
            boxes, landmarks = app.det_model.detect(img[y1:y2, x1:x2], input_size=FACE_DET_SIZE)
            for i, raw in enumerate(boxes):
                box = raw.copy()
                if (x1 > 0 and box[0] < 4) or (y1 > 0 and box[1] < 4) or (x2 < w and box[2] > x2-x1-4) or (y2 < h and box[3] > y2-y1-4):
                    continue  # A cut-off tile face is covered by the overlapping pass.
                box[:4] += np.array([x1, y1, x1, y1])
                points = landmarks[i] + np.array([x1, y1]) if landmarks is not None else None
                candidates.append((box, points))
        faces = []
        for box, points in merge_detections(candidates):
            face = Face(bbox=box[:4], kps=points, det_score=box[4])
            for task, model in app.models.items():
                if task != 'detection':
                    model.get(img, face)
            faces.append(face)
    if not faces:
        return [], f"No faces detected in: {os.path.basename(image_path)}"

    policy = policy or settings.recognition_policy()
    results = []
    for face in faces:
        bbox = face.bbox.astype(int)
        # Crop the face from the image with some padding
        h, w = img.shape[:2]
        x1 = max(0, bbox[0] - 10)
        y1 = max(0, bbox[1] - 10)
        x2 = min(w, bbox[2] + 10)
        y2 = min(h, bbox[3] + 10)
        crop = img[y1:y2, x1:x2]

        results.append({
            "bbox": bbox.tolist(),
            "embedding": face.normed_embedding,
            "crop": crop,
            "det_score": float(face.det_score),
            "quality": assess_face(img, face.bbox, float(face.det_score), face.get("kps"), face.get("pose"), policy["quality"]),
        })

    return results, None


def extract_single_face_embedding(image_path: str, *, allow_quality_override=False):
    """
    Extract embedding from an image that should contain exactly one face.
    Returns (embedding_ndarray, None) on success.
    Returns (None, error_message) on failure.
    """
    faces, error = detect_faces(image_path)
    if faces is None:
        return None, error
    if len(faces) == 0:
        return None, f"No face detected in {os.path.basename(image_path)}"
    if len(faces) > 1:
        return None, f"Multiple faces ({len(faces)}) detected in {os.path.basename(image_path)}, expected exactly 1"

    if not allow_quality_override and not faces[0]["quality"]["accepted"]:
        return None, "Retake this enrollment photo: " + ", ".join(faces[0]["quality"]["reasons"])
    embedding = np.asarray(faces[0]["embedding"], dtype=np.float32)
    if embedding.ndim != 1 or not embedding.size or not np.isfinite(embedding).all() or np.linalg.norm(embedding) <= 1e-12:
        return None, "Could not compute a usable face embedding from this photo"
    return embedding, None


def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
    """Compute cosine similarity between two embeddings."""
    return float(np.dot(emb1, emb2) / (np.linalg.norm(emb1) * np.linalg.norm(emb2) + 1e-8))


def match_face_to_students(face_embedding, student_embeddings, match_threshold=None, uncertain_threshold=None):
    """Compatibility helper; production matching evaluates all faces together."""
    policy = settings.recognition_policy()
    if match_threshold is not None:
        policy["match_threshold"] = match_threshold
    if uncertain_threshold is not None:
        policy["uncertain_threshold"] = uncertain_threshold
    return match_faces([{"embedding": face_embedding, "quality": {"accepted": True, "reasons": []}}], student_embeddings, policy)[0]


def annotate_class_photo(image_path: str, detections: list, output_path: str):
    """
    Draw labeled bounding boxes on a class photo.

    Args:
        image_path: Path to the original class photo.
        detections: list of dicts with bbox, label, status, confidence.
        output_path: Where to save the annotated image.
    """
    img = cv2.imread(image_path)
    if img is None:
        return

    for det in detections:
        bbox = det["bbox"]
        label = det.get("label", "Unknown")
        status = det.get("status", "not_found")
        confidence = det.get("confidence", 0)

        # Color by status
        if status == "matched":
            color = (0, 200, 0)  # Green
        elif status in ("uncertain", "quality_rejected", "unresolved"):
            color = (0, 165, 255)  # Orange
        else:
            color = (0, 0, 255)  # Red

        # Draw box
        cv2.rectangle(img, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color, 2)

        # Draw label background
        text = f"{label} ({confidence:.2f})" if confidence is not None else label
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.5
        thickness = 1
        (text_w, text_h), baseline = cv2.getTextSize(text, font, font_scale, thickness)

        y_text = max(bbox[1] - 5, text_h + 5)
        cv2.rectangle(img, (bbox[0], y_text - text_h - 5), (bbox[0] + text_w + 4, y_text + 3), color, -1)
        cv2.putText(img, text, (bbox[0] + 2, y_text - 2), font, font_scale, (255, 255, 255), thickness)

    cv2.imwrite(output_path, img)


def save_face_crop(image_path: str, bbox: list, output_path: str):
    """Save a cropped face region from an image."""
    img = cv2.imread(image_path)
    if img is None:
        return False

    h, w = img.shape[:2]
    x1 = max(0, bbox[0] - 15)
    y1 = max(0, bbox[1] - 15)
    x2 = min(w, bbox[2] + 15)
    y2 = min(h, bbox[3] + 15)

    crop = img[y1:y2, x1:x2]
    if not crop.size:
        return False
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    return bool(cv2.imwrite(output_path, crop))
