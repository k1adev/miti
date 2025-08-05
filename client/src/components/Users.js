import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, User } from 'lucide-react';
import axios from 'axios';

export const Users = ({ user }) => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', password: '', role: 1 });
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      const response = await axios.get('/api/users');
      setUsers(response.data);
    } catch (error) {
      console.error('Erro ao carregar usuários:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingId) {
        // Implementar edição quando necessário
        await axios.put(`/api/users/${editingId}`, formData);
        setFormData({ name: '', email: '', password: '', role: 1 });
        setEditingId(null);
        setShowForm(false);
        fetchUsers();
      } else {
        await axios.post('/api/users', formData);
        setFormData({ name: '', email: '', password: '', role: 1 });
        setShowForm(false);
        fetchUsers();
      }
    } catch (error) {
      console.error('Erro ao salvar usuário:', error);
      alert('Erro ao salvar usuário. Verifique os dados.');
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Tem certeza que deseja excluir este usuário?')) {
      try {
        const res = await axios.delete(`/api/users/${id}`);
        if (res.data && res.data.success) {
          fetchUsers();
        } else if (res.data && res.data.error) {
          alert(res.data.error);
        }
      } catch (error) {
        alert(error.response?.data?.error || 'Erro ao excluir usuário.');
      }
    }
  };

  const handleEdit = (user) => {
    setFormData({ name: user.name, email: user.email, password: '', role: user.role });
    setEditingId(user.id);
    setShowForm(true);
  };

  const resetForm = () => {
    setFormData({ name: '', email: '', password: '', role: 1 });
    setEditingId(null);
    setShowForm(false);
  };

  if (!user || user.role !== 4) {
    return <div className="p-6 text-center text-red-600 font-bold">Acesso restrito. Apenas administradores podem acessar esta página.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Usuários</h1>
          <p className="text-gray-600 mt-2">Gerencie os usuários do sistema</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="btn-primary flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Adicionar Usuário
        </button>
      </div>

      {/* Formulário */}
      {showForm && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {editingId ? 'Editar Usuário' : 'Adicionar Usuário'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Nome
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input-field"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="input-field"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Senha
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                className="input-field"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Nível
              </label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: Number(e.target.value) })}
                className="input-field"
                required
              >
                <option value={1}>Nível 1 - Estoque</option>
                <option value={2}>Nível 2 - Estoque e Vendas</option>
                <option value={3}>Nível 3 - Quase tudo</option>
                <option value={4}>Nível 4 - Administrador</option>
              </select>
            </div>
            <div className="flex space-x-3">
              <button type="submit" className="btn-primary">
                {editingId ? 'Atualizar' : 'Salvar'}
              </button>
              <button
                type="button"
                onClick={resetForm}
                className="btn-secondary"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de Usuários */}
      <div className="bg-white rounded-lg shadow-md">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Lista de Usuários</h2>
        </div>
        
        {loading ? (
          <div className="p-6 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-gray-600 mt-2">Carregando usuários...</p>
          </div>
        ) : users.length === 0 ? (
          <div className="p-6 text-center">
            <User className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">Nenhum usuário encontrado</p>
            <button
              onClick={() => setShowForm(true)}
              className="btn-primary mt-4"
            >
              Adicionar Primeiro Usuário
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Nome
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Nível
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Data de Criação
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Ações
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                          <User className="w-4 h-4 text-blue-600" />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {user.name}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{user.email}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-500">
                        Nível {user.role}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-500">
                        {new Date(user.created_at).toLocaleDateString('pt-BR')}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEdit(user)}
                        className="text-blue-600 hover:text-blue-900 mr-3"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(user.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}; 