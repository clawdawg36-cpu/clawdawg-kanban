import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/variables.css';
import './styles/global.css';
import { ThemeProvider } from './contexts/ThemeContext';
import { TaskProvider } from './contexts/TaskContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { FilterProvider } from './contexts/FilterContext';
import { NotificationProvider } from './contexts/NotificationContext';
import App from './App';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <ProjectProvider>
        <TaskProvider>
          <FilterProvider>
            <NotificationProvider>
              <App />
            </NotificationProvider>
          </FilterProvider>
        </TaskProvider>
      </ProjectProvider>
    </ThemeProvider>
  </StrictMode>,
);
