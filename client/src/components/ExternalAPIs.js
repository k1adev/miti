import React, { useState, useEffect } from 'react';
import { RefreshCw, CheckCircle, LogIn, Link2 } from 'lucide-react';
import axios from 'axios';

export const ExternalAPIs = () => {
  const [blingStatus, setBlingStatus] = useState({ connected: false });
  const [blingLoading, setBlingLoading] = useState(true);
  const [blingLogs, setBlingLogs] = useState('');
  const [blingTokens, setBlingTokens] = useState([]);

  useEffect(() => {
    fetchBlingStatus();
    fetchBlingLogs();
    fetchBlingTokens();
  }, []);

  const fetchBlingStatus = async () => {
    setBlingLoading(true);
    try {
      const res = await axios.get('/api/bling/status');
      setBlingStatus(res.data);
    } catch (e) {
      setBlingStatus({ connected: false });
    } finally {
      setBlingLoading(false);
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

  const handleConnectBling = async () => {
    try {
      const res = await axios.get('/api/bling/auth');
      if (res.data && res.data.url) {
        window.open(res.data.url, '_blank');
      }
    } catch (e) {
      alert('Erro ao gerar link de autorização do Bling.');
    }
  };

  const handleCleanTokens = async () => {
    try {
      await axios.delete('/api/bling/tokens');
      fetchBlingTokens();
      alert('Tokens antigos removidos com sucesso!');
    } catch (e) {
      alert('Erro ao limpar tokens antigos.');
    }
  };

  return (
    <div className="space-y-6">
      {/* Painel de status do Bling */}
      <div className="bg-white rounded-lg shadow-md p-6 mb-4 flex flex-col md:flex-row md:items-center md:justify-between">
        <div className="flex items-center space-x-4">
          <Link2 className="w-8 h-8 text-blue-600" />
          <div>
            <div className="text-lg font-semibold text-gray-900">Integração Bling</div>
            <div className="text-sm text-gray-600">
              Status: {blingLoading ? 'Verificando...' : blingStatus.connected ? 'Conectado' : 'Desconectado'}
            </div>
          </div>
        </div>
        <div className="mt-4 md:mt-0 flex items-center space-x-2">
          <button
            onClick={fetchBlingStatus}
            className="btn-secondary flex items-center"
            title="Atualizar status"
          >
            <RefreshCw className="w-4 h-4 mr-1" /> Atualizar
          </button>
          {blingStatus.connected ? (
            <span className="inline-flex items-center px-3 py-1 rounded bg-green-100 text-green-800 border border-green-300 text-xs font-semibold">
              <CheckCircle className="w-4 h-4 mr-1" /> Conectado
            </span>
          ) : (
            <button
              onClick={handleConnectBling}
              className="btn-primary flex items-center"
              title="Conectar ao Bling"
            >
              <LogIn className="w-4 h-4 mr-1" /> Conectar Bling
            </button>
          )}
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
                  <span className="font-semibold">Token #{token.id}</span>
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
    </div>
  );
}; 