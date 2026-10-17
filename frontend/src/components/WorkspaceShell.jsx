import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Dialog from './Dialog';
import StudentAvatar from './StudentAvatar';
import ProfileCard from './ProfileCard';
import { Link, NavLink, useInRouterContext } from 'react-router-dom';

export default function WorkspaceShell({ user, roleLabel, nav, page, onNavigate, onPassword, onSignOut, children }) {
  const routed = useInRouterContext();
  const BrandLink = routed ? Link : 'a';
  const attendancePath = nav.find(([id])=>id==='attendance')?.[3];
  const AttendanceAction = routed && attendancePath ? Link : 'button';
  const [profileOpen, setProfileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navRef = useRef(null);
  useEffect(() => {
    const navElement = navRef.current;
    const active = navElement?.querySelector('[aria-current="page"]');
    if (active && matchMedia('(max-width: 680px)').matches) navElement.scrollLeft = Math.max(0, active.offsetLeft-navElement.offsetLeft-12);
  }, [page]);
  const [today] = useState(() => new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }));
  const portalLabel = user.role === 'student' ? 'Student portal' : user.role === 'teacher' ? 'Teacher portal' : 'Admin portal';
  return <div className={`workspace role-${user.role} ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className="sidebar-brand-row"><BrandLink className="brand" aria-label="Attendly home" {...(routed ? {to:nav[0][3]} : {href:'/',onClick:e=>{e.preventDefault();onNavigate(nav[0][0]);}})}><span className="brand-symbol"><Icon name="face" size={23}/></span><span className="brand-name">Attendly<span className="brand-caption">Attendance, made simple.</span></span></BrandLink><button className="sidebar-collapse icon-button" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><Icon name="chevron" size={16}/></button></div>
      <div className="workspace-label">{roleLabel} workspace</div>
      <nav ref={navRef} aria-label="Main navigation">{nav.map(([id, icon, label, path]) => {
        const NavigationItem = routed && path ? NavLink : 'button';
        return <NavigationItem key={id} {...(routed && path ? {to:path} : {onClick:()=>onNavigate(id)})} data-page={id} aria-label={label} title={collapsed ? label : undefined} aria-current={page===id?'page':undefined} className={`nav-item ${page===id?'active':''}`}><Icon name={icon}/><span>{label}</span>{page===id && <span className="nav-active-dot" aria-hidden="true"/>}</NavigationItem>;
      })}</nav>
      <div className="sidebar-bottom"><button className="account-mini account-profile-button" aria-label="View my profile" onClick={()=>setProfileOpen(true)}><StudentAvatar student={user} size={36}/><div><strong>{user.name}</strong><span>{roleLabel} · View profile</span></div></button><button className="nav-item" aria-label="Change password" title={collapsed ? 'Change password' : undefined} onClick={() => onPassword()}><Icon name="key"/><span>Change password</span></button><button className="nav-item" aria-label="Sign out" title={collapsed ? 'Sign out' : undefined} onClick={onSignOut}><Icon name="logout"/><span>Sign out</span></button></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="topbar-location"><span className="portal-indicator"/>{portalLabel}<span className="breadcrumb-divider">/</span><strong>{nav.find(([id]) => id === page)?.[2] || 'Workspace'}</strong></div><div className="topbar-tools"><button className="workspace-search" aria-label="Find a page" onClick={() => { setQuery(''); setSearchOpen(true); }}><Icon name="search" size={17}/><span>Find a page</span></button><span className="topbar-date"><Icon name="calendar" size={15}/>{today}</span><details className="topbar-account"><summary aria-label="Account menu"><StudentAvatar student={user} size={36}/></summary><div className="account-popover"><strong>{user.name}</strong><span>{roleLabel}</span><button onClick={() => setProfileOpen(true)}><Icon name="users" size={16}/>My profile</button><button onClick={() => onPassword()}><Icon name="key" size={16}/>Change password</button><button onClick={onSignOut}><Icon name="logout" size={16}/>Sign out</button></div></details></div></header>
      <main className="content">{children}</main>
      <footer className="workspace-footer">Attendly <span>Thoughtfully simple attendance management.</span></footer>
    </div>
    {user.role === 'teacher' && page !== 'attendance' && <AttendanceAction className="attendance-fab btn btn-primary" {...(routed && attendancePath ? {to:attendancePath} : {onClick:()=>onNavigate('attendance')})}><Icon name="camera" size={21}/><span>Take attendance</span><Icon name="arrow" size={18}/></AttendanceAction>}
    {profileOpen && <Dialog title="My profile" onClose={()=>setProfileOpen(false)}><ProfileCard person={user} roleLabel={roleLabel}/></Dialog>}
    {searchOpen && <Dialog title="Find a page" description={`Navigate your ${portalLabel.toLowerCase()}.`} onClose={() => setSearchOpen(false)}><label className="field">Search pages<input autoFocus placeholder="Attendance, classes, biometrics…" value={query} onChange={e => setQuery(e.target.value)}/></label><div className="navigation-results">{nav.filter(([, , label]) => label.toLowerCase().includes(query.toLowerCase())).map(([id, icon, label]) => <button key={id} onClick={() => { onNavigate(id); setSearchOpen(false); }}><Icon name={icon}/>{label}<Icon name="arrow" size={16}/></button>)}{!nav.some(([, , label]) => label.toLowerCase().includes(query.toLowerCase())) && <p className="form-hint">No matching pages. Try “attendance” or “biometrics”.</p>}</div></Dialog>}
  </div>;
}
