"""Offline baseline measurement and calibration using independently labeled photos.

No school database is read or changed. See evaluation/example_manifest.json.
"""
import argparse
import hashlib
import json
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.stats import beta

import settings
from image_quality import image_fingerprint
from recognition import (ALGORITHM_VERSION, assign_scores, legacy_match_scores, score_faces,
                         aggregate_evidence, similar_photo)


def error_upper_bound(errors, trials):
    """One-sided 95% Clopper-Pearson bound; capture groups are the sampling units."""
    if not trials or errors >= trials:
        return 1.0
    return float(beta.ppf(.95, errors + 1, trials - errors))


def box_iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0


def align_labels(detections, labels, roster):
    """One-to-one ground-truth matching at IoU >= 0.5; unmatched detections are unknown."""
    truth = [None] * len(detections)
    matched = set()
    if detections and labels:
        overlap = np.array([[box_iou(d['bbox'], label['bbox']) for label in labels] for d in detections])
        weights = np.concatenate((np.where(overlap >= .5, overlap, -1e6), np.zeros((len(detections), len(detections)))), axis=1)
        rows, cols = linear_sum_assignment(weights, maximize=True)
        for row, col in zip(rows, cols):
            if col < len(labels) and overlap[row, col] >= .5:
                matched.add(int(col))
                identity = labels[col].get('student_id')
                truth[row] = identity if identity in roster else None
    return truth, matched


def summarize(samples, predictions):
    totals = dict(labeled_faces=0, missed_faces=0, spurious_detections=0, detected_faces=0,
                  known_probes=0, unknown_probes=0, wrong_identity_matches=0,
                  correct_identity_matches=0, unknown_identity_matches=0, review_faces=0,
                  correct_review_suggestions=0, unknown_review_suggestions=0)
    groups = defaultdict(lambda: False)
    condition_counts = defaultdict(lambda: dict(labeled_faces=0, missed_faces=0, wrong_identity_matches=0, review_faces=0))
    timings = []
    for sample, rows in zip(samples, predictions):
        totals['labeled_faces'] += len(sample['labels'])
        totals['missed_faces'] += len(sample['labels']) - len(sample['matched_labels'])
        totals['spurious_detections'] += len(rows) - len(sample['matched_labels'])
        totals['detected_faces'] += len(rows)
        groups[sample['group']]  # Include groups with no accepted identity.
        timings.append(sample['detection_ms'])
        wrong, reviews = 0, 0
        for actual, row in zip(sample['truth'], rows):
            known = actual is not None
            totals['known_probes' if known else 'unknown_probes'] += 1
            if row['status'] == 'matched':
                if known and row['student_id'] == actual:
                    totals['correct_identity_matches'] += 1
                else:
                    totals['wrong_identity_matches'] += 1
                    totals['unknown_identity_matches'] += int(not known)
                    groups[sample['group']] = True
                    wrong += 1
            else:
                totals['review_faces'] += 1
                reviews += 1
                if row['status'] == 'uncertain':
                    totals['correct_review_suggestions'] += int(known and row['student_id'] == actual)
                    totals['unknown_review_suggestions'] += int(not known)
        for condition in sample['conditions']:
            item = condition_counts[condition]
            item['labeled_faces'] += len(sample['labels'])
            item['missed_faces'] += len(sample['labels']) - len(sample['matched_labels'])
            item['wrong_identity_matches'] += wrong
            item['review_faces'] += reviews
    totals.update(capture_groups=len(groups), error_groups=sum(groups.values()),
                  error_group_upper_95=error_upper_bound(sum(groups.values()), len(groups)),
                  review_fraction=totals['review_faces'] / totals['detected_faces'] if totals['detected_faces'] else 0,
                  detection_recall=1-totals['missed_faces']/totals['labeled_faces'] if totals['labeled_faces'] else None,
                  conditions=dict(condition_counts),
                  detection_latency_ms={"median": float(np.median(timings)) if timings else None,
                                        "p95": float(np.percentile(timings, 95)) if timings else None})
    return totals


