import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { Search, X as XIcon, Loader2 } from 'lucide-react';

/**
 * Autocomplete com busca server-side em /api/inventory.
 * - `value` recebe o id do item de inventário (number|null)
 * - `onChange(id, item)` é disparado ao selecionar/limpar
 * - Evita carregar toda a base (limit 99999). Busca com debounce e só quando
 *   o usuário foca/digita.
 */
export function InventoryAutocomplete({
  value,
  onChange,
  placeholder,
  sizeHint = 'md',
  disabled,
  allowComposite = false,
  autoFocus = false,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [resolvingValue, setResolvingValue] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    if (!value) { setSelected(null); return; }
    if (selected && Number(selected.id) === Number(value)) return;
    setResolvingValue(true);
    (async () => {
      try {
        const r = await axios.get(`/api/inventory/${value}`);
        if (!cancelled) setSelected(r.data || null);
      } catch { if (!cancelled) setSelected(null); }
      finally { if (!cancelled) setResolvingValue(false); }
    })();
    return () => { cancelled = true; };
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await axios.get('/api/inventory', { params: { search: query || '', limit: 30 } });
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        setResults(allowComposite ? items : items.filter((i) => !i.is_composite));
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 180);
    return () => clearTimeout(id);
  }, [query, open, allowComposite]);

  useEffect(() => {
    const close = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    if (autoFocus && !selected && inputRef.current) {
      inputRef.current.focus();
      setOpen(true);
    }
  }, [autoFocus, selected]);

  const handleSelect = useCallback((item) => {
    setSelected(item);
    onChange?.(item?.id || null, item || null);
    setOpen(false);
    setQuery('');
  }, [onChange]);

  const handleClear = useCallback(() => {
    setSelected(null);
    onChange?.(null, null);
    setQuery('');
  }, [onChange]);

  const textSize = sizeHint === 'sm' ? 'text-xs' : 'text-sm';
  const padSize = sizeHint === 'sm' ? 'py-1 px-2' : 'py-1.5 px-2';

  if (selected) {
    return (
      <div ref={containerRef} className={`flex items-center justify-between gap-2 ${padSize} rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 ${textSize}`}>
        <div className="min-w-0 flex items-center gap-2 flex-1">
          <span className="font-mono font-semibold text-emerald-800 dark:text-emerald-300 shrink-0">{selected.sku}</span>
          <span className="text-gray-700 dark:text-gray-300 truncate">{selected.title}</span>
          <span className="ml-auto text-[10px] font-mono text-emerald-700 dark:text-emerald-300 shrink-0">Qtd: {selected.quantity ?? 0}</span>
        </div>
        <button type="button" disabled={disabled} onClick={handleClear} className="p-1 rounded text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 shrink-0" title="Remover vínculo">
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          placeholder={placeholder || 'Buscar SKU, título ou EAN…'}
          disabled={disabled || resolvingValue}
          className={`w-full pl-7 pr-8 ${padSize} rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${textSize}`}
        />
        {resolvingValue && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 animate-spin" />}
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl">
          {loading ? (
            <div className="px-3 py-2 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Buscando…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500">Nenhum resultado</div>
          ) : results.map((item) => (
            <button key={item.id} type="button" onClick={() => handleSelect(item)}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-b border-gray-100 dark:border-gray-700/50 flex items-center justify-between gap-2">
              <div className="min-w-0 flex items-center gap-2">
                <span className="font-mono font-semibold text-gray-900 dark:text-white text-xs shrink-0">{item.sku}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.title}</span>
              </div>
              <span className="text-[10px] font-mono text-gray-500 whitespace-nowrap shrink-0">Qtd: {item.quantity ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default InventoryAutocomplete;
