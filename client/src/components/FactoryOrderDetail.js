import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  X, Loader2, Package, Calendar, User, StickyNote, CheckCircle2, Clock, Ban,
  RefreshCw, History, PackageCheck
} from 'lucide-react';
import { useToast } from './Toast';

const STATUS_STYLES = {
  open: { label: 'Em aberto', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300', Icon: Clock },
  partially_received: { label: 'Parcial', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', Icon: PackageCheck },
  received: { label: 'Recebido', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300', Icon: CheckCircle2 },
  cancelled: { label: 'Cancelado', cls: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300', Icon: Ban },
};

export const StatusPill = ({ status }) => {
  const s = STATUS_STYLES[status] || STATUS_STYLES.open;
  const Icon = s.Icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${s.cls}`}>
      <Icon className="w-3 h-3" /> {s.label}
    </span>
  );
};

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const fmtDateShort = (iso) => {
  if (!iso) return '-';
  const s = String(iso);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return fmtDate(iso);
};

/**
 * Detalhe de um lote da fábrica. Usado tanto pelo staff (via drawer) quanto pela conta fábrica (tela cheia).
 * Props:
 *  - orderId: id do lote
 *  - onClose: fecha (opcional)
 *  - onChanged: callback após registrar entrega ou cancelar
 *  - canCancel: mostrar botão cancelar (role >= 4)
 *  - variant: 'modal' | 'page'
 */
export const FactoryOrderDetail = ({ orderId, onClose, onChanged, canCancel = false, variant = 'modal' }) => {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/factory-orders/${orderId}`);
      setData(res.data);
      setDrafts({});
    } catch (e) {
      toast.error('Erro ao carregar lote: ' + (e.response?.data?.error || e.message));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orderId, toast]);

  useEffect(() => { if (orderId) load(); }, [orderId, load]);

  const order = data?.order;
  const items = data?.items || [];
  const receipts = data?.receipts || [];

  const declaredPendingByItem = useMemo(() => {
    const map = new Map();
    for (const r of receipts) {
      if (r.status === 'pending') {
        map.set(r.factory_order_item_id, (map.get(r.factory_order_item_id) || 0) + Number(r.quantity || 0));
      }
    }
    return map;
  }, [receipts]);

  const totals = useMemo(() => {
    const ordered = items.reduce((a, i) => a + Number(i.quantity_ordered || 0), 0);
    const received = items.reduce((a, i) => a + Number(i.quantity_received || 0), 0);
    const awaiting = receipts.reduce((a, r) => a + (r.status === 'pending' ? Number(r.quantity || 0) : 0), 0);
    return {
      ordered,
      received,
      awaiting,
      pending: Math.max(0, ordered - received),
      pct: ordered > 0 ? (received / ordered) * 100 : 0,
    };
  }, [items, receipts]);

  const isClosed = order?.status === 'received' || order?.status === 'cancelled';

  const receivePending = useMemo(() => {
    return items
      .map(it => {
        const qty = Math.floor(Number(drafts[it.id] || 0));
        if (!Number.isFinite(qty) || qty <= 0) return null;
        return { item_id: it.id, quantity: qty };
      })
      .filter(Boolean);
  }, [drafts, items]);

  const submitReceipts = async () => {
    if (!receivePending.length) {
      toast.info('Informe ao menos uma quantidade > 0.');
      return;
    }
    setSaving(true);
    try {
      await axios.post(`/api/factory-orders/${orderId}/receipts`, { items: receivePending });
      toast.success('Entrega declarada! Aguardando conferência da expedição.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      toast.error('Erro: ' + (e.response?.data?.error || e.message));
    } finally {
      setSaving(false);
    }
  };

  const cancelOrder = async () => {
    if (!window.confirm(`Cancelar o lote ${order?.code}? Esta ação não pode ser desfeita.`)) return;
    setSaving(true);
    try {
      await axios.post(`/api/factory-orders/${orderId}/cancel`);
      toast.success('Lote cancelado.');
      await load();
      onChanged && onChanged();
    } catch (e) {
      toast.error('Erro: ' + (e.response?.data?.error || e.message));
    } finally {
      setSaving(false);
    }
  };

  const setDraft = (itemId, val) => {
    setDrafts(prev => ({ ...prev, [itemId]: val }));
  };

  const fillAll = () => {
    const next = {};
    for (const it of items) {
      const declared = declaredPendingByItem.get(it.id) || 0;
      const pend = Math.max(0, Number(it.quantity_ordered) - Number(it.quantity_received) - declared);
      if (pend > 0) next[it.id] = String(pend);
    }
    setDrafts(next);
  };

  const containerCls = variant === 'modal'
    ? 'bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] overflow-y-auto'
    : 'bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700';

  if (loading) {
    return (
      <div className={`${containerCls} p-8`}>
        <div className="flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className={`${containerCls} p-8 text-center text-gray-500`}>
        Lote não encontrado.
        {onClose && <div className="mt-4"><button className="btn-secondary" onClick={onClose}>Fechar</button></div>}
      </div>
    );
  }

  return (
    <div className={containerCls}>
      {/* Header */}
      <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-700">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Package className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">{order.code}</h3>
            <StatusPill status={order.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
            {order.supplier_name && <span className="inline-flex items-center gap-1"><User className="w-3 h-3" /> {order.supplier_name}</span>}
            {order.expected_date && <span className="inline-flex items-center gap-1"><Calendar className="w-3 h-3" /> Previsão: {fmtDateShort(order.expected_date)}</span>}
            <span>Criado em {fmtDate(order.created_at)}{order.created_by_name ? ` por ${order.created_by_name}` : ''}</span>
            {order.closed_at && <span>Fechado em {fmtDate(order.closed_at)}</span>}
          </div>
          {order.notes && (
            <div className="mt-2 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <StickyNote className="w-4 h-4 mt-0.5 shrink-0 text-gray-400" /> <span className="whitespace-pre-wrap">{order.notes}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
            onClick={load}
            title="Recarregar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress summary */}
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/30">
        <div className="flex flex-wrap items-end gap-4 justify-between">
          <div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Progresso (conferido)</div>
            <div className="text-2xl font-semibold text-gray-900 dark:text-white tabular-nums">
              {totals.received} <span className="text-gray-400 font-normal">/ {totals.ordered}</span>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {totals.pending} pendente(s)
              {totals.awaiting > 0 && <> • <span className="text-amber-600 dark:text-amber-400">{totals.awaiting} aguardando conferência</span></>}
            </div>
          </div>
          <div className="flex-1 min-w-[200px] max-w-xl">
            <div className="h-3 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden relative">
              {totals.awaiting > 0 && (
                <div
                  className="absolute inset-y-0 bg-amber-300/70 dark:bg-amber-400/30"
                  style={{
                    left: `${Math.min(100, totals.pct)}%`,
                    width: `${Math.min(100 - Math.min(100, totals.pct), (totals.awaiting / Math.max(1, totals.ordered)) * 100)}%`,
                  }}
                />
              )}
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all relative"
                style={{ width: `${Math.min(100, totals.pct)}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400 text-right tabular-nums">{totals.pct.toFixed(1)}%</div>
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Itens do lote ({items.length})</h4>
          {!isClosed && totals.pending > 0 && (
            <button type="button" onClick={fillAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
              Preencher tudo que falta
            </button>
          )}
        </div>
        <div className="overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400">
              <tr className="text-left">
                <th className="py-2 px-3">SKU</th>
                <th className="py-2 px-3">Título</th>
                <th className="py-2 px-3 text-right">Pedido</th>
                <th className="py-2 px-3 text-right">Recebido</th>
                <th className="py-2 px-3 text-right">Pendente</th>
                {!isClosed && <th className="py-2 px-3 text-right">Receber agora</th>}
              </tr>
            </thead>
            <tbody>
              {items.map(it => {
                const ordered = Number(it.quantity_ordered) || 0;
                const received = Number(it.quantity_received) || 0;
                const declared = declaredPendingByItem.get(it.id) || 0;
                const pending = Math.max(0, ordered - received);
                const declarable = Math.max(0, ordered - received - declared);
                const pct = ordered > 0 ? (received / ordered) * 100 : 0;
                const draft = drafts[it.id] || '';
                return (
                  <tr key={it.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="py-2 px-3 font-medium text-gray-900 dark:text-white whitespace-nowrap">{it.sku || it.inventory_sku}</td>
                    <td className="py-2 px-3 text-gray-700 dark:text-gray-300 max-w-xs truncate" title={it.title || it.inventory_title}>
                      {it.title || it.inventory_title || '-'}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{ordered}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      <div className="inline-flex flex-col items-end gap-0.5">
                        <span>{received}</span>
                        <div className="w-20 h-1 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div className={`h-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium text-gray-800 dark:text-gray-200">
                      {pending}
                      {declared > 0 && (
                        <div className="text-[10px] text-amber-600 dark:text-amber-400 font-normal" title="Declarado pela fábrica, aguardando conferência">
                          {declared} aguardando
                        </div>
                      )}
                    </td>
                    {!isClosed && (
                      <td className="py-2 px-3 text-right">
                        <input
                          type="number"
                          min="0"
                          max={declarable}
                          value={draft}
                          onChange={e => setDraft(it.id, e.target.value)}
                          disabled={declarable === 0}
                          placeholder={declarable === 0 ? '—' : String(declarable)}
                          className="w-24 px-2 py-1 text-right rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm tabular-nums disabled:opacity-50"
                          title={declarable === 0 ? (declared > 0 ? 'Todo o pendente já foi declarado e aguarda conferência' : 'Nada pendente') : undefined}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={isClosed ? 5 : 6} className="py-6 text-center text-gray-500">Sem itens no lote.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Action bar */}
      {!isClosed && (
        <div className="px-5 pb-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700 pt-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            {receivePending.length > 0
              ? <><strong>{receivePending.length}</strong> linha(s) prontas. <span className="text-amber-700 dark:text-amber-400">As quantidades só entram no estoque após a conferência da expedição.</span></>
              : 'Digite as quantidades entregues. O saldo entra no estoque apenas após conferência da expedição.'}
          </div>
          <div className="flex items-center gap-2">
            {canCancel && (
              <button type="button" onClick={cancelOrder} disabled={saving} className="btn-danger text-sm disabled:opacity-50">
                Cancelar lote
              </button>
            )}
            <button
              type="button"
              onClick={submitReceipts}
              disabled={saving || receivePending.length === 0}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
              Declarar entrega
            </button>
          </div>
        </div>
      )}

      {/* History */}
      <div className="px-5 pb-5">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
          onClick={() => setShowHistory(v => !v)}
        >
          <History className="w-4 h-4" />
          Histórico de recebimentos ({receipts.length})
          <span className="text-xs">{showHistory ? '▲' : '▼'}</span>
        </button>
        {showHistory && (
          <div className="mt-3 overflow-x-auto border border-gray-200 dark:border-gray-700 rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400">
                <tr className="text-left">
                  <th className="py-2 px-3">Data</th>
                  <th className="py-2 px-3">SKU</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3 text-right">Declarada</th>
                  <th className="py-2 px-3 text-right">Conferida</th>
                  <th className="py-2 px-3">Por</th>
                  <th className="py-2 px-3">Notas / Divergência</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => {
                  const declared = Number(r.quantity) || 0;
                  const confirmed = r.status === 'confirmed' ? Number(r.quantity_confirmed) || 0 : null;
                  const divergence = r.status === 'confirmed' && confirmed !== declared;
                  const statusMeta = r.status === 'confirmed'
                    ? { label: 'Conferido', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' }
                    : r.status === 'rejected'
                      ? { label: 'Rejeitado', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' }
                      : { label: 'Aguardando', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' };
                  return (
                    <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-2 px-3 whitespace-nowrap">
                        <div>{fmtDate(r.received_at)}</div>
                        {r.confirmed_at && r.status !== 'pending' && (
                          <div className="text-[10px] text-gray-500">Conf: {fmtDate(r.confirmed_at)}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 font-medium">{r.item_sku}</td>
                      <td className="py-2 px-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusMeta.cls}`}>
                          {statusMeta.label}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{declared}</td>
                      <td className={`py-2 px-3 text-right tabular-nums ${divergence ? 'text-amber-700 dark:text-amber-400 font-semibold' : ''}`}>
                        {r.status === 'pending' ? '—' : (confirmed ?? 0)}
                        {divergence && (
                          <div className="text-[10px] font-normal" title="Divergência">
                            {confirmed > declared ? '+' : ''}{confirmed - declared}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        <div>{r.received_by_name || '-'}</div>
                        {r.confirmed_by_name && r.status !== 'pending' && (
                          <div className="text-[10px] text-gray-500">{r.status === 'rejected' ? 'Rej.' : 'Conf.'}: {r.confirmed_by_name}</div>
                        )}
                      </td>
                      <td className="py-2 px-3 max-w-xs">
                        {r.notes && <div className="truncate" title={r.notes}>{r.notes}</div>}
                        {r.divergence_notes && (
                          <div className="truncate text-amber-700 dark:text-amber-400" title={r.divergence_notes}>
                            ⚠ {r.divergence_notes}
                          </div>
                        )}
                        {!r.notes && !r.divergence_notes && '-'}
                      </td>
                    </tr>
                  );
                })}
                {receipts.length === 0 && (
                  <tr><td colSpan={7} className="py-4 text-center text-gray-500">Nenhuma entrega registrada ainda.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default FactoryOrderDetail;
