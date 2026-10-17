import { useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import Empty from './Empty';

export default function ClassAttendanceChart({ classes, records, viewControl }) {
  const [classId, setClassId] = useState('all');
  const selected = records.filter(row => classId === 'all' || String(row.class_id) === classId);
  const days = new Map();
  let attended = 0, total = 0;
  for (const row of selected) {
    const date = new Date(row.date);
    const timestamp = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const day = days.get(timestamp) || {timestamp, attended:0, total:0};
    day.attended += row.attended;
    day.total += row.total;
    attended += row.attended;
    total += row.total;
    days.set(timestamp, day);
  }
  const points = [...days.values()].sort((a,b) => a.timestamp-b.timestamp)
    .map(day => ({...day, percentage: day.total ? day.attended/day.total*100 : 0}));
  const formatDate = value => new Date(value).toLocaleDateString('en-IN', {day:'numeric',month:'short'});
  return <>
    <div className="class-chart-controls">{viewControl}<label><span>Class</span><select aria-label="Class for average attendance" value={classId} onChange={event => setClassId(event.target.value)}><option value="all">All classes</option>{classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
    <div className="class-chart-summary"><strong>{total ? `${(attended/total*100).toFixed(1)}%` : '—'}<span> average attendance</span></strong><p>Confirmed student-periods attended ÷ recorded student-periods.</p></div>
    {points.length ? <div role="img" aria-label={`Average class attendance ${(attended/total*100).toFixed(1)} percent`}><ResponsiveContainer width="100%" height={220}><LineChart data={points} margin={{top:15,right:15,left:-15,bottom:5}}><CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 6"/><XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin','dataMax']} ticks={points.map(p=>p.timestamp)} tickFormatter={formatDate} minTickGap={30} padding={{left:10,right:10}} tick={{fontSize:11}}/><YAxis domain={[0,100]} tickFormatter={value=>`${value}%`} tick={{fontSize:11}}/><Tooltip labelFormatter={value=>new Date(value).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})} formatter={value=>[`${Number(value).toFixed(1)}%`,'Attendance']}/><Line type="linear" dataKey="percentage" stroke="var(--accent-primary)" strokeWidth={2.5} dot={{r:4,fill:'var(--accent-primary)',stroke:'white',strokeWidth:2}} activeDot={{r:6}}/></LineChart></ResponsiveContainer></div> : <Empty icon="clock" title="No confirmed attendance yet" description="The graph appears after attendance is confirmed for this class."/>}
  </>;
}
