"""Account provisioning, class teacher appointments, and teaching assignments."""
import shutil
from pathlib import Path
from datetime import timezone
from typing import Literal, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession
from sqlalchemy import func, case
from models import (get_db, User, Student, Classroom, SubjectAssignment, LoginSession,
                    Session as AttendanceSession, BiometricLog, AttendanceRecord, utc_now)
from auth import hash_password, managed_classes, require_manager, visible_class_ids, user_data
from settings import PHOTOS_DIR, PENDING_DIR

router = APIRouter(prefix="/api/admin")


def admin_only(db):
    if db.info["user"].role != "admin":
        raise HTTPException(403, "Only the admin can manage staff and classes")


class AccountInput(BaseModel):
    username: str = Field(min_length=3, max_length=80, pattern=r"^[a-zA-Z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=8, max_length=200)
    role: Literal["teacher", "student"]
    roll_no: Optional[str] = Field(default=None, max_length=20, pattern=r"^[a-zA-Z0-9_-]+$")
    email: str = Field(default="", max_length=100)
    class_id: Optional[int] = None


@router.get("/overview")
def overview(db: DBSession = Depends(get_db)):
    user = db.info["user"]
    classrooms = db.query(Classroom)
    if user.role != "admin":
        classrooms = classrooms.filter(Classroom.id.in_(managed_classes(db, user)))
    classes = classrooms.order_by(Classroom.name).all()
    class_ids = [c.id for c in classes]
    teachers = db.query(User).filter(User.role == "teacher").order_by(User.name).all()
    users = db.query(User).filter(User.role != "admin")
    if user.role != "admin":
        users = users.filter(User.student_id.in_(db.query(Student.id).filter(Student.class_id.in_(class_ids))))
    students = db.query(Student).filter(Student.class_id.in_(class_ids), Student.archived_at.is_(None)).all()
    former_students = db.query(Student).filter(Student.archived_at.is_not(None))
    if user.role != "admin":
        former_students = former_students.filter(Student.class_id.in_(class_ids))
    student_map = {s.id: s for s in students}
    assignments = db.query(SubjectAssignment).filter(SubjectAssignment.class_id.in_(class_ids)).all()
    attendance = (db.query(SubjectAssignment.class_id, AttendanceSession.date, AttendanceSession.periods,
                          func.count(AttendanceRecord.id),
                          func.sum(case((AttendanceRecord.status == "present", 1), else_=0)))
                  .join(AttendanceSession, AttendanceSession.assignment_id == SubjectAssignment.id)
                  .join(AttendanceRecord, AttendanceRecord.session_id == AttendanceSession.id)
                  .filter(SubjectAssignment.class_id.in_(class_ids), AttendanceSession.status == "confirmed")
                  .group_by(SubjectAssignment.class_id, AttendanceSession.id)
                  .order_by(AttendanceSession.date).all())
    return {
        "former_students": [
            {"id": s.id, "name": s.name, "roll_no": s.roll_no, "class_id": s.class_id,
             "class_name": (s.enrollment_at_departure or {}).get("class_name"),
             "archived_at": s.archived_at.replace(tzinfo=timezone.utc).isoformat()}
            for s in former_students.order_by(Student.name, Student.roll_no)
        ],
        "class_attendance": [{"class_id": cid, "date": date.isoformat(),
                              "total": count * periods, "attended": int(present or 0) * periods}
                             for cid, date, periods, count, present in attendance],
        "classes": [{"id": c.id, "name": c.name, "class_teacher_id": c.class_teacher_id,
                     "student_count": sum(s.class_id == c.id for s in students)} for c in classes],
        "teachers": [{"id": t.id, "name": t.name, "username": t.username} for t in teachers],
        "users": [dict(user_data(db, u),
                       class_id=student_map[u.student_id].class_id if u.student_id in student_map else None,
                       roll_no=student_map[u.student_id].roll_no if u.student_id in student_map else None)
                  for u in users.order_by(User.name).all()],
        "assignments": [assignment_data(db, a) for a in assignments],
    }


@router.get("/former-students/{student_id}")
def former_student_record(student_id: int, db: DBSession = Depends(get_db)):
    student = db.get(Student, student_id)
    if not student or student.archived_at is None:
        raise HTTPException(404, "Former student not found")
    require_manager(db, student.class_id)
    records = (db.query(AttendanceRecord, AttendanceSession, SubjectAssignment, Classroom)
               .join(AttendanceSession, AttendanceSession.id == AttendanceRecord.session_id)
               .outerjoin(SubjectAssignment, SubjectAssignment.id == AttendanceSession.assignment_id)
               .outerjoin(Classroom, Classroom.id == SubjectAssignment.class_id)
               .filter(AttendanceRecord.student_id == student.id))
    if db.info["user"].role != "admin":
        records = records.filter(Classroom.id.in_(managed_classes(db, db.info["user"])))
    return {
        "enrollment_at_departure": student.enrollment_at_departure,
        "attendance": [
            {"session_id": session.session_id, "date": session.date.replace(tzinfo=timezone.utc).isoformat(),
             "subject_name": subject.subject_name if subject else None,
             "subject_code": subject.subject_code if subject else None,
             "class_name": student.recorded_class_name(classroom),
             "periods": session.periods, "status": record.status, "method": record.method,
             "manual_reason": record.manual_reason}
            for record, session, subject, classroom in records.order_by(AttendanceSession.date.desc(), AttendanceSession.id.desc())
        ],
    }


@router.post("/users", status_code=201)
def create_user(data: AccountInput, db: DBSession = Depends(get_db)):
    if not data.name.strip():
        raise HTTPException(400, "Full name is required")
    if data.role == "teacher":
        admin_only(db)
    else:
        classroom = db.get(Classroom, data.class_id) if data.class_id else None
        if not classroom:
            raise HTTPException(400, "Choose a class for the student")
        require_manager(db, classroom.id)
        if not data.roll_no:
            raise HTTPException(400, "A roll number is required")
        if db.query(Student).filter(Student.roll_no == data.roll_no).first():
            raise HTTPException(409, "That roll number is already in use")
    username = data.username.lower()
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(409, "That username is already in use")
    student = None
    if data.role == "student":
        student = Student(roll_no=data.roll_no, name=data.name.strip(), email=data.email,
                          class_id=data.class_id, consent_given=False)
        db.add(student)
        db.flush()
    user = User(username=username, name=data.name.strip(), role=data.role,
                password_hash=hash_password(data.password), student_id=student.id if student else None)
    db.add(user)
    db.commit()
    return user_data(db, user)


@router.delete("/users/{user_id}")
def remove_user(user_id: int, db: DBSession = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Account not found")
    if user.role == "admin":
        raise HTTPException(400, "The admin account cannot be removed")
    student = db.get(Student, user.student_id) if user.student_id else None
    if student:
        require_manager(db, student.class_id)
    else:
        admin_only(db)
        if db.query(SubjectAssignment).filter(SubjectAssignment.teacher_id == user.id).first() or \
           db.query(Classroom).filter(Classroom.class_teacher_id == user.id).first():
            raise HTTPException(409, "Reassign this teacher's subjects and class responsibilities first")
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.query(AttendanceSession).filter(AttendanceSession.created_by == user.id).update({"created_by": None})
    db.delete(user)
    if student:
        # Keep the identity and attendance links for historical reports.
        student.archived_at = utc_now()
        classroom = db.get(Classroom, student.class_id) if student.class_id else None
        subjects = db.query(SubjectAssignment).filter_by(class_id=student.class_id).order_by(SubjectAssignment.subject_code)
        student.enrollment_at_departure = {
            "class_name": classroom.name if classroom else None,
            "subjects": [{"name": subject.subject_name, "code": subject.subject_code} for subject in subjects],
        }
        student.consent_given = False
        student.embeddings.clear()
        student.photos.clear()
        student.pending_updates.clear()
        db.add(BiometricLog(student_id=student.id, action="archive",
                            detail="Account removed; attendance history preserved",
                            performed_by=db.info["user"].username))
    db.commit()
    if student:
        for root in (PHOTOS_DIR, PENDING_DIR):
            folder = Path(root) / student.roll_no
            if folder.is_dir():
                shutil.rmtree(folder)
        from main import invalidate_embeddings_cache
        invalidate_embeddings_cache()
    return {"message": "Account removed"}


class ResetInput(BaseModel):
    password: str = Field(min_length=8, max_length=200)


@router.post("/users/{user_id}/password")
def reset_password(user_id: int, data: ResetInput, db: DBSession = Depends(get_db)):
    user = db.get(User, user_id)
    if not user or user.role == "admin":
        raise HTTPException(404, "Account not found")
    if user.role == "student":
        require_manager(db, db.get(Student, user.student_id).class_id)
    else:
        admin_only(db)
    user.password_hash = hash_password(data.password)
    db.query(LoginSession).filter(LoginSession.user_id == user.id).delete()
    db.commit()
    return {"message": "Password reset; existing sessions signed out"}


class ClassroomInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    class_teacher_id: Optional[int] = None


def validate_teacher(db, teacher_id):
    teacher = db.get(User, teacher_id) if teacher_id else None
    if not teacher or teacher.role != "teacher":
        raise HTTPException(400, "Select a teacher account")


@router.post("/classes", status_code=201)
def create_class(data: ClassroomInput, db: DBSession = Depends(get_db)):
    admin_only(db)
    if data.class_teacher_id:
        validate_teacher(db, data.class_teacher_id)
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Class name is required")
    if db.query(Classroom).filter(Classroom.name == name).first():
        raise HTTPException(409, "That class already exists")
    classroom = Classroom(name=name, class_teacher_id=data.class_teacher_id)
    db.add(classroom)
    db.commit()
    return {"id": classroom.id, "name": classroom.name}


@router.put("/classes/{class_id}")
def update_class(class_id: int, data: ClassroomInput, db: DBSession = Depends(get_db)):
    admin_only(db)
    classroom = db.get(Classroom, class_id)
    if not classroom:
        raise HTTPException(404, "Class not found")
    if data.class_teacher_id:
        validate_teacher(db, data.class_teacher_id)
    name = data.name.strip()
    if not name:
        raise HTTPException(400, "Class name is required")
    if db.query(Classroom).filter(Classroom.name == name, Classroom.id != class_id).first():
        raise HTTPException(409, "That class already exists")
    classroom.name, classroom.class_teacher_id = name, data.class_teacher_id
    db.commit()
    return {"message": "Class updated"}


class AssignmentInput(BaseModel):
    class_id: int
    teacher_id: int
    subject_name: str = Field(min_length=1, max_length=100)
    subject_code: str = Field(min_length=1, max_length=30)


def assignment_data(db, a):
    classroom, teacher = db.get(Classroom, a.class_id), db.get(User, a.teacher_id)
    return {"id": a.id, "class_id": a.class_id, "class_name": classroom.name,
            "teacher_id": a.teacher_id, "teacher_name": teacher.name,
            "subject_name": a.subject_name, "subject_code": a.subject_code}


@router.post("/assignments", status_code=201)
def create_assignment(data: AssignmentInput, db: DBSession = Depends(get_db)):
    if not data.subject_name.strip() or not data.subject_code.strip():
        raise HTTPException(400, "Subject name and code are required")
    if not db.get(Classroom, data.class_id):
        raise HTTPException(404, "Class not found")
    require_manager(db, data.class_id)
    validate_teacher(db, data.teacher_id)
    if db.query(SubjectAssignment).filter(SubjectAssignment.class_id == data.class_id,
                                          SubjectAssignment.subject_code == data.subject_code.strip().upper()).first():
        raise HTTPException(409, "This subject is already assigned in the class")
    assignment = SubjectAssignment(class_id=data.class_id, teacher_id=data.teacher_id,
                                   subject_name=data.subject_name.strip(), subject_code=data.subject_code.strip().upper())
    db.add(assignment)
    db.commit()
    return assignment_data(db, assignment)


@router.put("/assignments/{assignment_id}")
def reassign(assignment_id: int, data: AssignmentInput, db: DBSession = Depends(get_db)):
    assignment = db.get(SubjectAssignment, assignment_id)
    if not assignment:
        raise HTTPException(404, "Subject assignment not found")
    require_manager(db, assignment.class_id)
    if data.class_id != assignment.class_id:
        raise HTTPException(400, "A subject assignment cannot be moved between classes")
    validate_teacher(db, data.teacher_id)
    assignment.teacher_id = data.teacher_id
    db.commit()
    return assignment_data(db, assignment)


@router.delete("/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, db: DBSession = Depends(get_db)):
    assignment = db.get(SubjectAssignment, assignment_id)
    if not assignment:
        raise HTTPException(404, "Subject assignment not found")
    require_manager(db, assignment.class_id)
    if db.query(AttendanceSession).filter(AttendanceSession.assignment_id == assignment.id).first():
        raise HTTPException(409, "This subject has attendance history. Reassign its teacher instead.")
    db.delete(assignment)
    db.commit()
    return {"message": "Assignment removed"}
