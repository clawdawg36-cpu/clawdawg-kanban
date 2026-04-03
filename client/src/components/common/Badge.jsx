import styles from './Badge.module.css';

const PRIORITY_CONFIG = {
  urgent: { label: 'Urgent', emoji: '\uD83D\uDD34' },
  high: { label: 'High', emoji: '\uD83D\uDFE0' },
  medium: { label: 'Medium', emoji: '\uD83D\uDFE1' },
  low: { label: 'Low', emoji: '\uD83D\uDFE2' },
};

const STATUS_CONFIG = {
  idea: { label: 'Idea' },
  backlog: { label: 'Backlog' },
  'in-progress': { label: 'In Progress' },
  'in-review': { label: 'In Review' },
  done: { label: 'Done' },
};

export default function Badge({ type = 'custom', value, size = 'default', children }) {
  if (type === 'priority' && PRIORITY_CONFIG[value]) {
    const config = PRIORITY_CONFIG[value];
    return (
      <span className={`${styles.badge} ${styles[`priority${value.charAt(0).toUpperCase() + value.slice(1)}`]} ${size === 'small' ? styles.small : ''}`}>
        {config.emoji} {config.label}
      </span>
    );
  }

  if (type === 'status' && STATUS_CONFIG[value]) {
    return (
      <span className={`${styles.badge} ${styles.status} ${size === 'small' ? styles.small : ''}`}>
        {STATUS_CONFIG[value].label}
      </span>
    );
  }

  return (
    <span className={`${styles.badge} ${styles.custom} ${size === 'small' ? styles.small : ''}`}>
      {children || value}
    </span>
  );
}
