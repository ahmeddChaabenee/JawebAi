import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AdminApp } from './pages/AdminApp.tsx';
import { ClientApp } from './pages/ClientApp.tsx';
import { Landing } from './pages/Landing.tsx';
import { Login } from './pages/Login.tsx';
import './styles.css';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('app_token') ?? '');

  const signIn = (t: string) => { localStorage.setItem('app_token', t); setToken(t); };
  const signOut = () => { localStorage.removeItem('app_token'); setToken(''); };

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={
        token ? <Navigate to="/app" replace /> : <Login onSignedIn={signIn} />} />
      <Route path="/app" element={
        token ? <ClientApp token={token} onSignedOut={signOut} /> : <Navigate to="/login" replace />} />
      <Route path="/admin" element={<AdminApp />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
