import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Package, Activity, TrendingUp, BarChart2, Download, RefreshCw } from 'lucide-react';
import axios from 'axios';

const formatBRL = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const Skeleton = ({ className = '' }) => (
  <div className={`animate-pulse bg-gray-200 dark:bg-gray-700 rounded ${className}`} />
);

const StatCard = ({ title, value, icon: Icon, color, deltaPercent, meta, loading }) => {
  const positive = (deltaPercent || 0) >= 0;
  const metaProgress = meta ? Math.max(0, Math.min(100, Math.round((Number(String(value).replace(/[^0-9,.-]/g, '')) || 0) / meta * 100))) : null;
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-md p-5 transition-all duration-300 border border-gray-100 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">{title}</p>
          {loading ? (
            <Skeleton className="h-8 w-24 mt-1" />
          ) : (
            <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1 truncate">{value}</p>
          )}
          {!loading && deltaPercent !== undefined && (
            <div className={`mt-1.5 text-xs font-medium inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${positive ? 'bg-emerald-50/70 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' : 'bg-red-50/70 text-red-500 dark:bg-red-900/20 dark:text-red-400'}`}>
              {positive ? '▲' : '▼'} {Math.abs(deltaPercent).toFixed(2)}%
            </div>
          )}
          {!loading && metaProgress !== null && (
            <div className="mt-2">
              <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400/80 rounded-full transition-all duration-500" style={{ width: `${metaProgress}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-400">Meta {metaProgress}%</div>
            </div>
          )}
        </div>
        <div className={`p-3 rounded-xl ${color} flex-shrink-0 ml-4`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
    </div>
  );
};

