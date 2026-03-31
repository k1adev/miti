import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../Toast';

const Section = ({ title, children, right }) => (
  <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
      {right}
    </div>
    {children}
  </div>
);

const Reports = () => {
  const toast = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [configs, setConfigs] = useState([]);
  const [tables, setTables] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filtros, setFiltros] = useState({ dataInicio: '', dataFim: '', marketplace: '' });
  const [costs, setCosts] = useState({ orders: [], items: [] });
  const [formato, setFormato] = useState('consolidado');
  const [agg, setAgg] = useState({ faturamento: 0, commission: 0, freight: 0, extras: 0, cogs: 0, margin: 0, marginPct: 0 });
  const [marketOptions, setMarketOptions] = useState([]);
  const [activeTab, setActiveTab] = useState('resumo');

  const [novoConfig, setNovoConfig] = useState({ marketplace: '', commission_percent: 0, commission_fixed_per_order: 0, commission_fixed_per_item: 0, freight_mode: 'fixed_per_order', freight_fixed_per_order: 0, freight_fixed_per_item: 0, default_shipping_table_id: null, extra_fixed_per_order: 0, commission_base: 'gross' });
  const [novaTabela, setNovaTabela] = useState({ marketplace: '', name: '', rule_type: 'fixed_per_order', rules_json: {} });
  const [file, setFile] = useState(null);
  const [measuresFile, setMeasuresFile] = useState(null);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [c, t, o] = await Promise.all([
        axios.get('/api/reports/marketplace-cost-config'),
        axios.get('/api/reports/shipping-tables'),
        axios.get('/api/reports/item-cost-overrides')
      ]);
      setConfigs(c.data || []);
      setTables(t.data || []);
      setOverrides(o.data || []);
      const opts = Array.from(new Set((c.data || []).map(x => x.marketplace))).filter(Boolean);
      setMarketOptions(opts);
    } finally { setLoading(false); }
  };

  useEffect(()=>{ fetchAll(); }, []);

  // Sincroniza a aba com o querystring (?tab=...)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab') || 'resumo';
    setActiveTab(tab);
  }, [location.search]);

  const goTab = (key) => {
    const params = new URLSearchParams(location.search);
    params.set('tab', key);
    navigate(`/reports?${params.toString()}`, { replace: false });
  };

  const compute = async () => {
    await axios.post('/api/reports/costs/compute', filtros);
    await carregarRelatorio();
  };

  const carregarRelatorio = async () => {
    const qs = new URLSearchParams({ ...filtros, formato });
    const res = await axios.get(`/api/reports/costs?${qs.toString()}`);
    if (formato === 'por-item') setCosts({ orders: [], items: res.data.items || [] });
    else setCosts({ orders: res.data.orders || [], items: [] });
    // agregados
    if (formato === 'consolidado') {
      const rows = res.data.orders || [];
      const sum = (f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
      const faturamento = sum('faturamento');
      const commission = sum('commission');
      const freight = sum('freight');
      const extras = sum('extra_fixed');
      const cogs = sum('cogs');
      const margin = sum('gross_margin');
      const marginPct = faturamento > 0 ? (margin / faturamento) * 100 : 0;
      setAgg({ faturamento, commission, freight, extras, cogs, margin, marginPct });
    } else {
      const rows = res.data.items || [];
      const sum = (f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
      const receita = sum('receita_item');
      const commission = sum('commission_item');
      const freight = sum('freight_item');
      const extras = sum('extra_fixed_item');
      const cogs = sum('cogs_item');
      const margin = sum('gross_margin_item');
      const marginPct = receita > 0 ? (margin / receita) * 100 : 0;
      setAgg({ faturamento: receita, commission, freight, extras, cogs, margin, marginPct });
    }
  };

  // export CSV
  const exportCsv = (filename, rows) => {
    const escape = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const csv = rows.map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const exportConsolidado = () => {
    const header = ['NF','Marketplace','Itens','Faturamento','Comissão','Frete','Extras','COGS','Margem','Margem %'];
    const rows = [header, ...costs.orders.map(o => [o.nota_id,o.marketplace,o.total_itens,Number(o.faturamento||0).toFixed(2),Number(o.commission||0).toFixed(2),Number(o.freight||0).toFixed(2),Number(o.extra_fixed||0).toFixed(2),Number(o.cogs||0).toFixed(2),Number(o.gross_margin||0).toFixed(2),Number(o.gross_margin_percent||0).toFixed(2)])];
    exportCsv('relatorio_consolidado.csv', rows);
  };
  const exportDetalhado = () => {
    const header = ['NF','SKU','Qtd','Receita','Comissão','Frete','Extras','COGS','Margem','Margem %'];
    const rows = [header, ...costs.items.map(i => [i.nota_id,i.sku,i.quantidade,Number(i.receita_item||0).toFixed(2),Number(i.commission_item||0).toFixed(2),Number(i.freight_item||0).toFixed(2),Number(i.extra_fixed_item||0).toFixed(2),Number(i.cogs_item||0).toFixed(2),Number(i.gross_margin_item||0).toFixed(2),Number(i.gross_margin_item_percent||0).toFixed(2)])];
    exportCsv('relatorio_itens.csv', rows);
  };

  const salvarConfig = async () => {
    await axios.post('/api/reports/marketplace-cost-config', novoConfig);
    setNovoConfig({ marketplace: '', commission_percent: 0, commission_fixed_per_order: 0, commission_fixed_per_item: 0, freight_mode: 'fixed_per_order', freight_fixed_per_order: 0, freight_fixed_per_item: 0, default_shipping_table_id: null, extra_fixed_per_order: 0 });
    fetchAll();
  };
  const salvarTabela = async () => {
    if (file) {
      const form = new FormData();
      form.append('file', file);
      form.append('marketplace', novaTabela.marketplace);
      form.append('name', novaTabela.name || 'Tabela de frete');
      form.append('rule_type', novaTabela.rule_type || 'quantity_band');
      await axios.post('/api/reports/shipping-tables/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    } else {
      await axios.post('/api/reports/shipping-tables', novaTabela);
    }
    setNovaTabela({ marketplace: '', name: '', rule_type: 'fixed_per_order', rules_json: {} });
    setFile(null);
    fetchAll();
  };

  // Importar pesos por planilha (SKU | PESO)
  const [weightsFile, setWeightsFile] = useState(null);
  const uploadWeights = async () => {
    if (!weightsFile) return;
    const form = new FormData();
    form.append('file', weightsFile);
    await axios.post('/api/reports/inventory/weights/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    setWeightsFile(null);
    toast.success('Pesos importados com sucesso');
  };

  // Importar medidas (altura, largura, comprimento, peso)
  const uploadMeasures = async () => {
    if (!measuresFile) return;
    const form = new FormData();
    form.append('file', measuresFile);
    await axios.post('/api/reports/inventory/measures/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    setMeasuresFile(null);
    toast.success('Medidas importadas com sucesso');
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Relatórios & Custos</h1>

      {/* Submenus */}
      <div className="flex items-center gap-2">
        {[
          {key:'resumo', label:'Resumo de Margens'},
          {key:'config', label:'Configurações'},
          {key:'frete', label:'Tabelas de Frete'},
          {key:'overrides', label:'Overrides por Item'}
        ].map(t => (
          <button key={t.key} onClick={()=>goTab(t.key)} className={`px-3 py-1 rounded border text-sm ${activeTab===t.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-800 text-blue-700 border-blue-300 dark:border-gray-600'}`}>{t.label}</button>
        ))}
      </div>

      {activeTab==='resumo' && (
      <Section title="Resumo de Margens" right={
        <div className="flex items-center gap-2">
          {formato === 'consolidado' ? (
            <button onClick={exportConsolidado} className="btn-secondary">Exportar CSV</button>
          ) : (
            <button onClick={exportDetalhado} className="btn-secondary">Exportar CSV</button>
          )}
          <button onClick={carregarRelatorio} className="btn-secondary">Atualizar</button>
          <button onClick={compute} className="btn-primary">Recalcular período</button>
        </div>
      }>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Data início</label>
            <input type="date" className="input" value={filtros.dataInicio} onChange={e=>setFiltros({...filtros, dataInicio: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Data fim</label>
            <input type="date" className="input" value={filtros.dataFim} onChange={e=>setFiltros({...filtros, dataFim: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Marketplace</label>
            <select className="input" value={filtros.marketplace} onChange={e=>setFiltros({...filtros, marketplace: e.target.value})}>
              <option value="">(Todos)</option>
              {marketOptions.map(mk => <option key={mk} value={mk}>{mk}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Formato</label>
            <select className="input" value={formato} onChange={e=>setFormato(e.target.value)}>
              <option value="consolidado">Consolidado (por pedido)</option>
              <option value="por-item">Detalhado (por item)</option>
            </select>
          </div>
        </div>

        {/* Cards agregados */}
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">Faturamento</div><div className="text-lg font-semibold">R$ {agg.faturamento.toFixed(2)}</div></div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">Comissão</div><div className="text-lg font-semibold">R$ {agg.commission.toFixed(2)}</div></div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">Frete</div><div className="text-lg font-semibold">R$ {agg.freight.toFixed(2)}</div></div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">Extras</div><div className="text-lg font-semibold">R$ {agg.extras.toFixed(2)}</div></div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">COGS</div><div className="text-lg font-semibold">R$ {agg.cogs.toFixed(2)}</div></div>
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3"><div className="text-xs text-gray-500">Margem %</div><div className={`text-lg font-semibold ${agg.marginPct>=0 ? 'text-green-600':'text-red-600'}`}>{agg.marginPct.toFixed(2)}%</div></div>
        </div>

        {formato === 'consolidado' ? (
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="pb-2">NF</th>
                  <th className="pb-2">Marketplace</th>
                  <th className="pb-2">Itens</th>
                  <th className="pb-2">Faturamento</th>
                  <th className="pb-2">Comissão</th>
                  <th className="pb-2">Frete</th>
                  <th className="pb-2">Extras</th>
                  <th className="pb-2">COGS</th>
                  <th className="pb-2">Margem</th>
                  <th className="pb-2">Margem %</th>
                </tr>
              </thead>
              <tbody>
                {costs.orders.map(o => (
                  <tr key={o.nota_id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-2">{o.nota_id}</td>
                    <td className="py-2">{o.marketplace}</td>
                    <td className="py-2">{o.total_itens}</td>
                    <td className="py-2">R$ {Number(o.faturamento||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(o.commission||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(o.freight||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(o.extra_fixed||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(o.cogs||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(o.gross_margin||0).toFixed(2)}</td>
                    <td className="py-2">{Number(o.gross_margin_percent||0).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="pb-2">NF</th>
                  <th className="pb-2">SKU</th>
                  <th className="pb-2">Qtd</th>
                  <th className="pb-2">Receita</th>
                  <th className="pb-2">Comissão</th>
                  <th className="pb-2">Frete</th>
                  <th className="pb-2">Extras</th>
                  <th className="pb-2">COGS</th>
                  <th className="pb-2">Margem</th>
                  <th className="pb-2">Margem %</th>
                </tr>
              </thead>
              <tbody>
                {costs.items.map(i => (
                  <tr key={i.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-2">{i.nota_id}</td>
                    <td className="py-2">{i.sku}</td>
                    <td className="py-2">{i.quantidade}</td>
                    <td className="py-2">R$ {Number(i.receita_item||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(i.commission_item||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(i.freight_item||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(i.extra_fixed_item||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(i.cogs_item||0).toFixed(2)}</td>
                    <td className="py-2">R$ {Number(i.gross_margin_item||0).toFixed(2)}</td>
                    <td className="py-2">{Number(i.gross_margin_item_percent||0).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      )}

      {activeTab==='config' && (
      <Section title="Configurações de Custos por Marketplace" right={<button onClick={salvarConfig} className="btn-primary">Salvar</button>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Marketplace</label>
            <input className="input" value={novoConfig.marketplace} onChange={e=>setNovoConfig({...novoConfig, marketplace: e.target.value})} placeholder="Mercado Livre, Shopee, ..." />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">% Comissão</label>
            <input className="input" type="number" step="0.01" value={novoConfig.commission_percent} onChange={e=>setNovoConfig({...novoConfig, commission_percent: Number(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Comissão fixa por pedido</label>
            <input className="input" type="number" step="0.01" value={novoConfig.commission_fixed_per_order} onChange={e=>setNovoConfig({...novoConfig, commission_fixed_per_order: Number(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Comissão fixa por item</label>
            <input className="input" type="number" step="0.01" value={novoConfig.commission_fixed_per_item} onChange={e=>setNovoConfig({...novoConfig, commission_fixed_per_item: Number(e.target.value)})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Base da comissão</label>
            <select className="input" value={novoConfig.commission_base} onChange={e=>setNovoConfig({...novoConfig, commission_base: e.target.value})}>
              <option value="gross">Bruto (valor da NF - desconto)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Frete - modo</label>
            <select className="input" value={novoConfig.freight_mode} onChange={e=>setNovoConfig({...novoConfig, freight_mode: e.target.value})}>
              <option value="fixed_per_order">Fixo por pedido</option>
              <option value="fixed_per_item">Fixo por item</option>
              <option value="table">Tabela</option>
            </select>
          </div>
          {novoConfig.freight_mode === 'fixed_per_order' && (
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-300">Frete fixo por pedido</label>
              <input className="input" type="number" step="0.01" value={novoConfig.freight_fixed_per_order} onChange={e=>setNovoConfig({...novoConfig, freight_fixed_per_order: Number(e.target.value)})} />
            </div>
          )}
          {novoConfig.freight_mode === 'fixed_per_item' && (
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-300">Frete fixo por item</label>
              <input className="input" type="number" step="0.01" value={novoConfig.freight_fixed_per_item} onChange={e=>setNovoConfig({...novoConfig, freight_fixed_per_item: Number(e.target.value)})} />
            </div>
          )}
          {novoConfig.freight_mode === 'table' && (
            <div>
              <label className="block text-sm text-gray-600 dark:text-gray-300">Tabela padrão</label>
              <select className="input" value={novoConfig.default_shipping_table_id || ''} onChange={e=>setNovoConfig({...novoConfig, default_shipping_table_id: e.target.value || null})}>
                <option value="">Nenhuma</option>
                {tables.filter(t=>t.marketplace===novoConfig.marketplace).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Extra fixo por pedido</label>
            <input className="input" type="number" step="0.01" value={novoConfig.extra_fixed_per_order} onChange={e=>setNovoConfig({...novoConfig, extra_fixed_per_order: Number(e.target.value)})} />
          </div>
        </div>
        <div className="mt-4">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Configurações atuais</h3>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="pb-2">Marketplace</th>
                  <th className="pb-2">% Comissão</th>
                  <th className="pb-2">Fixos (pedido/item)</th>
                  <th className="pb-2">Frete</th>
                  <th className="pb-2">Base comissão</th>
                  <th className="pb-2">Extra fixo</th>
                </tr>
              </thead>
              <tbody>
                {configs.map(c => (
                  <tr key={c.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-2">{c.marketplace}</td>
                    <td className="py-2">{c.commission_percent}%</td>
                    <td className="py-2">R$ {c.commission_fixed_per_order} / R$ {c.commission_fixed_per_item}</td>
                    <td className="py-2">{c.freight_mode}</td>
                    <td className="py-2">{c.commission_base || 'gross'}</td>
                    <td className="py-2">R$ {c.extra_fixed_per_order}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>
      )}

      {activeTab==='frete' && (
      <Section title="Tabelas de Frete" right={<button onClick={salvarTabela} className="btn-primary">Salvar</button>}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Marketplace</label>
            <input className="input" value={novaTabela.marketplace} onChange={e=>setNovaTabela({...novaTabela, marketplace: e.target.value})} placeholder="Mercado Livre, Shopee..." />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Nome</label>
            <input className="input" value={novaTabela.name} onChange={e=>setNovaTabela({...novaTabela, name: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Tipo de regra</label>
            <select className="input" value={novaTabela.rule_type} onChange={e=>setNovaTabela({...novaTabela, rule_type: e.target.value})}>
              <option value="per_item">Preço por item</option>
              <option value="quantity_band">Faixa por quantidade (pedido)</option>
              <option value="weight_band">Faixa por peso (kg do pedido)</option>
              <option value="volume_band">Faixa por volume (m³ do pedido)</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-sm text-gray-600 dark:text-gray-300">Regras (JSON)</label>
            <textarea className="input" rows={4} value={JSON.stringify(novaTabela.rules_json)} onChange={e=>{
              try { setNovaTabela({...novaTabela, rules_json: JSON.parse(e.target.value || '{}')}); } catch {}
            }} />
            <div className="text-xs text-gray-500 mt-1">Ou envie uma planilha XLSX/CSV com colunas “DE”, “ATÉ”, “VALOR1”.</div>
            <input type="file" accept=".xlsx,.xls,.csv" className="mt-2" onChange={e=>setFile(e.target.files?.[0] || null)} />
          </div>
        </div>
        <div className="mt-4">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Tabelas existentes</h3>
          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400">
                  <th className="pb-2">Marketplace</th>
                  <th className="pb-2">Nome</th>
                  <th className="pb-2">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {tables.map(t => (
                  <tr key={t.id} className="border-t border-gray-100 dark:border-gray-700">
                    <td className="py-2">{t.marketplace}</td>
                    <td className="py-2">{t.name}</td>
                    <td className="py-2">{t.rule_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="mt-6">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Importar pesos (SKU | PESO)</h3>
          <div className="flex items-center gap-3">
            <input type="file" accept=".xlsx,.xls,.csv" onChange={e=>setWeightsFile(e.target.files?.[0] || null)} />
            <button className="btn-secondary" onClick={uploadWeights} disabled={!weightsFile}>Enviar</button>
          </div>
        </div>

        <div className="mt-6">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Importar medidas (SKU | ALTURA(cm) | LARGURA(cm) | COMPRIMENTO(cm) | PESO(kg))</h3>
          <div className="flex items-center gap-3">
            <input type="file" accept=".xlsx,.xls,.csv" onChange={e=>setMeasuresFile(e.target.files?.[0] || null)} />
            <button className="btn-secondary" onClick={uploadMeasures} disabled={!measuresFile}>Enviar</button>
            <button className="btn-secondary" onClick={()=>{ window.location.href = '/api/reports/inventory/measures/export'; }}>Exportar CSV</button>
          </div>
        </div>
      </Section>
      )}

      {activeTab==='overrides' && (
      <Section title="Overrides por Item (custos específicos)">
        <Overrides skuOverrides={overrides} onChanged={fetchAll} />
      </Section>
      )}
    </div>
  );
};

export default Reports;

// ---- Subcomponente de Overrides ----
const Overrides = ({ skuOverrides, onChanged }) => {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState([]);
  const [selecionado, setSelecionado] = useState(null);
  const [form, setForm] = useState({ commission_percent_override: '', commission_fixed_override: '', extra_fixed_per_item: '', shipping_table_id_override: '' });

  useEffect(()=>{
    const load = async () => {
      if (!busca || busca.length < 2) { setResultados([]); return; }
      const res = await axios.get('/api/inventory', { params: { search: busca, limit: 10 } });
      setResultados(res.data.items || []);
    };
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [busca]);

  const salvar = async () => {
    if (!selecionado) return;
    await axios.post('/api/reports/item-cost-overrides', {
      sku_id: selecionado.id,
      commission_percent_override: form.commission_percent_override || null,
      commission_fixed_override: form.commission_fixed_override || null,
      extra_fixed_per_item: form.extra_fixed_per_item || null,
      shipping_table_id_override: form.shipping_table_id_override || null
    });
    setBusca(''); setResultados([]); setSelecionado(null); setForm({ commission_percent_override: '', commission_fixed_override: '', extra_fixed_per_item: '', shipping_table_id_override: '' });
    onChanged && onChanged();
  };

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm text-gray-600 dark:text-gray-300">Buscar SKU</label>
          <input className="input" placeholder="Digite parte do SKU ou título" value={busca} onChange={e=>setBusca(e.target.value)} />
          {resultados.length > 0 && (
            <div className="border rounded mt-1 max-h-40 overflow-auto bg-white dark:bg-gray-900">
              {resultados.map(it => (
                <button key={it.id} className="block w-full text-left px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700" onClick={()=>{ setSelecionado(it); setResultados([]); setBusca(`${it.sku} - ${it.title}`); }}>
                  {it.sku} - {it.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">% Comissão (override)</label>
            <input className="input" type="number" step="0.01" value={form.commission_percent_override} onChange={e=>setForm({...form, commission_percent_override: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Comissão fixa por item</label>
            <input className="input" type="number" step="0.01" value={form.commission_fixed_override} onChange={e=>setForm({...form, commission_fixed_override: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Extra fixo por item</label>
            <input className="input" type="number" step="0.01" value={form.extra_fixed_per_item} onChange={e=>setForm({...form, extra_fixed_per_item: e.target.value})} />
          </div>
          <div>
            <label className="block text-sm text-gray-600 dark:text-gray-300">Tabela de frete (ID override)</label>
            <input className="input" type="number" value={form.shipping_table_id_override} onChange={e=>setForm({...form, shipping_table_id_override: e.target.value})} />
          </div>
        </div>
      </div>
      <button className="btn-primary" onClick={salvar} disabled={!selecionado}>Salvar override</button>

      <div className="mt-6">
        <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Overrides existentes</h3>
        <OverridesList overrides={skuOverrides} onChanged={onChanged} />
      </div>
    </div>
  );
};

const OverridesList = ({ overrides, onChanged }) => {
  const [detalhes, setDetalhes] = useState({});

  useEffect(()=>{
    const load = async () => {
      const map = {};
      for (const ov of overrides) {
        try {
          const res = await axios.get(`/api/inventory/${ov.sku_id}`);
          map[ov.id] = res.data;
        } catch {}
      }
      setDetalhes(map);
    };
    load();
  }, [overrides]);

  const remover = async (id) => {
    await axios.delete(`/api/reports/item-cost-overrides/${id}`);
    onChanged && onChanged();
  };

  return (
    <div className="overflow-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400">
            <th className="pb-2">SKU</th>
            <th className="pb-2">Título</th>
            <th className="pb-2">% Comissão</th>
            <th className="pb-2">Fixo por item</th>
            <th className="pb-2">Extra por item</th>
            <th className="pb-2">Tabela frete (ID)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {overrides.map(ov => (
            <tr key={ov.id} className="border-top border-gray-100 dark:border-gray-700">
              <td className="py-2">{detalhes[ov.id]?.sku || `#${ov.sku_id}`}</td>
              <td className="py-2">{detalhes[ov.id]?.title || '-'}</td>
              <td className="py-2">{ov.commission_percent_override ?? '-'}</td>
              <td className="py-2">{ov.commission_fixed_override ?? '-'}</td>
              <td className="py-2">{ov.extra_fixed_per_item ?? '-'}</td>
              <td className="py-2">{ov.shipping_table_id_override ?? '-'}</td>
              <td className="py-2"><button className="text-red-600" onClick={()=>remover(ov.id)}>Remover</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};


