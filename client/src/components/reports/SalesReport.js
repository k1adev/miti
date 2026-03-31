import React, { useEffect, useMemo, useState, useCallback } from 'react';
import axios from 'axios';
import { Download, FileSpreadsheet, FileText, ShoppingCart, ChevronDown, ChevronRight, Search, BarChart2, Loader2, Inbox } from 'lucide-react';

const NumberCell = ({ value }) => (
  <span>{Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
);

const STORAGE_KEY = 'sales_report_filters';
const MARKETPLACES_COMUNS = ['Shopee', 'Mercado Livre', 'Mercado Livre Full', 'Magalu', 'Amazon', 'Olist', 'Shein', 'Madeira & Madeira', 'Leroy Merlin', 'TikTok Shop', 'Outros', 'Desconhecido'];

const getMkBadgeColor = (mk) => {
  const colors = {
    'Shopee': 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
    'Mercado Livre': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300',
    'Mercado Livre Full': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    'Magalu': 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    'Amazon': 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  };
  return colors[mk] || 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300';
};

const getMkBorderColor = (mk) => {
  const borders = {
    'Shopee': 'border-l-orange-500',
    'Mercado Livre': 'border-l-yellow-500',
    'Mercado Livre Full': 'border-l-amber-500',
    'Magalu': 'border-l-red-500',
    'Amazon': 'border-l-sky-500',
  };
  return borders[mk] || 'border-l-gray-400';
};

const Section = ({ title, right, children }) => (
  <div className="bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
    <div className="flex items-center justify-between mb-6">
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
        <BarChart2 className="w-6 h-6 text-blue-600 dark:text-blue-400" />
        {title}
      </h2>
      {right}
    </div>
    {children}
  </div>
);

const SalesReport = () => {
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const dd = String(hoje.getDate()).padStart(2, '0');
  const dataHoje = `${yyyy}-${mm}-${dd}`;

  const loadFilters = () => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      if (s) {
        const o = JSON.parse(s);
        return {
          dataInicio: o.dataInicio || dataHoje,
          dataFim: o.dataFim || dataHoje,
          marketplace: o.marketplace || '',
          skuFiltro: o.skuFiltro || '',
          ordenacaoSkus: o.ordenacaoSkus || 'faturamento',
          mostrarSomenteComSkus: o.mostrarSomenteComSkus || false,
          activeAccountId: o.activeAccountId || 'all',
        };
      }
    } catch {}
    return {
      dataInicio: dataHoje,
      dataFim: dataHoje,
      marketplace: '',
      skuFiltro: '',
      ordenacaoSkus: 'faturamento',
      mostrarSomenteComSkus: false,
      activeAccountId: 'all',
    };
  };

  const [filters, setFilters] = useState(loadFilters);
  const { dataInicio, dataFim, marketplace, skuFiltro, ordenacaoSkus, mostrarSomenteComSkus, activeAccountId } = filters;
  const updateFilter = (k, v) => {
    setFilters(prev => {
      const next = { ...prev, [k]: v };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const [collapsedByMk, setCollapsedByMk] = useState({});
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [blingAccounts, setBlingAccounts] = useState([]);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exporting, setExporting] = useState(false);

  const agg = useMemo(() => {
    const totalPedidos = rows.reduce((a, r) => a + (r.pedidos || 0), 0);
    const totalItens = rows.reduce((a, r) => a + Number(r.itens || 0), 0);
    const totalFaturamento = rows.reduce((a, r) => a + Number(r.faturamento || 0), 0);
    const ticketMedio = totalPedidos > 0 ? totalFaturamento / totalPedidos : 0;
    const itensPorPedido = totalPedidos > 0 ? totalItens / totalPedidos : 0;
    return { totalPedidos, totalItens, totalFaturamento, ticketMedio, itensPorPedido };
  }, [rows]);

  const marketplaceOptions = useMemo(() => {
    const fromRows = [...new Set((rows || []).map(r => r.marketplace).filter(Boolean))];
    const combined = [...new Set([...MARKETPLACES_COMUNS, ...fromRows])].filter(Boolean).sort((a, b) => a.localeCompare(b));
    return combined;
  }, [rows]);

  const rowsFiltradas = useMemo(() => {
    const termoSku = (skuFiltro || '').trim().toLowerCase();
    const orderByReceita = ordenacaoSkus === 'faturamento';
    const filtradas = (rows || []).map(mk => {
      const skus = (mk.skus || []).filter(it => {
        if (!termoSku) return true;
        const sku = String(it.sku || '').toLowerCase();
        const titulo = String(it.title || '').toLowerCase();
        return sku.includes(termoSku) || titulo.includes(termoSku);
      }).sort((a, b) => {
        if (orderByReceita) return (b.faturamento - a.faturamento) || (b.quantidade - a.quantidade);
        return (b.quantidade - a.quantidade) || (b.faturamento - a.faturamento);
      });
      return { ...mk, skus };
    });
    return mostrarSomenteComSkus ? filtradas.filter(mk => (mk.skus || []).length > 0) : filtradas;
  }, [rows, skuFiltro, ordenacaoSkus, mostrarSomenteComSkus]);

  const buscar = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dataInicio) qs.set('dataInicio', dataInicio);
      if (dataFim) qs.set('dataFim', dataFim);
      if (marketplace) qs.set('marketplace', marketplace);
      if (activeAccountId && activeAccountId !== 'all') qs.set('accountId', activeAccountId);
      const res = await axios.get(`/api/reports/sales?${qs.toString()}`);
      setRows(res.data.marketplaces || []);
      setCollapsedByMk({});
    } finally { setLoading(false); }
  }, [dataInicio, dataFim, marketplace, activeAccountId]);

  useEffect(() => { buscar(); }, [buscar]);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await axios.get('/api/bling/accounts');
        const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
        if (!mounted) return;
        setBlingAccounts(accounts);
      } catch {
        if (mounted) setBlingAccounts([]);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') buscar();
  };

  const exportCsvItens = () => {
    const header = ['Marketplace','SKU','Título','Qtd','Receita'];
    const data = [];
    for (const mk of rows) {
      for (const it of (mk.skus || [])) {
        data.push([mk.marketplace, it.sku, it.title || '', it.quantidade, Number(it.faturamento||0).toFixed(2)]);
      }
    }
    const escape = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const csv = [header, ...data].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'relatorio_vendas_itens.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportCsvPedidos = async () => {
    const qs = new URLSearchParams();
    if (dataInicio) qs.set('dataInicio', dataInicio);
    if (dataFim) qs.set('dataFim', dataFim);
    if (marketplace) qs.set('marketplace', marketplace);
    if (activeAccountId && activeAccountId !== 'all') qs.set('accountId', activeAccountId);
    const res = await axios.get(`/api/reports/sales/orders?${qs.toString()}`);
    const orders = res.data.orders || [];
    const header = ['Marketplace','NF','Data','Itens','Faturamento'];
    const rowsCsv = [header, ...orders.map(o => [o.marketplace, o.nota_id, o.data, o.itens, Number(o.faturamento||0).toFixed(2)])];
    const csv = rowsCsv.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'relatorio_vendas_pedidos.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const exportXlsx = async () => {
    setExporting(true);
    try {
      const qs = new URLSearchParams();
      if (dataInicio) qs.set('dataInicio', dataInicio);
      if (dataFim) qs.set('dataFim', dataFim);
      if (marketplace) qs.set('marketplace', marketplace);
      if (activeAccountId && activeAccountId !== 'all') qs.set('accountId', activeAccountId);
      const res = await axios.get(`/api/export/sales.xlsx?${qs.toString()}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `relatorio_vendas_${dataInicio}_${dataFim}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Erro ao exportar Excel:', e);
    } finally { setExporting(false); setShowExportMenu(false); }
  };

  const toggleCollapse = (marketplaceName) => {
    setCollapsedByMk(prev => ({ ...prev, [marketplaceName]: !prev[marketplaceName] }));
  };

  const setAllCollapsed = (value) => {
    const next = {};
    (rowsFiltradas || []).forEach(mk => { next[mk.marketplace] = value; });
    setCollapsedByMk(next);
  };

  const statCards = [
    { label: 'Pedidos', value: agg.totalPedidos, valueClass: 'text-blue-700 dark:text-blue-400', icon: ShoppingCart, tooltip: 'Total de pedidos no período selecionado' },
    { label: 'Itens', value: agg.totalItens, valueClass: 'text-indigo-700 dark:text-indigo-400', tooltip: 'Total de itens vendidos no período' },
    { label: 'Faturamento', value: `R$ ${Number(agg.totalFaturamento).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, valueClass: 'text-emerald-700 dark:text-emerald-400', tooltip: 'Receita total das vendas' },
    { label: 'Ticket médio', value: `R$ ${Number(agg.ticketMedio).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, valueClass: 'text-sky-700 dark:text-sky-400', tooltip: 'Valor médio por pedido (faturamento ÷ pedidos)' },
    { label: 'Itens/pedido', value: Number(agg.itensPorPedido).toFixed(2), valueClass: 'text-purple-700 dark:text-purple-400', tooltip: 'Média de itens por pedido' },
  ];

  return (
    <div className="space-y-6">
      <Section
        title="Relatório de Vendas por Marketplace"
        right={
          <div className="flex gap-2 items-center">
            <div className="relative">
              <button
                className="btn-secondary flex items-center gap-2"
                onClick={() => setShowExportMenu(v => !v)}
                disabled={exporting}
              >
                <Download className="w-4 h-4" />
                Exportar {exporting ? '...' : '▼'}
              </button>
              {showExportMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                  <div className="absolute right-0 mt-1 py-1 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-xl z-20 min-w-[180px]">
                    <button className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-sm dark:text-gray-200" onClick={exportXlsx} disabled={exporting}>
                      <FileSpreadsheet className="w-4 h-4 text-emerald-600" /> Excel
                    </button>
                    <button className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-sm dark:text-gray-200" onClick={() => { exportCsvItens(); setShowExportMenu(false); }}>
                      <FileText className="w-4 h-4 text-blue-600" /> CSV Itens
                    </button>
                    <button className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-sm dark:text-gray-200" onClick={() => { exportCsvPedidos(); setShowExportMenu(false); }}>
                      <FileText className="w-4 h-4 text-indigo-600" /> CSV Pedidos
                    </button>
                  </div>
                </>
              )}
            </div>
            <button className="btn-primary flex items-center gap-2" onClick={buscar} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {loading ? 'Carregando...' : 'Buscar'}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4" onKeyDown={handleKeyDown}>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Data inicial</label>
            <input type="date" className="input-field w-full" value={dataInicio} onChange={e=>updateFilter('dataInicio', e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Data final</label>
            <input type="date" className="input-field w-full" value={dataFim} onChange={e=>updateFilter('dataFim', e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Marketplace</label>
            <select className="input-field w-full" value={marketplace} onChange={e=>updateFilter('marketplace', e.target.value)}>
              <option value="">Todos</option>
              {marketplaceOptions.map(mk => (
                <option key={mk} value={mk}>{mk}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">SKU/Título</label>
            <input type="text" className="input-field w-full" placeholder="Filtrar itens" value={skuFiltro} onChange={e=>updateFilter('skuFiltro', e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-gray-300 mb-1">Conta</label>
            <select className="input-field w-full" value={activeAccountId} onChange={e=>updateFilter('activeAccountId', e.target.value)}>
              <option value="all">Todas</option>
              {blingAccounts.map(acc => (
                <option key={acc.id} value={String(acc.id)}>{acc.name}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full h-10 flex items-center justify-center gap-2" onClick={buscar} disabled={loading}>
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              {loading ? 'Carregando...' : 'Buscar'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {[1,2,3,4,5].map(i => (
              <div key={i} className="h-24 bg-gray-200 dark:bg-gray-700 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {statCards.map((s, i) => (
              <div key={i} className="group relative bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4 flex flex-col items-center text-center shadow-sm hover:shadow-md transition-shadow">
                {s.tooltip && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 dark:bg-gray-700 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10 shadow-lg">
                    {s.tooltip}
                    <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900 dark:border-t-gray-700" />
                  </div>
                )}
                {s.icon && <s.icon className="w-6 h-6 text-blue-600 dark:text-blue-400 mb-1" />}
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{s.label}</div>
                <div className={`text-lg font-bold mt-1 ${s.valueClass}`}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600 dark:text-gray-300">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={mostrarSomenteComSkus} onChange={e=>updateFilter('mostrarSomenteComSkus', e.target.checked)} className="rounded" />
              Mostrar somente marketplaces com itens
            </label>
            <div className="flex items-center gap-2">
              <span>Ordenar itens por:</span>
              <select className="input-field text-sm h-9" value={ordenacaoSkus} onChange={e=>updateFilter('ordenacaoSkus', e.target.value)}>
                <option value="faturamento">Receita</option>
                <option value="quantidade">Quantidade</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-secondary text-sm py-1.5 px-3" onClick={()=>setAllCollapsed(false)}>Expandir tudo</button>
            <button className="btn-secondary text-sm py-1.5 px-3" onClick={()=>setAllCollapsed(true)}>Recolher tudo</button>
          </div>
        </div>

        <div className="space-y-4">
          {rowsFiltradas.map((mk) => (
            <div key={mk.marketplace} className={`border border-gray-200 dark:border-gray-700 border-l-4 ${getMkBorderColor(mk.marketplace)} rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow`}>
              <div
                className="px-4 py-3 flex items-center justify-between bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                onClick={() => toggleCollapse(mk.marketplace)}
              >
                <div className="font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                  {collapsedByMk[mk.marketplace] ? (
                    <ChevronRight className="w-5 h-5 text-gray-500" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-500" />
                  )}
                  <span className={`px-2.5 py-0.5 rounded-full text-sm font-medium ${getMkBadgeColor(mk.marketplace)}`}>
                    {mk.marketplace}
                  </span>
                </div>
                <div className="text-sm text-gray-700 dark:text-gray-300 flex gap-6">
                  <span><strong>Pedidos:</strong> {mk.pedidos}</span>
                  <span><strong>Itens:</strong> {mk.itens}</span>
                  <span><strong>Faturamento:</strong> R$ <NumberCell value={mk.faturamento} /></span>
                </div>
              </div>
              <div
                className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                style={{ gridTemplateRows: collapsedByMk[mk.marketplace] ? '0fr' : '1fr' }}
              >
                <div className="min-h-0 overflow-x-auto overflow-y-hidden">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-100 dark:bg-gray-900">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase">SKU</th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase">Título</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase">Qtd</th>
                        <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase">Receita</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {(mk.skus || []).map(it => (
                        <tr key={`${mk.marketplace}-${it.sku}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                          <td className="px-4 py-3 text-sm font-medium text-gray-800 dark:text-gray-100">{it.sku}</td>
                          <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">{it.title || '-'}</td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-gray-800 dark:text-gray-100">{Number(it.quantidade || 0)}</td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-emerald-700 dark:text-emerald-400"><NumberCell value={it.faturamento} /></td>
                        </tr>
                      ))}
                      {(mk.skus || []).length === 0 && (
                        <tr><td colSpan={4} className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">Nenhum item para este filtro.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
          {rowsFiltradas.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-16 px-6 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-xl bg-gray-50/50 dark:bg-gray-800/30">
              <Inbox className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" strokeWidth={1.25} />
              <p className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-1">Nenhum registro encontrado</p>
              <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-md">
                Não há vendas para o período e filtros selecionados. Tente ampliar o intervalo de datas ou alterar o marketplace.
              </p>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
};

export default SalesReport;
