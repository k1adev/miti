import React, { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import {
  MessageSquare, Send, Trash2, RefreshCw, Search, ExternalLink,
  Clock, CheckCircle, AlertCircle, XCircle, ChevronDown, ChevronUp,
  Link2, Eye, EyeOff, Filter, Zap, Star, Award, Store, Plus, Copy
} from 'lucide-react';
import axios from 'axios';
import { useToast } from './Toast';

const STATUS_CONFIG = {
  UNANSWERED: { label: 'Não respondida', color: 'bg-amber-50 text-amber-600', icon: Clock },
  ANSWERED: { label: 'Respondida', color: 'bg-emerald-50 text-emerald-600', icon: CheckCircle },
  BANNED: { label: 'Banida', color: 'bg-red-50 text-red-500', icon: XCircle },
  UNDER_REVIEW: { label: 'Em revisão', color: 'bg-blue-50 text-blue-500', icon: AlertCircle },
  CLOSED_UNANSWERED: { label: 'Fechada', color: 'bg-gray-100 text-gray-600', icon: XCircle },
  DELETED: { label: 'Deletada', color: 'bg-gray-50 text-gray-400', icon: Trash2 },
  DISABLED: { label: 'Desativada', color: 'bg-gray-50 text-gray-400', icon: EyeOff },
};

const MARKETPLACE_LOGOS = {
  mercadolivre: '/mercado-livre.png',
  shopee: '/shopee.png',
};

function httpsAssetUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url.startsWith('http://') ? 'https://' + url.slice(7) : url;
}

const LISTING_TYPE_MAP = {
  gold_pro: { label: 'Premium', color: 'bg-orange-50 text-orange-500 border-orange-100', icon: Star },
  gold_special: { label: 'Clássico', color: 'bg-blue-50 text-blue-500 border-blue-100', icon: Award },
  free: { label: 'Grátis', color: 'bg-gray-50 text-gray-500 border-gray-100', icon: null },
};

function getListingTypeBadge(listingTypeId) {
  const config = LISTING_TYPE_MAP[listingTypeId];
  if (!config) return null;
  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${config.color}`}>
      {Icon && <Icon size={9} />}
      {config.label}
    </span>
  );
}

function timeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now - date;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return date.toLocaleDateString('pt-BR');
}

function responseTimeBadge(question) {
  if (question.status !== 'ANSWERED' || !question.answer?.date_created || !question.date_created) return null;
  const asked = new Date(question.date_created);
  const answered = new Date(question.answer.date_created);
  const diffMs = answered - asked;
  if (diffMs < 0) return null;
  const mins = Math.floor(diffMs / 60000);
  let label, colorClass;
  if (mins < 60) {
    label = `${mins}min`;
    colorClass = mins <= 15 ? 'bg-emerald-50 text-emerald-600' : mins <= 30 ? 'bg-lime-50 text-lime-600' : 'bg-amber-50 text-amber-600';
  } else {
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    label = remMins > 0 ? `${hours}h${remMins}min` : `${hours}h`;
    colorClass = hours <= 1 ? 'bg-amber-50 text-amber-600' : 'bg-orange-50 text-orange-500';
  }
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${colorClass}`} title="Tempo de resposta">
      <Zap size={9} />
      {label}
    </span>
  );
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendDesktopNotification(title, body, icon) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, icon: icon || '/miti-logo.png', tag: 'ml-question', requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  }
}

function normalizeQuickReplyEntry(entry) {
  if (typeof entry === 'string') {
    const text = entry.trim();
    if (!text) return null;
    const title = text.length > 48 ? text.slice(0, 48) + '…' : text;
    return { title, text };
  }
  if (entry && typeof entry === 'object') {
    const text = String(entry.text ?? '').trim();
    if (!text) return null;
    let title = String(entry.title ?? '').trim();
    if (!title) title = text.length > 48 ? text.slice(0, 48) + '…' : text;
    return { title: title.slice(0, 80), text };
  }
  return null;
}

