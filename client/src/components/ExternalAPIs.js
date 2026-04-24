import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  RefreshCw, CheckCircle, LogIn, Link2, XCircle, Plus, Trash2, Globe, X, ChevronDown, ChevronUp,
  Settings, ShieldCheck, Terminal, Archive, Clock, Play, Save, Search, AlertTriangle, Eraser, Copy, Activity, Database,
  Landmark,
} from 'lucide-react';
import axios from 'axios';
import { useToast } from './Toast';

// KPI compacto usado no dashboard da aba Backup.
const KPI_TONE = {
  blue: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
  emerald: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400',
  amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  slate: 'bg-slate-50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300',
};
const KpiCard = ({ icon: Icon, label, value, tone = 'slate', hint }) => (
  <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
    <div className="flex items-center gap-2 mb-1.5">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center ${KPI_TONE[tone] || KPI_TONE.slate}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
    </div>
    <div className="text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
      {typeof value === 'number' ? value.toLocaleString('pt-BR') : (value ?? '—')}
    </div>
    {hint && <div className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{hint}</div>}
  </div>
);

const InfoLine = ({ label, value }) => (
  <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-gray-50 dark:bg-gray-700/50">
    <span className="text-gray-500 dark:text-gray-400">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 font-medium text-right truncate">{value}</span>
  </div>
);

