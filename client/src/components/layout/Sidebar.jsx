import { useProjects } from '../../contexts/ProjectContext';
import { useTasks } from '../../contexts/TaskContext';
import styles from './Sidebar.module.css';

export default function Sidebar({ collapsed, onToggle }) {
  const { projects, activeProjectId, setActiveProject } = useProjects();
  const { tasks } = useTasks();

  const taskCount = tasks.length;

  return (
    <>
      <nav className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
        <div className={styles.sidebarHeader}>
          <h3 className={styles.sidebarTitle}>Projects</h3>
          <button className={styles.toggleBtn} onClick={onToggle} title="Collapse sidebar">
            &#9776;
          </button>
        </div>
        <div className={styles.projectList}>
          {projects.map(project => (
            <button
              key={project.id}
              className={`${styles.projectItem} ${project.id === activeProjectId ? styles.active : ''}`}
              onClick={() => setActiveProject(project.id)}
            >
              <span className={styles.projEmoji}>{project.emoji || '\uD83D\uDCCB'}</span>
              <span className={styles.projName}>{project.name || project.id}</span>
              {project.id === activeProjectId && (
                <span className={styles.projCount}>{taskCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className={styles.sidebarFooter}>
          <button className={styles.newProjectBtn}>+ New Project</button>
        </div>
      </nav>

      {/* Expand button visible when sidebar is collapsed */}
      {collapsed && (
        <button className={styles.expandBtn} onClick={onToggle} title="Open sidebar">
          &#9776;
        </button>
      )}

      {/* Backdrop for mobile */}
      {!collapsed && (
        <div
          className={`${styles.backdrop} ${!collapsed ? styles.backdropOpen : ''}`}
          onClick={onToggle}
        />
      )}
    </>
  );
}
