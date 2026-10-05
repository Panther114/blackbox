import React from 'react';
import { createRoot } from 'react-dom/client';
import './bridge';
import { App } from './App';
import './styles.css';

// The main process reports whether the window has a native Mica material behind it.
const material = new URLSearchParams(window.location.search).get('material');
if (material) document.documentElement.dataset.material = material;

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
