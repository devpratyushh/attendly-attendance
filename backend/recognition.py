"""Deterministic, testable matching and conservative multi-photo evidence rules."""
import hashlib
import json
from itertools import combinations

import numpy as np
from scipy.optimize import linear_sum_assignment

ALGORITHM_VERSION = "guarded-assignment-v2"


def policy_digest(policy):
    return hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalized(vector):
    value = np.asarray(vector, dtype=np.float64)
    if value.ndim != 1 or not value.size or not np.isfinite(value).all():
        return None
    norm = np.linalg.norm(value)
    return value / norm if norm > 1e-12 else None


def score_faces(embeddings, student_embeddings):
    """Score each identity once, using its best valid enrollment angle."""
    ids = sorted(student_embeddings, key=str)
    scores = np.full((len(embeddings), len(ids)), -1.0)
    for row, embedding in enumerate(embeddings):
        query = normalized(embedding)
        if query is None:
            continue
        for col, student_id in enumerate(ids):
            gallery = [normalized(e) for e in student_embeddings[student_id]]
            valid = [e for e in gallery if e is not None and e.shape == query.shape]
            if valid:
                scores[row, col] = max(float(np.clip(np.dot(query, e), -1, 1)) for e in valid)
    return scores, ids


def assign_scores(scores, student_ids, qualities, policy):
    """Global one-to-one assignment with one reject column per detected face.

    An assignment is a suggestion, not proof of identity. An alternate assignment
    or a small row-level identity margin always requires review.
    """
    scores = np.asarray(scores, dtype=float)
    count, columns = scores.shape
    if columns != len(student_ids) or len(qualities) != count:
        raise ValueError("Score matrix, roster, and quality rows must agree")
    if not count:
        return []
    floor = policy["uncertain_threshold"]
    finite = np.isfinite(scores).all(axis=1)
    valid_quality = np.array([q.get("accepted", False) for q in qualities]) & finite
    safe = np.where(np.isfinite(scores), scores, -1.0)
    # Zero-weight reject columns beat every ineligible identity, including ties.
    weights = np.full((count, columns + count), -1e6)
    weights[:, columns:] = 0
    eligible = (safe > floor) & valid_quality[:, None]
    weights[:, :columns] = np.where(eligible, safe - floor, -1e6)
    rows, chosen = linear_sum_assignment(weights, maximize=True)
    choices = dict(zip(rows.tolist(), chosen.tolist()))
    results = []
    for row in range(count):
        ranking = np.argsort(-safe[row], kind="stable")
        best = int(ranking[0]) if columns else None
        runner = int(ranking[1]) if columns > 1 else None
        chosen_col = choices[row]
        assigned = chosen_col if chosen_col < columns and eligible[row, chosen_col] else None
        best_score = float(safe[row, best]) if best is not None else None
        score = float(safe[row, assigned]) if assigned is not None else best_score
        alternatives = [float(safe[row, j]) for j in range(columns) if j != assigned]
        margin = score - max(alternatives) if assigned is not None and alternatives else (2.0 if assigned is not None else None)
        reasons = []
        if not valid_quality[row]:
            status = "quality_rejected"
            reasons = list(qualities[row].get("reasons", [])) or ["invalid_embedding"]
        elif assigned is None:
            status = "not_found"
            reasons = ["identity_collision" if best_score is not None and best_score > floor else "below_review_threshold"]
        else:
            if score < policy["match_threshold"]:
                reasons.append("below_match_threshold")
            if margin < policy["min_match_margin"]:
                reasons.append("ambiguous_identity")
            if assigned != best:
                reasons.append("alternate_global_assignment")
            status = "uncertain" if reasons else "matched"
        results.append({
            "face_index": row, "student_id": student_ids[assigned] if assigned is not None else None,
            "best_student_id": student_ids[best] if best is not None else None,
            "runner_up_student_id": student_ids[runner] if runner is not None else None,
            "confidence": score, "best_score": best_score,
            "runner_up_score": float(safe[row, runner]) if runner is not None else None,
            "margin": margin, "status": status, "reasons": reasons, "quality": qualities[row],
        })
    return results


def match_faces(faces, gallery, policy):
    scores, ids = score_faces([face["embedding"] for face in faces], gallery)
    qualities = [face.get("quality", {"accepted": False, "reasons": ["quality_unavailable"]}) for face in faces]
    results = assign_scores(scores, ids, qualities, policy)
    # Invalid vectors cannot masquerade as a missing or low-similarity identity.
    for face, result in zip(faces, results):
        if normalized(face["embedding"]) is None:
            result.update(student_id=None, status="quality_rejected", reasons=["invalid_embedding"])
    return results


def similar_photo(left, right):
    if left.get("content_hash") and left.get("content_hash") == right.get("content_hash"):
        return True
    a, b = left.get("fingerprint"), right.get("fingerprint")
    if a and b:
        return bin(int(a, 16) ^ int(b, 16)).count("1") <= 4
    # Missing provenance must never count as independent evidence.
    return not (left.get("content_hash") and right.get("content_hash"))


