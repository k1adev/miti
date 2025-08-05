import React, { useState, useEffect } from 'react';
import { Users, Package, Globe, Activity, Plus, TrendingUp, BarChart2 } from 'lucide-react';
import axios from 'axios';

export const Home = () => {
  const [stats, setStats] = useState({
    faturamentoMes: 0,
    vendasMes: 0,
    faturamentoDia: 0,
    vendasPorDiaMes: [],
    status: 'offline'
  });
  const now = new Date();
  const [ano, setAno] = useState(now.getFullYear());
  const [mes, setMes] = useState((now.getMonth() + 1).toString().padStart(2, '0'));

  useEffect(() => {
    fetchStats();
  }, [ano, mes]);

  const fetchStats = async () => {
    try {
      const [statusRes, dashRes] = await Promise.all([
        axios.get('/api/status'),
        axios.get(`/api/dashboard/faturamento?ano=${ano}&mes=${mes}`)
      ]);
      setStats({
        faturamentoMes: dashRes.data.faturamentoMes || 0,
        vendasMes: dashRes.data.vendasMes || 0,
        faturamentoDia: dashRes.data.faturamentoDia || 0,
        vendasPorDiaMes: dashRes.data.vendasPorDiaMes || [],
        status: statusRes.data.status
      });
    } catch (error) {
      console.error('Erro ao carregar estatísticas:', error);
    }
  };

  const StatCard = ({ title, value, icon: Icon, color }) => (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600 dark:text-gray-300">{title}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
        </div>
        <div className={`p-3 rounded-full ${color}`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
      </div>
    </div>
  );

  // Gráfico de linha responsivo (SVG, sem libs externas)
  const GraficoVendas = ({ dados, ano, mes }) => {
    const ref = React.useRef(null);
    const [svgWidth, setSvgWidth] = React.useState(900);
    const height = 120;
    const padding = 30;
    React.useEffect(() => {
      if (ref.current) {
        setSvgWidth(ref.current.offsetWidth || 900);
      }
      const handleResize = () => {
        if (ref.current) setSvgWidth(ref.current.offsetWidth || 900);
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);
    if (!dados || dados.length === 0) return <div className="text-gray-500 dark:text-gray-400">Sem dados de vendas no mês.</div>;
    // Gerar todos os dias do mês selecionado
    const diasNoMes = new Date(ano, mes, 0).getDate();
    const diasArray = Array.from({ length: diasNoMes }, (_, i) => `${ano}-${mes.toString().padStart(2, '0')}-${(i+1).toString().padStart(2, '0')}`);
    // Mapear dados recebidos para um objeto {dia: {valor, quantidade}}
    const dadosMap = {};
    dados.forEach(d => { dadosMap[d.dia] = d; });
    // Preencher todos os dias do mês, usando zero onde não houver vendas
    const dadosCompletos = diasArray.map(dia => ({
      dia,
      valor: dadosMap[dia]?.valor || 0,
      quantidade: dadosMap[dia]?.quantidade || 0
    }));
    const maxValor = Math.max(...dadosCompletos.map(d => d.valor));
    const width = svgWidth;
    const stepX = (width - 2 * padding) / (dadosCompletos.length - 1);
    // Gerar pontos
    const points = dadosCompletos.map((d, i) => {
      const x = padding + i * stepX;
      const y = height - padding - (maxValor ? (d.valor / maxValor) * (height - 2 * padding) : 0);
      return [x, y];
    });
    // Gerar path da linha
    const path = points.map((p, i) => i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`).join(' ');
    return (
      <div className="w-full overflow-x-auto" ref={ref} style={{ minWidth: 300 }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', margin: '0 auto', background: 'transparent' }}>
          {/* Eixos */}
          <line x1={padding} y1={height-padding} x2={width-padding} y2={height-padding} stroke="#ccc" />
          <line x1={padding} y1={padding} x2={padding} y2={height-padding} stroke="#ccc" />
          {/* Linha do gráfico */}
          <path d={path} fill="none" stroke="#2563eb" strokeWidth={2} />
          {/* Pontos */}
          {points.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={3} fill="#2563eb" />
          ))}
          {/* Labels dos dias */}
          {points.map(([x], i) => (
            <text key={i} x={x} y={height-padding+14} fontSize={10} textAnchor="middle" fill="#666">{String(i+1).padStart(2, '0')}</text>
          ))}
          {/* Label do valor máximo */}
          <text x={padding} y={padding-8} fontSize={10} textAnchor="start" fill="#666">{maxValor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</text>
          {/* Label do zero */}
          <text x={padding-5} y={height-padding} fontSize={10} textAnchor="end" fill="#666">0</text>
        </svg>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Dashboard</h1>
        {/* f */}
      </div>

      {/* Estatísticas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Faturamento"
          value={stats.faturamentoMes.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          icon={TrendingUp}
          color="bg-blue-500"
        />
        <StatCard
          title="Vendas"
          value={stats.vendasMes}
          icon={Package}
          color="bg-green-500"
        />
        <StatCard
          title="Faturamento do Dia"
          value={stats.faturamentoDia.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          icon={BarChart2}
          color="bg-purple-500"
        />
        <StatCard
          title="Status"
          value={stats.status}
          icon={Activity}
          color={stats.status === 'online' ? 'bg-green-500' : 'bg-red-500'}
        />
      </div>

      {/* Gráfico de vendas do mês */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Vendas do Mês</h2>
        <div className="flex items-center mb-4 gap-2">
          <label className="text-sm dark:text-gray-300">Mês:</label>
          <select value={mes} onChange={e => setMes(e.target.value)} className="border rounded px-2 py-1 dark:bg-gray-700 dark:text-white dark:border-gray-600">
            {[...Array(12)].map((_, i) => (
              <option key={i+1} value={(i+1).toString().padStart(2, '0')}>{(i+1).toString().padStart(2, '0')}</option>
            ))}
          </select>
          <label className="text-sm ml-2 dark:text-gray-300">Ano:</label>
          <select value={ano} onChange={e => setAno(e.target.value)} className="border rounded px-2 py-1 dark:bg-gray-700 dark:text-white dark:border-gray-600">
            {Array.from({length: 5}, (_, i) => now.getFullYear() - 2 + i).map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
        <GraficoVendas dados={stats.vendasPorDiaMes} ano={ano} mes={mes} />
      </div>
    </div>
  );
}; 