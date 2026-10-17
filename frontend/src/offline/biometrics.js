export function latestBiometricUpdates(updates) {
  const ordered=[...updates].sort((a,b)=>new Date(b.submitted_at)-new Date(a.submitted_at) || b.id-a.id);
  const latest=new Map();
  for(const item of ordered) if(!latest.has(item.photo_type))latest.set(item.photo_type,item);
  return [...latest.values()];
}