const GraficoVendas = ({ dados, ano, mes, dadosComparacao }) => {
  const ref = useRef(null);
  const [svgWidth, setSvgWidth] = useState(900);
  const height = Math.max(180, Math.min(280, svgWidth * 0.2));
  const padding = { top: 30, right: 20, bottom: 30, left: 55 };
  const [hoverIndex, setHoverIndex] = useState(null);
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const colors = {
    axis: isDark ? '#374151' : '#e5e7eb',
    text: isDark ? '#9ca3af' : '#6b7280',
    tooltipBg: isDark ? '#1f2937' : '#ffffff',
    tooltipStroke: isDark ? '#374151' : '#e5e7eb',
    legendText: isDark ? '#9ca3af' : '#6b7280'
  };

  useEffect(() => {
    const update = () => { if (ref.current) setSvgWidth(ref.current.offsetWidth || 900); };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  if (!dados || dados.length === 0) return <div className="text-gray-400 dark:text-gray-500 text-center py-8">Sem dados de vendas no mês.</div>;

  const diasNoMes = new Date(ano, mes, 0).getDate();
  const diasArray = Array.from({ length: diasNoMes }, (_, i) => `${ano}-${String(mes).padStart(2, '0')}-${(i + 1).toString().padStart(2, '0')}`);
  const dadosMap = {};
  dados.forEach(d => { dadosMap[d.dia] = d; });
  const dadosCompletos = diasArray.map(dia => ({
    dia, valor: dadosMap[dia]?.valor || 0, quantidade: dadosMap[dia]?.quantidade || 0
  }));

  let dadosCompCompletos = null;
  if (dadosComparacao && dadosComparacao.length > 0) {
    const compPorDia = {};
    dadosComparacao.forEach(d => {
      const day = parseInt((d.dia || '').slice(8, 10), 10);
      if (!Number.isNaN(day)) compPorDia[day] = d.valor || 0;
    });
    dadosCompCompletos = Array.from({ length: diasNoMes }, (_, i) => ({
      diaIndex: i + 1, valor: compPorDia[i + 1] || 0
    }));
  }

  const maxValorAtual = Math.max(...dadosCompletos.map(d => d.valor), 0);
  const maxValorComp = dadosCompCompletos ? Math.max(...dadosCompCompletos.map(d => d.valor), 0) : 0;
  const maxValor = Math.max(maxValorAtual, maxValorComp) || 1;
  const w = svgWidth;
  const chartW = w - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const stepX = chartW / Math.max(dadosCompletos.length - 1, 1);

  const toPoint = (val, i) => [padding.left + i * stepX, padding.top + chartH - (val / maxValor) * chartH];
  const points = dadosCompletos.map((d, i) => toPoint(d.valor, i));
  const pointsComp = dadosCompCompletos ? dadosCompCompletos.map((d, i) => toPoint(d.valor, i)) : null;

  const buildSmoothPath = (pts) => {
    if (!pts || pts.length < 2) return '';
    const p = pts.map(([x, y]) => ({ x, y }));
    let d = `M${p[0].x},${p[0].y}`;
    const tension = 0.85;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i];
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = p[i + 2] || p2;
      const yMin = padding.top;
      const yMax = padding.top + chartH;
      const c1x = p1.x + (p2.x - p0.x) / 6 * tension;
      const c1y = Math.max(yMin, Math.min(yMax, p1.y + (p2.y - p0.y) / 6 * tension));
      const c2x = p2.x - (p3.x - p1.x) / 6 * tension;
      const c2y = Math.max(yMin, Math.min(yMax, p2.y - (p3.y - p1.y) / 6 * tension));
      d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
    }
    return d;
  };

  const path = buildSmoothPath(points);
  const baseline = padding.top + chartH;
  const areaPath = `${path} L${points[points.length - 1][0]},${baseline} L${points[0][0]},${baseline} Z`;
  const pathComp = pointsComp ? buildSmoothPath(pointsComp) : null;
  const areaPathComp = pointsComp ? `${pathComp} L${pointsComp[pointsComp.length - 1][0]},${baseline} L${pointsComp[0][0]},${baseline} Z` : null;

  const gridLines = 4;
  const gridValues = Array.from({ length: gridLines + 1 }, (_, i) => (maxValor / gridLines) * i);

  return (
    <div className="w-full overflow-x-auto" ref={ref} style={{ minWidth: 300 }}>
      <svg
        width={w} height={height}
        viewBox={`0 0 ${w} ${height}`}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          setHoverIndex(Math.max(0, Math.min(dadosCompletos.length - 1, Math.round((x - padding.left) / stepX))));
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="gradVendas" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="gradVendasPrev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a855f7" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((val, i) => {
          const y = padding.top + chartH - (val / maxValor) * chartH;
          return (
            <g key={i}>
              <line x1={padding.left} y1={y} x2={w - padding.right} y2={y} stroke={colors.axis} strokeDasharray={i === 0 ? '' : '3 3'} />
              <text x={padding.left - 8} y={y + 4} fontSize={10} textAnchor="end" fill={colors.text}>
                {val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val.toFixed(0)}
              </text>
            </g>
          );
        })}

        {areaPathComp && <path d={areaPathComp} fill="url(#gradVendasPrev)" />}
        {pathComp && <path d={pathComp} fill="none" stroke="#a855f7" strokeWidth={1.5} opacity={0.6} />}
        <path d={areaPath} fill="url(#gradVendas)" />
        <path d={path} fill="none" stroke="#2563eb" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

        {points.map(([x], i) => {
          if (diasNoMes > 15 && i % 2 !== 0 && i !== diasNoMes - 1) return null;
          return <text key={i} x={x} y={height - 6} fontSize={9} textAnchor="middle" fill={colors.text}>{i + 1}</text>;
        })}

        {hoverIndex !== null && hoverIndex >= 0 && hoverIndex < dadosCompletos.length && (() => {
          const px = points[hoverIndex][0];
          const py = points[hoverIndex][1];
          const valorAtual = dadosCompletos[hoverIndex].valor || 0;
          const valorPrev = dadosCompCompletos?.[hoverIndex]?.valor || 0;
          const hasPrev = !!dadosCompCompletos;
          const boxW = hasPrev ? 210 : 140;
          const boxH = 52;
          const boxX = Math.min(Math.max(px - boxW / 2, 5), w - boxW - 5);
          const boxY = Math.max(5, py - boxH - 12);
          return (
            <g>
              <line x1={px} y1={padding.top} x2={px} y2={baseline} stroke={colors.text} strokeDasharray="3 3" opacity={0.4} />
              <circle cx={px} cy={py} r={4} fill="#2563eb" stroke="white" strokeWidth={2} />
              {hasPrev && pointsComp && <circle cx={pointsComp[hoverIndex][0]} cy={pointsComp[hoverIndex][1]} r={3} fill="#a855f7" stroke="white" strokeWidth={2} />}
              <rect x={boxX} y={boxY} width={boxW} height={boxH} rx={8} fill={colors.tooltipBg} stroke={colors.tooltipStroke} filter="drop-shadow(0 2px 4px rgba(0,0,0,0.1))" />
              <text x={boxX + 10} y={boxY + 16} fontSize={11} fontWeight="600" fill={colors.text}>Dia {String(hoverIndex + 1).padStart(2, '0')}</text>
              <rect x={boxX + 10} y={boxY + 24} width={8} height={8} rx={2} fill="#2563eb" />
              <text x={boxX + 22} y={boxY + 32} fontSize={11} fill={colors.text}>{formatBRL(valorAtual)}</text>
              {hasPrev && (
                <>
                  <rect x={boxX + boxW / 2 + 5} y={boxY + 24} width={8} height={8} rx={2} fill="#a855f7" />
                  <text x={boxX + boxW / 2 + 17} y={boxY + 32} fontSize={11} fill={colors.text}>{formatBRL(valorPrev)}</text>
                </>
              )}
            </g>
          );
        })()}

        <g transform={`translate(${w - padding.right - 130}, ${padding.top - 5})`}>
          <rect x={0} y={0} width={10} height={10} rx={2} fill="#2563eb" />
          <text x={14} y={9} fontSize={10} fill={colors.legendText}>Mês selecionado</text>
          {pointsComp && (
            <>
              <rect x={0} y={15} width={10} height={10} rx={2} fill="#a855f7" />
              <text x={14} y={24} fontSize={10} fill={colors.legendText}>Mês anterior</text>
            </>
          )}
        </g>
      </svg>
    </div>
  );
};

