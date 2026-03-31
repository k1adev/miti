import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, X, Send, RefreshCw, ExternalLink, ChevronDown, ChevronUp, Search, Link2 } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';

const MARKETPLACE_LOGOS = {
  mercadolivre: '/mercado-livre.png',
  shopee: '/shopee.png',
};

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
  return `${days}d`;
}

const MiniAutocompleteTextarea = ({ value, onChange, onSend, placeholder, disabled, accountId }) => {
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [hashStart, setHashStart] = useState(-1);
  const [hashQuery, setHashQuery] = useState('');
  const searchTimeout = useRef(null);

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
  }, [onChange, accountId]);

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

  return (
    <div className="relative">
      <textarea ref={textareaRef} value={value} onChange={handleInput} onKeyDown={handleKeyDown}
        placeholder={placeholder} disabled={disabled} rows={2}
        className="w-full border border-gray-200/80 rounded-lg px-2.5 py-2 text-[11px] text-gray-700 placeholder-gray-400 focus:ring-1 focus:ring-blue-400/50 focus:border-blue-300 resize-none transition-all" />
      {showDropdown && (
        <div ref={dropdownRef}
          className="absolute bottom-full left-0 mb-1 z-[10000] bg-white rounded-xl shadow-2xl border border-gray-200/80 w-full max-h-[220px] overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-gray-100 px-2.5 py-1.5 flex items-center gap-1.5">
            <Search size={11} className="text-gray-400" />
            <span className="text-[10px] text-gray-500">
              Buscando: <span className="font-semibold text-gray-700">{hashQuery}</span>
            </span>
          </div>
          {searchLoading ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw size={12} className="animate-spin text-blue-500 mr-1.5" />
              <span className="text-[10px] text-gray-500">Buscando...</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-4 text-center text-[10px] text-gray-400">Nenhum anúncio encontrado</div>
          ) : (
            searchResults.map((item) => (
              <button key={item.ml_item_id} onClick={() => selectItem(item)}
                className="w-full flex items-center gap-2 px-2.5 py-2 hover:bg-blue-50/60 transition-colors text-left border-b border-gray-50 last:border-0">
                {item.thumbnail ? (
                  <img src={item.thumbnail} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0 border border-gray-100" />
                ) : (
                  <div className="w-8 h-8 rounded bg-gray-50 flex items-center justify-center flex-shrink-0"><Link2 size={10} className="text-gray-300" /></div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium text-gray-700 truncate">{item.title}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[9px] font-mono bg-gray-100/80 text-gray-500 px-1 py-0.5 rounded">{item.ml_item_id}</span>
                    {item.sku && <span className="text-[9px] font-mono bg-blue-50 text-blue-500 px-1 py-0.5 rounded">SKU: {item.sku}</span>}
                    {item.price && <span className="text-[9px] text-emerald-600 font-medium">R$ {Number(item.price).toFixed(2)}</span>}
                  </div>
                </div>
                <ExternalLink size={9} className="text-gray-300 flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const FloatingQuestionItem = ({ question, onAnswered }) => {
  const [expanded, setExpanded] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = useCallback(async () => {
    if (!answerText.trim() || sending) return;
    setSending(true);
    try {
      await axios.post(`/api/ml/questions/${question.id}/answer`, {
        text: answerText.trim(),
        accountId: question._accountId,
      });
      setSent(true);
      setAnswerText('');
      setTimeout(() => onAnswered(), 800);
    } catch { /* ignore */ }
    setSending(false);
  }, [answerText, sending, question.id, question._accountId, onAnswered]);

  if (sent) {
    return (
      <div className="px-4 py-3 bg-emerald-50/60 text-center">
        <span className="text-xs text-emerald-600 font-medium">Resposta enviada com sucesso</span>
      </div>
    );
  }

  return (
    <div className="border-b border-gray-100/80 last:border-0">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-4 py-3 hover:bg-gray-50/60 transition-colors">
        <div className="flex items-start gap-2.5">
          {question._item?.thumbnail ? (
            <img src={question._item.thumbnail} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0 border border-gray-100" />
          ) : (
            <div className="w-9 h-9 rounded-lg bg-gray-50 flex items-center justify-center flex-shrink-0">
              <MessageSquare size={13} className="text-gray-300" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              {question._marketplace && MARKETPLACE_LOGOS[question._marketplace] && (
                <img src={MARKETPLACE_LOGOS[question._marketplace]} alt="" className="w-3 h-3 object-contain opacity-70" />
              )}
              <span className="text-[10px] text-gray-400 truncate">{question._accountName}</span>
              <span className="text-[10px] text-gray-300 ml-auto flex-shrink-0">{timeAgo(question.date_created)}</span>
            </div>
            <p className="text-[11px] font-medium text-gray-700 truncate">{question._item?.title || question.item_id}</p>
            <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">{question.text}</p>
          </div>
          <div className="flex-shrink-0 mt-1 text-gray-300">
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1">
          <div className="bg-gray-50/80 rounded-lg p-2.5 mb-2">
            <p className="text-[11px] text-gray-600 leading-relaxed">{question.text}</p>
          </div>
          <MiniAutocompleteTextarea
            value={answerText}
            onChange={setAnswerText}
            onSend={handleSend}
            placeholder="Digite sua resposta... Use # para buscar anúncios"
            disabled={sending}
            accountId={question._accountId}
          />
          <div className="flex items-center justify-between mt-1.5">
            {question._item?.permalink && (
              <a href={question._item.permalink} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-gray-400 hover:text-blue-500 flex items-center gap-1 transition-colors">
                <ExternalLink size={10} />Ver anúncio
              </a>
            )}
            <button onClick={handleSend} disabled={!answerText.trim() || sending}
              className="ml-auto flex items-center gap-1.5 bg-blue-500/90 hover:bg-blue-600/90 text-white px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed">
              {sending ? <RefreshCw size={10} className="animate-spin" /> : <Send size={10} />}
              Enviar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const FloatingQuestions = () => {
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const pollRef = useRef(null);
  const panelRef = useRef(null);

  const isAtendimentoPage = location.pathname === '/atendimento';

  const fetchUnanswered = useCallback(async () => {
    try {
      setLoading(true);
      const r = await axios.get('/api/ml/questions?status=UNANSWERED&limit=20');
      const qs = r.data?.questions || [];
      setQuestions(qs);
      setCount(qs.length);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUnanswered();
    pollRef.current = setInterval(fetchUnanswered, 30000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchUnanswered]);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        const btn = document.getElementById('floating-questions-btn');
        if (btn && btn.contains(e.target)) return;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (open) fetchUnanswered();
  }, [open, fetchUnanswered]);

  if (isAtendimentoPage) return null;

  return (
    <>
      {/* Floating button */}
      <button id="floating-questions-btn" onClick={() => setOpen(!open)}
        className={`fixed bottom-6 right-6 z-[9998] w-12 h-12 rounded-2xl shadow-lg flex items-center justify-center transition-all duration-300 hover:scale-105 hover:shadow-xl ${
          open
            ? 'bg-gray-600/90 hover:bg-gray-700/90'
            : count > 0
              ? 'bg-amber-400/90 hover:bg-amber-500/90'
              : 'bg-blue-500/80 hover:bg-blue-500/90'
        }`}
        style={{ backdropFilter: 'blur(8px)' }}>
        {open ? <X size={18} className="text-white" /> : <MessageSquare size={18} className="text-white" />}
        {!open && count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center bg-red-400 text-white text-[9px] font-bold rounded-full px-1 shadow-sm">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {/* Floating panel */}
      <div ref={panelRef}
        className={`fixed bottom-20 right-6 z-[9997] w-[360px] max-h-[560px] bg-white/95 rounded-2xl shadow-2xl border border-gray-200/60 transform transition-all duration-300 ease-out origin-bottom-right ${
          open ? 'scale-100 opacity-100 translate-y-0' : 'scale-95 opacity-0 translate-y-2 pointer-events-none'
        }`}
        style={{ backdropFilter: 'blur(16px)' }}>
        <div className="flex flex-col max-h-[560px]">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100/80 flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <MessageSquare size={14} className="text-blue-500" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-800">Atendimento</h2>
                <p className="text-[10px] text-gray-400">{count} pergunta{count !== 1 ? 's' : ''} pendente{count !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <button onClick={fetchUnanswered} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100/60 rounded-lg transition-colors">
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
              </button>
              <button onClick={() => setOpen(false)} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100/60 rounded-lg transition-colors">
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Panel content */}
          <div className="flex-1 overflow-y-auto overscroll-contain" style={{ maxHeight: 'calc(560px - 100px)' }}>
            {questions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-6">
                <div className="w-12 h-12 rounded-2xl bg-emerald-50 flex items-center justify-center mb-3">
                  <MessageSquare size={18} className="text-emerald-400" />
                </div>
                <p className="text-sm font-medium text-gray-500">Tudo em dia!</p>
                <p className="text-[11px] text-gray-400 mt-1">Nenhuma pergunta pendente</p>
              </div>
            ) : (
              questions.map(q => (
                <FloatingQuestionItem key={q.id} question={q} onAnswered={fetchUnanswered} />
              ))
            )}
          </div>

          {/* Panel footer */}
          <div className="border-t border-gray-100/80 px-4 py-2.5 flex-shrink-0">
            <button onClick={() => { navigate('/atendimento'); setOpen(false); }}
              className="w-full flex items-center justify-center gap-1.5 bg-gray-50 hover:bg-gray-100/80 text-gray-600 py-2 rounded-xl text-[11px] font-medium transition-colors border border-gray-200/60">
              <ExternalLink size={11} />Ver todas as perguntas
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
