import styles from './Skeleton.module.css';

export function SkeletonLine({ width = '75%', height, variant = 'title' }) {
  return (
    <div
      className={`${styles.line} ${styles[variant] || ''}`}
      style={width ? { width } : undefined}
    />
  );
}

export function SkeletonCard({ lines }) {
  const defaultLines = [
    { variant: 'title', width: '75%' },
    { variant: 'desc', width: '90%' },
    { variant: 'meta', width: '40%' },
  ];
  const renderLines = lines || defaultLines;

  return (
    <div className={styles.card}>
      {renderLines.map((l, i) => (
        <SkeletonLine key={i} variant={l.variant} width={l.width} />
      ))}
    </div>
  );
}

export function SkeletonColumnHeader() {
  return <div className={styles.colHeader} />;
}

export default function Skeleton({ count = 3 }) {
  return (
    <div className={styles.container}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={styles.column}>
          <SkeletonColumnHeader />
          <SkeletonCard />
          <SkeletonCard lines={[
            { variant: 'title', width: '60%' },
            { variant: 'desc', width: '80%' },
            { variant: 'desc', width: '55%' },
            { variant: 'meta', width: '40%' },
          ]} />
        </div>
      ))}
    </div>
  );
}
