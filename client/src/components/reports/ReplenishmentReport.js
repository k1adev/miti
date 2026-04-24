import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import * as XLSX from 'xlsx';
import {
  Package, AlertCircle, AlertTriangle, TrendingUp, Loader2, RefreshCw,
  Download, Calendar, Search, X, Factory, PackagePlus, Info, Layers
} from 'lucide-react';
import { DateRangePicker } from '../DateRangePicker';

const STORAGE_KEY = 'replenishment_semanas_cobertura';
const STORAGE_DATA_INICIO = 'replenishment_dataInicio';
const STORAGE_DATA_FIM = 'replenishment_dataFim';

const ALERTA_META = {
  zerado: { label: 'Estoque zerado', short: 'Zerado', color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', border: 'border-l-red-500', icon: AlertCircle, priority: 0 },
  critico: { label: 'Crítico (<7 dias)', short: 'Crítico (<7 dias)', color: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', border: 'border-l-red-400', icon: AlertTriangle, priority: 1 },
  atencao: { label: 'Atenção (<14 dias)', short: 'Atenção (<14 dias)', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', border: 'border-l-amber-400', icon: AlertTriangle, priority: 2 },
  alto_giro: { label: 'Alto giro', short: 'Alto giro', color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300', border: 'border-l-orange-400', icon: TrendingUp, priority: 3 },
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

const ReplenishmentReport = ({ user, onCreateLote }) => {
  const role = Number(user?.role || 0);
  const canCreateLote = role >= 3;

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [config, setConfig] = useState({});

  const [severityFilter, setSeverityFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [semanasCobertura, setSemanasCobertura] = useState(loadSemanasCobertura);
  const [dataInicio, setDataInicio] = useState(() => loadDataRange().dataInicio);
  const [dataFim, setDataFim] = useState(() => loadDataRange().dataFim);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState(new Set());

  const datePickerRef = useRef(null);

  const carregar = async () => {
    setLoading(true);
    try {
      const params = { semanasCobertura };
      if (dataInicio && dataFim) {
        params.dataInicio = dataInicio;
        params.dataFim = dataFim;
      }
      const rep = await axios.get('/api/reports/replenishment', { params });
      setItems(rep.data.items || []);
      setConfig(rep.data.config || {});
    } catch (e) {
      console.error('Erro ao carregar reposição:', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semanasCobertura, dataInicio, dataFim]);

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

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [severityFilter, search, categoryFilter, dataInicio, dataFim, semanasCobertura]);

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

  // Stats sobre TODOS os itens (cards no topo refletem o universo total, não o filtro)
  const stats = useMemo(() => {
    const s = { zerado: 0, critico: 0, atencao: 0, alto_giro: 0, totalSugerida: 0, total: items.length };
    for (const i of items) {
      if (i.alerta) s[i.alerta] = (s[i.alerta] || 0) + 1;
      s.totalSugerida += Number(i.qtdSugerida) || 0;
    }
    return s;
  }, [items]);

  const categoriasDisponiveis = useMemo(() => {
    const set = new Set();
    for (const i of items) if (i.category) set.add(i.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filtrados = useMemo(() => {
    const searchLc = search.trim().toLowerCase();
    const res = items.filter(i => {
      if (severityFilter === 'alertas' && !i.alerta) return false;
      if (severityFilter === 'sugeridos' && !(i.qtdSugerida > 0)) return false;
      if (severityFilter in ALERTA_META && i.alerta !== severityFilter) return false;
      if (categoryFilter && i.category !== categoryFilter) return false;
      if (searchLc) {
        const hay = `${i.sku || ''} ${i.title || ''}`.toLowerCase();
        if (!hay.includes(searchLc)) return false;
      }
      return true;
    });
    res.sort((a, b) => {
      const pa = a.alerta ? ALERTA_META[a.alerta].priority : 99;
      const pb = b.alerta ? ALERTA_META[b.alerta].priority : 99;
      if (pa !== pb) return pa - pb;
      return (b.qtdSugerida || 0) - (a.qtdSugerida || 0);
    });
    return res;
  }, [items, severityFilter, categoryFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtrados.length / pageSize));
  const paginated = filtrados.slice((page - 1) * pageSize, page * pageSize);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const togglePageSelect = () => {
    const allOn = paginated.every(i => selected.has(i.id));
    setSelected(prev => {
      const next = new Set(prev);
      for (const i of paginated) {
        if (allOn) next.delete(i.id); else next.add(i.id);
      }
      return next;
    });
  };

  const selectSuggested = () => {
    const next = new Set(selected);
    for (const i of filtrados) if ((i.qtdSugerida || 0) > 0) next.add(i.id);
    setSelected(next);
  };

  const clearSelected = () => setSelected(new Set());

  const handleCreateLote = () => {
    const chosen = items.filter(i => selected.has(i.id));
    if (!chosen.length) return;
    const loteItems = chosen.map(i => ({
      inventory_id: i.id,
      sku: i.sku,
      title: i.title,
      quantity: Math.max(1, Number(i.qtdSugerida) || 1),
    }));
    onCreateLote && onCreateLote(loteItems);
  };

  const exportXlsx = () => {
    const isPeriodo = !!config.diasPeriodo;
    const header = isPeriodo
      ? ['SKU', 'Título', 'Categoria', 'Saldo', 'Pendente fábrica', 'Vendas (período)', 'Média/dia', 'Cobertura (dias)', 'Qtd Sugerida', 'Alerta']
      : ['SKU', 'Título', 'Categoria', 'Saldo', 'Pendente fábrica', 'Vendas 7d', 'Vendas 30d', 'Média/dia', 'Cobertura (dias)', 'Qtd Sugerida', 'Alerta'];

    const rows = filtrados.map(i => {
      const base = {
        SKU: i.sku || '',
        'Título': i.title || '',
        Categoria: i.category || '',
        Saldo: Number(i.saldo) || 0,
        'Pendente fábrica': Number(i.pedidosFornecedor) || 0,
      };
      if (isPeriodo) {
        base['Vendas (período)'] = Number(i.vendas30) || 0;
      } else {
        base['Vendas 7d'] = Number(i.vendas7) || 0;
        base['Vendas 30d'] = Number(i.vendas30) || 0;
      }
      base['Média/dia'] = Number(i.mediaDiaria) || 0;
      base['Cobertura (dias)'] = Number(i.coberturaDias) || 0;
      base['Qtd Sugerida'] = Number(i.qtdSugerida) || 0;
      base['Alerta'] = ALERTA_META[i.alerta]?.label || '';
      return base;
    });

    const ws = XLSX.utils.json_to_sheet(rows, { header });

    // Congela o cabeçalho
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: header.length - 1, r: Math.max(rows.length, 1) } }) };

    // Larguras otimizadas por coluna
    const widths = header.map(h => {
      if (h === 'Título') return { wch: 50 };
      if (h === 'SKU' || h === 'Categoria' || h === 'Alerta') return { wch: 22 };
      return { wch: 14 };
    });
    ws['!cols'] = widths;

    // Formato numérico inteiro para colunas numéricas
    const numericCols = ['Saldo', 'Pendente fábrica', 'Vendas (período)', 'Vendas 7d', 'Vendas 30d', 'Cobertura (dias)', 'Qtd Sugerida'];
    const decimalCols = ['Média/dia'];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < header.length; c++) {
        const col = header[c];
        const addr = XLSX.utils.encode_cell({ c, r: r + 1 });
        const cell = ws[addr];
        if (!cell) continue;
        if (numericCols.includes(col)) cell.z = '#,##0';
        else if (decimalCols.includes(col)) cell.z = '#,##0.00';
      }
    }

    // Aba de resumo
    const resumo = [
      ['Relatório', 'Reposição de Estoque'],
      ['Gerado em', new Date().toLocaleString('pt-BR')],
      ['Período de vendas', config.diasPeriodo ? `${config.diasPeriodo} dias (personalizado)` : '7 e 30 dias (padrão)'],
      ['Semanas de cobertura alvo', semanasCobertura],
      ['Total de itens no resultado', filtrados.length],
      [],
      ['Contagem por alerta'],
      ['Estoque zerado', stats.zerado],
      ['Crítico (<7 dias)', stats.critico],
      ['Atenção (<14 dias)', stats.atencao],
      ['Alto giro', stats.alto_giro],
      [],
      ['Soma de Qtd Sugerida (todos os itens)', stats.totalSugerida],
    ];
    const wsResumo = XLSX.utils.aoa_to_sheet(resumo);
    wsResumo['!cols'] = [{ wch: 40 }, { wch: 22 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reposição');
    XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `reposicao_estoque_${stamp}.xlsx`);
  };

  return (
    <div className="space-y-5">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          label="Monitorados"
          value={stats.total}
          Icon={Package}
          color="slate"
          active={severityFilter === 'todos'}
          onClick={() => setSeverityFilter('todos')}
        />
        <StatCard
          label="Zerados"
          value={stats.zerado || 0}
          Icon={AlertCircle}
          color="red"
          active={severityFilter === 'zerado'}
          onClick={() => setSeverityFilter('zerado')}
        />
        <StatCard
          label="Críticos"
          hint="<7 dias"
          value={stats.critico || 0}
          Icon={AlertTriangle}
          color="red"
          active={severityFilter === 'critico'}
          onClick={() => setSeverityFilter('critico')}
        />
        <StatCard
          label="Atenção"
          hint="<14 dias"
          value={stats.atencao || 0}
          Icon={AlertTriangle}
          color="amber"
          active={severityFilter === 'atencao'}
          onClick={() => setSeverityFilter('atencao')}
        />
        <StatCard
          label="Alto giro"
          value={stats.alto_giro || 0}
          Icon={TrendingUp}
          color="orange"
          active={severityFilter === 'alto_giro'}
          onClick={() => setSeverityFilter('alto_giro')}
        />
        <StatCard
          label="Qtd total sugerida"
          value={stats.totalSugerida}
          Icon={PackagePlus}
          color="blue"
          active={severityFilter === 'sugeridos'}
          onClick={() => setSeverityFilter('sugeridos')}
        />
      </div>

      {/* Filters card */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 text-gray-700 dark:text-gray-200 font-semibold">
            <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" /> Reposição de Estoque
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50" onClick={carregar} disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50" onClick={exportXlsx} disabled={loading}>
              <Download className="w-4 h-4" /> Excel
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Buscar</label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="SKU ou título"
                className="input-field text-sm !pl-9 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Categoria</label>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              <option value="">Todas ({categoriasDisponiveis.length})</option>
              {categoriasDisponiveis.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Semanas de cobertura</label>
            <select
              className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              value={semanasCobertura}
              onChange={e => handleSemanasChange(e.target.value)}
              disabled={loading}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10, 12].map(n => (
                <option key={n} value={n}>{n} {n === 1 ? 'semana' : 'semanas'}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Período de vendas</label>
            <div className="relative" ref={datePickerRef}>
              <button
                type="button"
                onClick={() => setShowDatePicker(v => !v)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  dataInicio && dataFim
                    ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                    : 'bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                <Calendar className="w-4 h-4" />
                <span className="flex-1 truncate text-left">
                  {dataInicio && dataFim
                    ? `${dataInicio.split('-').reverse().join('/')} – ${dataFim.split('-').reverse().join('/')}`
                    : 'Padrão (7d + 30d)'}
                </span>
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
                className="mt-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Limpar datas
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-500">
          <span className="inline-flex items-center gap-1"><Info className="w-3.5 h-3.5" /> Cobertura = (saldo + pendente fábrica) ÷ média diária · Qtd sugerida = {semanasCobertura} sem. × 7 dias × média − disponível.</span>
          {config.diasPeriodo > 0 && (
            <span>
              Vendas no período: {config.dataInicio?.split('-').reverse().join('/')} a {config.dataFim?.split('-').reverse().join('/')} ({config.diasPeriodo} dias).
            </span>
          )}
        </div>
      </div>

      {/* Selection action bar */}
      {selected.size > 0 && (
        <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-2 sticky top-0 z-10">
          <div className="text-sm text-blue-800 dark:text-blue-200 font-medium">
            {selected.size} item(ns) selecionado(s)
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={clearSelected} className="text-sm text-blue-700 dark:text-blue-300 hover:underline">
              Limpar seleção
            </button>
            {canCreateLote && (
              <button
                type="button"
                onClick={handleCreateLote}
                className="btn-primary text-sm flex items-center gap-2"
              >
                <Factory className="w-4 h-4" /> Criar lote com selecionados
              </button>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : filtrados.length === 0 ? (
          <div className="text-center py-16 text-gray-500 dark:text-gray-400">
            <Package className="w-10 h-10 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
            Nenhum item para os filtros atuais.
            <div className="mt-2 text-xs">
              <button type="button" onClick={selectSuggested} className="text-blue-600 dark:text-blue-400 hover:underline">
                Selecionar todos com sugestão &gt; 0
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
              <div className="flex items-center gap-3">
                <span>{filtrados.length} item(ns)</span>
                <button type="button" onClick={selectSuggested} className="text-blue-600 dark:text-blue-400 hover:underline">
                  Selecionar com sugestão &gt; 0
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40">
                    <th className="py-2 pl-3 pr-2 w-10">
                      <input
                        type="checkbox"
                        checked={paginated.length > 0 && paginated.every(i => selected.has(i.id))}
                        onChange={togglePageSelect}
                        className="rounded border-gray-300 dark:border-gray-500"
                      />
                    </th>
                    <th className="py-2 px-2">SKU</th>
                    <th className="py-2 px-2">Título</th>
                    <th className="py-2 px-2 text-right">Saldo</th>
                    <th className="py-2 px-2 text-right" title="Peças em lotes da fábrica ainda não recebidas">Pendente fábrica</th>
                    {config.diasPeriodo ? (
                      <th className="py-2 px-2 text-right">Vendas (período)</th>
                    ) : (
                      <>
                        <th className="py-2 px-2 text-right">Vendas 7d</th>
                        <th className="py-2 px-2 text-right">Vendas 30d</th>
                      </>
                    )}
                    <th className="py-2 px-2 text-right">Média/dia</th>
                    <th className="py-2 px-2 text-right" title="(saldo + pendente fábrica) ÷ média diária">Cobertura</th>
                    <th className="py-2 pr-3 pl-2 text-right font-semibold">Qtd Sugerida</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map(i => {
                    const meta = i.alerta ? ALERTA_META[i.alerta] : null;
                    const Icon = meta?.icon;
                    return (
                      <tr
                        key={i.id}
                        className={`border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                          meta ? `border-l-4 ${meta.border}` : 'border-l-4 border-l-transparent'
                        } ${selected.has(i.id) ? 'bg-blue-50/40 dark:bg-blue-900/10' : ''}`}
                      >
                        <td className="py-2 pl-3 pr-2">
                          <input
                            type="checkbox"
                            checked={selected.has(i.id)}
                            onChange={() => toggleSelect(i.id)}
                            className="rounded border-gray-300 dark:border-gray-500"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-gray-900 dark:text-white">{i.sku}</span>
                            {meta && (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${meta.color}`}>
                                {Icon && <Icon className="w-3 h-3" />} {meta.short}
                              </span>
                            )}
                          </div>
                          {i.category && <div className="text-[10px] text-gray-400 mt-0.5">{i.category}</div>}
                        </td>
                        <td className="py-2 px-2 text-gray-700 dark:text-gray-300 max-w-[260px]">
                          <div className="truncate" title={i.title}>{i.title || '-'}</div>
                          {Array.isArray(i.usadoEm) && i.usadoEm.length > 0 && (
                            <div
                              className="text-[10px] text-purple-600 dark:text-purple-300 inline-flex items-center gap-1 mt-0.5 max-w-full truncate"
                              title={`Componente de: ${i.usadoEm.map(u => `${u.sku} (×${u.qty})`).join(', ')}`}
                            >
                              <Layers className="w-3 h-3 shrink-0" />
                              <span className="truncate">
                                comp. de {i.usadoEm.slice(0, 2).map(u => `${u.sku}×${u.qty}`).join(', ')}
                                {i.usadoEm.length > 2 ? ` +${i.usadoEm.length - 2}` : ''}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">{i.saldo}</td>
                        <td className={`py-2 px-2 text-right tabular-nums ${i.pedidosFornecedor > 0 ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-400'}`}>
                          {i.pedidosFornecedor > 0 ? `+${i.pedidosFornecedor}` : '—'}
                        </td>
                        {config.diasPeriodo ? (
                          <td className="py-2 px-2 text-right tabular-nums">{i.vendas30}</td>
                        ) : (
                          <>
                            <td className="py-2 px-2 text-right tabular-nums">{i.vendas7}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{i.vendas30}</td>
                          </>
                        )}
                        <td className="py-2 px-2 text-right tabular-nums">{i.mediaDiaria}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{i.coberturaDias < 999 ? `${i.coberturaDias} dias` : '—'}</td>
                        <td className="py-2 pr-3 pl-2 text-right font-semibold text-blue-600 dark:text-blue-400 tabular-nums">
                          {i.qtdSugerida > 0 ? i.qtdSugerida : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                Exibindo {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, filtrados.length)} de {filtrados.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1.5 rounded border text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Anterior
                </button>
                <span className="text-gray-600 dark:text-gray-400">
                  Página {page} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 rounded border text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
          </>
        )}
      </div>
    </div>
  );
};

const STAT_COLOR = {
  slate: { on: 'bg-slate-600 text-white border-slate-600', off: 'bg-slate-50 text-slate-700 border-slate-100 dark:bg-slate-900/30 dark:text-slate-200 dark:border-slate-800' },
  red: { on: 'bg-red-600 text-white border-red-600', off: 'bg-red-50 text-red-700 border-red-100 dark:bg-red-900/30 dark:text-red-200 dark:border-red-900/60' },
  amber: { on: 'bg-amber-500 text-white border-amber-500', off: 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-900/60' },
  orange: { on: 'bg-orange-500 text-white border-orange-500', off: 'bg-orange-50 text-orange-700 border-orange-100 dark:bg-orange-900/30 dark:text-orange-200 dark:border-orange-900/60' },
  blue: { on: 'bg-blue-600 text-white border-blue-600', off: 'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-900/60' },
};

const StatCard = ({ label, hint, value, Icon, color, active, onClick }) => {
  const pal = STAT_COLOR[color] || STAT_COLOR.slate;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-3 transition-all hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-300 ${
        active ? pal.on + ' ring-2 ring-offset-1 ring-blue-300 dark:ring-offset-gray-900' : pal.off
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</span>
        {Icon && <Icon className="w-4 h-4 opacity-70" />}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] opacity-70 mt-0.5">{hint}</div>}
    </button>
  );
};

export default ReplenishmentReport;
