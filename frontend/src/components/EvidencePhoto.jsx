import { useState } from 'react';

export default function EvidencePhoto({ photo, evidence, index, showBoxes, caption }) {
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const width = evidence?.width || size?.width;
  const height = evidence?.height || size?.height;
  const hasGeometry = Array.isArray(evidence?.detections);
  const source = hasGeometry ? photo.url : (showBoxes && photo.annotated_url) || photo.url;
  return <figure className="evidence-photo">
    <div className="face-preview">
      <img src={source} alt={`Classroom view ${index + 1}`} onLoad={e => { setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }); setFailed(false); }} onError={() => setFailed(true)}/>
      {!failed && showBoxes && width > 0 && height > 0 && evidence?.detections?.map((face, i) => {
        const box = face.bbox;
        if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
        const [x1, y1, x2, y2] = box;
        const label = `${face.label} · ${face.status === 'matched' ? 'Matched' : 'Review'}${face.confidence != null ? ` · ${face.confidence.toFixed(2)}` : ''}`;
        return <div key={i} className={`face-box ${face.status === 'matched' ? 'matched' : 'review'}`} role="img" aria-label={label} style={{ left: `${Math.max(0, x1) / width * 100}%`, top: `${Math.max(0, y1) / height * 100}%`, width: `${(Math.min(width, x2) - Math.max(0, x1)) / width * 100}%`, height: `${(Math.min(height, y2) - Math.max(0, y1)) / height * 100}%` }}><span>{label}</span></div>;
      })}
    </div>
    <figcaption>{caption ?? `View ${index + 1}${hasGeometry ? ` · ${evidence.detections.length} face${evidence.detections.length === 1 ? '' : 's'} detected` : ' · detection pending'}`}{failed && ' · image unavailable while offline; stored captures are retained'}</figcaption>
  </figure>;
}
