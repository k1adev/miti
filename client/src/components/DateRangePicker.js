import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DIAS_SEMANA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

const formatDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseDate = (s) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const DateRangePicker = ({ dataInicio, dataFim, onChange, onClose }) => {
  const hoje = new Date();
  const initialMonth = dataInicio ? parseDate(dataInicio) : hoje;
  const [viewDate, setViewDate] = useState(initialMonth || hoje);
  const [selecting, setSelecting] = useState('inicio'); // 'inicio' | 'fim'
  const [tempInicio, setTempInicio] = useState(dataInicio || '');
  const [tempFim, setTempFim] = useState(dataFim || '');

  const { firstDay, daysInMonth, startPad } = useMemo(() => {
    const y = viewDate.getFullYear();
    const m = viewDate.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const daysInMonth = last.getDate();
    const startPad = first.getDay();
    return { firstDay: first, daysInMonth, startPad };
  }, [viewDate]);

  const prevMonth = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1));
  const nextMonth = () => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1));

  const handleDayClick = (day) => {
    const dateStr = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), day));
    if (selecting === 'inicio') {
      setTempInicio(dateStr);
      setTempFim('');
      setSelecting('fim');
    } else {
      if (dateStr < tempInicio) {
        setTempFim(tempInicio);
        setTempInicio(dateStr);
      } else {
        setTempFim(dateStr);
      }
      setSelecting('inicio');
    }
  };

  const handleConfirm = () => {
    if (tempInicio) {
      onChange(tempInicio, tempFim || tempInicio);
      onClose?.();
    }
  };

  const handleClear = () => {
    setTempInicio('');
    setTempFim('');
    setSelecting('inicio');
  };

  const isInRange = (day) => {
    const dateStr = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), day));
    if (!tempInicio) return false;
    const fim = tempFim || tempInicio;
    return dateStr >= tempInicio && dateStr <= fim;
  };

  const isStart = (day) => {
    const dateStr = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), day));
    return dateStr === tempInicio;
  };

  const isEnd = (day) => {
    const dateStr = formatDate(new Date(viewDate.getFullYear(), viewDate.getMonth(), day));
    return dateStr === (tempFim || tempInicio);
  };

  const isSelected = (day) => isStart(day) || isEnd(day);

  return (
    <div className="absolute z-50 mt-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl shadow-xl p-4 min-w-[280px]">
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={prevMonth}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
          aria-label="Mês anterior"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {MESES[viewDate.getMonth()]} {viewDate.getFullYear()}
        </h3>
        <button
          type="button"
          onClick={nextMonth}
          className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
          aria-label="Próximo mês"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-3">
        {DIAS_SEMANA.map((d) => (
          <div key={d} className="text-center text-xs font-medium text-gray-500 dark:text-gray-400 py-1">
            {d}
          </div>
        ))}
        {Array.from({ length: startPad }, (_, i) => (
          <div key={`pad-${i}`} className="h-9" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const inRange = isInRange(day);
          const selected = isSelected(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => handleDayClick(day)}
              className={`h-9 w-9 rounded-full text-sm font-medium transition-colors flex items-center justify-center
                ${selected
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : inRange
                    ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-gray-200 dark:border-gray-600">
        <div className="flex-1 text-xs text-gray-500 dark:text-gray-400">
          {tempInicio ? (
            <span>
              {tempInicio.split('-').reverse().join('/')}
              {tempFim ? ` – ${tempFim.split('-').reverse().join('/')}` : ' (clique no fim)'}
            </span>
          ) : (
            'Clique para selecionar o período'
          )}
        </div>
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1"
        >
          Limpar
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!tempInicio}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Aplicar
        </button>
      </div>
    </div>
  );
};

export default DateRangePicker;
