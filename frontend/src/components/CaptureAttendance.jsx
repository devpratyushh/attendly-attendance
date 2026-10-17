import { useEffect, useRef, useState } from 'react';
import Dialog from './Dialog';
import Icon from './Icon';
import { compressCapture } from '../offline/compress';
import { offlineModules, queueChanged, triggerSync } from '../offline/client';

const PANORAMA_SLOTS = ['Left', 'Center', 'Right'];
const SINGLE_SLOT = ['Classroom'];

export default function CaptureAttendance({ owner, job, onClose, onReady }) {
  const slots = job.mode === 'panorama' ? PANORAMA_SLOTS : SINGLE_SLOT;
  const [slot, setSlot] = useState(0);
  const [previews, setPreviews] = useState({});
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const video = useRef(null); const files = useRef(null);
  const urls = useRef([]);
  useEffect(() => {
    let active = true;
    const allocatedUrls = urls.current;
    offlineModules().then(async ({ store }) => {
      const frames = (await store.all('frames')).filter(frame => frame.jobId === job.id);
      const values = {};
      for (const frame of frames) { const blob = await store.readFrame(owner, frame.id); if (!active) return; const url = URL.createObjectURL(blob); allocatedUrls.push(url); values[frame.slot] = url; }
      if (active) { setPreviews(values); setSlot(slots.findIndex((_, i) => !values[i]) < 0 ? 0 : slots.findIndex((_, i) => !values[i])); if (frames.length === slots.length) setPreviewing(true); }
    }).catch(e => setError(e.message));
    return () => { active = false; allocatedUrls.forEach(url => URL.revokeObjectURL(url)); };
  }, [job.id, owner, slots]);
  useEffect(() => {
    if (previewing) return;
    let cancelled = false; let stream;
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera capture requires HTTPS or localhost. You can import an existing image.');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play(); setCameraReady(true); }
      } catch (e) { if (!cancelled) setCameraError(e.name === 'NotAllowedError' ? 'Camera access was declined. Enable it in browser settings or import a photo.' : e.message); }
    };
    start();
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); };
  }, [previewing]);
  const save = async source => {
    setBusy(true); setError('');
    try {
      const blob = await compressCapture(source);
      const { store } = await offlineModules();
      await store.saveFrame(owner, job.id, slot, blob);
      if (previews[slot]) URL.revokeObjectURL(previews[slot]);
      const url = URL.createObjectURL(blob); urls.current.push(url);
      const next = { ...previews, [slot]: url }; setPreviews(next); queueChanged();
      const remaining = slots.findIndex((_, i) => !next[i]);
      if (remaining < 0) setPreviewing(true); else setSlot(remaining);
    } catch (e) { setError(e.message || 'Photo could not be saved to this device. Free storage and retry.'); }
    finally { setBusy(false); }
  };
  const ready = async () => {
    setBusy(true); setError('');
    try {
      const { store } = await offlineModules();
      const saved = await store.get('jobs', job.id);
      if (saved.frameIds.length !== slots.length) throw new Error('Capture every required view before processing.');
      const value = await store.markReady(owner, job.id);
      try { await navigator.storage?.persist?.(); } catch { /* Storage durability is shown in the queue. */ }
      queueChanged(); onReady(value); triggerSync(owner).catch(() => {});
    } catch (e) { setError(e.message); setBusy(false); }
  };
  return <Dialog title={job.mode === 'panorama' ? '3-Shot Panorama' : 'Single Shot'} description={previewing ? 'Check your photos before processing. They are saved privately on this device.' : `${slot + 1}/${slots.length} · ${slots[slot]} view`} onClose={onClose}>
    <div className="capture-progress">{slots.map((label, i) => <span key={label} className={`${i === slot && !previewing ? 'active' : ''} ${previews[i] ? 'done' : ''}`}><span>{previews[i] ? <Icon name="check" size={13}/> : i + 1}</span>{label}</span>)}</div>
    {previewing ? <div className="capture-previews">{slots.map((label, i) => <figure key={label}><img src={previews[i]} alt={`${label} classroom view`}/><figcaption>{label}<button className="text-button" disabled={busy} onClick={() => { setSlot(i); setCameraReady(false); setPreviewing(false); }}>Retake</button></figcaption></figure>)}</div> : <>
      <div className="camera-stage"><video ref={video} playsInline muted autoPlay/><div className="camera-instructions"><span>{slots[slot]} view</span>{job.mode === 'panorama' ? <p>{['Start with the left side of the classroom.', 'Pan right. Include about a quarter of the previous view.', 'Pan right again, overlapping the center view.'][slot]}</p> : <p>Keep faces visible, hold steady, and avoid bright light behind students.</p>}</div>{job.mode === 'panorama' && slot > 0 && <div className="overlap-guide">Overlap previous view</div>}</div>
      {cameraError && <div className="notice mt-3">{cameraError}</div>}
      <button className="btn btn-primary btn-full mt-3" disabled={busy || !cameraReady} onClick={() => save(video.current)}><Icon name="camera" size={18}/>{busy ? 'Saving privately…' : `Capture ${slots[slot].toLowerCase()} view`}</button>
      <button className="btn btn-secondary btn-full mt-2" disabled={busy} onClick={() => files.current.click()}>Import an existing photo</button><input ref={files} type="file" accept="image/*" hidden onChange={e => { if (e.target.files[0]) save(e.target.files[0]); e.target.value = ''; }}/>
      <p className="text-xs text-muted mt-3">In-app camera captures are not saved to your public gallery. Imported originals remain in the gallery.</p>
    </>}
    {previewing && <><p className="form-hint mt-3">{job.mode === 'panorama' ? 'Frames are processed independently; overlapping students count once. ' : ''}{navigator.onLine ? 'Upload and review the results before finalizing attendance.' : 'Saved offline. Upload resumes when connectivity returns.'}</p><button className="btn btn-primary btn-full" disabled={busy} onClick={ready}>{busy ? 'Saving…' : navigator.onLine ? 'Use photos & process' : 'Save offline for sync'}</button></>}
    {error && <div className="notice error mt-3" role="alert">{error}</div>}
  </Dialog>;
}
