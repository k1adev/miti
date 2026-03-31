import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DollarSign, ShoppingCart, Printer, RefreshCw, ExternalLink, Package, CheckCircle, X, Check, Trash2, Send, Store, ChevronDown, ChevronUp, FileText, Truck, CreditCard, User, MapPin, Save, Copy, Eye, MoreVertical, Calendar } from 'lucide-react';
import axios from 'axios';
import { DateRangePicker } from './DateRangePicker';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from './Toast';

const ProgressBar = ({ value, max }) => {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  // Detectar modo escuro
  const isDark = typeof window !== 'undefined' && document.body.classList.contains('dark');

  return (
    <div style={{ width: '100%', margin: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', fontWeight: 600, fontSize: 22, color: isDark ? '#e0eaff' : '#2563eb', marginBottom: 4 }}>{percent}%</div>
      <div style={{
        width: '80%',
        height: 22,
        background: isDark ? '#232e41' : '#f3f4f6',
        borderRadius: 16,
        border: `2px solid ${isDark ? '#60a5fa' : '#2563eb'}`,
        overflow: 'hidden',
        position: 'relative',
        boxSizing: 'border-box',
      }}>
        <div style={{
          width: `${percent}%`,
          height: '100%',
          background: isDark
            ? 'linear-gradient(90deg, #60a5fa 60%, #93c5fd 100%)'
            : 'linear-gradient(90deg, #2563eb 60%, #3b82f6 100%)',
          borderRadius: 16,
          transition: 'width 0.4s cubic-bezier(.4,2,.6,1)',
        }} />
      </div>
    </div>
  );
};

export const Sales = () => {
  const toast = useToast();
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ 
    user_id: '', 
    product_id: '', 
    quantity: 1, 
    total_price: '' 
  });

  const [blingAuth, setBlingAuth] = useState(null);
  const [notasFiscais, setNotasFiscais] = useState([]);
  const [notasByAccount, setNotasByAccount] = useState({});
  const [selectedNotas, setSelectedNotas] = useState([]);
  const [showBlingAuth, setShowBlingAuth] = useState(false);
  const [blingStatus, setBlingStatus] = useState('disconnected');
  const [blingAccounts, setBlingAccounts] = useState([]);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [lastFetchAccountId, setLastFetchAccountId] = useState(null);
  const [loadingNotasByAccount, setLoadingNotasByAccount] = useState({});
  const [isFetchingNotasByAccount, setIsFetchingNotasByAccount] = useState({});
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const dd = String(hoje.getDate()).padStart(2, '0');
  const dataHoje = `${yyyy}-${mm}-${dd}`;
  const [dataInicial, setDataInicial] = useState(() => localStorage.getItem('miti_dataInicial') || dataHoje);
  const [dataFinal, setDataFinal] = useState(() => localStorage.getItem('miti_dataFinal') || dataHoje);
  const [filtro12h, setFiltro12h] = useState(() => localStorage.getItem('miti_filtro12h') === 'true');
  const [filtroTexto, setFiltroTexto] = useState('');
  const [filtroMarketplace, setFiltroMarketplace] = useState('');
  const [filtroStatus, setFiltroStatus] = useState('');
  const [filtroTipoPedido, setFiltroTipoPedido] = useState('todos');
  const [aglutinar, setAglutinar] = useState(false);
  const [expedidas, setExpedidas] = useState([]);
  const [ocultarExpedidas, setOcultarExpedidas] = useState(false);
  const [processingExpedition, setProcessingExpedition] = useState(false);
  const [notasEmProcessamento, setNotasEmProcessamento] = useState(new Set());
  const ownerIdRef = useRef(null);
  const [visibleRowsByGroup, setVisibleRowsByGroup] = useState({});
  // Modo leitor de etiquetas (opcional)
  const [scanMode, setScanMode] = useState(false);
  const [scanValue, setScanValue] = useState('');
  const scanInputRef = useRef(null);
  const notasDateRangeRef = useRef(null);
  const [showNotasDateRangePicker, setShowNotasDateRangePicker] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('miti_dataInicial', dataInicial || '');
      localStorage.setItem('miti_dataFinal', dataFinal || '');
      localStorage.setItem('miti_filtro12h', filtro12h ? 'true' : 'false');
    } catch {}
  }, [dataInicial, dataFinal, filtro12h]);

  useEffect(() => {
    if (!showNotasDateRangePicker) return;
    const handleClickOutside = (e) => {
      if (notasDateRangeRef.current && !notasDateRangeRef.current.contains(e.target)) {
        setShowNotasDateRangePicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotasDateRangePicker]);

  const location = useLocation();
  const navigate = useNavigate();
  const [aglutinados, setAglutinados] = useState([]);
  const [visualizarAglutinado, setVisualizarAglutinado] = useState(null);
  const [loadingAglutinados, setLoadingAglutinados] = useState(false);
  const [showAglutinadosModal, setShowAglutinadosModal] = useState(false);
  const [aglutinadosPerPage, setAglutinadosPerPage] = useState(15);
  const [aglutinadosPage, setAglutinadosPage] = useState(1);
  const [aglutinadoMenuOpen, setAglutinadoMenuOpen] = useState(null);
  const [manualOrders, setManualOrders] = useState([]);

  // --- Marketplace Orders state ---
  const [mktOrders, setMktOrders] = useState([]);
  const [mktLoading, setMktLoading] = useState(false);
  const [mktSyncing, setMktSyncing] = useState(false);
  const [mktSelectedIds, setMktSelectedIds] = useState([]);
  const [mktSearch, setMktSearch] = useState('');
  const [mktStatusFilter, setMktStatusFilter] = useState('');
  const [mktMarketplaceFilter, setMktMarketplaceFilter] = useState('');
  const [mktDateFrom, setMktDateFrom] = useState(dataHoje);
  const [mktDateTo, setMktDateTo] = useState(dataHoje);
  const [mktShowDatePicker, setMktShowDatePicker] = useState(false);
  const mktDatePickerRef = useRef(null);
  const [mktSending, setMktSending] = useState(new Set());
  const [mlAccounts, setMlAccounts] = useState([]);
  const [activeMlAccountId, setActiveMlAccountId] = useState(null);
  const [inventory, setInventory] = useState([]);
  const [adModels, setAdModels] = useState([]);
  const [mktPage, setMktPage] = useState(1);
  const [mktTotal, setMktTotal] = useState(0);
  const MKT_PER_PAGE = 50;
  const [mktExpandedId, setMktExpandedId] = useState(null);
  const [mktDetailData, setMktDetailData] = useState(null);
  const [mktDetailLoading, setMktDetailLoading] = useState(false);
  const [mktNfForm, setMktNfForm] = useState({ nf_manual_number: '', nf_manual_key: '', nf_manual_serie: '', nf_manual_date: '' });
  const [mktNfSaving, setMktNfSaving] = useState(false);
  const [mktNfeData, setMktNfeData] = useState(null);
  const [mktNfeLoading, setMktNfeLoading] = useState(false);

  // --- Marketplace Orders functions ---
  const fetchMlAccounts = useCallback(async () => {
    try {
      const res = await axios.get('/api/ml/accounts');
      const accs = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
      setMlAccounts(accs);
      if (!activeMlAccountId && accs.length > 0) setActiveMlAccountId(accs[0].id);
    } catch { setMlAccounts([]); }
  }, [activeMlAccountId]);

  const fetchInventory = useCallback(async () => {
    try {
      const res = await axios.get('/api/inventory');
      setInventory(Array.isArray(res.data) ? res.data : []);
    } catch { setInventory([]); }
  }, []);

  const fetchAdModels = useCallback(async () => {
    try {
      const res = await axios.get('/api/ad-models');
      setAdModels(Array.isArray(res.data?.models) ? res.data.models : []);
    } catch { setAdModels([]); }
  }, []);

  const fetchMktOrders = useCallback(async (page = mktPage, override) => {
    setMktLoading(true);
    try {
      const params = { limit: MKT_PER_PAGE, offset: (page - 1) * MKT_PER_PAGE };
      const mktFilter = override?.marketplace ?? mktMarketplaceFilter;
      const statusFilter = override?.status ?? mktStatusFilter;
      const searchVal = override?.search ?? mktSearch;
      const dateFrom = override?.dateFrom ?? mktDateFrom;
      const dateTo = override?.dateTo ?? mktDateTo;
      if (mktFilter) params.marketplace = mktFilter;
      if (statusFilter) params.status = statusFilter;
      if (searchVal) params.search = searchVal;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      const res = await axios.get('/api/marketplace-orders', { params });
      const orders = Array.isArray(res.data?.orders) ? res.data.orders : [];
      setMktOrders(orders);
      setMktTotal(res.data?.total || orders.length);

      // Batch check NF-e for orders that don't have bling_nfe_numero yet
      const needsNfeCheck = orders.filter(o => !o.bling_nfe_numero && !o.nf_manual_number).map(o => o.id);
      if (needsNfeCheck.length > 0) {
        try {
          const batchRes = await axios.post('/api/marketplace-orders/batch-nfe-check', { orderIds: needsNfeCheck });
          const results = batchRes.data?.results || {};
          if (Object.keys(results).length > 0) {
            setMktOrders(prev => prev.map(o => {
              const r = results[o.id];
              if (r) {
                return {
                  ...o,
                  bling_nfe_numero: r.nfe_numero || o.bling_nfe_numero,
                  bling_pedido_id: r.bling_pedido_id || o.bling_pedido_id,
                  bling_nfe_id: r.bling_nfe_id || o.bling_nfe_id,
                  bling_nfe_status: r.nfe_numero ? 'generated' : o.bling_nfe_status,
                  bling_nfe_chave: r.nfe_chave || o.bling_nfe_chave,
                };
              }
              return o;
            }));
          }
        } catch (batchErr) { console.log('[batch-nfe-check error]', batchErr); }
      }
    } catch (err) {
      console.error('[fetchMktOrders error]', err);
      setMktOrders([]);
      setMktTotal(0);
      if (err.response?.status === 401 || /token|não conectado/i.test(String(err.response?.data?.error || ''))) {
        toast.error('Token ML indisponível. Reautorize em APIs Externas.');
      }
    }
    setMktLoading(false);
  }, [mktMarketplaceFilter, mktStatusFilter, mktSearch, mktDateFrom, mktDateTo, mktPage]);

  const syncMktOrders = async (marketplace = 'ml') => {
    if (marketplace === 'ml' && (!mlAccounts || mlAccounts.length === 0)) {
      toast.error('Nenhuma conta ML configurada');
      return;
    }
    setMktSyncing(true);
    try {
      let totalSynced = 0;
      for (const acc of mlAccounts) {
        const res = await axios.post('/api/marketplace-orders/sync', { marketplace, accountId: acc.id, dateFrom: mktDateFrom, dateTo: mktDateTo });
        totalSynced += res.data?.synced || 0;
      }
      toast.success(`${totalSynced} pedidos sincronizados`);
      fetchMktOrders();
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.details || err.message || 'Erro ao sincronizar pedidos';
      const isTokenError = /token|não conectado|refresh_token|re-authorize/i.test(String(msg));
      toast.error(isTokenError ? `${msg} Reautorize em APIs Externas.` : msg);
    }
    setMktSyncing(false);
  };

  const sendOrderToBling = async (orderId) => {
    if (!activeAccountId) { toast.error('Selecione uma conta Bling'); return; }
    console.log(`[FRONTEND DEBUG] sendOrderToBling: orderId=${orderId}, blingAccountId=${activeAccountId}, activeMlAccountId=${activeMlAccountId}`);
    setMktSending(prev => new Set([...prev, orderId]));
    try {
      const res = await axios.post(`/api/marketplace-orders/${orderId}/send-to-bling`, { blingAccountId: activeAccountId });
      console.log('[FRONTEND DEBUG] sendOrderToBling response:', res.data);
      if (res.data?.success) {
        toast.success(`Pedido enviado ao Bling! NF-e: ${res.data.bling_nfe_status}`);
        fetchMktOrders();
      }
    } catch (err) {
      console.error('[FRONTEND DEBUG] sendOrderToBling error:', err.response?.status, err.response?.data);
      toast.error(err.response?.data?.error || 'Erro ao enviar para Bling');
    }
    setMktSending(prev => { const s = new Set(prev); s.delete(orderId); return s; });
  };

  const sendBulkToBling = async () => {
    if (!activeAccountId) { toast.error('Selecione uma conta Bling'); return; }
    if (mktSelectedIds.length === 0) { toast.error('Selecione pedidos para enviar'); return; }
    const ids = [...mktSelectedIds];
    setMktSending(new Set(ids));
    try {
      const res = await axios.post('/api/marketplace-orders/send-to-bling-bulk', { orderIds: ids, blingAccountId: activeAccountId });
      toast.success(`${res.data.sent || 0} enviados, ${res.data.skipped || 0} ignorados, ${res.data.errors?.length || 0} erros`);
      setMktSelectedIds([]);
      fetchMktOrders();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erro no envio em lote');
    }
    setMktSending(new Set());
  };

  const toggleOrderDetail = async (orderId) => {
    if (mktExpandedId === orderId) {
      setMktExpandedId(null);
      setMktDetailData(null);
      setMktNfeData(null);
      return;
    }
    setMktExpandedId(orderId);
    setMktDetailLoading(true);
    setMktNfeData(null);
    try {
      const res = await axios.get(`/api/marketplace-orders/${orderId}/detail`);
      setMktDetailData(res.data);
      setMktNfForm({
        nf_manual_number: res.data.nf_manual_number || '',
        nf_manual_key: res.data.nf_manual_key || '',
        nf_manual_serie: res.data.nf_manual_serie || '',
        nf_manual_date: res.data.nf_manual_date || ''
      });

      // Always search for NF-e in Bling (by direct ID or by marketplace order number)
      setMktNfeLoading(true);
      try {
        const nfeRes = await axios.get(`/api/marketplace-orders/${orderId}/nfe-detail`);
        setMktNfeData(nfeRes.data || null);
      } catch { setMktNfeData(null); }
      setMktNfeLoading(false);
    } catch (err) {
      console.error('Erro ao carregar detalhe:', err);
      setMktDetailData(null);
    }
    setMktDetailLoading(false);
  };

  const safe = (v) => v == null ? '' : typeof v === 'object' ? (v.descricao || v.valor || v.nome || JSON.stringify(v)) : String(v);

  const saveNfManual = async (orderId) => {
    setMktNfSaving(true);
    try {
      await axios.put(`/api/marketplace-orders/${orderId}/nf-manual`, mktNfForm);
      toast.success('NF Manual salva com sucesso');
      fetchMktOrders();
    } catch (err) {
      toast.error('Erro ao salvar NF Manual');
    }
    setMktNfSaving(false);
  };

  const findInventoryBySku = useCallback((sku) => {
    if (!sku || !inventory.length) return null;
    const skuClean = String(sku).replace(/[a-zA-Z]+/g, '').trim();
    if (!skuClean) return null;
    return inventory.find(inv => String(inv.sku) === skuClean)
      || inventory.find(inv => String(inv.sku).startsWith(skuClean))
      || null;
  }, [inventory]);

  const findAdModelBySku = useCallback((sku) => {
    if (!sku || !adModels.length) return null;
    return adModels.find(m => m.sku === sku) || null;
  }, [adModels]);

  const fetchData = useCallback(async () => {
    try {
      const [salesRes, productsRes, usersRes] = await Promise.all([
        axios.get('/api/sales'),
        axios.get('/api/products'),
        axios.get('/api/users')
      ]);
      setSales(salesRes.data);
      setProducts(productsRes.data);
      setUsers(usersRes.data);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const checkBlingAuth = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const statusRes = await axios.get('/api/bling/status', { params: { accountId: activeAccountId } });
      if (statusRes.data?.connected) {
        setBlingStatus('connected');
        setShowBlingAuth(false);
        return;
      }
      setBlingStatus('disconnected');
      const authRes = await axios.get('/api/bling/auth', { params: { accountId: activeAccountId } });
      if (authRes.data?.url) {
        setBlingAuth({ authUrl: authRes.data.url, accountId: activeAccountId });
        setShowBlingAuth(true);
      }
    } catch (error) {
      console.error('Erro ao verificar auth Bling:', error);
      setBlingStatus('error');
    }
  }, [activeAccountId]);

  // Sincronizar aba ativa com o parâmetro 'tab' da URL
  const params = new URLSearchParams(location.search);
  const activeTab = params.get('tab') || 'notas';
  const navigateTo = (tab) => {
    navigate(`/sales?tab=${tab}`, { replace: true });
  };

  useEffect(() => {
    if (activeTab === 'marketplace') {
      fetchMlAccounts();
      fetchInventory();
      fetchAdModels();
      // Busca sem filtro ao entrar na aba: limpa filtros e busca últimos 30 dias
      const hoje = new Date();
      const trintaDiasAtras = new Date(hoje);
      trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
      const dateFrom = trintaDiasAtras.toISOString().slice(0, 10);
      const dateTo = hoje.toISOString().slice(0, 10);
      setMktSearch('');
      setMktStatusFilter('');
      setMktMarketplaceFilter('');
      setMktDateFrom(dateFrom);
      setMktDateTo(dateTo);
      setMktPage(1);
      fetchMktOrders(1, { search: '', status: '', marketplace: '', dateFrom, dateTo });
    }
  }, [activeTab]);

  useEffect(() => {
    if (!mktShowDatePicker) return;
    const handleClickOutside = (e) => {
      if (mktDatePickerRef.current && !mktDatePickerRef.current.contains(e.target)) setMktShowDatePicker(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mktShowDatePicker]);

  // Progresso da importação por conta
  const [progressoByAccount, setProgressoByAccount] = useState({});
  const progressoInterval = useRef(null);
  const [totalNotasImportacao, setTotalNotasImportacao] = useState(null);

  const tentativasBuscarNotasRef = useRef(0);
  const [erroNotas, setErroNotas] = useState('');
  const getProgressoConta = (accountId) => {
    const fallback = { importados: 0, total: 0, status: 'idle', accountId };
    if (!accountId) return fallback;
    return progressoByAccount[accountId] || fallback;
  };
  const activeProgresso = getProgressoConta(activeAccountId);
  const activeLoadingNotas = Boolean(loadingNotasByAccount[activeAccountId]);
  const activeIsFetchingNotas = Boolean(isFetchingNotasByAccount[activeAccountId]);
  const isActiveFetch = Number(lastFetchAccountId) === Number(activeAccountId);
  const isLoadingActive = isActiveFetch && (activeLoadingNotas || activeIsFetchingNotas);
  const hasTotal = typeof activeProgresso.total === 'number' && activeProgresso.total > 0;
  const isImportingActive =
    activeProgresso.status === 'importando' ||
    (hasTotal && activeProgresso.importados < activeProgresso.total) ||
    activeLoadingNotas ||
    activeIsFetchingNotas;
  const setProgressoConta = (accountId, updater) => {
    if (!accountId) return;
    setProgressoByAccount(prev => {
      const current = prev[accountId] || { importados: 0, total: 0, status: 'idle', accountId };
      const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return { ...prev, [accountId]: { ...next, accountId } };
    });
  };

  // Atalho F2 para focar o campo do leitor quando ativo
  useEffect(() => {
    const onKeyDown = (e) => {
      if (scanMode && e.key === 'F2') {
        e.preventDefault();
        try { if (scanInputRef.current) scanInputRef.current.focus(); } catch {}
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [scanMode]);

  // Consulta via botão foi movida para Estoque; manter atalho F2 somente quando necessário

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await axios.get('/api/bling/accounts');
        const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
        if (!mounted) return;
        setBlingAccounts(accounts);
        if (!activeAccountId && accounts.length > 0) {
          setActiveAccountId(accounts[0].id);
        }
      } catch {
        if (mounted) setBlingAccounts([]);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!activeAccountId) return;
    setSelectedNotas([]);
    setExpedidas([]);
    setNotasEmProcessamento(new Set());
    setErroNotas('');
    checkBlingAuth();
  }, [activeAccountId]);

  useEffect(() => {
    if (!activeAccountId) return;
    setNotasFiscais(notasByAccount[activeAccountId] || []);
  }, [activeAccountId, notasByAccount]);

  const selecionarPorEtiqueta = () => {
    const v = (scanValue || '').trim();
    if (!v) return;
    const nota = todasNotas.find(n => String(n.numeroLoja || '').trim() === v || String(n.numero || '').trim() === v);
    if (nota) {
      handleNotaSelection(nota.id);
      try { const el = document.querySelector(`[data-nota-id="${nota.id}"]`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    }
    setScanValue('');
  };

  const parseNotaDateTime = (value) => {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const d = new Date(normalized);
    if (!Number.isFinite(d.getTime())) return null;
    return d;
  };

  const filtrarNotasApos12h = (notas, baseDateStr) => {
    if (!baseDateStr) return notas;
    const threshold = new Date(`${baseDateStr}T12:00:00`);
    if (!Number.isFinite(threshold.getTime())) return notas;
    return notas.filter(nota => {
      const d = parseNotaDateTime(nota?.dataEmissao || nota?.data_emissao);
      return d && d >= threshold;
    });
  };

  const abrirConsultaNota = () => {
    const v = (scanValue || '').trim();
    if (!v) return;
    const nota = todasNotas.find(n => String(n.numeroLoja || '').trim() === v || String(n.numero || '').trim() === v);
    if (!nota) { toast.error('Nota não encontrada.'); return; }
    // Renderização em janela flutuante
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed'; overlay.style.inset = '0'; overlay.style.background = 'rgba(0,0,0,0.35)'; overlay.style.zIndex = '9999';
    const modal = document.createElement('div');
    modal.style.background = '#fff'; modal.style.borderRadius = '12px'; modal.style.boxShadow = '0 10px 30px rgba(0,0,0,.2)';
    modal.style.padding = '16px'; modal.style.width = '90%'; modal.style.maxWidth = '900px'; modal.style.margin = '40px auto';
    const closeBtn = document.createElement('button'); closeBtn.textContent = '×'; closeBtn.style.float = 'right'; closeBtn.style.fontSize = '20px'; closeBtn.style.border='none'; closeBtn.style.background='transparent'; closeBtn.style.cursor='pointer'; closeBtn.onclick = () => document.body.removeChild(overlay);
    modal.appendChild(closeBtn);
    const header = document.createElement('div'); header.innerHTML = `<div style='font-weight:700;font-size:16px'>Consulta de Nota</div><div style='margin-top:4px;color:#555'>Cliente: ${nota.cliente || '-'} | Nº: ${nota.numero || '-'} | Nº Loja: ${nota.numeroLoja || '-'} | Data: ${nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleDateString('pt-BR') : '-'}</div>`;
    modal.appendChild(header);
    const table = document.createElement('table'); table.style.width='100%'; table.style.marginTop='10px'; table.style.borderCollapse='collapse';
    table.innerHTML = `<thead><tr><th style='border:1px solid #eee;padding:6px;text-align:left'>Foto</th><th style='border:1px solid #eee;padding:6px;text-align:left'>SKU</th><th style='border:1px solid #eee;padding:6px;text-align:left'>Título</th><th style='border:1px solid #eee;padding:6px;text-align:left'>Qtd</th></tr></thead><tbody>${(nota.itens||[]).map(it=>`<tr><td style='border:1px solid #eee;padding:6px'><img style='width:64px;height:64px;object-fit:cover;border-radius:6px;background:#f3f4f6' id='img-${it.codigo||''}'/></td><td style='border:1px solid #eee;padding:6px'>${it.codigo||''}</td><td style='border:1px solid #eee;padding:6px'>${it.descricao||''}</td><td style='border:1px solid #eee;padding:6px'>${it.quantidade||0}</td></tr>`).join('')}</tbody>`;
    modal.appendChild(table); overlay.appendChild(modal); document.body.appendChild(overlay);
    (async ()=>{
      const itens = (nota.itens || []).map(i => i.codigo);
      for(const sku of itens){
        try{
          const clean = String(sku||'').replace(/[^0-9A-Za-z_-]/g,''); if(!clean) continue;
          const res = await fetch('/api/inventory/'+clean+'/image');
          if(res.ok){ const data = await res.json(); const el = document.getElementById('img-'+sku); if(el){ el.src = 'data:'+data.mime+';base64,'+data.image_base64; } }
        }catch(e){}
      }
    })();
    setScanValue('');
  };

  useEffect(() => {
    if (!activeAccountId) return;
    // gerar um ownerId estável por aba/navegador
    if (!ownerIdRef.current) {
      ownerIdRef.current = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
    }
    fetchData();
    checkBlingAuth();
    axios.get('/api/notas-expedidas', { params: { accountId: activeAccountId } })
      .then(res => setExpedidas((res.data.expedidas || []).map(id => String(id))))
      .catch(() => setExpedidas([]));
    // Buscar locks ativos para marcar notas "em processamento"
    axios.get('/api/notas-expedidas/locks', { params: { accountId: activeAccountId } })
      .then(res => {
        const ids = Array.isArray(res.data?.locks) ? res.data.locks : [];
        const filtrados = ids.filter(id => !expedidas.includes(String(id)));
        setNotasEmProcessamento(new Set(filtrados));
      })
      .catch(() => {});
    // Conectar ao SSE para atualizações em tempo real (token na URL pois EventSource não envia headers)
    let es;
    try {
      const token = localStorage.getItem('token');
      const streamUrl = (window.location.origin || '') + `/api/notas-expedidas/locks/stream?accountId=${activeAccountId}` + (token ? `&token=${encodeURIComponent(token)}` : '');
      es = new EventSource(streamUrl);
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data || '{}');
          if (Array.isArray(data.locks)) {
            const filtrados = data.locks.filter(id => !expedidas.includes(String(id)));
            setNotasEmProcessamento(new Set(filtrados));
          }
        } catch {}
      };
      // se a conexão cair, re-tentar após breve atraso
      es.onerror = () => {
        try { es.close(); } catch {}
        setTimeout(() => {
          try {
            const es2 = new EventSource(streamUrl);
            es2.onmessage = (ev) => {
              try {
                const data = JSON.parse(ev.data || '{}');
                if (Array.isArray(data.locks)) {
                  const filtrados = data.locks.filter(id => !expedidas.includes(String(id)));
                  setNotasEmProcessamento(new Set(filtrados));
                }
              } catch {}
            };
          } catch {}
        }, 2000);
      };
    } catch {}
    if (activeTab === 'historico-aglutinados') {
      fetchAglutinados();
    }
    (async () => {
      try {
        const res = await axios.get('/api/manual-orders', { params: { dataInicio: dataInicial, dataFim: dataFinal } });
        setManualOrders(Array.isArray(res.data?.data) ? res.data.data : []);
      } catch {
        setManualOrders([]);
      }
    })();
    // polling leve para sincronizar locks entre máquinas
    const poll = setInterval(async () => {
      try {
        const res = await axios.get('/api/notas-expedidas/locks', { params: { accountId: activeAccountId } });
        const ids = Array.isArray(res.data?.locks) ? res.data.locks : [];
        const filtrados = ids.filter(id => !expedidas.includes(String(id)));
        setNotasEmProcessamento(new Set(filtrados));
      } catch {}
    }, 3000);
    return () => { clearInterval(poll); try { es && es.close(); } catch {} };
  }, [activeTab, activeAccountId]);

  // Sempre que a lista de expedidas mudar, remova-as do conjunto de processamento
  useEffect(() => {
    setNotasEmProcessamento(prev => new Set([...prev].filter(id => !expedidas.includes(String(id)))));
  }, [expedidas]);

  useEffect(() => {
    if (!activeAccountId) return;
    const isActiveFetch = Number(lastFetchAccountId) === Number(activeAccountId);
    if (!isActiveFetch) return;
    if (activeLoadingNotas || activeIsFetchingNotas) {
      setProgressoConta(activeAccountId, prev => ({ ...prev, importados: 0, status: 'importando' }));
    }
  }, [activeLoadingNotas, activeIsFetchingNotas, activeAccountId, lastFetchAccountId]);

  // Sempre confie no valor de total vindo do backend
  useEffect(() => {
    let mounted = true;
    if (!activeAccountId) return () => { mounted = false; };
    axios.get('/api/importacao/progresso', { params: { accountId: activeAccountId } }).then(async res => {
      if (!mounted) return;
      const prog = res.data;
      setProgressoConta(activeAccountId, prev => ({ ...prev, ...prog }));
    });
    return () => {
      mounted = false;
    };
  }, [activeAccountId]);

  // Manter polling enquanto o backend estiver importando
  useEffect(() => {
    if (!activeAccountId) return;
    if (!isImportingActive) {
      if (progressoInterval.current) clearInterval(progressoInterval.current);
      return;
    }
    if (progressoInterval.current) clearInterval(progressoInterval.current);
    progressoInterval.current = setInterval(async () => {
      try {
        const res = await axios.get('/api/importacao/progresso', { params: { accountId: activeAccountId } });
        setProgressoConta(activeAccountId, prev => ({ ...prev, importados: res.data.importados, status: res.data.status, total: res.data.total }));
        const total = typeof res.data.total === 'number' ? res.data.total : 0;
        const importados = typeof res.data.importados === 'number' ? res.data.importados : 0;
        if (res.data.status !== 'importando' && !(total > 0 && importados < total) && progressoInterval.current) {
          clearInterval(progressoInterval.current);
        }
      } catch {}
    }, 1000);
    return () => {
      if (progressoInterval.current) clearInterval(progressoInterval.current);
    };
  }, [activeAccountId, isImportingActive]);

  // Após a importação, se houver notas, mantenha-as no estado e exiba o painel
  const fetchNotasFiscais = async () => {
    console.log('[FRONTEND DEBUG] fetchNotasFiscais chamado - isFetchingNotas:', activeIsFetchingNotas, 'loadingNotas:', activeLoadingNotas);
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    setLastFetchAccountId(accountId);
    if (activeIsFetchingNotas || activeLoadingNotas) {
      console.log('[FRONTEND DEBUG] Bloqueando fetchNotasFiscais - já está em andamento');
      toast.warn('Aguarde o carregamento das notas fiscais terminar antes de buscar novamente.');
      return;
    }
    console.log('[FRONTEND DEBUG] Iniciando fetchNotasFiscais com forcarImportacao=true');
    setIsFetchingNotasByAccount(prev => ({ ...prev, [accountId]: true }));
    setLoadingNotasByAccount(prev => ({ ...prev, [accountId]: true }));
    try {
      let params = { accountId };
      if (dataInicial) {
        params.dataEmissaoInicial = dataInicial + (filtro12h ? ' 12:00:00' : ' 00:00:00');
      }
      if (dataFinal) params.dataEmissaoFinal = dataFinal + ' 23:59:59';
      // Primeiro, fazer a contagem para obter o total
      let totalNotas = 0;
      try {
        console.log('[FRONTEND DEBUG] Fazendo contagem inicial');
        const contagemResponse = await axios.get('/api/bling/notas-fiscais/contar', { params });
        totalNotas = contagemResponse.data.total;
        setProgressoConta(accountId, prev => ({ ...prev, total: totalNotas }));
        // Enviar o total ao backend e aguardar confirmação
        await axios.post('/api/importacao/total', { total: totalNotas, accountId });
      } catch (contagemError) {
        console.log('Erro na contagem inicial, continuando sem total conhecido:', contagemError.message);
      }
      // Agora fazer a importação completa
      console.log('[FRONTEND DEBUG] Chamando API com forcarImportacao=true');
      const response = await axios.get('/api/bling/notas-fiscais', { params: { ...params, forcarImportacao: true } });
      console.log('[FRONTEND DEBUG] Resposta da API:', response.status, 'dados recebidos:', response.data.data?.length || 0);
      const lista = Array.isArray(response.data.data) ? response.data.data : [];
      let filtradas = lista.filter(n => Number(n.accountId || accountId) === Number(accountId));
      if (filtro12h && dataInicial) {
        filtradas = filtrarNotasApos12h(filtradas, dataInicial);
      }
      setNotasByAccount(prev => ({ ...prev, [accountId]: filtradas }));
      if (Number(activeAccountId) === Number(accountId)) {
        setNotasFiscais(filtradas);
      }
    } catch (error) {
      console.error('[FRONTEND DEBUG] Erro ao buscar notas fiscais:', error.response?.status, error.response?.data);
      if (error.response?.status === 401) {
        setBlingStatus('unauthorized');
        setShowBlingAuth(true);
        checkBlingAuth();
      }
    } finally {
      console.log('[FRONTEND DEBUG] Finalizando fetchNotasFiscais');
      setLoadingNotasByAccount(prev => ({ ...prev, [accountId]: false }));
      setIsFetchingNotasByAccount(prev => ({ ...prev, [accountId]: false }));
    }
  };

  // Função para buscar apenas as notas fiscais já importadas, sem reiniciar importação
  const fetchNotasApenas = async () => {
    console.log('[FRONTEND DEBUG] fetchNotasApenas chamado - SEM forcarImportacao');
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    setLastFetchAccountId(accountId);
    let params = { accountId };
    if (dataInicial) params.dataEmissaoInicial = dataInicial + (filtro12h ? ' 12:00:00' : ' 00:00:00');
    if (dataFinal) params.dataEmissaoFinal = dataFinal + ' 23:59:59';
    
    console.log('[FRONTEND DEBUG] Parâmetros para fetchNotasApenas:', params);
    
    try {
      console.log('[FRONTEND DEBUG] Chamando API SEM forcarImportacao');
      const response = await axios.get('/api/bling/notas-fiscais', { params });
      console.log('[FRONTEND DEBUG] fetchNotasApenas - resposta:', response.status, 'dados:', response.data.data?.length || 0);
      const lista = Array.isArray(response.data.data) ? response.data.data : [];
      let filtradas = lista.filter(n => Number(n.accountId || accountId) === Number(accountId));
      if (filtro12h && dataInicial) {
        filtradas = filtrarNotasApos12h(filtradas, dataInicial);
      }
      setNotasByAccount(prev => ({ ...prev, [accountId]: filtradas }));
      if (Number(activeAccountId) === Number(accountId)) {
        setNotasFiscais(filtradas);
      }
    } catch (error) {
      console.error('[FRONTEND DEBUG] Erro em fetchNotasApenas:', error.response?.status, error.response?.data);
    }
  };

  // Limpar cache ao finalizar importação
  useEffect(() => {
    if (activeProgresso.status !== 'importando') {
      localStorage.removeItem('miti_totalNotasImportacao');
    }
  }, [activeProgresso.status]);

  // Buscar notas fiscais automaticamente ao concluir a importação
  useEffect(() => {
    console.log('[FRONTEND DEBUG] useEffect progresso.status mudou:', activeProgresso.status, 'notasFiscais.length:', notasFiscais.length);
    if (activeProgresso.status === 'concluido' && notasFiscais.length === 0) {
      tentativasBuscarNotasRef.current += 1;
      if (tentativasBuscarNotasRef.current <= 2) {
        console.log('[FRONTEND DEBUG] Chamando fetchNotasApenas porque importação concluída e não há notas, tentativa', tentativasBuscarNotasRef.current);
      fetchNotasApenas();
      } else {
        setErroNotas('Não foi possível obter as notas fiscais após a importação. Tente novamente ou verifique o backend.');
      }
    } else if (activeProgresso.status !== 'concluido') {
      tentativasBuscarNotasRef.current = 0;
      setErroNotas('');
    }
    // eslint-disable-next-line
  }, [activeProgresso.status]);

  // Certifique-se de que a função está definida antes do JSX
  const [claimedByMe, setClaimedByMe] = useState(new Set());

  function mapManualOrderToNota(order) {
    const id = `M-${order.id}`;
    return {
      id,
      isManual: true,
      numero: order.invoice_number || order.order_number || id,
      numeroLoja: order.order_number || '-',
      cliente: order.customer_name || 'Cliente não informado',
      marketplace: order.marketplace || 'Pedido Manual',
      dataEmissao: order.order_date || order.created_at || null,
      valorNota: 0,
      situacao: 5,
      itens: Array.isArray(order.items) ? order.items.map(it => ({
        codigo: it.sku,
        descricao: it.title,
        quantidade: it.quantity,
        localizacao: '',
        saldo: undefined,
      })) : []
    };
  }

  const manualNotas = React.useMemo(() => (manualOrders || []).map(mapManualOrderToNota), [manualOrders]);
  const todasNotas = React.useMemo(() => {
    const arr = [...(notasFiscais || []), ...manualNotas];
    return arr;
  }, [notasFiscais, manualNotas]);
  const marketplacesDisponiveis = React.useMemo(() => {
    const set = new Set();
    for (const n of todasNotas) {
      const mk = exibirMarketplace(n) || '';
      if (mk) set.add(mk);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [todasNotas]);
  const notasFiltradas = React.useMemo(() => {
    const termo = (filtroTexto || '').trim().toLowerCase();
    const statusTarget = (filtroStatus || '').toLowerCase();
    const mkTarget = (filtroMarketplace || '').toLowerCase();
    return (todasNotas || []).filter(nota => {
      if (filtroTipoPedido === 'manuais' && !nota.isManual) return false;
      if (filtroTipoPedido === 'bling' && nota.isManual) return false;
      if (statusTarget) {
        const statusStr = nota.situacao === 5 ? 'autorizada' : (nota.situacao === 2 ? 'cancelada' : 'pendente');
        if (statusStr !== statusTarget) return false;
      }
      if (mkTarget) {
        const mk = (exibirMarketplace(nota) || '').toLowerCase();
        if (mk !== mkTarget) return false;
      }
      if (!termo) return true;
      const base = [
        nota.numero,
        nota.numeroLoja,
        nota.cliente,
        exibirMarketplace(nota),
        nota.id
      ].filter(Boolean).map(v => String(v).toLowerCase());
      if (base.some(v => v.includes(termo))) return true;
      const itens = Array.isArray(nota.itens) ? nota.itens : [];
      return itens.some(it => {
        const sku = String(it.codigo || '').toLowerCase();
        const titulo = String(it.descricao || it.titulo || '').toLowerCase();
        return sku.includes(termo) || titulo.includes(termo);
      });
    });
  }, [todasNotas, filtroTexto, filtroMarketplace, filtroStatus, filtroTipoPedido]);
  const notaById = React.useMemo(() => {
    const map = new Map();
    for (const n of todasNotas) map.set(n.id, n);
    return map;
  }, [todasNotas]);

  // Render auxiliar: tabela de pedidos manuais quando activeTab === 'manual'
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualForm, setManualForm] = useState({ order_number: '', invoice_number: '', order_date: '', customer_name: '', items: [] });
  const addManualItem = () => setManualForm(f => ({ ...f, items: [...f.items, { sku: '', title: '', quantity: 1 }] }));
  const removeManualItem = (idx) => setManualForm(f => ({ ...f, items: f.items.filter((_,i)=>i!==idx) }));
  async function resolveSkuTitle(skuRaw){
    try{
      const sku = limparSkuB(skuRaw || '');
      if (!sku) return '';
      const res = await axios.get(`/api/inventory`, { params: { search: sku } });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const match = items.find(p => String(p.sku).toUpperCase() === String(sku).toUpperCase());
      return match?.title || '';
    }catch{ return ''; }
  }
  const onChangeManualSku = async (idx, value) => {
    setManualForm(f => {
      const arr = [...f.items];
      if (!arr[idx]) arr[idx] = { sku: '', title: '', quantity: 1 };
      arr[idx].sku = value;
      return { ...f, items: arr };
    });
    const title = await resolveSkuTitle(value);
    setManualForm(f => {
      const arr = [...f.items];
      if (!arr[idx]) return f;
      arr[idx].title = title || '';
      return { ...f, items: arr };
    });
  };
  const saveManual = async () => {
    const payload = { ...manualForm, marketplace: 'Pedido Manual' };
    await axios.post('/api/manual-orders', payload);
    setShowManualForm(false);
    setManualForm({ order_number: '', invoice_number: '', order_date: '', customer_name: '', items: [] });
    const res = await axios.get('/api/manual-orders', { params: { dataInicio: dataInicial, dataFim: dataFinal } });
    setManualOrders(Array.isArray(res.data?.data) ? res.data.data : []);
  };
  const renderPedidosManuais = () => (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Pedidos Manuais</h2>
        <button className="btn-primary" onClick={() => setShowManualForm(true)}>Novo Pedido Manual</button>
      </div>
      {manualOrders.length === 0 ? (
        <div className="text-gray-600 dark:text-gray-300">Nenhum pedido manual.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">#</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Nº Pedido</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Data</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Nota Fiscal</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Cliente</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Itens</th>
              </tr>
            </thead>
            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
              {manualOrders.map(o => (
                <tr key={o.id}>
                  <td className="px-3 py-2">manual-{o.id}</td>
                  <td className="px-3 py-2">{o.order_number || '-'}</td>
                  <td className="px-3 py-2">{o.order_date ? new Date(o.order_date).toLocaleDateString('pt-BR') : '-'}</td>
                  <td className="px-3 py-2">{o.invoice_number || '-'}</td>
                  <td className="px-3 py-2">{o.customer_name || '-'}</td>
                  <td className="px-3 py-2">{Array.isArray(o.items) ? o.items.map(it => `${it.sku} x${it.quantity}`).join(', ') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showManualForm && (
        <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-3xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Novo Pedido Manual</h3>
              <button className="btn-secondary" onClick={() => setShowManualForm(false)}>Fechar</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Nº Pedido</label>
                <input className="border rounded w-full px-3 py-2 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600" value={manualForm.order_number} onChange={e=>setManualForm(f=>({...f, order_number:e.target.value}))} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Nota Fiscal</label>
                <input className="border rounded w-full px-3 py-2 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600" value={manualForm.invoice_number} onChange={e=>setManualForm(f=>({...f, invoice_number:e.target.value}))} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Data</label>
                <input type="date" className="border rounded w-full px-3 py-2 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600" value={manualForm.order_date} onChange={e=>setManualForm(f=>({...f, order_date:e.target.value}))} />
              </div>
              <div>
                <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Cliente</label>
                <input className="border rounded w-full px-3 py-2 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600" value={manualForm.customer_name} onChange={e=>setManualForm(f=>({...f, customer_name:e.target.value}))} />
              </div>
            </div>
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="font-semibold">Itens</h4>
                <button className="btn-secondary" onClick={addManualItem}>Adicionar Item</button>
              </div>
              <div className="space-y-2">
                {manualForm.items.map((it, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-3 items-end">
                    <div className="col-span-4 md:col-span-3">
                      <label className="block text-xs mb-1">SKU</label>
                      <input className="border rounded w-full px-2 py-1 text-sm" maxLength={6} value={it.sku} onChange={e=>onChangeManualSku(idx, e.target.value.slice(0,6))} onBlur={e=>onChangeManualSku(idx, e.target.value)} />
                    </div>
                    <div className="col-span-6 md:col-span-7">
                      <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">Título</div>
                      <div className="px-2 py-2 border rounded bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-100 min-h-[38px] flex items-center">{it.title || '—'}</div>
                    </div>
                    <div className="col-span-2 md:col-span-1">
                      <label className="block text-xs mb-1">Qtd</label>
                      <input type="number" min="1" className="border rounded w-full px-2 py-1 text-sm" value={it.quantity} onChange={e=>setManualForm(f=>{ const arr=[...f.items]; arr[idx].quantity=Math.max(1, Math.min(999, Number(e.target.value)||1)); return {...f, items:arr}; })} />
                    </div>
                    <div className="col-span-12 md:col-span-1 flex md:justify-end">
                      <button className="btn-danger w-8 h-8 flex items-center justify-center" title="Remover" onClick={() => removeManualItem(idx)}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-col md:flex-row md:justify-end gap-2 mt-4">
              <button className="btn-secondary order-2 md:order-1" onClick={() => setShowManualForm(false)}>Cancelar</button>
              <button className="btn-primary order-1 md:order-2" onClick={saveManual}>Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const handleNotaSelection = async (notaId) => {
    const nota = notaById.get(notaId);
    const isManual = nota?.isManual || String(notaId).startsWith('M-');
    const sel = (arr) => arr.some(sid => String(sid) === String(notaId));
    const rem = (arr) => arr.filter(id => String(id) !== String(notaId));
    if (isManual) {
      setSelectedNotas(prev => sel(prev) ? rem(prev) : [...prev, notaId]);
      return;
    }
    // Para notas expedidas: apenas alterna seleção local, sem claim/release
    if (expedidas.includes(String(notaId))) {
      setSelectedNotas(prev => sel(prev) ? rem(prev) : [...prev, notaId]);
      return;
    }
    // Se já está selecionada por mim, tentar liberar
    if (selectedNotas.some(sid => String(sid) === String(notaId))) {
      try {
        await axios.post('/api/notas-expedidas/release', { id: notaId, owner: ownerIdRef.current, accountId: activeAccountId });
      } catch {}
      setSelectedNotas(prev => prev.filter(id => id !== notaId));
      setClaimedByMe(prev => { const next = new Set(prev); next.delete(notaId); return next; });
      setNotasEmProcessamento(prev => { const next = new Set(prev); next.delete(notaId); return next; });
      return;
    }
    // Tentar claim ao selecionar
    try {
      const res = await axios.post('/api/notas-expedidas/claim', { id: notaId, owner: ownerIdRef.current, accountId: activeAccountId });
      if (res.data && res.data.claimed === true) {
        setSelectedNotas(prev => [...prev, notaId]);
        setClaimedByMe(prev => { const next = new Set(prev); next.add(notaId); return next; });
        setNotasEmProcessamento(prev => { const next = new Set(prev); next.add(notaId); return next; });
      } else if (res.data && res.data.alreadyExpedited === true) {
        // Nota já expedida: permitir seleção para impressão e atualizar exibição
        setExpedidas(prev => prev.includes(String(notaId)) ? prev : [...prev, String(notaId)]);
        setNotasEmProcessamento(prev => { const next = new Set(prev); next.delete(notaId); return next; });
        setSelectedNotas(prev => prev.some(id => String(id) === String(notaId)) ? prev : [...prev, notaId]);
      } else {
        // Em processamento por outro usuário
        setNotasEmProcessamento(prev => { const next = new Set(prev); next.add(notaId); return next; });
        setSelectedNotas(prev => prev.filter(id => String(id) !== String(notaId)));
        setClaimedByMe(prev => { const next = new Set(prev); next.delete(notaId); return next; });
      }
    } catch (e) {
      console.warn('[LOCK] Falha ao claimar nota', notaId, e?.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      await axios.post('/api/sales', formData);
      setFormData({ user_id: '', product_id: '', quantity: 1, total_price: '' });
      setShowForm(false);
      fetchData();
    } catch (error) {
      console.error('Erro ao salvar venda:', error);
      toast.error('Erro ao salvar venda. Verifique os dados.');
    }
  };

  const calculateTotal = () => {
    const product = products.find(p => p.id == formData.product_id);
    if (product && formData.quantity) {
      return (product.price * formData.quantity).toFixed(2);
    }
    return 0;
  };

  const formatPrice = (price) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(price || 0);
  };

  const aglutinarPedidos = () => {
    const pedidosSelecionados = notasFiscais.filter(nota => selectedNotas.some(sid => String(sid) === String(nota.id)));
    
    const itensAgrupados = {};
    
    pedidosSelecionados.forEach(nota => {
      nota.itens?.forEach(item => {
        const skuOriginal = item.codigo || 'SKU-NÃO-INFORMADO';
        const sku = limparSkuB(skuOriginal);
        if (!itensAgrupados[sku]) {
          itensAgrupados[sku] = {
            sku: skuOriginal,
            titulo: item.descricao || 'Produto não informado',
            quantidade: 0,
            localizacao: item.localizacao || '',
            saldo: item.saldo
          };
        }
        itensAgrupados[sku].quantidade += parseInt(item.quantidade) || 0;
        if (item.localizacao && !itensAgrupados[sku].localizacao.includes(item.localizacao)) {
          if (itensAgrupados[sku].localizacao) {
            itensAgrupados[sku].localizacao += ', ' + item.localizacao;
          } else {
            itensAgrupados[sku].localizacao = item.localizacao;
          }
        }
      });
    });

    return Object.values(itensAgrupados).map(item => ({
      ...item,
      marketplaces: Array.from(item.marketplaces).join(', '),
      localizacao: item.localizacao || 'Não informado'
    }));
  };

  // Função para buscar saldo de unitários e kits para um SKU (com logs detalhados)
  async function buscarSaldosUnitarioEKit(skuBase) {
    let unitario = null;
    let kits = [];
    let componentes = [];
    let componentesDetalhados = [];
    try {
      const res = await axios.get(`/api/inventory`, { params: { search: skuBase } });
      if (Array.isArray(res.data.items)) {
        console.log('[MovInteligente] Itens encontrados para', skuBase, JSON.parse(JSON.stringify(res.data.items)));
        const matchesBase = (s) => {
          if (!s) return false;
          const sUp = String(s).trim().toUpperCase();
          const baseUp = String(skuBase).trim().toUpperCase();
          return sUp === baseUp || sUp.replace(/[A-Z]+$/, '') === baseUp;
        };
        unitario = res.data.items.find(p => !p.is_composite && matchesBase(p.sku));
        kits = res.data.items.filter(p => p.is_composite && (matchesBase(p.sku) || String(p.sku || '').toUpperCase().includes(String(skuBase).toUpperCase())));
        // Se não encontrou unitário mas encontrou composto, não usar o composto como unitário
        if (!unitario && kits.length > 0) {
          console.log('[MovInteligente] SKU composto encontrado mas não há unitário correspondente:', skuBase);
        }
        if (kits.length === 0) {
          kits = res.data.items.filter(p => p.is_composite);
        }
        // Se encontrar kit/composto, buscar componentes detalhados
        if (kits.length > 0) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${kits[0].id}`);
            if (Array.isArray(resComp.data) && resComp.data.length > 0) {
              for (const comp of resComp.data) {
                const compSku = comp.component_sku;
                try {
                  const resCompInv = await axios.get(`/api/inventory`, { params: { search: compSku } });
                  const compUnit = Array.isArray(resCompInv.data.items) ? resCompInv.data.items.find(p => p.sku === compSku && !p.is_composite) : null;
                  if (compUnit) {
                    componentesDetalhados.push({ ...compUnit, quantidadeNoComposto: comp.quantity });
                  }
                } catch (e) {
                  console.warn('[MovInteligente] Erro ao buscar detalhe do componente:', compSku, e);
                }
              }
            }
          } catch (e) {
            console.warn('[MovInteligente] Erro ao buscar componentes do kit:', e);
          }
        }
        console.log('[MovInteligente] Unitário:', unitario, 'Kits:', kits, 'Componentes:', componentes, 'ComponentesDetalhados:', componentesDetalhados);
      }
    } catch (e) {
      console.warn('[MovInteligente] Erro ao buscar saldos:', e);
    }
    return { unitario, kits, componentesDetalhados };
  }

  // Movimentação inteligente
  const movimentarEstoqueAposImpressao = async () => {
    setProcessingExpedition(true);
    try {
      const notasParaExpedir = todasNotas.filter(nota => !nota.isManual && selectedNotas.includes(nota.id) && !expedidas.includes(String(nota.id)));
      if (notasParaExpedir.length === 0) return;
      
      // Controle de concorrência: processar uma nota por vez
      for (const nota of notasParaExpedir) {
        console.log(`[MovInteligente] Processando nota ${nota.id}`);
        // 0) Claim lock no backend para evitar dupla expedição
        let touchInterval = null;
        try {
          const claim = await axios.post('/api/notas-expedidas/claim', { id: nota.id, owner: ownerIdRef.current, accountId: activeAccountId });
          if (!claim.data || claim.data.claimed !== true) {
            const motivo = claim.data?.alreadyExpedited ? 'já expedida' : 'em processamento';
            console.warn(`[MovInteligente] Nota ${nota.id} ${motivo}. Pulando.`);
            continue;
          }
          // claim OK: refletir no UI para feedback imediato
          setNotasEmProcessamento(prev => {
            const next = new Set(prev);
            next.add(nota.id);
            return next;
          });
          // iniciar heartbeat para manter o lock vivo enquanto processa
          touchInterval = setInterval(async () => {
            try {
              await axios.post('/api/notas-expedidas/touch', { id: nota.id, owner: ownerIdRef.current, accountId: activeAccountId });
            } catch {}
          }, 120000); // 2 minutos
        } catch (e) {
          console.warn(`[MovInteligente] Não foi possível reservar a nota ${nota.id}. Pulando.`, e.message);
          continue;
        }
        
        // Detectar Mercado Livre Full (estoque externo)
        const marketplaceNome = exibirMarketplace(nota);
        const isMercadoLivreFull = String(marketplaceNome || '').toLowerCase().includes('mercado livre full');

        // Apenas movimenta estoque se não for ML Full
        if (!isMercadoLivreFull) {
        for (const item of (nota.itens || [])) {
          if (!item.codigo || !item.quantidade) continue;
          
          const skuOriginal = item.codigo;
          const skuBase = limparSkuB(skuOriginal);
          console.log(`[MovInteligente] Processando item: ${skuOriginal} -> ${skuBase}, quantidade: ${item.quantidade}`);
          
          // Buscar saldos unitário, kits e componentes detalhados
          const { unitario, kits, componentesDetalhados } = await buscarSaldosUnitarioEKit(skuBase);
          
          // A partir daqui vamos movimentar componentes diretamente (sem duplicar)
          const quantidadePedido = Number(item.quantidade) || 0;
          
          // 1. Se houver componentes detalhados, movimentar primeiro os componentes unitários
          if (componentesDetalhados && componentesDetalhados.length > 0) {
            console.log(`[MovInteligente] Movimentando ${componentesDetalhados.length} componentes detalhados`);
            
            for (const compUnit of componentesDetalhados) {
              if (!compUnit) {
                console.warn(`[MovInteligente] Componente unitário não encontrado para SKU do componente.`);
                continue;
              }
              
              // Buscar a quantidade necessária de cada componente
              const qtdCompNecessaria = quantidadePedido * (Number(compUnit.quantidadeNoComposto) || 1);
              const qtdMov = Math.min(compUnit.quantity || 0, qtdCompNecessaria);
              console.log(`[MovInteligente] Componente ${compUnit.sku}: necessário ${qtdCompNecessaria}, disponível ${compUnit.quantity}, movendo ${qtdMov}`);
              if (qtdMov > 0) {
                try {
                  await axios.post(`/api/inventory/${compUnit.id}/movement`, {
                    movement_type: 'out',
                    quantity: qtdMov,
                    reason: `Separação de pedido (componente de ${skuBase})`,
                    accountId: activeAccountId
                  });
                  console.log(`[MovInteligente] Movimentação do componente ${compUnit.sku} concluída`);
                } catch (e) {
                  console.error(`[MovInteligente] Erro ao movimentar componente ${compUnit.sku}:`, e.message);
                }
              }
              if (qtdMov < qtdCompNecessaria) {
                console.warn(`[MovInteligente] Parcial: faltaram ${qtdCompNecessaria - qtdMov} unidade(s) do componente ${compUnit.sku}`);
              }
            }
          }
          // 2. Movimentar unitários do próprio SKU (caso não seja composto)
          if (unitario && unitario.id && unitario.quantity > 0) {
            // Para SKUs unitários, tentar movimentar diretamente
            if (!unitario.is_composite) {
              const qtdMov = Math.min(unitario.quantity, quantidadePedido);
              console.log(`[MovInteligente] Movimentando ${qtdMov} unitário(s) do SKU ${skuBase} (id: ${unitario.id})`);
              try {
                await axios.post(`/api/inventory/${unitario.id}/movement`, {
                  movement_type: 'out',
                  quantity: qtdMov,
                  reason: 'Separação de pedido (unitário)',
                  accountId: activeAccountId
                });
                console.log(`[MovInteligente] Movimentação do SKU unitário ${skuBase} concluída`);
              } catch (e) {
                console.error(`[MovInteligente] Erro ao movimentar SKU ${skuBase}:`, e.message);
              }
            } else {
              console.log(`[MovInteligente] SKU ${skuBase} (id: ${unitario.id}) é composto, movimentando componentes em vez do SKU principal`);
            }
          }
          // 3. Se não tínhamos componentesDetalhados (fallback), movimentar componentes via definição do kit
          if ((!componentesDetalhados || componentesDetalhados.length === 0) && kits && kits.length > 0) {
            console.log(`[MovInteligente] Tentando movimentar componentes de ${kits.length} kits disponíveis`);
            
            for (const kit of kits) {
              if (kit && kit.id && kit.quantity > 0) {
                try {
                  console.log(`[MovInteligente] Processando kit ${kit.sku} (id: ${kit.id})`);
                  
                  // Buscar componentes do kit
                  const resComp = await axios.get(`/api/composite-skus/${kit.id}`);
                  if (Array.isArray(resComp.data) && resComp.data.length > 0) {
                    console.log(`[MovInteligente] Kit ${kit.sku} tem ${resComp.data.length} componentes`);
                    
                    // Para cada componente do kit, tentar movimentar diretamente
                    for (const comp of resComp.data) {
                      // Buscar o componente no estoque
                      const resCompInv = await axios.get(`/api/inventory`, { params: { search: comp.component_sku } });
                      const compUnit = Array.isArray(resCompInv.data.items) ? resCompInv.data.items.find(p => !p.is_composite && (p.sku === comp.component_sku || p.sku.replace(/[A-Z]+$/, '') === comp.component_sku)) : null;
                      
                      if (compUnit && compUnit.quantity > 0) {
                        // Calcular quantas unidades deste componente são necessárias
                        const qtdCompNecessaria = quantidadePedido * (Number(comp.quantity) || 1);
                        const qtdMov = Math.min(compUnit.quantity || 0, qtdCompNecessaria);
                        
                        if (qtdMov > 0) {
                          console.log(`[MovInteligente] Movimentando ${qtdMov} unidade(s) do componente ${compUnit.sku} (id: ${compUnit.id}) do kit ${kit.sku}`);
                          try {
                            await axios.post(`/api/inventory/${compUnit.id}/movement`, {
                              movement_type: 'out',
                              quantity: qtdMov,
                              reason: `Separação de pedido (componente do kit ${kit.sku})`,
                              accountId: activeAccountId
                            });
                            console.log(`[MovInteligente] Movimentação do componente ${compUnit.sku} do kit ${kit.sku} concluída`);
                          } catch (e) {
                            console.error(`[MovInteligente] Erro ao movimentar componente ${compUnit.sku} do kit ${kit.sku}:`, e.message);
                          }
                        }
                        if (qtdMov < qtdCompNecessaria) {
                          console.warn(`[MovInteligente] Parcial (via kit): faltaram ${qtdCompNecessaria - qtdMov} unidade(s) do componente ${compUnit.sku}`);
                        }
                      } else {
                        console.warn(`[MovInteligente] Componente ${comp.component_sku} do kit ${kit.sku} não encontrado ou sem estoque`);
                      }
                    }
                  }
                } catch (e) {
                  console.error('[MovInteligente] Erro ao processar componentes do kit:', kit.sku, e);
                }
              }
            }
          }
          // 4. Se ainda faltar, logar/alertar
          console.log(`[MovInteligente] Movimentação finalizada para SKU ${skuBase}`);
        }
        } else {
          console.log(`[MovInteligente] Nota ${nota.id} é Mercado Livre Full. Pulando movimentação de estoque.`);
        }
        
        // Marcar nota como expedida
        console.log(`[MovInteligente] Marcando nota ${nota.id} como expedida`);
        try {
          await axios.post('/api/notas-expedidas', {
            id: nota.id,
            numero: nota.numero,
            codigo: nota.itens && nota.itens[0] ? nota.itens[0].codigo : '',
            numeroLoja: nota.numeroLoja,
            cliente: nota.cliente,
            valorNota: nota.valorNota || 0,
            itens: Array.isArray(nota.itens) ? nota.itens.map(it => ({
              codigo: it.codigo,
              quantidade: it.quantidade,
              title: it.descricao || it.titulo || undefined
            })) : [],
            accountId: activeAccountId
          });
          console.log(`[MovInteligente] Nota ${nota.id} marcada como expedida com sucesso`);
        } catch (e) {
          console.error(`[MovInteligente] Erro ao marcar nota ${nota.id} como expedida:`, e.message);
        } finally {
          // sempre liberar lock ao final
          if (touchInterval) { try { clearInterval(touchInterval); } catch {} }
          try { await axios.post('/api/notas-expedidas/release', { id: nota.id, owner: ownerIdRef.current, accountId: activeAccountId }); } catch {}
          setNotasEmProcessamento(prev => {
            const next = new Set(prev);
            next.delete(nota.id);
            return next;
          });
        }
      }
      
      // Atualizar lista de expedidas
      console.log('[MovInteligente] Atualizando lista de expedidas');
      try {
        const res = await axios.get('/api/notas-expedidas', { params: { accountId: activeAccountId } });
        setExpedidas((res.data.expedidas || []).map(id => String(id)));
      } catch (e) {
        console.error('[MovInteligente] Erro ao atualizar lista de expedidas:', e.message);
      }
      // sincronizar locks ativos pós-processamento
      try {
        const resLocks = await axios.get('/api/notas-expedidas/locks', { params: { accountId: activeAccountId } });
        const ids = Array.isArray(resLocks.data?.locks) ? resLocks.data.locks : [];
        setNotasEmProcessamento(new Set(ids));
      } catch {}
      
      // Atualizar estoque/produtos para garantir saldos corretos no próximo aglutinado
      console.log('[MovInteligente] Atualizando dados do estoque');
      try {
        await fetchData();
      } catch (e) {
        console.error('[MovInteligente] Erro ao atualizar dados do estoque:', e.message);
      }
      
      // Pequeno delay para garantir atualização do backend
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('[MovInteligente] Processamento de movimentação concluído');
    } finally {
      setProcessingExpedition(false);
    }
  };

  const buscarTitulosEstoqueParaAglutinado = async (itensAgrupados) => {
    const skus = Object.keys(itensAgrupados);
    for (const sku of skus) {
      const skuLimpo = limparSkuB(sku);
      if (!skuLimpo) continue;
      try {
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo } });
        const produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto && produto.title) {
          itensAgrupados[sku].titulo = produto.title;
        }
      } catch (e) {
        // Se não encontrar, mantém o título original
      }
    }
  };

  const imprimirPedidosIndividuais = async (dataExpedicaoParam) => {
    const dataExpedicao = dataExpedicaoParam || expeditionDate || new Date().toISOString().slice(0,10);
    const pedidosSelecionados = todasNotas.filter(nota => selectedNotas.some(sid => String(sid) === String(nota.id)));
    // Buscar saldo correto para todos os SKUs de todos os pedidos selecionados
    const allSkus = Array.from(new Set(pedidosSelecionados.flatMap(nota => (nota.itens || []).map(item => item.codigo || 'SKU-NÃO-INFORMADO'))));
    const saldoMap = await getCompositeStocksForSkus(allSkus);
    // Buscar títulos do estoque para cada SKU sem letras
    const skuToTitle = {};
    allSkus.forEach(sku => {
      const skuSemLetras = sku.replace(/[a-zA-Z]+/g, '');
      const prod = products.find(p => p.sku === skuSemLetras);
      if (prod && prod.title) skuToTitle[sku] = prod.title;
    });
    // Novo: converter kits em unitários e agrupar
    const inventoryCache = {};
    const pedidosConvertidos = [];
    for (const nota of pedidosSelecionados) {
      const itensConvertidos = [];
      for (const item of (nota.itens || [])) {
        const convertido = await converterKitParaUnitario(item, inventoryCache);
        itensConvertidos.push(convertido);
      }
      pedidosConvertidos.push({ ...nota, itens: itensConvertidos });
    }
    // Renderização
    const conteudo = `
      <html>
        <head>
          <title>Pedidos</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; font-size: 13px; text-align: left; }
            .bloco-borda { border: 1px solid #bbb; border-radius: 6px; padding: 18px; margin-bottom: 24px; background: #fff; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
            th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
            th { background-color: #f2f2f2; }
            .header { margin-bottom: 16px; font-size: 15px; text-align: left; display: flex; justify-content: space-between; align-items: center; }
            .footer { margin-top: 16px; font-size: 11px; text-align: left; }
            .page-break { page-break-after: always; }
          </style>
        </head>
        <body>
          ${pedidosConvertidos.map(nota => {
            // Agrupar itens por SKU unitário
            const itensAgrupados = {};
            nota.itens.forEach(item => {
              const sku = item.sku;
              if (!itensAgrupados[sku]) {
                itensAgrupados[sku] = {
                  sku: sku,
                  titulo: item.titulo,
                  quantidade: 0,
                  localizacao: item.localizacao || '',
                  saldo: item.saldo
                };
              }
              itensAgrupados[sku].quantidade += parseInt(item.quantidade) || 0;
              if (item.localizacao && !itensAgrupados[sku].localizacao.includes(item.localizacao)) {
                if (itensAgrupados[sku].localizacao) {
                  itensAgrupados[sku].localizacao += ', ' + item.localizacao;
                } else {
                  itensAgrupados[sku].localizacao = item.localizacao;
                }
              }
            });
            // Atualizar saldo dos itens do pedido
            Object.keys(itensAgrupados).forEach(sku => {
              if (saldoMap[sku] !== undefined) {
                itensAgrupados[sku].saldo = saldoMap[sku];
              }
              // Atualizar título do estoque se existir
              const skuSemLetras = sku.replace(/[a-zA-Z]+/g, '');
              if (skuToTitle[sku]) {
                itensAgrupados[sku].titulo = skuToTitle[sku];
              } else if (skuSemLetras && products.find(p => p.sku === skuSemLetras)) {
                itensAgrupados[sku].titulo = products.find(p => p.sku === skuSemLetras).title;
              }
            });
            return `
              <div class=\"bloco-borda\">
                <div class=\"header\">
                  <div>
                  <h2 style=\"font-size:18px;\">Pedido</h2>
                  <p>Nome: ${nota.cliente || 'Cliente não informado'}</p>
                  <p>Número: ${nota.isManual ? ('PM #' + (nota.numero || '-')) : (nota.numero || '-')}</p>
                    <p>Número Loja: ${nota.numeroLoja || '-'} </p>
                    <p>Marketplace: ${exibirMarketplace(nota)} </p>
                    <p>Conta: ${getAccountLabel(nota.accountId, nota.isManual)} </p>
                  <p>Data de Emissão: ${nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleDateString('pt-BR') : 'Não informada'}</p>
                  </div>
                  <div style=\"text-align:right;font-weight:bold;min-width:160px;\">Data de Expedição:<br>${dataExpedicao.split('-').reverse().join('/')}</div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Título</th>
                      <th>Quantidade</th>
                      <th>Localização</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${Object.values(itensAgrupados).map(item => `
                      <tr>
                        <td>${removerLetrasSku(item.sku)}</td>
                        <td>${item.titulo}</td>
                        <td style=\"text-align: center; vertical-align: middle;\">${item.quantidade}</td>
                        <td style=\"text-align: center; vertical-align: middle;\">${item.localizacao || '-'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              <div class=\"page-break\"></div>
            `;
          }).join('')}
        </body>
      </html>
    `;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(conteudo);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(async () => {
      printWindow.print();
      printWindow.close();
      // Só movimenta estoque se houver pedidos não expedidos
      if (pedidosSelecionados.some(nota => !expedidas.includes(String(nota.id)))) {
        await movimentarEstoqueAposImpressao();
      }
    }, 500);
  };

  // Função utilitária para buscar saldo correto de vários SKUs (kits/compostos)
  const getCompositeStocksForSkus = async (skus) => {
    const saldoMap = {};
    await Promise.all(skus.map(async (sku) => {
      const skuLimpo = limparSkuB(sku);
      try {
        // Buscar produto pelo SKU limpo SEMPRE do backend
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo, t: Date.now() } });
        const produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto && produto.is_composite) {
          const saldo = await getCompositeStock(produto.id);
          saldoMap[sku] = saldo;
        } else if (produto) {
          saldoMap[sku] = produto.quantity;
        }
      } catch {}
    }));
    return saldoMap;
  };

  // Função utilitária para buscar saldo de kit/composto
  const getCompositeStock = async (produtoId) => {
    try {
      const res = await axios.get(`/api/inventory/${produtoId}/composite-stock`);
      return res.data.max_possible;
    } catch {
      return 0;
    }
  };



  // Função utilitária: identifica se um SKU é kit e retorna info do componente
  async function converterKitParaUnitario(item, inventoryCache) {
    // Busca o produto pelo SKU
    let produto = null;
    const skuLimpo = limparSkuB(item.codigo);
    console.log('[CONVERSÃO KIT] SKU original:', item.codigo, 'SKU limpo:', skuLimpo);
    
    if (inventoryCache[skuLimpo]) {
      produto = inventoryCache[skuLimpo];
      console.log('[CONVERSÃO KIT] Produto encontrado no cache:', produto);
    } else {
      try {
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo } });
        produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto) {
          inventoryCache[skuLimpo] = produto;
          console.log('[CONVERSÃO KIT] Produto encontrado no backend:', produto);
        } else {
          console.log('[CONVERSÃO KIT] Produto NÃO encontrado no backend para SKU:', skuLimpo);
        }
      } catch (e) {
        console.log('[CONVERSÃO KIT] Erro ao buscar produto:', e);
      }
    }
    
    if (produto && produto.is_composite) {
      console.log('[CONVERSÃO KIT] Produto é composto, buscando componentes...');
      // Buscar componentes do kit
      try {
        const resComp = await axios.get(`/api/composite-skus/${produto.id}`);
        const componentes = resComp.data;
        console.log('[CONVERSÃO KIT] Componentes encontrados:', componentes);
        if (componentes.length === 1) {
          // É kit simples: converter normalmente
          const comp = componentes[0];
          console.log('[CONVERSÃO KIT] Componente único:', comp);
          // Buscar info do componente unitário
          let compProduto = null;
          const compSkuLimpo = limparSkuB(comp.component_sku);
          if (inventoryCache[compSkuLimpo]) {
            compProduto = inventoryCache[compSkuLimpo];
          } else {
            const resInv2 = await axios.get(`/api/inventory`, { params: { search: compSkuLimpo } });
            compProduto = Array.isArray(resInv2.data.items) ? resInv2.data.items.find(p => p.sku === compSkuLimpo) : null;
            if (compProduto) inventoryCache[compSkuLimpo] = compProduto;
          }
          if (compProduto) {
            console.log('[CONVERSÃO KIT] Kit convertido com sucesso para:', compProduto.sku);
            return {
              sku: compProduto.sku,
              titulo: compProduto.title,
              quantidade: (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1),
              localizacao: compProduto.location || '',
              saldo: compProduto.quantity,
              originalKit: item.codigo
            };
          } else {
            console.log('[CONVERSÃO KIT] Componente unitário não encontrado para SKU:', compSkuLimpo);
          }
        } else if (componentes.length > 1) {
          // É composto: NÃO converter, retornar o item original
          console.log('[CONVERSÃO KIT] Produto é composto (não kit). Não converter.');
          return {
            sku: item.codigo || 'SKU-NÃO-INFORMADO',
            titulo: item.descricao || 'Produto não informado',
            quantidade: parseInt(item.quantidade) || 0,
            localizacao: item.localizacao || '',
            saldo: item.saldo,
            originalKit: null
          };
        }
      } catch (e) {
        console.log('[CONVERSÃO KIT] Erro ao buscar componentes:', e);
      }
    } else {
      console.log('[CONVERSÃO KIT] Produto não é composto ou não foi encontrado. Retornando item original.');
    }
    // Não é kit, retorna o próprio item
    return {
      sku: item.codigo || 'SKU-NÃO-INFORMADO',
      titulo: item.descricao || 'Produto não informado',
      quantidade: parseInt(item.quantidade) || 0,
      localizacao: item.localizacao || '',
      saldo: item.saldo,
      originalKit: null
    };
  }

  // Alerta amigável para erro de componentes insuficientes
  // (Removido bloco solto que usava pedidosSelecionados e itensAgrupados fora de função)

  const imprimirPedidos = async (dataExpedicaoParam) => {
    const dataExpedicao = dataExpedicaoParam || expeditionDate || new Date().toISOString().slice(0,10);
    if (selectedNotas.length === 0) return;
    if (aglutinar) {
      const pedidosSelecionados = todasNotas.filter(nota => selectedNotas.some(sid => String(sid) === String(nota.id)));
      // Novo agrupamento: por SKU unitário, somando quantidades e juntando marketplaces
      const itensAgrupados = {};
      const inventoryCache = {};
      // Novo: mapa de produção por SKU
      const producaoPorSku = {};
      for (const nota of pedidosSelecionados) {
        for (const item of (nota.itens || [])) {
          const convertido = await converterKitParaUnitario(item, inventoryCache);
          const chave = limparSkuB(convertido.sku);
          if (!itensAgrupados[chave]) {
            itensAgrupados[chave] = {
              sku: convertido.sku,
              titulo: convertido.titulo,
              quantidade: 0,
              localizacao: convertido.localizacao || '',
              saldo: convertido.saldo,
              marketplaces: new Set(),
            };
          }
          itensAgrupados[chave].quantidade += convertido.quantidade;
          if (item.localizacao && !itensAgrupados[chave].localizacao.includes(item.localizacao)) {
            if (itensAgrupados[chave].localizacao) {
              itensAgrupados[chave].localizacao += ', ' + item.localizacao;
            } else {
              itensAgrupados[chave].localizacao = item.localizacao;
            }
          }
          // Adiciona marketplace ao Set
          const marketplace = exibirMarketplace(nota, item);
          if (marketplace && typeof marketplace === 'string' && marketplace.trim() !== '') {
            itensAgrupados[chave].marketplaces.add(marketplace.trim());
          }
        }
      }
      // Buscar saldo correto para kits/compostos
      const saldoMap = await getCompositeStocksForSkus(Object.values(itensAgrupados).map(i => i.sku));
      Object.values(itensAgrupados).forEach(item => {
        if (saldoMap[item.sku] !== undefined) {
          item.saldo = saldoMap[item.sku];
        }
      });
      // Buscar títulos do estoque para cada SKU aglutinado
      await buscarTitulosEstoqueParaAglutinado(itensAgrupados);

      // NOVO: calcular produção necessária para SKUs compostos
      console.log('[PRODUÇÃO] Iniciando cálculo de produção para', Object.values(itensAgrupados).length, 'itens');
      for (const item of Object.values(itensAgrupados)) {
        // Buscar detalhes do produto diretamente do inventário
        let produtoPrincipal = null;
        try {
          const skuLimpo = limparSkuB(item.sku);
          const resInvPrincipal = await axios.get(`/api/inventory`, { params: { search: skuLimpo } });
          produtoPrincipal = Array.isArray(resInvPrincipal.data.items) ? resInvPrincipal.data.items.find(p => p.sku === skuLimpo) : null;
          console.log('[PRODUÇÃO] Buscando produto principal para SKU:', item.sku, 'SKU limpo:', skuLimpo, 'Encontrado:', !!produtoPrincipal, 'É composto:', produtoPrincipal?.is_composite);
        } catch (e) {
          console.log('[PRODUÇÃO] Erro ao buscar produto principal:', e);
        }
        if (produtoPrincipal && produtoPrincipal.is_composite && (item.saldo === undefined || item.saldo < item.quantidade)) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${produtoPrincipal.id}`);
            const componentes = resComp.data;
            if (Array.isArray(componentes) && componentes.length > 0) {
              for (const comp of componentes) {
                let compProduto = null;
                try {
                  const resInv = await axios.get(`/api/inventory`, { params: { search: comp.component_sku } });
                  compProduto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === comp.component_sku && !p.is_composite) : null;
                } catch {}
                let compTitle = compProduto ? compProduto.title : comp.component_sku;
                let saldoComp = compProduto ? compProduto.quantity : 0;
                const qtdNecessaria = (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1);
                if (saldoComp < qtdNecessaria) {
                  if (!producaoPorSku[item.sku]) producaoPorSku[item.sku] = [];
                  producaoPorSku[item.sku].push(`${qtdNecessaria - saldoComp} un ${compTitle}`);
                }
              }
            }
          } catch {}
        }
      }

      // Atualizar producaoPorSku com saldo atualizado dos componentes
      for (const item of Object.values(itensAgrupados)) {
        const skuLimpo = limparSkuB(item.sku);
        const produto = products.find(p => p.sku === skuLimpo);
        if (produto && produto.is_composite) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${produto.id}`);
            const componentes = resComp.data;
            if (Array.isArray(componentes) && componentes.length > 0) {
              for (const comp of componentes) {
                let compProduto = null;
                try {
                  const resInv = await axios.get(`/api/inventory`, { params: { search: comp.component_sku } });
                  compProduto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === comp.component_sku) : null;
                } catch {}
                let compTitle = compProduto ? compProduto.title : comp.component_sku;
                let saldoComp = compProduto ? compProduto.quantity : 0;
                const qtdNecessaria = (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1);
                if (saldoComp < qtdNecessaria) {
                  if (!producaoPorSku[item.sku]) producaoPorSku[item.sku] = [];
                  producaoPorSku[item.sku].push(`${qtdNecessaria - saldoComp} un ${compTitle}`);
                }
              }
            }
          } catch {}
        }
      }

      // Renderização da tabela
      const conteudo = `
        <html>
          <head>
            <title>Pedidos Aglutinados</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; font-size: 13px; }
              .bloco-borda { border: 1px solid #bbb; border-radius: 6px; padding: 18px; margin-bottom: 24px; background: #fff; }
              table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
              th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
              th { background-color: #f2f2f2; }
              .header { margin-bottom: 16px; font-size: 15px; text-align: left; display: flex; justify-content: space-between; align-items: center; }
              .footer { margin-top: 16px; font-size: 11px; text-align: left; }
            </style>
          </head>
          <body>
            <div class="bloco-borda">
              <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">
                <div style="min-width:220px;max-width:320px;">
                  <h2 style="font-size:18px;margin-bottom:8px;">Pedidos Aglutinados</h2>
                  <div style="font-size:12px;line-height:1.4;">${pedidosSelecionados.map(nota => `${nota.cliente || 'Cliente não informado'} (NF: ${nota.numero})`).join('<br/>')}</div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:180px;">
                  <div style="font-weight:bold;font-size:15px;">Data de Expedição: <span style="font-weight:600;">${dataExpedicao.split('-').reverse().join('/')}</span></div>
                  <div style="font-size:13px;">Total de pedidos: ${selectedNotas.length}</div>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Título</th>
                    <th>Quantidade</th>
                    <th>Localização</th>
                    <th>Saldo</th>
                    <th>Produção</th>
                    <th>Marketplace(s)</th>
                  </tr>
                </thead>
                <tbody>
                  ${Object.values(itensAgrupados)
                    .sort((a, b) => parseInt(a.sku) - parseInt(b.sku))
                    .map(item => {
                      const saldoNum = parseInt(item.saldo) || 0;
                      const qtdNum = parseInt(item.quantidade) || 0;
                      let producao = '';
                      // Adiciona log para depuração
                      console.log('[AGLUTINADO PRODUCAO DEBUG]', item.sku, 'SKU limpo:', limparSkuB(item.sku), producaoPorSku[item.sku]);
                      if (producaoPorSku[item.sku] && producaoPorSku[item.sku].length > 0) {
                        producao = producaoPorSku[item.sku].join('<br/>');
                      } else if (saldoNum < qtdNum) {
                        producao = (qtdNum - saldoNum) + ' un.';
                      } else {
                        producao = '';
                      }
                      return `
                        <tr>
                          <td>${removerLetrasSku(item.sku)}</td>
                          <td>${item.titulo}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.quantidade}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.localizacao || '-'}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.saldo !== undefined ? item.saldo : '-'}</td>
                          <td style="color: red; font-weight: bold; text-align: center; vertical-align: middle;">${producao}</td>
                          <td style="text-align: center; vertical-align: middle;">${Array.from(item.marketplaces).map(mk => mk === 'EBAZAR.COM.BR LTDA' ? 'Mercado Livre Full' : mk).join(', ')}</td>
                        </tr>
                      `;
                    }).join('')}
                </tbody>
              </table>
            </div>
            <div class="footer" style="margin-top:16px;font-size:13px;text-align:right;">Data: ${new Date().toLocaleDateString('pt-BR')}</div>
          </body>
        </html>
      `;
      // Log para debug visual do HTML gerado
      console.log('[AGLUTINADO HTML]', conteudo);
      const printWindow = window.open('', '_blank');
      printWindow.document.write(conteudo);
      printWindow.document.close();
      printWindow.focus();
      // Salvar aglutinado no backend
      try {
        await axios.post('/api/aglutinados', {
          marketplaces: Array.from(new Set(pedidosSelecionados.map(n => n.marketplace))).join(', '),
          conteudo_html: conteudo,
          conteudo_json: JSON.stringify(pedidosSelecionados)
        });
      } catch (e) {
        console.error('Erro ao salvar aglutinado:', e);
      }
      setTimeout(async () => {
        printWindow.print();
        printWindow.close();
        // Só movimenta estoque se houver pedidos não expedidos
        if (pedidosSelecionados.some(nota => !expedidas.includes(String(nota.id)))) {
          await movimentarEstoqueAposImpressao();
        }
      }, 500);
    } else {
      await imprimirPedidosIndividuais(dataExpedicao);
    }
  };

  const agruparPorMarketplace = (notas) => {
    const marketplaces = {};
    notas.forEach(nota => {
      const mk = exibirMarketplace(nota) || 'Desconhecido';
      if (!marketplaces[mk]) marketplaces[mk] = [];
      marketplaces[mk].push(nota);
    });
    return marketplaces;
  };

  const fetchAglutinados = async () => {
    setLoadingAglutinados(true);
    try {
      const res = await axios.get('/api/aglutinados');
      setAglutinados(res.data);
    } catch {
      setAglutinados([]);
    }
    setLoadingAglutinados(false);
  };

  const handleVisualizarAglutinado = async (id) => {
    try {
      const res = await axios.get(`/api/aglutinados/${id}`);
      setVisualizarAglutinado(res.data);
    } catch {
      setVisualizarAglutinado(null);
    }
  };

  const handleImprimirAglutinado = (conteudo_html) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(conteudo_html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  // Paginação do histórico de aglutinados (definir dentro do componente, antes do JSX do modal)
  const totalAglutinados = aglutinados.length;
  const totalPages = Math.ceil(totalAglutinados / aglutinadosPerPage);
  const paginatedAglutinados = aglutinados.slice((aglutinadosPage - 1) * aglutinadosPerPage, aglutinadosPage * aglutinadosPerPage);

  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [expeditionDate, setExpeditionDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Função para abrir menu e definir data de expedição
  const handlePrintMenu = () => setShowPrintMenu(v => !v);
  const handleExpedirHoje = () => {
    const hoje = new Date();
    const yyyy = hoje.getFullYear();
    const mm = String(hoje.getMonth() + 1).padStart(2, '0');
    const dd = String(hoje.getDate()).padStart(2, '0');
    setExpeditionDate(`${yyyy}-${mm}-${dd}`);
    setShowPrintMenu(false);
    setShowDatePicker(false);
    imprimirPedidosComData(`${yyyy}-${mm}-${dd}`);
  };
  const handleSelecionarData = () => {
    setShowDatePicker(true);
    setShowPrintMenu(false);
  };
  const handleDateChange = (e) => {
    setExpeditionDate(e.target.value);
  };
  const handleConfirmarData = () => {
    if (expeditionDate) {
      setShowDatePicker(false);
      imprimirPedidosComData(expeditionDate);
    }
  };

  // Função wrapper para impressão com data
  const imprimirPedidosComData = async (dataExpedicao) => {
    await imprimirPedidos(dataExpedicao);
  };

  // Picklist por localização (opcional)
  const imprimirPicklistPorLocalizacao = async (dataExpedicaoParam) => {
    const dataExpedicao = dataExpedicaoParam || new Date().toISOString().slice(0,10);
    const pedidosSelecionados = todasNotas.filter(nota => selectedNotas.some(sid => String(sid) === String(nota.id)));
    const inventoryCache = {};
    const agrupados = {};
    for (const nota of pedidosSelecionados) {
      for (const item of (nota.itens || [])) {
        const convertido = await converterKitParaUnitario(item, inventoryCache);
        const chave = limparSkuB(convertido.sku);
        if (!agrupados[chave]) {
          agrupados[chave] = { sku: convertido.sku, titulo: convertido.titulo, quantidade: 0, localizacao: convertido.localizacao || '' };
        }
        agrupados[chave].quantidade += convertido.quantidade;
        if (convertido.localizacao && !agrupados[chave].localizacao.includes(convertido.localizacao)) {
          agrupados[chave].localizacao = agrupados[chave].localizacao ? (agrupados[chave].localizacao + ', ' + convertido.localizacao) : convertido.localizacao;
        }
      }
    }
    const itens = Object.values(agrupados).sort((a,b) => String(a.localizacao || '').localeCompare(String(b.localizacao || '')));
    const conteudo = `
      <html>
        <head>
          <title>Picklist</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; font-size: 13px; }
            .bloco-borda { border: 1px solid #bbb; border-radius: 6px; padding: 18px; margin-bottom: 24px; background: #fff; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
            th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
            th { background-color: #f2f2f2; }
          </style>
        </head>
        <body>
          <div class="bloco-borda">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <h2 style="font-size:18px;">Picklist por Localização</h2>
              <div style="font-weight:bold;">Data de Expedição: ${dataExpedicao.split('-').reverse().join('/')}</div>
            </div>
            <table>
              <thead><tr><th>Localização</th><th>SKU</th><th>Título</th><th>Quantidade</th></tr></thead>
              <tbody>
                ${itens.map(i => `<tr><td style="text-align:center;">${i.localizacao || '-'}</td><td>${removerLetrasSku(i.sku)}</td><td>${i.titulo}</td><td style="text-align:center;">${i.quantidade}</td></tr>`).join('')}
              </tbody>
            </table>
          </div>
        </body>
      </html>`;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(conteudo);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => { printWindow.print(); printWindow.close(); }, 400);
  };

  // Função utilitária para normalizar SKU removendo letras do final (inclusive B)
  function normalizarSku(sku) {
    if (!sku) return '';
    // Remove apenas letras do final, preservando números, hífens, etc.
    return sku.replace(/[a-zA-Z]+$/, '');
  }

  // Função utilitária para exibir marketplace padronizado
  function exibirMarketplace(nota, item) {
    const cliente = String(nota?.cliente || item?.cliente || '').toUpperCase();
    const numeroLoja = String(nota?.numeroLoja || item?.numeroLoja || '').toUpperCase();
    const mkRaw = item?.marketplace || nota?.marketplace || '';
    const mk = String(mkRaw).toUpperCase();
    // Mercado Livre Full: priorizar antes de "Mercado Livre"
    if ((mk.includes('MERCADO LIVRE') && mk.includes('FULL')) || /^\d{8}$/.test(numeroLoja) || cliente.includes('EBAZAR.COM.BR LTDA')) {
      return 'Mercado Livre Full';
    }
    // Normalização por heurísticas restantes
    if (mk.includes('SHEIN') || numeroLoja.startsWith('GSH') || numeroLoja.startsWith('GS')) return 'Shein';
    if (mk.includes('MERCADO LIVRE')) return 'Mercado Livre';
    if (mk.includes('AMAZON')) return 'Amazon';
    if (mk.includes('MAGALU') || mk.includes('LUIZA')) return 'Magalu';
    if (mk.includes('SHOPEE')) return 'Shopee';
    if (mk.includes('LEROY')) return 'Leroy Merlin';
    return mkRaw || '-';
  }

  // Função para gerar chave única por SKU + marketplace
  function chaveAgrupamento(item, nota) {
    return `${normalizarSku(item.codigo || 'SKU-NÃO-INFORMADO')}|${item.marketplace || nota.marketplace || '-'}`;
  }

  function removerLetrasSku(sku) {
    return (sku || '').replace(/[a-zA-Z]+/g, '');
  }

  // Função utilitária para limpar letras do final do SKU (ex.: 51502F → 51502, 50583B → 50583)
  // Mantém compatibilidade com usos existentes de "limparSkuB"
  function limparSkuB(sku) {
    return typeof sku === 'string' ? sku.replace(/[a-zA-Z]+$/, '') : sku;
  }

  // Monta texto do tooltip com itens da nota
  function tooltipItensNota(nota) {
    try {
      const itens = Array.isArray(nota?.itens) ? nota.itens : [];
      if (itens.length === 0) return 'Sem itens';
      const linhas = itens.slice(0, 20).map(it => {
        const sku = it.codigo || '-';
        const titulo = it.descricao || it.titulo || '-';
        const quantidade = it.quantidade || 0;
        return `${sku} | ${titulo} | Qtd: ${quantidade}`;
      });
      if (itens.length > 20) linhas.push(`... +${itens.length - 20} itens`);
      return linhas.join('\n');
    } catch {
      return '';
    }
  }

  // Render JSX do tooltip com linhas horizontais SKU | Título | Qtd
  const getAccountLabel = (accountId, isManual) => {
    if (isManual) return 'Manual';
    const match = blingAccounts.find(acc => Number(acc.id) === Number(accountId));
    return match?.name || (accountId ? `Conta ${accountId}` : 'Conta');
  };
  function renderTooltipItens(nota) {
    const itens = Array.isArray(nota?.itens) ? nota.itens : [];
    const exibidos = itens.slice(0, 20);
    return (
      <div className="space-y-1 text-sm">
        {exibidos.map((it, i) => {
          const sku = it.codigo || '-';
          const titulo = it.descricao || it.titulo || '-';
          const quantidade = it.quantidade || 0;
          return (
            <div key={i} className="grid grid-cols-[80px,1fr,auto] gap-2 items-center">
              <span className="font-mono text-gray-700 dark:text-gray-300">{sku}</span>
              <span className="text-gray-900 dark:text-white truncate">{titulo}</span>
              <span className="whitespace-nowrap text-gray-700 dark:text-gray-300">Qtd: {quantidade}</span>
            </div>
          );
        })}
        {itens.length > 20 && (
          <div className="text-[11px] text-gray-500">+{itens.length - 20} itens</div>
        )}
      </div>
    );
  }

  // --- Render Marketplace Orders tab ---
  const renderMarketplaceOrders = () => {
    const mktLogos = {
      ml: '/mercado-livre.png',
      shopee: '/shopee.png',
      amazon: '/amazon.png',
      magalu: '/magalu.png',
    };

    const getStatusInfo = (order) => {
      const s = order.status;
      const ss = order.shipping_status;

      if (s === 'error' || order.bling_nfe_status === 'error') return { label: 'Erro', dotColor: 'bg-red-400', textColor: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-100 dark:bg-red-900/30' };
      if (s === 'cancelled') return { label: 'Cancelado', dotColor: 'bg-red-300', textColor: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-50 dark:bg-red-900/20' };

      // Shipping status takes priority for visual display
      if (ss === 'delivered') return { label: 'Entregue', dotColor: 'bg-green-400', textColor: 'text-green-700 dark:text-green-400', bgColor: 'bg-green-50 dark:bg-green-900/20' };
      if (ss === 'shipped' || ss === 'in_transit') return { label: 'Em Trânsito', dotColor: 'bg-cyan-400', textColor: 'text-cyan-700 dark:text-cyan-400', bgColor: 'bg-cyan-50 dark:bg-cyan-900/20' };
      if (ss === 'ready_to_ship') return { label: 'Pronto p/ Envio', dotColor: 'bg-indigo-400', textColor: 'text-indigo-700 dark:text-indigo-400', bgColor: 'bg-indigo-50 dark:bg-indigo-900/20' };
      if (ss === 'handling') return { label: 'Em Manuseio', dotColor: 'bg-orange-400', textColor: 'text-orange-700 dark:text-orange-400', bgColor: 'bg-orange-50 dark:bg-orange-900/20' };
      if (ss === 'pending') return { label: 'Envio Pendente', dotColor: 'bg-amber-400', textColor: 'text-amber-700 dark:text-amber-400', bgColor: 'bg-amber-50 dark:bg-amber-900/20' };
      if (ss === 'cancelled' || ss === 'not_delivered') return { label: 'Envio Cancelado', dotColor: 'bg-red-300', textColor: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-50 dark:bg-red-900/20' };

      // Bling status (only shown when no shipping status available)
      if (order.bling_pedido_id && order.bling_nfe_status === 'generated') return { label: 'NF-e Gerada', dotColor: 'bg-green-400', textColor: 'text-green-700 dark:text-green-400', bgColor: 'bg-green-100 dark:bg-green-900/30' };
      if (order.bling_pedido_id) return { label: 'Enviado Bling', dotColor: 'bg-blue-400', textColor: 'text-blue-700 dark:text-blue-400', bgColor: 'bg-blue-100 dark:bg-blue-900/30' };

      // Fallback to order status
      if (s === 'paid') return { label: 'Pago', dotColor: 'bg-yellow-400', textColor: 'text-yellow-700 dark:text-yellow-400', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30' };
      if (s === 'confirmed') return { label: 'Confirmado', dotColor: 'bg-teal-400', textColor: 'text-teal-700 dark:text-teal-400', bgColor: 'bg-teal-50 dark:bg-teal-900/20' };
      if (s === 'payment_required') return { label: 'Aguard. Pagamento', dotColor: 'bg-amber-400', textColor: 'text-amber-700 dark:text-amber-400', bgColor: 'bg-amber-50 dark:bg-amber-900/20' };
      if (s === 'payment_in_process') return { label: 'Pgto em Processo', dotColor: 'bg-amber-300', textColor: 'text-amber-700 dark:text-amber-400', bgColor: 'bg-amber-50 dark:bg-amber-900/20' };
      return { label: s || 'Pendente', dotColor: 'bg-gray-400', textColor: 'text-gray-600 dark:text-gray-400', bgColor: 'bg-gray-100 dark:bg-gray-800' };
    };

    const groupByDate = (orders) => {
      const groups = {};
      for (const o of orders) {
        const d = o.order_date ? new Date(o.order_date).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }) : 'Sem data';
        if (!groups[d]) groups[d] = [];
        groups[d].push(o);
      }
      return groups;
    };

    const grouped = groupByDate(mktOrders);
    const totalPages = Math.ceil(mktTotal / MKT_PER_PAGE);

    const goToPage = (p) => {
      setMktPage(p);
      fetchMktOrders(p);
    };

    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Store className="w-6 h-6" /> Pedidos Marketplace</h1>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 flex flex-wrap items-end gap-3">
          <div className="relative" ref={mktDatePickerRef}>
            <button
              type="button"
              onClick={() => setMktShowDatePicker(v => !v)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors h-10 ${
                mktDateFrom && mktDateTo
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <Calendar className="w-4 h-4" />
              {mktDateFrom && mktDateTo
                ? `${mktDateFrom.split('-').reverse().join('/')} – ${mktDateTo.split('-').reverse().join('/')}`
                : 'Data personalizada'}
            </button>
            {mktShowDatePicker && (
              <DateRangePicker
                dataInicio={mktDateFrom}
                dataFim={mktDateTo}
                onChange={(ini, fim) => {
                  setMktDateFrom(ini);
                  setMktDateTo(fim || ini);
                  setMktShowDatePicker(false);
                  setMktPage(1);
                }}
                onClose={() => setMktShowDatePicker(false)}
              />
            )}
          </div>
          {mktDateFrom && mktDateTo && (
            <button type="button" onClick={() => {
              const hoje = new Date();
              const trintaDiasAtras = new Date(hoje);
              trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
              setMktDateFrom(trintaDiasAtras.toISOString().slice(0, 10));
              setMktDateTo(hoje.toISOString().slice(0, 10));
              setMktPage(1);
            }}
              className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 h-10 flex items-center">
              Últimos 30 dias
            </button>
          )}
          <button onClick={() => syncMktOrders('ml')} disabled={mktSyncing}
            className="btn-primary text-sm h-10 flex items-center gap-1.5">
            <RefreshCw className={`w-4 h-4 ${mktSyncing ? 'animate-spin' : ''}`} /> {mktSyncing ? 'Sincronizando...' : 'Buscar Pedidos ML'}
          </button>
          <button onClick={() => fetchMktOrders()} disabled={mktLoading}
            className="btn-secondary text-sm h-10 flex items-center gap-1.5">
            <RefreshCw className={`w-4 h-4 ${mktLoading ? 'animate-spin' : ''}`} /> Atualizar Lista
          </button>
          {blingAccounts.length > 1 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 dark:text-gray-400">Enviar para:</label>
              <select value={activeAccountId || ''} onChange={e => setActiveAccountId(e.target.value)}
                className="input-field text-sm h-10 w-36">
                {blingAccounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
              </select>
            </div>
          )}
          {mktSelectedIds.length > 0 && blingAccounts.length > 0 && (
            <button onClick={sendBulkToBling} className="bg-emerald-500/90 hover:bg-emerald-600/90 text-white text-sm px-4 h-10 rounded-lg flex items-center gap-1.5 transition-colors">
              <Send className="w-4 h-4" /> Enviar {mktSelectedIds.length} para Bling
            </button>
          )}
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl p-3 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <input type="text" placeholder="Buscar por nome, SKU, ID..." value={mktSearch} onChange={e => setMktSearch(e.target.value)}
              className="input-field text-sm w-full" />
          </div>
          <select value={mktStatusFilter} onChange={e => { setMktStatusFilter(e.target.value); setMktPage(1); }} className="input-field text-sm">
            <option value="">Todos status</option>
            <optgroup label="Status do Pedido">
              <option value="paid">Pago</option>
              <option value="confirmed">Confirmado</option>
              <option value="cancelled">Cancelado</option>
              <option value="payment_required">Aguard. Pagamento</option>
              <option value="sent_to_bling">Enviado ao Bling</option>
              <option value="error">Erro</option>
            </optgroup>
            <optgroup label="Status do Envio">
              <option value="handling">Em Manuseio</option>
              <option value="ready_to_ship">Pronto p/ Envio</option>
              <option value="shipped">Em Trânsito</option>
              <option value="delivered">Entregue</option>
            </optgroup>
          </select>
          <select value={mktMarketplaceFilter} onChange={e => { setMktMarketplaceFilter(e.target.value); setMktPage(1); }} className="input-field text-sm">
            <option value="">Todos</option>
            <option value="ml">Mercado Livre</option>
            <option value="shopee">Shopee</option>
          </select>
          <button onClick={() => { setMktSearch(''); setMktStatusFilter(''); setMktMarketplaceFilter(''); setMktPage(1); }} className="btn-secondary text-sm h-9">Limpar</button>
        </div>

        {mktLoading ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2" /> Carregando pedidos...
          </div>
        ) : mktOrders.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <ShoppingCart className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Nenhum pedido encontrado. Clique em "Buscar Pedidos ML" para sincronizar.</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <input type="checkbox"
                checked={mktSelectedIds.length === mktOrders.filter(o => !o.bling_pedido_id).length && mktOrders.filter(o => !o.bling_pedido_id).length > 0}
                onChange={e => {
                  if (e.target.checked) setMktSelectedIds(mktOrders.filter(o => !o.bling_pedido_id).map(o => o.id));
                  else setMktSelectedIds([]);
                }}
                className="rounded" />
              <span>Selecionar todos pendentes ({mktOrders.filter(o => !o.bling_pedido_id).length})</span>
              <span className="ml-auto font-medium">{mktTotal} pedidos</span>
            </div>

            {Object.entries(grouped).map(([dateLabel, orders]) => (
              <div key={dateLabel}>
                <div className="sticky top-0 z-10 bg-gray-100/90 dark:bg-gray-900/90 backdrop-blur-sm px-3 py-1.5 rounded-lg mb-2">
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-300 capitalize">{dateLabel}</span>
                  <span className="text-[10px] text-gray-400 ml-2">({orders.length} pedidos)</span>
                </div>

                <div className="relative ml-4 border-l-2 border-gray-200 dark:border-gray-700 pl-6 space-y-4">
                  {orders.map(order => {
                    const items = order.items || [];
                    const statusInfo = getStatusInfo(order);
                    const isSent = !!order.bling_pedido_id;
                    const isSending = mktSending.has(order.id);
                    const addr = order.shipping_address || {};
                    const buyerDisplay = order.buyer_name || order.buyer_nickname || 'N/A';
                    const orderTime = order.order_date ? new Date(order.order_date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
                    const mktLogo = mktLogos[order.marketplace] || mktLogos.ml;
                    const isExpanded = mktExpandedId === order.id;

                    const nfStatus = order.nf_manual_number ? 'manual' : (order.bling_nfe_numero || order.bling_nfe_id) ? 'bling' : null;

                    return (
                      <div key={order.id} className="relative">
                        <div className={`absolute -left-[31px] top-3 w-3 h-3 rounded-full ${statusInfo.dotColor} ring-2 ring-white dark:ring-gray-900`} />

                        <div className={`bg-white dark:bg-gray-800 rounded-xl border ${order.status === 'cancelled' ? 'border-red-200 dark:border-red-800/40 opacity-70' : isSent ? 'border-green-200 dark:border-green-800/50' : 'border-gray-200 dark:border-gray-700'} overflow-hidden transition-shadow hover:shadow-lg`}>
                          {/* Header */}
                          <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-100 dark:border-gray-700/50 cursor-pointer"
                            onClick={() => toggleOrderDetail(order.id)}>
                            <div className="flex items-center gap-3 text-xs">
                              {!isSent && order.status !== 'cancelled' && (
                                <input type="checkbox" checked={mktSelectedIds.includes(order.id)}
                                  onClick={e => e.stopPropagation()}
                                  onChange={e => {
                                    if (e.target.checked) setMktSelectedIds(prev => [...prev, order.id]);
                                    else setMktSelectedIds(prev => prev.filter(id => id !== order.id));
                                  }} className="rounded" />
                              )}
                              <span className="font-mono text-gray-500 dark:text-gray-400">#{order.marketplace_order_id}</span>
                              {orderTime && <span className="text-gray-400">{orderTime}</span>}
                              {order.account_name && (
                                <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200/60 dark:border-gray-600">
                                  {order.account_name}
                                </span>
                              )}
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1.5 ${statusInfo.bgColor} ${statusInfo.textColor}`}>
                                <img src={mktLogo} alt="" className="w-3.5 h-3.5 rounded-sm object-contain" />
                                {statusInfo.label}
                              </span>
                              {nfStatus && (
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold inline-flex items-center gap-1 ${nfStatus === 'manual' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400' : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'}`}>
                                  <FileText className="w-3 h-3" />
                                  {nfStatus === 'manual' ? `NF ${order.nf_manual_number}` : `NF-e ${order.bling_nfe_numero || 'Gerada'}`}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-green-600 dark:text-green-400">R$ {(order.total_amount || 0).toFixed(2)}</span>
                              {!isSent && order.status !== 'cancelled' ? (
                                <button onClick={e => { e.stopPropagation(); sendOrderToBling(order.id); }} disabled={isSending}
                                  className="bg-green-600 hover:bg-green-700 text-white text-[11px] px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors disabled:opacity-50">
                                  {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                                  {isSending ? '...' : 'Bling'}
                                </button>
                              ) : isSent ? (
                                <span className="text-[10px] text-gray-400 font-mono">{order.bling_pedido_id}</span>
                              ) : null}
                              {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                            </div>
                          </div>

                          {/* Items preview */}
                          <div className="p-4 space-y-3">
                            {items.map((item, idx) => {
                              const invMatch = findInventoryBySku(item.sku);
                              const adModel = findAdModelBySku(item.sku);
                              let thumb = item.thumbnail || null;
                              if (!thumb && adModel) {
                                try {
                                  const pics = JSON.parse(adModel.pictures || '[]');
                                  if (pics.length > 0) thumb = pics[0].source || pics[0].secure_url;
                                } catch {}
                              }
                              if (!thumb && invMatch?.image) thumb = invMatch.image;
                              const displayTitle = item.title && item.title !== 'null' ? item.title : (invMatch?.title || 'Produto sem título');
                              const displaySku = item.sku || invMatch?.sku || '';
                              let varAttrs = item.variation_attributes || [];
                              if (!varAttrs.length && item.variation_attributes_json) {
                                try { varAttrs = JSON.parse(item.variation_attributes_json); } catch {}
                              }

                              return (
                                <div key={idx} className="flex gap-4 items-start">
                                  <div className="flex-shrink-0">
                                    {thumb ? (
                                      <img src={thumb} alt="" className="w-20 h-20 rounded-lg object-cover bg-gray-100 dark:bg-gray-700 shadow-sm" />
                                    ) : (
                                      <div className="w-20 h-20 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                                        <Package className="w-7 h-7 text-gray-300 dark:text-gray-600" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-900 dark:text-white leading-tight">{displayTitle}</p>
                                    {varAttrs.length > 0 && (
                                      <p className="text-[11px] text-violet-600 dark:text-violet-400 mt-0.5">
                                        {varAttrs.map(a => `${a.name || a.id}: ${a.value_name || a.value_id}`).join(' | ')}
                                      </p>
                                    )}
                                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                                      <span className="font-medium">{item.quantity || 1}x R$ {(item.unit_price || 0).toFixed(2)}</span>
                                      {displaySku && <span className="font-mono bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-[11px]">SKU: {displaySku}</span>}
                                      {item.marketplace_item_id && <span className="font-mono text-[10px] text-gray-400">MLB{item.marketplace_item_id}</span>}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}

                            {items.length === 0 && <p className="text-xs text-gray-400 italic">Sem itens registrados</p>}

                            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-gray-100 dark:border-gray-700/50 text-[11px] text-gray-500 dark:text-gray-400">
                              <span>Comprador: <strong className="text-gray-700 dark:text-gray-200">{buyerDisplay}</strong></span>
                              {addr.city && <span>{addr.city}{addr.state ? ` - ${addr.state}` : ''}</span>}
                              {addr.zip_code && <span>CEP: {addr.zip_code}</span>}
                              {order.payment_method && <span>Pag: {order.payment_method}</span>}
                              {order.shipping_cost > 0 && <span>Frete: R$ {order.shipping_cost.toFixed(2)}</span>}
                              {order.shipping_tracking && (
                                <span className="flex items-center gap-1"><Truck className="w-3 h-3" /> {order.shipping_tracking}</span>
                              )}
                            </div>
                            <div className="mt-2 flex justify-center cursor-pointer group" onClick={() => toggleOrderDetail(order.id)}>
                              <span className="text-[10px] text-blue-500 dark:text-blue-400 group-hover:text-blue-700 flex items-center gap-1 py-1">
                                {isExpanded ? <><ChevronUp className="w-3 h-3" /> Recolher detalhes</> : <><Eye className="w-3 h-3" /> Clique para ver detalhes completos</>}
                              </span>
                            </div>
                          </div>

                          {/* Expanded Detail Panel */}
                          {isExpanded && (
                            <div className="border-t-2 border-blue-200 dark:border-blue-800/50 bg-blue-50/30 dark:bg-blue-950/20">
                              {mktDetailLoading ? (
                                <div className="flex items-center justify-center py-8 text-gray-500 dark:text-gray-400">
                                  <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Carregando detalhes...
                                </div>
                              ) : mktDetailData ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-0 divide-y md:divide-y-0 md:divide-x divide-gray-200 dark:divide-gray-700">
                                  {/* Pedido */}
                                  <div className="p-4">
                                    <h4 className="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide flex items-center gap-1.5 mb-3">
                                      <ShoppingCart className="w-3.5 h-3.5" /> Pedido
                                    </h4>
                                    <div className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Canal:</span>
                                        <span className="font-medium flex items-center gap-1">
                                          <img src={mktLogo} alt="" className="w-4 h-4" />
                                          {order.marketplace === 'ml' ? 'Mercado Livre' : order.marketplace === 'shopee' ? 'Shopee' : order.marketplace}
                                        </span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Pedido:</span>
                                        <span className="font-mono font-medium">{safe(mktDetailData.marketplace_order_id)}</span>
                                      </div>
                                      {mktDetailData.pack_id && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Pack:</span>
                                          <span className="font-mono">{safe(mktDetailData.pack_id)}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Status:</span>
                                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusInfo.bgColor} ${statusInfo.textColor}`}>{statusInfo.label}</span>
                                      </div>
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Data:</span>
                                        <span>{mktDetailData.order_date ? new Date(mktDetailData.order_date).toLocaleString('pt-BR') : '-'}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Pagamento */}
                                  <div className="p-4">
                                    <h4 className="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide flex items-center gap-1.5 mb-3">
                                      <CreditCard className="w-3.5 h-3.5" /> Pagamento
                                    </h4>
                                    <div className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
                                      {mktDetailData.payment_id && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">ID Pgto:</span>
                                          <span className="font-mono">{safe(mktDetailData.payment_id)}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Total:</span>
                                        <span className="font-bold text-green-600 dark:text-green-400">R$ {(mktDetailData.payment_total || mktDetailData.total_amount || 0).toFixed(2)}</span>
                                      </div>
                                      {mktDetailData.shipping_cost > 0 && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Frete:</span>
                                          <span>R$ {mktDetailData.shipping_cost.toFixed(2)}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Método:</span>
                                        <span className="capitalize">{safe(mktDetailData.payment_method) || '-'}</span>
                                      </div>
                                      {mktDetailData.payment_installments > 1 && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Parcelas:</span>
                                          <span>{mktDetailData.payment_installments}x</span>
                                        </div>
                                      )}
                                      {mktDetailData.payment_date && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Data aprovação:</span>
                                          <span>{new Date(mktDetailData.payment_date).toLocaleString('pt-BR')}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Status:</span>
                                        <span className="capitalize">{safe(mktDetailData.payment_status) || '-'}</span>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Comprador + Envio */}
                                  <div className="p-4">
                                    <h4 className="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide flex items-center gap-1.5 mb-3">
                                      <User className="w-3.5 h-3.5" /> Comprador
                                    </h4>
                                    <div className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
                                      {mktDetailData.buyer_nickname && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Nickname:</span>
                                          <span className="font-medium">@{safe(mktDetailData.buyer_nickname)}</span>
                                        </div>
                                      )}
                                      <div className="flex justify-between">
                                        <span className="text-gray-400">Nome:</span>
                                        <span className="font-medium">{safe(mktDetailData.buyer_name) || '-'}</span>
                                      </div>
                                      {mktDetailData.buyer_doc && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">CPF/CNPJ:</span>
                                          <span className="font-mono">{safe(mktDetailData.buyer_doc)}</span>
                                        </div>
                                      )}
                                      {mktDetailData.buyer_phone && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Telefone:</span>
                                          <span>{safe(mktDetailData.buyer_phone)}</span>
                                        </div>
                                      )}
                                      {mktDetailData.buyer_email && (
                                        <div className="flex justify-between">
                                          <span className="text-gray-400">Email:</span>
                                          <span className="truncate max-w-[140px]" title={safe(mktDetailData.buyer_email)}>{safe(mktDetailData.buyer_email)}</span>
                                        </div>
                                      )}
                                      {mktDetailData.shipping_address && (
                                        <>
                                          <div className="pt-2 mt-2 border-t border-gray-200 dark:border-gray-700">
                                            <h5 className="text-[10px] font-bold text-gray-400 uppercase flex items-center gap-1 mb-1.5">
                                              <MapPin className="w-3 h-3" /> Endereço
                                            </h5>
                                          </div>
                                          <div className="text-[11px] leading-relaxed">
                                            <p>{safe(mktDetailData.shipping_address.street)}{mktDetailData.shipping_address.number ? `, ${safe(mktDetailData.shipping_address.number)}` : ''}</p>
                                            {mktDetailData.shipping_address.complement && <p>{safe(mktDetailData.shipping_address.complement)}</p>}
                                            <p>{safe(mktDetailData.shipping_address.neighborhood)}</p>
                                            <p>{safe(mktDetailData.shipping_address.city)} - {safe(mktDetailData.shipping_address.state)}</p>
                                            {mktDetailData.shipping_address.zip_code && <p>CEP: {safe(mktDetailData.shipping_address.zip_code)}</p>}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {/* NF / Opções */}
                                  <div className="p-4">
                                    <h4 className="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wide flex items-center gap-1.5 mb-3">
                                      <FileText className="w-3.5 h-3.5" /> NF / Opções
                                    </h4>
                                    <div className="space-y-2">
                                      {/* Shipping info */}
                                      {(mktDetailData.shipping_tracking || mktDetailData.shipping_method) && (
                                        <div className="bg-white dark:bg-gray-800 rounded-lg p-2 border border-gray-200 dark:border-gray-700 mb-2">
                                          <h5 className="text-[10px] font-bold text-gray-400 uppercase flex items-center gap-1 mb-1.5">
                                            <Truck className="w-3 h-3" /> Envio
                                          </h5>
                                          <div className="text-[11px] space-y-1 text-gray-600 dark:text-gray-300">
                                            {mktDetailData.shipping_method && <p>Método: {safe(mktDetailData.shipping_method)}</p>}
                                            {mktDetailData.shipping_status && <p>Status: <span className="capitalize">{safe(mktDetailData.shipping_status)}</span></p>}
                                            {mktDetailData.shipping_tracking && (
                                              <p className="flex items-center gap-1">Rastreio: <span className="font-mono font-medium">{safe(mktDetailData.shipping_tracking)}</span>
                                                <button onClick={() => { navigator.clipboard.writeText(mktDetailData.shipping_tracking); toast.success('Copiado!'); }} className="text-blue-500 hover:text-blue-700"><Copy className="w-3 h-3" /></button>
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                      )}

                                      {/* NF-e section - dynamic based on search result */}
                                      {mktNfeLoading ? (
                                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                                          <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                                            <RefreshCw className="w-3 h-3 animate-spin" /> Buscando NF-e no Bling...
                                          </div>
                                        </div>
                                      ) : mktNfeData?.nfe ? (
                                        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800/40">
                                          <h5 className="text-[10px] font-bold text-green-700 dark:text-green-400 uppercase flex items-center gap-1 mb-2">
                                            <FileText className="w-3 h-3" /> Nota Fiscal Eletrônica
                                          </h5>
                                          <div className="space-y-1.5 text-[11px] text-gray-700 dark:text-gray-300">
                                            {mktNfeData.bling_pedido_id && (
                                              <div className="flex justify-between">
                                                <span className="text-gray-400">Pedido Bling:</span>
                                                <span className="font-mono font-medium">#{safe(mktNfeData.bling_pedido_id)}</span>
                                              </div>
                                            )}
                                            <div className="flex justify-between">
                                              <span className="text-gray-400">NF-e Nº:</span>
                                              <span className="font-bold text-green-700 dark:text-green-400">{safe(mktNfeData.nfe.numero)}</span>
                                            </div>
                                            {mktNfeData.nfe.serie && (
                                              <div className="flex justify-between">
                                                <span className="text-gray-400">Série:</span>
                                                <span>{safe(mktNfeData.nfe.serie)}</span>
                                              </div>
                                            )}
                                            <div className="flex justify-between">
                                              <span className="text-gray-400">Situação:</span>
                                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                                [5, 6].includes(Number(mktNfeData.nfe.situacao)) ? 'bg-green-200 dark:bg-green-800/50 text-green-800 dark:text-green-300'
                                                : [2, 4, 7].includes(Number(mktNfeData.nfe.situacao)) ? 'bg-red-200 dark:bg-red-800/50 text-red-800 dark:text-red-300'
                                                : 'bg-yellow-200 dark:bg-yellow-800/50 text-yellow-800 dark:text-yellow-300'
                                              }`}>{safe(mktNfeData.nfe.situacaoLabel)}</span>
                                            </div>
                                            {mktNfeData.nfe.valorNota != null && (
                                              <div className="flex justify-between">
                                                <span className="text-gray-400">Valor:</span>
                                                <span className="font-bold">R$ {Number(mktNfeData.nfe.valorNota || 0).toFixed(2)}</span>
                                              </div>
                                            )}
                                            {mktNfeData.nfe.dataEmissao && (
                                              <div className="flex justify-between">
                                                <span className="text-gray-400">Emissão:</span>
                                                <span>{safe(mktNfeData.nfe.dataEmissao)}{mktNfeData.nfe.horaEmissao ? ` ${safe(mktNfeData.nfe.horaEmissao)}` : ''}</span>
                                              </div>
                                            )}
                                            {mktNfeData.nfe.naturezaOperacao && (
                                              <div className="flex justify-between">
                                                <span className="text-gray-400">Natureza:</span>
                                                <span className="text-right max-w-[150px] truncate" title={safe(mktNfeData.nfe.naturezaOperacao)}>{safe(mktNfeData.nfe.naturezaOperacao)}</span>
                                              </div>
                                            )}
                                            {mktNfeData.nfe.chaveAcesso && (
                                              <div className="pt-1.5 mt-1.5 border-t border-green-200 dark:border-green-700">
                                                <span className="text-[10px] text-gray-400 block mb-0.5">Chave de Acesso:</span>
                                                <div className="flex items-center gap-1">
                                                  <span className="font-mono text-[9px] break-all leading-tight">{safe(mktNfeData.nfe.chaveAcesso)}</span>
                                                  <button onClick={() => { navigator.clipboard.writeText(safe(mktNfeData.nfe.chaveAcesso)); toast.success('Chave copiada!'); }}
                                                    className="flex-shrink-0 text-blue-500 hover:text-blue-700"><Copy className="w-3 h-3" /></button>
                                                </div>
                                              </div>
                                            )}
                                            <div className="flex gap-1.5 pt-2 mt-1">
                                              {mktNfeData.nfe.linkDanfe && (
                                                <a href={safe(mktNfeData.nfe.linkDanfe)} target="_blank" rel="noopener noreferrer"
                                                  className="flex-1 bg-green-600 hover:bg-green-700 text-white text-[10px] py-1.5 rounded-lg flex items-center justify-center gap-1 transition-colors">
                                                  <Printer className="w-3 h-3" /> DANFE
                                                </a>
                                              )}
                                              {mktNfeData.nfe.xml && (
                                                <a href={safe(mktNfeData.nfe.xml)} target="_blank" rel="noopener noreferrer"
                                                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-[10px] py-1.5 rounded-lg flex items-center justify-center gap-1 transition-colors">
                                                  <ExternalLink className="w-3 h-3" /> XML
                                                </a>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      ) : mktNfeData?.pedido ? (
                                        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2 border border-blue-200 dark:border-blue-800/40 mb-1">
                                          <div className="text-[11px] text-blue-700 dark:text-blue-400">
                                            <p className="font-semibold">Bling: #{safe(mktNfeData.bling_pedido_id || mktNfeData.pedido.id)}</p>
                                            <p className="text-[10px] text-gray-400 mt-0.5">Pedido encontrado no Bling mas sem NF-e vinculada</p>
                                          </div>
                                        </div>
                                      ) : (
                                        <>
                                          {/* NF Manual form - only shown when no Bling NF-e found */}
                                          <div className="bg-white dark:bg-gray-800 rounded-lg p-2.5 border border-gray-200 dark:border-gray-700">
                                            <h5 className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase flex items-center gap-1 mb-2">
                                              <FileText className="w-3 h-3" /> NF Manual
                                            </h5>
                                            <div className="space-y-1.5">
                                              <input type="text" placeholder="Nº NF" value={mktNfForm.nf_manual_number}
                                                onChange={e => setMktNfForm(f => ({ ...f, nf_manual_number: e.target.value }))}
                                                className="w-full input-field text-xs py-1 px-2" />
                                              <input type="text" placeholder="Série" value={mktNfForm.nf_manual_serie}
                                                onChange={e => setMktNfForm(f => ({ ...f, nf_manual_serie: e.target.value }))}
                                                className="w-full input-field text-xs py-1 px-2" />
                                              <input type="text" placeholder="Chave NF-e (44 dígitos)" value={mktNfForm.nf_manual_key}
                                                onChange={e => setMktNfForm(f => ({ ...f, nf_manual_key: e.target.value }))}
                                                className="w-full input-field text-xs py-1 px-2" />
                                              <input type="date" value={mktNfForm.nf_manual_date}
                                                onChange={e => setMktNfForm(f => ({ ...f, nf_manual_date: e.target.value }))}
                                                className="w-full input-field text-xs py-1 px-2" />
                                              <button onClick={() => saveNfManual(order.id)} disabled={mktNfSaving}
                                                className="w-full bg-purple-600 hover:bg-purple-700 text-white text-xs py-1.5 rounded-lg flex items-center justify-center gap-1 transition-colors disabled:opacity-50">
                                                {mktNfSaving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                                                {mktNfSaving ? 'Salvando...' : 'Salvar NF Manual'}
                                              </button>
                                            </div>
                                          </div>
                                        </>
                                      )}

                                      {/* Action buttons */}
                                      <div className="flex flex-wrap gap-1.5 pt-1">
                                        {!isSent && order.status !== 'cancelled' && (
                                          <button onClick={e => { e.stopPropagation(); sendOrderToBling(order.id); }} disabled={isSending}
                                            className="flex-1 min-w-[80px] bg-green-600 hover:bg-green-700 text-white text-[10px] py-1.5 rounded-lg flex items-center justify-center gap-1 transition-colors disabled:opacity-50">
                                            <Send className="w-3 h-3" /> ENVIAR BLING
                                          </button>
                                        )}
                                        {order.marketplace === 'ml' && order.marketplace_order_id && (
                                          <a href={`https://www.mercadolivre.com.br/vendas/${order.marketplace_order_id}/detalhe`}
                                            target="_blank" rel="noopener noreferrer"
                                            className="flex-1 min-w-[80px] bg-yellow-500 hover:bg-yellow-600 text-white text-[10px] py-1.5 rounded-lg flex items-center justify-center gap-1 transition-colors">
                                            <ExternalLink className="w-3 h-3" /> VER NO ML
                                          </a>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className="p-4 text-center text-xs text-gray-400">Erro ao carregar detalhes</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <button onClick={() => goToPage(1)} disabled={mktPage === 1}
                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  &laquo;
                </button>
                <button onClick={() => goToPage(Math.max(1, mktPage - 1))} disabled={mktPage === 1}
                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  &lsaquo;
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let page;
                  if (totalPages <= 5) {
                    page = i + 1;
                  } else if (mktPage <= 3) {
                    page = i + 1;
                  } else if (mktPage >= totalPages - 2) {
                    page = totalPages - 4 + i;
                  } else {
                    page = mktPage - 2 + i;
                  }
                  return (
                    <button key={page} onClick={() => goToPage(page)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${mktPage === page ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                      {page}
                    </button>
                  );
                })}
                <button onClick={() => goToPage(Math.min(totalPages, mktPage + 1))} disabled={mktPage === totalPages}
                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  &rsaquo;
                </button>
                <button onClick={() => goToPage(totalPages)} disabled={mktPage === totalPages}
                  className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  &raquo;
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">Página {mktPage} de {totalPages}</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const handleNotasDateRangeChange = (ini, fim) => {
    setDataInicial(ini);
    setDataFinal(fim || ini);
    setShowNotasDateRangePicker(false);
  };

  const clearNotasDateRange = () => {
    setDataInicial('');
    setDataFinal('');
    setShowNotasDateRangePicker(false);
  };

  return (
    <div className="space-y-6">
      {activeTab === 'marketplace' && renderMarketplaceOrders()}
      {activeTab === 'manual' && renderPedidosManuais()}
      {activeTab !== 'manual' && activeTab !== 'marketplace' && (
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Pedidos</h1>
        </div>
        <button
          className="btn-secondary ml-4"
          onClick={() => { fetchAglutinados(); setShowAglutinadosModal(true); }}
        >
          Histórico de Aglutinados
        </button>
      </div>
      )}

      {activeTab !== 'manual' && activeTab !== 'marketplace' && blingAccounts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {blingAccounts.map(account => {
            const isActive = Number(activeAccountId) === Number(account.id);
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => setActiveAccountId(account.id)}
                className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${isActive ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-blue-50 dark:hover:bg-blue-900'}`}
              >
                {account.name}
              </button>
            );
          })}
        </div>
      )}

      {activeTab !== 'manual' && activeTab !== 'marketplace' && (
      <div className="orders-toolbar bg-white/80 dark:bg-gray-800/70 rounded-xl p-3 md:p-4 flex flex-col md:flex-row md:items-center sticky top-6 z-30 gap-3 md:gap-4">
        {/* Esquerda: Liberar todas */}
        <div className="flex items-center gap-2 mr-auto">
          <button
            type="button"
            className="text-xs px-3 py-2 border rounded btn-soft"
            onClick={async () => {
              const todosIds = Array.from(new Set((notasFiltradas || []).map(n => n.id)));
              const meus = todosIds.filter(id => claimedByMe.has(id));
              if (meus.length > 0) { try { await axios.post('/api/notas-expedidas/release/batch', { ids: meus, owner: ownerIdRef.current, accountId: activeAccountId }); } catch {} }
              setSelectedNotas([]);
              setClaimedByMe(new Set());
              setNotasEmProcessamento(prev => { const s = new Set(prev); meus.forEach(id => s.delete(id)); return s; });
            }}
          ><span style={{fontWeight:'bold'}}>X</span></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:ml-2">
          <div className="relative" ref={notasDateRangeRef}>
            <button
              type="button"
              onClick={() => setShowNotasDateRangePicker((v) => !v)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                dataInicial && dataFinal
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <Calendar className="w-4 h-4" />
              {dataInicial && dataFinal
                ? `${dataInicial.split('-').reverse().join('/')} – ${dataFinal.split('-').reverse().join('/')}`
                : 'Data personalizada'}
            </button>
            {showNotasDateRangePicker && (
              <DateRangePicker
                dataInicio={dataInicial}
                dataFim={dataFinal}
                onChange={handleNotasDateRangeChange}
                onClose={() => setShowNotasDateRangePicker(false)}
              />
            )}
          </div>
          {dataInicial && dataFinal && (
            <button
              type="button"
              onClick={clearNotasDateRange}
              className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Limpar datas
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setFiltro12h(f => !f)}
          className={`ml-0 md:ml-4 flex items-center text-sm border rounded px-3 py-1 font-semibold transition-colors ${filtro12h ? 'bg-green-600 text-white border-green-600' : 'bg-white dark:bg-gray-700 text-green-600 dark:text-green-400 border-green-600 dark:border-green-500 hover:bg-green-50 dark:hover:bg-green-900'}`}
        >
          12h+
        </button>
        <button
          onClick={fetchNotasFiscais}
          className="btn-soft flex items-center text-sm px-3 py-2 md:ml-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          disabled={activeLoadingNotas || activeIsFetchingNotas || activeProgresso.status === 'importando'}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          {activeLoadingNotas || activeIsFetchingNotas ? 'Carregando...' : 'Buscar Notas'}
        </button>
        <div className="flex items-center space-x-2 ml-4">
          <input
            type="checkbox"
            id="aglutinar-pedidos"
            checked={aglutinar}
            onChange={e => setAglutinar(e.target.checked)}
            style={{ width: 22, height: 22 }}
            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
          />
          <label htmlFor="aglutinar-pedidos" className="text-sm text-gray-700 dark:text-gray-300 select-none">Aglutinar Pedidos</label>
        </div>
        <div className="flex items-center gap-3 ml-4">
          <label className="flex items-center text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={ocultarExpedidas}
              onChange={e => setOcultarExpedidas(e.target.checked)}
              style={{ width: 22, height: 22 }}
              className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
            />
            <span className="ml-2 text-gray-700 dark:text-gray-300">Ocultar expedidas</span>
          </label>
          {selectedNotas.length > 0 && (
            <div className="relative">
            <button
                onClick={handlePrintMenu}
              className="btn-primary btn-soft flex items-center text-sm"
                type="button"
            >
              <Printer className="w-4 h-4 mr-2" />
              Imprimir Selecionados ({selectedNotas.length})
            </button>
              {showPrintMenu && (
                <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg z-50">
                  <button className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white" onClick={handleExpedirHoje}>Expedir hoje</button>
                  <button className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white" onClick={handleSelecionarData}>Expedir em...</button>
                  <button className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white" onClick={() => imprimirPicklistPorLocalizacao(expeditionDate || new Date().toISOString().slice(0,10))}>Picklist (por localização)</button>
                </div>
              )}
              {showDatePicker && (
                <div className="absolute right-0 mt-2 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg z-50 p-4 flex flex-col items-center gap-2" style={{width:'180px', minWidth:'unset', maxWidth:'90vw'}}>
                  <input type="date" value={expeditionDate} onChange={handleDateChange} className="border rounded px-2 py-1 text-sm w-full text-center dark:bg-gray-700 dark:text-white dark:border-gray-600" style={{fontSize:'1.1rem'}} />
                  <div className="flex gap-3 justify-center mt-2">
                    <button className="flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white rounded-full p-2 w-8 h-8" onClick={() => setShowDatePicker(false)} title="Cancelar">
                      <X className="w-4 h-4" />
                    </button>
                    <button className="flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white rounded-full p-2 w-8 h-8" onClick={handleConfirmarData} disabled={!expeditionDate} title="Confirmar">
                      <Check className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {activeTab !== 'manual' && activeTab !== 'marketplace' && (
        <div className="bg-white/70 dark:bg-gray-800/60 rounded-xl p-3 md:p-4 flex flex-wrap gap-3 items-end">
          <div className="min-w-[220px] flex-1">
            <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Pesquisar</label>
            <input
              type="text"
              value={filtroTexto}
              onChange={e => setFiltroTexto(e.target.value)}
              placeholder="Cliente, NF, Nº Loja, SKU ou título"
              className="input-field text-sm"
            />
          </div>
          <div className="min-w-[180px]">
            <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Marketplace</label>
            <select className="input-field text-sm" value={filtroMarketplace} onChange={e => setFiltroMarketplace(e.target.value)}>
              <option value="">Todos</option>
              {marketplacesDisponiveis.map(mk => (
                <option key={mk} value={mk}>{mk}</option>
              ))}
            </select>
          </div>
          <div className="min-w-[160px]">
            <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Status</label>
            <select className="input-field text-sm" value={filtroStatus} onChange={e => setFiltroStatus(e.target.value)}>
              <option value="">Todos</option>
              <option value="autorizada">Autorizada</option>
              <option value="pendente">Pendente</option>
              <option value="cancelada">Cancelada</option>
            </select>
          </div>
          <div className="min-w-[160px]">
            <label className="block text-xs text-gray-600 dark:text-gray-300 mb-1">Tipo</label>
            <select className="input-field text-sm" value={filtroTipoPedido} onChange={e => setFiltroTipoPedido(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="bling">Bling</option>
              <option value="manuais">Manuais</option>
            </select>
          </div>
          <button
            type="button"
            className="btn-secondary text-sm h-10"
            onClick={() => { setFiltroTexto(''); setFiltroMarketplace(''); setFiltroStatus(''); setFiltroTipoPedido('todos'); }}
          >
            Limpar filtros
          </button>
        </div>
      )}

      {erroNotas && (
        <div className="bg-red-100 text-red-700 rounded p-3 mb-4 text-center font-semibold">
          {erroNotas}
        </div>
      )}

      {showBlingAuth && blingAuth && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Autorizar Integração Bling</h2>
          <p className="text-gray-600 dark:text-gray-300 mb-4">
            Para acessar as notas fiscais, você precisa autorizar o aplicativo no Bling.
          </p>
          <a
            href={blingAuth.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary flex items-center"
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Autorizar no Bling
          </a>
        </div>
      )}

      {/* Exibir progresso de importação mesmo sem notas */}
      {isImportingActive && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <div className="flex flex-col items-center">
            <img src={process.env.PUBLIC_URL + '/loader-cat.gif.gif'} alt="Carregando..." className="h-24 w-24 mb-4" />
            <p className="text-gray-600 dark:text-gray-300 text-lg font-semibold mb-2">Importando pedidos...</p>
            <ProgressBar value={activeProgresso.importados} max={activeProgresso.total || 1} />
            <p className="text-gray-700 dark:text-gray-300 text-sm">{activeProgresso.importados} de {(typeof activeProgresso.total === 'number' ? activeProgresso.total : '?')} pedidos importados</p>
            <p className="text-gray-400 dark:text-gray-400 text-sm mt-2">Aguarde, pode demorar alguns minutos dependendo da quantidade de pedidos.</p>
          </div>
        </div>
      )}

      {/* Exibir painel vazio só se não estiver importando e não estivermos na aba de manuais */}
      {activeTab !== 'manual' && activeTab !== 'marketplace' && notasFiscais.length === 0 && !isLoadingActive && !isImportingActive && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <ShoppingCart className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-300">Nenhuma nota fiscal encontrada</p>
          <button
            onClick={fetchNotasFiscais}
            className="mt-4 bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
            disabled={blingStatus === 'disconnected'}
          >
            Buscar Notas
          </button>
        </div>
      )}

      {/* Skeleton loader quando está carregando notas (apenas na aba de notas) */}
      {activeTab !== 'manual' && activeTab !== 'marketplace' && isLoadingActive && !isImportingActive && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
          <div className="space-y-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid grid-cols-9 gap-3">
                {Array.from({ length: 9 }).map((__, j) => (
                  <div key={j} className="skeleton h-6 rounded"></div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab !== 'manual' && activeTab !== 'marketplace' && processingExpedition && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black bg-opacity-30">
          <div className="flex flex-col items-center">
            <img src={process.env.PUBLIC_URL + '/loader-cat.gif.gif'} alt="Carregando..." className="h-24 w-24 mb-4" />
            <span className="text-blue-700 font-semibold text-lg">Processando</span>
          </div>
        </div>
      )}

      {activeTab !== 'manual' && activeTab !== 'marketplace' && notasFiltradas.length > 0 && !isLoadingActive && !isImportingActive && (
        <div className="space-y-8">
          {[
            {label: 'Emitidos após 12:00', filtro: nota => {
              const hora = nota.dataEmissao ? new Date(nota.dataEmissao).getHours() : 0;
              return hora >= 12;
            }},
            {label: 'Emitidos até 12:00', filtro: nota => {
              const hora = nota.dataEmissao ? new Date(nota.dataEmissao).getHours() : 0;
              return hora < 12;
            }}
          ].map(({label, filtro}) => {
            const notasPorHorario = notasFiltradas.filter(filtro).filter(nota => !ocultarExpedidas || !expedidas.includes(String(nota.id)));
            if (notasPorHorario.length === 0) return null;
            const marketplaces = agruparPorMarketplace(notasPorHorario);
            return (
              <div key={label} className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{label}</h2>
                {Object.entries(marketplaces).map(([mk, notas]) => (
                  <div key={mk} className="mb-8">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-md font-bold text-blue-700 dark:text-blue-400">{exibirMarketplace(notas[0])}</h3>
                      <div className="flex items-center gap-2">
                        <button
                          className="text-xs px-2 py-1 border rounded"
                          onClick={() => setVisibleRowsByGroup(prev => ({...prev, [mk]: prev[mk] ? undefined : 20}))}
                        >{visibleRowsByGroup[mk] ? 'Mostrar tudo' : 'Exibir 20'}</button>
                        <button
                          className="text-xs px-2 py-1 border rounded"
                          onClick={async () => {
                            const idsBatch = notas.filter(n => !n.isManual && !expedidas.includes(String(n.id))).map(n => n.id);
                            const locais = notas.filter(n => n.isManual || expedidas.includes(String(n.id))).map(n => n.id);
                            let novos = [...locais];
                            if (idsBatch.length > 0) {
                              try {
                                const r = await axios.post('/api/notas-expedidas/claim/batch', { ids: idsBatch, owner: ownerIdRef.current, accountId: activeAccountId });
                                const claimed = Array.isArray(r.data?.claimed) ? r.data.claimed : [];
                                const alreadyExp = Array.isArray(r.data?.alreadyExpedited) ? r.data.alreadyExpedited : [];
                                novos = novos.concat(claimed, alreadyExp);
                                if (claimed.length > 0) setClaimedByMe(prev => { const s = new Set(prev); claimed.forEach(id => s.add(id)); return s; });
                                setNotasEmProcessamento(prev => {
                                  const s = new Set(prev);
                                  claimed.forEach(id => s.add(id));
                                  alreadyExp.forEach(id => s.delete(id));
                                  return s;
                                });
                                if (alreadyExp.length > 0) setExpedidas(prev => { const set = new Set(prev); alreadyExp.forEach(id => set.add(String(id))); return [...set]; });
                              } catch {}
                            }
                            setSelectedNotas(prev => Array.from(new Set([...prev, ...novos])));
                          }}
                        >Selecionar pendentes</button>
                        <button
                          className="text-xs px-2 py-1 border rounded"
                          onClick={async () => {
                            const meus = notas.filter(n => claimedByMe.has(n.id)).map(n => n.id);
                            if (meus.length > 0) {
                              try { await axios.post('/api/notas-expedidas/release/batch', { ids: meus, owner: ownerIdRef.current, accountId: activeAccountId }); } catch {}
                            }
                            setSelectedNotas(prev => prev.filter(id => !notas.some(n => String(n.id) === String(id))));
                            setClaimedByMe(prev => { const s = new Set(prev); notas.forEach(n => s.delete(n.id)); return s; });
                            setNotasEmProcessamento(prev => { const s = new Set(prev); notas.forEach(n => s.delete(n.id)); return s; });
                          }}
                        >Liberar</button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-600 table-sticky sticky-first">
                          <thead className="bg-gray-50 dark:bg-gray-700">
                            <tr>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <input
                                  type="checkbox"
                                      onChange={async (e) => {
                                    if (e.target.checked) {
                                          const idsBatch = notas.filter(n => !n.isManual && !expedidas.includes(String(n.id))).map(n => n.id);
                                          const locais = notas.filter(n => n.isManual || expedidas.includes(String(n.id))).map(n => n.id);
                                          let novos = [...locais];
                                          if (idsBatch.length > 0) {
                                            try {
                                              const r = await axios.post('/api/notas-expedidas/claim/batch', { ids: idsBatch, owner: ownerIdRef.current, accountId: activeAccountId });
                                              const claimed = Array.isArray(r.data?.claimed) ? r.data.claimed : [];
                                              const alreadyExp = Array.isArray(r.data?.alreadyExpedited) ? r.data.alreadyExpedited : [];
                                              novos = novos.concat(claimed, alreadyExp);
                                              if (claimed.length > 0) setClaimedByMe(prev => { const s = new Set(prev); claimed.forEach(id => s.add(id)); return s; });
                                              setNotasEmProcessamento(prev => {
                                                const s = new Set(prev);
                                                claimed.forEach(id => s.add(id));
                                                alreadyExp.forEach(id => s.delete(id));
                                                return s;
                                              });
                                              if (alreadyExp.length > 0) setExpedidas(prev => { const set = new Set(prev); alreadyExp.forEach(id => set.add(String(id))); return [...set]; });
                                            } catch {}
                                          }
                                          setSelectedNotas(prev => Array.from(new Set([...prev, ...novos])));
                                    } else {
                                          const meus = notas.filter(n => claimedByMe.has(n.id)).map(n => n.id);
                                          if (meus.length > 0) {
                                            try { await axios.post('/api/notas-expedidas/release/batch', { ids: meus, owner: ownerIdRef.current, accountId: activeAccountId }); } catch {}
                                          }
                                          setSelectedNotas(prev => prev.filter(id => !notas.some(n => String(n.id) === String(id))));
                                          setClaimedByMe(prev => { const s = new Set(prev); notas.forEach(n => s.delete(n.id)); return s; });
                                          setNotasEmProcessamento(prev => { const s = new Set(prev); notas.forEach(n => s.delete(n.id)); return s; });
                                        }
                                      }}
                                      checked={notas.length > 0 && notas.every(n => selectedNotas.some(sid => String(sid) === String(n.id)))}
                                  style={{ width: 22, height: 22 }}
                                  className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                                />
                              </th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Número</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Cliente</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Data</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Valor</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Status</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Número Loja</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Marketplace</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Conta</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">ID</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-600">
                            {(visibleRowsByGroup[mk] ? notas.slice(0, visibleRowsByGroup[mk]) : notas).map((nota, idx) => (
                              <tr key={nota.id ? `${nota.id}-${idx}` : idx} className="hover:bg-gray-50 dark:hover:bg-gray-700" data-nota-id={nota.id}>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <input
                                    type="checkbox"
                                    checked={selectedNotas.some(sid => String(sid) === String(nota.id))}
                                    onChange={() => handleNotaSelection(nota.id)}
                                    disabled={notasEmProcessamento.has(nota.id) && !claimedByMe.has(nota.id)}
                                    style={{ width: 22, height: 22 }}
                                    className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                                  />
                                </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  {expedidas.includes(String(nota.id)) ? (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{background:'#dcfce7'}}>
                                      <CheckCircle className="w-4 h-4" style={{color:'#15803d'}} title="Expedida" />
                                    </div>
                                  ) : notasEmProcessamento.has(nota.id) ? (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center" title="Em processamento" style={{background:'#fef9c3'}}>
                                      <RefreshCw className="w-4 h-4 animate-spin" style={{color:'#a16207'}} />
                                    </div>
                                  ) : (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{background:'#dbeafe'}}>
                                      <Package className="w-4 h-4" style={{color:'#1d4ed8'}} />
                                    </div>
                                  )}
                                  <div className="ml-4">
                                    <div className="text-sm font-medium text-gray-900 dark:text-white relative inline-block group">
                                      <span>
                                        {nota.isManual ? 'PM #' : 'NF #'}{nota.numero} {expedidas.includes(String(nota.id)) && <span className="ml-1 text-green-700 dark:text-green-400 font-bold">Expedida</span>}
                                        {!expedidas.includes(String(nota.id)) && notasEmProcessamento.has(nota.id) && (
                                          <span className="ml-1 text-yellow-700 dark:text-yellow-400 font-bold">Em processamento…</span>
                                        )}
                                      </span>
                                      <div className="absolute left-0 mt-2 hidden group-hover:block bg-white dark:bg-gray-800 text-gray-900 dark:text-white border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 z-50 max-w-xl w-max">
                                        {renderTooltipItens(nota)}
                                      </div>
                                    </div>
                                    <div className="text-sm text-gray-500 dark:text-gray-400">
                                      Série: {nota.serie}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {nota.cliente || 'Cliente não informado'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  {nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleDateString('pt-BR') : 'Data não informada'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  <DollarSign className="w-4 h-4 mr-1" style={{color:'#059669'}} />
                                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                                    {formatPrice(nota.valorNota)}
                                  </span>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                  nota.situacao === 5 ? 'bg-green-600 text-white' :
                                  nota.situacao === 2 ? 'bg-red-600 text-white' :
                                  'bg-amber-500 text-white'
                                }`}>
                                  {nota.situacao === 5 ? 'Autorizada' :
                                    nota.situacao === 2 ? 'Cancelada' : 'Pendente'}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {(nota.numeroLoja !== undefined && nota.numeroLoja !== null && nota.numeroLoja !== "") ? nota.numeroLoja : 'Não informado'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {(() => {
                                    const mkName = exibirMarketplace(nota);
                                    const cls = mkName === 'Mercado Livre Full' ? 'mk-mlfull' :
                                      mkName === 'Mercado Livre' ? 'mk-ml' :
                                      mkName === 'Shopee' ? 'mk-shopee' :
                                      mkName === 'Shein' ? 'mk-shein' :
                                      mkName === 'Amazon' ? 'mk-amazon' :
                                      mkName === 'Magalu' ? 'mk-magalu' :
                                      mkName === 'Leroy Merlin' ? 'mk-leroy' : 'mk-outros';
                                    return <span className={`mk-chip ${cls}`}>{mkName}</span>;
                                  })()}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {getAccountLabel(nota.accountId, nota.isManual)}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {nota.id || 'Não informado'}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de Histórico de Aglutinados */}
      {showAglutinadosModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => { setShowAglutinadosModal(false); setAglutinadosPage(1); setAglutinadoMenuOpen(null); setVisualizarAglutinado(null); }}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Histórico de Aglutinados</h2>
              <button className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500" onClick={() => { setShowAglutinadosModal(false); setAglutinadosPage(1); setAglutinadoMenuOpen(null); setVisualizarAglutinado(null); }}>×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loadingAglutinados ? (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">Carregando...</div>
              ) : aglutinados.length === 0 ? (
                <div className="text-center py-12 text-gray-500 dark:text-gray-400">Nenhum aglutinado salvo.</div>
              ) : (
                <div className="space-y-3">
                  {paginatedAglutinados.map(a => {
                    const dataExibir = a.data_criacao_br || (() => {
                      let d = a.data_criacao;
                      if (typeof d === 'string' && !d.endsWith('Z') && !d.includes('+') && !d.includes('-', 10)) d = d.replace(' ', 'T') + 'Z';
                      try {
                        return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                      } catch { return a.data_criacao || '-'; }
                    })();
                    const mks = (a.marketplaces || '').split(',').map(s => s.trim()).filter(Boolean);
                    return (
                      <div key={a.id} className="flex items-center justify-between gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50/50 dark:bg-gray-700/30 hover:bg-gray-100/50 dark:hover:bg-gray-700/50 transition-colors">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap gap-2 mb-2">
                            {mks.map((mk, i) => (
                              <span key={i} className="px-3 py-1 rounded-lg text-sm font-semibold bg-blue-500 dark:bg-blue-600 text-white shadow-sm">{mk}</span>
                            ))}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">{dataExibir}</div>
                        </div>
                        <div className="relative flex-shrink-0">
                          <button
                            onClick={() => setAglutinadoMenuOpen(aglutinadoMenuOpen === a.id ? null : a.id)}
                            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
                          >
                            <MoreVertical className="w-5 h-5" />
                          </button>
                          {aglutinadoMenuOpen === a.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setAglutinadoMenuOpen(null)} />
                              <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-20 py-1">
                                <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={() => { handleVisualizarAglutinado(a.id); setAglutinadoMenuOpen(null); }}>
                                  <Eye className="w-4 h-4" /> Visualizar
                                </button>
                                <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={async () => {
                                  const res = await axios.get(`/api/aglutinados/${a.id}`);
                                  handleImprimirAglutinado(res.data.conteudo_html);
                                  setAglutinadoMenuOpen(null);
                                }}>
                                  <Printer className="w-4 h-4" /> Imprimir
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {aglutinados.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50">
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Exibindo {(aglutinadosPage - 1) * aglutinadosPerPage + 1}–{Math.min(aglutinadosPage * aglutinadosPerPage, aglutinados.length)} de {aglutinados.length}
                </span>
                <div className="flex items-center gap-2">
                  <button className="px-3 py-1.5 rounded border text-sm border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50" disabled={aglutinadosPage === 1} onClick={() => setAglutinadosPage(p => Math.max(1, p - 1))}>Anterior</button>
                  <span className="text-sm text-gray-600 dark:text-gray-400">Página {aglutinadosPage} de {totalPages}</span>
                  <button className="px-3 py-1.5 rounded border text-sm border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50" disabled={aglutinadosPage === totalPages} onClick={() => setAglutinadosPage(p => Math.min(totalPages, p + 1))}>Próxima</button>
                  <select value={aglutinadosPerPage} onChange={e => { setAglutinadosPerPage(Number(e.target.value)); setAglutinadosPage(1); }} className="ml-2 border rounded text-sm px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    {[10, 15, 25, 50].map(n => <option key={n} value={n}>{n} por página</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Modal de visualização do aglutinado (sobreposto) */}
      {visualizarAglutinado && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => setVisualizarAglutinado(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
            <button className="absolute top-4 right-4 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => setVisualizarAglutinado(null)}>×</button>
            <div dangerouslySetInnerHTML={{ __html: visualizarAglutinado.conteudo_html }} />
          </div>
        </div>
      )}
    </div>
  );
};