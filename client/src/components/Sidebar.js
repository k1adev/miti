import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Home, Users, Globe, Activity, ShoppingCart, Archive, LogOut, ChevronDown, ChevronRight } from 'lucide-react';

export const Sidebar = ({ user, onSelectEstoqueTab, activeEstoqueTab, onLogout, toggleDarkMode, userSettings }) => {
  const location = useLocation();
  const [estoqueOpen, setEstoqueOpen] = useState(location.pathname.startsWith('/inventory'));
  const navigate = useNavigate();

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
      ];
    } else if (user.role === 3) {
      menuItems = [
        { path: '/', label: 'Início', icon: Home },
        { path: '/inventory', label: 'Estoque', icon: Archive },
        { path: '/sales', label: 'Pedidos', icon: ShoppingCart },
        { path: '/external-apis', label: 'APIs Externas', icon: Globe },
      ];
    } else if (user.role === 4) {
      menuItems = [
        { path: '/', label: 'Início', icon: Home },
        { path: '/inventory', label: 'Estoque', icon: Archive },
        { path: '/sales', label: 'Pedidos', icon: ShoppingCart },
        { path: '/status', label: 'Status', icon: Activity },
        { path: '/users', label: 'Usuários', icon: Users },
        { path: '/external-apis', label: 'APIs Externas', icon: Globe },
      ];
    }
  }

  // Submenu do Estoque
  const estoqueSubmenu = [
    { tab: 'itens', label: 'Itens em Estoque' },
    { tab: 'compostos', label: 'SKUs Compostos' },
    { tab: 'movimentacao', label: 'Movimentação' },
  ];

  const handleEstoqueSubmenu = (tab) => {
    navigate(`/inventory?tab=${tab}`);
  };

  return (
    <div className="w-64 bg-white dark:bg-gray-800 shadow-lg sidebar flex flex-col h-screen">
      <div className="p-6 flex flex-col items-center">
        <img 
          src={process.env.PUBLIC_URL + (userSettings?.darkMode ? '/miti-logo-white.png' : '/miti-logo.png')} 
          alt="Logo Miti" 
          className="h-20 w-auto mb-1" 
        />
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-0">Gestão e inovação</p>
      </div>
      <nav className="mt-6 flex-1">
        <ul className="space-y-2">
          {menuItems.map(item => (
            <li key={item.path}>
              <div>
                <Link
                  to={item.path}
                  className={`flex items-center px-6 py-3 text-sm font-medium transition-colors duration-200 ${location.pathname === item.path ? 'bg-blue-50 dark:bg-blue-900 text-blue-700 dark:text-blue-300 border-r-2 border-blue-700' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white'}`}
                  onClick={() => {
                    if (item.path === '/inventory') setEstoqueOpen(!estoqueOpen);
                  }}
                >
                  <item.icon className="w-5 h-5 mr-3" />
                  {item.label}
                </Link>
                {/* Submenu Estoque */}
                {item.path === '/inventory' && (location.pathname.startsWith('/inventory') || estoqueOpen) && (
                  <ul className="ml-8 mt-1 space-y-1">
                    {estoqueSubmenu.map(sub => (
                      <li key={sub.tab}>
                        <button
                          className={`text-left text-sm px-2 py-1 rounded w-full ${new URLSearchParams(location.search).get('tab') === sub.tab || (!location.search && sub.tab === 'itens') ? 'bg-blue-100 dark:bg-blue-800 text-blue-800 dark:text-blue-200 font-semibold' : 'text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900'}`}
                          onClick={() => handleEstoqueSubmenu(sub.tab)}
                        >
                          {sub.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto p-4 border-t border-gray-200 dark:border-gray-600">
        {user && (
          <>
            <div className="mb-2 text-xs text-gray-700 dark:text-gray-300 flex flex-col gap-1">
              <div className="font-semibold">{user.name}</div>
              <div className="text-gray-500 dark:text-gray-400">{user.email}</div>
              <button
                onClick={toggleDarkMode}
                className={`mt-2 px-3 py-1 rounded text-xs font-semibold border ${userSettings?.darkMode ? 'bg-blue-700 text-white border-blue-700' : 'bg-gray-100 text-gray-700 border-gray-300'}`}
                style={{ width: 'fit-content' }}
              >
                {userSettings?.darkMode ? 'Modo Claro' : 'Modo Escuro'}
              </button>
            </div>
            <button onClick={onLogout} className="btn-secondary py-1 px-4 text-sm rounded mt-2">Sair</button>
          </>
        )}
      </div>
    </div>
  );
}; 