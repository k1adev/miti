import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import * as XLSX from 'xlsx';
import {
  DollarSign, Loader2, RefreshCw, Download, Search, X, ChevronLeft, ChevronRight,
  AlertTriangle, TrendingDown, TrendingUp, Info, ExternalLink,
  Package, Truck, Percent, Receipt, Tag, RotateCcw, Landmark
} from 'lucide-react';

const STORAGE_FROM = 'order_costs_from';
const STORAGE_TO = 'order_costs_to';
const STORAGE_MARKETPLACE = 'order_costs_marketplace';

const loadPersistedRange = () => {
  try {
    const from = localStorage.getItem(STORAGE_FROM) || '';
    const to = localStorage.getItem(STORAGE_TO) || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
      return { from, to };
    }
  } catch (_) { /* ignore */ }
  return { from: '', to: '' };
};

const brl = (v) => {
  const n = Number(v || 0);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};
const pct = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${(Number(v) * 100).toFixed(1)}%`;
};
const fmtDate = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return String(d); }
};

const COGS_LABEL = {
  ok: { label: 'COGS OK', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  partial: { label: 'COGS parcial', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  unknown: { label: 'Sem COGS', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  no_items: { label: 'Sem itens', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
  cancelled: { label: 'Cancelado', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
};

// Traduções amigáveis dos warnings gerados pelo backend em
// `computeOrderCostsReconstructed`. Mantemos o código bruto como fallback
// para códigos novos ou específicos (ex.: `tax_error:...`).
const WARNING_LABELS = {
  imposto_conta_nao_configurado: 'Alíquota da conta não configurada',
  pedido_cancelado_sem_custo: 'Pedido cancelado sem custo',
  sem_escrow_detail: 'Escrow Shopee indisponível',
  escrow_reusado_cache_local: 'Comissão Shopee carregada do último cálculo (API indisponível no momento)',
  sem_shipment_costs: 'Custos de envio ML indisponíveis',
  sem_itens: 'Pedido sem itens associados',
  sem_order_detail: 'Detalhes do pedido indisponíveis',
  commission_from_listing_prices: 'Comissão estimada via tabela de tarifas (pedido ainda não liquidado)',
  order_gone: 'Pedido removido do marketplace',
};
const formatWarning = (w) => {
  if (!w) return '';
  if (WARNING_LABELS[w]) return WARNING_LABELS[w];
  // Padrões dinâmicos como `tax_error:algumacoisa` continuam legíveis.
  return String(w).replace(/_/g, ' ');
};

const OrderCostsReport = ({ user }) => {
  // Custo de fabricação e margem só são visíveis para administradores (role=4).
  // role<4 continua vendo o relatório sem as colunas/cards de COGS/margem.
  const canSeeCogs = Number(user?.role) === 4;
  const persistedRange = useMemo(loadPersistedRange, []);
  const [from, setFrom] = useState(persistedRange.from);
  const [to, setTo] = useState(persistedRange.to);
  const [marketplace, setMarketplace] = useState(() => localStorage.getItem(STORAGE_MARKETPLACE) || 'all');
  const [accountId, setAccountId] = useState('all');
  const [status, setStatus] = useState('all');
  const [missingCogs, setMissingCogs] = useState(false);
  const [negativeMargin, setNegativeMargin] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ orders: [], aggregates: null, total: 0, totalPages: 1 });
  const [mlAccounts, setMlAccounts] = useState([]);
  const [shopeeAccounts, setShopeeAccounts] = useState([]);
  const [recalcRunning, setRecalcRunning] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState('');

  const [detailOrder, setDetailOrder] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState(null);
  const [showRawJson, setShowRawJson] = useState(false);

  const debounceRef = useRef(null);

  useEffect(() => { try { localStorage.setItem(STORAGE_FROM, from || ''); } catch (_) {} }, [from]);
  useEffect(() => { try { localStorage.setItem(STORAGE_TO, to || ''); } catch (_) {} }, [to]);
  useEffect(() => { try { localStorage.setItem(STORAGE_MARKETPLACE, marketplace || 'all'); } catch (_) {} }, [marketplace]);

  useEffect(() => {
    (async () => {
      try {
        const ml = await axios.get('/api/ml/accounts').catch(() => ({ data: [] }));
        setMlAccounts(Array.isArray(ml.data) ? ml.data : []);
      } catch (_) { /* ignore */ }
      try {
        const sh = await axios.get('/api/shopee/accounts').catch(() => ({ data: [] }));
        setShopeeAccounts(Array.isArray(sh.data) ? sh.data : []);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, pageSize };
      if (from) params.from = from;
      if (to) params.to = to;
      if (marketplace && marketplace !== 'all') params.marketplace = marketplace;
      if (accountId && accountId !== 'all') params.accountId = accountId;
      if (status && status !== 'all') params.status = status;
      if (canSeeCogs && missingCogs) params.missingCogs = 'yes';
      if (canSeeCogs && negativeMargin) params.negativeMargin = 'yes';
      if (search.trim()) params.search = search.trim();
      const res = await axios.get('/api/reports/order-costs', { params });
      setData({
        orders: res.data.orders || [],
        aggregates: res.data.aggregates || null,
        total: res.data.total || 0,
        totalPages: res.data.totalPages || 1,
      });
    } catch (e) {
      console.error('Erro ao carregar custos de pedido:', e);
      setData({ orders: [], aggregates: null, total: 0, totalPages: 1 });
    } finally {
      setLoading(false);
    }
  }, [from, to, marketplace, accountId, status, missingCogs, negativeMargin, search, page, pageSize, canSeeCogs]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSearchChange = (v) => {
    setSearch(v);
    setPage(1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { /* fetch triggered via dep */ }, 500);
  };

  const handleRecalc = async () => {
    if (!window.confirm('Recalcular a quebra de custos de TODOS os pedidos do período selecionado? Isso consulta as APIs do ML/Shopee em paralelo e pode levar vários minutos para períodos longos.')) return;
    setRecalcRunning(true);
    setRecalcMsg('Processando... mantenha esta aba aberta. Períodos grandes podem levar alguns minutos.');
    try {
      const body = {};
      if (from) body.from = from;
      if (to) body.to = to;
      if (marketplace !== 'all') body.marketplace = marketplace;
      // Processa todos os pedidos do período (cap de segurança no backend = 10000)
      body.limit = 10000;
      // Timeout longo porque cada pedido faz 2-4 chamadas externas; mesmo
      // com concorrência 3, períodos grandes podem levar minutos.
      const res = await axios.post('/api/reports/order-costs/recalc', body, { timeout: 30 * 60 * 1000 });
      const rehydrated = Number(res.data.rehydrated || 0);
      const skusResolved = Number(res.data.skus_resolved || 0);
      const msg = `Processados ${res.data.processed || 0} pedidos (${res.data.success || 0} ok, ${res.data.failed || 0} falharam`
        + (rehydrated > 0 ? `, ${rehydrated} re-hidratados` : '')
        + (skusResolved > 0 ? `, ${skusResolved} SKUs resolvidos via cache` : '')
        + `).`;
      setRecalcMsg(msg);
      fetchData();
    } catch (e) {
      console.error(e);
      setRecalcMsg(`Erro: ${e?.response?.data?.error || e.message}`);
    } finally {
      setRecalcRunning(false);
    }
  };

  const handleExportCsv = () => {
    if (!data.orders.length) return;
    // Colunas de COGS/Imposto/Margem são restritas a role=4 (custo de
    // fabricação e alíquota da conta são restritos a administradores).
    const cogsHeaders = canSeeCogs
      ? ['Imposto', 'Alíquota efetiva', 'COGS', 'Margem', 'Margem %', 'COGS status']
      : [];
    const headers = [
      'Marketplace', 'Conta', 'Pedido', 'SKUs', 'Data', 'Status', 'Comprador',
      'Receita bruta', 'Comissão', 'Taxa serviço', 'Taxa pagamento',
      'Frete vendedor', 'Subsídio frete', 'Frete comprador',
      'Desconto vendedor', 'Desconto marketplace', 'Frete reverso',
      'Impostos', 'Ajustes', 'Líquido recebido', ...cogsHeaders, 'Warnings',
    ];
    // Cada célula é { v, t } para preservar tipos no XLSX. IDs viram string
    // (evita notação científica "2,00002E+15"), valores financeiros viram
    // número, datas viram Date.
    const rows = data.orders.map(o => {
      const c = o.costs || {};
      const margin = c.gross_margin != null ? Number(c.gross_margin) : null;
      // Base da margem/alíquota = receita de faturamento (NF) = bruta − promo.
      const billableBase = Number(c.gross_revenue || 0) - Number(c.discounts_seller || 0);
      const marginPct = (margin != null && billableBase > 0)
        ? (margin / billableBase)
        : null;
      const effectiveTaxPct = (c.taxes_seller != null && billableBase > 0)
        ? (Number(c.taxes_seller) / billableBase)
        : null;
      const dateVal = o.order_date ? new Date(o.order_date.replace(' ', 'T')) : null;
      const buyer = (o.buyer_name || '').replace(/[\r\n]/g, ' ').trim();
      const skus = o.skus_summary || '';
      const warnings = Array.isArray(c.warnings) ? c.warnings.join(' | ') : '';
      // Receita bruta exibida = valor da NF = preço cheio − desconto
      // promocional do anúncio (discounts_seller). Mantemos a coluna
      // "Desconto vendedor" zerada porque já está embutida na receita bruta
      // exibida; o waterfall/detalhe ainda audita o valor cheio quando
      // precisar.
      const billableRevenue = Number(c.gross_revenue || 0) - Number(c.discounts_seller || 0);
      const baseCells = [
        { t: 's', v: o.marketplace === 'shopee' ? 'Shopee' : o.marketplace === 'mercado_livre' || o.marketplace === 'ml' ? 'Mercado Livre' : (o.marketplace || '') },
        { t: 'n', v: Number(o.account_id) || 0 },
        { t: 's', v: String(o.marketplace_order_id || '') },
        { t: 's', v: skus },
        dateVal && !Number.isNaN(dateVal.getTime()) ? { t: 'd', v: dateVal } : { t: 's', v: '' },
        { t: 's', v: o.status || '' },
        { t: 's', v: buyer },
        { t: 'n', v: billableRevenue },
        { t: 'n', v: Number(c.marketplace_commission || 0) },
        { t: 'n', v: Number(c.marketplace_service_fee || 0) },
        { t: 'n', v: Number(c.payment_fee || 0) },
        { t: 'n', v: Number(c.shipping_cost_seller || 0) },
        { t: 'n', v: Number(c.shipping_subsidy || 0) },
        { t: 'n', v: Number(c.shipping_paid_by_buyer || 0) },
        { t: 'n', v: 0 },
        { t: 'n', v: Number(c.discounts_marketplace || 0) },
        { t: 'n', v: Number(c.reverse_shipping_fee || 0) },
        { t: 'n', v: Number(c.taxes_withheld || 0) },
        { t: 'n', v: Number(c.other_adjustments || 0) },
        { t: 'n', v: Number(c.net_received || 0) },
      ];
      const cogsCells = canSeeCogs
        ? [
            c.taxes_seller != null ? { t: 'n', v: Number(c.taxes_seller) } : { t: 's', v: '' },
            effectiveTaxPct != null ? { t: 'n', v: effectiveTaxPct } : { t: 's', v: '' },
            c.cogs_estimated != null ? { t: 'n', v: Number(c.cogs_estimated) } : { t: 's', v: '' },
            margin != null ? { t: 'n', v: margin } : { t: 's', v: '' },
            marginPct != null ? { t: 'n', v: marginPct } : { t: 's', v: '' },
            { t: 's', v: c.cogs_status || '' },
          ]
        : [];
      return [...baseCells, ...cogsCells, { t: 's', v: warnings }];
    });

    // Monta worksheet como array-of-arrays. Enviamos os valores crus; em
    // seguida aplicamos formatos (moeda, %, data) célula a célula.
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows.map(r => r.map(cell => cell.v))]);
    const range = XLSX.utils.decode_range(ws['!ref']);

    // Larguras por coluna (ordem do `headers`).
    const widthMap = {
      'Marketplace': 14, 'Conta': 7, 'Pedido': 22, 'SKUs': 28,
      'Data': 18, 'Status': 12, 'Comprador': 26,
      'Receita bruta': 14, 'Comissão': 12, 'Taxa serviço': 12,
      'Taxa pagamento': 14, 'Frete vendedor': 14, 'Subsídio frete': 14,
      'Frete comprador': 14, 'Desconto vendedor': 16, 'Desconto marketplace': 18,
      'Frete reverso': 14, 'Impostos': 12, 'Ajustes': 12,
      'Líquido recebido': 16, 'Imposto': 12, 'Alíquota efetiva': 14,
      'COGS': 12, 'Margem': 12, 'Margem %': 10, 'COGS status': 14,
      'Warnings': 34,
    };
    ws['!cols'] = headers.map(h => ({ wch: widthMap[h] || 14 }));
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: headers.length - 1, r: Math.max(rows.length, 1) } }) };

    // Formatação por célula. SheetJS community usa `cell.z` para número-format
    // (compatível com Excel). Formato "[$R$ ]#,##0.00" = moeda BR.
    const currencyFmt = '[$R$-pt-BR] #,##0.00;[Red]-[$R$-pt-BR] #,##0.00';
    const percentFmt = '0.00%';
    const dateFmt = 'dd/mm/yyyy hh:mm';
    const currencyCols = new Set([
      'Receita bruta', 'Comissão', 'Taxa serviço', 'Taxa pagamento',
      'Frete vendedor', 'Subsídio frete', 'Frete comprador',
      'Desconto vendedor', 'Desconto marketplace', 'Frete reverso',
      'Impostos', 'Ajustes', 'Líquido recebido', 'Imposto', 'COGS', 'Margem',
    ]);
    const percentCols = new Set(['Alíquota efetiva', 'Margem %']);
    const dateCols = new Set(['Data']);
    for (let C = range.s.c; C <= range.e.c; C++) {
      const header = headers[C];
      let fmt = null;
      if (currencyCols.has(header)) fmt = currencyFmt;
      else if (percentCols.has(header)) fmt = percentFmt;
      else if (dateCols.has(header)) fmt = dateFmt;
      if (!fmt) continue;
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const addr = XLSX.utils.encode_cell({ c: C, r: R });
        const cell = ws[addr];
        if (cell && cell.v !== '' && cell.v != null) cell.z = fmt;
      }
    }
    // Pedido: força string com prefixo para Excel não interpretar como
    // número grande (2,00002E+15). Já enviamos como string no aoa; só
    // garantimos o tipo `s` aqui pra defesa em profundidade.
    const pedidoCol = headers.indexOf('Pedido');
    if (pedidoCol >= 0) {
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const addr = XLSX.utils.encode_cell({ c: pedidoCol, r: R });
        const cell = ws[addr];
        if (cell) { cell.t = 's'; cell.v = String(cell.v); }
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Custos de Pedido');
    const stamp = `${from || 'inicio'}_${to || 'hoje'}`;
    XLSX.writeFile(wb, `custos-pedido-${stamp}.xlsx`);
  };

  const openDetail = async (order) => {
    setDetailOrder(order);
    setDetailLoading(true);
    setDetailData(null);
    setShowRawJson(false);
    try {
      const res = await axios.get(`/api/reports/order-costs/${order.id}`);
      setDetailData(res.data);
    } catch (e) {
      console.error(e);
      setDetailData({ error: e?.response?.data?.error || e.message });
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailOrder(null);
    setDetailData(null);
    setShowRawJson(false);
  };

  const accountOptions = useMemo(() => {
    if (marketplace === 'ml') return mlAccounts.map(a => ({ value: a.id, label: a.name || `ML ${a.id}` }));
    if (marketplace === 'shopee') return shopeeAccounts.map(a => ({ value: a.id, label: a.name || `Shopee ${a.id}` }));
    return [
      ...mlAccounts.map(a => ({ value: a.id, label: `ML — ${a.name || a.id}` })),
      ...shopeeAccounts.map(a => ({ value: a.id, label: `Shopee — ${a.name || a.id}` })),
    ];
  }, [marketplace, mlAccounts, shopeeAccounts]);

  const agg = data.aggregates || {};
  const totalMargin = Number(agg.margin || 0);
  // Receita bruta exibida = valor de faturamento (NF) = preço cheio somado
  // menos desconto promocional do anúncio. Usamos essa base também no % da
  // margem para que o indicador bata com o que é de fato faturado.
  const totalRevenue = Number(agg.gross_revenue || 0) - Number(agg.discounts_seller || 0);
  const marginPctAll = totalRevenue > 0 ? totalMargin / totalRevenue : null;

  return (
    <div className="space-y-4">
      {/* Cabeçalho + botões */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-emerald-500" /> Custos de Pedido
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRecalc}
            disabled={recalcRunning}
            title="Recalcula a quebra de custos dos pedidos do período via APIs do ML/Shopee. Útil depois de atualizar cost_price no estoque."
            className="px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 flex items-center gap-2 disabled:opacity-50">
            {recalcRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {recalcRunning ? 'Recalculando…' : 'Recalcular período'}
          </button>
          <button
            onClick={handleExportCsv}
            disabled={!data.orders.length}
            className="px-3 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-2 disabled:opacity-50">
            <Download className="w-4 h-4" /> Exportar XLSX
          </button>
        </div>
      </div>

      {recalcMsg && (
        <div className="px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-200 flex items-center gap-2">
          <Info className="w-4 h-4" /> {recalcMsg}
        </div>
      )}

      {/* Filtros */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
          <span className="text-gray-400">até</span>
          <input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
        </div>
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          {[{ v: 'all', l: 'Todos' }, { v: 'ml', l: 'Mercado Livre' }, { v: 'shopee', l: 'Shopee' }].map(opt => (
            <button key={opt.v} onClick={() => { setMarketplace(opt.v); setAccountId('all'); setPage(1); }}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${marketplace === opt.v ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
              {opt.l}
            </button>
          ))}
        </div>
        {accountOptions.length > 0 && (
          <select value={accountId} onChange={e => { setAccountId(e.target.value); setPage(1); }}
            className="px-2 py-1.5 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
            <option value="all">Todas as contas</option>
            {accountOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        )}
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}
          className="px-2 py-1.5 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
          <option value="all">Qualquer status</option>
          <option value="paid">Pago</option>
          <option value="confirmed">Confirmado</option>
          <option value="shipped">Enviado</option>
          <option value="delivered">Entregue</option>
          <option value="cancelled">Cancelado</option>
          <option value="COMPLETED">Shopee: COMPLETED</option>
          <option value="READY_TO_SHIP">Shopee: READY_TO_SHIP</option>
          <option value="CANCELLED">Shopee: CANCELLED</option>
        </select>
        {canSeeCogs && (
          <>
            <label className={`px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1 cursor-pointer ${negativeMargin ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800' : 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'}`}>
              <input type="checkbox" checked={negativeMargin} onChange={e => { setNegativeMargin(e.target.checked); setPage(1); }} className="hidden" />
              <TrendingDown className="w-3.5 h-3.5" /> Margem negativa
            </label>
            <label className={`px-2.5 py-1 rounded-md text-xs font-medium border flex items-center gap-1 cursor-pointer ${missingCogs ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800' : 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400'}`}>
              <input type="checkbox" checked={missingCogs} onChange={e => { setMissingCogs(e.target.checked); setPage(1); }} className="hidden" />
              <AlertTriangle className="w-3.5 h-3.5" /> Sem COGS
            </label>
          </>
        )}
        <div className="flex items-center gap-2 ml-auto min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Buscar pedido, pack ou comprador…" value={search}
            onChange={e => handleSearchChange(e.target.value)}
            className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
        </div>
      </div>

      {/* Cards de resumo. Cards de COGS/margem só aparecem para role=4. */}
      {data.aggregates && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <SummaryCard label="Receita bruta" value={brl(totalRevenue)} icon={DollarSign} tone="emerald"
            title="Valor de faturamento (NF): preço cheio do pedido menos o desconto promocional do anúncio. É a base usada para emissão de nota fiscal e cálculo de imposto." />
          <SummaryCard label="Comissões" value={brl(agg.commission + agg.service_fee + agg.payment_fee)} icon={Percent} tone="blue" />
          <SummaryCard label="Frete vendedor" value={brl(agg.shipping_cost_seller)} icon={Truck} tone="amber" />
          <SummaryCard label="Descontos" value={brl(agg.discounts_marketplace)} icon={Tag} tone="purple"
            title="Cupons/descontos aplicados pelo marketplace. O desconto promocional do anúncio já está embutido na Receita bruta (NF)." />
          <SummaryCard label="Líquido recebido" value={brl(agg.net_received)} icon={Receipt} tone="cyan" />
          {canSeeCogs && (
            <SummaryCard
              label="Margem líquida"
              value={brl(totalMargin)}
              subtitle={marginPctAll != null ? `(${pct(marginPctAll)})` : ''}
              icon={totalMargin >= 0 ? TrendingUp : TrendingDown}
              tone={totalMargin >= 0 ? 'green' : 'red'}
            />
          )}
          {canSeeCogs && <SummaryCard label="COGS total" value={brl(agg.cogs)} icon={Package} tone="slate" />}
          {canSeeCogs && <SummaryCard label="Imposto" value={brl(agg.taxes_seller)} icon={Landmark} tone="rose" title="Imposto estimado do vendedor (Simples/PIS/COFINS etc.) aplicando a alíquota configurada em cada conta de marketplace sobre a receita bruta dos pedidos." />}
          <SummaryCard label="Pedidos" value={String(agg.orders_total || 0)} icon={Info} tone="slate" />
          {canSeeCogs && (
            <SummaryCard
              label="Sem COGS"
              value={String(agg.orders_missing_cogs || 0)}
              subtitle={`+ ${agg.orders_without_costs || 0} sem custos`}
              icon={AlertTriangle}
              tone="amber"
            />
          )}
        </div>
      )}

      {/* Tabela */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2">Pedido</th>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Canal</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right" title="Valor de faturamento (NF): preço cheio do pedido menos o desconto promocional do anúncio.">Receita</th>
                <th className="px-3 py-2 text-right">Comissão</th>
                <th className="px-3 py-2 text-right">Frete vend.</th>
                <th className="px-3 py-2 text-right" title="Cupons/descontos aplicados pelo marketplace. O desconto promocional do anúncio já está descontado da Receita (NF).">Descontos</th>
                <th className="px-3 py-2 text-right">Líquido</th>
                {canSeeCogs && <th className="px-3 py-2 text-right" title="Imposto estimado do vendedor (Simples/PIS/COFINS etc.) aplicando a alíquota configurada na conta de marketplace. Configure em Configurações → Marketplaces.">Imposto</th>}
                {canSeeCogs && <th className="px-3 py-2 text-right">COGS</th>}
                {canSeeCogs && <th className="px-3 py-2 text-right">Margem</th>}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {loading && (
                <tr><td colSpan={canSeeCogs ? 13 : 10} className="px-3 py-10 text-center text-gray-400">
                  <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Carregando…
                </td></tr>
              )}
              {!loading && data.orders.length === 0 && (
                <tr><td colSpan={canSeeCogs ? 13 : 10} className="px-3 py-10 text-center text-gray-400">
                  Nenhum pedido encontrado com os filtros selecionados.
                </td></tr>
              )}
              {!loading && data.orders.map(o => {
                const c = o.costs || {};
                const margin = c.gross_margin;
                // Receita/NF = preço cheio − desconto promocional do anúncio.
                const billableRevenue = Number(c.gross_revenue || 0) - Number(c.discounts_seller || 0);
                const mPct = billableRevenue > 0 ? (margin / billableRevenue) : null;
                const noCosts = !o.has_costs;
                const totalCommission = (c.marketplace_commission || 0) + (c.marketplace_service_fee || 0) + (c.payment_fee || 0);
                // `shipping_subsidy` (save do ML) é informativo — não reduz o
                // custo real do vendedor, que é exatamente `shipping_cost_seller`.
                const netShipping = (c.shipping_cost_seller || 0);
                // Desconto promocional já está embutido na Receita (NF); aqui
                // restam só cupons/descontos do marketplace.
                const totalDiscounts = (c.discounts_marketplace || 0);
                return (
                  <tr key={o.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 dark:text-white">{o.marketplace_order_id}</div>
                      <div className="text-[11px] text-gray-400 truncate max-w-[220px]">{o.buyer_name || '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{fmtDate(o.order_date)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded ${o.marketplace === 'shopee' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300'}`}>
                        {o.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{o.status || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{noCosts ? '—' : brl(billableRevenue)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{noCosts ? '—' : `-${brl(totalCommission)}`}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{noCosts ? '—' : (netShipping > 0 ? `-${brl(netShipping)}` : brl(-netShipping))}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-red-600 dark:text-red-400">{noCosts ? '—' : (totalDiscounts > 0 ? `-${brl(totalDiscounts)}` : brl(0))}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{noCosts ? '—' : brl(c.net_received)}</td>
                    {canSeeCogs && (
                      <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                        {noCosts ? '—' : (c.taxes_seller > 0 ? `-${brl(c.taxes_seller)}` : brl(0))}
                      </td>
                    )}
                    {canSeeCogs && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {noCosts ? '—' : (
                          c.cogs_estimated != null ? (
                            <>
                              {brl(c.cogs_estimated)}
                              {c.cogs_status && COGS_LABEL[c.cogs_status] && (
                                <div className={`mt-0.5 inline-block text-[10px] px-1 py-0.5 rounded ${COGS_LABEL[c.cogs_status].cls}`}>{COGS_LABEL[c.cogs_status].label}</div>
                              )}
                            </>
                          ) : '—'
                        )}
                      </td>
                    )}
                    {canSeeCogs && (
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${margin == null ? '' : margin >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                        {noCosts || margin == null ? '—' : (
                          <>
                            {brl(margin)}
                            {mPct != null && <div className="text-[10px] font-normal">({pct(mPct)})</div>}
                          </>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right">
                      {noCosts ? (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400 italic">Não calculado</span>
                      ) : (
                        <button onClick={() => openDetail(o)} className="text-blue-600 dark:text-blue-400 hover:underline text-xs flex items-center gap-1 justify-end ml-auto">
                          <ExternalLink className="w-3.5 h-3.5" /> Detalhes
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        {data.total > pageSize && (
          <div className="flex items-center gap-3 px-3 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-1">
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                className="p-1 rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700"><ChevronLeft className="w-4 h-4" /></button>
              <button disabled={page >= data.totalPages} onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                className="p-1 rounded disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-700"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <span>{data.total} pedidos — página {page} de {data.totalPages}</span>
          </div>
        )}
      </div>

      {/* Modal detalhe */}
      {detailOrder && (
        <OrderCostDetailModal
          order={detailOrder}
          loading={detailLoading}
          data={detailData}
          showRawJson={showRawJson}
          onToggleRawJson={() => setShowRawJson(v => !v)}
          onClose={closeDetail}
          canSeeCogs={canSeeCogs}
        />
      )}
    </div>
  );
};

function SummaryCard({ label, value, subtitle, icon: Icon, tone = 'slate', title }) {
  const tones = {
    emerald: 'from-emerald-500/10 to-emerald-500/5 text-emerald-700 dark:text-emerald-400',
    blue: 'from-blue-500/10 to-blue-500/5 text-blue-700 dark:text-blue-400',
    amber: 'from-amber-500/10 to-amber-500/5 text-amber-700 dark:text-amber-400',
    purple: 'from-purple-500/10 to-purple-500/5 text-purple-700 dark:text-purple-400',
    cyan: 'from-cyan-500/10 to-cyan-500/5 text-cyan-700 dark:text-cyan-400',
    green: 'from-green-500/10 to-green-500/5 text-green-700 dark:text-green-400',
    red: 'from-red-500/10 to-red-500/5 text-red-700 dark:text-red-400',
    rose: 'from-rose-500/10 to-rose-500/5 text-rose-700 dark:text-rose-400',
    slate: 'from-slate-500/10 to-slate-500/5 text-slate-700 dark:text-slate-300',
  };
  return (
    <div title={title} className={`rounded-lg p-3 bg-gradient-to-br ${tones[tone] || tones.slate} border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800`}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide font-medium">
        <Icon className="w-3.5 h-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-bold text-gray-900 dark:text-white">{value}</div>
      {subtitle && <div className="text-[11px] text-gray-500 dark:text-gray-400">{subtitle}</div>}
    </div>
  );
}

function OrderCostDetailModal({ order, loading, data, showRawJson, onToggleRawJson, onClose, canSeeCogs }) {
  const rec = data?.costs?.find(c => c.source === 'reconstructed');
  const bill = data?.costs?.find(c => c.source === 'ml_billing_report');
  const gross = Number(rec?.gross_revenue || 0);
  const commission = Number(rec?.marketplace_commission || 0);
  const serviceFee = Number(rec?.marketplace_service_fee || 0);
  const paymentFee = Number(rec?.payment_fee || 0);
  const shipSeller = Number(rec?.shipping_cost_seller || 0);
  const shipSubsidy = Number(rec?.shipping_subsidy || 0);
  const discSeller = Number(rec?.discounts_seller || 0);
  const discMarket = Number(rec?.discounts_marketplace || 0);
  const taxes = Number(rec?.taxes_withheld || 0);
  const taxesSeller = Number(rec?.taxes_seller || 0);
  const reverse = Number(rec?.reverse_shipping_fee || 0);
  const others = Number(rec?.other_adjustments || 0);
  const net = Number(rec?.net_received || 0);
  const cogs = Number(rec?.cogs_estimated || 0);
  const margin = Number(rec?.gross_margin || 0);

  // Waterfall: cada linha representa uma subtração/adição sobre o valor anterior.
  // Linhas de COGS/Margem só aparecem para role=4 (custo de fabricação restrito).
  // Na Shopee, comissão + taxa de serviço são aglomeradas em uma única linha
  // (a quebra por conta é do marketplace; o vendedor vê as duas como "taxa
  // total da Shopee"). No ML, mantemos separadas porque refletem escopos
  // diferentes (comissão = categoria, taxa de serviço = envio Full/Flex).
  const isShopee = order.marketplace === 'shopee';
  // Receita bruta exibida = valor da NF (preço cheio − desconto promocional
  // do anúncio). O desconto promocional não aparece como linha separada no
  // waterfall porque já está embutido nessa base.
  const billableRevenue = gross - discSeller;
  const waterfall = [
    { label: 'Receita bruta (NF)', value: billableRevenue, kind: 'gross' },
    isShopee
      ? { label: 'Comissão + taxa de serviço', value: -(commission + serviceFee), kind: 'deduction', hideIfZero: true }
      : { label: 'Comissão marketplace', value: -commission, kind: 'deduction' },
    ...(isShopee ? [] : [
      { label: 'Taxa de serviço', value: -serviceFee, kind: 'deduction', hideIfZero: true },
    ]),
    { label: 'Taxa de pagamento/parcelamento', value: -paymentFee, kind: 'deduction', hideIfZero: true },
    // Obs.: shipping_subsidy (`save` do ML) é exibido como nota informativa
    // abaixo do waterfall, não entra na soma — o vendedor paga `cost` direto
    // e o `save` só indica quanto o ML absorveu do preço cheio.
    { label: 'Frete pago pelo vendedor', value: -shipSeller, kind: 'deduction', hideIfZero: true },
    { label: 'Cupons/descontos marketplace', value: -discMarket, kind: 'deduction', hideIfZero: true },
    { label: 'Frete reverso (devolução)', value: -reverse, kind: 'deduction', hideIfZero: true },
    { label: 'Impostos retidos', value: -taxes, kind: 'deduction', hideIfZero: true },
    // Imposto estimado do vendedor (alíquota configurada na conta de
    // marketplace). Só aparece para role=4.
    ...(canSeeCogs ? [
      { label: 'Imposto (alíquota da conta)', value: -taxesSeller, kind: 'deduction', hideIfZero: true },
    ] : []),
    { label: 'Ajustes', value: others, kind: others < 0 ? 'deduction' : 'addition', hideIfZero: true },
    { label: 'Líquido recebido', value: net, kind: 'total' },
    ...(canSeeCogs ? [
      { label: 'COGS', value: -cogs, kind: 'deduction' },
      { label: 'Margem', value: margin, kind: margin >= 0 ? 'final-pos' : 'final-neg' },
    ] : []),
  ].filter(r => !(r.hideIfZero && Math.abs(r.value) < 0.01));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl my-8 max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Pedido {order.marketplace_order_id}
            </h3>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {order.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre'} · {fmtDate(order.order_date)}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loading && (
            <div className="py-10 text-center text-gray-400">
              <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando detalhes…
            </div>
          )}
          {!loading && data?.error && (
            <div className="py-6 px-4 rounded bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
              Erro: {data.error}
            </div>
          )}
          {!loading && data && !data.error && (
            <>
              {/* Waterfall */}
              <div className="bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium mb-2 flex items-center gap-2">
                  <DollarSign className="w-4 h-4" /> Waterfall financeiro
                </div>
                <div className="space-y-1">
                  {waterfall.map((r, i) => (
                    <div key={i} className={`flex justify-between items-center text-sm px-2 py-1.5 rounded ${
                      r.kind === 'gross' ? 'bg-white dark:bg-gray-800 font-semibold text-gray-900 dark:text-white'
                      : r.kind === 'total' ? 'bg-blue-50 dark:bg-blue-900/30 font-semibold text-blue-900 dark:text-blue-200 border-y border-blue-200 dark:border-blue-800'
                      : r.kind === 'final-pos' ? 'bg-emerald-50 dark:bg-emerald-900/30 font-bold text-emerald-800 dark:text-emerald-300'
                      : r.kind === 'final-neg' ? 'bg-red-50 dark:bg-red-900/30 font-bold text-red-800 dark:text-red-300'
                      : r.kind === 'addition' ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                    }`}>
                      <span>{r.label}</span>
                      <span className="tabular-nums">{r.value >= 0 ? brl(r.value) : `-${brl(-r.value)}`}</span>
                    </div>
                  ))}
                </div>
                {rec && discSeller > 0 && (
                  <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 italic">
                    Preço cheio do pedido: {brl(gross)}. Desconto promocional do anúncio ({brl(discSeller)}) já está embutido na Receita bruta (NF) acima.
                  </div>
                )}
                {rec && order.marketplace === 'mercado_livre' && shipSubsidy > 0 && (
                  <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 italic">
                    ML absorveu {brl(shipSubsidy)} do preço cheio do frete (desconto promocional; informativo, não reduz seu custo de {brl(shipSeller)}).
                  </div>
                )}
                {rec && (
                  <div className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 flex items-center gap-2 flex-wrap">
                    <span>Calculado em {fmtDate(rec.computed_at)}</span>
                    {rec.escrow_status && <span className="px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700">{rec.escrow_status}</span>}
                    {canSeeCogs && rec.cogs_status && COGS_LABEL[rec.cogs_status] && (
                      <span className={`px-1.5 py-0.5 rounded ${COGS_LABEL[rec.cogs_status].cls}`}>{COGS_LABEL[rec.cogs_status].label}</span>
                    )}
                    {Array.isArray(rec.warnings) && rec.warnings.map((w, i) => (
                      <span key={i} className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 break-words max-w-full inline-flex items-center">
                        <AlertTriangle className="w-3 h-3 inline mr-1 flex-shrink-0" />
                        <span className="break-words">{formatWarning(w)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Comparação reconstructed vs billing_report */}
              {data.divergence && data.divergence.length > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 border border-amber-200 dark:border-amber-800">
                  <div className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300 font-medium mb-2">
                    Divergência vs. Billing Reports do ML
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-left text-amber-800 dark:text-amber-300">
                      <tr><th className="py-1">Métrica</th><th className="py-1 text-right">Reconstrução</th><th className="py-1 text-right">Billing report</th><th className="py-1 text-right">Diferença</th></tr>
                    </thead>
                    <tbody>
                      {data.divergence.map(d => (
                        <tr key={d.metric} className="border-t border-amber-200 dark:border-amber-800">
                          <td className="py-1">{d.metric}</td>
                          <td className="py-1 text-right tabular-nums">{brl(d.reconstructed)}</td>
                          <td className="py-1 text-right tabular-nums">{brl(d.billing_report)}</td>
                          <td className={`py-1 text-right tabular-nums font-semibold ${Math.abs(d.diff) > 0.5 ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-300'}`}>
                            {d.diff >= 0 ? '+' : ''}{brl(d.diff)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Itens com COGS por SKU */}
              {Array.isArray(data.items) && data.items.length > 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                  <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium flex items-center gap-2">
                    <Package className="w-4 h-4" /> Itens do pedido ({data.items.length})
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-3 py-2">SKU</th>
                        <th className="px-3 py-2">Título</th>
                        <th className="px-3 py-2 text-right">Qtd</th>
                        <th className="px-3 py-2 text-right">Preço unit.</th>
                        <th className="px-3 py-2 text-right">Receita</th>
                        {canSeeCogs && <th className="px-3 py-2 text-right" title="Alíquota de imposto configurada na conta de marketplace deste pedido.">Alíq. %</th>}
                        {canSeeCogs && <th className="px-3 py-2 text-right" title="Imposto do pedido: (receita bruta − desconto promocional) × alíquota. Este é o valor faturado (o que o cliente paga). Distribuído proporcionalmente entre os itens.">Imposto</th>}
                        {canSeeCogs && <th className="px-3 py-2 text-right">COGS unit.</th>}
                        {canSeeCogs && <th className="px-3 py-2 text-right">COGS total</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                      {data.items.map(it => (
                        <tr key={it.id}>
                          <td className="px-3 py-2 font-mono text-gray-900 dark:text-white">
                            {it.sku || <span className="text-amber-600 dark:text-amber-400 italic">(sem SKU)</span>}
                            {it.is_composite && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">Composto</span>}
                          </td>
                          <td className="px-3 py-2 text-gray-600 dark:text-gray-300 truncate max-w-[220px]" title={it.title || ''}>{it.title || '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{it.quantity}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{brl(it.unit_price)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{brl(it.line_revenue)}</td>
                          {canSeeCogs && (
                            <td className="px-3 py-2 text-right tabular-nums">
                              {it.tax_pct == null ? <span className="text-amber-600 dark:text-amber-400">—</span> : `${Number(it.tax_pct).toFixed(2)}%`}
                            </td>
                          )}
                          {canSeeCogs && (
                            <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                              {it.line_tax == null ? '—' : brl(it.line_tax)}
                            </td>
                          )}
                          {canSeeCogs && (
                            <td className="px-3 py-2 text-right tabular-nums">{it.cost_price == null ? <span className="text-amber-600 dark:text-amber-400">—</span> : brl(it.cost_price)}</td>
                          )}
                          {canSeeCogs && (
                            <td className="px-3 py-2 text-right tabular-nums">{it.line_cogs == null ? '—' : brl(it.line_cogs)}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  {canSeeCogs && (
                    <div className="px-3 py-2 text-[11px] text-gray-500 dark:text-gray-400 italic border-t border-gray-200 dark:border-gray-700">
                      A margem líquida do pedido está no waterfall acima (já considera comissão, frete, descontos e imposto). Esta tabela serve para auditar o custo do produto por SKU.
                    </div>
                  )}
                </div>
              )}

              {/* JSON bruto para auditoria. Ocultado para role<4 porque o raw
                  contém cost_price por SKU (reversal_applied.before + cogs_lines). */}
              {canSeeCogs && (
                <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                  <button onClick={onToggleRawJson}
                    className="w-full px-3 py-2 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-medium flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <RotateCcw className="w-4 h-4" /> JSON bruto usado no cálculo (auditoria)
                    <span className="ml-auto text-[11px] normal-case">{showRawJson ? 'ocultar' : 'mostrar'}</span>
                  </button>
                  {showRawJson && rec?.raw_json && (
                    <pre className="px-3 py-2 text-[11px] bg-gray-900 text-gray-100 overflow-x-auto max-h-96 rounded-b-lg">
                      {JSON.stringify(rec.raw_json, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default OrderCostsReport;
