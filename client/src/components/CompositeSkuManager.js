import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Package, Settings, AlertTriangle } from 'lucide-react';
import axios from 'axios';

// Função utilitária para limpar o 'B' do final do SKU
function limparSkuB(sku) {
  return typeof sku === 'string' ? sku.replace(/B$/, '') : sku;
}

export const CompositeSkuManager = ({ mainSku, onClose, onUpdate }) => {
  const [components, setComponents] = useState([]);
  const [availableItems, setAvailableItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newComponent, setNewComponent] = useState({
    component_sku_id: '',
    quantity: 1
  });

  useEffect(() => {
    fetchData();
  }, [mainSku?.id]);

  const fetchData = async () => {
    if (!mainSku?.id) return;
    
    try {
      const [componentsRes, itemsRes] = await Promise.all([
        axios.get(`/api/composite-skus/${mainSku.id}`),
        axios.get('/api/inventory')
      ]);
      
      setComponents(componentsRes.data);
      setAvailableItems(itemsRes.data.filter(item => item.id !== mainSku.id));
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddComponent = async (e) => {
    e.preventDefault();
    
    try {
      await axios.post('/api/composite-skus', {
        main_sku_id: mainSku.id,
        component_sku_id: newComponent.component_sku_id,
        quantity: newComponent.quantity
      });
      
      setNewComponent({ component_sku_id: '', quantity: 1 });
      setShowAddForm(false);
      fetchData();
      if (onUpdate) onUpdate();
    } catch (error) {
      console.error('Erro ao adicionar componente:', error);
      alert('Erro ao adicionar componente. Verifique os dados.');
    }
  };

  const handleRemoveComponent = async (componentId) => {
    if (window.confirm('Tem certeza que deseja remover este componente?')) {
      try {
        await axios.delete(`/api/composite-skus/${componentId}`);
        fetchData();
        if (onUpdate) onUpdate();
      } catch (error) {
        console.error('Erro ao remover componente:', error);
      }
    }
  };

  const getItemBySku = (sku) => {
    return availableItems.find(item => limparSkuB(item.sku) === limparSkuB(sku));
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">SKU Composto: {mainSku?.sku}</h2>
          <p className="text-sm text-gray-600">{mainSku?.title}</p>
        </div>
        <div className="flex items-center space-x-2">
          {mainSku?.id && (
            <button
              onClick={async () => {
                if (window.confirm('Tem certeza que deseja excluir este SKU composto/kit? Esta ação não pode ser desfeita.')) {
                  try {
                    await axios.delete(`/api/inventory/${mainSku.id}`);
                    if (onUpdate) onUpdate();
                    if (onClose) onClose();
                  } catch (error) {
                    alert('Erro ao excluir SKU.');
                  }
                }
              }}
              className="text-red-600 hover:text-red-800 border border-red-200 rounded px-2 py-1 text-xs font-semibold"
              title="Excluir SKU Composto/Kit"
            >
              <Trash2 className="w-4 h-4 inline mr-1" /> Excluir SKU
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl ml-2"
          >
            ×
          </button>
        </div>
      </div>

      {/* Formulário para adicionar componente */}
      {showAddForm && (
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <h3 className="font-medium text-gray-900 mb-3">Adicionar Componente</h3>
          <form onSubmit={handleAddComponent} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Componente
                </label>
                <select
                  value={newComponent.component_sku_id}
                  onChange={(e) => setNewComponent({ ...newComponent, component_sku_id: e.target.value })}
                  className="input-field"
                  required
                >
                  <option value="">Selecione um item</option>
                  {availableItems.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.sku} - {item.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Quantidade
                </label>
                <input
                  type="number"
                  min="1"
                  value={newComponent.quantity}
                  onChange={(e) => setNewComponent({ ...newComponent, quantity: parseInt(e.target.value) || 1 })}
                  className="input-field"
                  required
                />
              </div>
            </div>
            <div className="flex space-x-3">
              <button type="submit" className="btn-primary">
                Adicionar
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="btn-secondary"
              >
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Lista de componentes */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="font-medium text-gray-900">Componentes</h3>
          <button
            onClick={() => setShowAddForm(true)}
            className="btn-primary flex items-center text-sm"
          >
            <Plus className="w-4 h-4 mr-1" />
            Adicionar
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto"></div>
            <p className="text-gray-600 mt-2">Carregando...</p>
          </div>
        ) : components.length === 0 ? (
          <div className="text-center py-6">
            <Package className="w-8 h-8 text-gray-400 mx-auto mb-2" />
            <p className="text-gray-600">Nenhum componente adicionado</p>
            <button
              onClick={() => setShowAddForm(true)}
              className="btn-primary mt-2"
            >
              Adicionar Primeiro Componente
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {components.map((component) => (
              <div key={component.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div className="flex items-center">
                  <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                    <Package className="w-4 h-4 text-blue-600" />
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">
                      {component.component_sku} - {component.component_title}
                    </div>
                    <div className="text-sm text-gray-600">
                      Quantidade: {component.quantity} | Estoque: {component.component_quantity}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRemoveComponent(component.id)}
                  className="text-red-600 hover:text-red-800"
                  title="Remover componente"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Informações adicionais */}
      {components.length > 0 && (
        <div className="mt-6 p-4 bg-blue-50 rounded-lg">
          <h4 className="font-medium text-blue-900 mb-2 flex items-center">
            <Settings className="w-4 h-4 mr-2" />
            Informações do SKU Composto
          </h4>
          <div className="text-sm text-blue-800">
            <p>• Este SKU é composto por {components.length} componente(s)</p>
            <p>• Para montar este SKU, serão consumidos os componentes listados acima</p>
            <p>• O estoque disponível depende da quantidade dos componentes</p>
          </div>
        </div>
      )}
    </div>
  );
}; 