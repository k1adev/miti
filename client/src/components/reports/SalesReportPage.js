import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import SalesReport from './SalesReport';
import ReplenishmentReport from './ReplenishmentReport';
import { BarChart2, Package } from 'lucide-react';

const SalesReportPage = ({ user }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = new URLSearchParams(location.search).get('tab') || 'vendas';
  const isAdmin = user && user.role === 4;

  useEffect(() => {
    if (tab === 'reposicao' && !isAdmin) {
      navigate('/sales-report?tab=vendas', { replace: true });
    }
  }, [tab, isAdmin, navigate]);

  const goTab = (key) => {
    const params = new URLSearchParams(location.search);
    params.set('tab', key);
    navigate(`/sales-report?${params.toString()}`);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Relatório</h1>

      <div className="flex items-center gap-2">
        <button
          onClick={() => goTab('vendas')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
            tab === 'vendas'
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <BarChart2 className="w-4 h-4" />
          Vendas
        </button>
        {isAdmin && (
          <button
            onClick={() => goTab('reposicao')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
              tab === 'reposicao'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            <Package className="w-4 h-4" />
            Reposição de Estoque
          </button>
        )}
      </div>

      {tab === 'vendas' && <SalesReport />}
      {tab === 'reposicao' && isAdmin && <ReplenishmentReport />}
    </div>
  );
};

export default SalesReportPage;
