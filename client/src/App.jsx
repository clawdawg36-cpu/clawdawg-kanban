import { useState, useCallback } from 'react';
import Header from './components/layout/Header';
import Sidebar from './components/layout/Sidebar';
import FilterBar from './components/filters/FilterBar';
import Board from './components/board/Board';
import ListView from './components/list/ListView';
import TimelineView from './components/timeline/TimelineView';
import TaskModal from './components/modal/TaskModal';
import ProjectModal from './components/project/ProjectModal';
import ProjectSwitcher from './components/project/ProjectSwitcher';
import StatsPanel from './components/stats/StatsPanel';
import BulkToolbar from './components/bulk/BulkToolbar';
import KeyboardHelp from './components/common/KeyboardHelp';
import useKeyboardShortcuts from './hooks/useKeyboardShortcuts';
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

  // Stats panel state
  const [statsOpen, setStatsOpen] = useState(false);

  // Keyboard help state
  const [kbdHelpOpen, setKbdHelpOpen] = useState(false);

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

  // Determine if any overlay is open for keyboard shortcut handling
  const hasOpenOverlay = taskModalOpen || projectModalOpen || switcherOpen || statsOpen || kbdHelpOpen;

  const closeTopOverlay = useCallback(() => {
    if (kbdHelpOpen) { setKbdHelpOpen(false); return; }
    if (statsOpen) { setStatsOpen(false); return; }
    if (switcherOpen) { setSwitcherOpen(false); return; }
    if (projectModalOpen) { closeProjectModal(); return; }
    if (taskModalOpen) { closeTaskModal(); return; }
  }, [kbdHelpOpen, statsOpen, switcherOpen, projectModalOpen, taskModalOpen, closeProjectModal, closeTaskModal]);

  const focusSearch = useCallback(() => {
    const input = document.querySelector('input[placeholder*="Search"]');
    if (input) { input.focus(); input.select(); }
  }, []);

  useKeyboardShortcuts({
    onNewTask: () => openTaskModal(),
    onFocusSearch: focusSearch,
    onToggleKeyboardHelp: () => setKbdHelpOpen(prev => !prev),
    onToggleSwitcher: () => setSwitcherOpen(prev => !prev),
    onCloseOverlay: closeTopOverlay,
    hasOpenOverlay,
  });

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
          onToggleStats={() => setStatsOpen(prev => !prev)}
          activeView={activeView}
          onViewChange={setActiveView}
          onAddTask={() => openTaskModal()}
        />
        <FilterBar />
        {activeView === 'board' && (
          <Board onCardClick={(task) => openTaskModal(task)} />
        )}
        {activeView === 'list' && (
          <ListView onTaskClick={(task) => openTaskModal(task)} />
        )}
        {activeView === 'timeline' && (
          <TimelineView onTaskClick={(task) => openTaskModal(task)} />
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

      {/* Stats Panel */}
      <StatsPanel open={statsOpen} onClose={() => setStatsOpen(false)} />

      {/* Bulk Toolbar */}
      <BulkToolbar />

      {/* Keyboard Help Overlay */}
      {kbdHelpOpen && (
        <KeyboardHelp onClose={() => setKbdHelpOpen(false)} />
      )}
    </div>
  );
}

export default App;
