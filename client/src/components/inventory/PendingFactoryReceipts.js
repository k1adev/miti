import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { PackageCheck, RefreshCw, Check, X, AlertTriangle, ClipboardCheck, Factory } from 'lucide-react';

/**
 * Painel de Entrada de Lote (fila de conferência).
 * Lista recebimentos declarados pela fábrica que ainda aguardam aceite da expedição.
 * Ao confirmar, o saldo é adicionado ao estoque; se houver divergência, registra observação.
 * Se rejeitar, nada é movimentado; a fábrica pode declarar novamente.
 */
const PendingFactoryReceipts = ({ onAfterChange }) => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [action, setAction] = useState(null); // { type: 'confirm'|'reject', receipt }
  const [qtyConfirmed, setQtyConfirmed] = useState('');
  const [divergenceNotes, setDivergenceNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true); else setLoading(true);
      setError('');
      const { data } = await axios.get('/api/factory-receipts/pending');
      setItems(Array.isArray(data?.receipts) ? data.receipts : []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Erro ao carregar fila de conferência.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData(false);
    const id = setInterval(() => fetchData(true), 45000); // auto refresh suave
    return () => clearInterval(id);
  }, [fetchData]);

  const openConfirm = (r) => {
    setAction({ type: 'confirm', receipt: r });
    setQtyConfirmed(String(r.quantity));
    setDivergenceNotes('');
  };
  const openReject = (r) => {
    setAction({ type: 'reject', receipt: r });
    setQtyConfirmed('');
    setDivergenceNotes('');
  };
  const closeModal = () => { setAction(null); setQtyConfirmed(''); setDivergenceNotes(''); };

  const declared = action?.receipt?.quantity ?? 0;
  const qtyNum = Number(qtyConfirmed);
  const hasDivergence = action?.type === 'confirm' && Number.isFinite(qtyNum) && qtyNum !== Number(declared);
  const canSubmit = useMemo(() => {
    if (!action) return false;
    if (action.type === 'reject') return !!divergenceNotes.trim();
    if (!Number.isFinite(qtyNum) || qtyNum < 0) return false;
    if (qtyNum > Number(declared)) return false;
    if (hasDivergence && !divergenceNotes.trim()) return false;
    return true;
  }, [action, qtyNum, declared, divergenceNotes, hasDivergence]);

  const submit = async () => {
    if (!action || !canSubmit) return;
    try {
      setSubmitting(true);
      setError('');
      if (action.type === 'confirm') {
        await axios.post(`/api/factory-receipts/${action.receipt.id}/confirm`, {
          quantity_confirmed: qtyNum,
          divergence_notes: divergenceNotes.trim() || null,
        });
      } else {
        await axios.post(`/api/factory-receipts/${action.receipt.id}/reject`, {
          divergence_notes: divergenceNotes.trim(),
        });
      }
      closeModal();
      await fetchData(true);
      if (typeof onAfterChange === 'function') onAfterChange();
    } catch (err) {
      setError(err?.response?.data?.error || 'Erro ao processar conferência.');
    } finally {
      setSubmitting(false);
    }
  };

  const formatDateTime = (s) => {
    if (!s) return '—';
    try {
      return new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    } catch { return s; }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <PackageCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Entrada de Lote</h2>
          {items.length > 0 && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[22px] h-[22px] text-xs font-semibold text-white bg-red-500 rounded-full px-1.5">
              {items.length}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fetchData(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          title="Atualizar"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
        Entregas declaradas pela fábrica aguardando conferência. Só entram no estoque após o aceite.
      </p>

      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 dark:bg-red-900/30 dark:border-red-800 dark:text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
          <ClipboardCheck className="w-8 h-8 mx-auto mb-2 text-gray-300 dark:text-gray-600" />
          Nenhuma entrega aguardando conferência.
        </div>
      ) : (
        <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
          {items.map(r => (
            <div
              key={r.id}
              className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 bg-gray-50 dark:bg-gray-900/40"
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span className="font-mono px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                      {r.factory_order_code}
                    </span>
                    {r.supplier_name && (
                      <span className="inline-flex items-center gap-1">
                        <Factory className="w-3 h-3" /> {r.supplier_name}
                      </span>
                    )}
                    <span>•</span>
                    <span>{formatDateTime(r.received_at)}</span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">
                    <span className="font-mono mr-2">{r.item_sku}</span>
                    <span className="font-normal text-gray-700 dark:text-gray-200">{r.item_title}</span>
                  </div>
                  <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                    Declarada: <strong className="text-gray-900 dark:text-white">{r.quantity}</strong>
                    <span className="mx-1.5 text-gray-300">|</span>
                    Item do lote: {r.quantity_received}/{r.quantity_ordered}
                    {r.received_by_name && (
                      <span className="ml-1.5 text-gray-400">por {r.received_by_name}</span>
                    )}
                  </div>
                  {r.notes && (
                    <div className="mt-1 text-xs italic text-gray-500 dark:text-gray-400">Obs. da fábrica: {r.notes}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => openConfirm(r)}
                    className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    <Check className="w-3.5 h-3.5" /> Conferir
                  </button>
                  <button
                    type="button"
                    onClick={() => openReject(r)}
                    className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/30"
                  >
                    <X className="w-3.5 h-3.5" /> Rejeitar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {action && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                {action.type === 'confirm' ? 'Conferir recebimento' : 'Rejeitar recebimento'}
              </h3>
              <button type="button" onClick={closeModal} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm text-gray-700 dark:text-gray-200">
                <div>
                  Lote <span className="font-mono font-semibold">{action.receipt.factory_order_code}</span>
                  {action.receipt.supplier_name && <> • {action.receipt.supplier_name}</>}
                </div>
                <div className="mt-0.5">
                  <span className="font-mono">{action.receipt.item_sku}</span> — {action.receipt.item_title}
                </div>
                <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  Declarado pela fábrica: <strong className="text-gray-900 dark:text-white">{action.receipt.quantity}</strong>
                </div>
              </div>

              {action.type === 'confirm' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Quantidade conferida</label>
                  <input
                    type="number"
                    min={0}
                    max={action.receipt.quantity}
                    value={qtyConfirmed}
                    onChange={e => setQtyConfirmed(e.target.value)}
                    className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                  {hasDivergence && (
                    <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Divergência de {Number(declared) - qtyNum > 0 ? 'faltam' : 'excedentes'}{' '}
                      {Math.abs(Number(declared) - qtyNum)} unidade(s). Justifique abaixo.
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  {action.type === 'reject' ? 'Motivo da rejeição *' : (hasDivergence ? 'Observação da divergência *' : 'Observação (opcional)')}
                </label>
                <textarea
                  rows={3}
                  value={divergenceNotes}
                  onChange={e => setDivergenceNotes(e.target.value)}
                  placeholder={action.type === 'reject' ? 'Ex.: mercadoria danificada, SKU errado…' : 'Ex.: 1 peça quebrada, faltou 1 unidade…'}
                  className="input-field text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 rounded-b-lg">
              <button type="button" onClick={closeModal} className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700">Cancelar</button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit || submitting}
                className={`px-3 py-1.5 text-sm rounded text-white disabled:opacity-50 disabled:cursor-not-allowed ${action.type === 'confirm' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {submitting ? 'Processando…' : (action.type === 'confirm' ? 'Confirmar entrada' : 'Rejeitar')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PendingFactoryReceipts;
