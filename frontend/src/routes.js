// Route permissions mirror visible portal navigation; the API remains authoritative.
const route = (path, page, view, icon, label, manager = false) => ({path,page,view,icon,label,manager,role:path.split('/')[1]});
export const portalRoutes = [
  route('/student/attendance','overview','student','grid','My attendance'),
  route('/student/attendance/:sessionId','overview','student'),
  route('/student/biometrics','biometric','student','face','My biometrics'),
  route('/teacher/dashboard','overview','teacher','grid','Overview'),
  route('/teacher/students','accounts','management','users','Students',true),
  route('/teacher/classes','classes','management','school','Classes',true),
  route('/teacher/subjects','subjects','management','book','Subject assignments',true),
  route('/teacher/biometrics','biometrics','management','face','Biometrics',true),
  route('/teacher/attendance','attendance','teacher','camera','Take attendance'),
  route('/teacher/history','history','teacher','clock','Session history'),
  route('/teacher/history/:sessionId','history','teacher'),
  route('/admin/dashboard','overview','management','grid','Overview'),
  route('/admin/accounts','accounts','management','users','People & accounts'),
  route('/admin/classes','classes','management','school','Classes'),
  route('/admin/subjects','subjects','management','book','Subject assignments'),
  route('/admin/biometrics','biometrics','management','face','Biometrics'),
  route('/admin/settings','settings','management','settings','Recognition settings'),
];
export const isManager = user => user?.role === 'admin' || Boolean(user?.managed_class_ids?.length);
export const canAccessRoute = (user, entry) => Boolean(user && entry && user.role === entry.role && (!entry.manager || isManager(user)));
export const homePath = user => user?.role === 'teacher' ? '/teacher/dashboard' : user?.role === 'admin' ? '/admin/dashboard' : '/student/attendance';
export function navigationFor(user) {
  return portalRoutes.filter(entry=>entry.label && canAccessRoute(user,entry)).map(entry=>[entry.page,entry.icon,entry.path==='/teacher/dashboard' && isManager(user)?'Overview':entry.label,entry.path]);
}
export function routeForPath(pathname) {
  return portalRoutes.find(entry=>{
    const parts=entry.path.split('/'), actual=pathname.replace(/\/$/,'').split('/');
    return parts.length===actual.length && parts.every((part,i)=>part.startsWith(':')?Boolean(actual[i]):part===actual[i]);
  });
}
export function returnPath(user, requested) {
  if (typeof requested !== 'string' || !requested.startsWith('/') || requested.startsWith('//')) return homePath(user);
  const parsed=new URL(requested,'https://attendly.invalid');
  return parsed.origin==='https://attendly.invalid' && canAccessRoute(user,routeForPath(parsed.pathname)) ? parsed.pathname+parsed.search : homePath(user);
}
