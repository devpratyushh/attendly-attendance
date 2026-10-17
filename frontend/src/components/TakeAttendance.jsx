import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import Dialog from './Dialog';
import CaptureAttendance from './CaptureAttendance';
import OfflineQueue from './OfflineQueue';
import EvidencePhoto from './EvidencePhoto';
import { attendanceStatus, confirmationRecords, reviewReason, reviewRemaining, photoEvidence } from '../offline/review';
import { offlineModules, queueChanged, triggerSync } from '../offline/client';

const explanations = {
  needs_more_independent_photos: 'Upload a different classroom view to corroborate this identity.',
  not_detected: 'Not detected. Review this student; a missing face does not prove absence.',
  ambiguous_identity: 'The identity is not clear enough to accept automatically. Check the student or capture a clearer view.',
  conflicting_identity_evidence: 'Photos contain competing identity suggestions. Review manually.',
  inconsistent_face_embeddings: 'The matching faces disagree across photos. Review manually.',
  enrollment_required: 'Enrollment photos are needed for recognition.',
  biometric_consent_required: 'Biometric consent is required before recognition.',
  face_too_small: 'Face too small — move closer or use a clearer image.',
  face_blurred: 'Blurred face — hold the camera steady and retake.',
  face_underexposed: 'Face too dark — improve the lighting.',
  face_overexposed: 'Face overexposed — reduce glare or direct light.',
  extreme_face_angle: 'Extreme angle — take another view facing the class.',
  landmarks_unreliable_or_obstructed: 'Facial landmarks are unclear or possibly obstructed.',
  low_detection_score: 'Face detection is uncertain — take another photo.',
  face_cut_off: 'Face cut off by the image edge.',
  face_pose_unavailable: 'Face pose could not be assessed.',
};

