"""Delete classroom images only after committed attendance has aged past retention."""
import argparse
import os
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from models import SessionLocal, Session, ClassPhoto, AttendanceRecord
from settings import SESSIONS_DIR


def cleanup_media(now=None, dry_run=False):
    now = now or datetime.utcnow()
    hours = max(1, int(os.getenv('ATTENDLY_IMAGE_RETENTION_HOURS', '24')))
    cutoff = now - timedelta(hours=hours)
    deleted = []
    root = Path(SESSIONS_DIR).resolve()
    with SessionLocal() as db:
        sessions = db.query(Session).filter(Session.status == 'confirmed', Session.confirmed_at < cutoff,
                                            Session.images_deleted_at.is_(None)).all()
        for session in sessions:
            folder = (root / session.session_id).resolve()
            if root not in folder.parents:
                continue
            deleted.append(session.session_id)
            if dry_run:
                continue
            if folder.is_dir():
                shutil.rmtree(folder)
            for photo in db.query(ClassPhoto).filter(ClassPhoto.session_id == session.id):
                photo.analysis_json = None  # Contains face vectors: retire those too.
            for record in db.query(AttendanceRecord).filter(AttendanceRecord.session_id == session.id):
                record.matched_crop_path = None
            session.images_deleted_at = now
        if not dry_run:
            db.commit()
    return deleted


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    print(cleanup_media(dry_run=args.dry_run))
