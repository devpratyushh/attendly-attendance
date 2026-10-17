import React, { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../api';
import { latestBiometricUpdates } from '../offline/biometrics';

const STEPS = [
  { type: 'front', label: 'Look straight at the camera', hint: 'Keep your head upright and your whole face inside the oval.', arrow: '•' },
  { type: 'left', label: 'Turn your face slightly to your left', hint: 'Just 15–30° — keep both eyes visible. Turn gently, without leaning your head.', arrow: '←' },
  { type: 'right', label: 'Turn your face slightly to your right', hint: 'Just 15–30° — keep both eyes visible. Turn gently, without leaning your head.', arrow: '→' },
];

const DEFAULT_GUIDE = { x: 50, y: 49, width: 48, height: 58 };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function UpdateBiometric({ student }) {
  const [step, setStep] = useState(-1); // -1 = intro, 0-2 = capturing, 3 = reviewing
  const [captures, setCaptures] = useState({ front: null, left: null, right: null });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [statusNotice, setStatusNotice] = useState('');
  const [pendingStatus, setPendingStatus] = useState([]);
  const [cameraReady, setCameraReady] = useState(false);
  const [previewUrls, setPreviewUrls] = useState({});
  const [retake, setRetake] = useState(false);
  const [guide, setGuide] = useState(DEFAULT_GUIDE);
  const [guideHint, setGuideHint] = useState('Keep your whole face inside the oval.');
  const cameraRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const canvasRef = useRef(null);
  const captureLock = useRef(false);
  const captureGeneration = useRef(0);
  useEffect(() => {
    const urls = Object.fromEntries(Object.entries(captures).filter(([,blob])=>blob).map(([type,blob])=>[type,URL.createObjectURL(blob)]));
    // eslint-disable-next-line react/set-state-in-effect -- Blob previews have a matching revoke lifecycle.
    setPreviewUrls(urls);
    return () => Object.values(urls).forEach(url=>URL.revokeObjectURL(url));
  }, [captures]);

  // Load existing pending status
  useEffect(() => {
    if (student) {
      api.getBiometricStatus(student.roll_no).then(setPendingStatus).catch(() => {});
    }
  }, [student]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (step >= 0 && step < 3) {
      // eslint-disable-next-line react/set-state-in-effect -- Camera readiness changes when a new stream is requested.
      setCameraReady(false);
      const request = navigator.mediaDevices?.getUserMedia?.({ video: { facingMode:'user', width:{ideal:1280}, height:{ideal:960} }, audio:false });
      if(!request) { setError('Camera capture needs a supported browser on HTTPS or localhost.'); return stopCamera; }
      request.then(stream=>{
        if(cancelled) { stream.getTracks().forEach(track=>track.stop()); return; }
        streamRef.current=stream;
        if(videoRef.current) videoRef.current.srcObject=stream;
      }).catch(()=>{if(!cancelled)setError('Camera unavailable. Allow camera access and try again.');});
    }
    return () => { cancelled=true; captureGeneration.current+=1; stopCamera(); };
  }, [step, stopCamera]);

  useEffect(() => {
    if (step < 0 || step > 2 || !cameraReady) return;
    let cancelled = false;
    let timer;
    let controller;
    const preview = document.createElement('canvas');
    const context = preview.getContext('2d');
    const track = async () => {
      const video = videoRef.current;
      if (cancelled) return;
      if (!video?.videoWidth || video.readyState < 2 || document.hidden) {
        timer = setTimeout(track, 1000);
        return;
      }
      try {
        const ratio = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
        preview.width = Math.round(video.videoWidth * ratio);
        preview.height = Math.round(video.videoHeight * ratio);
        context.drawImage(video, 0, 0, preview.width, preview.height);
        const blob = await new Promise(resolve => preview.toBlob(resolve, 'image/jpeg', .7));
        if (cancelled || !blob) return;
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        let result;
        try { result = await api.getBiometricGuide(student.roll_no, blob, controller.signal); }
        finally { clearTimeout(timeout); }
        if (cancelled) return;
        if (result.face_count === 1 && result.bbox) {
          const { width, height } = cameraRef.current.getBoundingClientRect();
          const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
          const renderedWidth = video.videoWidth * scale;
          const renderedHeight = video.videoHeight * scale;
          const [x1, y1, x2, y2] = result.bbox;
          // Account for object-fit: cover and the mirrored selfie preview.
          const faceWidth = (x2 - x1) * renderedWidth / width * 100;
          const faceHeight = (y2 - y1) * renderedHeight / height * 100;
          const target = {
            x: clamp(100 - (((x1 + x2) / 2 * renderedWidth - (renderedWidth - width) / 2) / width * 100), 42, 58),
            y: clamp(((y1 + y2) / 2 * renderedHeight - (renderedHeight - height) / 2) / height * 100, 41, 57),
            width: clamp(faceWidth * 1.16, 42, 66),
            height: clamp(faceHeight * 1.18, 46, 68),
          };
          setGuide(previous => Object.fromEntries(Object.entries(target).map(([key, value]) => [key, previous[key] + (value - previous[key]) * .35])));
          setGuideHint(faceWidth > 65 || faceHeight > 68 ? 'Move back a little so your whole face fits.' : faceWidth < 25 ? 'Move a little closer to the camera.' : 'Keep steady, then tap the shutter.');
        } else {
          setGuide(DEFAULT_GUIDE);
          setGuideHint(result.face_count > 1 ? 'Only one person should be in the frame.' : 'Bring your face into the oval.');
        }
      } catch {
        if (!cancelled) { setGuide(DEFAULT_GUIDE); setGuideHint('Keep your whole face inside the oval. You can still take your photo.'); }
      }
      if (!cancelled) timer = setTimeout(track, 1000);
    };
    timer = setTimeout(track, 300);
    return () => { cancelled = true; clearTimeout(timer); controller?.abort(); };
  }, [step, cameraReady, student.roll_no]);

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !cameraReady || video.readyState < 2 || !video.videoWidth || !video.videoHeight || captureLock.current) return;
    captureLock.current=true;
    setCameraReady(false);
    const generation=captureGeneration.current;
    const currentStep = STEPS[step];

    const canvas = canvasRef.current || document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    canvas.toBlob(blob => {
      captureLock.current=false;
      if(generation!==captureGeneration.current)return;
      if(!blob) { setCameraReady(true); setError('The camera frame could not be captured. Please try again.'); return; }
      setCaptures(prev => ({ ...prev, [currentStep.type]: blob }));

      if(retake) { stopCamera(); setRetake(false); setStep(3); }
      else if (step < 2) {
        setStep(step + 1);
      } else {
        stopCamera();
        setStep(3); // review
      }
    }, 'image/jpeg', 0.9);
  };

  const handleSubmit = async () => {
    if(STEPS.some(s=>!captures[s.type]?.size)) { setError('Capture all three photos before submitting.'); return; }
    setSubmitting(true);
    setError(null);
    setStatusNotice('');
    try {
      const frontFile = new File([captures.front], 'front.jpg', { type: 'image/jpeg' });
      const leftFile = new File([captures.left], 'left.jpg', { type: 'image/jpeg' });
      const rightFile = new File([captures.right], 'right.jpg', { type: 'image/jpeg' });

      const res = await api.submitBiometricUpdate(student.roll_no, frontFile, leftFile, rightFile);
      setResult(res);
      setStep(-1); setCaptures({front:null,left:null,right:null});
      // Refresh status
      const status = await api.getBiometricStatus(student.roll_no).catch(()=>null);
      if(status) setPendingStatus(status);
      else setStatusNotice('Your photos were submitted successfully. Reopen this page to refresh their review status.');
    } catch (err) {
      setError(err.message);
    }
    setSubmitting(false);
  };

  const handleRetake = () => {
    setCaptures({ front: null, left: null, right: null });
    setStep(0);
    setResult(null);
    setRetake(false);
    setError(null);
  };

  // Filter recent pending
  const latest = latestBiometricUpdates(pendingStatus);
  const recentPending = latest.filter(p => p.status === 'pending');
  const recentApproved = latest.filter(p => p.status === 'approved');
  const recentRejected = latest.filter(p => p.status === 'rejected');

  return (
    <div>
      <h2 className="mb-3">Update Biometric</h2>
      {statusNotice && <div className="notice" role="status">{statusNotice}</div>}

      {/* Status of pending updates */}
      {pendingStatus.length > 0 && (
        <div className="card mb-3">
          <div className="card-title mb-2">Update Status</div>
          {recentPending.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="badge badge-pending">⏳ Pending</span>
              <span className="text-sm">{recentPending.length} photo(s) awaiting review</span>
            </div>
          )}
          {recentApproved.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="badge badge-approved"> Approved</span>
              <span className="text-sm">{recentApproved.length} photo(s) approved</span>
            </div>
          )}
          {recentRejected.length > 0 && (
            <div className="flex items-center gap-2 mb-2">
              <span className="badge badge-rejected"> Rejected</span>
              <span className="text-sm">{recentRejected.length} photo(s) rejected</span>
            </div>
          )}
          {latest.filter(p=>p.validation?.status==='needs_retake' && p.status==='pending').map(p=><p className="form-hint mt-2" key={p.id}>{p.photo_type}: {p.validation.message} Your submission is pending review, not rejected.</p>)}
          {recentRejected.map(p=><p className="form-hint mt-2" key={p.id}>{p.photo_type}: {p.review_note || 'Your teacher requested a replacement photo.'}</p>)}
        </div>
      )}

      {result && (
        <div className="card mb-3" style={{ borderColor: 'var(--success)' }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: '1.5rem' }}></span>
            <div>
              <div style={{ fontWeight: 600 }}>Photos Submitted!</div>
              <div className="text-sm text-muted">
                {result.accepted.length} photos are pending class teacher or admin approval. Your current biometric stays active until approved.
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="card mb-3" style={{ borderColor: 'var(--danger)' }}>
          <div className="flex items-center gap-2">
            <span style={{ fontSize: '1.5rem' }}></span>
            <div className="text-sm" style={{ color: 'var(--danger)' }}>{error}</div>
          </div>
        </div>
      )}

      {step === -1 && (
        <div className="card text-center" style={{ padding: 32 }}>
          <div style={{ fontSize: '3rem', marginBottom: 12 }}></div>
          <h3 className="mb-2">Capture New Photos</h3>
          <p className="text-sm text-muted mb-3" style={{ lineHeight: 1.6 }}>
            Take a front photo and two slight head turns, keeping both eyes visible. Use even lighting and keep your face close to the camera. Each photo must show one clear face.
          </p>
          <button className="btn btn-primary btn-full" onClick={() => setStep(0)}>
            Start Camera
          </button>
        </div>
      )}

      {step >= 0 && step < 3 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="camera-container biometric-camera" ref={cameraRef}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
              onLoadedData={() => setCameraReady(true)}
              style={{ transform: 'scaleX(-1)' }}
            />
            <div className="camera-overlay">
              <div className="camera-guide" role="status" aria-live="polite">
                <span className="biometric-step">Photo {step + 1} of 3 · {STEPS[step].type}</span>
                <strong>{STEPS[step].label}</strong>
                <span>{STEPS[step].hint}</span>
              </div>
              <div className="camera-face-outline" aria-hidden="true" style={{ left: `${guide.x}%`, top: `${guide.y}%`, width: `${guide.width}%`, height: `${guide.height}%` }}>
                {step > 0 && <span className="biometric-turn-arrow">{STEPS[step].arrow}</span>}
              </div>
              <div className="biometric-camera-actions">
              <span className="biometric-camera-hint">{guideHint}</span>
              <button className="camera-capture-btn" aria-label={cameraReady ? `Capture ${STEPS[step].type} photo` : 'Waiting for camera'} disabled={!cameraReady} onClick={capturePhoto} />
              </div>
            </div>
          </div>
          <div className="text-xs text-muted text-center" style={{ padding: 8 }}>
            Step {step + 1} of 3
            <button className="text-button" style={{marginLeft:16}} onClick={()=>{ stopCamera(); setStep(retake?3:-1); setRetake(false); }}>Cancel capture</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <div className="card-title mb-3">Review Photos</div>
          <div className="photo-grid">
            {STEPS.map(s => (
              <div key={s.type} style={{ textAlign: 'center' }}>
                {captures[s.type] && (
                  <img
                    src={previewUrls[s.type]}
                    alt={s.type}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 8 }}
                  />
                )}
                <div className="text-xs text-muted mt-2">{s.type}</div>
                <button className="text-button mt-2" disabled={submitting} onClick={()=>{setRetake(true);setError(null);setStep(STEPS.findIndex(item=>item.type===s.type));}}>Retake {s.type}</button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={handleRetake}>
              Retake
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
}
