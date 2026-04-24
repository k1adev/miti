import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import SalesReport from './SalesReport';
import ReplenishmentReport from './ReplenishmentReport';
import FactoryOrdersTab from './FactoryOrdersTab';
import OrderCostsReport from './OrderCostsReport';
import { BarChart2, Package, Factory, DollarSign } from 'lucide-react';

const SalesReportPage = ({ user }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const role = Number(user?.role || 0);
  const tab = new URLSearchParams(location.search).get('tab') || 'vendas';
  const canSeeReposicao = role >= 2;
  const canSeeLotes = role >= 2;
  const canSeeVendas = role >= 3;
  const canSeeCustos = role >= 3;

  /** Quando o usuário clica "Criar lote com selecionados" na aba de Reposição,
   * este estado transporta os itens até a aba de Lotes (consumido no mount). */
  const [pendingCreate, setPendingCreate] = useState(null);

  useEffect(() => {
    if (tab === 'vendas' && !canSeeVendas) {
      navigate('/sales-report?tab=reposicao', { replace: true });
    } else if (tab === 'reposicao' && !canSeeReposicao) {
      navigate('/sales-report?tab=lotes', { replace: true });
    } else if (tab === 'lotes' && !canSeeLotes) {
      navigate('/sales-report?tab=vendas', { replace: true });
    } else if (tab === 'custos' && !canSeeCustos) {
      navigate('/sales-report?tab=vendas', { replace: true });
    }
  }, [tab, canSeeVendas, canSeeReposicao, canSeeLotes, canSeeCustos, navigate]);

  const goTab = (key) => {
    const params = new URLSearchParams(location.search);
    params.set('tab', key);
    navigate(`/sales-report?${params.toString()}`);
  };

  const triggerCreateLote = (items) => {
    setPendingCreate({ items });
    goTab('lotes');
  };

  const tabs = [
    canSeeVendas && { key: 'vendas', label: 'Vendas', Icon: BarChart2 },
    canSeeReposicao && { key: 'reposicao', label: 'Reposição de Estoque', Icon: Package },
    canSeeLotes && { key: 'lotes', label: 'Lote', Icon: Factory },
    canSeeCustos && { key: 'custos', label: 'Custos de Pedido', Icon: DollarSign },
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Relatório</h1>

      <div className="flex items-center gap-2 flex-wrap">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => goTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
              tab === t.key
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
            }`}
          >
            <t.Icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'vendas' && canSeeVendas && <SalesReport />}
      {tab === 'reposicao' && canSeeReposicao && (
        <ReplenishmentReport user={user} onCreateLote={triggerCreateLote} />
      )}
      {tab === 'lotes' && canSeeLotes && (
        <FactoryOrdersTab
          user={user}
          initialCreate={pendingCreate}
          onCreateConsumed={() => setPendingCreate(null)}
        />
      )}
      {tab === 'custos' && canSeeCustos && <OrderCostsReport user={user} />}
    </div>
  );
};

export default SalesReportPage;