def predict(samples, policy, legacy=False):
    started = time.perf_counter()
    rows = [(legacy_match_scores(sample['scores'], sample['ids'], .45, .35) if legacy else
             assign_scores(sample['scores'], sample['ids'], [face['quality'] for face in sample['faces']], policy)) for sample in samples]
    elapsed = (time.perf_counter() - started) * 1000
    return rows, elapsed


def validate_manifest(path):
    manifest = json.loads(path.read_text())
    if manifest.get('schema_version') != 1 or not manifest.get('dataset_id'):
        raise ValueError('Manifest needs schema_version 1 and a dataset_id')
    if not manifest.get('enrollment') or not manifest.get('images'):
        raise ValueError('Provide labeled classroom images and separate enrollment photos')
    ids, groups, hashes, seen_paths = set(), {}, {}, set()
    digest = hashlib.sha256(path.read_bytes())
    fingerprints = []

    def inspect_file(relative, role):
        filename = (path.parent / relative).resolve()
        if not filename.is_file():
            raise ValueError(f'Image does not exist: {relative}')
        raw = filename.read_bytes()
        content_hash = hashlib.sha256(raw).hexdigest()
        if filename in seen_paths or content_hash in hashes:
            raise ValueError('A photo is repeated in the dataset; enrollment and evaluation must be independent')
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f'Image cannot be decoded: {relative}')
        fingerprint = image_fingerprint(image)
        if any(other_role != role and similar_photo({'fingerprint': fingerprint, 'content_hash': content_hash}, previous)
               for previous, other_role in fingerprints):
            raise ValueError('Near-duplicate images cross enrollment/calibration/evaluation boundaries')
        fingerprints.append(({'fingerprint': fingerprint, 'content_hash': content_hash}, role))
        seen_paths.add(filename); hashes[content_hash] = role; digest.update(raw)
        return filename, content_hash, fingerprint

    for enrolled in manifest['enrollment']:
        identity = enrolled.get('student_id')
        if not isinstance(identity, str) or not identity or identity in ids or not enrolled.get('photos'):
            raise ValueError('Every enrollment needs a unique string student_id and photos')
        ids.add(identity)
        group = enrolled.get('capture_group')
        if not group:
            raise ValueError('Enrollment photos need a capture_group (for example enrollment-day-1)')
        if group in groups and groups[group] != 'enrollment':
            raise ValueError('A capture group crosses splits')
        groups[group] = 'enrollment'
        enrolled['_paths'] = [inspect_file(photo, 'enrollment')[0] for photo in enrolled['photos']]
    sessions = {}
    for item in manifest['images']:
        split, group, session = item.get('split'), item.get('capture_group'), item.get('session_id')
        if split not in ('calibration', 'evaluation') or not group or not session:
            raise ValueError('Each classroom photo needs split, capture_group, and session_id')
        if group in groups and groups[group] != split:
            raise ValueError('A capture group/day crosses enrollment, calibration, or evaluation splits')
        if session in sessions and sessions[session] != split:
            raise ValueError('A classroom session crosses calibration/evaluation splits')
        sessions[session], groups[group] = split, split
        roster = item.get('roster')
        if not roster or len(set(roster)) != len(roster) or not set(roster).issubset(ids):
            raise ValueError('Each image needs a unique roster of enrolled student IDs')
        if not isinstance(item.get('faces'), list):
            raise ValueError('Every image must explicitly label all faces, including unknown people')
        for face in item['faces']:
            box = np.asarray(face.get('bbox', []), dtype=float)
            if box.shape != (4,) or not np.isfinite(box).all() or box[2] <= box[0] or box[3] <= box[1]:
                raise ValueError('Labels need valid [left, top, right, bottom] boxes')
            if 'student_id' not in face or (face['student_id'] is not None and not isinstance(face['student_id'], str)):
                raise ValueError('Label student_id must be a string or null for unknown/outside-class people')
        item['_path'], item['_hash'], item['_fingerprint'] = inspect_file(item['path'], split)
    if not {'calibration', 'evaluation'}.issubset({item['split'] for item in manifest['images']}):
        raise ValueError('Use separate calibration and evaluation images')
    return manifest, digest.hexdigest()


