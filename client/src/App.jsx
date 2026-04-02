import { useState } from 'react';
import Header from './components/layout/Header';
import Sidebar from './components/layout/Sidebar';
import FilterBar from './components/filters/FilterBar';
import Board from './components/board/Board';
import styles from './App.module.css';

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [activeView, setActiveView] = useState('board');

  const toggleSidebar = () => setSidebarCollapsed(prev => !prev);

  return (
    <div className={styles.appWrapper}>
      <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      <div className={`${styles.appContent} ${sidebarCollapsed ? styles.sidebarCollapsed : ''}`}>
        <Header
          onToggleSidebar={toggleSidebar}
          activeView={activeView}
          onViewChange={setActiveView}
        />
        <FilterBar />
        {activeView === 'board' && <Board />}
        {activeView === 'list' && (
          <div style={{ padding: '24px 32px', color: 'var(--text-dim)', fontSize: 14 }}>
            List view coming in Phase 3.
          </div>
        )}
        {activeView === 'timeline' && (
          <div style={{ padding: '24px 32px', color: 'var(--text-dim)', fontSize: 14 }}>
            Timeline view coming in Phase 3.
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
