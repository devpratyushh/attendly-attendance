import React from 'react';

export default function AttendanceRing({ attended, total }) {
  const size = 160;
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const percentage = total > 0 ? attended / total : 0;
  const offset = circumference * (1 - percentage);

  return (
    <div className="ring-container" style={{ position: 'relative' }}>
      <svg width={size} height={size} className="ring-svg" role="img" aria-label={total ? `${Math.round(percentage*100)} percent attendance; ${attended} of ${total} periods` : 'No confirmed attendance yet'}>
        <circle className="ring-bg" cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div
        className="ring-text"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      >
        <div className="ring-value">{total ? `${Math.round(percentage*100)}%` : '—'}</div>
        <div className="ring-label">{total ? 'attendance' : 'No records yet'}</div>
      </div>
    </div>
  );
}
