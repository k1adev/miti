import React, { useState, useEffect, useRef } from 'react';
import { DollarSign, ShoppingCart, Printer, RefreshCw, ExternalLink, Package, CheckCircle, X, Check } from 'lucide-react';
import axios from 'axios';
import { useLocation } from 'react-router-dom';

const ProgressBar = ({ value, max }) => {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  // Detectar modo escuro
  const isDark = typeof window !== 'undefined' && document.body.classList.contains('dark');
  return (
    <div style={{ width: '100%', margin: '16px 0', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', fontWeight: 600, fontSize: 22, color: isDark ? '#e0eaff' : '#2563eb', marginBottom: 4 }}>{percent}%</div>
      <div style={{
        width: '80%',
        height: 22,
        background: isDark ? '#232e41' : '#f3f4f6',
        borderRadius: 16,
        border: `2px solid ${isDark ? '#60a5fa' : '#2563eb'}`,
        overflow: 'hidden',
        position: 'relative',
        boxSizing: 'border-box',
      }}>
        <div style={{
          width: `${percent}%`,
          height: '100%',
          background: isDark
            ? 'linear-gradient(90deg, #60a5fa 60%, #93c5fd 100%)'
            : 'linear-gradient(90deg, #2563eb 60%, #3b82f6 100%)',
          borderRadius: 16,
          transition: 'width 0.4s cubic-bezier(.4,2,.6,1)',
        }} />
      </div>
    </div>
  );
};

export const Sales = () => {
  const [sales, setSales] = useState([]);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ 
    user_id: '', 
    product_id: '', 
    quantity: 1, 
    total_price: '' 
  });

  const [blingAuth, setBlingAuth] = useState(null);
  const [notasFiscais, setNotasFiscais] = useState([]);
  const [loadingNotas, setLoadingNotas] = useState(false);
  const [selectedNotas, setSelectedNotas] = useState([]);
  const [showBlingAuth, setShowBlingAuth] = useState(false);
  const [blingStatus, setBlingStatus] = useState('disconnected');
  const [isFetchingNotas, setIsFetchingNotas] = useState(false);
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm = String(hoje.getMonth() + 1).padStart(2, '0');
  const dd = String(hoje.getDate()).padStart(2, '0');
  const dataHoje = `${yyyy}-${mm}-${dd}`;
  const [dataInicial, setDataInicial] = useState(dataHoje);
  const [dataFinal, setDataFinal] = useState(dataHoje);
  const [filtro12h, setFiltro12h] = useState(false);
  const [aglutinar, setAglutinar] = useState(false);
  const [expedidas, setExpedidas] = useState([]);
  const [ocultarExpedidas, setOcultarExpedidas] = useState(false);
  const [processingExpedition, setProcessingExpedition] = useState(false);

  const location = useLocation();
  const [aglutinados, setAglutinados] = useState([]);
  const [visualizarAglutinado, setVisualizarAglutinado] = useState(null);
  const [loadingAglutinados, setLoadingAglutinados] = useState(false);
  const [showAglutinadosModal, setShowAglutinadosModal] = useState(false);
  const aglutinadosPerPage = 10;
  const [aglutinadosPage, setAglutinadosPage] = useState(1);

  // Progresso da importação
  const [progresso, setProgresso] = useState({ importados: 0, total: 0, status: 'idle' });
  const progressoInterval = useRef(null);
  const [totalNotasImportacao, setTotalNotasImportacao] = useState(null);

  // Sincronizar aba ativa com o parâmetro 'tab' da URL
  const params = new URLSearchParams(location.search);
  const activeTab = params.get('tab') || '';

  const tentativasBuscarNotasRef = useRef(0);
  const [erroNotas, setErroNotas] = useState('');

  useEffect(() => {
    fetchData();
    checkBlingAuth();
    fetch('/api/notas-expedidas')
      .then(res => res.json())
      .then(data => setExpedidas(data.expedidas || []));
    if (activeTab === 'historico-aglutinados') {
      fetchAglutinados();
    }
  }, [activeTab]);

  useEffect(() => {
    if (loadingNotas || isFetchingNotas) {
      setProgresso(prev => ({ ...prev, importados: 0, status: 'importando' }));
      progressoInterval.current = setInterval(async () => {
        try {
          const res = await axios.get('/api/importacao/progresso');
          setProgresso(prev => ({
            ...prev,
            importados: res.data.importados,
            status: res.data.status
          }));
        } catch {}
      }, 1000);
    } else {
      if (progressoInterval.current) clearInterval(progressoInterval.current);
      setTimeout(() => setProgresso(prev => ({ ...prev, importados: 0, status: 'idle' })), 2000);
      setTimeout(() => setTotalNotasImportacao(null), 2000);
    }
    return () => { if (progressoInterval.current) clearInterval(progressoInterval.current); };
  }, [loadingNotas, isFetchingNotas]);

  // Sempre confie no valor de total vindo do backend
  useEffect(() => {
    let mounted = true;
    axios.get('/api/importacao/progresso').then(async res => {
      if (!mounted) return;
      const prog = res.data;
      setProgresso(prev => ({ ...prev, ...prog }));
      if (prog.status === 'importando') {
        progressoInterval.current = setInterval(async () => {
          try {
            const res = await axios.get('/api/importacao/progresso');
            setProgresso(prev => ({ ...prev, importados: res.data.importados, status: res.data.status, total: res.data.total }));
          } catch {}
        }, 1000);
      }
    });
    return () => {
      mounted = false;
      if (progressoInterval.current) clearInterval(progressoInterval.current);
    };
  }, []);

  // Após a importação, se houver notas, mantenha-as no estado e exiba o painel
  const fetchNotasFiscais = async () => {
    console.log('[FRONTEND DEBUG] fetchNotasFiscais chamado - isFetchingNotas:', isFetchingNotas, 'loadingNotas:', loadingNotas);
    if (isFetchingNotas || loadingNotas) {
      console.log('[FRONTEND DEBUG] Bloqueando fetchNotasFiscais - já está em andamento');
      alert('Aguarde o carregamento das notas fiscais terminar antes de buscar novamente.');
      return;
    }
    console.log('[FRONTEND DEBUG] Iniciando fetchNotasFiscais com forcarImportacao=true');
    setIsFetchingNotas(true);
    setLoadingNotas(true);
    try {
      let params = {};
      if (dataInicial) {
        params.dataEmissaoInicial = dataInicial + (filtro12h ? ' 12:00:00' : ' 00:00:00');
      }
      if (dataFinal) params.dataEmissaoFinal = dataFinal + ' 23:59:59';
      // Primeiro, fazer a contagem para obter o total
      let totalNotas = 0;
      try {
        console.log('[FRONTEND DEBUG] Fazendo contagem inicial');
        const contagemResponse = await axios.get('/api/bling/notas-fiscais/contar', { params });
        totalNotas = contagemResponse.data.total;
        setProgresso(prev => ({ ...prev, total: totalNotas }));
        // Enviar o total ao backend e aguardar confirmação
        await axios.post('/api/importacao/total', { total: totalNotas });
      } catch (contagemError) {
        console.log('Erro na contagem inicial, continuando sem total conhecido:', contagemError.message);
      }
      // Agora fazer a importação completa
      console.log('[FRONTEND DEBUG] Chamando API com forcarImportacao=true');
      const response = await axios.get('/api/bling/notas-fiscais', { params: { ...params, forcarImportacao: true } });
      console.log('[FRONTEND DEBUG] Resposta da API:', response.status, 'dados recebidos:', response.data.data?.length || 0);
      if (response.data.data && response.data.data.length > 0) {
        setNotasFiscais(response.data.data);
      }
    } catch (error) {
      console.error('[FRONTEND DEBUG] Erro ao buscar notas fiscais:', error.response?.status, error.response?.data);
      if (error.response?.status === 401) {
        setBlingStatus('unauthorized');
        setShowBlingAuth(true);
      }
    } finally {
      console.log('[FRONTEND DEBUG] Finalizando fetchNotasFiscais');
      setLoadingNotas(false);
      setIsFetchingNotas(false);
    }
  };

  // Função para buscar apenas as notas fiscais já importadas, sem reiniciar importação
  const fetchNotasApenas = async () => {
    console.log('[FRONTEND DEBUG] fetchNotasApenas chamado - SEM forcarImportacao');
    let params = {};
    if (dataInicial) params.dataEmissaoInicial = dataInicial + (filtro12h ? ' 12:00:00' : ' 00:00:00');
    if (dataFinal) params.dataEmissaoFinal = dataFinal + ' 23:59:59';
    
    console.log('[FRONTEND DEBUG] Parâmetros para fetchNotasApenas:', params);
    
    try {
      console.log('[FRONTEND DEBUG] Chamando API SEM forcarImportacao');
      const response = await axios.get('/api/bling/notas-fiscais', { params });
      console.log('[FRONTEND DEBUG] fetchNotasApenas - resposta:', response.status, 'dados:', response.data.data?.length || 0);
      if (response.data.data && response.data.data.length > 0) {
        setNotasFiscais(response.data.data);
      }
    } catch (error) {
      console.error('[FRONTEND DEBUG] Erro em fetchNotasApenas:', error.response?.status, error.response?.data);
    }
  };

  // Limpar cache ao finalizar importação
  useEffect(() => {
    if (progresso.status !== 'importando') {
      localStorage.removeItem('miti_totalNotasImportacao');
    }
  }, [progresso.status]);

  // Buscar notas fiscais automaticamente ao concluir a importação
  useEffect(() => {
    console.log('[FRONTEND DEBUG] useEffect progresso.status mudou:', progresso.status, 'notasFiscais.length:', notasFiscais.length);
    if (progresso.status === 'concluido' && notasFiscais.length === 0) {
      tentativasBuscarNotasRef.current += 1;
      if (tentativasBuscarNotasRef.current <= 2) {
        console.log('[FRONTEND DEBUG] Chamando fetchNotasApenas porque importação concluída e não há notas, tentativa', tentativasBuscarNotasRef.current);
      fetchNotasApenas();
      } else {
        setErroNotas('Não foi possível obter as notas fiscais após a importação. Tente novamente ou verifique o backend.');
      }
    } else if (progresso.status !== 'concluido') {
      tentativasBuscarNotasRef.current = 0;
      setErroNotas('');
    }
    // eslint-disable-next-line
  }, [progresso.status]);

  // Certifique-se de que a função está definida antes do JSX
  const handleNotaSelection = (notaId) => {
    setSelectedNotas(prev =>
      prev.includes(notaId)
        ? prev.filter(id => id !== notaId)
        : [...prev, notaId]
    );
  };

  const fetchData = async () => {
    try {
      const [salesRes, productsRes, usersRes] = await Promise.all([
        axios.get('/api/sales'),
        axios.get('/api/products'),
        axios.get('/api/users')
      ]);
      
      setSales(salesRes.data);
      setProducts(productsRes.data);
      setUsers(usersRes.data);
    } catch (error) {
      console.error('Erro ao carregar dados:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      await axios.post('/api/sales', formData);
      setFormData({ user_id: '', product_id: '', quantity: 1, total_price: '' });
      setShowForm(false);
      fetchData();
    } catch (error) {
      console.error('Erro ao salvar venda:', error);
      alert('Erro ao salvar venda. Verifique os dados.');
    }
  };

  const calculateTotal = () => {
    const product = products.find(p => p.id == formData.product_id);
    if (product && formData.quantity) {
      return (product.price * formData.quantity).toFixed(2);
    }
    return 0;
  };

  const formatPrice = (price) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(price || 0);
  };

  const checkBlingAuth = async () => {
    try {
      const response = await axios.get('/api/bling/auth');
      setBlingAuth(response.data);
      setBlingStatus('ready');
    } catch (error) {
      console.error('Erro ao verificar auth Bling:', error);
      setBlingStatus('error');
    }
  };

  const aglutinarPedidos = () => {
    const pedidosSelecionados = notasFiscais.filter(nota => selectedNotas.includes(nota.id));
    
    const itensAgrupados = {};
    
    pedidosSelecionados.forEach(nota => {
      nota.itens?.forEach(item => {
        const skuOriginal = item.codigo || 'SKU-NÃO-INFORMADO';
        const sku = limparSkuB(skuOriginal);
        if (!itensAgrupados[sku]) {
          itensAgrupados[sku] = {
            sku: skuOriginal,
            titulo: item.descricao || 'Produto não informado',
            quantidade: 0,
            localizacao: item.localizacao || '',
            saldo: item.saldo
          };
        }
        itensAgrupados[sku].quantidade += parseInt(item.quantidade) || 0;
        if (item.localizacao && !itensAgrupados[sku].localizacao.includes(item.localizacao)) {
          if (itensAgrupados[sku].localizacao) {
            itensAgrupados[sku].localizacao += ', ' + item.localizacao;
          } else {
            itensAgrupados[sku].localizacao = item.localizacao;
          }
        }
      });
    });

    return Object.values(itensAgrupados).map(item => ({
      ...item,
      marketplaces: Array.from(item.marketplaces).join(', '),
      localizacao: item.localizacao || 'Não informado'
    }));
  };

  // Função para buscar saldo de unitários e kits para um SKU (com logs detalhados)
  async function buscarSaldosUnitarioEKit(skuBase) {
    let unitario = null;
    let kits = [];
    let componentes = [];
    let componentesDetalhados = [];
    try {
      const res = await axios.get(`/api/inventory`, { params: { search: skuBase } });
      if (Array.isArray(res.data.items)) {
        console.log('[MovInteligente] Itens encontrados para', skuBase, JSON.parse(JSON.stringify(res.data.items)));
        unitario = res.data.items.find(p => p.sku === skuBase && !p.is_composite);
        kits = res.data.items.filter(p => p.is_composite && (p.sku.includes(skuBase) || p.sku.replace(/B$/, '') === skuBase));
        if (kits.length === 0) {
          kits = res.data.items.filter(p => p.is_composite);
        }
        // Se encontrar kit/composto, buscar componentes detalhados
        if (kits.length > 0) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${kits[0].id}`);
            if (Array.isArray(resComp.data) && resComp.data.length > 0) {
              for (const comp of resComp.data) {
                const compSku = comp.component_sku;
                try {
                  const resCompInv = await axios.get(`/api/inventory`, { params: { search: compSku } });
                  const compUnit = Array.isArray(resCompInv.data.items) ? resCompInv.data.items.find(p => p.sku === compSku && !p.is_composite) : null;
                  if (compUnit) {
                    componentesDetalhados.push({ ...compUnit, quantidadeNoComposto: comp.quantity });
                  }
                } catch (e) {
                  console.warn('[MovInteligente] Erro ao buscar detalhe do componente:', compSku, e);
                }
              }
            }
          } catch (e) {
            console.warn('[MovInteligente] Erro ao buscar componentes do kit:', e);
          }
        }
        console.log('[MovInteligente] Unitário:', unitario, 'Kits:', kits, 'Componentes:', componentes, 'ComponentesDetalhados:', componentesDetalhados);
      }
    } catch (e) {
      console.warn('[MovInteligente] Erro ao buscar saldos:', e);
    }
    return { unitario, kits, componentesDetalhados };
  }

  // Movimentação inteligente
  const movimentarEstoqueAposImpressao = async () => {
    setProcessingExpedition(true);
    try {
      const notasParaExpedir = notasFiscais.filter(nota => selectedNotas.includes(nota.id) && !expedidas.includes(nota.id));
      if (notasParaExpedir.length === 0) return;
      for (const nota of notasParaExpedir) {
        for (const item of (nota.itens || [])) {
          if (!item.codigo || !item.quantidade) continue;
          const skuOriginal = item.codigo;
          const skuBase = limparSkuB(skuOriginal);
          // Buscar saldos unitário, kits e componentes detalhados
          const { unitario, kits, componentesDetalhados } = await buscarSaldosUnitarioEKit(skuBase);
          // Determinar fator de conversao do kit para unidades
          let fatorConversao = 1;
          if (kits && kits.length > 0) {
            try {
              const resComp = await axios.get(`/api/composite-skus/${kits[0].id}`);
              if (Array.isArray(resComp.data) && resComp.data.length > 0) {
                fatorConversao = Number(resComp.data[0].quantity) || 1;
              }
            } catch {}
          }
          // quantidadeRestante deve ser o total de unidades convertidas
          let quantidadeRestante = Number(item.quantidade) * fatorConversao;
          // 1. Se houver componentes detalhados, movimentar primeiro os componentes unitários
          if (componentesDetalhados && componentesDetalhados.length > 0) {
            for (const compUnit of componentesDetalhados) {
              console.log(`[MovInteligente] Tentando movimentar componente unitário:`, compUnit);
              if (!compUnit) {
                console.warn(`[MovInteligente] Componente unitário não encontrado para SKU do componente.`);
                continue;
              }
              // Buscar a quantidade necessária de cada componente (qtdCompNecessaria = quantidade do pedido * quantidade do componente no composto)
              const qtdCompNecessaria = (Number(item.quantidade) || 0) * (Number(compUnit.quantidadeNoComposto) || 1);
              let saldoComp = compUnit.quantity;
              let qtdParaDebitar = qtdCompNecessaria;
              while (saldoComp > 0 && qtdParaDebitar > 0) {
                const qtdMov = Math.min(saldoComp, qtdParaDebitar);
                console.log(`[MovInteligente] Movimentando ${qtdMov} unidade(s) do componente unitário ${compUnit.sku} (id: ${compUnit.id}) para SKU ${skuBase}`);
                await axios.post(`/api/inventory/${compUnit.id}/movement`, {
                  movement_type: 'out',
                  quantity: qtdMov,
                  reason: `Separação de pedido (componente de ${skuBase})`
                });
                qtdParaDebitar -= qtdMov;
                // Buscar saldo atualizado do componente após movimentação
                try {
                  const resCompInvAtual = await axios.get(`/api/inventory`, { params: { search: compUnit.sku } });
                  const compUnitAtual = Array.isArray(resCompInvAtual.data.items) ? resCompInvAtual.data.items.find(p => p.sku === compUnit.sku && !p.is_composite) : null;
                  saldoComp = compUnitAtual ? compUnitAtual.quantity : 0;
                  console.log(`[MovInteligente] Após movimentação: saldoComp atualizado=${saldoComp}, quantidadeRestante=${quantidadeRestante}`);
                } catch (e) {
                  console.warn('[MovInteligente] Erro ao buscar saldo atualizado do componente:', compUnit.sku, e);
                  saldoComp = 0;
                }
              }
              if (saldoComp <= 0 && quantidadeRestante > 0) {
                console.warn(`[MovInteligente] Componente unitário ${compUnit.sku} (id: ${compUnit.id}) ficou sem saldo. Ainda faltam ${quantidadeRestante} unidade(s).`);
              }
            }
          }
          // 2. Movimentar unitários do próprio SKU (caso não seja composto ou ainda reste)
          if (unitario && unitario.id && unitario.quantity > 0 && quantidadeRestante > 0) {
            const qtdMov = Math.min(unitario.quantity, quantidadeRestante);
            console.log(`[MovInteligente] Movimentando ${qtdMov} unitário(s) do SKU ${skuBase} (id: ${unitario.id})`);
            await axios.post(`/api/inventory/${unitario.id}/movement`, {
              movement_type: 'out',
              quantity: qtdMov,
              reason: 'Separação de pedido (unitário)'
            });
            quantidadeRestante -= qtdMov;
          }
          // 3. Se faltar, movimentar kits/compostos (um por vez, para cobrir qualquer resto)
          for (const kit of kits) {
            if (kit && kit.id && kit.quantity > 0 && quantidadeRestante > 0) {
              // Descobrir quantas unidades cada kit representa
              let unidadesPorKit = 1;
              try {
                const resComp = await axios.get(`/api/composite-skus/${kit.id}`);
                if (Array.isArray(resComp.data) && resComp.data.length === 1) {
                  unidadesPorKit = Number(resComp.data[0].quantity) || 1;
                }
              } catch {}
              let kitsNecessarios = Math.ceil(quantidadeRestante / unidadesPorKit);
              const kitsParaMovimentar = Math.min(kit.quantity, kitsNecessarios);
              const unidadesMovimentadas = kitsParaMovimentar * unidadesPorKit;
              if (kitsParaMovimentar > 0) {
                console.log(`[MovInteligente] Movimentando ${kitsParaMovimentar} kit(s) (id: ${kit.id}, SKU: ${kit.sku}, ${unidadesPorKit} un/kit) para cobrir ${quantidadeRestante} unidades`);
                await axios.post(`/api/inventory/${kit.id}/movement`, {
                  movement_type: 'out',
                  quantity: kitsParaMovimentar,
                  reason: 'Separação de pedido (kit/composto)'
                });
                quantidadeRestante -= unidadesMovimentadas;
              }
            }
          }
          // 4. Se ainda faltar, logar/alertar
          if (quantidadeRestante > 0) {
            console.warn(`Não foi possível movimentar ${quantidadeRestante} unidade(s) do SKU ${skuBase}. Saldo insuficiente.`);
          }
        }
        await axios.post('/api/notas-expedidas', {
          id: nota.id,
          numero: nota.numero,
          codigo: nota.itens && nota.itens[0] ? nota.itens[0].codigo : '',
          numeroLoja: nota.numeroLoja,
          cliente: nota.cliente,
          valorNota: nota.valorNota || 0
        });
      }
      // Atualizar lista de expedidas
      const res = await axios.get('/api/notas-expedidas');
      setExpedidas(res.data.expedidas || []);
      // Atualizar estoque/produtos para garantir saldos corretos no próximo aglutinado
      await fetchData();
      // Pequeno delay para garantir atualização do backend
      await new Promise(resolve => setTimeout(resolve, 400));
    } finally {
      setProcessingExpedition(false);
    }
  };

  const buscarTitulosEstoqueParaAglutinado = async (itensAgrupados) => {
    const skus = Object.keys(itensAgrupados);
    for (const sku of skus) {
      const skuLimpo = limparSkuB(sku);
      if (!skuLimpo) continue;
      try {
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo } });
        const produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto && produto.title) {
          itensAgrupados[sku].titulo = produto.title;
        }
      } catch (e) {
        // Se não encontrar, mantém o título original
      }
    }
  };

  const imprimirPedidosIndividuais = async (dataExpedicaoParam) => {
    const dataExpedicao = dataExpedicaoParam || expeditionDate || new Date().toISOString().slice(0,10);
    const pedidosSelecionados = notasFiscais.filter(nota => selectedNotas.includes(nota.id));
    // Buscar saldo correto para todos os SKUs de todos os pedidos selecionados
    const allSkus = Array.from(new Set(pedidosSelecionados.flatMap(nota => (nota.itens || []).map(item => item.codigo || 'SKU-NÃO-INFORMADO'))));
    const saldoMap = await getCompositeStocksForSkus(allSkus);
    // Buscar títulos do estoque para cada SKU sem letras
    const skuToTitle = {};
    allSkus.forEach(sku => {
      const skuSemLetras = sku.replace(/[a-zA-Z]+/g, '');
      const prod = products.find(p => p.sku === skuSemLetras);
      if (prod && prod.title) skuToTitle[sku] = prod.title;
    });
    // Novo: converter kits em unitários e agrupar
    const inventoryCache = {};
    const pedidosConvertidos = [];
    for (const nota of pedidosSelecionados) {
      const itensConvertidos = [];
      for (const item of (nota.itens || [])) {
        const convertido = await converterKitParaUnitario(item, inventoryCache);
        itensConvertidos.push(convertido);
      }
      pedidosConvertidos.push({ ...nota, itens: itensConvertidos });
    }
    // Renderização
    const conteudo = `
      <html>
        <head>
          <title>Pedidos</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; font-size: 13px; text-align: left; }
            .bloco-borda { border: 1px solid #bbb; border-radius: 6px; padding: 18px; margin-bottom: 24px; background: #fff; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
            th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
            th { background-color: #f2f2f2; }
            .header { margin-bottom: 16px; font-size: 15px; text-align: left; display: flex; justify-content: space-between; align-items: center; }
            .footer { margin-top: 16px; font-size: 11px; text-align: left; }
            .page-break { page-break-after: always; }
          </style>
        </head>
        <body>
          ${pedidosConvertidos.map(nota => {
            // Agrupar itens por SKU unitário
            const itensAgrupados = {};
            nota.itens.forEach(item => {
              const sku = item.sku;
              if (!itensAgrupados[sku]) {
                itensAgrupados[sku] = {
                  sku: sku,
                  titulo: item.titulo,
                  quantidade: 0,
                  localizacao: item.localizacao || '',
                  saldo: item.saldo
                };
              }
              itensAgrupados[sku].quantidade += parseInt(item.quantidade) || 0;
              if (item.localizacao && !itensAgrupados[sku].localizacao.includes(item.localizacao)) {
                if (itensAgrupados[sku].localizacao) {
                  itensAgrupados[sku].localizacao += ', ' + item.localizacao;
                } else {
                  itensAgrupados[sku].localizacao = item.localizacao;
                }
              }
            });
            // Atualizar saldo dos itens do pedido
            Object.keys(itensAgrupados).forEach(sku => {
              if (saldoMap[sku] !== undefined) {
                itensAgrupados[sku].saldo = saldoMap[sku];
              }
              // Atualizar título do estoque se existir
              const skuSemLetras = sku.replace(/[a-zA-Z]+/g, '');
              if (skuToTitle[sku]) {
                itensAgrupados[sku].titulo = skuToTitle[sku];
              } else if (skuSemLetras && products.find(p => p.sku === skuSemLetras)) {
                itensAgrupados[sku].titulo = products.find(p => p.sku === skuSemLetras).title;
              }
            });
            return `
              <div class=\"bloco-borda\">
                <div class=\"header\">
                  <div>
                  <h2 style=\"font-size:18px;\">Pedido</h2>
                  <p>Nome: ${nota.cliente || 'Cliente não informado'}</p>
                  <p>Número: ${nota.numero}</p>
                    <p>Número Loja: ${nota.numeroLoja || '-'} </p>
                    <p>Marketplace: ${exibirMarketplace(nota)} </p>
                  <p>Data de Emissão: ${nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleDateString('pt-BR') : 'Não informada'}</p>
                  </div>
                  <div style=\"text-align:right;font-weight:bold;min-width:160px;\">Data de Expedição:<br>${dataExpedicao.split('-').reverse().join('/')}</div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Título</th>
                      <th>Quantidade</th>
                      <th>Localização</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${Object.values(itensAgrupados).map(item => `
                      <tr>
                        <td>${removerLetrasSku(item.sku)}</td>
                        <td>${item.titulo}</td>
                        <td style=\"text-align: center; vertical-align: middle;\">${item.quantidade}</td>
                        <td style=\"text-align: center; vertical-align: middle;\">${item.localizacao || '-'}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
              <div class=\"page-break\"></div>
            `;
          }).join('')}
        </body>
      </html>
    `;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(conteudo);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(async () => {
      printWindow.print();
      printWindow.close();
      // Só movimenta estoque se houver pedidos não expedidos
      if (pedidosSelecionados.some(nota => !expedidas.includes(nota.id))) {
        await movimentarEstoqueAposImpressao();
      }
    }, 500);
  };

  // Função utilitária para buscar saldo correto de vários SKUs (kits/compostos)
  const getCompositeStocksForSkus = async (skus) => {
    const saldoMap = {};
    await Promise.all(skus.map(async (sku) => {
      const skuLimpo = limparSkuB(sku);
      try {
        // Buscar produto pelo SKU limpo SEMPRE do backend
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo, t: Date.now() } });
        const produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto && produto.is_composite) {
          const saldo = await getCompositeStock(produto.id);
          saldoMap[sku] = saldo;
        } else if (produto) {
          saldoMap[sku] = produto.quantity;
        }
      } catch {}
    }));
    return saldoMap;
  };

  // Função utilitária para buscar saldo de kit/composto
  const getCompositeStock = async (produtoId) => {
    try {
      const res = await axios.get(`/api/inventory/${produtoId}/composite-stock`);
      return res.data.max_possible;
    } catch {
      return 0;
    }
  };

  // Função utilitária: identifica se um SKU é kit e retorna info do componente
  async function converterKitParaUnitario(item, inventoryCache) {
    // Busca o produto pelo SKU
    let produto = null;
    const skuLimpo = limparSkuB(item.codigo);
    console.log('[CONVERSÃO KIT] SKU original:', item.codigo, 'SKU limpo:', skuLimpo);
    
    if (inventoryCache[skuLimpo]) {
      produto = inventoryCache[skuLimpo];
      console.log('[CONVERSÃO KIT] Produto encontrado no cache:', produto);
    } else {
      try {
        const resInv = await axios.get(`/api/inventory`, { params: { search: skuLimpo } });
        produto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === skuLimpo) : null;
        if (produto) {
          inventoryCache[skuLimpo] = produto;
          console.log('[CONVERSÃO KIT] Produto encontrado no backend:', produto);
        } else {
          console.log('[CONVERSÃO KIT] Produto NÃO encontrado no backend para SKU:', skuLimpo);
        }
      } catch (e) {
        console.log('[CONVERSÃO KIT] Erro ao buscar produto:', e);
      }
    }
    
    if (produto && produto.is_composite) {
      console.log('[CONVERSÃO KIT] Produto é composto, buscando componentes...');
      // Buscar componentes do kit
      try {
        const resComp = await axios.get(`/api/composite-skus/${produto.id}`);
        const componentes = resComp.data;
        console.log('[CONVERSÃO KIT] Componentes encontrados:', componentes);
        if (componentes.length === 1) {
          // É kit simples: converter normalmente
          const comp = componentes[0];
          console.log('[CONVERSÃO KIT] Componente único:', comp);
          // Buscar info do componente unitário
          let compProduto = null;
          const compSkuLimpo = limparSkuB(comp.component_sku);
          if (inventoryCache[compSkuLimpo]) {
            compProduto = inventoryCache[compSkuLimpo];
          } else {
            const resInv2 = await axios.get(`/api/inventory`, { params: { search: compSkuLimpo } });
            compProduto = Array.isArray(resInv2.data.items) ? resInv2.data.items.find(p => p.sku === compSkuLimpo) : null;
            if (compProduto) inventoryCache[compSkuLimpo] = compProduto;
          }
          if (compProduto) {
            console.log('[CONVERSÃO KIT] Kit convertido com sucesso para:', compProduto.sku);
            return {
              sku: compProduto.sku,
              titulo: compProduto.title,
              quantidade: (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1),
              localizacao: compProduto.location || '',
              saldo: compProduto.quantity,
              originalKit: item.codigo
            };
          } else {
            console.log('[CONVERSÃO KIT] Componente unitário não encontrado para SKU:', compSkuLimpo);
          }
        } else if (componentes.length > 1) {
          // É composto: NÃO converter, retornar o item original
          console.log('[CONVERSÃO KIT] Produto é composto (não kit). Não converter.');
          return {
            sku: item.codigo || 'SKU-NÃO-INFORMADO',
            titulo: item.descricao || 'Produto não informado',
            quantidade: parseInt(item.quantidade) || 0,
            localizacao: item.localizacao || '',
            saldo: item.saldo,
            originalKit: null
          };
        }
      } catch (e) {
        console.log('[CONVERSÃO KIT] Erro ao buscar componentes:', e);
      }
    } else {
      console.log('[CONVERSÃO KIT] Produto não é composto ou não foi encontrado. Retornando item original.');
    }
    // Não é kit, retorna o próprio item
    return {
      sku: item.codigo || 'SKU-NÃO-INFORMADO',
      titulo: item.descricao || 'Produto não informado',
      quantidade: parseInt(item.quantidade) || 0,
      localizacao: item.localizacao || '',
      saldo: item.saldo,
      originalKit: null
    };
  }

  // Alerta amigável para erro de componentes insuficientes
  // (Removido bloco solto que usava pedidosSelecionados e itensAgrupados fora de função)

  const imprimirPedidos = async (dataExpedicaoParam) => {
    const dataExpedicao = dataExpedicaoParam || expeditionDate || new Date().toISOString().slice(0,10);
    if (selectedNotas.length === 0) return;
    if (aglutinar) {
      const pedidosSelecionados = notasFiscais.filter(nota => selectedNotas.includes(nota.id));
      // Novo agrupamento: por SKU unitário, somando quantidades e juntando marketplaces
      const itensAgrupados = {};
      const inventoryCache = {};
      // Novo: mapa de produção por SKU
      const producaoPorSku = {};
      for (const nota of pedidosSelecionados) {
        for (const item of (nota.itens || [])) {
          const convertido = await converterKitParaUnitario(item, inventoryCache);
          const chave = limparSkuB(convertido.sku);
          if (!itensAgrupados[chave]) {
            itensAgrupados[chave] = {
              sku: convertido.sku,
              titulo: convertido.titulo,
              quantidade: 0,
              localizacao: convertido.localizacao || '',
              saldo: convertido.saldo,
              marketplaces: new Set(),
            };
          }
          itensAgrupados[chave].quantidade += convertido.quantidade;
          if (item.localizacao && !itensAgrupados[chave].localizacao.includes(item.localizacao)) {
            if (itensAgrupados[chave].localizacao) {
              itensAgrupados[chave].localizacao += ', ' + item.localizacao;
            } else {
              itensAgrupados[chave].localizacao = item.localizacao;
            }
          }
          // Adiciona marketplace ao Set
          const marketplace = exibirMarketplace(nota, item);
          if (marketplace && typeof marketplace === 'string' && marketplace.trim() !== '') {
            itensAgrupados[chave].marketplaces.add(marketplace.trim());
          }
        }
      }
      // Buscar saldo correto para kits/compostos
      const saldoMap = await getCompositeStocksForSkus(Object.values(itensAgrupados).map(i => i.sku));
      Object.values(itensAgrupados).forEach(item => {
        if (saldoMap[item.sku] !== undefined) {
          item.saldo = saldoMap[item.sku];
        }
      });
      // Buscar títulos do estoque para cada SKU aglutinado
      await buscarTitulosEstoqueParaAglutinado(itensAgrupados);

      // NOVO: calcular produção necessária para SKUs compostos
      console.log('[PRODUÇÃO] Iniciando cálculo de produção para', Object.values(itensAgrupados).length, 'itens');
      for (const item of Object.values(itensAgrupados)) {
        // Buscar detalhes do produto diretamente do inventário
        let produtoPrincipal = null;
        try {
          const resInvPrincipal = await axios.get(`/api/inventory`, { params: { search: item.sku } });
          produtoPrincipal = Array.isArray(resInvPrincipal.data.items) ? resInvPrincipal.data.items.find(p => p.sku === item.sku) : null;
          console.log('[PRODUÇÃO] Buscando produto principal para SKU:', item.sku, 'Encontrado:', !!produtoPrincipal, 'É composto:', produtoPrincipal?.is_composite);
        } catch (e) {
          console.log('[PRODUÇÃO] Erro ao buscar produto principal:', e);
        }
        if (produtoPrincipal && produtoPrincipal.is_composite && (item.saldo === undefined || item.saldo < item.quantidade)) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${produtoPrincipal.id}`);
            const componentes = resComp.data;
            if (Array.isArray(componentes) && componentes.length > 0) {
              for (const comp of componentes) {
                let compProduto = null;
                try {
                  const resInv = await axios.get(`/api/inventory`, { params: { search: comp.component_sku } });
                  compProduto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === comp.component_sku && !p.is_composite) : null;
                } catch {}
                let compTitle = compProduto ? compProduto.title : comp.component_sku;
                let saldoComp = compProduto ? compProduto.quantity : 0;
                const qtdNecessaria = (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1);
                if (saldoComp < qtdNecessaria) {
                  if (!producaoPorSku[item.sku]) producaoPorSku[item.sku] = [];
                  producaoPorSku[item.sku].push(`${qtdNecessaria - saldoComp} un ${compTitle}`);
                }
              }
            }
          } catch {}
        }
      }

      // Atualizar producaoPorSku com saldo atualizado dos componentes
      for (const item of Object.values(itensAgrupados)) {
        const produto = products.find(p => p.sku === item.sku);
        if (produto && produto.is_composite) {
          try {
            const resComp = await axios.get(`/api/composite-skus/${produto.id}`);
            const componentes = resComp.data;
            if (Array.isArray(componentes) && componentes.length > 0) {
              for (const comp of componentes) {
                let compProduto = null;
                try {
                  const resInv = await axios.get(`/api/inventory`, { params: { search: comp.component_sku } });
                  compProduto = Array.isArray(resInv.data.items) ? resInv.data.items.find(p => p.sku === comp.component_sku) : null;
                } catch {}
                let compTitle = compProduto ? compProduto.title : comp.component_sku;
                let saldoComp = compProduto ? compProduto.quantity : 0;
                const qtdNecessaria = (parseInt(item.quantidade) || 0) * (parseInt(comp.quantity) || 1);
                if (saldoComp < qtdNecessaria) {
                  if (!producaoPorSku[item.sku]) producaoPorSku[item.sku] = [];
                  producaoPorSku[item.sku].push(`${qtdNecessaria - saldoComp} un ${compTitle}`);
                }
              }
            }
          } catch {}
        }
      }

      // Renderização da tabela
      const conteudo = `
        <html>
          <head>
            <title>Pedidos Aglutinados</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; font-size: 13px; }
              .bloco-borda { border: 1px solid #bbb; border-radius: 6px; padding: 18px; margin-bottom: 24px; background: #fff; }
              table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px; }
              th, td { border: 1px solid #ddd; padding: 6px; text-align: left; }
              th { background-color: #f2f2f2; }
              .header { margin-bottom: 16px; font-size: 15px; text-align: left; display: flex; justify-content: space-between; align-items: center; }
              .footer { margin-top: 16px; font-size: 11px; text-align: left; }
            </style>
          </head>
          <body>
            <div class="bloco-borda">
              <div class="header" style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">
                <div style="min-width:220px;max-width:320px;">
                  <h2 style="font-size:18px;margin-bottom:8px;">Pedidos Aglutinados</h2>
                  <div style="font-size:12px;line-height:1.4;">${pedidosSelecionados.map(nota => `${nota.cliente || 'Cliente não informado'} (NF: ${nota.numero})`).join('<br/>')}</div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:180px;">
                  <div style="font-weight:bold;font-size:15px;">Data de Expedição: <span style="font-weight:600;">${dataExpedicao.split('-').reverse().join('/')}</span></div>
                  <div style="font-size:13px;">Total de pedidos: ${selectedNotas.length}</div>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Título</th>
                    <th>Quantidade</th>
                    <th>Localização</th>
                    <th>Saldo</th>
                    <th>Produção</th>
                    <th>Marketplace(s)</th>
                  </tr>
                </thead>
                <tbody>
                  ${Object.values(itensAgrupados)
                    .sort((a, b) => parseInt(a.sku) - parseInt(b.sku))
                    .map(item => {
                      const saldoNum = parseInt(item.saldo) || 0;
                      const qtdNum = parseInt(item.quantidade) || 0;
                      let producao = '';
                      // Adiciona log para depuração
                      console.log('[AGLUTINADO PRODUCAO DEBUG]', item.sku, producaoPorSku[item.sku]);
                      if (producaoPorSku[item.sku] && producaoPorSku[item.sku].length > 0) {
                        producao = producaoPorSku[item.sku].join('<br/>');
                      } else if (saldoNum < qtdNum) {
                        producao = (qtdNum - saldoNum) + ' un.';
                      } else {
                        producao = '';
                      }
                      return `
                        <tr>
                          <td>${removerLetrasSku(item.sku)}</td>
                          <td>${item.titulo}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.quantidade}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.localizacao || '-'}</td>
                          <td style="text-align: center; vertical-align: middle;">${item.saldo !== undefined ? item.saldo : '-'}</td>
                          <td style="color: red; font-weight: bold; text-align: center; vertical-align: middle;">${producao}</td>
                          <td style="text-align: center; vertical-align: middle;">${Array.from(item.marketplaces).map(mk => mk === 'EBAZAR.COM.BR LTDA' ? 'Mercado Livre Full' : mk).join(', ')}</td>
                        </tr>
                      `;
                    }).join('')}
                </tbody>
              </table>
            </div>
            <div class="footer" style="margin-top:16px;font-size:13px;text-align:right;">Data: ${new Date().toLocaleDateString('pt-BR')}</div>
          </body>
        </html>
      `;
      // Log para debug visual do HTML gerado
      console.log('[AGLUTINADO HTML]', conteudo);
      const printWindow = window.open('', '_blank');
      printWindow.document.write(conteudo);
      printWindow.document.close();
      printWindow.focus();
      // Salvar aglutinado no backend
      try {
        await axios.post('/api/aglutinados', {
          marketplaces: Array.from(new Set(pedidosSelecionados.map(n => n.marketplace))).join(', '),
          conteudo_html: conteudo,
          conteudo_json: JSON.stringify(pedidosSelecionados)
        });
      } catch (e) {
        console.error('Erro ao salvar aglutinado:', e);
      }
      setTimeout(async () => {
        printWindow.print();
        printWindow.close();
        // Só movimenta estoque se houver pedidos não expedidos
        if (pedidosSelecionados.some(nota => !expedidas.includes(nota.id))) {
          await movimentarEstoqueAposImpressao();
        }
      }, 500);
    } else {
      await imprimirPedidosIndividuais(dataExpedicao);
    }
  };

  const agruparPorMarketplace = (notas) => {
    const marketplaces = {};
    notas.forEach(nota => {
      const mk = exibirMarketplace(nota) || 'Desconhecido';
      if (!marketplaces[mk]) marketplaces[mk] = [];
      marketplaces[mk].push(nota);
    });
    return marketplaces;
  };

  const fetchAglutinados = async () => {
    setLoadingAglutinados(true);
    try {
      const res = await axios.get('/api/aglutinados');
      setAglutinados(res.data);
    } catch {
      setAglutinados([]);
    }
    setLoadingAglutinados(false);
  };

  const handleVisualizarAglutinado = async (id) => {
    try {
      const res = await axios.get(`/api/aglutinados/${id}`);
      setVisualizarAglutinado(res.data);
    } catch {
      setVisualizarAglutinado(null);
    }
  };

  const handleImprimirAglutinado = (conteudo_html) => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(conteudo_html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 500);
  };

  // Paginação do histórico de aglutinados (definir dentro do componente, antes do JSX do modal)
  const totalAglutinados = aglutinados.length;
  const totalPages = Math.ceil(totalAglutinados / aglutinadosPerPage);
  const paginatedAglutinados = aglutinados.slice((aglutinadosPage - 1) * aglutinadosPerPage, aglutinadosPage * aglutinadosPerPage);

  const [showPrintMenu, setShowPrintMenu] = useState(false);
  const [expeditionDate, setExpeditionDate] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Função para abrir menu e definir data de expedição
  const handlePrintMenu = () => setShowPrintMenu(v => !v);
  const handleExpedirHoje = () => {
    const hoje = new Date();
    const yyyy = hoje.getFullYear();
    const mm = String(hoje.getMonth() + 1).padStart(2, '0');
    const dd = String(hoje.getDate()).padStart(2, '0');
    setExpeditionDate(`${yyyy}-${mm}-${dd}`);
    setShowPrintMenu(false);
    setShowDatePicker(false);
    imprimirPedidosComData(`${yyyy}-${mm}-${dd}`);
  };
  const handleSelecionarData = () => {
    setShowDatePicker(true);
    setShowPrintMenu(false);
  };
  const handleDateChange = (e) => {
    setExpeditionDate(e.target.value);
  };
  const handleConfirmarData = () => {
    if (expeditionDate) {
      setShowDatePicker(false);
      imprimirPedidosComData(expeditionDate);
    }
  };

  // Função wrapper para impressão com data
  const imprimirPedidosComData = async (dataExpedicao) => {
    await imprimirPedidos(dataExpedicao);
  };

  // Função utilitária para normalizar SKU removendo letras do final (inclusive B)
  function normalizarSku(sku) {
    if (!sku) return '';
    // Remove apenas letras do final, preservando números, hífens, etc.
    return sku.replace(/[a-zA-Z]+$/, '');
  }

  // Função utilitária para exibir marketplace padronizado
  function exibirMarketplace(nota, item) {
    // Se o cliente for EBAZAR.COM.BR LTDA, é Mercado Livre Full
    if ((nota?.cliente || item?.cliente) && (nota?.cliente || item?.cliente).toUpperCase().includes('EBAZAR.COM.BR LTDA')) {
      return 'Mercado Livre Full';
    }
    // Caso contrário, retorna o marketplace padrão
    return (item?.marketplace || nota?.marketplace || '-');
  }

  // Função para gerar chave única por SKU + marketplace
  function chaveAgrupamento(item, nota) {
    return `${normalizarSku(item.codigo || 'SKU-NÃO-INFORMADO')}|${item.marketplace || nota.marketplace || '-'}`;
  }

  function removerLetrasSku(sku) {
    return (sku || '').replace(/[a-zA-Z]+/g, '');
  }

  // Função utilitária para limpar o 'B' do final do SKU
  function limparSkuB(sku) {
    return typeof sku === 'string' ? sku.replace(/B$/, '') : sku;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Pedidos</h1>
        </div>
        <button
          className="btn-secondary ml-4"
          onClick={() => { fetchAglutinados(); setShowAglutinadosModal(true); }}
        >
          Histórico de Aglutinados
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4 flex flex-col md:flex-row md:justify-end md:items-center space-y-2 md:space-y-0 md:space-x-4 sticky top-6 z-30 pt-6">
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-700 dark:text-gray-300">Data inicial:</label>
          <input
            type="date"
            value={dataInicial}
            onChange={e => setDataInicial(e.target.value)}
            className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600"
          />
        </div>
        <div className="flex items-center space-x-2">
          <label className="text-sm text-gray-700 dark:text-gray-300">Data final:</label>
          <input
            type="date"
            value={dataFinal}
            onChange={e => setDataFinal(e.target.value)}
            className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:text-white dark:border-gray-600"
          />
        </div>
        <button
          type="button"
          onClick={() => setFiltro12h(f => !f)}
          className={`flex items-center text-sm border rounded px-3 py-1 font-semibold transition-colors ${filtro12h ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 border-blue-600 dark:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900'}`}
        >
          12h+
        </button>
        <button
          onClick={fetchNotasFiscais}
          className="btn-primary flex items-center text-sm"
          disabled={loadingNotas || isFetchingNotas || progresso.status === 'importando'}
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          {loadingNotas || isFetchingNotas ? 'Carregando...' : 'Buscar Notas'}
        </button>
        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id="aglutinar-pedidos"
            checked={aglutinar}
            onChange={e => setAglutinar(e.target.checked)}
            style={{ width: 22, height: 22 }}
            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
          />
          <label htmlFor="aglutinar-pedidos" className="text-sm text-gray-700 dark:text-gray-300 select-none">Aglutinar Pedidos</label>
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          <label className="flex items-center text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={ocultarExpedidas}
              onChange={e => setOcultarExpedidas(e.target.checked)}
              style={{ width: 22, height: 22 }}
              className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
            />
            <span className="ml-2 text-gray-700 dark:text-gray-300">Ocultar expedidas</span>
          </label>
          {selectedNotas.length > 0 && (
            <div className="relative">
            <button
                onClick={handlePrintMenu}
              className="btn-primary flex items-center text-sm"
                type="button"
            >
              <Printer className="w-4 h-4 mr-2" />
              Imprimir Selecionados ({selectedNotas.length})
            </button>
              {showPrintMenu && (
                <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg z-50">
                  <button className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white" onClick={handleExpedirHoje}>Expedir hoje</button>
                  <button className="w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-white" onClick={handleSelecionarData}>Expedir em...</button>
                </div>
              )}
              {showDatePicker && (
                <div className="absolute right-0 mt-2 bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg z-50 p-4 flex flex-col items-center gap-2" style={{width:'180px', minWidth:'unset', maxWidth:'90vw'}}>
                  <input type="date" value={expeditionDate} onChange={handleDateChange} className="border rounded px-2 py-1 text-sm w-full text-center dark:bg-gray-700 dark:text-white dark:border-gray-600" style={{fontSize:'1.1rem'}} />
                  <div className="flex gap-3 justify-center mt-2">
                    <button className="flex items-center justify-center bg-gray-600 hover:bg-gray-700 text-white rounded-full p-2 w-8 h-8" onClick={() => setShowDatePicker(false)} title="Cancelar">
                      <X className="w-4 h-4" />
                    </button>
                    <button className="flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white rounded-full p-2 w-8 h-8" onClick={handleConfirmarData} disabled={!expeditionDate} title="Confirmar">
                      <Check className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {erroNotas && (
        <div className="bg-red-100 text-red-700 rounded p-3 mb-4 text-center font-semibold">
          {erroNotas}
        </div>
      )}

      {showBlingAuth && blingAuth && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Autorizar Integração Bling</h2>
          <p className="text-gray-600 dark:text-gray-300 mb-4">
            Para acessar as notas fiscais, você precisa autorizar o aplicativo no Bling.
          </p>
          <a
            href={blingAuth.authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary flex items-center"
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Autorizar no Bling
          </a>
        </div>
      )}

      {/* Exibir progresso de importação mesmo sem notas */}
      {progresso.status === 'importando' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <div className="flex flex-col items-center">
            <img src={process.env.PUBLIC_URL + '/loader-cat.gif.gif'} alt="Carregando..." className="h-24 w-24 mb-4" />
            <p className="text-gray-600 dark:text-gray-300 text-lg font-semibold mb-2">Importando pedidos...</p>
            <ProgressBar value={progresso.importados} max={progresso.total || 1} />
            <p className="text-gray-700 dark:text-gray-300 text-sm">{progresso.importados} de {progresso.total || '?'} pedidos importados</p>
            <p className="text-gray-400 dark:text-gray-400 text-sm mt-2">Aguarde, pode demorar alguns minutos dependendo da quantidade de pedidos.</p>
          </div>
        </div>
      )}

      {/* Exibir painel vazio só se não estiver importando */}
      {notasFiscais.length === 0 && !loadingNotas && progresso.status !== 'importando' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6 text-center">
          <ShoppingCart className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-300">Nenhuma nota fiscal encontrada</p>
          <button
            onClick={fetchNotasFiscais}
            className="btn-primary mt-4"
            disabled={blingStatus === 'disconnected'}
          >
            Buscar Notas
          </button>
        </div>
      )}

      {processingExpedition && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black bg-opacity-30">
          <div className="flex flex-col items-center">
            <img src={process.env.PUBLIC_URL + '/loader-cat.gif.gif'} alt="Carregando..." className="h-24 w-24 mb-4" />
            <span className="text-blue-700 font-semibold text-lg">Processando</span>
          </div>
        </div>
      )}

      {notasFiscais.length > 0 && !loadingNotas && !isFetchingNotas && (
        <div className="space-y-8">
          {[
            {label: 'Emitidos após 12:00', filtro: nota => {
              const hora = nota.dataEmissao ? new Date(nota.dataEmissao).getHours() : 0;
              return hora >= 12;
            }},
            {label: 'Emitidos até 12:00', filtro: nota => {
              const hora = nota.dataEmissao ? new Date(nota.dataEmissao).getHours() : 0;
              return hora < 12;
            }}
          ].map(({label, filtro}) => {
            const notasPorHorario = notasFiscais.filter(filtro).filter(nota => !ocultarExpedidas || !expedidas.includes(nota.id));
            if (notasPorHorario.length === 0) return null;
            const marketplaces = agruparPorMarketplace(notasPorHorario);
            return (
              <div key={label} className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{label}</h2>
                {Object.entries(marketplaces).map(([mk, notas]) => (
                  <div key={mk} className="mb-8">
                    <h3 className="text-md font-bold text-blue-700 dark:text-blue-400 mb-2">{exibirMarketplace(notas[0])}</h3>
                    <div className="overflow-x-auto">
                                              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-600">
                          <thead className="bg-gray-50 dark:bg-gray-700">
                            <tr>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <input
                                  type="checkbox"
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedNotas(notas.map(n => n.id));
                                    } else {
                                      setSelectedNotas(selectedNotas.filter(id => !notas.some(n => n.id === id)));
                                    }
                                  }}
                                  checked={notas.every(n => selectedNotas.includes(n.id)) && notas.length > 0}
                                  style={{ width: 22, height: 22 }}
                                  className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                                />
                              </th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Número</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Cliente</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Data</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Valor</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Status</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Número Loja</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Marketplace</th>
                              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">ID</th>
                            </tr>
                          </thead>
                          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-600">
                                                      {notas.map((nota, idx) => (
                              <tr key={nota.id ? `${nota.id}-${idx}` : idx} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <input
                                    type="checkbox"
                                    checked={selectedNotas.includes(nota.id)}
                                    onChange={() => handleNotaSelection(nota.id)}
                                    style={{ width: 22, height: 22 }}
                                    className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
                                  />
                                </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  {expedidas.includes(nota.id) ? (
                                    <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center">
                                      <CheckCircle className="w-4 h-4 text-green-600" title="Expedida" />
                                    </div>
                                  ) : (
                                    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                                      <Package className="w-4 h-4 text-blue-600" />
                                    </div>
                                  )}
                                  <div className="ml-4">
                                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                                      NF #{nota.numero} {expedidas.includes(nota.id) && <span className="ml-1 text-green-700 dark:text-green-400 font-bold">Expedida</span>}
                                    </div>
                                    <div className="text-sm text-gray-500 dark:text-gray-400">
                                      Série: {nota.serie}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {nota.cliente || 'Cliente não informado'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  {nota.dataEmissao ? new Date(nota.dataEmissao).toLocaleDateString('pt-BR') : 'Data não informada'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="flex items-center">
                                  <DollarSign className="w-4 h-4 text-green-600 mr-1" />
                                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                                    {formatPrice(nota.valorNota)}
                                  </span>
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                  nota.situacao === 5 ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200' :
                                  nota.situacao === 2 ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200' :
                                  'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200'
                                }`}>
                                  {nota.situacao === 5 ? 'Autorizada' :
                                    nota.situacao === 2 ? 'Cancelada' : 'Pendente'}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {(nota.numeroLoja !== undefined && nota.numeroLoja !== null && nota.numeroLoja !== "") ? nota.numeroLoja : 'Não informado'}
                                </div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">{exibirMarketplace(nota)}</div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm text-gray-900 dark:text-white">
                                  {nota.id || 'Não informado'}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal de Histórico de Aglutinados */}
      {showAglutinadosModal && (
        <div className="aglutinado-modal-bg">
          <div className="aglutinado-modal">
            <button className="close-btn" onClick={() => { setShowAglutinadosModal(false); setAglutinadosPage(1); }} title="Fechar">×</button>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Histórico de Aglutinados</h2>
            {loadingAglutinados ? (
              <div className="text-center text-gray-500 dark:text-gray-400">Carregando...</div>
            ) : aglutinados.length === 0 ? (
              <div className="text-center text-gray-500 dark:text-gray-400">Nenhum aglutinado salvo.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-600">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Data</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Marketplaces</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-600">
                    {paginatedAglutinados.map(a => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">{
                          (() => {
                            // Corrigir para GMT-3 se necessário
                            let data = a.data_criacao;
                            if (typeof data === 'string' && !data.endsWith('Z')) {
                              // Se vier sem fuso, forçar GMT-3
                              data += '-03:00';
                            }
                            const dateObj = new Date(data);
                            return dateObj.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                          })()
                        }</td>
                        <td className="px-4 py-2">{a.marketplaces}</td>
                        <td className="px-4 py-2">
                          <button className="btn-secondary mr-2" onClick={() => handleVisualizarAglutinado(a.id)}>Visualizar</button>
                          <button className="btn-primary" onClick={async () => {
                            const res = await axios.get(`/api/aglutinados/${a.id}`);
                            handleImprimirAglutinado(res.data.conteudo_html);
                          }}>Imprimir</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {totalPages > 1 && (
              <div className="flex justify-center items-center mt-4 space-x-2">
                <button
                  className="px-2 py-1 rounded border text-sm"
                  disabled={aglutinadosPage === 1}
                  onClick={() => setAglutinadosPage(p => Math.max(1, p - 1))}
                >Anterior</button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                  <button
                    key={page}
                    className={`px-3 py-1 rounded border text-sm ${aglutinadosPage === page ? 'bg-blue-600 text-white' : 'bg-white text-blue-700'}`}
                    onClick={() => setAglutinadosPage(page)}
                  >{page}</button>
                ))}
                <button
                  className="px-2 py-1 rounded border text-sm"
                  disabled={aglutinadosPage === totalPages}
                  onClick={() => setAglutinadosPage(p => Math.min(totalPages, p + 1))}
                >Próximo</button>
              </div>
            )}
            {/* Modal de visualização do aglutinado */}
            {visualizarAglutinado && (
              <div className="aglutinado-modal-bg">
                <div className="aglutinado-modal">
                  <button className="close-btn" onClick={() => setVisualizarAglutinado(null)} title="Fechar">×</button>
                  <div dangerouslySetInnerHTML={{ __html: visualizarAglutinado.conteudo_html }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};