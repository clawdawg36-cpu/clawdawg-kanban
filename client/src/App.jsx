import { useState, useEffect, useCallback } from 'react';
import Header from './components/layout/Header';
import Sidebar from './components/layout/Sidebar';
import FilterBar from './components/filters/FilterBar';
import Board from './components/board/Board';
import TaskModal from './components/modal/TaskModal';
import ProjectModal from './components/project/ProjectModal';
import ProjectSwitcher from './components/project/ProjectSwitcher';
import styles from './App.module.css';

function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [activeView, setActiveView] = useState('board');

  // Task modal state
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskModalTask, setTaskModalTask] = useState(null);

  // Project modal state
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalProject, setProjectModalProject] = useState(null);

  // Project switcher state
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const toggleSidebar = () => setSidebarCollapsed(prev => !prev);

  const openTaskModal = useCallback((task = null) => {
    setTaskModalTask(task);
    setTaskModalOpen(true);
  }, []);

  const closeTaskModal = useCallback(() => {
    setTaskModalOpen(false);
    setTaskModalTask(null);
  }, []);

  const openProjectModal = useCallback((project = null) => {
    setProjectModalProject(project);
    setProjectModalOpen(true);
  }, []);

  const closeProjectModal = useCallback(() => {
    setProjectModalOpen(false);
    setProjectModalProject(null);
  }, []);

  // Cmd+K / Ctrl+K to open project switcher
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSwitcherOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  return (
    <div className={styles.appWrapper}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
        onNewProject={() => openProjectModal()}
        onEditProject={(project) => openProjectModal(project)}
      />
      <div className={`${styles.appContent} ${sidebarCollapsed ? styles.sidebarCollapsed : ''}`}>
        <Header
          onToggleSidebar={toggleSidebar}
          activeView={activeView}
          onViewChange={setActiveView}
          onAddTask={() => openTaskModal()}
        />
        <FilterBar />
        {activeView === 'board' && (
          <Board onCardClick={(task) => openTaskModal(task)} />
        )}
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

      {/* Task Modal */}
      {taskModalOpen && (
        <TaskModal task={taskModalTask} onClose={closeTaskModal} />
      )}

      {/* Project Modal */}
      {projectModalOpen && (
        <ProjectModal project={projectModalProject} onClose={closeProjectModal} />
      )}

      {/* Project Switcher */}
      {switcherOpen && (
        <ProjectSwitcher onClose={() => setSwitcherOpen(false)} />
      )}
    </div>
  );
}

export default App;