def load_samples(manifest, policy):
    from face_engine import detect_faces, extract_single_face_embedding
    gallery = {}
    for identity in manifest['enrollment']:
        entries = []
        for filename in identity['_paths']:
            embedding, error = extract_single_face_embedding(str(filename))
            if error:
                raise ValueError(f'Enrollment {identity["student_id"]}: {error}')
            entries.append(embedding)
        gallery[identity['student_id']] = entries
    samples = []
    for index, item in enumerate(manifest['images']):
        started = time.perf_counter()
        faces, error = detect_faces(str(item['_path']), policy=policy)
        elapsed = (time.perf_counter() - started) * 1000
        if faces is None:
            raise ValueError(error)
        scores, ids = score_faces([f['embedding'] for f in faces], {sid: gallery[sid] for sid in item['roster']})
        truth, matched = align_labels(faces, item['faces'], item['roster'])
        samples.append(dict(faces=faces, scores=scores, ids=ids, truth=truth, labels=item['faces'],
                            matched_labels=matched, detection_ms=elapsed, group=item['capture_group'],
                            session_id=item['session_id'], split=item['split'], conditions=item.get('conditions', []),
                            id=index, content_hash=item['_hash'], fingerprint=item['_fingerprint']))
    return samples


def session_summary(samples, predictions, policy):
    sessions = defaultdict(list)
    roster = defaultdict(set)
    for sample, rows in zip(samples, predictions):
        enriched = [dict(row, embedding=np.asarray(face['embedding']).tolist()) for row, face in zip(rows, sample['faces'])]
        sessions[sample['session_id']].append(dict(id=sample['id'], results=enriched,
                                                 content_hash=sample['content_hash'], fingerprint=sample['fingerprint']))
        roster[sample['session_id']].update(sample['ids'])
    results = [aggregate_evidence(photos, sorted(roster[sid]), policy) for sid, photos in sessions.items()]
    return {'sessions': len(results), 'automatic_presence_suggestions': sum(
        row['status'] == 'matched' for result in results for row in result['results']),
        'unresolved_students': sum(result['unresolved_count'] for result in results)}


def recommend_policy(samples, policy, target):
    """Tune only on calibration groups; held-out evaluation is never searched."""
    best = None
    for match in (.4, .45, .5, .55, .6, .65, .7, .75, .8, .85, .9):
        for floor in (.2, .3, .35, .4):
            if floor >= match:
                continue
            for margin in (.04, .06, .08, .10, .12, .16, .20):
                candidate = dict(policy, match_threshold=match, uncertain_threshold=floor, min_match_margin=margin)
                rows, _ = predict(samples, candidate)
                metrics = summarize(samples, rows)
                if (not metrics['known_probes'] or not metrics['unknown_probes'] or
                    not metrics['correct_identity_matches'] or metrics['error_group_upper_95'] > target):
                    continue
                rank = (metrics['correct_identity_matches'],
                        metrics['correct_review_suggestions'] - metrics['unknown_review_suggestions'], margin, match)
                if best is None or rank > best[0]:
                    best = rank, candidate, metrics
    return best


