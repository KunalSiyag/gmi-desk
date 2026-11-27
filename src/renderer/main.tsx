import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './styles/index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { scheduleBootSplashFallback } from './lib/boot-splash';
import { queryClient } from './lib/query';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

scheduleBootSplashFallback();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