const MarketplaceIcon = ({ name }) => {
  const [idx, setIdx] = useState(0);
  if (!name || name.toLowerCase() === 'desconhecido') return null;
  const normalize = (s) => {
    const base = (s || '').toLowerCase().trim();
    if (base.includes('mercado livre')) return 'mercado-livre';
    if (base.includes('magazine luiza') || base.includes('magalu')) return 'magalu';
    if (base.includes('shopee')) return 'shopee';
    if (base.includes('amazon')) return 'amazon';
    if (base.includes('olist')) return 'olist';
    if (base.includes('shein')) return 'shein';
    if (base.includes('tiktok')) return 'tiktok-shop';
    if (base.includes('madeira')) return 'madeira-madeira';
    if (base.includes('leroy')) return 'leroy-merlin';
    return base.replace(/\s+/g, '-');
  };
  const slug = normalize(name);
  const candidates = [`/icons/${slug}.svg`, `/icons/${slug}.png`, `/${slug}.svg`, `/${slug}.png`];
  if (idx >= candidates.length) return null;
  return (
    <img src={(process.env.PUBLIC_URL || '') + candidates[idx]} alt="" className="w-5 h-5"
      onError={() => setIdx(i => i + 1)} />
  );
};

const DonutChart = ({ slices, size = 200, stroke = 24, centerLabel = '' }) => {
  const radius = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * radius;
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={radius} fill="none" stroke={isDark ? '#374151' : '#f3f4f6'} strokeWidth={stroke} />
      {slices.map((s, i) => {
        const dash = (s.value / total) * C;
        const el = (
          <circle key={i} cx={cx} cy={cy} r={radius} fill="none" stroke={s.color} strokeWidth={stroke}
            strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset}
            className="transition-all duration-500" />
        );
        offset += dash;
        return el;
      })}
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
        fill={isDark ? '#e5e7eb' : '#374151'} fontSize="13" fontWeight="500">{centerLabel}</text>
    </svg>
  );
};