def make_report(samples, policy, dataset_id, dataset_digest, target):
    calibration = [sample for sample in samples if sample['split'] == 'calibration']
    evaluation = [sample for sample in samples if sample['split'] == 'evaluation']
    baseline_rows, baseline_time = predict(evaluation, policy, legacy=True)
    current_rows, current_time = predict(evaluation, policy)
    report = {'schema_version': 1, 'algorithm_version': ALGORITHM_VERSION, 'model_name': settings.FACE_MODEL_NAME,
              'dataset_id': dataset_id, 'dataset_digest': dataset_digest, 'target_error_group_rate': target,
              'policy': policy, 'baseline': summarize(evaluation, baseline_rows),
              'guarded': summarize(evaluation, current_rows), 'session_evidence': session_summary(evaluation, current_rows, policy),
              'matching_total_ms': {'baseline': baseline_time, 'guarded': current_time},
              'methodology': 'Same detector and embeddings for both matchers; face matches are scored against IoU>=0.5 labels. '
                 'Review includes unknown and quality-rejected faces. Capture groups are sampling units for a one-sided 95% error bound. '
                 'Labels, group independence, and representativeness must be checked by the dataset owner. '
                 'The face-level matching bound is not a guarantee of attendance accuracy or spoof resistance.',
              'calibration': {'status': 'insufficient_evidence', 'message': 'No threshold combination meets the requested bound with nonzero correct matches. Add independent labeled capture groups, including unknown people.'}}
    selected = recommend_policy(calibration, policy, target)
    if selected:
        _, recommended, calibration_metrics = selected
        heldout_rows, _ = predict(evaluation, recommended)
        heldout = summarize(evaluation, heldout_rows)
        validated = bool(heldout['known_probes'] and heldout['unknown_probes'] and heldout['correct_identity_matches'] and heldout['error_group_upper_95'] <= target)
        report['calibration'] = {'status': 'validated' if validated else 'heldout_validation_failed',
                                 'recommended_policy': recommended, 'calibration_metrics': calibration_metrics,
                                 'evaluation_metrics': heldout,
                                 'message': 'Profile passed the requested capture-group bound on held-out data.' if validated else 'The recommended profile did not pass independent evaluation; it cannot be activated.'}
    return report


def validate_calibration_report(report):
    """Validate a locally produced report before an administrator activates it."""
    if report.get('schema_version') != 1 or report.get('algorithm_version') != ALGORITHM_VERSION or report.get('model_name') != settings.FACE_MODEL_NAME:
        raise ValueError('Report model or algorithm does not match this installation')
    if not isinstance(report.get('dataset_id'), str) or not 1 <= len(report['dataset_id']) <= 128:
        raise ValueError('Dataset identity is missing')
    calibrated = report.get('calibration', {})
    if calibrated.get('status') != 'validated':
        raise ValueError('This report has not passed held-out validation')
    target = report.get('target_error_group_rate')
    if not isinstance(target, (int, float)) or not np.isfinite(target) or not .001 <= target <= .2:
        raise ValueError('Invalid target error-group rate')
    for split in ('calibration_metrics', 'evaluation_metrics'):
        metrics = calibrated.get(split, {})
        n, errors = metrics.get('capture_groups'), metrics.get('error_groups')
        if not isinstance(n, int) or not isinstance(errors, int) or not 0 <= errors <= n or n < 1:
            raise ValueError('Invalid validation counts')
        if error_upper_bound(errors, n) > target or not all(metrics.get(key, 0) > 0 for key in ('known_probes', 'unknown_probes', 'correct_identity_matches')):
            raise ValueError('Validation evidence does not meet the requested bound')
    proposed = calibrated.get('recommended_policy', {})
    current = settings.recognition_policy()
    for key in ('algorithm_version', 'model_name', 'quality', 'min_supporting_photos', 'consistency_threshold',
                'cross_identity_threshold', 'evidence_dominance_margin', 'detector_strategy'):
        if proposed.get(key) != current[key]:
            raise ValueError('Quality and evidence policy differ; re-run evaluation with this installation')
    match, floor, margin = (proposed.get(key) for key in ('match_threshold', 'uncertain_threshold', 'min_match_margin'))
    if not all(isinstance(v, (int, float)) and np.isfinite(v) for v in (match, floor, margin)) or not 0 <= floor < match <= 1 or not .01 <= margin <= .5:
        raise ValueError('Report thresholds are invalid')
    if not isinstance(report.get('dataset_digest'), str) or len(report['dataset_digest']) != 64:
        raise ValueError('Dataset fingerprint is missing')
    return proposed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--target-error-group-rate', type=float, default=.05)
    args = parser.parse_args()
    if not .001 <= args.target_error_group_rate <= .2:
        parser.error('Target must be between 0.001 and 0.2')
    try:
        policy = settings.recognition_policy()
        manifest, digest = validate_manifest(args.manifest.resolve())
        samples = load_samples(manifest, policy)
        report = make_report(samples, policy, manifest['dataset_id'], digest, args.target_error_group_rate)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False))
        print(f'Report saved to {args.output}: {report["calibration"]["status"]}')
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(2, f'Evaluation could not complete: {error}\n')


if __name__ == '__main__':
    main()