export default function TakeAttendance({ assignmentId, initialSession, owner, assignmentLabel, initialJob, onOpenJob, onResetRequest, onConfirmed }) {
  const [session, setSession] = useState(initialSession || null);
  const [periods, setPeriods] = useState(initialSession?.periods || 1);
  const validPeriods = Number.isInteger(periods) && periods >= 1 && periods <= 4;
  const [analysis, setAnalysis] = useState(null);
  const [photos, setPhotos] = useState(initialSession?.photos || []);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (confirmed && session?.session_id) onConfirmed?.(session.session_id);
  }, [confirmed, session?.session_id, onConfirmed]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(null);
  const [mode, setMode] = useState('single');
  const [menuOpen, setMenuOpen] = useState(false);
  const [captureJob, setCaptureJob] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const photoUrls = useRef([]);
  const loadLocal = async job => {
    const { store } = await offlineModules();
    setActiveJob(job); setSession(job.serverSession || null); setPeriods(job.confirmationPeriods ?? job.serverSession?.periods ?? job.periods ?? 1); setConfirmed(job.state === 'completed');
    const saved = await store.readPrivate(owner, `analysis:${job.id}`);
    setAnalysis(saved || null);
    const review = (job.serverSession ? await store.readPrivate(owner, `review-session:${job.serverSession.session_id}`) : null) || await store.readPrivate(owner, `review:${job.id}`);
    setOverrides(review || {});
    const frames = (await store.all('frames')).filter(frame => frame.jobId === job.id);
    photoUrls.current.forEach(url => URL.revokeObjectURL(url)); photoUrls.current = [];
    const values = [];
    for (const frame of frames.sort((a, b) => a.slot - b.slot)) { const url = URL.createObjectURL(await store.readFrame(owner, frame.id)); photoUrls.current.push(url); values.push({ id: frame.id, url, server_photo_id: job.uploaded?.[frame.slot], client_photo_id: frame.id.replace(':', '_'), content_hash: frame.contentHash }); }
    setPhotos(values);
  };
  useEffect(() => {
    if (initialJob) offlineModules().then(async ({ store }) => { const job = await store.get('jobs', initialJob.id); if (job) { await loadLocal(job); if (job.state === 'capturing') setCaptureJob(job); } }).catch(e => setError(e.message));
    return () => { photoUrls.current.forEach(url => URL.revokeObjectURL(url)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- A selected local job is loaded only when its stable ID changes.
  }, [initialJob?.id, owner]);
  useEffect(() => {
    if (!activeJob?.id) return;
    const jobId = activeJob.id;
    let alive = true;
    const refresh = async () => {
      const { store } = await offlineModules(); const job = await store.get('jobs', jobId);
      if (!alive || !job) return;
      setActiveJob(job); if (job.serverSession) setSession(job.serverSession);
      if (job.state === 'completed') { setConfirmed(true); setPhotos([]); setNotice('Attendance was committed on the server. Private local images have been deleted.'); photoUrls.current.forEach(url => URL.revokeObjectURL(url)); }
      else if (job.state === 'needs_review') { const value = await store.readPrivate(owner, `analysis:${job.id}`); if (alive && value) setAnalysis(value); }
    };
    window.addEventListener('attendance-queue', refresh);
    return () => { alive = false; window.removeEventListener('attendance-queue', refresh); };
  }, [activeJob?.id, owner]);
  useEffect(() => {
    if (!initialSession) return;
    let active = true;
    Promise.all([api.getSessionAnalysis(initialSession.session_id), offlineModules().then(({store})=>store.readPrivate(owner, `review-session:${initialSession.session_id}`))]).then(([value,review]) => { if (active) {setAnalysis(value);setOverrides(review || {});} }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [initialSession, owner]);
  const create = async (captureMode = mode, serverSession = null) => {
    setBusy(true); setError(''); setMenuOpen(false);
    try {
      if (!globalThis.indexedDB || !crypto.subtle) throw new Error('Private offline capture needs HTTPS or localhost and browser storage.');
      const { store } = await offlineModules();
      const job = await store.newJob(owner, { assignmentId, periods: serverSession?.periods || periods, mode: captureMode,
        label: assignmentLabel, ...(serverSession ? { serverSession } : {}) });
      setCaptureJob(job); queueChanged();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const rows = analysis?.results || [];
  const effective = row => attendanceStatus(row, overrides);
  const present = rows.filter(row => effective(row) === 'present').length;
  const absent = rows.filter(row => effective(row) === 'absent').length;
  const unresolved = rows.length - present - absent;
  const reviewPhotos = [...(analysis?.photos || []).map(photo => photos.find(local => photoEvidence(local, analysis)?.id === photo.id) || photo),
    ...photos.filter(photo => !photoEvidence(photo, analysis))];
  const saveReview = async next => {
    setReviewBusy(true); setError('');
    try {
      const { store } = await offlineModules();
      await store.savePrivate(owner, session ? `review-session:${session.session_id}` : `review:${activeJob.id}`, next);
      setOverrides(next);
      return true;
    } catch (e) { setError(`Could not save your review: ${e.message}`); return false; }
    finally { setReviewBusy(false); }
  };
  const quickReview = (row, status) => saveReview({ ...overrides, [row.student_id]: { status, reason: reviewReason(status) } });
  const confirm = async () => {
    if (!validPeriods) { setError('Choose between 1 and 4 periods before confirming attendance.'); return; }
    if (unresolved) { setError('Review every unresolved student before confirming.'); return; }
    setBusy(true); setError('');
    try {
      const records = confirmationRecords(rows, overrides);
      if (activeJob) {
        const { store } = await offlineModules();
        await store.savePrivate(owner, `confirmation:${activeJob.id}`, records);
        await store.update(activeJob.id, { confirmationPending: true, confirmationPeriods: periods, state: navigator.onLine ? 'waiting_sync' : 'saved_offline', nextAttempt: 0 });
        setNotice('Review saved on this device. Attendance is not final until the server confirms it.'); queueChanged();
        await triggerSync(owner, true);
        const latest = await store.get('jobs', activeJob.id);
        if (latest.state === 'completed') setConfirmed(true);
      } else {
        await api.confirmSession(session.session_id, records, periods);
        const receipt = await api.getSession(session.session_id);
        if (receipt.status !== 'confirmed') throw new Error('The server has not committed attendance. Please retry.');
        setConfirmed(true);
        const {store}=await offlineModules();
        await store.savePrivate(owner, `review-session:${session.session_id}`, null).catch(()=>{});
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const reset = () => { setSession(null); setActiveJob(null); setAnalysis(null); setPhotos([]); setOverrides({}); setConfirmed(false); setError(''); setNotice(''); onResetRequest?.(); };
  if (session && !analysis && !confirmed) return <div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="card" aria-busy={busy}><h2>Preparing attendance review</h2><p className="form-hint mt-3">Loading saved face detections. Student statuses will appear when processing results are available.</p><button className="btn btn-secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { if (activeJob) { await triggerSync(owner, true); const { store } = await offlineModules(); const saved = await store.readPrivate(owner, `analysis:${activeJob.id}`); if (saved) setAnalysis(saved); } else setAnalysis(await api.getSessionAnalysis(session.session_id)); }
      catch (e) { setError(e.message); } finally { setBusy(false); }
    }}>{busy ? 'Loading…' : 'Retry loading results'}</button><button className="text-button ml-3" onClick={reset}>Back to capture</button></div>
  </div>;
  return <div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!validPeriods && !confirmed && <div className="notice error" role="alert">This saved session exceeds the 4-period limit. Choose 1–4 periods before confirming.</div>}
    {notice && <div className="notice success" role="status">{notice}</div>}
    {activeJob && !session ? <div className="card"><h2>Capture saved on this device</h2><p className="form-hint mt-3">{navigator.onLine ? 'Waiting for upload and processing. Attendance has not been finalized.' : 'Saved offline. Your photos will upload when connectivity returns.'}</p><button className="btn btn-secondary" onClick={reset}>Back to capture</button></div> : !session ? <div className="card text-center"><div className="attendance-mark"><Icon name="camera" size={30}/></div><h2 className="mb-3">Take attendance</h2><p className="form-hint">One clear classroom photo is enough for confident matches. Unclear identities and missing detections need your review.</p><label className="field" style={{ textAlign: 'left' }}>Number of periods (maximum 4)<select value={periods} onChange={e => setPeriods(Number(e.target.value))}>{!validPeriods && <option value={periods} disabled>Choose 1–4 periods</option>}{Array.from({ length: 4 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} period{n > 1 ? 's' : ''}</option>)}</select></label><div className="split-button"><button className="btn btn-primary" disabled={busy} onClick={() => create()}><Icon name="camera" size={18}/>{busy ? 'Preparing…' : 'Take Attendance'}</button><button className="btn btn-primary split-arrow" aria-label="Choose capture mode" aria-expanded={menuOpen} disabled={busy} onClick={() => setMenuOpen(!menuOpen)}>⌄</button>{menuOpen && <div className="capture-mode-menu" role="menu">{[['single', 'Single Shot', 'One clear classroom photo'], ['panorama', '3-Shot Panorama', 'Left, center, and right views']].map(([value, label, text]) => <button key={value} role="menuitemradio" aria-checked={mode === value} onClick={() => { setMode(value); setMenuOpen(false); }}><span>{label}{mode === value ? ' ✓' : ''}</span><small>{text}</small></button>)}</div>}</div><p className="text-xs text-muted mt-3">{mode === 'single' ? 'Single Shot' : '3-Shot Panorama'} · private capture · offline ready</p></div> : confirmed ? <div className="card text-center"><div className="attendance-mark"><Icon name="check" size={28}/></div><h2>Attendance confirmed</h2><p className="form-hint mt-2">{present} present · {absent} absent · {periods} periods</p><button className="btn btn-primary" onClick={reset}>Start another session</button></div> : <>
      <div className="card mb-3"><div className="flex justify-between items-center"><strong className="text-sm">{session.session_id}</strong><span className="badge badge-pending">In review</span></div><p className="text-muted text-xs mt-2">{analysis?.photo_count || 0} classroom view{analysis?.photo_count === 1 ? '' : 's'} analyzed · each student counts once</p><label className="field mt-3">Number of periods (maximum 4)<select value={periods} disabled={busy || activeJob?.confirmationPending} onChange={e => setPeriods(Number(e.target.value))}>{!validPeriods && <option value={periods} disabled>Choose 1–4 periods</option>}{Array.from({ length: 4 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} period{n > 1 ? 's' : ''}</option>)}</select></label><p className="text-muted text-xs mt-2">Session evidence is saved on the server. You can resume it from Session history.</p></div>
      <button className="btn btn-secondary btn-full mt-3" disabled={busy || activeJob?.confirmationPending} onClick={() => create('single', session)}><Icon name="camera" size={18}/>Capture another view</button>
      {analysis?.retake_recommended && <div className="notice mt-3">Some faces are missing or unclear. Take a closer, steady photo with even lighting and visible faces.</div>}
      {analysis?.unprocessed_photo_count > 0 && <div className="notice mt-3">{analysis.unprocessed_photo_count} older photos have no quality analysis and cannot support automatic attendance. Upload new views or review students manually.</div>}
      {analysis?.quality_rejections?.length > 0 && <details className="card mt-3"><summary className="text-sm">Detection notes ({analysis.quality_rejections.length})</summary><ul className="quality-list">{analysis.quality_rejections.map((item, i) => <li key={i}>Photo {item.class_photo_id}, face {item.face_index + 1}: {item.reasons.map(code => explanations[code] || code.replaceAll('_', ' ')).join(' ')}</li>)}</ul><p className="text-muted text-xs mt-2">Unclear faces do not undo a clear match in another view. Strong competing identity evidence still needs review.</p></details>}
      {analysis?.unknown_face_count > 0 && <div className="notice mt-3">{analysis.unknown_face_count} faces remain unknown. They are not assigned to a student automatically.</div>}
      {reviewPhotos.length > 0 && <details className="card mt-3" open><summary className="text-sm">Classroom photos ({reviewPhotos.length})</summary><label className="face-toggle"><input type="checkbox" checked={showBoxes} onChange={e => setShowBoxes(e.target.checked)}/>Show detected faces</label><div className="evidence-photo-grid">{reviewPhotos.map((photo, i) => <EvidencePhoto key={photo.id} photo={photo} evidence={photoEvidence(photo, analysis)} index={i} showBoxes={showBoxes}/>)}</div></details>}
      <div className="summary-bar"><div className="summary-item"><div className="summary-value" style={{ color: 'var(--success)' }}>{present}</div><div className="summary-label">Present</div></div><div className="summary-item"><div className="summary-value" style={{ color: 'var(--danger)' }}>{absent}</div><div className="summary-label">Reviewed absent</div></div><div className="summary-item"><div className="summary-value" style={{ color: 'var(--warning)' }}>{unresolved}</div><div className="summary-label">Needs review</div></div></div>
      <div className="review-toolbar card"><div><h3>{unresolved ? `${unresolved} student${unresolved === 1 ? '' : 's'} to check` : 'Ready to confirm'}</h3><p className="text-xs text-muted mt-2">{present + absent} of {rows.length} resolved. Confident matches are already marked present.</p></div>{unresolved > 0 && <button className="btn btn-secondary btn-sm" disabled={busy || reviewBusy || !analysis || activeJob?.confirmationPending} onClick={() => setManual({ batch: true, status: 'absent' })}>Review remaining as absent</button>}</div>
      {rows.some(row => effective(row) !== 'unresolved') && <button className="text-button resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved(!showResolved)}>{showResolved ? 'Hide' : 'Show'} {present + absent} resolved student{present + absent === 1 ? '' : 's'}</button>}
      {rows.filter(row => showResolved || effective(row) === 'unresolved').map(row => <div className="result-row" key={row.student_id}><div className="result-row-header"><div><strong className="student-name">{row.name}</strong><div className="student-roll">{row.roll_no}</div></div><span className={`badge badge-${effective(row) === 'unresolved' ? 'uncertain' : effective(row)}`}>{effective(row) === 'unresolved' ? 'Needs review' : effective(row)}{overrides[row.student_id] ? ' · manual' : ''}</span></div>
        <p className="text-xs text-muted">Matched in {row.support_count || 0} capture{row.support_count === 1 ? '' : 's'} from this session{row.confidence != null ? ` · match score ${row.confidence.toFixed(3)}` : ''}</p>
        {!overrides[row.student_id] && row.status !== 'matched' && <p className="text-xs text-muted mt-2">{row.reasons.map(code => explanations[code] || code.replaceAll('_', ' ')).join(' ')}</p>}
        {overrides[row.student_id] && <p className="text-xs text-muted mt-2">Review reason: {overrides[row.student_id].reason}</p>}
        {(row.enrolled_photo_url || row.crop_url) && <div className="result-photos">{row.enrolled_photo_url && <img src={row.enrolled_photo_url} alt={`Enrolled face for ${row.name}`}/>} {row.crop_url && <img src={row.crop_url} alt={`Detected candidate for ${row.name}`}/>}</div>}
        <div className="result-actions"><button className="btn btn-sm btn-secondary" disabled={busy || reviewBusy || !analysis || activeJob?.confirmationPending} onClick={() => quickReview(row, 'present')}>Mark present</button><button className="btn btn-sm btn-secondary" disabled={busy || reviewBusy || !analysis || activeJob?.confirmationPending} onClick={() => quickReview(row, 'absent')}>Mark absent</button><button className="text-button" disabled={busy || reviewBusy || !analysis || activeJob?.confirmationPending} onClick={() => setManual({ row, status: overrides[row.student_id]?.status || 'present' })}>Add note</button>{overrides[row.student_id] && <button className="text-button" disabled={busy || reviewBusy || activeJob?.confirmationPending} onClick={() => { const next = { ...overrides }; delete next[row.student_id]; saveReview(next); }}>Undo review</button>}</div>
      </div>)}
      <button className="btn btn-primary btn-full mt-3" disabled={!validPeriods || busy || reviewBusy || unresolved > 0 || !analysis || !rows.length || activeJob?.confirmationPending} onClick={confirm}>{busy ? 'Processing…' : unresolved ? `Review ${unresolved} remaining student${unresolved > 1 ? 's' : ''}` : `Confirm attendance · ${present} present, ${absent} absent`}</button>
    </>}
    <OfflineQueue owner={owner} onSelect={job => { if (onOpenJob) onOpenJob(job); else loadLocal(job).catch(e => setError(e.message)); }} onResumeCapture={job => { if (onOpenJob) onOpenJob(job); else setCaptureJob(job); }}/>
    {captureJob && <CaptureAttendance owner={owner} job={captureJob} onClose={() => { setCaptureJob(null); queueChanged(); }} onReady={job => { setCaptureJob(null); if(onOpenJob) onOpenJob(job); else loadLocal(job).catch(e => setError(e.message)); }}/>}
    {manual && <Dialog title={manual.batch ? `Mark ${unresolved} remaining student${unresolved === 1 ? '' : 's'} absent?` : `Review ${manual.row.name}`} description={manual.batch ? 'Only continue after checking these students are absent. Confident matches and previous decisions stay as they are. This is recorded as your manual review.' : 'Your observation is recorded with attendance. A note is optional.'} onClose={() => { if (!reviewBusy) setManual(null); }}><form onSubmit={async e => { e.preventDefault(); const data = new FormData(e.currentTarget); const status = manual.batch ? 'absent' : data.get('status'); const reason = data.get('reason').trim() || reviewReason(status); const next = manual.batch ? reviewRemaining(rows, overrides, reason) : { ...overrides, [manual.row.student_id]: { status, reason } }; if (await saveReview(next)) setManual(null); }}>
      {manual.batch ? <><ul className="bulk-roster">{rows.filter(row => effective(row) === 'unresolved').map(row => <li key={row.student_id}>{row.name} <span>{row.roll_no}</span></li>)}</ul><label className="checkbox-field"><input type="checkbox" required/>I checked the roster and these students are absent.</label></> : <label className="field">Status<select name="status" defaultValue={manual.status}><option value="present">Present</option><option value="absent">Absent</option></select></label>}
      <label className="field">Note (optional)<input name="reason" maxLength={200} defaultValue={manual.row ? overrides[manual.row.student_id]?.reason || '' : ''} placeholder="Add context if needed"/></label><button disabled={reviewBusy} className="btn btn-primary btn-full">{reviewBusy ? 'Saving…' : manual.batch ? `Mark ${unresolved} absent` : 'Save review'}</button></form></Dialog>}
  </div>;
}
