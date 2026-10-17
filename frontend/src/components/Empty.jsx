import Icon from './Icon';

export default function Empty({ icon, title, description, action, actionLabel }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{description}</p>{action && <button className="btn btn-secondary" onClick={action}><Icon name="plus" size={16}/>{actionLabel}</button>}</div>;
}
