import React, { useState, useEffect } from 'react';
import { Activity, Server, Database, Globe, Clock, Wifi, Cpu, HardDrive } from 'lucide-react';
import axios from 'axios';

export const Status = () => {
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

  useEffect(() => {
    fetchStatus();
    fetchSystemInfo();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
      fetchSystemInfo();
      fetchLogs();
    }, 30000); // Atualiza a cada 30 segundos
    return () => clearInterval(interval);
  }, []);

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
      const res = await axios.get('/api/logs');
      setLogs(res.data.logs || []);
    } catch (err) {
      setLogs(['[ERRO] Não foi possível carregar os logs']);
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
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Logs do Sistema</h2>
        <div className="bg-gray-900 text-green-400 p-4 rounded-lg font-mono text-sm overflow-auto max-h-64">
          {loading ? (
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-400 mr-2"></div>
              Carregando logs...
            </div>
          ) : (
            logs.length > 0 ? logs.map((line, idx) => (
              <div key={idx}>{line}</div>
            )) : <div className="text-red-400">Nenhum log encontrado</div>
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
          <button className="btn-secondary flex items-center">
            <Server className="w-4 h-4 mr-2" />
            Reiniciar Servidor
          </button>
        </div>
      </div>
    </div>
  );
}; 