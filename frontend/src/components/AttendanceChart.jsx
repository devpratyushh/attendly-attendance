import { useId } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function AttendanceChart({ sessions }) {
  const gradient = useId().replaceAll(':','');
  const formatDate = (timestamp, options = {}) => new Date(timestamp).toLocaleDateString('en-IN', {month:'short',day:'numeric', ...options});
  const days = new Map();
  for (const session of sessions) {
    const date = new Date(session.date);
    const periods = Number(session.periods);
    if (!Number.isFinite(date.getTime()) || !Number.isFinite(periods) || periods <= 0) continue;
    const timestamp = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const day = days.get(timestamp) || {timestamp, attended:0, total:0};
    day.total += periods;
    if (session.status === 'present') day.attended += periods;
    days.set(timestamp, day);
  }
  const data = [...days.values()].sort((a,b) => a.timestamp-b.timestamp).reduce((items, day) => {
    const previous = items[items.length-1] || {attended:0,total:0};
    items.push({...day, attended:previous.attended+day.attended, total:previous.total+day.total});
    return items;
  }, []);
  const {attended,total}=data[data.length-1] || {attended:0,total:0};
  return <><div className="chart-legend"><span><i/>Attended periods</span><span><i/>Recorded periods</span></div><div className="attendance-chart" role="img" aria-label={`Attendance activity: ${attended} attended out of ${total} recorded periods`}>
    <ResponsiveContainer width="100%" height={250}><AreaChart data={data} margin={{top:15,right:10,left:-25,bottom:5}}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent-primary)" stopOpacity={.2}/><stop offset="100%" stopColor="var(--accent-primary)" stopOpacity={.01}/></linearGradient></defs>
      <CartesianGrid strokeDasharray="3 6" stroke="var(--border)" vertical={false}/><XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin','dataMax']} ticks={data.map(day => day.timestamp)} tickFormatter={formatDate} axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-secondary)'}} minTickGap={30} padding={{left:10,right:10}}/><YAxis domain={[0,'auto']} allowDecimals={false} axisLine={false} tickLine={false} tick={{fontSize:11,fill:'var(--text-secondary)'}}/>
      <Tooltip labelFormatter={value => formatDate(value, {year:'numeric'})} contentStyle={{background:'white',border:'1px solid var(--border)',borderRadius:14,fontSize:12,boxShadow:'0 8px 30px #263b2c12'}}/>
      <Area type="linear" dataKey="total" name="Recorded periods" stroke="#c68b5f" fill="#fbf0e5" strokeWidth={1.5} dot={{r:3,fill:'#c68b5f',stroke:'white',strokeWidth:1.5}}/><Area type="linear" dataKey="attended" name="Attended periods" stroke="var(--accent-primary)" fill={`url(#${gradient})`} strokeWidth={2.5} dot={{r:4,fill:'var(--accent-primary)',stroke:'white',strokeWidth:2}} activeDot={{r:5,stroke:'white',strokeWidth:3}}/>
    </AreaChart></ResponsiveContainer>
  </div></>;
}
