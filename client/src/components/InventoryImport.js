import React, { useState } from 'react';
import { Upload, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import axios from 'axios';

export const InventoryImport = ({ onImportComplete, onClose }) => {
  const [csvData, setCsvData] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleImport = async (e) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    
    try {
      const response = await axios.post('/api/inventory/import/csv', { csvData });
      setResult({
        success: true,
        imported: response.data.imported,
        errors: response.data.errors,
        errorDetails: response.data.errorDetails
      });
      
      if (onImportComplete) {
        onImportComplete();
      }
    } catch (error) {
      console.error('Erro na importação:', error);
      setResult({
        success: false,
        error: error.response?.data?.error || 'Erro na importação'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setCsvData(event.target.result);
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Importar Estoque</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600"
        >
          ×
        </button>
      </div>

      <div className="mb-4 p-4 bg-blue-50 rounded-lg">
        <h3 className="font-medium text-blue-900 mb-2 flex items-center">
          <FileText className="w-4 h-4 mr-2" />
          Formato do CSV:
        </h3>
        <p className="text-sm text-blue-800">
          SKU,EAN,Título,Quantidade,Localização,Quantidade Mínima,Quantidade Máxima,Categoria,Fornecedor,Preço de Custo,Preço de Venda,Observações
        </p>
        <p className="text-xs text-blue-600 mt-2">
          <strong>Obrigatórios:</strong> SKU, Título
        </p>
      </div>

      <form onSubmit={handleImport} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Upload de arquivo CSV
          </label>
          <input
            type="file"
            accept=".csv"
            onChange={handleFileUpload}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Ou cole os dados CSV aqui:
          </label>
          <textarea
            value={csvData}
            onChange={(e) => setCsvData(e.target.value)}
            className="input-field"
            rows="10"
            placeholder="Cole aqui os dados do CSV..."
            required
          />
        </div>

        {result && (
          <div className={`p-4 rounded-lg ${
            result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
          }`}>
            <div className="flex items-center">
              {result.success ? (
                <CheckCircle className="w-5 h-5 text-green-600 mr-2" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-600 mr-2" />
              )}
              <div>
                {result.success ? (
                  <div>
                    <p className="text-green-800 font-medium">
                      Importação concluída com sucesso!
                    </p>
                    <p className="text-green-700 text-sm">
                      Importados: {result.imported} | Erros: {result.errors}
                    </p>
                    {result.errorDetails && result.errorDetails.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-green-700 text-sm cursor-pointer">
                          Ver detalhes dos erros
                        </summary>
                        <ul className="mt-1 text-xs text-green-600">
                          {result.errorDetails.map((error, index) => (
                            <li key={index}>{error}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ) : (
                  <p className="text-red-800">{result.error}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex space-x-3">
          <button 
            type="submit" 
            className="btn-primary flex items-center"
            disabled={loading}
          >
            <Upload className="w-4 h-4 mr-2" />
            {loading ? 'Importando...' : 'Importar'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}; 