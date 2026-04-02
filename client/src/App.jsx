import { useTheme } from './contexts/ThemeContext';

function App() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="app">
      <header style={{
        padding: '20px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(180deg, rgba(108,92,231,0.06) 0%, transparent 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: 36, height: 36,
            background: 'linear-gradient(135deg, var(--accent), #a29bfe)',
            borderRadius: 10,
            display: 'grid', placeItems: 'center',
            fontWeight: 700, fontSize: 18, color: '#fff',
          }}>K</div>
          <h1 style={{
            fontSize: 20, fontWeight: 700,
            background: 'linear-gradient(135deg, #e4e6ef, #a29bfe)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>Kanban</h1>
        </div>
        <button onClick={toggleTheme} style={{
          width: 36, height: 36,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text-dim)',
          fontSize: 18,
          cursor: 'pointer',
          display: 'grid', placeItems: 'center',
        }}>
          {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
        </button>
      </header>
      <main style={{ padding: '24px 32px', color: 'var(--text-dim)', fontSize: 14 }}>
        <p>React app shell ready. Phase 2 will add board components here.</p>
      </main>
    </div>
  );
}

export default App;
