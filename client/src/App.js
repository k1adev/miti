import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Home, Users, ExternalAPIs, Status } from './components';
import { Sales } from './components/Sales';
import SalesReportPage from './components/reports/SalesReportPage';
import { Inventory } from './components/Inventory';
import { Sidebar } from './components/Sidebar';
import { Login } from './components/Login';
import { AdminPanel } from './components/AdminPanel';
import { Anuncios } from './components/Anuncios';
import { Atendimento } from './components/Atendimento';
import { FactoryDeliveries } from './components/FactoryDeliveries';
import { FloatingQuestions } from './components/FloatingQuestions';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import './App.css';
import axios from 'axios';

axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers = config.headers || {};
    if (!config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const isTokenInvalid = error.response?.data?.error === 'Token inválido';
    // 401 = sem token/revogado | 403 com "Token inválido" = token expirado (JWT expira em 8h)
    const shouldRedirectToLogin = status === 401 || (status === 403 && isTokenInvalid);
    if (shouldRedirectToLogin) {
      const currentPath = window.location.pathname;
      if (currentPath !== '/login') {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        sessionStorage.setItem('session_expired', 'true');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

function logout(setUser) {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  setUser(null);
  window.location.href = '/login';
}

function AppRoutes({ user, setUser, toggleDarkMode, userSettings }) {
  const location = useLocation();
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;

  // Permissões por nível
  if (user.role === 1) {
    return (
      <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
        <Sidebar user={user} onLogout={() => logout(setUser)} toggleDarkMode={toggleDarkMode} userSettings={userSettings} />
        <main className="flex-1 overflow-auto">
          <div className="p-6">
            <Routes>
              <Route path="/inventory" element={<Inventory user={user} />} />
              <Route path="*" element={<Navigate to="/inventory" />} />
            </Routes>
          </div>
        </main>
      </div>
    );
  }

  // Conta Fábrica: apenas registrar entregas de lotes (sem sidebar completa).
  if (user.role === 5) {
    return (
      <Routes>
        <Route path="/factory/*" element={<FactoryDeliveries user={user} onLogout={() => logout(setUser)} />} />
        <Route path="*" element={<Navigate to="/factory" replace />} />
      </Routes>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-900">
      <Sidebar user={user} onLogout={() => logout(setUser)} toggleDarkMode={toggleDarkMode} userSettings={userSettings} />
      <main className="flex-1 overflow-auto">
        <div className="p-6">
          <Routes>
            <Route path="/" element={<Home />} />
            {user.role === 4 && <Route path="/users" element={<Users user={user} />} />}
            {user.role === 4 && <Route path="/admin" element={<AdminPanel user={user} />} />}
            {(user.role >= 1) && <Route path="/inventory" element={<Inventory user={user} />} />}
            {(user.role >= 2) && <Route path="/sales" element={<Sales />} />}
            {(user.role >= 2) && <Route path="/anuncios" element={<Anuncios user={user} />} />}
            {(user.role >= 2) && <Route path="/atendimento" element={<Atendimento user={user} />} />}
            {(user.role >= 2) && <Route path="/sales-report" element={<SalesReportPage user={user} />} />}
            {(user.role >= 4) && <Route path="/external-apis" element={<ExternalAPIs />} />}
            {(user.role >= 4) && <Route path="/configuracoes" element={<ExternalAPIs />} />}
            {user.role === 4 && <Route path="/status" element={<Status />} />}
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </div>
      </main>
      {user.role >= 2 && <FloatingQuestions />}
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [loadingUser, setLoadingUser] = useState(true);
  const [userSettings, setUserSettings] = useState({});
  const [loadingSettings, setLoadingSettings] = useState(false);

  // Buscar usuário logado
  useEffect(() => {
    const token = localStorage.getItem('token');
    const userData = localStorage.getItem('user');
    if (token && userData) {
      setUser(JSON.parse(userData));
    }
    setLoadingUser(false);
  }, []);

  // Buscar preferências do usuário
  useEffect(() => {
    const fetchSettings = async () => {
      if (!user) return;
      setLoadingSettings(true);
      try {
        const token = localStorage.getItem('token');
        const res = await axios.get('/api/user/settings', { headers: { Authorization: `Bearer ${token}` } });
        setUserSettings(res.data || {});
        if (res.data.darkMode) {
          document.body.classList.add('dark');
        } else {
          document.body.classList.remove('dark');
        }
      } catch {
        setUserSettings({});
        document.body.classList.remove('dark');
      }
      setLoadingSettings(false);
    };
    fetchSettings();
  }, [user]);

  // Função para alternar modo noturno
  const toggleDarkMode = async () => {
    const newSettings = { ...userSettings, darkMode: !userSettings.darkMode };
    setUserSettings(newSettings);
    if (newSettings.darkMode) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
    try {
      const token = localStorage.getItem('token');
      await axios.put('/api/user/settings', newSettings, { headers: { Authorization: `Bearer ${token}` } });
    } catch {}
  };

  if (loadingUser || loadingSettings) {
    return <div className="flex items-center justify-center h-screen text-xl text-gray-600">Carregando...</div>;
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <Router>
          <Routes>
            <Route path="/login" element={<Login onLogin={setUser} />} />
            <Route path="/*" element={<AppRoutes user={user} setUser={setUser} toggleDarkMode={toggleDarkMode} userSettings={userSettings} />} />
          </Routes>
        </Router>
      </ToastProvider>
    </ErrorBoundary>
  );
}

export default App; 