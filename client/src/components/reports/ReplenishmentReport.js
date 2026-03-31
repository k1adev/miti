import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { Package, AlertCircle, AlertTriangle, TrendingUp, Loader2, RefreshCw, Download, Calendar } from 'lucide-react';
import { DateRangePicker } from '../DateRangePicker';

const STORAGE_KEY = 'replenishment_semanas_cobertura';
const STORAGE_DATA_INICIO = 'replenishment_dataInicio';
const STORAGE_DATA_FIM = 'replenishment_dataFim';

const ALERTA_LABELS = {
  zerado: { label: 'Estoque zerado', color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', icon: AlertCircle },
  critico: { label: 'Crítico (<7 dias)', color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', icon: AlertTriangle },
  atencao: { label: 'Atenção (<14 dias)', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', icon: AlertTriangle },
  alto_giro: { label: 'Alto giro', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300', icon: TrendingUp },
};

const loadSemanasCobertura = () => {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    return Number.isFinite(v) && v >= 1 && v <= 12 ? v : 2;
  } catch { return 2; }
};

const loadDataRange = () => {
  try {
    const ini = localStorage.getItem(STORAGE_DATA_INICIO) || '';
    const fim = localStorage.getItem(STORAGE_DATA_FIM) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(ini) && /^\d{4}-\d{2}-\d{2}$/.test(fim) && ini <= fim) {
      return { dataInicio: ini, dataFim: fim };
    }
  } catch {}
  return { dataInicio: '', dataFim: '' };
};

const ReplenishmentReport = () => {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [alertas, setAlertas] = useState([]);
  const [config, setConfig] = useState({});
  const [filtro, setFiltro] = useState('todos');
  const [semanasCobertura, setSemanasCobertura] = useState(loadSemanasCobertura);
  const [dataInicio, setDataInicio] = useState(() => loadDataRange().dataInicio);
  const [dataFim, setDataFim] = useState(() => loadDataRange().dataFim);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const datePickerRef = useRef(null);

  const carregar = useCallback(async () => {
    setLoading(true);
    try {
      const params = { semanasCobertura };
      if (dataInicio && dataFim) {
        params.dataInicio = dataInicio;
        params.dataFim = dataFim;
      }
      const rep = await axios.get('/api/reports/replenishment', { params });
      setItems(rep.data.items || []);
      setAlertas(rep.data.alertas || []);
      setConfig(rep.data.config || {});
    } catch (e) {
      console.error('Erro ao carregar reposição:', e);
      setItems([]);
      setAlertas([]);
    } finally {
      setLoading(false);
    }
  }, [semanasCobertura, dataInicio, dataFim]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    if (!showDatePicker) return;
    const handleClickOutside = (e) => {
      if (datePickerRef.current && !datePickerRef.current.contains(e.target)) {
        setShowDatePicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDatePicker]);

  const handleSemanasChange = (v) => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 12) {
      setSemanasCobertura(n);
      try { localStorage.setItem(STORAGE_KEY, String(n)); } catch {}
    }
  };

  const handleDateRangeChange = (ini, fim) => {
    setDataInicio(ini);
    setDataFim(fim || ini);
    try {
      if (ini) localStorage.setItem(STORAGE_DATA_INICIO, ini);
      if (fim || ini) localStorage.setItem(STORAGE_DATA_FIM, fim || ini);
    } catch {}
    setShowDatePicker(false);
  };

  const clearDateRange = () => {
    setDataInicio('');
    setDataFim('');
    try {
      localStorage.removeItem(STORAGE_DATA_INICIO);
      localStorage.removeItem(STORAGE_DATA_FIM);
    } catch {}
    setShowDatePicker(false);
  };

  const exportCsv = () => {
    const header = config.diasPeriodo
      ? ['SKU', 'Título', 'Saldo', 'Vendas (período)', 'Média/dia', 'Cobertura (dias)', 'Qtd Sugerida', 'Alerta']
      : ['SKU', 'Título', 'Saldo', 'Vendas 7d', 'Vendas 30d', 'Média/dia', 'Cobertura (dias)', 'Qtd Sugerida', 'Alerta'];
    const rows = filtrados.map(i =>
      config.diasPeriodo
        ? [i.sku, i.title || '', i.saldo, i.vendas30, i.mediaDiaria, i.coberturaDias, i.qtdSugerida, ALERTA_LABELS[i.alerta]?.label || '']
        : [i.sku, i.title || '', i.saldo, i.vendas7, i.vendas30, i.mediaDiaria, i.coberturaDias, i.qtdSugerida, ALERTA_LABELS[i.alerta]?.label || '']
    );
    const csv = [header, ...rows].map(r => r.map(v => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'reposicao_estoque.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const baseFiltrados = filtro === 'todos' ? items : filtro === 'alertas' ? alertas : items.filter(i => i.qtdSugerida > 0);
  const filtrados = [...baseFiltrados].sort((a, b) => (b.qtdSugerida || 0) - (a.qtdSugerida || 0));
  const totalPages = Math.max(1, Math.ceil(filtrados.length / pageSize));
  const paginated = filtrados.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [filtro, dataInicio, dataFim, semanasCobertura]);

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Package className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            Reposição de Estoque
          </h2>
          <div className="flex items-center gap-2">
            <button className="btn-secondary flex items-center gap-2" onClick={carregar} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
            <button className="btn-secondary flex items-center gap-2" onClick={exportCsv} disabled={loading}>
              <Download className="w-4 h-4" />
              Exportar CSV
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-600 dark:text-gray-400">Semanas de cobertura:</label>
            <select
              className="input-field w-20"
              value={semanasCobertura}
              onChange={e => handleSemanasChange(e.target.value)}
              disabled={loading}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => (
                <option key={n} value={n}>{n} {n === 1 ? 'semana' : 'semanas'}</option>
              ))}
            </select>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-500">
            Saldo ÷ Média diária = cobertura. Qtd sugerida = {semanasCobertura} sem. × 7 dias.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 mb-4">
          <div className="relative" ref={datePickerRef}>
            <button
              type="button"
              onClick={() => setShowDatePicker(v => !v)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                dataInicio && dataFim
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <Calendar className="w-4 h-4" />
              {dataInicio && dataFim
                ? `${dataInicio.split('-').reverse().join('/')} – ${dataFim.split('-').reverse().join('/')}`
                : 'Data personalizada'}
            </button>
            {showDatePicker && (
              <DateRangePicker
                dataInicio={dataInicio}
                dataFim={dataFim}
                onChange={handleDateRangeChange}
                onClose={() => setShowDatePicker(false)}
              />
            )}
          </div>
          {dataInicio && dataFim && (
            <button
              type="button"
              onClick={clearDateRange}
              className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Limpar datas
            </button>
          )}
          <select className="input-field w-48" value={filtro} onChange={e => setFiltro(e.target.value)}>
            <option value="todos">Todos os itens</option>
            <option value="alertas">Com alerta</option>
            <option value="sugeridos">Com qtd sugerida &gt; 0</option>
          </select>
        </div>

        {config.diasPeriodo > 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-500 mb-4">
            Vendas no período: {config.dataInicio?.split('-').reverse().join('/')} a {config.dataFim?.split('-').reverse().join('/')} ({config.diasPeriodo} dias).
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="py-3 pr-4">SKU</th>
                  <th className="py-3 pr-4">Título</th>
                  <th className="py-3 pr-2 text-right">Saldo</th>
                  {config.diasPeriodo ? (
                    <th className="py-3 pr-2 text-right">Vendas (período)</th>
                  ) : (
                    <>
                      <th className="py-3 pr-2 text-right">Vendas 7d</th>
                      <th className="py-3 pr-2 text-right">Vendas 30d</th>
                    </>
                  )}
                  <th className="py-3 pr-2 text-right">Média/dia</th>
                  <th className="py-3 pr-2 text-right">Cobertura</th>
                  <th className="py-3 pr-2 text-right font-semibold">Qtd Sugerida</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(i => (
                  <tr
                    key={i.id}
                    className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
                      i.alerta ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''
                    }`}
                  >
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{i.sku}</span>
                        {i.alerta && (
                          <span className={`px-2 py-0.5 rounded text-xs ${ALERTA_LABELS[i.alerta]?.color || ''}`}>
                            {ALERTA_LABELS[i.alerta]?.label || i.alerta}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-gray-700 dark:text-gray-300 max-w-[200px] truncate" title={i.title}>
                      {i.title || '-'}
                    </td>
                    <td className="py-2 pr-2 text-right">{i.saldo}</td>
                    {config.diasPeriodo ? (
                      <td className="py-2 pr-2 text-right">{i.vendas30}</td>
                    ) : (
                      <>
                        <td className="py-2 pr-2 text-right">{i.vendas7}</td>
                        <td className="py-2 pr-2 text-right">{i.vendas30}</td>
                      </>
                    )}
                    <td className="py-2 pr-2 text-right">{i.mediaDiaria}</td>
                    <td className="py-2 pr-2 text-right">{i.coberturaDias < 999 ? `${i.coberturaDias} dias` : '-'}</td>
                    <td className="py-2 pr-2 text-right font-semibold text-blue-600 dark:text-blue-400">
                      {i.qtdSugerida > 0 ? i.qtdSugerida : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtrados.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                Nenhum item encontrado para o filtro selecionado.
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Exibindo {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtrados.length)} de {filtrados.length} itens
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-3 py-1.5 rounded border text-sm text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Anterior
                  </button>
                  <span className="text-sm text-gray-600 dark:text-gray-400">
                    Página {page} de {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="px-3 py-1.5 rounded border text-sm text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Próxima
                  </button>
                  <select
                    value={pageSize}
                    onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
                    className="ml-2 border rounded text-sm px-2 py-1.5 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                  >
                    {[15, 25, 50, 100, 200].map(n => (
                      <option key={n} value={n}>{n} por página</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReplenishmentReport;
