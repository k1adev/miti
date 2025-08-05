import React, { useState, useEffect } from 'react';
import { Plus, Edit, Trash2, Package, DollarSign } from 'lucide-react';
import axios from 'axios';

export const Products = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ 
    name: '', 
    description: '', 
    price: '', 
    quantity: '' 
  });
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const response = await axios.get('/api/products');
      setProducts(response.data);
    } catch (error) {
      console.error('Erro ao carregar produtos:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      if (editingId) {
        // Implementar edição quando necessário
        console.log('Edição não implementada ainda');
      } else {
        await axios.post('/api/products', {
          ...formData,
          price: parseFloat(formData.price),
          quantity: parseInt(formData.quantity) || 0
        });
        setFormData({ name: '', description: '', price: '', quantity: '' });
        setShowForm(false);
        fetchProducts();
      }
    } catch (error) {
      console.error('Erro ao salvar produto:', error);
      alert('Erro ao salvar produto. Verifique os dados.');
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Tem certeza que deseja excluir este produto?')) {
      try {
        // Implementar exclusão quando necessário
        console.log('Exclusão não implementada ainda');
      } catch (error) {
        console.error('Erro ao excluir produto:', error);
      }
    }
  };

  const handleEdit = (product) => {
    setFormData({ 
      name: product.name, 
      description: product.description || '', 
      price: product.price.toString(), 
      quantity: product.quantity.toString() 
    });
    setEditingId(product.id);
    setShowForm(true);
  };

  const resetForm = () => {
    setFormData({ name: '', description: '', price: '', quantity: '' });
    setEditingId(null);
    setShowForm(false);
  };

  const formatPrice = (price) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(price);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-600 mt-2">Gerencie o catálogo de produtos</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="btn-primary flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Adicionar Produto
        </button>
      </div>

      {/* Formulário */}
      {showForm && (
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {editingId ? 'Editar Produto' : 'Adicionar Produto'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nome do Produto *
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
                  Preço *
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-gray-500">R$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    className="input-field pl-8"
                    required
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Descrição
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input-field"
                rows="3"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quantidade em Estoque
              </label>
              <input
                type="number"
                min="0"
                value={formData.quantity}
                onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
                className="input-field"
              />
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

      {/* Lista de Produtos */}
      <div className="bg-white rounded-lg shadow-md">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Catálogo de Produtos</h2>
        </div>
        
        {loading ? (
          <div className="p-6 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-600 mx-auto"></div>
            <p className="text-gray-600 mt-2">Carregando produtos...</p>
          </div>
        ) : products.length === 0 ? (
          <div className="p-6 text-center">
            <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">Nenhum produto encontrado</p>
            <button
              onClick={() => setShowForm(true)}
              className="btn-primary mt-4"
            >
              Adicionar Primeiro Produto
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Produto
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Preço
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estoque
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
                {products.map((product) => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                          <Package className="w-4 h-4 text-green-600" />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {product.name}
                          </div>
                          {product.description && (
                            <div className="text-sm text-gray-500">
                              {product.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <DollarSign className="w-4 h-4 text-green-600 mr-1" />
                        <span className="text-sm font-medium text-gray-900">
                          {formatPrice(product.price)}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        product.quantity > 10 
                          ? 'bg-green-100 text-green-800' 
                          : product.quantity > 0 
                          ? 'bg-yellow-100 text-yellow-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {product.quantity} unidades
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-500">
                        {new Date(product.created_at).toLocaleDateString('pt-BR')}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => handleEdit(product)}
                        className="text-blue-600 hover:text-blue-900 mr-3"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(product.id)}
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