import React, { useState, useEffect, useRef } from 'react';
import { Activity, Server, Database, Globe, Clock, Wifi, Cpu, HardDrive, RefreshCw, Filter } from 'lucide-react';
import axios from 'axios';
import { useToast } from './Toast';

export const Status = () => {
  const toast = useToast();
  const [status, setStatus] = useState({
    server: 'offline',
    database: 'offline',
    timestamp: null,
    uptime: null
  });
  const [loading, setLoading] = useState(true);
  const [systemInfo, setSystemInfo] = useState({
    platform: '',
    nodeVersion: '',
    totalMem: '',
    freeMem: '',
    cpu: ''
  });
  const [logs, setLogs] = useState([]);
  const [logMeta, setLogMeta] = useState({ total: 0, serverUptime: 0 });
  const [logFilter, setLogFilter] = useState('ALL');
  const [logCategoryFilter, setLogCategoryFilter] = useState('ALL');
  const [logAutoRefresh, setLogAutoRefresh] = useState(true);
  const [logLimit, setLogLimit] = useState(100);
  const [mktPersisted, setMktPersisted] = useState([]);
  const [mktPersistedLoading, setMktPersistedLoading] = useState(false);
  const logEndRef = useRef(null);

  useEffect(() => {
    fetchStatus();
    fetchSystemInfo();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
      fetchSystemInfo();
      if (logAutoRefresh) fetchLogs();
    }, 10000);
    return () => clearInterval(interval);
  }, [logAutoRefresh, logFilter, logCategoryFilter, logLimit]);

  const fetchStatus = async () => {
    try {
      const response = await axios.get('/api/status');
      setStatus({
        server: response.data.status,
        database: response.data.database,
        timestamp: response.data.timestamp,
        uptime: response.data.uptime
      });
    } catch (error) {
      setStatus({
        server: 'offline',
        database: 'offline',
        timestamp: null,
        uptime: null
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchSystemInfo = async () => {
    try {
      const res = await axios.get('/api/system-info');
      setSystemInfo(res.data);
    } catch (err) {
      setSystemInfo({
        platform: 'Desconhecido',
        nodeVersion: '',
        totalMem: '',
        freeMem: '',
        cpu: ''
      });
    }
  };

  const fetchLogs = async () => {
    try {
      const params = { limit: logLimit };
      if (logFilter !== 'ALL') params.level = logFilter;
      if (logCategoryFilter !== 'ALL') params.category = logCategoryFilter;
      const res = await axios.get('/api/logs', { params });
      const data = res.data;
      if (Array.isArray(data.logs)) {
        setLogs(data.logs);
        setLogMeta({ total: data.total || 0, serverUptime: data.serverUptime || 0 });
      } else if (Array.isArray(data)) {
        setLogs(data.map(l => typeof l === 'string' ? { timestamp: '', level: 'INFO', category: 'SYSTEM', message: l } : l));
      }
    } catch (err) {
      setLogs([{ timestamp: new Date().toISOString(), level: 'ERROR', category: 'SYSTEM', message: 'Não foi possível carregar os logs' }]);
    }
  };

  const loadMktPersisted = async () => {
    setMktPersistedLoading(true);
    try {
      const res = await axios.get('/api/admin/marketplace-connection-log', { params: { limit: 200 } });
      setMktPersisted(res.data.logs || []);
    } catch (e) {
      toast.error('Não foi possível carregar o histórico persistido (permissões ou rede).');
      setMktPersisted([]);
    } finally {
      setMktPersistedLoading(false);
    }
  };

  const StatusCard = ({ title, status, icon: Icon, color, description }) => (
    <div className="bg-white rounded-lg shadow-md p-6 card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          <div className={`p-3 rounded-full ${color} mr-4`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-600">{description}</p>
          </div>
        </div>
        <div className={`flex items-center px-3 py-1 rounded-full text-sm font-medium ${
          status === 'online' || status === 'connected'
            ? 'bg-green-100 text-green-800' 
            : 'bg-red-100 text-red-800'
        }`}>
          <div className={`w-2 h-2 rounded-full mr-2 ${
            status === 'online' || status === 'connected' ? 'bg-green-500' : 'bg-red-500'
          }`}></div>
          {status === 'online' || status === 'connected' ? 'Online' : 'Offline'}
        </div>
      </div>
    </div>
  );

  const formatUptime = (seconds) => {
    if (!seconds) return '---';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  };

  const LEVEL_COLORS = {
    ERROR: 'text-red-400',
    WARN: 'text-yellow-400',
    INFO: 'text-green-400',
    DEBUG: 'text-gray-500',
  };

  const CATEGORY_COLORS = {
    HTTP: 'text-cyan-400',
    AUTH: 'text-purple-400',
    DB: 'text-blue-400',
    BLING: 'text-orange-400',
    ESTOQUE: 'text-emerald-400',
    EXPEDIÇÃO: 'text-pink-400',
    SERVER: 'text-indigo-400',
    SYSTEM: 'text-gray-400',
    API: 'text-teal-400',
    MARKETPLACE: 'text-amber-400',
  };

  const LogLine = ({ log }) => {
    if (typeof log === 'string') {
      return <div className="text-green-400 py-0.5 leading-snug">{log}</div>;
    }
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('pt-BR', { hour12: false }) : '';
    const levelColor = LEVEL_COLORS[log.level] || 'text-gray-400';
    const catColor = CATEGORY_COLORS[log.category] || 'text-gray-500';
    return (
      <div className={`py-0.5 leading-snug flex gap-2 ${log.level === 'ERROR' ? 'bg-red-900/20' : log.level === 'WARN' ? 'bg-yellow-900/10' : ''}`}>
        <span className="text-gray-600 flex-shrink-0">{time}</span>
        <span className={`font-bold flex-shrink-0 w-12 ${levelColor}`}>{log.level}</span>
        <span className={`flex-shrink-0 w-20 ${catColor}`}>[{log.category}]</span>
        <span className="text-gray-200 break-all">{log.message}</span>
        {log.data != null && typeof log.data === 'object' && (
          <div className="text-[10px] text-gray-500 break-all pl-0 sm:pl-28 mt-0.5 font-mono opacity-90 w-full">
            {JSON.stringify(log.data)}
          </div>
        )}
      </div>
    );
  };

  const InfoCard = ({ title, value, icon: Icon, color }) => (
    <div className="bg-white rounded-lg shadow-md p-6 card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
        </div>
        <div className={`p-3 rounded-full ${color}`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Status do Sistema</h1>
        <p className="text-gray-600 mt-2">Monitoramento em tempo real da aplicação</p>
      </div>

      {/* Status Principal */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <StatusCard
          title="Servidor"
          status={status.server}
          icon={Server}
          color="bg-blue-500"
          description="Servidor Express.js"
        />
        <StatusCard
          title="Banco de Dados"
          status={status.database}
          icon={Database}
          color="bg-green-500"
          description="SQLite Database"
        />
      </div>

      {/* Informações do Sistema */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Informações do Sistema</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <InfoCard
            title="Plataforma"
            value={systemInfo.platform}
            icon={Cpu}
            color="bg-purple-500"
          />
          <InfoCard
            title="Node.js"
            value={systemInfo.nodeVersion}
            icon={Activity}
            color="bg-green-500"
          />
          <InfoCard
            title="Memória Total"
            value={systemInfo.totalMem}
            icon={HardDrive}
            color="bg-blue-500"
          />
          <InfoCard
            title="Memória Livre"
            value={systemInfo.freeMem}
            icon={HardDrive}
            color="bg-blue-300"
          />
          <InfoCard
            title="Processador"
            value={systemInfo.cpu}
            icon={Cpu}
            color="bg-orange-500"
          />
        </div>
      </div>

      {/* Detalhes de Conectividade */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Conectividade</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center">
              <Wifi className="w-5 h-5 text-blue-600 mr-3" />
              <div>
                <p className="font-medium text-gray-900">Acesso Local</p>
                <p className="text-sm text-gray-600">Acessível na rede local</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium text-gray-900">localhost:3001</p>
              <p className="text-sm text-gray-600">Porta padrão</p>
            </div>
          </div>
          
          <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
            <div className="flex items-center">
              <Globe className="w-5 h-5 text-green-600 mr-3" />
              <div>
                <p className="font-medium text-gray-900">CORS</p>
                <p className="text-sm text-gray-600">Cross-Origin Resource Sharing</p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium text-green-600">Habilitado</p>
              <p className="text-sm text-gray-600">Rede local</p>
            </div>
          </div>

          {status.timestamp && (
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center">
                <Clock className="w-5 h-5 text-purple-600 mr-3" />
                <div>
                  <p className="font-medium text-gray-900">Última Verificação</p>
                  <p className="text-sm text-gray-600">Status atualizado</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-medium text-gray-900">
                  {new Date(status.timestamp).toLocaleTimeString('pt-BR')}
                </p>
                <p className="text-sm text-gray-600">
                  {new Date(status.timestamp).toLocaleDateString('pt-BR')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Logs do Sistema */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Logs do Sistema</h2>
            <p className="text-xs text-gray-500 mt-1">
              {logMeta.total} logs no buffer | Uptime: {formatUptime(logMeta.serverUptime)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={logFilter}
              onChange={(e) => { setLogFilter(e.target.value); }}
              className="text-xs border rounded px-2 py-1 bg-white"
            >
              <option value="ALL">Todos níveis</option>
              <option value="ERROR">Erros</option>
              <option value="WARN">Avisos</option>
              <option value="INFO">Info</option>
            </select>
            <select
              value={logCategoryFilter}
              onChange={(e) => setLogCategoryFilter(e.target.value)}
              className="text-xs border rounded px-2 py-1 bg-white max-w-[140px]"
              title="Filtrar por categoria"
            >
              <option value="ALL">Todas categorias</option>
              <option value="MARKETPLACE">Marketplaces</option>
            </select>
            <select
              value={logLimit}
              onChange={(e) => setLogLimit(parseInt(e.target.value))}
              className="text-xs border rounded px-2 py-1 bg-white"
            >
              <option value={50}>50 linhas</option>
              <option value={100}>100 linhas</option>
              <option value={200}>200 linhas</option>
              <option value={500}>Tudo</option>
            </select>
            <button
              onClick={() => setLogAutoRefresh(!logAutoRefresh)}
              className={`text-xs px-2 py-1 rounded border ${logAutoRefresh ? 'bg-green-100 text-green-700 border-green-300' : 'bg-gray-100 text-gray-600 border-gray-300'}`}
              title={logAutoRefresh ? 'Auto-refresh ligado' : 'Auto-refresh desligado'}
            >
              <RefreshCw className={`w-3 h-3 inline mr-1 ${logAutoRefresh ? 'animate-spin' : ''}`} style={logAutoRefresh ? { animationDuration: '3s' } : {}} />
              Auto
            </button>
            <button
              onClick={fetchLogs}
              className="text-xs px-2 py-1 rounded border bg-blue-50 text-blue-700 border-blue-300 hover:bg-blue-100"
            >
              Atualizar
            </button>
          </div>
        </div>
        <div className="bg-gray-900 rounded-lg font-mono text-xs overflow-auto max-h-96 p-3">
          {loading && logs.length === 0 ? (
            <div className="flex items-center text-green-400">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-400 mr-2"></div>
              Carregando logs...
            </div>
          ) : logs.length > 0 ? (
            <>
              {logs.map((log, idx) => (
                <LogLine key={idx} log={log} />
              ))}
              <div ref={logEndRef} />
            </>
          ) : (
            <div className="text-gray-500">Nenhum log encontrado</div>
          )}
        </div>
      </div>

      {/* Histórico persistido: conexão marketplaces (sobrevive restart do processo) */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Histórico de conexão (marketplaces)</h2>
            <p className="text-xs text-gray-500 mt-1">
              Eventos gravados no banco: refresh falho, token ausente, 401 após retry, invalid_grant, etc.
            </p>
          </div>
          <button
            type="button"
            onClick={loadMktPersisted}
            disabled={mktPersistedLoading}
            className="text-xs px-3 py-1.5 rounded border bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100 disabled:opacity-50"
          >
            {mktPersistedLoading ? 'Carregando…' : 'Carregar histórico'}
          </button>
        </div>
        <div className="bg-gray-900 rounded-lg font-mono text-[11px] overflow-auto max-h-72 p-3 text-gray-200">
          {mktPersisted.length === 0 ? (
            <span className="text-gray-500">Clique em &quot;Carregar histórico&quot; para ver os últimos registros (admin).</span>
          ) : (
            mktPersisted.map((row) => (
              <div key={row.id} className="border-b border-gray-800 py-1.5 last:border-0">
                <div>
                  <span className="text-gray-500">{row.created_at}</span>{' '}
                  <span className={row.level === 'ERROR' ? 'text-red-400' : row.level === 'WARN' ? 'text-yellow-400' : 'text-green-400'}>{row.level}</span>{' '}
                  <span className="text-amber-400">[{row.provider}]</span>{' '}
                  <span className="text-cyan-300">{row.event}</span>
                  {row.account_id != null && <span className="text-gray-400"> conta={row.account_id}</span>}
                </div>
                {row.detail != null && (
                  <pre className="text-gray-500 whitespace-pre-wrap break-all mt-0.5 pl-0">
                    {typeof row.detail === 'object' ? JSON.stringify(row.detail, null, 0) : String(row.detail)}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Ações */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Ações</h2>
        <div className="flex space-x-4">
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="btn-primary flex items-center"
          >
            <Activity className="w-4 h-4 mr-2" />
            {loading ? 'Verificando...' : 'Verificar Status'}
          </button>
          <button className="btn-secondary flex items-center">
            <Database className="w-4 h-4 mr-2" />
            Backup do Banco
          </button>
          <button
            className="btn-secondary flex items-center"
            onClick={async () => {
              try {
                const token = localStorage.getItem('token');
                if (!token) {
                  toast.error('Você precisa estar logado para executar esta ação.');
                  return;
                }
                if (!window.confirm('Tem certeza que deseja reiniciar o servidor agora?')) return;
                await axios.post('/api/admin/restart', {}, { headers: { Authorization: `Bearer ${token}` } });
                toast.success('Servidor será reiniciado em instantes. Aguarde alguns segundos e recarregue a página.');
              } catch (e) {
                toast.error('Falha ao solicitar reinício. Verifique suas permissões ou tente novamente.');
              }
            }}
          >
            <Server className="w-4 h-4 mr-2" />
            Reiniciar Servidor
          </button>
        </div>
      </div>
    </div>
  );
}; 