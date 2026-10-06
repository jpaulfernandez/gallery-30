import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installErrorForwarding } from './lib/log';
import { router } from './router';
import { installCloseFlush, startAutosave } from './store/autosave';
import './styles.css';

installErrorForwarding();
startAutosave();
void installCloseFlush();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
