import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { listProjects, createProject as apiCreateProject, updateProject as apiUpdateProject, deleteProject as apiDeleteProject } from '../api/projects';

const ProjectContext = createContext();

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(() => {
    return localStorage.getItem('kanban-active-project') || 'default';
  });
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listProjects();
      const list = Array.isArray(data) ? data : (data.items || []);
      setProjects(list);
      // If active project doesn't exist in list, default to first or 'default'
      if (list.length > 0 && !list.find(p => p.id === activeProjectId)) {
        const firstId = list[0].id || 'default';
        setActiveProjectId(firstId);
        localStorage.setItem('kanban-active-project', firstId);
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    loadProjects();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setActiveProject = useCallback((id) => {
    setActiveProjectId(id);
    localStorage.setItem('kanban-active-project', id);
  }, []);

  const createProject = useCallback(async (data) => {
    const project = await apiCreateProject(data);
    setProjects(prev => [...prev, project]);
    return project;
  }, []);

  const updateProject = useCallback(async (id, data) => {
    const updated = await apiUpdateProject(id, data);
    setProjects(prev => prev.map(p => p.id === id ? updated : p));
    return updated;
  }, []);

  const deleteProject = useCallback(async (id) => {
    await apiDeleteProject(id);
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProjectId === id) {
      setActiveProject('default');
    }
  }, [activeProjectId, setActiveProject]);

  const activeProject = projects.find(p => p.id === activeProjectId) || null;

  return (
    <ProjectContext.Provider value={{
      projects,
      activeProjectId,
      activeProject,
      loading,
      loadProjects,
      createProject,
      updateProject,
      deleteProject,
      setActiveProject,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjects() {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProjects must be used within a ProjectProvider');
  return context;
}
