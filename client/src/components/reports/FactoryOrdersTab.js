import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Plus, RefreshCw, Search, Loader2, Package } from 'lucide-react';
import { FactoryOrderDetail, StatusPill } from '../FactoryOrderDetail';
import { NewFactoryOrderModal } from './NewFactoryOrderModal';

const STATUS_OPTS = [
  { value: '', label: 'Todos' },
  { value: 'open,partially_received', label: 'Em andamento' },
  { value: 'open', label: 'Em aberto' },
  { value: 'partially_received', label: 'Parcial' },
  { value: 'received', label: 'Recebido' },
  { value: 'cancelled', label: 'Cancelado' },
];

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-BR');
};

/**
 * Aba "Lotes da Fábrica" dentro de SalesReportPage (role >= 2).
 * Props:
 *  - user: { role }
 *  - initialCreate?: { items: [...] } — se presente, já abre o modal de criação pré-preenchido (vindo da aba Reposição)
 *  - onCreateConsumed?: callback após consumir a solicitação de criação (limpa o trigger no pai)
 */
export const FactoryOrdersTab = ({ user, initialCreate, onCreateConsumed }) => {
  const role = Number(user?.role || 0);
  const canCreate = role >= 3;
  const canCancel = role >= 4;

  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('open,partially_received');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createInitialItems, setCreateInitialItems] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 200 };
      if (status) params.status = status;
      if (q.trim()) params.q = q.trim();
      const res = await axios.get('/api/factory-orders', { params });
      setOrders(res.data.orders || []);
      setTotal(res.data.total || 0);
    } catch {
      setOrders([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (initialCreate && Array.isArray(initialCreate.items) && initialCreate.items.length > 0 && canCreate) {
      setCreateInitialItems(initialCreate.items);
      setShowCreate(true);
      onCreateConsumed && onCreateConsumed();
    }
  }, [initialCreate, canCreate, onCreateConsumed]);

  const summary = useMemo(() => {
    const counts = { open: 0, partially_received: 0, received: 0, cancelled: 0 };
    for (const o of orders) if (counts[o.status] !== undefined) counts[o.status]++;
    return counts;
  }, [orders]);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Em aberto" value={summary.open} color="blue" />
        <SummaryCard label="Parciais" value={summary.partially_received} color="amber" />
        <SummaryCard label="Recebidos" value={summary.received} color="emerald" />
        <SummaryCard label="Cancelados" value={summary.cancelled} color="gray" />
      </div>

      {/* Filter bar */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Buscar</label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Código do lote ou nome da fábrica"
              className="input-field text-sm !pl-9 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)} className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white">
            {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <button type="button" onClick={load} disabled={loading} className="btn-secondary text-sm flex items-center gap-2 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
        {canCreate && (
          <button type="button" onClick={() => { setCreateInitialItems(null); setShowCreate(true); }} className="btn-primary text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> Novo lote
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {loading && orders.length === 0 ? (
          <div className="p-12 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center text-gray-500 dark:text-gray-400 text-sm">
            <Package className="w-10 h-10 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
            Nenhum lote encontrado com os filtros atuais.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400">
                <tr className="text-left">
                  <th className="py-2 px-3">Código</th>
                  <th className="py-2 px-3">Fábrica</th>
                  <th className="py-2 px-3">Criado</th>
                  <th className="py-2 px-3">Previsão</th>
                  <th className="py-2 px-3">Itens</th>
                  <th className="py-2 px-3 w-64">Progresso</th>
                  <th className="py-2 px-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const ordered = Number(o.total_ordered) || 0;
                  const received = Number(o.total_received) || 0;
                  const awaiting = Number(o.total_awaiting) || 0;
                  const pct = ordered > 0 ? (received / ordered) * 100 : 0;
                  const awaitingPct = ordered > 0 ? (awaiting / ordered) * 100 : 0;
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className="border-t border-gray-100 dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40"
                    >
                      <td className="py-2 px-3 font-semibold text-gray-900 dark:text-white whitespace-nowrap">
                        {o.code}
                        {awaiting > 0 && (
                          <span
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                            title={`${awaiting} peça(s) aguardando conferência`}
                          >
                            {awaiting} aguard.
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-gray-700 dark:text-gray-300">{o.supplier_name || '-'}</td>
                      <td className="py-2 px-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                      <td className="py-2 px-3 text-gray-600 dark:text-gray-400 whitespace-nowrap">{fmtDate(o.expected_date)}</td>
                      <td className="py-2 px-3 tabular-nums">{o.items_count}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden min-w-[80px] relative">
                            {awaitingPct > 0 && (
                              <div
                                className="absolute inset-y-0 bg-amber-300/70"
                                style={{
                                  left: `${Math.min(100, pct)}%`,
                                  width: `${Math.min(100 - Math.min(100, pct), awaitingPct)}%`,
                                }}
                              />
                            )}
                            <div className={`h-full relative ${pct >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, pct)}%` }} />
                          </div>
                          <span className="text-xs tabular-nums text-gray-600 dark:text-gray-400 shrink-0">{received}/{ordered}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3"><StatusPill status={o.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > orders.length && (
          <div className="p-3 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 text-center">
            Exibindo {orders.length} de {total} lotes. Refine os filtros para ver mais.
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selectedId != null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-40 p-3 sm:p-4">
          <FactoryOrderDetail
            orderId={selectedId}
            onClose={() => setSelectedId(null)}
            onChanged={load}
            canCancel={canCancel}
            variant="modal"
          />
        </div>
      )}

      {/* Create modal */}
      <NewFactoryOrderModal
        open={showCreate}
        onClose={() => { setShowCreate(false); setCreateInitialItems(null); }}
        onCreated={(id) => { load(); setSelectedId(id); }}
        initialItems={createInitialItems}
      />
    </div>
  );
};

const SummaryCard = ({ label, value, color }) => {
  const colorMap = {
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-100 dark:border-blue-900/50',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-100 dark:border-amber-900/50',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-emerald-100 dark:border-emerald-900/50',
    gray: 'bg-gray-50 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300 border-gray-200 dark:border-gray-700',
  };
  return (
    <div className={`rounded-xl border p-3 ${colorMap[color] || colorMap.gray}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
};

export default FactoryOrdersTab;
