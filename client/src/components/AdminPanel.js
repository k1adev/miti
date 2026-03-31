import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Users, Shield, Clock, LogOut, Edit, Save, X, Key, CheckCircle, XCircle, Eye, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { useToast } from './Toast';

const ROLE_LABELS = {
  1: 'Nível 1 - Estoque',
  2: 'Nível 2 - Estoque e Vendas',
  3: 'Nível 3 - Quase tudo',
  4: 'Nível 4 - Administrador'
};

const ROLE_COLORS = {
  1: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  2: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  3: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  4: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
};

function timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min atrás`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h atrás`;
  return `${Math.floor(hrs / 24)}d atrás`;
}

export const AdminPanel = ({ user }) => {
  const toast = useToast();
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [actions, setActions] = useState([]);
  const [resetRequests, setResetRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [resetPasswordId, setResetPasswordId] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/users');
      setUsers(res.data || []);
    } catch { /* silently ignore */ }
  }, []);

  const fetchActions = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/user-actions?limit=200');
      setActions(res.data || []);
    } catch { /* silently ignore */ }
  }, []);

  const fetchResetRequests = useCallback(async () => {
    try {
      const res = await axios.get('/api/admin/password-reset-requests');
      setResetRequests(res.data || []);
    } catch { /* silently ignore */ }
  }, []);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchUsers(), fetchActions(), fetchResetRequests()]);
    setLoading(false);
  }, [fetchUsers, fetchActions, fetchResetRequests]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchAll, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, fetchAll]);

  const handleDisconnect = async (userId, userName) => {
    if (!window.confirm(`Desconectar ${userName}?`)) return;
    try {
      await axios.delete(`/api/admin/sessions/${userId}`);
      toast.success(`${userName} desconectado`);
      fetchUsers();
    } catch {
      toast.error('Erro ao desconectar usuário');
    }
  };

  const handleEditStart = (u) => {
    setEditingUser(u.id);
    setEditForm({ name: u.name, email: u.email, role: u.role, password: '' });
  };

  const handleEditSave = async () => {
    try {
      const payload = { name: editForm.name, email: editForm.email, role: editForm.role };
      if (editForm.password) payload.password = editForm.password;
      await axios.put(`/api/admin/users/${editingUser}`, payload);
      toast.success('Usuário atualizado');
      setEditingUser(null);
      fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erro ao atualizar');
    }
  };

  const handleResetResolve = async (id, status) => {
    try {
      const payload = { status };
      if (status === 'resolved' && newPassword) {
        payload.newPassword = newPassword;
      }
      await axios.put(`/api/admin/password-reset-requests/${id}`, payload);
      toast.success(status === 'resolved' ? 'Senha atualizada' : 'Solicitação rejeitada');
      setResetPasswordId(null);
      setNewPassword('');
      fetchResetRequests();
    } catch {
      toast.error('Erro ao processar solicitação');
    }
  };

  if (!user || user.role < 4) {
    return <div className="p-6 text-center text-red-600 font-bold">Acesso restrito a administradores.</div>;
  }

  const pendingResets = resetRequests.filter(r => r.status === 'pending');
  const onlineUsers = users.filter(u => u.online);

  const tabs = [
    { id: 'users', label: 'Usuários', icon: Users, badge: onlineUsers.length },
    { id: 'actions', label: 'Ações em Tempo Real', icon: Eye, badge: null },
    { id: 'resets', label: 'Solicitações de Senha', icon: Key, badge: pendingResets.length || null },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <Shield className="w-8 h-8 text-blue-600" />
            Painel Administrativo
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            {onlineUsers.length} usuário{onlineUsers.length !== 1 ? 's' : ''} online
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${autoRefresh ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}
          >
            <RefreshCw className={`w-4 h-4 ${autoRefresh ? 'animate-spin' : ''}`} style={autoRefresh ? { animationDuration: '3s' } : {}} />
            {autoRefresh ? 'Auto-refresh ON' : 'Auto-refresh OFF'}
          </button>
          <button onClick={fetchAll} className="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            <RefreshCw className="w-4 h-4 text-gray-600 dark:text-gray-300" />
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-600 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
            {t.badge > 0 && (
              <span className="ml-1 px-2 py-0.5 text-xs font-bold rounded-full bg-blue-600 text-white">{t.badge}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <>
          {tab === 'users' && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Status</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Usuário</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Nível</th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Última Atividade</th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {users.map(u => (
                      <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <span className={`w-3 h-3 rounded-full ${u.online ? 'bg-green-500 animate-pulse' : 'bg-gray-300 dark:bg-gray-600'}`} />
                            <span className="text-xs text-gray-500 dark:text-gray-400">{u.online ? 'Online' : 'Offline'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          {editingUser === u.id ? (
                            <div className="flex flex-col gap-2">
                              <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                                className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="Nome" />
                              <input value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })}
                                className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="Email" />
                              <input value={editForm.password} onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                                className="px-2 py-1 text-sm border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white" placeholder="Nova senha (opcional)" type="password" />
                            </div>
                          ) : (
                            <div>
                              <div className="text-sm font-medium text-gray-900 dark:text-white">{u.name}</div>
                              <div className="text-xs text-gray-500 dark:text-gray-400">{u.email}</div>
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          {editingUser === u.id ? (
                            <select value={editForm.role} onChange={e => setEditForm({ ...editForm, role: Number(e.target.value) })}
                              className="px-2 py-1 text-xs border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white">
                              {[1, 2, 3, 4].map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                            </select>
                          ) : (
                            <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${ROLE_COLORS[u.role] || ''}`}>
                              {ROLE_LABELS[u.role] || `Nível ${u.role}`}
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {u.online ? (
                              <div>
                                <div className="text-green-600 dark:text-green-400 font-medium">Ativo {timeAgo(u.lastActivity)}</div>
                                <div>Login: {timeAgo(u.loginTime)}</div>
                              </div>
                            ) : (
                              <span>Criado: {new Date(u.created_at).toLocaleDateString('pt-BR')}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            {editingUser === u.id ? (
                              <>
                                <button onClick={handleEditSave} className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900 dark:text-green-300" title="Salvar">
                                  <Save className="w-4 h-4" />
                                </button>
                                <button onClick={() => setEditingUser(null)} className="p-1.5 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300" title="Cancelar">
                                  <X className="w-4 h-4" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => handleEditStart(u)} className="p-1.5 rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300" title="Editar">
                                  <Edit className="w-4 h-4" />
                                </button>
                                {u.online && u.id !== user.id && (
                                  <button onClick={() => handleDisconnect(u.id, u.name)} className="p-1.5 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300" title="Desconectar">
                                    <LogOut className="w-4 h-4" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'actions' && (
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md overflow-hidden">
              <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  Ações recentes ({actions.length})
                </h3>
                <div className="flex items-center gap-2 text-xs text-gray-400">
                  <Clock className="w-3.5 h-3.5" />
                  Atualiza a cada 5s
                </div>
              </div>
              <div className="max-h-[600px] overflow-y-auto">
                {actions.length === 0 ? (
                  <div className="p-8 text-center text-gray-400">Nenhuma ação registrada</div>
                ) : (
                  <div className="divide-y divide-gray-100 dark:divide-gray-700/50">
                    {actions.map((a, i) => (
                      <div key={i} className="px-4 py-3 flex items-center gap-4 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center">
                          <span className="text-xs font-bold text-blue-700 dark:text-blue-300">{(a.userName || '?')[0].toUpperCase()}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-900 dark:text-white">
                            <span className="font-medium">{a.userName}</span>
                            {' '}
                            <span className="text-gray-500 dark:text-gray-400">{a.action}</span>
                          </div>
                          <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{a.details}</div>
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 whitespace-nowrap">
                          {timeAgo(a.timestamp)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'resets' && (
            <div className="space-y-4">
              {resetRequests.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-md p-8 text-center text-gray-400">
                  Nenhuma solicitação de reset de senha
                </div>
              ) : (
                resetRequests.map(r => (
                  <div key={r.id} className={`bg-white dark:bg-gray-800 rounded-xl shadow-md p-5 flex items-center justify-between gap-4 ${r.status === 'pending' ? 'border-l-4 border-yellow-500' : ''}`}>
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${r.status === 'pending' ? 'bg-yellow-100 dark:bg-yellow-900' : r.status === 'resolved' ? 'bg-green-100 dark:bg-green-900' : 'bg-gray-100 dark:bg-gray-700'}`}>
                        <Key className={`w-5 h-5 ${r.status === 'pending' ? 'text-yellow-600' : r.status === 'resolved' ? 'text-green-600' : 'text-gray-400'}`} />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-900 dark:text-white">{r.user_name}</div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{r.user_email}</div>
                        <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                          {new Date(r.created_at).toLocaleString('pt-BR')}
                          {r.status !== 'pending' && <span className="ml-2 font-medium text-gray-600 dark:text-gray-300">({r.status === 'resolved' ? 'Resolvido' : 'Rejeitado'})</span>}
                        </div>
                      </div>
                    </div>
                    {r.status === 'pending' && (
                      <div className="flex items-center gap-2">
                        {resetPasswordId === r.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              value={newPassword}
                              onChange={e => setNewPassword(e.target.value)}
                              placeholder="Nova senha"
                              className="px-3 py-1.5 text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                            />
                            <button
                              onClick={() => handleResetResolve(r.id, 'resolved')}
                              disabled={!newPassword}
                              className="p-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                              title="Definir nova senha"
                            >
                              <CheckCircle className="w-4 h-4" />
                            </button>
                            <button onClick={() => { setResetPasswordId(null); setNewPassword(''); }}
                              className="p-2 rounded-lg bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300">
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button onClick={() => setResetPasswordId(r.id)}
                              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                              Definir Senha
                            </button>
                            <button onClick={() => handleResetResolve(r.id, 'rejected')}
                              className="p-2 rounded-lg bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300" title="Rejeitar">
                              <XCircle className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