def aggregate_evidence(photos, student_ids, policy):
    """Require independent, agreeing captures; never infer absence from a miss."""
    representatives = []
    groups = {}
    for photo in photos:
        group = next((i for i, earlier in enumerate(representatives) if similar_photo(photo, earlier)), None)
        if group is None:
            group = len(representatives)
            representatives.append(photo)
        groups[photo["id"]] = group
    results = []
    for student_id in student_ids:
        supports, conflicts, suggestions, ambiguous_photos, ambiguous_faces = [], [], [], [], []
        for photo in photos:
            for face in photo.get("results", []):
                if face.get("student_id") == student_id or (face.get('best_student_id') == student_id and
                        face.get('status') == 'quality_rejected' and (face.get('best_score') or -1) >= policy['uncertain_threshold']):
                    suggestions.append((photo, face))
                if face.get("student_id") == student_id and face["status"] == "matched" and face.get("quality", {}).get("accepted"):
                    supports.append((photo, face))
                ambiguous = face["status"] == "uncertain" or "identity_collision" in face.get("reasons", [])
                candidate_ids = {face.get("student_id"), face.get("best_student_id")}
                if "ambiguous_identity" in face.get("reasons", []):
                    candidate_ids.add(face.get("runner_up_student_id"))
                if ambiguous and student_id in candidate_ids:
                    ambiguous_photos.append(photo["id"])
                    ambiguous_faces.append((photo, face))
                # Two distinct faces in one image claiming the same identity is
                # a real collision. A low-score/close-runner suggestion is not a
                # contradiction of an otherwise clear positive observation.
                if "identity_collision" in face.get("reasons", []) and face.get("best_student_id") == student_id:
                    score, runner = face.get("best_score"), face.get("runner_up_score")
                    if score is not None and score >= policy["match_threshold"] and (runner is None or score-runner >= policy["min_match_margin"]):
                        conflicts.append(photo["id"])
        if supports:
            strongest = max(f["confidence"] for _, f in supports)
            for photo, face in ambiguous_faces:
                if face.get("best_score") is not None and strongest - face["best_score"] < policy.get("evidence_dominance_margin", .15):
                    conflicts.append(photo["id"])
        independent = {}
        for photo, face in supports:
            group = groups[photo["id"]]
            if group not in independent or face["confidence"] > independent[group][1]["confidence"]:
                independent[group] = (photo, face)
        chosen = list(independent.values())
        inconsistent = False
        # Compare every positive observation, including duplicate views. Duplicates
        # cannot vote, but inconsistent identity evidence must still be visible.
        for (_, first), (_, second) in combinations(supports, 2):
            a, b = normalized(first.get("embedding", [])), normalized(second.get("embedding", []))
            if a is None or b is None or a.shape != b.shape or np.dot(a, b) < policy["consistency_threshold"]:
                inconsistent = True
        # Also catch the same face confidently switching identity between views.
        for _, support in supports:
            a = normalized(support.get("embedding", []))
            for photo in photos:
                for face in photo.get("results", []):
                    if face.get("status") != "matched" or face.get("student_id") == student_id:
                        continue
                    b = normalized(face.get("embedding", []))
                    if a is not None and b is not None and a.shape == b.shape and np.dot(a, b) >= policy.get("cross_identity_threshold", .65):
                        conflicts.append(photo["id"])
        reasons = []
        if conflicts:
            reasons.append("conflicting_identity_evidence")
        if inconsistent:
            reasons.append("inconsistent_face_embeddings")
        if len(chosen) < policy["min_supporting_photos"]:
            if ambiguous_photos:
                reasons.append("ambiguous_identity")
            elif suggestions and not supports:
                reasons.extend(sorted({reason for _, face in suggestions for reason in face.get('reasons', [])}) or ['not_detected'])
            else:
                reasons.append("needs_more_independent_photos" if suggestions else "not_detected")
        matched = len(chosen) >= policy["min_supporting_photos"] and not conflicts and not inconsistent
        evidence = supports or suggestions
        # The representative is for display only; acceptance uses ALL evidence.
        display = max(evidence, key=lambda item: item[1].get("confidence") or -1) if evidence else ({}, {})
        photo, representative = display
        scores = [f["confidence"] for _, f in chosen if f.get("confidence") is not None]
        results.append({
            "student_id": student_id, "status": "matched" if matched else "unresolved",
            "confidence": min(scores) if scores else representative.get("confidence"),
            "reasons": reasons, "support_count": len(chosen),
            "supporting_photo_ids": [p["id"] for p, _ in chosen],
            "conflicting_photo_ids": sorted(set(conflicts)),
            "ambiguous_photo_ids": sorted(set(ambiguous_photos)),
            "class_photo_id": photo.get("id"), "crop_path": representative.get("crop_path"),
            "margin": representative.get("margin"),
        })
    return {"results": results, "photo_count": len(photos), "independent_photo_count": len(representatives),
            "required_support": policy["min_supporting_photos"], "policy_digest": policy_digest(policy),
            "unresolved_count": sum(r["status"] != "matched" for r in results)}


def legacy_match_scores(scores, student_ids, match_threshold=.45, uncertain_threshold=.35):
    """Frozen pre-safeguard matcher for baseline comparison; never used in production."""
    candidates = []
    for row in scores:
        col = int(np.argmax(row)) if len(row) else None
        score = float(row[col]) if col is not None else -1
        status = "matched" if score >= match_threshold else "uncertain" if score >= uncertain_threshold else "not_found"
        candidates.append({"student_id": student_ids[col] if col is not None and status != "not_found" else None,
                           "status": status, "confidence": score})
    for student_id in student_ids:
        duplicates = [i for i, candidate in enumerate(candidates) if candidate["student_id"] == student_id]
        if duplicates:
            best = max(duplicates, key=lambda i: candidates[i]["confidence"])
            for i in duplicates:
                if i != best:
                    candidates[i].update(student_id=None, status="not_found")
    return candidates
