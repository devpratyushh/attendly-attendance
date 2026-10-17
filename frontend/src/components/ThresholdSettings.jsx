import { useState } from 'react';
import { api } from '../api';

export default function ThresholdSettings({ config, onClose }) {
  const [match, setMatch] = useState(config?.match_threshold ?? 0.45);
  const [uncertain, setUncertain] = useState(config?.uncertain_threshold ?? 0.35);
  const [margin, setMargin] = useState(config?.recognition_policy?.min_match_margin ?? 0.08);
  const [calibration, setCalibration] = useState(config?.calibration);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try { await api.updateThresholds(match, uncertain, margin); setCalibration(null); setNotice('Manual thresholds saved for new sessions. This profile is uncalibrated.'); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const activate = async file => {
    if (!file) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.activateCalibration(file);
      setMatch(result.recognition_policy.match_threshold); setUncertain(result.recognition_policy.uncertain_threshold); setMargin(result.recognition_policy.min_match_margin);
      setCalibration(result.calibration); setNotice(result.message);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <>
    <div className="card mb-3"><div className="card-title mb-3">Calibration & baseline measurement</div>
      {calibration ? <div className="calibration-summary"><strong className="text-sm">Validated profile · {calibration.dataset_id}</strong><p>{calibration.evaluation_metrics.capture_groups} held-out capture groups · {calibration.evaluation_metrics.wrong_identity_matches} wrong identity matches · {calibration.evaluation_metrics.review_faces} faces needing review.</p><p>Validation applies to the labeled dataset. It does not guarantee error-free attendance in new conditions.</p></div> : <div className="notice">Provisional thresholds. No classroom-specific calibration has been validated yet.</div>}
      <p className="form-hint">Measure the current matcher and the guarded matcher on independently labeled classroom photos, including people outside the class. Use separate capture days for calibration and evaluation, then import the resulting validation report.</p>
      <label className="field">Import validated calibration report<input type="file" accept=".json,application/json" disabled={busy} onChange={e => { activate(e.target.files[0]); e.target.value = ''; }}/></label>
      <p className="text-xs text-muted">Reports with insufficient evidence, incompatible models, or failed held-out evaluation cannot be activated.</p>
    </div>
    <div className="card"><div className="flex justify-between items-center mb-3"><div className="card-title">Manual recognition policy</div>{onClose && <button className="btn btn-sm btn-secondary" onClick={onClose}>Close</button>}</div>
      <p className="form-hint">Similarity scores are not probabilities. Automatic presence also requires good image quality, a clear identity margin, and consistent identities across any additional classroom views.</p>
      <label className="field">Match threshold · {match.toFixed(2)}<input aria-label="Match threshold" type="range" className="threshold-slider" min="0.2" max="0.95" step="0.01" value={match} onChange={e => { const value = Number(e.target.value); setMatch(value); if (uncertain >= value) setUncertain(Math.max(0, value - .05)); }}/></label>
      <label className="field">Review threshold · {uncertain.toFixed(2)}<input aria-label="Review threshold" type="range" className="threshold-slider" min="0" max={match - .01} step="0.01" value={uncertain} onChange={e => setUncertain(Number(e.target.value))}/></label>
      <label className="field">Minimum identity margin · {margin.toFixed(2)}<input aria-label="Minimum identity margin" type="range" className="threshold-slider" min="0.01" max="0.3" step="0.01" value={margin} onChange={e => setMargin(Number(e.target.value))}/></label>
      <p className="form-hint">The chosen identity must exceed every competing student by this margin. Close candidates remain unresolved.</p>
      <button className="btn btn-secondary btn-full" disabled={busy} onClick={save}>{busy ? 'Processing…' : 'Save manual policy'}</button><p className="text-xs text-muted mt-3">Manual edits clear the calibration status. Active sessions retain the policy they started with.</p>
    </div>
    {error && <div className="notice error mt-3" role="alert">{error}</div>}{notice && <div className="notice success mt-3" role="status">{notice}</div>}
  </>;
}
