"""
Seed the database with students from CSV and compute initial embeddings
from enrollment photos. Run on first startup.
"""
import os
import sys
import shutil
import numpy as np
import pandas as pd
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# Add backend dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from settings import (
    SOURCE_CSV, SOURCE_BIOMETRIC, PHOTOS_DIR, DATA_DIR
)
from models import init_db, SessionLocal, Student, EnrolledPhoto, FaceEmbedding
from face_engine import extract_single_face_embedding


def seed():
    """Seed students and compute embeddings."""
    init_db()
    db = SessionLocal()

    # Check if already seeded
    existing = db.query(Student).count()
    if existing > 0:
        logger.info("Database already has %d students. Skipping seed.", existing)
        db.close()
        return

    # Read CSV
    if not os.path.exists(SOURCE_CSV):
        logger.warning("Source CSV not found at '%s'. Skipping automatic seed.", SOURCE_CSV)
        db.close()
        return

    logger.info("Reading student list from %s", SOURCE_CSV)
    df = pd.read_csv(SOURCE_CSV)
    df.columns = [c.strip() for c in df.columns]

    os.makedirs(PHOTOS_DIR, exist_ok=True)

    skipped_files = []
    total_embeddings = 0

    for _, row in df.iterrows():
        roll_no = str(row["roll_no"]).strip()
        name = str(row["name"]).strip()
        email = str(row.get("email", "")).strip() if pd.notna(row.get("email", "")) else ""

        logger.info("Seeding student: %s (%s)", name, roll_no)

        student = Student(roll_no=roll_no, name=name, email=email, consent_given=True)
        db.add(student)
        db.flush()  # Get student.id

        # Find biometric folder - try exact roll_no match first, then pattern match
        bio_folder = None
        if os.path.exists(SOURCE_BIOMETRIC):
            for folder_name in os.listdir(SOURCE_BIOMETRIC):
                folder_path = os.path.join(SOURCE_BIOMETRIC, folder_name)
                if os.path.isdir(folder_path) and folder_name.startswith(roll_no):
                    bio_folder = folder_path
                    break

        if not bio_folder:
            logger.warning("No biometric folder found for %s", roll_no)
            continue

        # Copy photos to app data dir and create records
        student_photo_dir = os.path.join(PHOTOS_DIR, roll_no)
        os.makedirs(student_photo_dir, exist_ok=True)

        for photo_type in ["front", "left", "right"]:
            # Try common extensions
            src_path = None
            for ext in [".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"]:
                candidate = os.path.join(bio_folder, f"{photo_type}{ext}")
                if os.path.exists(candidate):
                    src_path = candidate
                    break

            if not src_path:
                logger.warning("Missing %s photo for %s", photo_type, roll_no)
                continue

            # Copy to data dir (never modify originals)
            dst_filename = f"{photo_type}.jpg"
            dst_path = os.path.join(student_photo_dir, dst_filename)
            shutil.copy2(src_path, dst_path)

            # Create enrolled photo record
            rel_path = os.path.join(roll_no, dst_filename)
            photo = EnrolledPhoto(
                student_id=student.id,
                photo_type=photo_type,
                file_path=rel_path,
                uploaded_by="system"
            )
            db.add(photo)
            db.flush()

            # Compute embedding
            logger.info("  Computing embedding for %s/%s...", roll_no, photo_type)
            embedding, error = extract_single_face_embedding(dst_path)

            if error:
                logger.warning("  SKIPPED: %s/%s - %s", roll_no, photo_type, error)
                skipped_files.append({"file": f"{roll_no}/{photo_type}.jpg", "reason": error})
                continue

            # Store embedding
            emb_record = FaceEmbedding(
                student_id=student.id,
                photo_id=photo.id,
                embedding=embedding.tobytes()
            )
            db.add(emb_record)
            total_embeddings += 1

    db.commit()
    db.close()

    logger.info("=" * 60)
    logger.info("Seeding complete!")
    logger.info("Total embeddings computed: %d", total_embeddings)
    if skipped_files:
        logger.warning("Skipped files:")
        for sf in skipped_files:
            logger.warning("  %s: %s", sf["file"], sf["reason"])
    logger.info("=" * 60)


if __name__ == "__main__":
    seed()
