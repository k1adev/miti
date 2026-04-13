import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle, LogIn, Link2, XCircle, Plus, Trash2, Globe, X, ChevronDown, ChevronUp } from 'lucide-react';
import axios from 'axios';
import { useToast } from './Toast';

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

  const [expandedCards, setExpandedCards] = useState({});

  const toggleCardExpanded = (key) => {
    setExpandedCards(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedMarketplace, setSelectedMarketplace] = useState(null);
  const [newIntegrationName, setNewIntegrationName] = useState('');
  const [creatingIntegration, setCreatingIntegration] = useState(false);
  const modalRef = useRef(null);

  useEffect(() => {
    fetchBlingAccounts();
    fetchBlingLogs();
    fetchBlingTokens();
    fetchMLAccounts();
    fetchShopeeAccounts();
  }, []);

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

  const fetchBlingLogs = async () => {
    try {
      const res = await axios.get('/api/bling/logs');
      setBlingLogs(res.data || res);
    } catch (e) {
      setBlingLogs('Erro ao carregar logs.');
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

  return (
    <div className="space-y-6">
      {/* Painel de status do Bling */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-4">
        <div className="flex items-center space-x-4 mb-4">
          <Link2 className="w-8 h-8 text-blue-600" />
          <div className="text-lg font-semibold text-gray-900">Integração Bling</div>
        </div>
        <div className="space-y-3">
          {blingAccounts.length === 0 && (
            <div className="text-sm text-gray-600">Nenhuma conta cadastrada.</div>
          )}
          {blingAccounts.map(acc => {
            const status = blingStatusByAccount[acc.id];
            const loading = blingLoadingByAccount[acc.id];
            const creds = blingCredsByAccount[acc.id] || {};
            const nameValue = blingNameByAccount[acc.id] ?? acc.name ?? '';
            return (
              <div key={acc.id} className="flex flex-col md:flex-row md:items-center md:justify-between bg-gray-50 rounded p-3">
                <div>
                  <div className="flex flex-col md:flex-row md:items-center gap-2">
                    <input
                      type="text"
                      className="border rounded px-2 py-1 text-sm"
                      placeholder="Nome da conta"
                      value={nameValue}
                      onChange={(e) => handleNameChange(acc.id, e.target.value)}
                    />
                    <button
                      className="btn-secondary text-xs"
                      onClick={() => handleSaveName(acc.id)}
                    >
                      Salvar nome
                    </button>
                  </div>
                  <div className="text-sm text-gray-600">
                    Status: {loading ? 'Verificando...' : status?.connected ? 'Conectado' : 'Desconectado'}
                  </div>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                    <input
                      type="text"
                      className="border rounded px-2 py-1 text-xs"
                      placeholder="client_id"
                      value={creds.client_id || ''}
                      onChange={(e) => handleCredChange(acc.id, 'client_id', e.target.value)}
                    />
                    <input
                      type="password"
                      className="border rounded px-2 py-1 text-xs"
                      placeholder={acc.has_client_secret ? 'client_secret (já configurado)' : 'client_secret'}
                      value={creds.client_secret || ''}
                      onChange={(e) => handleCredChange(acc.id, 'client_secret', e.target.value)}
                    />
                    <input
                      type="text"
                      className="border rounded px-2 py-1 text-xs"
                      placeholder="redirect_uri"
                      value={creds.redirect_uri || ''}
                      onChange={(e) => handleCredChange(acc.id, 'redirect_uri', e.target.value)}
                    />
                  </div>
                  <div className="mt-2">
                    <button
                      className="btn-secondary text-xs"
                      onClick={() => handleSaveCreds(acc.id)}
                    >
                      Salvar credenciais
                    </button>
                  </div>
                </div>
                <div className="mt-3 md:mt-0 flex items-center space-x-2">
                  <button
                    onClick={() => fetchBlingStatus(acc.id)}
                    className="btn-secondary flex items-center justify-center h-9 min-w-[120px]"
                    title="Atualizar status"
                  >
                    <RefreshCw className="w-4 h-4 mr-1" /> Atualizar
                  </button>
                  {status?.connected ? (
                    <>
                      <span className="inline-flex items-center justify-center px-3 h-9 min-w-[120px] rounded bg-green-100 text-green-800 border border-green-300 text-xs font-semibold">
                        <CheckCircle className="w-4 h-4 mr-1" /> Conectado
                      </span>
                      <button
                        onClick={() => handleDisconnectBling(acc.id)}
                        className="btn-secondary flex items-center justify-center h-9 min-w-[120px]"
                        title="Desconectar Bling"
                      >
                        Desconectar
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleConnectBling(acc.id)}
                      className="btn-primary flex items-center justify-center h-9 min-w-[120px]"
                      title="Conectar ao Bling"
                    >
                      <LogIn className="w-4 h-4 mr-1" /> Conectar Bling
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-col md:flex-row md:items-center gap-2">
          <input
            type="text"
            placeholder="Nome da nova conta (ex: Bling 2)"
            className="border rounded px-2 py-1 text-sm w-full md:w-80"
            value={newAccountName}
            onChange={(e) => setNewAccountName(e.target.value)}
          />
          <button className="btn-primary" onClick={handleCreateAccount}>Adicionar conta</button>
        </div>
      </div>
      {/* Console de logs do Bling */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-4">
        <div className="flex items-center mb-2">
          <span className="text-lg font-semibold text-gray-900 mr-2">Console da API Bling</span>
          <button onClick={fetchBlingLogs} className="btn-secondary flex items-center text-xs" title="Atualizar logs">
            <RefreshCw className="w-4 h-4 mr-1" /> Atualizar Logs
          </button>
        </div>
        <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto max-h-64" style={{ whiteSpace: 'pre-wrap' }}>{blingLogs || 'Sem logs.'}</pre>
      </div>

      {/* Informações dos Tokens */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-4">
        <div className="flex items-center mb-2">
          <span className="text-lg font-semibold text-gray-900 mr-2">Tokens Armazenados</span>
          <button onClick={fetchBlingTokens} className="btn-secondary flex items-center text-xs" title="Atualizar tokens">
            <RefreshCw className="w-4 h-4 mr-1" /> Atualizar
          </button>
          {blingTokens.length > 1 && (
            <button onClick={handleCleanTokens} className="btn-secondary flex items-center text-xs ml-2" title="Limpar tokens antigos">
              <span className="text-red-600">🗑️</span> Limpar Antigos
            </button>
          )}
        </div>
        <div className="text-sm text-gray-600 mb-2">
          Total de tokens: {blingTokens.length}
        </div>
        {blingTokens.length > 0 ? (
          <div className="space-y-2">
            {blingTokens.map((token, index) => (
              <div key={token.id} className="bg-gray-50 p-3 rounded text-xs">
                <div className="flex justify-between items-center">
                  <span className="font-semibold">Token #{token.id} {token.account_name ? `• ${token.account_name}` : ''}</span>
                  <span className="text-gray-500">
                    {new Date(token.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                  </span>
                </div>
                <div className="text-gray-600 mt-1">
                  Atualizado: {new Date(token.updated_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-gray-500 text-sm">Nenhum token encontrado no banco de dados.</div>
        )}
      </div>

      {/* ═══ Integrações com Marketplaces ═══ */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
        <div className="flex items-center space-x-4 mb-2">
          <Globe className="w-8 h-8 text-blue-500" />
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Marketplaces</h2>
          </div>
        </div>

        {mlAccounts.length === 0 && shopeeAccounts.length === 0 && (
          <div className="text-center py-8 text-gray-400 dark:text-gray-500">
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
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors flex items-center gap-2 font-medium shadow-sm"
          >
            <Plus className="w-5 h-5" /> Adicionar Nova Integração
          </button>
        </div>

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
    </div>
  );
}; 