export const ExternalAPIs = () => {
  const toast = useToast();
  const [blingAccounts, setBlingAccounts] = useState([]);
  const [blingStatusByAccount, setBlingStatusByAccount] = useState({});
  const [blingLoadingByAccount, setBlingLoadingByAccount] = useState({});
  const [blingLogs, setBlingLogs] = useState('');
  const [blingTokens, setBlingTokens] = useState([]);
  const [newAccountName, setNewAccountName] = useState('');
  const [blingCredsByAccount, setBlingCredsByAccount] = useState({});
  const [blingNameByAccount, setBlingNameByAccount] = useState({});

  const [mlAccounts, setMlAccounts] = useState([]);
  const [mlStatusByAccount, setMlStatusByAccount] = useState({});
  const [mlLoadingByAccount, setMlLoadingByAccount] = useState({});
  const [mlCredsByAccount, setMlCredsByAccount] = useState({});
  const [mlSyncing, setMlSyncing] = useState({});

  const [shopeeAccounts, setShopeeAccounts] = useState([]);
  const [shopeeStatusByAccount, setShopeeStatusByAccount] = useState({});
  const [shopeeLoadingByAccount, setShopeeLoadingByAccount] = useState({});
  const [shopeeCredsByAccount, setShopeeCredsByAccount] = useState({});
  const [shopeeSyncing, setShopeeSyncing] = useState({});

  // Alíquota de imposto por conta (em %), dirty-state e saving-state do form.
  // A alíquota entra como `taxes_seller` no relatório de custos de pedido.
  const [taxByAccount, setTaxByAccount] = useState({});
  const [savingTax, setSavingTax] = useState({});

  const [expandedCards, setExpandedCards] = useState({});

  // Aba ativa dentro da tela de Configurações — persiste entre visitas.
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem('configTab') || 'marketplaces'; }
    catch (_) { return 'marketplaces'; }
  });
  useEffect(() => {
    try { localStorage.setItem('configTab', activeTab); } catch (_) {}
  }, [activeTab]);

  // Backup — estado da aba "Backup" (status + form de agendamento).
  const [backupStatus, setBackupStatus] = useState(null);
  const [backupStatusLoading, setBackupStatusLoading] = useState(false);
  const [backupCfgForm, setBackupCfgForm] = useState({
    enabled: true, hour: 0, pace_ms: 1500, batch: 2000, max_run_min: 240, freeze_after: 3,
  });
  const [backupCfgLoaded, setBackupCfgLoaded] = useState(false);
  const [backupCfgSaving, setBackupCfgSaving] = useState(false);
  const [backupCfgDirty, setBackupCfgDirty] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);

  // Histórico de um pedido (modal na aba Backup).
  const [historyModalOrderId, setHistoryModalOrderId] = useState('');
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyModalRows, setHistoryModalRows] = useState([]);
  const [historyModalLoading, setHistoryModalLoading] = useState(false);

  // Console Bling — filtros + auto-refresh na aba "Avançado".
  const [consoleFilter, setConsoleFilter] = useState('');
  const [consoleAutoRefresh, setConsoleAutoRefresh] = useState(false);
  const [consoleLoading, setConsoleLoading] = useState(false);

  // Mapeamento de faturamento — liga cada conta de marketplace a uma conta Bling
  // e controla o disparo automático do fluxo de NFe.
  const [savingMapping, setSavingMapping] = useState({});
  const saveBillingMapping = async (marketplace, accountId, patch) => {
    const key = `${marketplace}-${accountId}`;
    setSavingMapping(prev => ({ ...prev, [key]: true }));
    try {
      await axios.put('/api/marketplace-bling-mapping', { marketplace, account_id: accountId, ...patch });
      if (marketplace === 'ml') {
        setMlAccounts(prev => prev.map(a => a.id === accountId ? { ...a, ...patch } : a));
      } else {
        setShopeeAccounts(prev => prev.map(a => a.id === accountId ? { ...a, ...patch } : a));
      }
      toast.success('Mapeamento atualizado');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao salvar mapeamento');
    }
    setSavingMapping(prev => ({ ...prev, [key]: false }));
  };

  const toggleCardExpanded = (key) => {
    setExpandedCards(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Bloco reutilizável de imposto por conta de marketplace. A alíquota entra
  // no cálculo de `taxes_seller` do relatório de Análise de Custos de Pedido.
  const saveTaxForAccount = async (marketplace, accountId) => {
    const key = `${marketplace}-${accountId}`;
    const raw = taxByAccount[key];
    const value = raw === '' || raw == null ? null : Number(raw);
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 100)) {
      toast.warn('Alíquota inválida (use percentual entre 0 e 100).');
      return;
    }
    setSavingTax(prev => ({ ...prev, [key]: true }));
    try {
      const url = marketplace === 'ml'
        ? `/api/ml/accounts/${accountId}/tax-settings`
        : `/api/shopee/accounts/${accountId}/tax-settings`;
      await axios.put(url, { tax_pct: value });
      if (marketplace === 'ml') {
        setMlAccounts(prev => prev.map(a => a.id === accountId ? { ...a, tax_pct: value } : a));
      } else {
        setShopeeAccounts(prev => prev.map(a => a.id === accountId ? { ...a, tax_pct: value } : a));
      }
      toast.success(value == null ? 'Alíquota removida' : 'Alíquota salva');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao salvar alíquota');
    }
    setSavingTax(prev => ({ ...prev, [key]: false }));
  };

  const TaxSettingsBlock = ({ marketplace, account }) => {
    const key = `${marketplace}-${account.id}`;
    const saving = !!savingTax[key];
    const current = taxByAccount[key] ?? (account.tax_pct == null ? '' : String(account.tax_pct));
    const dirty = (current === '' ? null : Number(current)) !== (account.tax_pct == null ? null : Number(account.tax_pct));
    return (
      <div className="mt-3 pt-3 border-t dark:border-gray-700">
        <div className="flex items-center gap-2 mb-2">
          <Landmark className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Imposto (alíquota por conta)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Alíquota (%)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={current}
              onChange={(e) => setTaxByAccount(prev => ({ ...prev, [key]: e.target.value }))}
              placeholder="Ex.: 6.00"
              className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-snug md:pb-2">
            Incide sobre a receita bruta de cada pedido desta conta (Simples Nacional, PIS/COFINS etc.).
            É usada como <span className="font-medium">imposto do vendedor</span> no relatório de Análise de Custos de Pedido.
            Deixe em branco para desativar.
          </p>
          <button
            type="button"
            onClick={() => saveTaxForAccount(marketplace, account.id)}
            disabled={saving || !dirty}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 dark:disabled:bg-blue-900/50 text-white text-xs rounded-md transition-colors flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
        {account.tax_pct == null && !dirty && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Sem alíquota configurada — o imposto do vendedor fica zerado nos pedidos desta conta até você preencher e salvar aqui.
          </p>
        )}
      </div>
    );
  };

  // Bloco reutilizável "Faturamento (Bling)" dentro das configurações expandidas
  // de cada conta de marketplace.
  const BillingMappingBlock = ({ marketplace, account }) => {
    const key = `${marketplace}-${account.id}`;
    const saving = savingMapping[key];
    return (
      <div className="mt-3 pt-3 border-t dark:border-gray-700">
        <div className="flex items-center gap-2 mb-2">
          <Link2 className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Faturamento (Bling)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Conta Bling que fatura os pedidos desta conta
            </label>
            <select
              value={account.bling_account_id || ''}
              disabled={saving}
              onChange={(e) => saveBillingMapping(marketplace, account.id, {
                bling_account_id: e.target.value ? parseInt(e.target.value, 10) : null,
              })}
              className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            >
              <option value="">— Nenhuma (envio manual) —</option>
              {blingAccounts.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!account.auto_invoice_enabled}
              disabled={saving || !account.bling_account_id}
              onChange={(e) => saveBillingMapping(marketplace, account.id, {
                auto_invoice_enabled: e.target.checked ? 1 : 0,
              })}
              className="w-4 h-4 rounded border-gray-300"
            />
            <span className="text-xs text-gray-700 dark:text-gray-300" title="Quando ligado, o worker fatura os pedidos automaticamente assim que ficarem prontos.">
              Faturar automaticamente
            </span>
          </label>
        </div>
        {!account.bling_account_id && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Sem conta Bling mapeada, os pedidos desta conta precisam ser enviados manualmente em "Pedidos Marketplace".
          </p>
        )}
      </div>
    );
  };

  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState(null);
  const [newIntegrationName, setNewIntegrationName] = useState('');
  const [creatingIntegration, setCreatingIntegration] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => {
    fetchBlingAccounts();
    fetchBlingTokens();
    fetchMLAccounts();
    fetchShopeeAccounts();
    fetchBackupStatus();
    fetchBackupConfig();
  }, []);

  // Auto-refresh do status do backup enquanto a aba "Backup" estiver aberta —
  // a execução pode levar horas e queremos que o usuário veja o progresso sem
  // precisar atualizar manualmente.
  useEffect(() => {
    if (activeTab !== 'backup') return undefined;
    fetchBackupStatus();
    const id = setInterval(fetchBackupStatus, 30000);
    return () => clearInterval(id);
  }, [activeTab]);

  // Console: carrega ao abrir a aba Avançado. Auto-refresh opcional a cada 5s.
  useEffect(() => {
    if (activeTab !== 'advanced') return undefined;
    fetchBlingLogs();
    if (!consoleAutoRefresh) return undefined;
    const id = setInterval(() => fetchBlingLogs(true), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, consoleAutoRefresh]);

  const fetchBlingAccounts = async () => {
    try {
      const res = await axios.get('/api/bling/accounts');
      const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
      setBlingAccounts(accounts);
      const nextCreds = {};
      const nextNames = {};
      accounts.forEach(acc => {
        nextCreds[acc.id] = {
          client_id: acc.client_id || '',
          client_secret: '',
          redirect_uri: acc.redirect_uri || ''
        };
        nextNames[acc.id] = acc.name || '';
      });
      setBlingCredsByAccount(nextCreds);
      setBlingNameByAccount(nextNames);
      accounts.forEach(acc => fetchBlingStatus(acc.id));
    } catch (e) {
      setBlingAccounts([]);
    }
  };

  const fetchBlingStatus = async (accountId) => {
    setBlingLoadingByAccount(prev => ({ ...prev, [accountId]: true }));
    try {
      const res = await axios.get('/api/bling/status', { params: { accountId } });
      setBlingStatusByAccount(prev => ({ ...prev, [accountId]: res.data }));
    } catch (e) {
      setBlingStatusByAccount(prev => ({ ...prev, [accountId]: { connected: false } }));
    } finally {
      setBlingLoadingByAccount(prev => ({ ...prev, [accountId]: false }));
    }
  };

  const fetchBlingLogs = async (silent = false) => {
    if (!silent) setConsoleLoading(true);
    try {
      const res = await axios.get('/api/bling/logs', { params: { lines: 200 } });
      setBlingLogs(typeof res.data === 'string' ? res.data : String(res.data || ''));
    } catch (e) {
      setBlingLogs('Erro ao carregar logs.');
    }
    if (!silent) setConsoleLoading(false);
  };

  const clearBlingLogs = async () => {
    if (!window.confirm('Limpar o console da API Bling? Essa ação apaga o arquivo de log.')) return;
    try {
      await axios.delete('/api/bling/logs');
      setBlingLogs('');
      toast.success('Console limpo');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao limpar console');
    }
  };

  const copyConsoleToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(blingLogs || '');
      toast.success('Console copiado');
    } catch (_) {
      toast.error('Não foi possível copiar');
    }
  };

  // Backup — fetchers e mutadores.
  const fetchBackupStatus = async () => {
    setBackupStatusLoading(true);
    try {
      const res = await axios.get('/api/marketplace-orders/backup-status');
      setBackupStatus(res.data || null);
      setBackupRunning(!!res.data?.last_run?.running);
    } catch (_) {
      setBackupStatus(null);
    }
    setBackupStatusLoading(false);
  };

  const fetchBackupConfig = async () => {
    try {
      const res = await axios.get('/api/marketplace-orders/backup-config');
      const d = res.data || {};
      setBackupCfgForm({
        enabled: d.enabled !== false,
        hour: Number(d.hour ?? 0),
        pace_ms: Number(d.pace_ms ?? 1500),
        batch: Number(d.batch ?? 2000),
        max_run_min: Number(d.max_run_min ?? 240),
        freeze_after: Number(d.freeze_after ?? 3),
      });
      setBackupCfgLoaded(true);
      setBackupCfgDirty(false);
    } catch (_) {
      setBackupCfgLoaded(true);
    }
  };

  const saveBackupConfig = async () => {
    setBackupCfgSaving(true);
    try {
      await axios.put('/api/marketplace-orders/backup-config', backupCfgForm);
      toast.success('Agendamento salvo e reagendado');
      setBackupCfgDirty(false);
      fetchBackupStatus();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao salvar configuração');
    }
    setBackupCfgSaving(false);
  };

  const runBackupNow = async () => {
    if (!window.confirm('Disparar o ciclo de backup agora? Ele pode levar horas em bancos grandes.')) return;
    try {
      await axios.post('/api/marketplace-orders/backup-run', {});
      toast.success('Backup iniciado em segundo plano');
      setTimeout(fetchBackupStatus, 1500);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao iniciar backup');
    }
  };

  const openHistoryModal = async () => {
    const id = parseInt(historyModalOrderId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.warn('Informe o ID do pedido (número inteiro).');
      return;
    }
    setHistoryModalOpen(true);
    setHistoryModalLoading(true);
    try {
      const res = await axios.get(`/api/marketplace-orders/${id}/history`);
      setHistoryModalRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setHistoryModalRows([]);
      toast.error(e.response?.data?.error || 'Erro ao carregar histórico');
    }
    setHistoryModalLoading(false);
  };

  const forceHydrateOrderFromModal = async () => {
    const id = parseInt(historyModalOrderId, 10);
    if (!Number.isFinite(id)) return;
    try {
      await axios.post(`/api/marketplace-orders/${id}/hydrate`, {});
      toast.success('Pedido re-hidratado');
      const res = await axios.get(`/api/marketplace-orders/${id}/history`);
      setHistoryModalRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao re-hidratar');
    }
  };

  const fetchBlingTokens = async () => {
    try {
      const res = await axios.get('/api/bling/tokens');
      setBlingTokens(res.data.tokens || []);
    } catch (e) {
      setBlingTokens([]);
    }
  };

  const handleConnectBling = async (accountId) => {
    try {
      const res = await axios.get('/api/bling/auth', { params: { accountId } });
      if (res.data && res.data.url) {
        window.open(res.data.url, '_blank');
      }
    } catch (e) {
      toast.error('Erro ao gerar link de autorização do Bling.');
    }
  };

  const handleCreateAccount = async () => {
    const name = (newAccountName || '').trim();
    if (!name) return;
    try {
      await axios.post('/api/bling/accounts', { name });
      setNewAccountName('');
      fetchBlingAccounts();
    } catch {
      toast.error('Erro ao criar conta do Bling.');
    }
  };

  const handleCleanTokens = async () => {
    try {
      await axios.delete('/api/bling/tokens');
      fetchBlingTokens();
      toast.success('Tokens antigos removidos com sucesso!');
    } catch (e) {
      toast.error('Erro ao limpar tokens antigos.');
    }
  };

  const handleDisconnectBling = async (accountId) => {
    try {
      await axios.delete('/api/bling/tokens/revoke', { params: { accountId } });
      fetchBlingTokens();
      fetchBlingStatus(accountId);
      toast.success('Conta desconectada com sucesso!');
    } catch (e) {
      toast.error('Erro ao desconectar a conta.');
    }
  };

  const handleCredChange = (accountId, field, value) => {
    setBlingCredsByAccount(prev => ({
      ...prev,
      [accountId]: { ...(prev[accountId] || {}), [field]: value }
    }));
  };

  const handleSaveCreds = async (accountId) => {
    const creds = blingCredsByAccount[accountId] || {};
    try {
      await axios.put(`/api/bling/accounts/${accountId}/credentials`, {
        client_id: (creds.client_id || '').trim(),
        client_secret: (creds.client_secret || '').trim(),
        redirect_uri: (creds.redirect_uri || '').trim()
      });
      toast.success('Credenciais salvas com sucesso!');
      fetchBlingAccounts();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao salvar credenciais.');
    }
  };

  const handleNameChange = (accountId, value) => {
    setBlingNameByAccount(prev => ({ ...prev, [accountId]: value }));
  };

  const handleSaveName = async (accountId) => {
    const name = (blingNameByAccount[accountId] || '').trim();
    if (!name) {
      toast.warn('Nome da conta é obrigatório.');
      return;
    }
    try {
      await axios.put(`/api/bling/accounts/${accountId}`, { name });
      toast.success('Nome atualizado com sucesso!');
      fetchBlingAccounts();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao atualizar nome da conta.');
    }
  };

  const fetchMLAccounts = async () => {
    try {
      const res = await axios.get('/api/ml/accounts');
      const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
      setMlAccounts(accounts);
      const creds = {};
      accounts.forEach(acc => {
        creds[acc.id] = { client_id: acc.client_id || '', client_secret: '', redirect_uri: acc.redirect_uri || '' };
      });
      setMlCredsByAccount(creds);
      accounts.forEach(acc => fetchMLStatus(acc.id));
    } catch { setMlAccounts([]); }
  };

  const fetchMLStatus = async (accountId) => {
    setMlLoadingByAccount(p => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.get('/api/ml/status', { params: { accountId } });
      setMlStatusByAccount(p => ({ ...p, [accountId]: res.data }));
    } catch { setMlStatusByAccount(p => ({ ...p, [accountId]: { connected: false } })); }
    setMlLoadingByAccount(p => ({ ...p, [accountId]: false }));
  };


  const handleMLSaveCredentials = async (accountId, formEl) => {
    const fd = new FormData(formEl);
    const clientId = (fd.get('ml_client_id') || '').trim();
    const clientSecret = (fd.get('ml_client_secret') || '').trim();
    const redirectUri = (fd.get('ml_redirect_uri') || '').trim();
    if (!clientId || !redirectUri) return toast.error('Client ID e Redirect URI são obrigatórios');
    try {
      await axios.put(`/api/ml/accounts/${accountId}/credentials`, {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      });
      toast.success('Credenciais ML salvas!');
      fetchMLAccounts();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao salvar credenciais'); }
  };

  const handleMLConnect = async (accountId) => {
    try {
      const res = await axios.get('/api/ml/auth', { params: { accountId } });
      if (res.data?.url) window.open(res.data.url, '_blank');
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao gerar URL de autorização ML'); }
  };

  const handleMLDisconnect = async (accountId) => {
    try {
      await axios.delete('/api/ml/tokens/revoke', { params: { accountId } });
      toast.success('Desconectado do Mercado Livre');
      fetchMLStatus(accountId);
    } catch (e) { toast.error('Erro ao desconectar'); }
  };

  const handleMLSync = async (accountId) => {
    setMlSyncing(p => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.post('/api/ml/items/sync', { accountId });
      toast.success(`Sincronizados ${res.data.synced} de ${res.data.total} anúncios`);
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao sincronizar'); }
    setMlSyncing(p => ({ ...p, [accountId]: false }));
  };

  const handleMLDeleteAccount = async (accountId, name) => {
    if (!window.confirm(`Tem certeza que deseja excluir a integração "${name}"? Todos os anúncios e configurações vinculados serão removidos.`)) return;
    try {
      await axios.delete(`/api/ml/accounts/${accountId}`);
      toast.success('Integração removida');
      fetchMLAccounts();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao excluir integração'); }
  };

  // --- Shopee ---
  const fetchShopeeAccounts = async () => {
    try {
      const res = await axios.get('/api/shopee/accounts');
      const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
      setShopeeAccounts(accounts);
      const creds = {};
      accounts.forEach(acc => {
        creds[acc.id] = { partner_id: acc.partner_id || '', partner_key: '', redirect_uri: acc.redirect_uri || '' };
      });
      setShopeeCredsByAccount(creds);
      accounts.forEach(acc => fetchShopeeStatus(acc.id));
    } catch { setShopeeAccounts([]); }
  };

  const fetchShopeeStatus = async (accountId) => {
    setShopeeLoadingByAccount(p => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.get(`/api/shopee/connection-status/${accountId}`);
      setShopeeStatusByAccount(p => ({ ...p, [accountId]: res.data }));
    } catch { setShopeeStatusByAccount(p => ({ ...p, [accountId]: { connected: false } })); }
    setShopeeLoadingByAccount(p => ({ ...p, [accountId]: false }));
  };


  const handleShopeeSaveCredentials = async (accountId, formEl) => {
    const fd = new FormData(formEl);
    const partnerId = (fd.get('shopee_partner_id') || '').trim();
    const partnerKey = (fd.get('shopee_partner_key') || '').trim();
    const redirectUri = (fd.get('shopee_redirect_uri') || '').trim();
    if (!partnerId || !partnerKey) return toast.error('Partner ID e Partner Key são obrigatórios');
    try {
      await axios.put(`/api/shopee/accounts/${accountId}`, {
        partner_id: partnerId,
        partner_key: partnerKey,
        redirect_uri: redirectUri
      });
      toast.success('Credenciais Shopee salvas!');
      fetchShopeeAccounts();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao salvar credenciais'); }
  };

  const handleShopeeConnect = async (accountId) => {
    try {
      const res = await axios.get(`/api/shopee/auth-url/${accountId}`);
      if (res.data?.url) window.open(res.data.url, '_blank');
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao gerar URL de autorização Shopee'); }
  };

  const handleShopeeSync = async (accountId) => {
    setShopeeSyncing(p => ({ ...p, [accountId]: true }));
    try {
      const res = await axios.post('/api/shopee/items/sync', { accountId });
      toast.success(`Sincronizados ${res.data.synced} de ${res.data.total} anúncios Shopee`);
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao sincronizar Shopee'); }
    setShopeeSyncing(p => ({ ...p, [accountId]: false }));
  };

  const handleShopeeDeleteAccount = async (accountId, name) => {
    if (!window.confirm(`Tem certeza que deseja excluir a integração Shopee "${name}"? Todos os anúncios e configurações vinculados serão removidos.`)) return;
    try {
      await axios.delete(`/api/shopee/accounts/${accountId}`);
      toast.success('Integração Shopee removida');
      fetchShopeeAccounts();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao excluir integração Shopee'); }
  };

  const MARKETPLACES = [
    { id: 'mercado_livre', name: 'Mercado Livre', logo: '/mercado-livre.png', color: 'bg-yellow-500', hoverColor: 'hover:bg-yellow-600', available: true },
    { id: 'shopee', name: 'Shopee', logo: '/shopee.png', color: 'bg-orange-500', hoverColor: 'hover:bg-orange-600', available: true },
    { id: 'amazon', name: 'Amazon', logo: '/amazon.png', color: 'bg-gray-700', hoverColor: 'hover:bg-gray-800', available: false },
    { id: 'magalu', name: 'Magazine Luiza', logo: '/magalu.png', color: 'bg-blue-600', hoverColor: 'hover:bg-blue-700', available: false },
    { id: 'shein', name: 'Shein', logo: '/shein.png', color: 'bg-black', hoverColor: 'hover:bg-gray-900', available: false },
    { id: 'olist', name: 'Olist', logo: '/olist.png', color: 'bg-purple-600', hoverColor: 'hover:bg-purple-700', available: false },
    { id: 'leroy', name: 'Leroy Merlin', logo: '/leroy-merlin.png', color: 'bg-green-600', hoverColor: 'hover:bg-green-700', available: false },
    { id: 'madeira', name: 'MadeiraMadeira', logo: '/madeira.png', color: 'bg-red-600', hoverColor: 'hover:bg-red-700', available: false },
  ];

  const handleCreateIntegration = async () => {
    if (!selectedMarketplace || !newIntegrationName.trim()) return;
    setCreatingIntegration(true);
    try {
      if (selectedMarketplace === 'mercado_livre') {
        await axios.post('/api/ml/accounts', { name: newIntegrationName.trim() });
        toast.success('Integração Mercado Livre criada!');
        fetchMLAccounts();
      } else if (selectedMarketplace === 'shopee') {
        await axios.post('/api/shopee/accounts', { name: newIntegrationName.trim() });
        toast.success('Integração Shopee criada!');
        fetchShopeeAccounts();
      }
      setShowAddModal(false);
      setSelectedMarketplace(null);
      setNewIntegrationName('');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao criar integração');
    }
    setCreatingIntegration(false);
  };

  const handleModalBackdropClick = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      setShowAddModal(false);
      setSelectedMarketplace(null);
      setNewIntegrationName('');
    }
  };

  // Formata uma data ISO para horário de Brasília, ou devolve fallback legível.
  const fmtDT = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
    catch (_) { return '—'; }
  };

  // Calcula quanto falta para o próximo run (em texto amigável).
  const etaText = (iso) => {
    if (!iso) return '—';
    const t = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(t)) return '—';
    if (t <= 0) return 'agora';
    const mins = Math.round(t / 60000);
    if (mins < 60) return `em ${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `em ${h}h${m}min` : `em ${h}h`;
  };

  // Linhas do console filtradas (aba Avançado) com destaque por palavra-chave.
  const consoleLines = useMemo(() => {
    if (!blingLogs) return [];
    const lines = String(blingLogs).split(/\r?\n/).filter(Boolean);
    const q = consoleFilter.trim().toLowerCase();
    const filtered = q ? lines.filter(l => l.toLowerCase().includes(q)) : lines;
    return filtered.map((line, idx) => {
      const lower = line.toLowerCase();
      let cls = 'text-gray-600 dark:text-gray-300';
      if (/erro|error|fail/.test(lower)) cls = 'text-red-600 dark:text-red-400';
      else if (/refresh/.test(lower)) cls = 'text-amber-600 dark:text-amber-400';
      else if (/salvo|saved|success|sucesso|carregado/.test(lower)) cls = 'text-emerald-600 dark:text-emerald-400';
      else if (/token/.test(lower)) cls = 'text-blue-600 dark:text-blue-400';
      return { line, cls, idx };
    });
  }, [blingLogs, consoleFilter]);

  const TABS = [
    { id: 'marketplaces', label: 'Marketplaces', icon: Globe },
    { id: 'bling', label: 'Bling', icon: Link2 },
    { id: 'backup', label: 'Backup', icon: ShieldCheck },
    { id: 'advanced', label: 'Avançado', icon: Terminal },
  ];

  const hasMkt = mlAccounts.length > 0 || shopeeAccounts.length > 0;

  return (
    <div className="space-y-5">
      {/* Cabeçalho */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 px-5 py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-sm">
              <Settings className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-white leading-tight">Configurações</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Integrações, backup e ferramentas internas do Miti</p>
            </div>
          </div>
          {backupStatus && (
            <div className="flex items-center gap-2 text-xs">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full ${backupStatus.last_run?.running ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'}`}>
                <Activity className="w-3.5 h-3.5" />
                {backupStatus.last_run?.running ? 'Backup em execução' : 'Backup ok'}
              </span>
              <span className="text-gray-500 dark:text-gray-400">
                {backupStatus.total?.toLocaleString?.('pt-BR') || backupStatus.total} pedidos · {backupStatus.frozen?.toLocaleString?.('pt-BR') || backupStatus.frozen} congelados
              </span>
            </div>
          )}
        </div>

        {/* TabBar */}
        <div className="mt-4 -mx-5 px-5 border-t border-gray-100 dark:border-gray-700 overflow-x-auto">
          <div className="flex items-center gap-1 pt-2">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
                    active
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }`}
                >
                  <Icon className="w-4 h-4" /> {t.label}
                  {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-blue-600 dark:bg-blue-400" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ═══ Aba: Marketplaces ═══ */}
      {activeTab === 'marketplaces' && (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
        {!hasMkt && (
          <div className="text-center py-10 text-gray-400 dark:text-gray-500">
            <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Nenhuma integração cadastrada. Adicione um marketplace abaixo.</p>
          </div>
        )}

        {mlAccounts.map(acc => {
          const status = mlStatusByAccount[acc.id];
          const loading = mlLoadingByAccount[acc.id];
          const creds = mlCredsByAccount[acc.id] || {};
          const syncing = mlSyncing[acc.id];
          const isExpanded = expandedCards[`ml-${acc.id}`];
          return (
            <div key={acc.id} className="border dark:border-gray-700 rounded-lg mb-4 overflow-hidden">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <img src="/mercado-livre.png" alt="ML" className="w-8 h-8 object-contain rounded" />
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-white">{acc.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-medium">Mercado Livre</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {loading ? (
                        <span className="text-xs text-gray-400">Verificando...</span>
                      ) : status?.connected ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> Conectado {status.nickname && `(${status.nickname})`}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-red-500">
                          <XCircle className="w-3.5 h-3.5" />
                          {status?.reason === 'no_refresh_token'
                            ? 'Reconectar necessária (token não renova automaticamente)'
                            : 'Desconectado'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {status?.connected ? (
                    <button type="button" onClick={() => handleMLSync(acc.id)} disabled={syncing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors disabled:opacity-50 flex items-center gap-1">
                      <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Sincronizando...' : 'Sincronizar'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => handleMLConnect(acc.id)} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded-md transition-colors flex items-center gap-1">
                      <LogIn className="w-3.5 h-3.5" /> Conectar
                    </button>
                  )}
                  <button onClick={() => toggleCardExpanded(`ml-${acc.id}`)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    title={isExpanded ? 'Recolher' : 'Expandir configurações'}>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4 border-t dark:border-gray-700 pt-3">
                  <form onSubmit={e => { e.preventDefault(); handleMLSaveCredentials(acc.id, e.target); }}>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Client ID (APP ID)</label>
                        <input type="text" name="ml_client_id" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.client_id || ''} placeholder="Ex: 1234567890" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Client Secret</label>
                        <input type="password" name="ml_client_secret" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.client_secret || ''} placeholder={acc.has_secret ? '••••••••' : 'Secret Key'} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Redirect URI</label>
                        <input type="text" name="ml_redirect_uri" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.redirect_uri || ''} placeholder="https://miti.fly.dev/api/ml/callback" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-white text-sm rounded-md transition-colors">Salvar Credenciais</button>
                    </div>
                  </form>

                  <BillingMappingBlock marketplace="ml" account={acc} />

                  <TaxSettingsBlock marketplace="ml" account={acc} />

                  <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t dark:border-gray-700">
                    {status?.connected ? (
                      <>
                        <button type="button" onClick={() => fetchMLStatus(acc.id)} className="px-3 py-1.5 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded-md hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">Verificar Status</button>
                        <button type="button" onClick={() => handleMLDisconnect(acc.id)} className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-md transition-colors">Desconectar</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => handleMLConnect(acc.id)} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded-md transition-colors flex items-center gap-1">
                        <LogIn className="w-3.5 h-3.5" /> Conectar Mercado Livre
                      </button>
                    )}
                    <button onClick={() => handleMLDeleteAccount(acc.id, acc.name)}
                      className="px-3 py-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-xs flex items-center gap-1"
                      title="Excluir integração">
                      <Trash2 className="w-3.5 h-3.5" /> Excluir
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Shopee Accounts */}
        {shopeeAccounts.map(acc => {
          const status = shopeeStatusByAccount[acc.id];
          const loading = shopeeLoadingByAccount[acc.id];
          const creds = shopeeCredsByAccount[acc.id] || {};
          const syncing = shopeeSyncing[acc.id];
          const isExpanded = expandedCards[`shopee-${acc.id}`];
          return (
            <div key={`shopee-${acc.id}`} className="border dark:border-gray-700 rounded-lg mb-4 overflow-hidden">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <img src="/shopee.png" alt="Shopee" className="w-8 h-8 object-contain rounded" />
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-white">{acc.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 font-medium">Shopee</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {loading ? (
                        <span className="text-xs text-gray-400">Verificando...</span>
                      ) : status?.connected ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> Conectado {status.shop_id && `(Shop: ${status.shop_id})`}</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-red-500"><XCircle className="w-3.5 h-3.5" /> Desconectado</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {status?.connected ? (
                    <button type="button" onClick={() => handleShopeeSync(acc.id)} disabled={syncing} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors disabled:opacity-50 flex items-center gap-1">
                      <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> {syncing ? 'Sincronizando...' : 'Sincronizar'}
                    </button>
                  ) : (
                    <button type="button" onClick={() => handleShopeeConnect(acc.id)} className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-xs rounded-md transition-colors flex items-center gap-1">
                      <LogIn className="w-3.5 h-3.5" /> Conectar
                    </button>
                  )}
                  <button onClick={() => toggleCardExpanded(`shopee-${acc.id}`)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    title={isExpanded ? 'Recolher' : 'Expandir configurações'}>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4 border-t dark:border-gray-700 pt-3">
                  <form onSubmit={e => { e.preventDefault(); handleShopeeSaveCredentials(acc.id, e.target); }}>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Partner ID</label>
                        <input type="text" name="shopee_partner_id" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.partner_id || ''} placeholder="Ex: 2001234" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Partner Key</label>
                        <input type="password" name="shopee_partner_key" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.partner_key || ''} placeholder={acc.partner_key ? '••••••••' : 'Partner Key'} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Redirect URI</label>
                        <input type="text" name="shopee_redirect_uri" autoComplete="off" className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue={creds.redirect_uri || ''} placeholder="https://miti.fly.dev/api/shopee/callback" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded-md transition-colors">Salvar Credenciais</button>
                    </div>
                  </form>

                  <BillingMappingBlock marketplace="shopee" account={acc} />

                  <TaxSettingsBlock marketplace="shopee" account={acc} />

                  <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t dark:border-gray-700">
                    {status?.connected && (
                      <button type="button" onClick={() => fetchShopeeStatus(acc.id)} className="px-3 py-1.5 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded-md hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">Verificar Status</button>
                    )}
                    <button onClick={() => handleShopeeDeleteAccount(acc.id, acc.name)}
                      className="px-3 py-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-xs flex items-center gap-1"
                      title="Excluir integração">
                      <Trash2 className="w-3.5 h-3.5" /> Excluir
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="border-t dark:border-gray-700 pt-4 mt-4 flex justify-center">
          <button
            onClick={() => setShowAddModal(true)}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2 text-sm font-medium shadow-sm"
          >
            <Plus className="w-4 h-4" /> Adicionar Marketplace
          </button>
        </div>
      </div>
      )}

      {/* ═══ Aba: Bling ═══ */}
      {activeTab === 'bling' && (
      <div className="space-y-4">
        {blingAccounts.length === 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-10 text-center text-gray-400 dark:text-gray-500">
            <Link2 className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Nenhuma conta Bling cadastrada. Adicione uma conta abaixo.</p>
          </div>
        )}

        {blingAccounts.map(acc => {
          const status = blingStatusByAccount[acc.id];
          const loading = blingLoadingByAccount[acc.id];
          const creds = blingCredsByAccount[acc.id] || {};
          const nameValue = blingNameByAccount[acc.id] ?? acc.name ?? '';
          const isExpanded = expandedCards[`bling-${acc.id}`];
          const tokensForAcc = (blingTokens || []).filter(t => t.account_id === acc.id);
          return (
            <div key={acc.id} className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
                    <Link2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-gray-900 dark:text-white">{acc.name}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium">Bling</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {loading ? (
                        <span className="text-xs text-gray-400">Verificando...</span>
                      ) : status?.connected ? (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle className="w-3.5 h-3.5" /> Conectado</span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-red-500"><XCircle className="w-3.5 h-3.5" /> Desconectado</span>
                      )}
                      {tokensForAcc.length > 0 && (
                        <span className="text-[11px] text-gray-400 dark:text-gray-500">· {tokensForAcc.length} token{tokensForAcc.length > 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {status?.connected ? (
                    <>
                      <button type="button" onClick={() => fetchBlingStatus(acc.id)} className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded-md transition-colors flex items-center gap-1">
                        <RefreshCw className="w-3.5 h-3.5" /> Atualizar
                      </button>
                      <button type="button" onClick={() => handleDisconnectBling(acc.id)} className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-md transition-colors">Desconectar</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => handleConnectBling(acc.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors flex items-center gap-1">
                      <LogIn className="w-3.5 h-3.5" /> Conectar Bling
                    </button>
                  )}
                  <button onClick={() => toggleCardExpanded(`bling-${acc.id}`)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    title={isExpanded ? 'Recolher' : 'Expandir configurações'}>
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 pb-4 border-t dark:border-gray-700 pt-4 space-y-4">
                  {/* Nome da conta */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nome da conta</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="flex-1 px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        placeholder="Ex: Bling Principal"
                        value={nameValue}
                        onChange={(e) => handleNameChange(acc.id, e.target.value)}
                      />
                      <button
                        className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm rounded-md transition-colors"
                        onClick={() => handleSaveName(acc.id)}
                      >
                        Salvar
                      </button>
                    </div>
                  </div>

                  {/* Credenciais */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Credenciais OAuth</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Client ID</label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          placeholder="client_id"
                          value={creds.client_id || ''}
                          onChange={(e) => handleCredChange(acc.id, 'client_id', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Client Secret</label>
                        <input
                          type="password"
                          className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          placeholder={acc.has_client_secret ? '•••••••• (já configurado)' : 'client_secret'}
                          value={creds.client_secret || ''}
                          onChange={(e) => handleCredChange(acc.id, 'client_secret', e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Redirect URI</label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          placeholder="https://miti.fly.dev/api/bling/callback"
                          value={creds.redirect_uri || ''}
                          onChange={(e) => handleCredChange(acc.id, 'redirect_uri', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="mt-2">
                      <button
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md transition-colors"
                        onClick={() => handleSaveCreds(acc.id)}
                      >
                        Salvar credenciais
                      </button>
                    </div>
                  </div>

                  {/* Tokens desta conta */}
                  <div className="pt-3 border-t dark:border-gray-700">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">Tokens ativos</span>
                      <button onClick={fetchBlingTokens} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" /> Atualizar
                      </button>
                    </div>
                    {tokensForAcc.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-gray-500">Nenhum token salvo para esta conta.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {tokensForAcc.map(tk => (
                          <div key={tk.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-700/50 rounded-md px-3 py-2 text-xs">
                            <span className="font-mono text-gray-700 dark:text-gray-300">#{tk.id}</span>
                            <span className="text-gray-500 dark:text-gray-400">Atualizado {fmtDT(tk.updated_at)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Adicionar conta Bling */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Adicionar conta Bling</label>
          <div className="flex flex-col md:flex-row gap-2">
            <input
              type="text"
              placeholder="Nome da nova conta (ex: Bling 2)"
              className="flex-1 px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateAccount()}
            />
            <button
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-md transition-colors flex items-center justify-center gap-2"
              onClick={handleCreateAccount}
            >
              <Plus className="w-4 h-4" /> Adicionar
            </button>
          </div>
        </div>
      </div>
      )}

      {/* ═══ Aba: Backup ═══ */}
      {activeTab === 'backup' && (
      <div className="space-y-4">
        {/* Dashboard de status */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">Backup dos pedidos marketplace</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">Re-hidrata dados dos marketplaces e mantém histórico de versões</p>
              </div>
            </div>
            <button
              onClick={fetchBackupStatus}
              disabled={backupStatusLoading}
              className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs rounded-md transition-colors flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${backupStatusLoading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
          </div>

          {!backupStatus ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Carregando status…</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiCard icon={Database} label="Total de pedidos" value={backupStatus.total} tone="blue" />
                <KpiCard icon={Archive} label="Congelados" value={backupStatus.frozen} tone="amber" hint="Marketplace não devolve mais dados" />
                <KpiCard icon={Activity} label="Hidratados 24h" value={backupStatus.hydrated_last_24h} tone="emerald" />
                <KpiCard icon={Clock} label="Pendentes" value={backupStatus.pending_hydration} tone="slate" hint=">20h desde última hidratação" />
              </div>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                <InfoLine label="Histórico total" value={(backupStatus.history_rows || 0).toLocaleString('pt-BR') + ' versões'} />
                <InfoLine label="Última execução" value={fmtDT(backupStatus.last_run?.finished_at) + (backupStatus.last_run?.running ? ' (em andamento)' : '')} />
                <InfoLine label="Próximo run" value={`${fmtDT(backupStatus.next_run_at)} · ${etaText(backupStatus.next_run_at)}`} />
              </div>

              {backupStatus.last_run?.stats && (
                <div className="mt-3 text-[11px] text-gray-500 dark:text-gray-400">
                  Último ciclo: hidratados <b>{backupStatus.last_run.stats.hydrated}</b> · inalterados <b>{backupStatus.last_run.stats.unchanged}</b> · congelados <b>{backupStatus.last_run.stats.frozen}</b> · erros <b>{backupStatus.last_run.stats.errors}</b> · duração <b>{backupStatus.last_run.stats.duration_sec}s</b>
                </div>
              )}
            </>
          )}
        </div>

        {/* Form de agendamento */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-5 h-5 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Agendamento</h3>
          </div>

          {!backupCfgLoaded ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Carregando configuração…</p>
          ) : (
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!backupCfgForm.enabled}
                  onChange={(e) => { setBackupCfgForm(p => ({ ...p, enabled: e.target.checked })); setBackupCfgDirty(true); }}
                  className="w-4 h-4 rounded border-gray-300"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Backup noturno habilitado</span>
              </label>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Horário (hora local)</label>
                  <input
                    type="number" min="0" max="23"
                    value={backupCfgForm.hour}
                    onChange={(e) => { setBackupCfgForm(p => ({ ...p, hour: Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0)) })); setBackupCfgDirty(true); }}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">Ex: 0 = meia-noite, 3 = 03h. Jitter de 0–15min é aplicado automaticamente.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Pace entre pedidos (ms)</label>
                  <input
                    type="number" min="0" max="10000" step="100"
                    value={backupCfgForm.pace_ms}
                    onChange={(e) => { setBackupCfgForm(p => ({ ...p, pace_ms: parseInt(e.target.value, 10) || 0 })); setBackupCfgDirty(true); }}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">Tempo de espera entre cada pedido. Maior = menos carga.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Batch por execução</label>
                  <input
                    type="number" min="10" max="20000" step="100"
                    value={backupCfgForm.batch}
                    onChange={(e) => { setBackupCfgForm(p => ({ ...p, batch: parseInt(e.target.value, 10) || 100 })); setBackupCfgDirty(true); }}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">Máximo de pedidos processados por rodada.</p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Duração máxima (min)</label>
                  <input
                    type="number" min="5" max="720"
                    value={backupCfgForm.max_run_min}
                    onChange={(e) => { setBackupCfgForm(p => ({ ...p, max_run_min: parseInt(e.target.value, 10) || 60 })); setBackupCfgDirty(true); }}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Congelar após N falhas 404</label>
                  <input
                    type="number" min="1" max="20"
                    value={backupCfgForm.freeze_after}
                    onChange={(e) => { setBackupCfgForm(p => ({ ...p, freeze_after: parseInt(e.target.value, 10) || 3 })); setBackupCfgDirty(true); }}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                  />
                  <p className="mt-1 text-[11px] text-gray-400">Quando o marketplace devolver 404 N vezes seguidas, o pedido é marcado como congelado.</p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={saveBackupConfig}
                  disabled={backupCfgSaving || !backupCfgDirty}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm rounded-md transition-colors flex items-center gap-2"
                >
                  <Save className="w-4 h-4" /> {backupCfgSaving ? 'Salvando…' : 'Salvar e reagendar'}
                </button>
                {backupCfgDirty && (
                  <button
                    onClick={() => { fetchBackupConfig(); }}
                    className="px-3 py-2 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    Descartar alterações
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Ações */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Play className="w-5 h-5 text-gray-500" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">Ações</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="text-sm font-medium text-gray-900 dark:text-white mb-1">Rodar backup agora</div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Dispara o ciclo imediatamente, independente do horário agendado.</p>
              <button
                onClick={runBackupNow}
                disabled={backupStatus?.last_run?.running}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-xs rounded-md transition-colors flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" /> {backupStatus?.last_run?.running ? 'Já em execução' : 'Iniciar agora'}
              </button>
            </div>
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="text-sm font-medium text-gray-900 dark:text-white mb-1">Ver histórico de um pedido</div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Consulte todas as versões capturadas para um pedido específico.</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="ID do pedido"
                  value={historyModalOrderId}
                  onChange={(e) => setHistoryModalOrderId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && openHistoryModal()}
                  className="flex-1 px-3 py-1.5 border dark:border-gray-600 rounded-md text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                />
                <button
                  onClick={openHistoryModal}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors flex items-center gap-1.5"
                >
                  <Search className="w-3.5 h-3.5" /> Buscar
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ═══ Aba: Avançado ═══ */}
      {activeTab === 'advanced' && (
      <div className="space-y-4">
        {/* Console da API Bling */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-gray-500" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Console da API Bling</h3>
              <span className="text-[11px] text-gray-400">últimas 200 linhas</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer select-none">
                <input type="checkbox" checked={consoleAutoRefresh} onChange={(e) => setConsoleAutoRefresh(e.target.checked)} className="w-3.5 h-3.5" />
                Auto 5s
              </label>
              <button onClick={() => fetchBlingLogs()} disabled={consoleLoading} className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" title="Atualizar">
                <RefreshCw className={`w-4 h-4 ${consoleLoading ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={copyConsoleToClipboard} className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" title="Copiar">
                <Copy className="w-4 h-4" />
              </button>
              <button onClick={clearBlingLogs} className="p-1.5 rounded-md text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Limpar console">
                <Eraser className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="px-5 py-2 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              value={consoleFilter}
              onChange={(e) => setConsoleFilter(e.target.value)}
              placeholder="Filtrar linhas…"
              className="flex-1 bg-transparent text-xs focus:outline-none text-gray-700 dark:text-gray-200 placeholder-gray-400"
            />
            {consoleFilter && (
              <button onClick={() => setConsoleFilter('')} className="text-[11px] text-gray-400 hover:text-gray-600">limpar</button>
            )}
            <span className="text-[11px] text-gray-400">{consoleLines.length} linha{consoleLines.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900/40 h-96 overflow-auto font-mono text-[11px] leading-relaxed">
            {consoleLines.length === 0 ? (
              <div className="p-4 text-gray-400 text-xs">{blingLogs ? 'Nenhuma linha corresponde ao filtro.' : 'Sem logs ainda.'}</div>
            ) : (
              <div className="p-3 space-y-0.5">
                {consoleLines.map(({ line, cls, idx }) => (
                  <div key={idx} className={`whitespace-pre-wrap break-all ${cls}`}>{line}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Zona de risco */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-200 dark:border-red-900/40 overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-red-100 dark:border-red-900/40 bg-red-50/50 dark:bg-red-900/10">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">Zona de risco</h3>
          </div>
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">Limpar tokens Bling antigos</div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Remove tokens duplicados/antigos mantendo apenas o mais recente por conta. Use se houver comportamento estranho de autenticação.</p>
              </div>
              <button onClick={handleCleanTokens} className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs rounded-md transition-colors flex items-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> Limpar
              </button>
            </div>
          </div>
        </div>
      </div>
      )}

      {/* ═══ Modal histórico de pedido (global) ═══ */}
      {historyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && setHistoryModalOpen(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">Histórico do pedido #{historyModalOrderId}</h3>
              <div className="flex items-center gap-2">
                <button onClick={forceHydrateOrderFromModal} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded-md transition-colors flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5" /> Re-hidratar agora
                </button>
                <button onClick={() => setHistoryModalOpen(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-auto flex-1">
              {historyModalLoading ? (
                <p className="text-sm text-gray-500">Carregando…</p>
              ) : historyModalRows.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">Nenhuma versão registrada para este pedido.</p>
              ) : (
                <div className="space-y-2">
                  {historyModalRows.map(row => (
                    <div key={row.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900 dark:text-white">{fmtDT(row.snapshot_at)}</span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{row.source || '—'}</span>
                      </div>
                      {Array.isArray(row.changed_fields) && row.changed_fields.length > 0 && (
                        <div className="mt-1.5 text-gray-600 dark:text-gray-300">
                          Campos alterados: <span className="font-mono">{row.changed_fields.slice(0, 12).join(', ')}{row.changed_fields.length > 12 ? '…' : ''}</span>
                        </div>
                      )}
                      {row.snapshot_hash && (
                        <div className="mt-1 text-[10px] text-gray-400 font-mono truncate">hash: {row.snapshot_hash}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ Modal Adicionar Marketplace (global) ═══ */}
      {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleModalBackdropClick}>
            <div ref={modalRef} className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
              <div className="flex items-center justify-between px-6 py-4 border-b dark:border-gray-700">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  {selectedMarketplace ? 'Configurar Integração' : 'Selecione o Marketplace'}
                </h3>
                <button onClick={() => { setShowAddModal(false); setSelectedMarketplace(null); setNewIntegrationName(''); }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6">
                {!selectedMarketplace ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {MARKETPLACES.map(mp => (
                      <button
                        key={mp.id}
                        onClick={() => mp.available && setSelectedMarketplace(mp.id)}
                        disabled={!mp.available}
                        className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                          mp.available
                            ? 'border-gray-200 dark:border-gray-600 hover:border-blue-500 hover:shadow-md cursor-pointer'
                            : 'border-gray-100 dark:border-gray-700 opacity-50 cursor-not-allowed'
                        }`}
                      >
                        <img src={mp.logo} alt={mp.name} className="w-10 h-10 object-contain rounded-lg" />
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300 text-center leading-tight">{mp.name}</span>
                        {!mp.available && (
                          <span className="absolute top-1 right-1 text-[8px] px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400 font-medium">Em breve</span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
                      <img
                        src={MARKETPLACES.find(m => m.id === selectedMarketplace)?.logo}
                        alt=""
                        className="w-8 h-8 object-contain rounded-lg"
                      />
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white text-sm">
                          {MARKETPLACES.find(m => m.id === selectedMarketplace)?.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Nova integração</p>
                      </div>
                      <button onClick={() => { setSelectedMarketplace(null); setNewIntegrationName(''); }}
                        className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline">
                        Alterar
                      </button>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                        Nome da loja
                      </label>
                      <input
                        type="text"
                        className="w-full px-4 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                        placeholder="Ex: Minha Loja Principal"
                        value={newIntegrationName}
                        onChange={e => setNewIntegrationName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleCreateIntegration()}
                        autoFocus
                      />
                      <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">
                        Use um nome que identifique facilmente esta conta
                      </p>
                    </div>

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => { setSelectedMarketplace(null); setNewIntegrationName(''); }}
                        className="flex-1 px-4 py-2.5 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                      >
                        Voltar
                      </button>
                      <button
                        onClick={handleCreateIntegration}
                        disabled={!newIntegrationName.trim() || creatingIntegration}
                        className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                      >
                        {creatingIntegration ? (
                          <><RefreshCw className="w-4 h-4 animate-spin" /> Criando...</>
                        ) : (
                          <><Plus className="w-4 h-4" /> Criar Integração</>
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}; 