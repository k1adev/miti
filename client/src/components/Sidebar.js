import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Home, Users, Globe, Activity, ShoppingCart, Archive, LogOut, BarChart2, Shield, ChevronLeft, ChevronRight, Sun, Moon, Megaphone, MessageSquare } from 'lucide-react';
import axios from 'axios';

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendDesktopNotif(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, icon: '/miti-logo.png', tag: 'ml-q-' + Date.now(), requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }
}

export const Sidebar = ({ user, onSelectEstoqueTab, activeEstoqueTab, onLogout, toggleDarkMode, userSettings }) => {
  const location = useLocation();
  const [estoqueOpen, setEstoqueOpen] = useState(location.pathname.startsWith('/inventory'));
  const [salesOpen, setSalesOpen] = useState(location.pathname.startsWith('/sales'));
  const [anunciosOpen, setAnunciosOpen] = useState(location.pathname.startsWith('/anuncios'));
  const [atendimentoOpen, setAtendimentoOpen] = useState(location.pathname.startsWith('/atendimento'));
  const [salesReportOpen, setSalesReportOpen] = useState(location.pathname.startsWith('/sales-report'));
  const [collapsed, setCollapsed] = useState(false);
  const [unansweredCount, setUnansweredCount] = useState(0);
  const navigate = useNavigate();
  const pollRef = useRef(null);
  const prevCountRef = useRef(null);
  const isFirstLoad = useRef(true);

  useEffect(() => {
    if (!user || user.role < 2) return;
    requestNotifPermission();
    const fetchCount = async () => {
      try {
        const r = await axios.get('/api/ml/questions/count');
        const newCount = r.data?.unanswered || 0;
        setUnansweredCount(newCount);

        if (!isFirstLoad.current && prevCountRef.current !== null && newCount > prevCountRef.current) {
          const diff = newCount - prevCountRef.current;
          sendDesktopNotif(
            'Nova pergunta no Mercado Livre',
            `Você tem ${diff} nova${diff > 1 ? 's' : ''} pergunta${diff > 1 ? 's' : ''} não respondida${diff > 1 ? 's' : ''}`
          );
        }
        isFirstLoad.current = false;
        prevCountRef.current = newCount;
      } catch { /* ignore */ }
    };
    fetchCount();
    pollRef.current = setInterval(fetchCount, 15000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [user]);

  let menuItems = [];
  if (user) {
    if (user.role === 1) {
      menuItems = [
        { path: '/inventory', label: 'Estoque', icon: Archive },
      ];
    } else if (user.role === 2) {
      menuItems = [
        { path: '/inventory', label: 'Estoque', icon: Archive },
        { path: '/sales', label: 'Pedidos', icon: ShoppingCart },
        { path: '/anuncios', label: 'Anúncios', icon: Megaphone },
        { path: '/atendimento', label: 'Atendimento', icon: MessageSquare },
      ];
    } else if (user.role === 3) {
      menuItems = [
        { path: '/', label: 'Início', icon: Home },
        { path: '/inventory', label: 'Estoque', icon: Archive },
        { path: '/sales', label: 'Pedidos', icon: ShoppingCart },
        { path: '/anuncios', label: 'Anúncios', icon: Megaphone },
        { path: '/atendimento', label: 'Atendimento', icon: MessageSquare },
        { path: '/sales-report', label: 'Relatório', icon: BarChart2 },
      ];
    } else if (user.role === 4) {
      menuItems = [
        { path: '/', label: 'Início', icon: Home },
        { path: '/inventory', label: 'Estoque', icon: Archive },
        { path: '/sales', label: 'Pedidos', icon: ShoppingCart },
        { path: '/anuncios', label: 'Anúncios', icon: Megaphone },
        { path: '/atendimento', label: 'Atendimento', icon: MessageSquare },
        { path: '/sales-report', label: 'Relatório', icon: BarChart2 },
        { path: '/status', label: 'Status', icon: Activity },
        { path: '/users', label: 'Usuários', icon: Users },
        { path: '/external-apis', label: 'APIs Externas', icon: Globe },
        { path: '/admin', label: 'Painel Admin', icon: Shield },
      ];
    }
  }

  const estoqueSubmenu = [
    { tab: 'itens', label: 'Itens em Estoque' },
    { tab: 'compostos', label: 'SKUs Compostos' },
    { tab: 'movimentacao', label: 'Movimentação' },
  ];

  const salesSubmenu = [
    { tab: 'notas', label: 'Pedidos de venda' },
    { tab: 'marketplace', label: 'Marketplace' },
    { tab: 'manual', label: 'Pedidos Manuais' },
  ];

  const anunciosSubmenu = [
    { tab: 'ativos', label: 'Anúncios Ativos' },
    { tab: 'modelos', label: 'Modelos de Anúncio' },
  ];

  const atendimentoSubmenu = [
    { tab: 'pre-venda', label: 'Pré Venda' },
  ];

  const isActive = (path) => location.pathname === path || (path !== '/' && location.pathname.startsWith(path));

  return (
    <div className={`bg-white dark:bg-gray-800 shadow-lg sidebar flex flex-col h-screen transition-all duration-300 ease-in-out ${collapsed ? 'w-[68px]' : 'w-64'}`}>
      {/* Logo */}
      <div className={`flex items-center justify-center border-b border-gray-100 dark:border-gray-700 ${collapsed ? 'py-4 px-2' : 'py-5 px-6'}`}>
        {collapsed ? (
          <div className="h-9 w-9 rounded-xl flex items-center justify-center font-extrabold text-white text-sm bg-blue-500/85 shadow-sm">
            M
          </div>
        ) : (
          <div className="flex flex-col items-center">
            <img
              src={process.env.PUBLIC_URL + (userSettings?.darkMode ? '/miti-logo-white.png' : '/miti-logo.png')}
              alt="Logo Miti"
              className="h-16 w-auto"
            />
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Gestão e inovação</p>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3">
        <ul className="space-y-0.5 px-2">
          {menuItems.map(item => (
            <li key={item.path}>
              <Link
                to={item.path}
                className={`flex items-center gap-3 rounded-lg transition-colors duration-150 ${collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'} ${isActive(item.path) ? 'bg-blue-50/70 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 font-medium' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-white'}`}
                onClick={() => {
                  if (item.path === '/inventory') {
                    setEstoqueOpen(o => !o);
                    setSalesOpen(false); setAnunciosOpen(false); setAtendimentoOpen(false); setSalesReportOpen(false);
                  } else if (item.path === '/sales') {
                    setSalesOpen(o => !o);
                    setEstoqueOpen(false); setAnunciosOpen(false); setAtendimentoOpen(false); setSalesReportOpen(false);
                  } else if (item.path === '/anuncios') {
                    setAnunciosOpen(o => !o);
                    setEstoqueOpen(false); setSalesOpen(false); setAtendimentoOpen(false); setSalesReportOpen(false);
                  } else if (item.path === '/atendimento') {
                    setAtendimentoOpen(o => !o);
                    setEstoqueOpen(false); setSalesOpen(false); setAnunciosOpen(false); setSalesReportOpen(false);
                  } else if (item.path === '/sales-report') {
                    setSalesReportOpen(o => !o);
                    setEstoqueOpen(false); setSalesOpen(false); setAnunciosOpen(false); setAtendimentoOpen(false);
                  } else {
                    setEstoqueOpen(false); setSalesOpen(false); setAnunciosOpen(false); setAtendimentoOpen(false);
                    setSalesReportOpen(false);
                  }
                }}
                title={collapsed ? item.label : undefined}
              >
                <div className="relative flex-shrink-0">
                  <item.icon className="w-5 h-5" />
                  {item.path === '/atendimento' && unansweredCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 flex items-center justify-center bg-red-400/90 text-white text-[9px] font-bold rounded-full px-1 animate-pulse">
                      {unansweredCount > 99 ? '99+' : unansweredCount}
                    </span>
                  )}
                </div>
                {!collapsed && <span className="text-sm">{item.label}</span>}
              </Link>

              {!collapsed && item.path === '/inventory' && (location.pathname.startsWith('/inventory') || estoqueOpen) && (
                <ul className={`ml-10 mt-0.5 space-y-0.5 overflow-hidden transition-all duration-200 ${estoqueOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  {estoqueSubmenu.map(sub => {
                    const active = new URLSearchParams(location.search).get('tab') === sub.tab || (!location.search && sub.tab === 'itens');
                    return (
                      <li key={sub.tab}>
                        <button
                          className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${active ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                          onClick={() => navigate(`/inventory?tab=${sub.tab}`)}
                        >
                          {sub.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!collapsed && item.path === '/sales' && (location.pathname.startsWith('/sales') || salesOpen) && (
                <ul className={`ml-10 mt-0.5 space-y-0.5 overflow-hidden transition-all duration-200 ${salesOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  {salesSubmenu.map(sub => {
                    const active = new URLSearchParams(location.search).get('tab') === sub.tab || (!location.search && sub.tab === 'notas');
                    return (
                      <li key={sub.tab}>
                        <button
                          className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${active ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                          onClick={() => navigate(`/sales?tab=${sub.tab}`)}
                        >
                          {sub.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!collapsed && item.path === '/anuncios' && (location.pathname.startsWith('/anuncios') || anunciosOpen) && (
                <ul className={`ml-10 mt-0.5 space-y-0.5 overflow-hidden transition-all duration-200 ${anunciosOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  {anunciosSubmenu.map(sub => {
                    const active = new URLSearchParams(location.search).get('tab') === sub.tab || (!location.search && sub.tab === 'ativos');
                    return (
                      <li key={sub.tab}>
                        <button
                          className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${active ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                          onClick={() => navigate(`/anuncios?tab=${sub.tab}`)}
                        >
                          {sub.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!collapsed && item.path === '/atendimento' && (location.pathname.startsWith('/atendimento') || atendimentoOpen) && (
                <ul className={`ml-10 mt-0.5 space-y-0.5 overflow-hidden transition-all duration-200 ${atendimentoOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  {atendimentoSubmenu.map(sub => {
                    const active = new URLSearchParams(location.search).get('tab') === sub.tab || (!location.search && sub.tab === 'pre-venda');
                    return (
                      <li key={sub.tab}>
                        <button
                          className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${active ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                          onClick={() => navigate(`/atendimento?tab=${sub.tab}`)}
                        >
                          {sub.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {!collapsed && item.path === '/sales-report' && (location.pathname.startsWith('/sales-report') || salesReportOpen) && (
                <ul className={`ml-10 mt-0.5 space-y-0.5 overflow-hidden transition-all duration-200 ${salesReportOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  <li>
                    <button
                      className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${(new URLSearchParams(location.search).get('tab') || 'vendas') === 'vendas' ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                      onClick={() => navigate('/sales-report?tab=vendas')}
                    >
                      Vendas
                    </button>
                  </li>
                  {user.role === 4 && (
                    <li>
                      <button
                        className={`text-left text-xs px-2.5 py-1.5 rounded-md w-full transition-colors ${new URLSearchParams(location.search).get('tab') === 'reposicao' ? 'bg-blue-50/70 dark:bg-blue-800/40 text-blue-600 dark:text-blue-200 font-semibold' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700/50 hover:text-gray-800 dark:hover:text-gray-200'}`}
                        onClick={() => navigate('/sales-report?tab=reposicao')}
                      >
                        Reposição de Estoque
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Bottom section */}
      <div className="border-t border-gray-100 dark:border-gray-700 p-2">
        {!collapsed && user && (
          <div className="px-2 py-2 mb-2">
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{user.name}</div>
            <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{user.email}</div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={toggleDarkMode}
                className="p-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                title={userSettings?.darkMode ? 'Modo Claro' : 'Modo Escuro'}
              >
                {userSettings?.darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={onLogout}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium text-red-500 dark:text-red-400 bg-red-50/60 dark:bg-red-900/15 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sair
              </button>
            </div>
          </div>
        )}

        {collapsed && user && (
          <div className="flex flex-col items-center gap-1.5 py-1">
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              title={userSettings?.darkMode ? 'Modo Claro' : 'Modo Escuro'}
            >
              {userSettings?.darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              title="Sair"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}

        <button
          className={`w-full flex items-center justify-center py-2 rounded-lg text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300 transition-colors`}
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? 'Expandir menu' : 'Recolher menu'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};
