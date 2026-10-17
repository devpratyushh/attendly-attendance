import copy
import json
import unittest
from unittest.mock import patch
import numpy as np
import cv2
import settings
from recognition import assign_scores, aggregate_evidence, match_faces
from image_quality import assess_face
from detection_geometry import detection_windows, merge_detections
from evaluate_recognition import align_labels, error_upper_bound, make_report, validate_calibration_report


class RecognitionTests(unittest.TestCase):
    def test_reviewer_can_override_enrollment_quality(self):
        from face_engine import extract_single_face_embedding
        face = {'embedding': np.ones(512, dtype=np.float32),
                'quality': {'accepted': False, 'reasons': ['face_blurred', 'extreme_face_angle']}}
        with patch('face_engine.detect_faces', return_value=([face], None)):
            self.assertIsNone(extract_single_face_embedding('preview.jpg')[0])
            embedding, error = extract_single_face_embedding('preview.jpg', allow_quality_override=True)
            self.assertIsNone(error)
            self.assertEqual(embedding.shape, (512,))
        for faces in ([], [face, face], [dict(face, embedding=np.array([np.nan]))]):
            with patch('face_engine.detect_faces', return_value=(faces, None)):
                embedding, error = extract_single_face_embedding('preview.jpg', allow_quality_override=True)
                self.assertIsNone(embedding)
                self.assertTrue(error)

    def setUp(self):
        self.policy = settings.recognition_policy()
        self.policy.update(match_threshold=.45, uncertain_threshold=.35, min_match_margin=.08, min_supporting_photos=1)
        self.quality = {'accepted': True, 'reasons': []}

    def face(self, scores, ids=(1, 2)):
        row = assign_scores([scores], list(ids), [self.quality], self.policy)[0]
        row['embedding'] = [1., 0.]
        return row

    def photo(self, i, face, fingerprint=None):
        return {'id': i, 'content_hash': str(i), 'fingerprint': fingerprint, 'results': [face]}

    def test_single_shot_new_class_is_sufficient(self):
        result = aggregate_evidence([self.photo(1, self.face([.859, .1]))], [1, 2], self.policy)
        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][0]['support_count'], 1)
        self.assertEqual(result['results'][1]['status'], 'unresolved')

    def test_close_identity_is_reviewed(self):
        row = self.face([.46, .45])
        self.assertEqual(row['status'], 'uncertain')
        self.assertIn('ambiguous_identity', row['reasons'])

    def test_global_assignment_and_unknown_option(self):
        rows = assign_scores([[.85, .80], [.83, .36], [.2, .1]], [1, 2], [self.quality] * 3, self.policy)
        self.assertEqual([r['student_id'] for r in rows], [2, 1, None])
        self.assertEqual(rows[0]['status'], 'uncertain')
        self.assertEqual(rows[2]['status'], 'not_found')

    def test_quality_and_invalid_vectors_cannot_match(self):
        row = assign_scores([[.99]], [1], [{'accepted': False, 'reasons': ['face_blurred']}], self.policy)[0]
        self.assertIsNone(row['student_id'])
        bad = match_faces([{'embedding': [float('nan'), 1], 'quality': self.quality}], {1: [[1, 0]]}, self.policy)[0]
        self.assertEqual(bad['status'], 'quality_rejected')
        self.assertEqual(match_faces([{'embedding': [1, 0], 'quality': self.quality}], {}, self.policy)[0]['status'], 'not_found')

    def test_panorama_overlap_and_weak_suggestions_do_not_veto_clear_match(self):
        photos = [self.photo(1, self.face([.9, .1])), self.photo(2, self.face([.88, .1]))]
        result = aggregate_evidence(photos, [1, 2], self.policy)
        self.assertEqual(sum(r['status'] == 'matched' for r in result['results']), 1)
        ambiguous = self.face([.46, .45])
        result = aggregate_evidence(photos + [self.photo(3, ambiguous)], [1, 2], self.policy)
        self.assertEqual(result['results'][0]['status'], 'matched')
        self.assertEqual(result['results'][1]['status'], 'unresolved')
        self.assertIn(3, result['results'][0]['ambiguous_photo_ids'])
        strong_ambiguity = self.face([.87, .86])
        result = aggregate_evidence(photos + [self.photo(4, strong_ambiguity)], [1, 2], self.policy)
        self.assertEqual(result['results'][0]['status'], 'unresolved')
        self.assertIn('conflicting_identity_evidence', result['results'][0]['reasons'])

    def test_confident_identity_switch_and_same_photo_collision_require_review(self):
        a, b = self.face([.9, .1]), self.face([.1, .9])
        result = aggregate_evidence([self.photo(1, a), self.photo(2, b)], [1, 2], self.policy)
        self.assertTrue(all(r['status'] == 'unresolved' for r in result['results']))
        collisions = assign_scores([[.9,.1],[.8,.1]], [1,2], [self.quality]*2, self.policy)
        for f in collisions: f['embedding'] = [1,0]
        result = aggregate_evidence([{'id':1,'content_hash':'one','results':collisions}], [1,2], self.policy)
        self.assertEqual(result['results'][0]['status'], 'unresolved')

    def test_large_image_detection_windows_overlap_and_merge_face_boxes(self):
        self.assertEqual(detection_windows(640,480), [])
        windows = detection_windows(2560,1440)
        self.assertEqual(len(windows), 4)
        self.assertGreater(windows[0][2], windows[-1][0])
        candidates = [(np.array([100,100,200,200,.8]),None), (np.array([102,99,201,200,.9]),None),
                      (np.array([220,100,320,200,.85]),None), (np.array([0,0,0,0,.99]),None)]
        merged = merge_detections(candidates)
        self.assertEqual(len(merged), 2)
        self.assertAlmostEqual(merged[0][0][4], .9)

    def test_tiled_detector_translates_landmarks_and_embeds_each_face_once(self):
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from unittest.mock import patch
        from face_engine import detect_faces
        class Detector:
            calls = 0
            def detect(self, image, input_size):
                self.calls += 1
                if self.calls not in (1, 2, 4):
                    return np.empty((0,5)), np.empty((0,5,2))
                x = 100 if self.calls == 4 else 300
                return np.array([[x,200,x+200,450,.9 if self.calls == 2 else .8]]), np.array([[[x+50,260],[x+150,260],[x+100,320],[x+60,390],[x+140,390]]])
        class Recognizer:
            calls = 0
            def get(self, image, face):
                self.calls += 1
                face.embedding = np.array([1.,0.]); face.pose = np.zeros(3)
        detector, recognizer = Detector(), Recognizer()
        app = SimpleNamespace(det_model=detector, models={'detection':detector, 'recognition':recognizer})
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder)/'class.jpg')
            cv2.imwrite(path, np.random.default_rng(5).integers(40,210,(1440,2560,3), dtype=np.uint8))
            with patch('face_engine.get_face_app', return_value=app):
                faces, error = detect_faces(path, self.policy)
        self.assertIsNone(error)
        self.assertEqual(detector.calls, 5)
        self.assertEqual(recognizer.calls, 2)
        self.assertEqual([f['bbox'][0] for f in faces], [300,1060])
        self.assertTrue(all(f['quality']['accepted'] for f in faces))

    def test_rejected_candidate_explains_quality_instead_of_claiming_missing(self):
        row = assign_scores([[.86,.1]], [1,2], [{'accepted':False,'reasons':['face_blurred']}], self.policy)[0]
        row['embedding'] = [1,0]
        result = aggregate_evidence([self.photo(1,row)], [1,2], self.policy)['results'][0]
        self.assertEqual(result['status'], 'unresolved')
        self.assertIn('face_blurred', result['reasons'])
        self.assertNotIn('not_detected', result['reasons'])

    def test_duplicates_are_not_independent_votes(self):
        policy = dict(self.policy, min_supporting_photos=2)
        photos = [self.photo(1, self.face([.9,.1]), '0000000000000000'), self.photo(2, self.face([.9,.1]), '0000000000000001')]
        result = aggregate_evidence(photos, [1], policy)
        self.assertEqual(result['results'][0]['support_count'], 1)
        self.assertEqual(result['results'][0]['status'], 'unresolved')

    def test_inconsistent_embeddings_are_not_erased_by_max_score(self):
        a, b = self.face([.99, .1]), self.face([.86, .1]); b['embedding'] = [0, 1]
        result = aggregate_evidence([self.photo(1, a), self.photo(2, b)], [1], self.policy)
        self.assertIn('inconsistent_face_embeddings', result['results'][0]['reasons'])

    def test_quality_metrics_reject_bad_images_and_serialize(self):
        landmarks = [[70,70],[120,70],[95,95],[75,120],[115,120]]
        noise = np.random.default_rng(8).integers(40, 210, (200, 200, 3), dtype=np.uint8)
        good = assess_face(noise, [40,40,150,160], .99, landmarks, [0,0,0], self.policy['quality'])
        self.assertTrue(good['accepted'])
        json.dumps(good, allow_nan=False)
        dark = assess_face(np.zeros_like(noise), [40,40,150,160], .99, landmarks, [0,0,0], self.policy['quality'])
        self.assertIn('face_blurred', dark['reasons']); self.assertIn('face_underexposed', dark['reasons'])
        obstructed = assess_face(noise, [40,40,150,160], .4, None, [0,70,0], self.policy['quality'])
        self.assertIn('landmarks_unreliable_or_obstructed', obstructed['reasons'])
        self.assertIn('extreme_face_angle', obstructed['reasons'])
        self.assertFalse(obstructed['occlusion_assessed'])

    def test_label_alignment_and_small_dataset_rejection(self):
        truth, matched = align_labels([{'bbox':[0,0,100,100]},{'bbox':[200,0,300,100]}], [{'bbox':[0,0,100,100],'student_id':'A'}], ['A'])
        self.assertEqual(truth, ['A', None]); self.assertEqual(matched, {0})
        self.assertGreater(error_upper_bound(0, 2), .05)

    def test_calibration_uses_independent_holdout_and_validates(self):
        samples = []
        for split in ('calibration', 'evaluation'):
            for i in range(60):
                samples.append(dict(split=split, scores=np.array([[.95],[.1]]), ids=['A'],
                    faces=[{'embedding':[1,0], 'quality':self.quality},{'embedding':[0,1], 'quality':self.quality}],
                    truth=['A',None], labels=[{},{}], matched_labels={0,1}, detection_ms=1,
                    group=f'{split}-{i}', session_id=f'{split}-{i}', conditions=['fixture'],
                    id=f'{split}-{i}', content_hash=f'{split}-{i}', fingerprint=None))
        report = make_report(samples, self.policy, 'synthetic-logic-test-only', 'a'*64, .05)
        self.assertEqual(report['calibration']['status'], 'validated')
        validate_calibration_report(report)
        changed = copy.deepcopy(report); changed['calibration']['evaluation_metrics']['capture_groups'] = 2
        with self.assertRaises(ValueError): validate_calibration_report(changed)
        changed = copy.deepcopy(report); changed['model_name'] = 'other'
        with self.assertRaises(ValueError): validate_calibration_report(changed)


if __name__ == '__main__':
    unittest.main(verbosity=2)
