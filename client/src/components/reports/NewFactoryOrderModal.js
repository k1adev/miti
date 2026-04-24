import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { X, Plus, Trash2, Search, Loader2, Package } from 'lucide-react';
import { useToast } from '../Toast';

/**
 * Modal de criação de lote de fábrica.
 * Props:
 *  - open: boolean
 *  - onClose
 *  - onCreated(orderId, code)
 *  - initialItems?: [{ inventory_id, sku, title, quantity }] — pré-preenche (vindo da tela Reposição)
 */
export const NewFactoryOrderModal = ({ open, onClose, onCreated, initialItems }) => {
  const toast = useToast();
  const [supplierName, setSupplierName] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSupplierName('');
      setExpectedDate('');
      setNotes('');
      if (Array.isArray(initialItems) && initialItems.length) {
        setItems(initialItems.map(it => ({
          _key: `${it.inventory_id}-${Math.random()}`,
          inventory_id: it.inventory_id,
          sku: it.sku,
          title: it.title,
          quantity: String(it.quantity || ''),
          notes: '',
        })));
      } else {
        setItems([]);
      }
    }
  }, [open, initialItems]);

  const addLine = (inv) => {
    setItems(prev => {
      const existing = prev.find(x => x.inventory_id === inv.id);
      if (existing) {
        return prev.map(x => x.inventory_id === inv.id ? { ...x, quantity: String((Number(x.quantity) || 0) + 1) } : x);
      }
      return [...prev, { _key: `${inv.id}-${Math.random()}`, inventory_id: inv.id, sku: inv.sku, title: inv.title, quantity: '1', notes: '' }];
    });
  };

  const updateLine = (key, patch) => {
    setItems(prev => prev.map(it => it._key === key ? { ...it, ...patch } : it));
  };

  const removeLine = (key) => {
    setItems(prev => prev.filter(it => it._key !== key));
  };

  const submit = async () => {
    const clean = items
      .map(it => ({ inventory_id: it.inventory_id, quantity: Math.floor(Number(it.quantity || 0)), notes: it.notes || null }))
      .filter(it => it.inventory_id && it.quantity > 0);
    if (!clean.length) {
      toast.error('Adicione ao menos um item com quantidade válida.');
      return;
    }
    setSaving(true);
    try {
      const res = await axios.post('/api/factory-orders', {
        supplier_name: supplierName.trim() || null,
        expected_date: expectedDate || null,
        notes: notes.trim() || null,
        items: clean,
      });
      toast.success(`Lote ${res.data.code} criado.`);
      onCreated && onCreated(res.data.id, res.data.code);
      onClose && onClose();
    } catch (e) {
      toast.error('Erro: ' + (e.response?.data?.error || e.message));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const totalPeças = items.reduce((a, it) => a + (Number(it.quantity) || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3 sm:p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">Novo Lote da Fábrica</h3>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Origem</label>
              <input
                type="text"
                value={supplierName}
                onChange={e => setSupplierName(e.target.value)}
                placeholder="Nome da origem"
                className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Previsão de entrega</label>
              <input
                type="date"
                value={expectedDate}
                onChange={e => setExpectedDate(e.target.value)}
                className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Observações</label>
              <input
                type="text"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Opcional"
                className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
          </div>

          <SkuPicker onPick={addLine} />

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <div className="bg-gray-50 dark:bg-gray-900/40 px-3 py-2 flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                Itens do lote ({items.length}) · Total: <span className="tabular-nums">{totalPeças}</span> peça(s)
              </span>
            </div>
            {items.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
                Nenhum item. Busque um SKU acima e clique para adicionar.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-gray-600 dark:text-gray-400">
                    <tr>
                      <th className="py-2 px-3">SKU</th>
                      <th className="py-2 px-3">Título</th>
                      <th className="py-2 px-3 text-right w-32">Quantidade</th>
                      <th className="py-2 px-3">Notas</th>
                      <th className="py-2 px-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => (
                      <tr key={it._key} className="border-t border-gray-100 dark:border-gray-700">
                        <td className="py-2 px-3 font-medium whitespace-nowrap">{it.sku}</td>
                        <td className="py-2 px-3 max-w-xs truncate text-gray-700 dark:text-gray-300" title={it.title}>{it.title}</td>
                        <td className="py-2 px-3 text-right">
                          <input
                            type="number"
                            min="1"
                            value={it.quantity}
                            onChange={e => updateLine(it._key, { quantity: e.target.value })}
                            className="w-24 px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-right tabular-nums"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={it.notes}
                            onChange={e => updateLine(it._key, { notes: e.target.value })}
                            placeholder="(opcional)"
                            className="w-full px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-xs"
                          />
                        </td>
                        <td className="py-2 px-3">
                          <button type="button" onClick={() => removeLine(it._key)} className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded">
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

        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancelar</button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || items.length === 0}
            className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Criar lote
          </button>
        </div>
      </div>
    </div>
  );
};

const SkuPicker = ({ onPick }) => {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const term = q.trim();
      if (term.length < 2) { setResults([]); return; }
      setLoading(true);
      try {
        const res = await axios.get('/api/inventory', { params: { search: term, limit: 15 } });
        const list = res.data?.items || res.data || [];
        setResults(Array.isArray(list) ? list.filter(i => !i.is_composite) : []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="relative" ref={boxRef}>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Adicionar item (SKU ou título)</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 z-10" />
        <input
          type="text"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Digite ao menos 2 caracteres"
          className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          style={{ paddingLeft: '2.25rem' }}
        />
        {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-gray-400" />}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg">
          {results.map(r => (
            <button
              type="button"
              key={r.id}
              onClick={() => { onPick(r); setQ(''); setResults([]); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-b-0"
            >
              <div className="font-medium text-gray-900 dark:text-white">{r.sku}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{r.title}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default NewFactoryOrderModal;
