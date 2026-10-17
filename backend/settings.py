"""
Centralized settings for the Face Recognition Attendance App.
Edit this file to configure subject, thresholds, and paths.
"""
import os

# ── Subject & Teacher ──────────────────────────────────────────────
SUBJECT_NAME = "Machine Learning"
SUBJECT_CODE = "CS5001"
TEACHER_NAME = "Dr. Faculty"

# ── Face-matching thresholds (cosine similarity) ───────────────────
# >= MATCH_THRESHOLD        → Matched (auto-present)
# >= UNCERTAIN_THRESHOLD    → Uncertain (needs teacher approval)
# <  UNCERTAIN_THRESHOLD    → Not Found
DEFAULT_MATCH_THRESHOLD = 0.45
DEFAULT_UNCERTAIN_THRESHOLD = 0.35
CONFIG_FILE = os.path.join(os.getenv("ATTENDLY_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")), "config.json")


DEFAULT_MATCH_MARGIN = 0.08
DEFAULT_QUALITY = {
    "min_face_pixels": 64, "min_detection_score": 0.70, "min_sharpness": 40.0,
    "min_luminance": 25.0, "max_luminance": 235.0,
    "max_abs_yaw": 45.0, "max_abs_pitch": 35.0, "min_eye_distance": 18.0,
}


def load_config():
    import json
    try:
        with open(CONFIG_FILE) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def load_thresholds():
    config = load_config()
    return float(config.get("match_threshold", DEFAULT_MATCH_THRESHOLD)), float(config.get("uncertain_threshold", DEFAULT_UNCERTAIN_THRESHOLD))


def save_config(config):
    import json
    import tempfile
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(CONFIG_FILE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(config, handle, indent=2, allow_nan=False)
        os.replace(temporary, CONFIG_FILE)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def save_thresholds(m: float, u: float, margin: float = None):
    global MATCH_THRESHOLD, UNCERTAIN_THRESHOLD
    config = load_config()
    config.update(match_threshold=float(m), uncertain_threshold=float(u),
                  min_match_margin=float(margin if margin is not None else config.get("min_match_margin", DEFAULT_MATCH_MARGIN)))
    config.pop("calibration", None)
    save_config(config)
    MATCH_THRESHOLD, UNCERTAIN_THRESHOLD = float(m), float(u)


def recognition_policy():
    from recognition import ALGORITHM_VERSION
    config = load_config()
    return {
        "algorithm_version": ALGORITHM_VERSION, "model_name": FACE_MODEL_NAME,
        "match_threshold": float(config.get("match_threshold", DEFAULT_MATCH_THRESHOLD)),
        "uncertain_threshold": float(config.get("uncertain_threshold", DEFAULT_UNCERTAIN_THRESHOLD)),
        "min_match_margin": float(config.get("min_match_margin", DEFAULT_MATCH_MARGIN)),
        "min_supporting_photos": 1, "consistency_threshold": 0.40,
        "cross_identity_threshold": 0.65, "detector_strategy": "overlapping-tiles-v1",
        "evidence_dominance_margin": 0.15,
        "quality": dict(DEFAULT_QUALITY),
    }


MATCH_THRESHOLD, UNCERTAIN_THRESHOLD = load_thresholds()

# ── Paths ──────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("ATTENDLY_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "attendance.db")
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")            # enrolled photos
SESSIONS_DIR = os.path.join(DATA_DIR, "sessions")         # class photos & crops
PENDING_DIR = os.path.join(DATA_DIR, "pending_biometric")  # student-submitted updates

# Source data (for initial seed)
SOURCE_CSV = os.getenv("ATTENDLY_SOURCE_CSV", os.path.join(DATA_DIR, "import", "students.csv"))
SOURCE_BIOMETRIC = os.getenv("ATTENDLY_SOURCE_BIOMETRIC", os.path.join(DATA_DIR, "import", "biometrics"))
SOURCE_CLASSROOM = os.getenv("ATTENDLY_SOURCE_CLASSROOM", os.path.join(DATA_DIR, "import", "classroom"))

# ── Server ─────────────────────────────────────────────────────────
HOST = "0.0.0.0"
PORT = 8000

# ── InsightFace model ─────────────────────────────────────────────
FACE_MODEL_NAME = "buffalo_l"
FACE_DET_SIZE = (640, 640)