const QuickRepliesPanel = ({ onInsert, disabled }) => {
  const toast = useToast();
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchReplies = useCallback(async () => {
    try {
      const r = await axios.get('/api/user/quick-replies');
      const raw = r.data?.quickReplies || [];
      const list = Array.isArray(raw)
        ? raw.map(normalizeQuickReplyEntry).filter(Boolean)
        : [];
      setReplies(list);
    } catch { setReplies([]); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  const saveReplies = useCallback(async (updated) => {
    setSaving(true);
    try {
      await axios.put('/api/user/quick-replies', { quickReplies: updated });
      setReplies(updated);
      toast.success('Respostas rápidas atualizadas');
    } catch (e) {
      toast.error('Erro ao salvar: ' + (e.response?.data?.error || e.message));
    }
    setSaving(false);
  }, [toast]);

  const handleAdd = () => {
    const title = newTitle.trim();
    const text = newText.trim();
    if (!text) { toast.error('Preencha o texto da resposta'); return; }
    if (!title) { toast.error('Preencha o título do atalho'); return; }
    if (replies.length >= 50) { toast.error('Máximo de 50 respostas'); return; }
    saveReplies([...replies, { title: title.slice(0, 80), text }]);
    setNewTitle('');
    setNewText('');
  };

  const handleRemove = (idx) => {
    saveReplies(replies.filter((_, i) => i !== idx));
  };

  const handleUse = (text) => {
    if (!disabled && onInsert) onInsert(text);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex flex-col w-[min(100%,20rem)] min-w-[17rem] flex-shrink-0 self-stretch max-h-full min-h-0">
      <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50/50">
        <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
          <Copy size={14} className="text-blue-500/80" /> Respostas rápidas
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-2.5 min-h-0">
        {loading ? (
          <div className="py-6 text-center text-sm text-gray-400">Carregando...</div>
        ) : (
          <div className="space-y-2">
            {replies.map((item, i) => (
              <div key={i} className="group flex items-start gap-1.5">
                <button type="button" onClick={() => handleUse(item.text)} disabled={disabled}
                  className="flex-1 text-left bg-gray-50 hover:bg-blue-50 border border-gray-100 hover:border-blue-200 rounded-xl px-3 py-2.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[3.25rem]"
                  title={item.text}>
                  <span className="block text-sm font-semibold text-gray-900 line-clamp-2 leading-snug">{item.title}</span>
                  <span className="block text-xs text-gray-600 line-clamp-2 mt-1 leading-snug">{item.text.length > 72 ? item.text.slice(0, 72) + '…' : item.text}</span>
                </button>
                <button type="button" onClick={() => handleRemove(i)} className="p-1.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 self-start" title="Remover">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="p-2.5 border-t border-gray-100 space-y-2 bg-gray-50/30">
        <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)}
          placeholder="Título do atalho"
          className="w-full text-[13px] border border-gray-200 rounded-lg px-2.5 py-2 focus:ring-1 focus:ring-blue-400 focus:border-blue-300" />
        <div className="flex gap-1.5">
          <input type="text" value={newText} onChange={e => setNewText(e.target.value)}
            placeholder="Texto da resposta..."
            onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleAdd(); } }}
            className="flex-1 text-[13px] border border-gray-200 rounded-lg px-2.5 py-2 focus:ring-1 focus:ring-blue-400 focus:border-blue-300" />
          <button type="button" onClick={handleAdd} disabled={!newText.trim() || !newTitle.trim() || saving} className="p-2 bg-blue-500/80 hover:bg-blue-600 text-white rounded-lg disabled:opacity-40" title="Adicionar">
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

const AUTOCOMPLETE_DROPDOWN_W = 400;
const AUTOCOMPLETE_DROPDOWN_MAX_H = 320;

/** Posiciona o painel abaixo ou acima do cursor conforme espaço na viewport. */
function computeAutocompleteDropdownLayout(anchorTop, anchorLeft) {
  const GAP = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(GAP, Math.min(anchorLeft, vw - AUTOCOMPLETE_DROPDOWN_W - GAP));
  const spaceBelow = vh - anchorTop - GAP;
  const spaceAbove = anchorTop - GAP;
  const rawBelow = Math.max(0, spaceBelow);
  const rawAbove = Math.max(0, spaceAbove);
  if (rawBelow >= rawAbove) {
    const maxHeight = Math.min(AUTOCOMPLETE_DROPDOWN_MAX_H, rawBelow);
    return { top: anchorTop, left, maxHeight };
  }
  const maxHeight = Math.min(AUTOCOMPLETE_DROPDOWN_MAX_H, rawAbove);
  const top = Math.max(GAP, anchorTop - GAP - maxHeight);
  return { top, left, maxHeight };
}

const MarketplaceBadge = ({ marketplace, accountName }) => {
  const logo = MARKETPLACE_LOGOS[marketplace];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-[10px] text-gray-600 font-medium" title={accountName}>
      {logo ? (
        <img src={logo} alt={marketplace} className="w-3.5 h-3.5 object-contain" />
      ) : (
        <Store size={10} />
      )}
      <span className="truncate max-w-[80px]">{accountName}</span>
    </span>
  );
};

const AutocompleteTextarea = ({ value, onChange, onSend, placeholder, disabled, accountId }) => {
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hashStart, setHashStart] = useState(-1);
  const [hashQuery, setHashQuery] = useState('');
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, maxHeight: AUTOCOMPLETE_DROPDOWN_MAX_H });
  const searchTimeout = useRef(null);

  const getCaretCoordinates = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return { top: 0, left: 0 };
    const mirror = document.createElement('div');
    const computed = getComputedStyle(textarea);
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight',
      'padding', 'paddingTop', 'paddingLeft', 'paddingRight', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'width'];
    props.forEach(p => { mirror.style[p] = computed[p]; });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.overflow = 'hidden';
    mirror.style.height = 'auto';
    const textBefore = textarea.value.substring(0, textarea.selectionStart);
    const span = document.createElement('span');
    mirror.textContent = textBefore.replace(/\n/g, '\n');
    span.textContent = '|';
    mirror.appendChild(span);
    document.body.appendChild(mirror);
    const rect = textarea.getBoundingClientRect();
    const top = rect.top + span.offsetTop - textarea.scrollTop + 24;
    const left = rect.left + span.offsetLeft;
    document.body.removeChild(mirror);
    return { top: Math.min(top, rect.bottom), left: Math.min(left, rect.right - AUTOCOMPLETE_DROPDOWN_W) };
  }, []);

  const handleInput = useCallback((e) => {
    const val = e.target.value;
    onChange(val);
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const lastHashIdx = textBeforeCursor.lastIndexOf('#');
    if (lastHashIdx >= 0) {
      const textBetween = textBeforeCursor.substring(lastHashIdx + 1);
      if (!textBetween.includes(' ') || textBetween.trim().length > 0) {
        const query = textBetween.trim();
        if (query.length >= 2) {
          setHashStart(lastHashIdx);
          setHashQuery(query);
          const pos = getCaretCoordinates();
          setDropdownPos(computeAutocompleteDropdownLayout(pos.top, pos.left));
          setShowDropdown(true);
          if (searchTimeout.current) clearTimeout(searchTimeout.current);
          searchTimeout.current = setTimeout(async () => {
            setSearchLoading(true);
            try {
              let url = `/api/ml/items/search-autocomplete?q=${encodeURIComponent(query)}`;
              if (accountId) url += `&accountId=${accountId}`;
              const r = await axios.get(url);
              setSearchResults(r.data || []);
            } catch { setSearchResults([]); }
            setSearchLoading(false);
          }, 300);
          return;
        }
      }
    }
    setShowDropdown(false);
    setSearchResults([]);
  }, [onChange, getCaretCoordinates, accountId]);

  const selectItem = useCallback((item) => {
    const textarea = textareaRef.current;
    const currentVal = textarea.value;
    const cursorPos = textarea.selectionStart;
    const before = currentVal.substring(0, hashStart);
    const after = currentVal.substring(cursorPos);
    const link = item.permalink;
    const newVal = before + link + after;
    onChange(newVal);
    setShowDropdown(false);
    setSearchResults([]);
    setTimeout(() => {
      const newPos = before.length + link.length;
      textarea.selectionStart = newPos;
      textarea.selectionEnd = newPos;
      textarea.focus();
    }, 10);
  }, [hashStart, onChange]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape' && showDropdown) { e.preventDefault(); setShowDropdown(false); }
    if (e.key === 'Enter' && !e.shiftKey && !showDropdown) { e.preventDefault(); onSend(); }
  }, [showDropdown, onSend]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          textareaRef.current && !textareaRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useLayoutEffect(() => {
    if (!showDropdown) return;
    const update = () => {
      const pos = getCaretCoordinates();
      setDropdownPos(computeAutocompleteDropdownLayout(pos.top, pos.left));
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [showDropdown, getCaretCoordinates, value, hashQuery, searchLoading, searchResults.length]);

  return (
    <div className="relative">
      <textarea ref={textareaRef} value={value} onChange={handleInput} onKeyDown={handleKeyDown}
        placeholder={placeholder} disabled={disabled} rows={3}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none disabled:bg-gray-100" />
      {showDropdown && (
        <div ref={dropdownRef} className="fixed z-[9999] bg-white rounded-xl shadow-2xl border border-gray-200 w-[400px] overflow-y-auto"
          style={{ top: dropdownPos.top, left: dropdownPos.left, maxHeight: dropdownPos.maxHeight }}>
          <div className="sticky top-0 bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2">
            <Search size={14} className="text-gray-400" />
            <span className="text-xs text-gray-500">Buscando: <span className="font-semibold text-gray-700">{hashQuery}</span></span>
          </div>
          {searchLoading ? (
            <div className="flex items-center justify-center py-6">
              <RefreshCw size={16} className="animate-spin text-blue-500 mr-2" />
              <span className="text-sm text-gray-500">Buscando anúncios...</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-400">Nenhum anúncio encontrado</div>
          ) : (
            searchResults.map((item) => (
              <button key={item.ml_item_id} onClick={() => selectItem(item)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 transition-colors text-left border-b border-gray-50 last:border-0">
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-gray-200" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0"><Link2 size={14} className="text-gray-400" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-800 truncate">{item.title}</p>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    <span className="text-[10px] font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{item.ml_item_id}</span>
                    {item.sku && <span className="text-[10px] font-mono bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">SKU: {item.sku}</span>}
                    {item.listing_type_id && getListingTypeBadge(item.listing_type_id)}
                    {item.price && <span className="text-[10px] text-green-600 font-medium">R$ {Number(item.price).toFixed(2)}</span>}
                  </div>
                </div>
                <ExternalLink size={12} className="text-gray-300 flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const QuestionMiniCard = ({ question, selected, onClick }) => {
  return (
    <button onClick={onClick}
      className={`w-full text-left flex items-start gap-3.5 p-3.5 rounded-xl border transition-all ${
        selected ? 'border-blue-400 bg-blue-50 shadow-sm ring-1 ring-blue-100' : 'border-transparent hover:bg-gray-50'
      }`}>
      {question._item?.thumbnail ? (
        <img src={httpsAssetUrl(question._item.thumbnail)} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-gray-200 shadow-sm" />
      ) : (
        <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0"><MessageSquare size={22} className="text-gray-400" /></div>
      )}
      <div className="flex-1 min-w-0 py-0.5">
        <div className="flex items-start gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${question.status === 'UNANSWERED' ? 'bg-amber-400' : 'bg-emerald-500'}`} />
          {question._item?.permalink ? (
            <span
              role="link"
              onClick={(e) => { e.stopPropagation(); window.open(question._item.permalink, '_blank', 'noopener,noreferrer'); }}
              className="text-sm font-semibold text-blue-700 hover:underline line-clamp-2 text-left cursor-pointer leading-snug"
            >{question._item?.title || question.item_id}</span>
          ) : (
            <p className="text-sm font-semibold text-gray-800 line-clamp-2 leading-snug">{question._item?.title || question.item_id}</p>
          )}
        </div>
        {question._buyerNickname && (
          <p className="text-xs text-gray-600 truncate mt-1.5 font-medium">Comprador: {question._buyerNickname}</p>
        )}
        <p className="text-sm text-gray-600 line-clamp-2 mt-1.5 leading-snug">{question.text}</p>
      </div>
      <div className="flex flex-col items-end gap-1.5 flex-shrink-0 pt-0.5">
        <span className="text-xs font-medium text-gray-500 tabular-nums">{timeAgo(question.date_created)}</span>
        {question._marketplace && (
          <img src={MARKETPLACE_LOGOS[question._marketplace]} alt="" className="w-4 h-4 object-contain opacity-70" />
        )}
      </div>
    </button>
  );
};

const QuestionDetail = ({ question, answerText, setAnswerText, onAnswer, onDelete, answeringId }) => {
  const [sending, setSending] = useState(false);
  const st = STATUS_CONFIG[question.status] || STATUS_CONFIG.UNANSWERED;
  const StIcon = st.icon;
  const isAnswering = answeringId === question.id;

  const handleSend = async () => {
    if (!answerText.trim()) return;
    setSending(true);
    await onAnswer(question.id, answerText.trim(), question._accountId);
    setAnswerText('');
    setSending(false);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="p-4 sm:p-5 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-start gap-4">
          {question._item?.thumbnail ? (
            <img src={httpsAssetUrl(question._item.thumbnail)} alt="" className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-xl object-cover flex-shrink-0 border border-gray-200 shadow-sm" />
          ) : (
            <div className="w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0"><MessageSquare size={22} className="text-gray-400" /></div>
          )}
          <div className="flex-1 min-w-0">
            {question._item?.permalink ? (
              <a href={question._item.permalink} target="_blank" rel="noopener noreferrer"
                className="text-base font-semibold text-blue-700 hover:underline line-clamp-3 block leading-snug">{question._item?.title || `Item: ${question.item_id}`}</a>
            ) : (
              <p className="text-base font-semibold text-gray-800 line-clamp-3 leading-snug">{question._item?.title || `Item: ${question.item_id}`}</p>
            )}
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${st.color}`}>
                <StIcon size={10} />{st.label}
              </span>
              <MarketplaceBadge marketplace={question._marketplace} accountName={question._accountName} />
              {responseTimeBadge(question)}
              <span className="text-[10px] text-gray-400">{timeAgo(question.date_created)}</span>
            </div>
            {question._item?.sku && (
              <span className="text-[10px] font-mono bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded mt-1 inline-block">SKU: {question._item.sku}</span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {question._item?.permalink && (
              <a href={question._item.permalink} target="_blank" rel="noopener noreferrer"
                className="p-1.5 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-colors" title="Abrir anúncio">
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 min-h-0">
          <div className="bg-gray-50/90 rounded-xl p-4 border border-gray-100/80">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center">
              <MessageSquare size={16} className="text-blue-500/80" />
            </div>
            <span className="text-sm font-semibold text-gray-600">Pergunta do comprador</span>
            <span className="text-xs text-gray-400">{new Date(question.date_created).toLocaleString('pt-BR')}</span>
          </div>
          {question._buyerNickname && (
            <p className="text-sm text-gray-600 mb-2">Comprador: <span className="font-semibold">{question._buyerNickname}</span></p>
          )}
          <p className="text-base text-gray-800 leading-relaxed">{question.text || '(Texto não disponível)'}</p>
        </div>

        {question.answer && question.answer.text && (
          <div className="bg-emerald-50/70 rounded-xl p-4 border border-emerald-100/60">
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <div className="w-8 h-8 rounded-full bg-emerald-100/80 flex items-center justify-center">
                <CheckCircle size={16} className="text-emerald-500" />
              </div>
              <span className="text-sm font-semibold text-emerald-700">Sua resposta</span>
              <span className="text-xs text-gray-500">{new Date(question.answer.date_created).toLocaleString('pt-BR')}</span>
              {responseTimeBadge(question)}
            </div>
            <p className="text-base text-gray-800 leading-relaxed">{question.answer.text}</p>
          </div>
        )}
      </div>

      <div className="p-4 sm:p-5 border-t border-gray-100 flex-shrink-0 bg-white">
        {question.status === 'UNANSWERED' ? (
          <div>
            <AutocompleteTextarea value={answerText} onChange={setAnswerText} onSend={handleSend}
              placeholder="Digite sua resposta... Use # para buscar e inserir links de anúncios"
              disabled={sending || isAnswering} accountId={question._accountId} />
            <div className="flex items-center gap-2 mt-2">
              <button onClick={handleSend} disabled={!answerText.trim() || sending}
                className="flex items-center gap-2 bg-emerald-500/90 hover:bg-emerald-600/90 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {sending ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                Enviar Resposta
              </button>
              <button onClick={() => onDelete(question.id, question._accountId)}
                className="flex items-center gap-1.5 text-red-400 hover:text-red-500 hover:bg-red-50/60 px-3 py-2 rounded-lg text-sm transition-colors">
                <Trash2 size={14} />Excluir
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <button onClick={() => onDelete(question.id, question._accountId)}
              className="flex items-center gap-1.5 text-red-400 hover:text-red-500 hover:bg-red-50/50 px-3 py-1.5 rounded-lg text-xs transition-colors">
              <Trash2 size={12} />Excluir pergunta
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const QuestionCardCompact = ({ question, onAnswer, onDelete, answeringId }) => {
  const [expanded, setExpanded] = useState(question.status === 'UNANSWERED');
  const [answerText, setAnswerText] = useState('');
  const [sending, setSending] = useState(false);
  const st = STATUS_CONFIG[question.status] || STATUS_CONFIG.UNANSWERED;
  const StIcon = st.icon;
  const isAnswering = answeringId === question.id;

  const handleSend = async () => {
    if (!answerText.trim()) return;
    setSending(true);
    await onAnswer(question.id, answerText.trim(), question._accountId);
    setAnswerText('');
    setSending(false);
  };

  return (
    <div className={`bg-white rounded-xl border transition-all duration-200 ${
      question.status === 'UNANSWERED' ? 'border-amber-200/70 shadow-sm' : 'border-gray-200/80'
    }`}>
      <div className="flex items-start gap-2.5 p-3 cursor-pointer hover:bg-gray-50/50 transition-colors rounded-t-xl" onClick={() => setExpanded(!expanded)}>
        {question._item?.thumbnail ? (
          <img src={httpsAssetUrl(question._item.thumbnail)} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0 border border-gray-200" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0"><MessageSquare size={14} className="text-gray-400" /></div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${st.color}`}>
              <StIcon size={9} />{st.label}
            </span>
            <MarketplaceBadge marketplace={question._marketplace} accountName={question._accountName} />
            {responseTimeBadge(question)}
            <span className="text-[10px] text-gray-400">{timeAgo(question.date_created)}</span>
          </div>
          {question._item?.permalink ? (
            <a href={question._item.permalink} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              className="text-xs font-medium text-blue-700 hover:underline truncate block">{question._item?.title || `Item: ${question.item_id}`}</a>
          ) : (
            <p className="text-xs font-medium text-gray-700 truncate">{question._item?.title || `Item: ${question.item_id}`}</p>
          )}
          {question._buyerNickname && (
            <p className="text-[10px] text-gray-500 truncate">Comprador: {question._buyerNickname}</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{question.text}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {question._item?.permalink && (
            <a href={question._item.permalink} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
              className="p-1 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded transition-colors" title="Abrir anúncio">
              <ExternalLink size={12} />
            </a>
          )}
          {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-3 pb-3">
          <div className="mt-2 bg-gray-50 rounded-lg p-2.5">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-5 h-5 rounded-full bg-blue-50 flex items-center justify-center"><MessageSquare size={10} className="text-blue-500/80" /></div>
              <span className="text-[10px] font-semibold text-gray-500">Pergunta do comprador</span>
              <span className="text-[9px] text-gray-400">{new Date(question.date_created).toLocaleString('pt-BR')}</span>
            </div>
            {question._buyerNickname && (
              <p className="text-[10px] text-gray-600 mb-1">Comprador: <span className="font-medium">{question._buyerNickname}</span></p>
            )}
            <p className="text-xs text-gray-700 leading-relaxed">{question.text || '(Texto não disponível)'}</p>
          </div>

          {question.answer && question.answer.text && (
            <div className="mt-1.5 bg-emerald-50/50 rounded-lg p-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-5 h-5 rounded-full bg-emerald-100/50 flex items-center justify-center"><CheckCircle size={10} className="text-emerald-500" /></div>
                <span className="text-[10px] font-semibold text-emerald-600">Sua resposta</span>
                <span className="text-[9px] text-gray-400">{new Date(question.answer.date_created).toLocaleString('pt-BR')}</span>
                {responseTimeBadge(question)}
              </div>
              <p className="text-xs text-gray-700 leading-relaxed">{question.answer.text}</p>
            </div>
          )}

          {question.status === 'UNANSWERED' && (
            <div className="mt-2">
              <AutocompleteTextarea value={answerText} onChange={setAnswerText} onSend={handleSend}
                placeholder="Digite sua resposta... Use # para buscar e inserir links" disabled={sending || isAnswering} accountId={question._accountId} />
              <div className="flex items-center gap-2 mt-1.5">
                <button onClick={handleSend} disabled={!answerText.trim() || sending}
                  className="flex items-center gap-1.5 bg-emerald-500/90 hover:bg-emerald-600/90 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40">
                  {sending ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}Enviar
                </button>
                <button onClick={() => onDelete(question.id, question._accountId)}
                  className="flex items-center gap-1 text-red-400 hover:text-red-500 hover:bg-red-50/50 px-2.5 py-1.5 rounded-lg text-xs transition-colors">
                  <Trash2 size={12} />Excluir
                </button>
              </div>
            </div>
          )}

          {question.status === 'ANSWERED' && (
            <div className="mt-1.5 flex justify-end">
              <button onClick={() => onDelete(question.id, question._accountId)}
                className="flex items-center gap-1 text-red-400 hover:text-red-500 hover:bg-red-50/50 px-2.5 py-1 rounded-lg text-[10px] transition-colors">
                <Trash2 size={10} />Excluir
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const Atendimento = ({ user }) => {
  const toast = useToast();
  const [questions, setQuestions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [answeringId, setAnsweringId] = useState(null);
  const [showAnswered, setShowAnswered] = useState(true);
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [answerText, setAnswerText] = useState('');
  const [collapsedSections, setCollapsedSections] = useState({});
  const refreshInterval = useRef(null);
  const prevUnansweredIds = useRef(new Set());
  const isFirstLoad = useRef(true);

  useEffect(() => { requestNotificationPermission(); }, []);

  useEffect(() => { setAnswerText(''); }, [selectedQuestionId]);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    try {
      let url = '/api/ml/questions?limit=50';
      if (statusFilter) url += `&status=${statusFilter}`;
      if (accountFilter) url += `&accountId=${accountFilter}`;
      const r = await axios.get(url);
      const newQuestions = r.data?.questions || [];
      if (r.data?.accounts) setAccounts(r.data.accounts);

      if (!isFirstLoad.current) {
        const newUnanswered = newQuestions.filter(q => q.status === 'UNANSWERED' && !prevUnansweredIds.current.has(q.id));
        if (newUnanswered.length > 0) {
          newUnanswered.forEach(q => {
            const itemTitle = q._item?.title || q.item_id;
            toast.info(`Nova pergunta: "${(q.text || '').substring(0, 60)}..."`);
            sendDesktopNotification('Nova pergunta no Mercado Livre', `${itemTitle}\n${(q.text || '').substring(0, 100)}`, q._item?.thumbnail);
          });
        }
      }
      isFirstLoad.current = false;
      prevUnansweredIds.current = new Set(newQuestions.filter(q => q.status === 'UNANSWERED').map(q => q.id));
      setQuestions(newQuestions);
    } catch (e) {
      console.error('Erro ao buscar perguntas:', e);
    }
    setLoading(false);
  }, [statusFilter, accountFilter, toast]);

  useEffect(() => {
    fetchQuestions();
    refreshInterval.current = setInterval(fetchQuestions, 15000);
    return () => { if (refreshInterval.current) clearInterval(refreshInterval.current); };
  }, [fetchQuestions]);

  const handleAnswer = async (questionId, text, accountId) => {
    setAnsweringId(questionId);
    try {
      await axios.post(`/api/ml/questions/${questionId}/answer`, { text, accountId });
      toast.success('Resposta enviada com sucesso!');
      await fetchQuestions();
    } catch (e) {
      const st = e.response?.status;
      const d = e.response?.data;
      if (st === 409 && (d?.code === 'QUESTION_ALREADY_ANSWERED' || d?.error)) {
        toast.warning(d?.error || 'Esta pergunta já foi respondida ou não está mais disponível.');
        await fetchQuestions();
        setAnsweringId(null);
        return;
      }
      const extra = d?.details != null
        ? (typeof d.details === 'object' ? JSON.stringify(d.details) : String(d.details))
        : '';
      const hint = d?.hint ? `\n\n${d.hint}` : '';
      toast.error(`Erro ao enviar resposta: ${d?.error || e.message}${extra ? ` — ${extra}` : ''}${hint}`);
    }
    setAnsweringId(null);
  };

  const handleDelete = async (questionId, accountId) => {
    if (!window.confirm('Tem certeza que deseja excluir esta pergunta?')) return;
    try {
      await axios.delete(`/api/ml/questions/${questionId}?accountId=${accountId}`);
      toast.success('Pergunta excluída');
      setQuestions(prev => prev.filter(q => q.id !== questionId));
      if (selectedQuestionId === questionId) setSelectedQuestionId(null);
    } catch (e) {
      toast.error('Erro ao excluir: ' + (e.response?.data?.error || e.message));
    }
  };

  const toggleSection = (key) => setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const unansweredCount = questions.filter(q => q.status === 'UNANSWERED').length;
  const answeredCount = questions.filter(q => q.status === 'ANSWERED').length;

  const filteredQuestions = questions.filter(q => {
    if (!showAnswered && q.status === 'ANSWERED') return false;
    return true;
  });

  const unansweredQuestions = filteredQuestions.filter(q => q.status === 'UNANSWERED');
  const otherQuestions = filteredQuestions.filter(q => q.status !== 'UNANSWERED');
  const selectedQuestion = questions.find(q => q.id === selectedQuestionId);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <MessageSquare className="text-blue-500/80" size={22} />Atendimento
          </h1>
          {unansweredCount > 0 && (
            <span className="flex items-center gap-1.5 bg-amber-50/70 border border-amber-200/60 text-amber-600 px-2.5 py-1 rounded-lg text-xs font-semibold">
              <AlertCircle size={12} />{unansweredCount} pendente{unansweredCount > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span></span>
          <span className="text-[10px] text-gray-400">15s</span>
          <button onClick={fetchQuestions} disabled={loading}
            className="flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 px-2.5 py-1.5 rounded-lg text-xs transition-colors">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />Atualizar
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 mb-3 flex-wrap flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
          <Filter size={12} className="text-gray-400" />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="text-xs bg-transparent border-0 focus:ring-0 text-gray-700 pr-5">
            <option value="">Todos os status</option>
            <option value="UNANSWERED">Não respondidas</option>
            <option value="ANSWERED">Respondidas</option>
            <option value="UNDER_REVIEW">Em revisão</option>
          </select>
        </div>
        {accounts.length > 1 && (
          <div className="flex items-center gap-1.5 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
            <Store size={12} className="text-gray-400" />
            <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}
              className="text-xs bg-transparent border-0 focus:ring-0 text-gray-700 pr-5">
              <option value="">Todas as contas</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <button onClick={() => setShowAnswered(!showAnswered)}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border transition-colors ${
            showAnswered ? 'bg-emerald-50/60 border-emerald-200/60 text-emerald-600' : 'bg-white border-gray-200 text-gray-500'
          }`}>
          {showAnswered ? <Eye size={12} /> : <EyeOff size={12} />}Respondidas ({answeredCount})
        </button>
      </div>

      {/* Main Content - 2 columns on large screens */}
      {loading && questions.length === 0 ? (
        <div className="space-y-2 flex-1 min-h-0 overflow-auto">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-3 animate-pulse">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-lg bg-gray-200" />
                <div className="flex-1"><div className="h-3 bg-gray-200 rounded w-1/3 mb-1.5" /><div className="h-2.5 bg-gray-200 rounded w-2/3" /></div>
              </div>
            </div>
          ))}
        </div>
      ) : filteredQuestions.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-200 flex-1 flex flex-col justify-center min-h-[12rem]">
          <MessageSquare size={40} className="mx-auto text-gray-300 mb-3" />
          <h3 className="text-base font-medium text-gray-500">Nenhuma pergunta encontrada</h3>
          <p className="text-xs text-gray-400 mt-1">{statusFilter ? 'Tente outro filtro' : 'As perguntas dos seus anúncios aparecerão aqui'}</p>
        </div>
      ) : (
        <div className="flex gap-4 flex-1 min-h-0">
          {/* Left column - question list */}
          <div className="w-full lg:w-[min(100%,28rem)] lg:min-w-[22rem] lg:flex-shrink-0 overflow-y-auto space-y-2 pr-1">
            {unansweredQuestions.length > 0 && (
              <div>
                <button onClick={() => toggleSection('unanswered')}
                  className="w-full flex items-center gap-2 text-xs font-bold text-yellow-800 uppercase tracking-wide px-2 py-2 hover:bg-yellow-50 rounded-lg transition-colors">
                  {collapsedSections.unanswered ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  <Clock size={14} />Aguardando resposta ({unansweredQuestions.length})
                </button>
                {!collapsedSections.unanswered && (
                  <div className="space-y-2">
                    {/* Desktop: mini cards for split view */}
                    <div className="hidden lg:block space-y-1.5">
                      {unansweredQuestions.map(q => (
                        <QuestionMiniCard key={q.id} question={q} selected={selectedQuestionId === q.id}
                          onClick={() => setSelectedQuestionId(q.id)} />
                      ))}
                    </div>
                    {/* Mobile: full compact cards */}
                    <div className="lg:hidden space-y-1.5">
                      {unansweredQuestions.map(q => (
                        <QuestionCardCompact key={q.id} question={q} onAnswer={handleAnswer} onDelete={handleDelete} answeringId={answeringId} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {otherQuestions.length > 0 && (
              <div className={unansweredQuestions.length > 0 ? 'mt-3' : ''}>
                <button onClick={() => toggleSection('others')}
                  className="w-full flex items-center gap-2 text-xs font-bold text-gray-600 uppercase tracking-wide px-2 py-2 hover:bg-gray-50 rounded-lg transition-colors">
                  {collapsedSections.others ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                  <CheckCircle size={14} />Outras ({otherQuestions.length})
                </button>
                {!collapsedSections.others && (
                  <div className="space-y-2">
                    <div className="hidden lg:block space-y-1.5">
                      {otherQuestions.map(q => (
                        <QuestionMiniCard key={q.id} question={q} selected={selectedQuestionId === q.id}
                          onClick={() => setSelectedQuestionId(q.id)} />
                      ))}
                    </div>
                    <div className="lg:hidden space-y-1.5">
                      {otherQuestions.map(q => (
                        <QuestionCardCompact key={q.id} question={q} onAnswer={handleAnswer} onDelete={handleDelete} answeringId={answeringId} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right column - detail + respostas rápidas (desktop only) */}
          <div className="hidden lg:flex flex-1 min-w-0 min-h-0 gap-4">
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {selectedQuestion ? (
                <QuestionDetail key={selectedQuestion.id} question={selectedQuestion}
                  answerText={answerText} setAnswerText={setAnswerText}
                  onAnswer={handleAnswer} onDelete={handleDelete} answeringId={answeringId} />
              ) : (
                <div className="flex-1 min-h-[18rem] flex items-center justify-center bg-white rounded-xl border border-gray-200">
                  <div className="text-center px-6">
                    <MessageSquare size={40} className="mx-auto text-gray-300 mb-3" />
                    <p className="text-base text-gray-500 font-medium">Selecione uma pergunta para ver os detalhes</p>
                  </div>
                </div>
              )}
            </div>
            <QuickRepliesPanel
              onInsert={(text) => setAnswerText(prev => prev ? prev + '\n\n' + text : text)}
              disabled={!selectedQuestion || selectedQuestion?.status !== 'UNANSWERED' || answeringId === selectedQuestion?.id} />
          </div>
        </div>
      )}
    </div>
  );
};
