import { useEffect, useState } from 'react';
import { api } from '../api';
import Dialog from './Dialog';

export default function FormerStudentRecord({ student, onClose }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api.getFormerStudentRecord(student.id).then(data => {
      if (active) setRecord(data);
    }).catch(err => {
      if (active) setError(err.message);
    });
    return () => { active = false; };
  }, [student.id]);

  return <Dialog title={student.name} description={`Roll no. ${student.roll_no}`} onClose={onClose}>
    <p><strong>No longer enrolled</strong> since {new Date(student.archived_at).toLocaleDateString('en-IN')}</p>
    {error ? <p role="alert" className="notice error">{error}</p> : !record ? <p role="status">Loading record…</p> : <>
      <h3 className="mt-4">Enrollment at departure</h3>
      {record.enrollment_at_departure ? <>
        <p>{record.enrollment_at_departure.class_name || 'Class not recorded'}</p>
        {record.enrollment_at_departure.subjects.length ? <ul>
          {record.enrollment_at_departure.subjects.map(subject => <li key={subject.code}>{subject.name} · {subject.code}</li>)}
        </ul> : <p>No subjects were assigned to this class.</p>}
      </> : <p>The class subject list was not recorded at departure.</p>}
      <h3 className="mt-4">Attendance history</h3>
      {record.attendance.length ? <div className="table-container"><table>
        <thead><tr><th>Session</th><th>Subject / class</th><th>Periods</th><th>Attendance</th></tr></thead>
        <tbody>{record.attendance.map(row => <tr key={row.session_id}>
          <td>{new Date(row.date).toLocaleDateString('en-IN')}<span className="cell-subtext">{row.session_id}</span></td>
          <td>{row.subject_name || 'Subject not recorded'}<span className="cell-subtext">{[row.subject_code, row.class_name].filter(Boolean).join(' · ')}</span></td>
          <td>{row.periods}</td>
          <td><span className={`badge badge-${row.status}`}>{row.status}</span><span className="cell-subtext">{[row.method, row.manual_reason].filter(Boolean).join(' · ')}</span></td>
        </tr>)}</tbody>
      </table></div> : <p>No attendance records to display.</p>}
    </>}
  </Dialog>;
}
