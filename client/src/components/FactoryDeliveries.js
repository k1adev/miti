import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Factory, LogOut, Loader2, RefreshCw, ChevronRight, PackageCheck } from 'lucide-react';
import { FactoryOrderDetail, StatusPill } from './FactoryOrderDetail';

const fmtDateShort = (iso) => {
  if (!iso) return '-';
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-BR');
};

/** Tela exclusiva para conta role=5 (Fábrica). Lista lotes em aberto / parciais e permite registrar entrega. */
export const FactoryDeliveries = ({ user, onLogout }) => {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/factory-orders', { params: { limit: 200 } });
      setOrders(res.data.orders || []);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const { abertos, parciais } = useMemo(() => {
    const a = []; const p = [];
    for (const o of orders) {
      if (o.status === 'partially_received') p.push(o);
      else if (o.status === 'open') a.push(o);
    }
    return { abertos: a, parciais: p };
  }, [orders]);

  const selected = orders.find(o => o.id === selectedId);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* Top bar */}
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center shrink-0">
              <Factory className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <div className="text-lg font-bold text-gray-900 dark:text-white truncate">Entregas da Fábrica</div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{user?.name || 'Fábrica'} · {user?.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} disabled={loading} className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
            </button>
            <button type="button" onClick={onLogout} className="btn-danger flex items-center gap-2 text-sm">
              <LogOut className="w-4 h-4" /> Sair
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6">
        {selected ? (
          <div>
            <button
              type="button"
              onClick={() => { setSelectedId(null); load(); }}
              className="mb-4 text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              ← Voltar para a lista
            </button>
            <FactoryOrderDetail
              orderId={selected.id}
              onChanged={load}
              variant="page"
            />
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                <PackageCheck className="w-4 h-4 text-amber-500" /> Entregas em andamento ({parciais.length})
              </h2>
              <OrdersList orders={parciais} loading={loading} onSelect={setSelectedId} emptyMsg="Sem lotes parcialmente recebidos." />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                Lotes em aberto ({abertos.length})
              </h2>
              <OrdersList orders={abertos} loading={loading} onSelect={setSelectedId} emptyMsg="Sem lotes em aberto." />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

const OrdersList = ({ orders, loading, onSelect, emptyMsg }) => {
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }
  if (!orders.length) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 text-center text-gray-500 dark:text-gray-400 text-sm">
        {emptyMsg}
      </div>
    );
  }
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden divide-y divide-gray-100 dark:divide-gray-700">
      {orders.map(o => {
        const ordered = Number(o.total_ordered) || 0;
        const received = Number(o.total_received) || 0;
        const awaiting = Number(o.total_awaiting) || 0;
        const pending = Math.max(0, ordered - received);
        const pct = ordered > 0 ? (received / ordered) * 100 : 0;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onSelect(o.id)}
            className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-gray-900 dark:text-white">{o.code}</span>
                <StatusPill status={o.status} />
                {awaiting > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                    {awaiting} aguardando conferência
                  </span>
                )}
                {o.supplier_name && <span className="text-xs text-gray-500 dark:text-gray-400">· {o.supplier_name}</span>}
              </div>
              <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 flex flex-wrap items-center gap-x-4 gap-y-0.5">
                <span>{o.items_count} item(ns)</span>
                <span className="tabular-nums">{received} / {ordered} conferidos</span>
                <span className="tabular-nums text-amber-600 dark:text-amber-400">{pending} pendente(s)</span>
                {o.expected_date && <span>Previsão {fmtDateShort(o.expected_date)}</span>}
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden max-w-lg">
                <div className="h-full bg-gradient-to-r from-blue-500 to-emerald-500" style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
          </button>
        );
      })}
    </div>
  );
};

export default FactoryDeliveries;
