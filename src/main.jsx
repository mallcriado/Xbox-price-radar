import React from 'react';
import { createRoot } from 'react-dom/client';
import Root from './App.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