const exportCsv = (filename, rows) => {
  const escape = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const csv = '\uFEFF' + rows.map(r => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const Home = () => {
  const [stats, setStats] = useState({
    faturamentoMes: 0, vendasMes: 0, faturamentoDia: 0, vendasPorDiaMes: [],
    status: 'offline', prevFaturamentoMes: 0, prevVendasMes: 0, prevDiaValor: 0, metaMes: null
  });
  const now = new Date();
  const initialAno = (() => {
    const qs = new URLSearchParams(window.location.search);
    const a = qs.get('ano') || localStorage.getItem('dash_ano');
    return a ? Number(a) : now.getFullYear();
  })();
  const initialMes = (() => {
    const qs = new URLSearchParams(window.location.search);
    const m = qs.get('mes') || localStorage.getItem('dash_mes');
    return m || (now.getMonth() + 1).toString().padStart(2, '0');
  })();

  const [ano, setAno] = useState(initialAno);
  const [mes, setMes] = useState(initialMes);
  const [graficoMetrica, setGraficoMetrica] = useState(localStorage.getItem('dash_metrica') || 'faturamento');
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingLists, setLoadingLists] = useState(true);
  const [maisVendidosMes, setMaisVendidosMes] = useState([]);
  const [maisVendidos3m, setMaisVendidos3m] = useState([]);
  const [mkMaisVendasMes, setMkMaisVendasMes] = useState([]);
  const [mkMaisVendas3m, setMkMaisVendas3m] = useState([]);
  const [blingAccounts, setBlingAccounts] = useState([]);
  const [statsByAccount, setStatsByAccount] = useState({});
  const [vendasPorDiaAnterior, setVendasPorDiaAnterior] = useState([]);
  const [ordenacaoSkusMes, setOrdenacaoSkusMes] = useState('faturamento');
  const [ordenacaoSkus3m, setOrdenacaoSkus3m] = useState('faturamento');

  const fetchStats = useCallback(async () => {
    try {
      setLoadingStats(true);
      const [statusRes, dashRes] = await Promise.all([
        axios.get('/api/status'),
        axios.get(`/api/dashboard/faturamento?ano=${ano}&mes=${mes}`)
      ]);
      const current = {
        faturamentoMes: dashRes.data.faturamentoMes || 0,
        vendasMes: dashRes.data.vendasMes || 0,
        faturamentoDia: dashRes.data.faturamentoDia || 0,
        vendasPorDiaMes: dashRes.data.vendasPorDiaMes || [],
        status: statusRes.data.status,
        metaMes: dashRes.data.metaMes || null,
        prevFaturamentoMes: 0, prevVendasMes: 0, prevDiaValor: 0
      };
      const mesNumber = parseInt(mes, 10);
      const prevDate = new Date(ano, mesNumber - 2, 1);
      const prevAno = prevDate.getFullYear();
      const prevMes = String(prevDate.getMonth() + 1).padStart(2, '0');
      try {
        const prevRes = await axios.get(`/api/dashboard/faturamento?ano=${prevAno}&mes=${prevMes}`);
        const vpd = prevRes.data.vendasPorDiaMes || [];
        setVendasPorDiaAnterior(vpd);
        current.prevFaturamentoMes = vpd.reduce((a, d) => a + (d.valor || 0), 0);
        current.prevVendasMes = vpd.reduce((a, d) => a + (d.quantidade || 0), 0);
        current.prevDiaValor = vpd[new Date().getDate() - 1]?.valor || 0;
      } catch { setVendasPorDiaAnterior([]); }
      setStats(current);
    } catch (error) {
      console.error('Erro ao carregar estatísticas:', error);
    } finally { setLoadingStats(false); }
  }, [ano, mes]);

  const fetchMaisVendidos = useCallback(async () => {
    try {
      setLoadingLists(true);
      const pad = (n) => String(n).padStart(2, '0');
      const monthNum = parseInt(mes, 10);
      const startMonth = `${ano}-${mes}-01`;
      const nextMonthDate = new Date(ano, monthNum, 1);
      const endMonth = `${nextMonthDate.getFullYear()}-${pad(nextMonthDate.getMonth() + 1)}-01`;
      const threeStartDate = new Date(ano, monthNum - 3, 1);
      const threeEnd = `${nextMonthDate.getFullYear()}-${pad(nextMonthDate.getMonth() + 1)}-01`;
      const threeStart = `${threeStartDate.getFullYear()}-${pad(threeStartDate.getMonth() + 1)}-01`;

      const [mesRes, trimesRes, mkMesRes, mkTrimesRes] = await Promise.all([
        axios.get(`/api/dashboard/itens-mais-vendidos?sort=${ordenacaoSkusMes}&dataInicio=${startMonth}&dataFim=${endMonth}`),
        axios.get(`/api/dashboard/itens-mais-vendidos?sort=${ordenacaoSkus3m}&dataInicio=${threeStart}&dataFim=${threeEnd}`),
        axios.get(`/api/dashboard/marketplaces-mais-vendas?sort=faturamento&dataInicio=${startMonth}&dataFim=${endMonth}`),
        axios.get(`/api/dashboard/marketplaces-mais-vendas?sort=faturamento&dataInicio=${threeStart}&dataFim=${threeEnd}`)
      ]);
      setMaisVendidosMes(mesRes.data.items || []);
      setMaisVendidos3m(trimesRes.data.items || []);
      setMkMaisVendasMes(mkMesRes.data.marketplaces || []);
      setMkMaisVendas3m(mkTrimesRes.data.marketplaces || []);
    } catch {
      setMaisVendidosMes([]); setMaisVendidos3m([]); setMkMaisVendasMes([]); setMkMaisVendas3m([]);
    } finally { setLoadingLists(false); }
  }, [ano, mes, ordenacaoSkusMes, ordenacaoSkus3m]);

  const fetchStatsByAccount = useCallback(async () => {
    if (!blingAccounts.length) { setStatsByAccount({}); return; }
    try {
      const entries = await Promise.all(
        blingAccounts.map(async (acc) => {
          const res = await axios.get(`/api/dashboard/faturamento?ano=${ano}&mes=${mes}&accountId=${acc.id}`);
          return [acc.id, { ...res.data, accountId: acc.id, accountName: acc.name }];
        })
      );
      setStatsByAccount(Object.fromEntries(entries));
    } catch { setStatsByAccount({}); }
  }, [blingAccounts, ano, mes]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await axios.get('/api/bling/accounts');
        if (mounted) setBlingAccounts(Array.isArray(res.data?.accounts) ? res.data.accounts : []);
      } catch { if (mounted) setBlingAccounts([]); }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchMaisVendidos(); }, [fetchMaisVendidos]);
  useEffect(() => { fetchStatsByAccount(); }, [fetchStatsByAccount]);

  const handleMesChange = (m) => {
    setMes(m);
    localStorage.setItem('dash_mes', m);
    const qs = new URLSearchParams(window.location.search);
    qs.set('mes', m);
    window.history.replaceState(null, '', `${window.location.pathname}?${qs.toString()}`);
  };

  const handleAnoChange = (a) => {
    setAno(Number(a));
    localStorage.setItem('dash_ano', a);
    const qs = new URLSearchParams(window.location.search);
    qs.set('ano', a);
    window.history.replaceState(null, '', `${window.location.pathname}?${qs.toString()}`);
  };

  const palette = ['#3b82f6', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c', '#38bdf8', '#9ca3af'];

  const MarketplaceDonutCard = ({ title, data }) => {
    const sorted = [...data].sort((a, b) => (b.faturamento || 0) - (a.faturamento || 0));
    const maxSlices = 7;
    const top = sorted.slice(0, maxSlices);
    const rest = sorted.slice(maxSlices);
    const outrosValor = rest.reduce((a, r) => a + (r.faturamento || 0), 0);
    const topWithColors = top.map((r, i) => ({ ...r, color: palette[i % palette.length] }));
    if (outrosValor > 0) topWithColors.push({ marketplace: 'Outros', faturamento: outrosValor, color: palette[topWithColors.length % palette.length] });
    const totalGeral = sorted.reduce((a, r) => a + (r.faturamento || 0), 0) || 1;
    const slices = topWithColors.map(r => ({ label: r.marketplace, value: r.faturamento || 0, color: r.color }));
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 transition-all duration-300">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">{title}</h2>
        {data.length === 0 ? (
          <div className="text-gray-400 text-center py-6">Sem dados.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-center">
            <div className="flex justify-center">
              <DonutChart slices={slices} centerLabel="Faturamento" />
            </div>
            <div className="overflow-auto max-h-[260px]">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400 dark:text-gray-500">
                    <th className="pb-2" />
                    <th className="pb-2">Marketplace</th>
                    <th className="pb-2 text-right">Total</th>
                    <th className="pb-2 text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.marketplace + i} className="border-t border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
                      <td className="py-2 pr-2"><MarketplaceIcon name={r.marketplace} /></td>
                      <td className="py-2 text-gray-800 dark:text-gray-200 text-xs">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: palette[i % palette.length] }} />
                        {r.marketplace}
                      </td>
                      <td className="py-2 text-right text-gray-700 dark:text-gray-300 text-xs font-medium">{formatBRL(r.faturamento || 0)}</td>
                      <td className="py-2 text-right text-gray-400 text-xs">{(((r.faturamento || 0) / totalGeral) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  };

  const ItemList = ({ title, data, ordenacao, setOrdenacao, period }) => (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5 transition-all duration-300">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        <button onClick={() => {
          const header = ['SKU', 'Título', 'Quantidade', 'Faturamento'];
          const rows = [header, ...data.map(i => [i.sku, i.title || '', i.total_quantidade, Number(i.faturamento || 0).toFixed(2)])];
          exportCsv(`itens-mais-vendidos-${period}.csv`, rows);
        }}
          title="Baixar CSV" className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
          <Download className="w-4 h-4" />
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xs text-gray-400">Ordenar:</span>
        {['faturamento', 'pedidos'].map(opt => (
          <button key={opt} onClick={() => setOrdenacao(opt)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${ordenacao === opt ? 'bg-blue-500/90 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}>
            {opt === 'faturamento' ? 'Faturamento' : 'Qtd. Pedidos'}
          </button>
        ))}
      </div>
      {loadingLists ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : data.length === 0 ? (
        <div className="text-gray-400 text-center py-6">Sem dados.</div>
      ) : (
        <ul className="divide-y divide-gray-50 dark:divide-gray-700/50 max-h-[400px] overflow-y-auto">
          {data.map((item, idx) => (
            <li key={item.sku + idx} className="py-2.5 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/30 rounded-lg px-2 transition-colors">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{item.title || item.sku}</div>
                <div className="text-xs text-gray-400">SKU: {item.sku}</div>
              </div>
              <div className="text-right flex-shrink-0 ml-4">
                <div className="text-sm font-semibold text-gray-900 dark:text-white">{item.total_quantidade}</div>
                <div className="text-xs text-gray-400">{formatBRL(item.faturamento)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-6 max-w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        <button onClick={() => { fetchStats(); fetchMaisVendidos(); }}
          disabled={loadingStats}
          className="p-2 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 text-gray-600 dark:text-gray-300 ${loadingStats ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Faturamento" value={formatBRL(stats.faturamentoMes)} icon={TrendingUp} color="bg-blue-400/80"
          deltaPercent={stats.prevFaturamentoMes ? ((stats.faturamentoMes - stats.prevFaturamentoMes) / stats.prevFaturamentoMes) * 100 : 0}
          meta={stats.metaMes} loading={loadingStats} />
        <StatCard title="Vendas" value={stats.vendasMes} icon={Package} color="bg-emerald-400/80"
          deltaPercent={stats.prevVendasMes ? ((stats.vendasMes - stats.prevVendasMes) / stats.prevVendasMes) * 100 : 0} loading={loadingStats} />
        <StatCard title="Faturamento do Dia" value={formatBRL(stats.faturamentoDia)} icon={BarChart2} color="bg-violet-400/80"
          deltaPercent={stats.prevDiaValor ? ((stats.faturamentoDia - stats.prevDiaValor) / stats.prevDiaValor) * 100 : 0} loading={loadingStats} />
        <StatCard title="Status" value={stats.status} icon={Activity}
          color={stats.status === 'online' ? 'bg-emerald-400/80' : 'bg-rose-400/80'} loading={loadingStats} />
      </div>

      {blingAccounts.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-3">Totais por Conta</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {blingAccounts.map(acc => {
              const s = statsByAccount[acc.id] || {};
              return (
                <div key={acc.id} className="border border-gray-100 dark:border-gray-700 rounded-xl p-4 hover:shadow-sm transition-shadow">
                  <div className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">{acc.name}</div>
                  <div className="text-lg font-bold text-gray-900 dark:text-white">{formatBRL(s.faturamentoMes)}</div>
                  <div className="text-xs text-gray-400 mb-2">Faturamento do mês</div>
                  <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
                    <span>Vendas: <strong>{s.vendasMes || 0}</strong></span>
                    <span>Dia: <strong>{formatBRL(s.faturamentoDia)}</strong></span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Vendas do Mês</h2>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-gray-500 dark:text-gray-400">Mês:</label>
              <select value={mes} onChange={e => handleMesChange(e.target.value)}
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none">
                {[...Array(12)].map((_, i) => (
                  <option key={i + 1} value={(i + 1).toString().padStart(2, '0')}>{(i + 1).toString().padStart(2, '0')}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-gray-500 dark:text-gray-400">Ano:</label>
              <select value={ano} onChange={e => handleAnoChange(e.target.value)}
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none">
                {Array.from({ length: 5 }, (_, i) => now.getFullYear() - 2 + i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-gray-500 dark:text-gray-400">Métrica:</label>
              <select value={graficoMetrica} onChange={e => { setGraficoMetrica(e.target.value); localStorage.setItem('dash_metrica', e.target.value); }}
                className="border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1 text-sm bg-white dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none">
                <option value="faturamento">Faturamento</option>
                <option value="pedidos">Pedidos</option>
              </select>
            </div>
          </div>
        </div>
        {loadingStats ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <GraficoVendas
            dados={stats.vendasPorDiaMes.map(d => ({ ...d, valor: graficoMetrica === 'faturamento' ? d.valor : d.quantidade }))}
            ano={ano} mes={mes}
            dadosComparacao={vendasPorDiaAnterior.map(d => ({ ...d, valor: graficoMetrica === 'faturamento' ? d.valor : d.quantidade }))}
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MarketplaceDonutCard title="Marketplaces (mês)" data={mkMaisVendasMes} />
        <MarketplaceDonutCard title="Marketplaces (últimos 3 meses)" data={mkMaisVendas3m} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ItemList title="Mais vendidos (mês)" data={maisVendidosMes} ordenacao={ordenacaoSkusMes} setOrdenacao={setOrdenacaoSkusMes} period="mes" />
        <ItemList title="Mais vendidos (últimos 3 meses)" data={maisVendidos3m} ordenacao={ordenacaoSkus3m} setOrdenacao={setOrdenacaoSkus3m} period="3m" />
      </div>
    </div>
  );
};
