import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, Edit as EditIcon, Trash2, Package, Search, Download, Upload, 
  TrendingUp, AlertTriangle, MapPin, Barcode, Hash, Settings, 
  Wrench, CheckCircle, Funnel, Star 
} from 'lucide-react';
import axios from 'axios';
import { InventoryImport } from './InventoryImport';
import { CompositeSkuManager } from './CompositeSkuManager';
import { useLocation } from 'react-router-dom';

export const Inventory = ({ user }) => {
  const location = useLocation();
  const [inventory, setInventory] = useState([]);
  const [fullInventory, setFullInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const [showCompositeManager, setShowCompositeManager] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [compositeInfo, setCompositeInfo] = useState(null);
  const [compositeStocks, setCompositeStocks] = useState({});
  const [activeTab, setActiveTab] = useState('itens');
  const [compositeList, setCompositeList] = useState([]);
  const [showCreateComposite, setShowCreateComposite] = useState(false);
  const [compositeMainSku, setCompositeMainSku] = useState('');
  const [compositeComponents, setCompositeComponents] = useState([{ sku: '', quantity: 1 }]);
  const [compositeError, setCompositeError] = useState('');
  const [showCreateKit, setShowCreateKit] = useState(false);
  const [kitMainSku, setKitMainSku] = useState('');
  const [kitComponentSku, setKitComponentSku] = useState('');
  const [kitQuantity, setKitQuantity] = useState(1);
  const [kitError, setKitError] = useState('');
  const [movementForm, setMovementForm] = useState({ skuId: '', type: 'entrada', quantity: 1 });
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementError, setMovementError] = useState('');
  const [movements, setMovements] = useState([]);
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalFiltrado, setTotalFiltrado] = useState(0);
  
  // Estados para paginação e pesquisa das movimentações
  const [movementsPage, setMovementsPage] = useState(1);
  const [movementsPageSize, setMovementsPageSize] = useState(20);
  const [movementsSearchTerm, setMovementsSearchTerm] = useState('');
  const [movementsTotal, setMovementsTotal] = useState(0);
  const [movementsLoading, setMovementsLoading] = useState(false);
  
  const [formData, setFormData] = useState({
    sku: '',
    ean: '',
    title: '',
    quantity: 0,
    location: '',
    min_quantity: 0,
    max_quantity: '',
    category: '',
    supplier: '',
    cost_price: '',
    selling_price: '',
    notes: '',
    is_composite: false
  });

  // 1. Estado para edição
  const [editingComposite, setEditingComposite] = useState(null); // objeto do composto/kit em edição
  const [editingComponents, setEditingComponents] = useState([]); // componentes em edição
  const [editingMainSku, setEditingMainSku] = useState('');
  const [editingError, setEditingError] = useState('');

  // 1. Adicione estados para edição de kit
  const [editingKit, setEditingKit] = useState(null);
  const [editingKitMainSku, setEditingKitMainSku] = useState('');
  const [editingKitComponentSku, setEditingKitComponentSku] = useState('');
  const [editingKitQuantity, setEditingKitQuantity] = useState(1);
  const [editingKitError, setEditingKitError] = useState('');
  const [showImportKitModal, setShowImportKitModal] = useState(false);
  const [showImportCompostoModal, setShowImportCompostoModal] = useState(false);
  const [cleaningKits, setCleaningKits] = useState(false);
  const [cleaningCompostos, setCleaningCompostos] = useState(false);
  const [aglutinados, setAglutinados] = useState([]);
  const [visualizarAglutinado, setVisualizarAglutinado] = useState(null);
  const [loadingAglutinados, setLoadingAglutinados] = useState(false);

  // Adicionar estados para filtros
  const [showFilter, setShowFilter] = useState(false);
  const [filterLowStock, setFilterLowStock] = useState(false);
  const [filterNoStock, setFilterNoStock] = useState(false);
  const [filterWithStock, setFilterWithStock] = useState(false);

  // Adicionar ref para o menu de filtro
  const filterMenuRef = useRef(null);
  
  // Estados para menu de relatórios
  const [showReportsMenu, setShowReportsMenu] = useState(false);
  const reportsMenuRef = useRef(null);

  // Estado para SKUs fixados
  const [pinnedSkus, setPinnedSkus] = useState([]);
  const [loadingPins, setLoadingPins] = useState(false);

  // Sincronizar aba ativa com o parâmetro 'tab' da URL
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && ['itens', 'compostos', 'movimentacao', 'historico-aglutinados'].includes(tab) && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [location.search, activeTab]);

  useEffect(() => {
    fetchInventory();
  }, [searchTerm, page, pageSize, filterLowStock, filterNoStock, filterWithStock]);

  useEffect(() => {
    if (activeTab === 'historico-aglutinados') {
      fetchAglutinados();
    }
  }, [activeTab]);

  // Buscar o saldo máximo de montagem para todos SKUs compostos
  useEffect(() => {
    const fetchAllCompositeStocks = async () => {
      const composed = inventory.filter(item => item.is_composite);
      const results = {};
      await Promise.all(composed.map(async (item) => {
        try {
          const res = await axios.get(`/api/inventory/${item.id}/composite-stock`);
          results[item.id] = res.data.max_possible;
        } catch {
          results[item.id] = 0;
        }
      }));
      setCompositeStocks(results);
    };
    if (inventory.length > 0) fetchAllCompositeStocks();
  }, [inventory]);

  useEffect(() => {
    if (activeTab === 'compostos' || activeTab === 'itens') {
      fetchCompositeList();
    }
  }, [activeTab]);

  // Buscar histórico de movimentações
  useEffect(() => {
    if (activeTab === 'movimentacao') {
      fetchMovements();
    }
  }, [activeTab, movementsPage, movementsPageSize, movementsSearchTerm]);

  // Ajustar o useEffect para fechar o menu apenas se o clique for fora do botão e do menu
  useEffect(() => {
      function handleClickOutside(event) {
    const btn = document.getElementById('btn-filtro');
    const reportsBtn = document.getElementById('btn-relatorios');
    
    if (showFilter && btn && !btn.contains(event.target) && filterMenuRef.current && !filterMenuRef.current.contains(event.target)) {
      setShowFilter(false);
    }
    
    if (showReportsMenu && reportsBtn && !reportsBtn.contains(event.target) && reportsMenuRef.current && !reportsMenuRef.current.contains(event.target)) {
      setShowReportsMenu(false);
    }
  }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilter]);

  // Adicionar useEffect para resetar a página ao mudar qualquer filtro
  useEffect(() => {
    setPage(1);
  }, [filterLowStock, filterNoStock, filterWithStock]);

  // Buscar SKUs fixados ao carregar, somente se usuário estiver disponível
  useEffect(() => {
    console.log('[FIXAR ITENS DEBUG] useEffect executado, user:', user);
    if (!user) {
      console.log('[FIXAR ITENS DEBUG] Usuário não disponível, abortando fetchPinned');
      return;
    }
    async function fetchPinned() {
      console.log('[FIXAR ITENS DEBUG] Iniciando fetchPinned');
      setLoadingPins(true);
      try {
        const token = localStorage.getItem('token');
        console.log('[FIXAR ITENS DEBUG] Token encontrado:', !!token);
        console.log('[FIXAR ITENS DEBUG] User ID:', user.id);
        
        const res = await axios.get('/api/user/pinned-skus', token ? { headers: { Authorization: `Bearer ${token}` } } : {});
        console.log('[FIXAR ITENS DEBUG] Resposta da API:', res.data);
        setPinnedSkus(res.data.pinnedSkus || []);
        console.log('[FIXAR ITENS DEBUG] pinnedSkus atualizado:', res.data.pinnedSkus || []);
      } catch (e) {
        console.error('[FIXAR ITENS DEBUG] Erro ao buscar SKUs fixados:', e);
        console.error('[FIXAR ITENS DEBUG] Detalhes do erro:', e.response?.data || e.message);
        setPinnedSkus([]);
      } finally {
        setLoadingPins(false);
        console.log('[FIXAR ITENS DEBUG] fetchPinned concluído');
      }
    }
    fetchPinned();
  }, [user]);

  // Função para fixar/desfixar SKU
  const togglePin = async (sku) => {
    console.log('[FIXAR ITENS DEBUG] togglePin chamado para SKU:', sku);
    console.log('[FIXAR ITENS DEBUG] pinnedSkus atual:', pinnedSkus);
    
    let newPins;
    if (pinnedSkus.includes(sku)) {
      newPins = pinnedSkus.filter(s => s !== sku);
      console.log('[FIXAR ITENS DEBUG] Desfixando SKU, novos pins:', newPins);
    } else {
      newPins = [...pinnedSkus, sku];
      console.log('[FIXAR ITENS DEBUG] Fixando SKU, novos pins:', newPins);
    }
    
    setPinnedSkus(newPins);
    setLoadingPins(true);
    
    try {
      const token = localStorage.getItem('token');
      console.log('[FIXAR ITENS DEBUG] Enviando requisição PUT com token:', !!token);
      console.log('[FIXAR ITENS DEBUG] Dados enviados:', { pinnedSkus: newPins });
      
      const response = await axios.put('/api/user/pinned-skus', { pinnedSkus: newPins }, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      console.log('[FIXAR ITENS DEBUG] Resposta da API:', response.data);
      console.log('[FIXAR ITENS DEBUG] SKU fixado/desfixado com sucesso');
    } catch (e) {
      console.error('[FIXAR ITENS DEBUG] Erro ao atualizar SKUs fixados:', e);
      console.error('[FIXAR ITENS DEBUG] Detalhes do erro:', e.response?.data || e.message);
      // rollback visual se falhar
      setPinnedSkus(pinnedSkus);
      alert('Erro ao atualizar SKUs fixados. Faça login novamente.');
    } finally {
      setLoadingPins(false);
      console.log('[FIXAR ITENS DEBUG] togglePin concluído');
    }
  };

  // Definir filteredItems ANTES de sortedPaginatedItems
  const filteredItems = fullInventory.filter(item => {
    // Filtro de busca
    if (searchTerm) {
      const termo = searchTerm.toLowerCase();
      if (
        !(item.sku?.toString().toLowerCase().includes(termo) ||
          item.ean?.toString().toLowerCase().includes(termo) ||
          item.title?.toLowerCase().includes(termo))
      ) {
        return false;
      }
    }
    // Filtro Estoque Baixo
    if (filterLowStock && !(item.quantity > 0 && item.quantity <= (item.min_quantity || 0))) {
      return false;
    }
    // Filtro Sem Estoque
    if (filterNoStock && item.quantity !== 0) {
      return false;
    }
    // Filtro Com Estoque
    if (filterWithStock && item.quantity <= 0) {
      return false;
    }
    return true;
  });

  // Separar itens fixados dos não fixados
  const pinnedItems = filteredItems.filter(item => pinnedSkus.includes(item.sku));
  const nonPinnedItems = filteredItems.filter(item => !pinnedSkus.includes(item.sku));

  // Lógica para página 1: mostrar itens fixados + itens não fixados
  let sortedPaginatedItems = [];
  let totalPages = 1;

  if (page === 1) {
    // Página 1: itens fixados + itens não fixados que cabem
    const remainingSlots = pageSize - pinnedItems.length;
    const nonPinnedForPage1 = nonPinnedItems.slice(0, remainingSlots);
    sortedPaginatedItems = [...pinnedItems, ...nonPinnedForPage1];
    
    // Calcular páginas restantes para itens não fixados
    const remainingNonPinnedItems = nonPinnedItems.length - remainingSlots;
    totalPages = 1 + Math.ceil(remainingNonPinnedItems / pageSize);
  } else {
    // Páginas 2+: apenas itens não fixados
    const startIndex = (page - 2) * pageSize + (pageSize - pinnedItems.length);
    const endIndex = startIndex + pageSize;
    sortedPaginatedItems = nonPinnedItems.slice(startIndex, endIndex);
    
    // Calcular total de páginas
    const totalNonPinnedItems = nonPinnedItems.length;
    const firstPageSlots = pageSize - pinnedItems.length;
    const remainingItems = totalNonPinnedItems - firstPageSlots;
    totalPages = 1 + Math.ceil(remainingItems / pageSize);
  }

  const fetchInventory = async (paramsOverride = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Busca
      if (searchTerm) params.append('search', searchTerm);
      // Filtros do menu (REMOVIDO: não enviar para o backend)
      // if (filterLowStock) params.append('lowStock', 'true');
      // if (filterNoStock) params.append('noStock', 'true');
      // if (filterWithStock) params.append('withStock', 'true');
      // Paginação
      params.append('limit', pageSize);
      params.append('offset', (page - 1) * pageSize);
      // Permitir sobrescrever params para navegação
      Object.entries(paramsOverride).forEach(([k, v]) => params.set(k, v));
      const now = Date.now();
      const response = await axios.get(`/api/inventory?${params}&_=${now}`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      setInventory(response.data.items || []);
      setTotalFiltrado(response.data.totalFiltrado || 0);
      // Sempre buscar todos os itens para fullInventory, sem paginação/filtro
      const allRes = await axios.get(`/api/inventory?limit=10000&offset=0&_=${now}`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      setFullInventory(allRes.data.items || []);
    } catch (error) {
      console.error('Erro ao carregar estoque:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCompositeInfo = async (itemId) => {
    try {
      const response = await axios.get(`/api/inventory/${itemId}/composite-stock`);
      setCompositeInfo(response.data);
    } catch (error) {
      console.error('Erro ao carregar informações do SKU composto:', error);
    }
  };

  const fetchCompositeList = async () => {
    try {
      const res = await axios.get('/api/composite-skus');
      setCompositeList(res.data);
    } catch (err) {
      setCompositeList([]);
    }
  };

  const fetchMovements = async () => {
    setMovementsLoading(true);
    try {
      const params = new URLSearchParams();
      if (movementsSearchTerm) {
        params.append('search', movementsSearchTerm);
      }
      params.append('limit', movementsPageSize);
      params.append('offset', (movementsPage - 1) * movementsPageSize);
      
      const res = await axios.get(`/api/stock-movements?${params}`);
      setMovements(res.data.movements || res.data || []);
      setMovementsTotal(res.data.total || res.data.length || 0);
    } catch (err) {
      setMovements([]);
      setMovementsTotal(0);
    } finally {
      setMovementsLoading(false);
    }
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('submit');
    try {
      // Converter is_composite para 0 ou 1
      const dataToSend = { ...formData, is_composite: formData.is_composite ? 1 : 0 };
      if (selectedItem) {
        await axios.put(`/api/inventory/${selectedItem.id}`, dataToSend);
      } else {
        await axios.post('/api/inventory', dataToSend);
      }
      resetForm();
      fetchInventory();
    } catch (error) {
      console.error('Erro ao salvar item:', error);
      alert('Erro ao salvar item. Verifique os dados.');
    }
  };

  const handleExport = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/inventory/export/csv', {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'estoque.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error('Erro na exportação:', error);
      if (error.response?.status === 403) {
        alert('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        alert('Sessão expirada. Faça login novamente.');
      } else {
        alert('Erro na exportação.');
      }
    }
  };

  const handleExportLowStock = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/inventory/report/low-stock', {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'relatorio-estoque-baixo.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error('Erro na exportação do relatório de estoque baixo:', error);
      if (error.response?.status === 403) {
        alert('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        alert('Sessão expirada. Faça login novamente.');
      } else {
        alert('Erro na exportação do relatório.');
      }
    }
  };

  const handleExportOutOfStock = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/inventory/report/out-of-stock', {
        responseType: 'blob',
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'relatorio-sem-estoque.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error('Erro na exportação do relatório de sem estoque:', error);
      if (error.response?.status === 403) {
        alert('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        alert('Sessão expirada. Faça login novamente.');
      } else {
        alert('Erro na exportação do relatório.');
      }
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('Tem certeza que deseja excluir este item?')) {
      try {
        await axios.delete(`/api/inventory/${id}`);
        fetchInventory();
      } catch (error) {
        console.error('Erro ao excluir item:', error);
      }
    }
  };

  const handleEdit = (item) => {
    setSelectedItem(item);
    setFormData({
      sku: item.sku,
      ean: item.ean || '',
      title: item.title,
      quantity: item.quantity,
      location: item.location || '',
      min_quantity: item.min_quantity || 0,
      max_quantity: item.max_quantity || '',
      category: item.category || '',
      supplier: item.supplier || '',
      cost_price: item.cost_price || '',
      selling_price: item.selling_price || '',
      notes: item.notes || '',
      is_composite: item.is_composite || false
    });
    setShowForm(true);
  };

  const handleCompositeManager = (item) => {
    setSelectedItem(item);
    setShowCompositeManager(true);
  };

  const handleImportComplete = () => {
    fetchInventory();
  };

  const resetForm = () => {
    setFormData({
      sku: '',
      ean: '',
      title: '',
      quantity: 0,
      location: '',
      min_quantity: 0,
      max_quantity: '',
      category: '',
      supplier: '',
      cost_price: '',
      selling_price: '',
      notes: '',
      is_composite: false
    });
    setSelectedItem(null);
    setShowForm(false);
  };

  const getStockStatus = (item) => {
    if (item.quantity === 0) return 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200';
    if (item.quantity <= item.min_quantity) return 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
    return 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200';
  };

  const getStockStatusText = (item) => {
    if (item.quantity === 0) return 'Sem estoque';
    if (item.quantity <= item.min_quantity) return 'Estoque baixo';
    return 'Em estoque';
  };

  // Novo: calcular estatísticas considerando SKUs compostos
  const getPanelStatsFull = () => {
    // Ignorar itens da categoria 'Ventilador'
    let inventarioFiltrado = fullInventory.filter(item => (item.category || '').toLowerCase() !== 'ventilador');
    let itensComEstoque = inventarioFiltrado.filter(item => (item.quantity || 0) > 0);
    let totalItems = itensComEstoque.length;
    let totalQuantity = inventarioFiltrado.filter(item => !item.is_composite && !compositeList.some(c => c.main_sku_id === item.id)).reduce((acc, item) => acc + (item.quantity || 0), 0);
    let lowStock = inventarioFiltrado.filter(item => !item.is_composite && item.quantity > 0 && item.quantity <= (item.min_quantity || 0)).length;
    let outOfStock = inventarioFiltrado.filter(item => !item.is_composite && (item.quantity || 0) === 0).length;
    return { totalItems, totalQuantity, lowStock, outOfStock };
  };

  // Função para criar SKU composto (reescrita do zero espelhando a de kit)
  const handleCreateComposite = async (e) => {
    e.preventDefault();
    setCompositeError('');
    
    // Validação básica
    if (!compositeMainSku) {
      setCompositeError('Selecione o SKU principal do composto.');
      return;
    }
    if (compositeComponents.length < 2) {
      setCompositeError('Adicione pelo menos 2 componentes.');
      return;
    }
    if (compositeComponents.some(c => !c.sku || c.quantity < 1)) {
      setCompositeError('Preencha todos os SKUs e quantidades.');
      return;
    }
    if (compositeComponents.some(c => c.sku === compositeMainSku)) {
      setCompositeError('O SKU principal não pode ser um componente.');
      return;
    }
    const skus = compositeComponents.map(c => c.sku);
    if (new Set(skus).size !== skus.length) {
      setCompositeError('Não repita SKUs nos componentes.');
      return;
    }
    
    // Buscar os IDs a partir dos SKUs digitados
    const mainItem = fullInventory.find(i => i.sku === compositeMainSku);
    if (!mainItem) {
      setCompositeError('SKU principal não encontrado.');
      return;
    }
    
    // Verificar se todos os componentes existem
    const componentsWithId = compositeComponents.map(c => {
      const compItem = fullInventory.find(i => i.sku === c.sku);
      return compItem ? { ...c, id: compItem.id } : null;
    });
    if (componentsWithId.some(c => !c)) {
      setCompositeError('Um ou mais componentes não encontrados.');
      return;
    }
    
    try {
      // Enviar um POST para cada componente (igual ao kit, mas para múltiplos)
      for (const comp of componentsWithId) {
        const payload = {
          main_sku_id: Number(mainItem.id),
          component_sku_id: Number(comp.id),
          quantity: Number(comp.quantity)
        };
        console.log('Enviando componente para /api/composite-skus:', payload);
        await axios.post('/api/composite-skus', payload);
      }
      
      // Marcar o SKU principal como composto
      await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
      
      // Limpar formulário e atualizar dados
      setShowCreateComposite(false);
      setCompositeMainSku('');
      setCompositeComponents([{ sku: '', quantity: 1 }]);
      fetchCompositeList();
      fetchInventory();
    } catch (err) {
      setCompositeError('Erro ao criar SKU composto. Verifique os dados.');
    }
  };

  // Função para criar Kit (SKU composto com apenas um componente)
  const handleCreateKit = async (e) => {
    e.preventDefault();
    setKitError('');
    
    // Validação básica
    if (!kitMainSku) {
      setKitError('Selecione o SKU principal do kit.');
      return;
    }
    if (!kitComponentSku) {
      setKitError('Selecione o SKU do componente.');
      return;
    }
    if (kitQuantity < 1) {
      setKitError('A quantidade deve ser maior que zero.');
      return;
    }
    if (kitMainSku === kitComponentSku) {
      setKitError('O SKU principal não pode ser o mesmo do componente.');
      return;
    }
    // Buscar os IDs a partir dos SKUs digitados
    const mainItem = fullInventory.find(i => i.sku === kitMainSku);
    const componentItem = fullInventory.find(i => i.sku === kitComponentSku);
    if (!mainItem || !componentItem) {
      setKitError('SKU principal ou componente não encontrado.');
      return;
    }
    try {
      const payload = {
        main_sku_id: Number(mainItem.id),
        component_sku_id: Number(componentItem.id),
        quantity: Number(kitQuantity)
      };
      console.log('Enviando kit para /api/composite-skus:', payload);
      await axios.post('/api/composite-skus', payload);
      await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
      
      setShowCreateKit(false);
      setKitMainSku('');
      setKitComponentSku('');
      setKitQuantity(1);
      fetchCompositeList();
      fetchInventory();
    } catch (err) {
      setKitError('Erro ao criar kit. Verifique os dados.');
    }
  };

  // 4. Função para salvar edição
  const handleEditComposite = async (e) => {
    e.preventDefault();
    setEditingError('');
    // Validação básica
    if (!editingMainSku) {
      setEditingError('Selecione o SKU principal.');
      return;
    }
    if (editingComponents.length < 1) {
      setEditingError('Adicione pelo menos 1 componente.');
      return;
    }
    if (editingComponents.some(c => !c.sku || c.quantity < 1)) {
      setEditingError('Preencha todos os SKUs e quantidades.');
      return;
    }
    if (editingComponents.some(c => c.sku === editingMainSku)) {
      setEditingError('O SKU principal não pode ser um componente.');
      return;
    }
    const skus = editingComponents.map(c => c.sku);
    if (new Set(skus).size !== skus.length) {
      setEditingError('Não repita SKUs nos componentes.');
      return;
    }
    // Buscar o ID do SKU principal
    const mainItem = inventory.find(i => i.sku === editingMainSku);
    if (!mainItem) {
      setEditingError('SKU principal não encontrado.');
      return;
    }
    // Buscar os IDs dos componentes
    const componentsWithId = editingComponents.map(c => {
      const compItem = inventory.find(i => i.sku === c.sku);
      return compItem ? { ...c, id: compItem.id } : null;
    });
    if (componentsWithId.some(c => !c)) {
      setEditingError('Um ou mais componentes não encontrados.');
      return;
    }
    try {
      // Buscar todos os componentes atuais do composto/kit
      const res = await axios.get(`/api/composite-skus/${editingComposite.main_sku_id}`);
      const currentComponents = res.data;
      // Deletar cada componente individualmente
      for (const comp of currentComponents) {
        await axios.delete(`/api/composite-skus/${comp.id}`);
      }
      // Adicionar os novos componentes
      for (const comp of componentsWithId) {
        const payload = {
          main_sku_id: Number(mainItem.id),
          component_sku_id: Number(comp.id),
          quantity: Number(comp.quantity)
        };
        await axios.post('/api/composite-skus', payload);
      }
      await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
      setEditingComposite(null);
      fetchCompositeList();
      fetchInventory();
    } catch (err) {
      setEditingError('Erro ao salvar alterações. Verifique os dados.');
    }
  };

  // 2. Função para abrir edição de kit
  function handleEditKit(kit) {
    setEditingKit(kit);
    setEditingKitMainSku(inventory.find(i => i.id === kit.main_sku_id)?.sku || '');
    setEditingKitComponentSku(inventory.find(i => i.id === kit.components[0].component_sku_id)?.sku || '');
    setEditingKitQuantity(kit.components[0].quantity);
    setEditingKitError('');
    setShowCreateComposite(false);
    setShowCreateKit(false);
  }

  // 3. Função para salvar edição de kit
  async function handleSaveEditKit(e) {
    e.preventDefault();
    setEditingKitError('');
    if (!editingKitMainSku || !editingKitComponentSku || editingKitQuantity < 1) {
      setEditingKitError('Preencha todos os campos corretamente.');
      return;
    }
    if (editingKitMainSku === editingKitComponentSku) {
      setEditingKitError('O SKU principal não pode ser o mesmo do componente.');
      return;
    }
    const mainItem = fullInventory.find(i => i.sku === editingKitMainSku);
    const componentItem = fullInventory.find(i => i.sku === editingKitComponentSku);
    if (!mainItem || !componentItem) {
      setEditingKitError('SKU principal ou componente não encontrado.');
      return;
    }
    try {
      // Deletar o kit antigo
      const res = await axios.get(`/api/composite-skus/${editingKit.main_sku_id}`);
      for (const comp of res.data) {
        await axios.delete(`/api/composite-skus/${comp.id}`);
      }
      // Adicionar o novo kit
      await axios.post('/api/composite-skus', {
        main_sku_id: Number(mainItem.id),
        component_sku_id: Number(componentItem.id),
        quantity: Number(editingKitQuantity)
      });
      await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
      setEditingKit(null);
      fetchCompositeList();
      fetchInventory();
    } catch (err) {
      setEditingKitError('Erro ao salvar alterações do kit.');
    }
  }

  // 4. Modal de importação de kits
  function ImportKitModal() {
    const [csvData, setCsvData] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const handleFileUpload = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setCsvData(event.target.result);
        };
        reader.readAsText(file);
      }
    };
    const handleImport = async (e) => {
      e && e.preventDefault();
      setLoading(true);
      setResult(null);
      try {
        const sep = csvData.includes(';') && !csvData.includes(',') ? ';' : ',';
        const lines = csvData.split(/\r?\n/).filter(l => l.trim());
        let startIdx = 0;
        if (lines[0] && lines[0].toLowerCase().includes('sku')) startIdx = 1;
        let ok = 0, fail = 0, errors = [];
        for (let i = startIdx; i < lines.length; i++) {
          const cols = lines[i].split(sep).map(s => s.trim());
          if (cols.length !== 3) {
            fail++;
            errors.push(`Linha ${i+1}: esperado 3 colunas (SKU principal, componente, quantidade)`);
            continue;
          }
          const [mainSku, compSku, qty] = cols;
          const mainItem = fullInventory.find(i => i.sku == mainSku);
          const componentItem = fullInventory.find(i => i.sku == compSku);
          if (!mainItem || !componentItem) {
            fail++;
            errors.push(`Linha ${i+1}: SKU não encontrado`);
            continue;
          }
          try {
            const payload = {
              main_sku_id: Number(mainItem.id),
              component_sku_id: Number(componentItem.id),
              quantity: Number(qty)
            };
            await axios.post('/api/composite-skus', payload);
            await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
            ok++;
          } catch (err) {
            fail++;
            errors.push(`Linha ${i+1}: erro ao salvar (${err?.response?.data?.error || err.message})`);
          }
        }
        setResult({ ok, fail, errors });
        fetchCompositeList();
        fetchInventory();
      } catch (err) {
        setResult({ ok: 0, fail: 1, errors: [err.message] });
      }
      setLoading(false);
    };
    return (
      <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-lg">
          <h2 className="text-lg font-bold mb-2">Importar Kits via CSV</h2>
          <input type="file" accept=".csv" onChange={handleFileUpload} className="mb-2" />
          <textarea className="input-field w-full mb-2" rows={8} value={csvData} onChange={e => setCsvData(e.target.value)} placeholder="SKU_PRINCIPAL,SKU_COMPONENTE,QUANTIDADE\n95437,52525,2\n..." />
          <div className="flex gap-2 mb-2">
            <button className="btn-primary" onClick={handleImport} disabled={loading}>{loading ? 'Importando...' : 'Importar'}</button>
            <button className="btn-secondary" onClick={() => setShowImportKitModal(false)} disabled={loading}>Fechar</button>
          </div>
          {result && (<div className="mt-2 text-sm"><b>{result.ok}</b> importados, <b>{result.fail}</b> falharam.<br/>{result.errors && result.errors.length > 0 && (<ul className="text-red-600 list-disc ml-5">{result.errors.map((e,i) => <li key={i}>{e}</li>)}</ul>)}</div>)}
        </div>
      </div>
    );
  }

  // 5. Modal de importação de compostos
  function ImportCompostoModal() {
    const [csvData, setCsvData] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const handleFileUpload = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setCsvData(event.target.result);
        };
        reader.readAsText(file);
      }
    };
    const handleImport = async (e) => {
      e && e.preventDefault();
      setLoading(true);
      setResult(null);
      try {
        const sep = csvData.includes(';') && !csvData.includes(',') ? ';' : ',';
        const lines = csvData.split(/\r?\n/).filter(l => l.trim());
        let startIdx = 0;
        if (lines[0] && lines[0].toLowerCase().includes('sku')) startIdx = 1;
        let ok = 0, fail = 0, errors = [];
        for (let i = startIdx; i < lines.length; i++) {
          const cols = lines[i].split(sep).map(s => s.trim());
          if (cols.length < 4 || cols.length % 2 !== 1) {
            fail++;
            errors.push(`Linha ${i+1}: esperado formato SKU_PRINCIPAL,COMP1,QTD1,COMP2,QTD2,...`);
            continue;
          }
          const mainSku = cols[0];
          const mainItem = fullInventory.find(i => i.sku == mainSku);
          if (!mainItem) {
            fail++;
            errors.push(`Linha ${i+1}: SKU principal não encontrado`);
            continue;
          }
          let allOk = true;
          let components = [];
          for (let j = 1; j < cols.length; j += 2) {
            const compSku = cols[j];
            const qty = cols[j+1];
            const compItem = fullInventory.find(i => i.sku == compSku);
            if (!compItem) {
              allOk = false;
              errors.push(`Linha ${i+1}: componente '${compSku}' não encontrado`);
              break;
            }
            components.push({ compItem, qty });
          }
          if (!allOk) { fail++; continue; }
          try {
            for (const { compItem, qty } of components) {
              const payload = {
                main_sku_id: Number(mainItem.id),
                component_sku_id: Number(compItem.id),
                quantity: Number(qty)
              };
              await axios.post('/api/composite-skus', payload);
            }
            await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
            ok++;
          } catch (err) {
            fail++;
            errors.push(`Linha ${i+1}: erro ao salvar (${err?.response?.data?.error || err.message})`);
          }
        }
        setResult({ ok, fail, errors });
        fetchCompositeList();
        fetchInventory();
      } catch (err) {
        setResult({ ok: 0, fail: 1, errors: [err.message] });
      }
      setLoading(false);
    };
    return (
      <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-lg">
          <h2 className="text-lg font-bold mb-2">Importar SKUs Compostos via CSV</h2>
          <input type="file" accept=".csv" onChange={handleFileUpload} className="mb-2" />
          <textarea className="input-field w-full mb-2" rows={8} value={csvData} onChange={e => setCsvData(e.target.value)} placeholder="SKU_PRINCIPAL,COMP1,QTD1,COMP2,QTD2,...\n12345,111,2,222,3\n..." />
          <div className="flex gap-2 mb-2">
            <button className="btn-primary" onClick={handleImport} disabled={loading}>{loading ? 'Importando...' : 'Importar'}</button>
            <button className="btn-secondary" onClick={() => setShowImportCompostoModal(false)} disabled={loading}>Fechar</button>
          </div>
          {result && (<div className="mt-2 text-sm"><b>{result.ok}</b> importados, <b>{result.fail}</b> falharam.<br/>{result.errors && result.errors.length > 0 && (<ul className="text-red-600 list-disc ml-5">{result.errors.map((e,i) => <li key={i}>{e}</li>)}</ul>)}</div>)}
        </div>
      </div>
    );
  }

  // 2. Função para limpar todos os kits
  async function handleCleanKits() {
    setCleaningKits(true);
    try {
      const res = await axios.get('/api/composite-skus');
      // Deletar todos os vínculos de kits (com 1 componente)
      const allLinks = res.data.flatMap(c => c.components.map(comp => ({ main: c.main_sku_id, id: comp.id, count: c.components.length })));
      const kitLinks = allLinks.filter(l => l.count === 1);
      for (const link of kitLinks) {
        await axios.delete(`/api/composite-skus/${link.id}`);
      }
      fetchCompositeList();
      fetchInventory();
    } catch {}
    setCleaningKits(false);
  }

  // 3. Função para limpar todos os compostos
  async function handleCleanCompostos() {
    setCleaningCompostos(true);
    try {
      const res = await axios.get('/api/composite-skus');
      // Deletar todos os vínculos de compostos (com 2+ componentes)
      const allLinks = res.data.flatMap(c => c.components.map(comp => ({ main: c.main_sku_id, id: comp.id, count: c.components.length })));
      const compLinks = allLinks.filter(l => l.count > 1);
      for (const link of compLinks) {
        await axios.delete(`/api/composite-skus/${link.id}`);
      }
      fetchCompositeList();
      fetchInventory();
    } catch {}
    setCleaningCompostos(false);
  }

  // Função utilitária para limpar o 'B' do final do SKU
  function limparSkuB(sku) {
    return typeof sku === 'string' ? sku.replace(/B$/, '') : sku;
  }

  return (
    <div className="space-y-6">
      {/* Conteúdo das abas */}
      {activeTab === 'itens' && (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Estoque</h1>
              <p className="text-gray-600 dark:text-gray-300 mt-2">Gerencie o inventário do sistema</p>
            </div>
            <div className="flex space-x-3">
              {user.role >= 4 && (
                <button
                  onClick={() => setShowImportForm(true)}
                  className="btn-secondary flex items-center"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  Importar
                </button>
              )}
              <div className="relative">
                <button
                  onClick={() => setShowReportsMenu(f => !f)}
                  className="btn-secondary flex items-center"
                  id="btn-relatorios"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Relatórios
                </button>
                {showReportsMenu && (
                  <div ref={reportsMenuRef} className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg z-20">
                    <button
                      onClick={() => {
                        handleExport();
                        setShowReportsMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-600"
                    >
                      Exportar Todos
                    </button>
                    <button
                      onClick={() => {
                        handleExportLowStock();
                        setShowReportsMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-yellow-700 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900 border-b border-gray-100 dark:border-gray-600"
                    >
                      Estoque Baixo
                    </button>
                    <button
                      onClick={() => {
                        handleExportOutOfStock();
                        setShowReportsMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900"
                    >
                      Sem Estoque
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => setShowForm(true)}
                className="btn-primary flex items-center"
              >
                <Plus className="w-4 h-4 mr-2" />
                Adicionar Item
              </button>
            </div>
          </div>

          {/* Estatísticas */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
              <div className="flex items-center">
                <Package className="w-8 h-8 text-blue-600 mr-3" />
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">Total de Itens</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{getPanelStatsFull().totalItems}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
              <div className="flex items-center">
                <TrendingUp className="w-8 h-8 text-green-600 mr-3" />
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">Quantidade Total</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{getPanelStatsFull().totalQuantity}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
              <div className="flex items-center">
                <AlertTriangle className="w-8 h-8 text-yellow-600 mr-3" />
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">Estoque Baixo</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{getPanelStatsFull().lowStock}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
              <div className="flex items-center">
                <AlertTriangle className="w-8 h-8 text-red-600 mr-3" />
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">Sem Estoque</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{getPanelStatsFull().outOfStock}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Busca */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
            <div className="flex flex-col md:flex-row gap-4 items-center">
              <div className="relative flex-1 flex items-center">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Buscar por SKU, EAN ou título..."
                  className="input-field dark:bg-gray-700 dark:text-white dark:border-gray-600"
                />
                <button
                  type="button"
                  className="ml-2 p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600 dark:text-gray-300"
                  onClick={() => setShowFilter(f => !f)}
                  title="Filtros"
                  id="btn-filtro"
                >
                  <Funnel className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                </button>
                {showFilter && (
                  <div ref={filterMenuRef} className="absolute right-0 mt-10 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg z-20 p-4 flex flex-col space-y-2" style={{ minWidth: 180 }}>
                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={filterNoStock}
                        onChange={e => setFilterNoStock(e.target.checked)}
                        className="rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">Sem Estoque</span>
                    </label>
                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={filterLowStock}
                        onChange={e => setFilterLowStock(e.target.checked)}
                        className="rounded border-gray-300 dark:border-gray-600 text-yellow-600 focus:ring-yellow-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">Estoque Baixo</span>
                    </label>
                    <label className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={filterWithStock}
                        onChange={e => setFilterWithStock(e.target.checked)}
                        className="rounded border-gray-300 dark:border-gray-600 text-green-600 focus:ring-green-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">Com Estoque</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Formulário de Importação */}
          {showImportForm && (
            <InventoryImport
              onImportComplete={handleImportComplete}
              onClose={() => setShowImportForm(false)}
            />
          )}

          {/* Gerenciador de SKU Composto */}
          {showCompositeManager && selectedItem && (
            <CompositeSkuManager
              mainSku={selectedItem}
              onClose={() => setShowCompositeManager(false)}
              onUpdate={() => {
                fetchInventory();
              }}
            />
          )}

          {/* Formulário de Item */}
          {showForm && (
            <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-5xl relative">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedItem ? 'Editar Item' : 'Adicionar Item ao Estoque'}
                  </h2>
                  <button className="text-gray-600 hover:text-red-600 text-2xl font-bold px-2" onClick={resetForm} title="Fechar">&times;</button>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        SKU *
                      </label>
                      <input
                        type="text"
                        value={formData.sku}
                        onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                        className="input-field"
                        required
                        placeholder="Digite o SKU"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        EAN
                      </label>
                      <input
                        type="text"
                        value={formData.ean}
                        onChange={(e) => setFormData({ ...formData, ean: e.target.value })}
                        className="input-field"
                        placeholder="Digite o EAN"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Título *
                      </label>
                      <input
                        type="text"
                        value={formData.title}
                        onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                        className="input-field"
                        required
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Quantidade
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={formData.quantity}
                        onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 0 })}
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Localização
                      </label>
                      <input
                        type="text"
                        value={formData.location}
                        onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                        className="input-field"
                        placeholder="Ex: Prateleira A1"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Qtd. Mínima
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={formData.min_quantity}
                        onChange={(e) => setFormData({ ...formData, min_quantity: parseInt(e.target.value) || 0 })}
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Qtd. Máxima
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={formData.max_quantity}
                        onChange={(e) => setFormData({ ...formData, max_quantity: parseInt(e.target.value) || '' })}
                        className="input-field"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Categoria
                      </label>
                      <select
                        value={formData.category}
                        onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                        className="input-field"
                      >
                        <option value="">Selecione uma categoria</option>
                        <option value="Arandela">Arandela</option>
                        <option value="Abajur">Abajur</option>
                        <option value="Balizador">Balizador</option>
                        <option value="Pendente">Pendente</option>
                        <option value="Trilho">Trilho</option>
                        <option value="Ventilador">Ventilador</option>
                        <option value="Outros">Outros</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Fornecedor
                      </label>
                      <input
                        type="text"
                        value={formData.supplier}
                        onChange={(e) => setFormData({ ...formData, supplier: e.target.value })}
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Preço de Custo
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={formData.cost_price}
                        onChange={(e) => setFormData({ ...formData, cost_price: e.target.value })}
                        className="input-field"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Preço de Venda
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={formData.selling_price}
                        onChange={(e) => setFormData({ ...formData, selling_price: e.target.value })}
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Observações
                      </label>
                      <textarea
                        value={formData.notes}
                        onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        className="input-field"
                        rows="3"
                      />
                    </div>
                  </div>
                  <div className="flex space-x-3">
                    <button type="submit" className="btn-primary">
                      {selectedItem ? 'Atualizar' : 'Salvar'}
                    </button>
                    <button
                      type="button"
                      onClick={resetForm}
                      className="btn-secondary"
                    >
                      Cancelar
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Lista de Itens */}
          {(loading || loadingPins) ? (
            <div className="p-6 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
              <p className="text-gray-600 mt-2">Carregando estoque...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="p-6 text-center">
              <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">Nenhum item encontrado.</p>
              <button
                onClick={() => setShowForm(true)}
                className="btn-primary mt-4"
              >
                Adicionar Primeiro Item
              </button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        Item
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        Estoque
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        Localização
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        Categoria
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        OBSERVAÇÕES
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                        Ações
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedPaginatedItems.map((item) => {
                      // Identificar se o item é um kit ou composto
                      const compositeInfo = compositeList.find(c => c.main_sku_id === item.id);
                      const isKit = compositeInfo && compositeInfo.components.length === 1;
                      const isComposto = compositeInfo && compositeInfo.components.length > 1;
                      const isCompostoOuKit = isKit || isComposto;
                      let saldoCompostoOuKit = null;
                      if (isCompostoOuKit) {
                        saldoCompostoOuKit = compositeStocks[item.id] !== undefined ? compositeStocks[item.id] : 0;
                      }
                      return (
                        <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <button
                                className="mr-2 focus:outline-none"
                                title={pinnedSkus.includes(item.sku) ? 'Desafixar' : 'Fixar'}
                                onClick={() => togglePin(item.sku)}
                                disabled={loadingPins}
                              >
                                <Star className={`w-5 h-5 ${pinnedSkus.includes(item.sku) ? 'text-yellow-400 fill-yellow-300' : 'text-gray-300'}`} fill={pinnedSkus.includes(item.sku) ? '#fde047' : 'none'} />
                              </button>
                              <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center">
                                <Package className="w-4 h-4 text-blue-600" />
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900 dark:text-white">
                                  {item.title}
                                  {isComposto && (
                                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 border border-purple-300 dark:border-purple-600">Composto</span>
                                  )}
                                  {isKit && (
                                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 border border-green-300 dark:border-green-600">Kit</span>
                                  )}
                                </div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">
                                  SKU: {item.sku} {item.ean && `| EAN: ${item.ean}`}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              {isCompostoOuKit ? (
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-purple-50 dark:bg-purple-900 text-purple-800 dark:text-purple-200 border border-purple-300 dark:border-purple-600`}>
                                  {saldoCompostoOuKit} un
                                  <span className={`ml-2 px-2 py-0.5 rounded ${isKit ? 'bg-green-200 dark:bg-green-800 text-green-800 dark:text-green-200 border-green-400 dark:border-green-600' : 'bg-purple-200 dark:bg-purple-800 text-purple-800 dark:text-purple-200 border-purple-400 dark:border-purple-600'} text-xs font-bold border`} style={{ marginLeft: 8 }}>
                                    {isKit ? 'KIT' : 'SKU COMPOSTO'}
                                  </span>
                                </span>
                              ) : (
                                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStockStatus(item)}`}>
                                  {(item.quantity !== undefined && item.quantity !== null ? item.quantity : '-')} un
                                </span>
                              )}
                            </div>
                            {item.min_quantity > 0 && (
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Mín: {item.min_quantity}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {item.location || '-'}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {item.category || '-'}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {item.notes || '-'}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            {item.is_composite ? (
                              <>
                                <button onClick={() => handleCompositeManager(item)} className="text-purple-600 dark:text-purple-400 hover:text-purple-900 dark:hover:text-purple-300 mr-3" title="Gerenciar Componentes"><Settings className="w-4 h-4" /></button>
                              </>
                            ) : null}
                            <button onClick={() => handleEdit(item)} className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-3" title="Editar"><EditIcon className="w-4 h-4" /></button>
                            <button onClick={() => handleDelete(item.id)} className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300" title="Excluir"><Trash2 className="w-4 h-4" /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex justify-center items-center py-4 space-x-2">
                  <button onClick={() => setPage(1)} disabled={page === 1} className="px-2 py-1 rounded border text-xs disabled:opacity-50 dark:border-gray-600 dark:text-gray-300">«</button>
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 rounded border text-xs disabled:opacity-50 dark:border-gray-600 dark:text-gray-300">‹</button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).slice(Math.max(0, page - 3), page + 2).map(p => (
                    <button key={p} onClick={() => setPage(p)} className={`px-2 py-1 rounded border text-xs dark:border-gray-600 dark:text-gray-300 ${p === page ? 'bg-blue-100 dark:bg-blue-900 border-blue-400 dark:border-blue-600 font-bold' : ''}`}>{p}</button>
                  ))}
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-2 py-1 rounded border text-xs disabled:opacity-50 dark:border-gray-600 dark:text-gray-300">›</button>
                  <button onClick={() => setPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 rounded border text-xs disabled:opacity-50 dark:border-gray-600 dark:text-gray-300">»</button>
                  <span className="ml-4 text-xs text-gray-500 dark:text-gray-400">Página {page} de {totalPages}</span>
                  <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }} className="ml-2 border rounded text-xs px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-white">
                    {[10, 20, 50, 100].map(sz => <option key={sz} value={sz}>{sz} por página</option>)}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {activeTab === 'compostos' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Painel de SKUs Compostos e Kits</h2>
          <p className="text-gray-600 dark:text-gray-300 mb-4">Crie e gerencie SKUs compostos (múltiplos componentes) e kits (um componente com múltiplas unidades).</p>
          
          {/* Botões para abrir formulários */}
          <div className="flex flex-wrap gap-4 mb-6">
            <button
              className="btn-primary"
              onClick={() => {
                setShowCreateComposite(!showCreateComposite);
                setShowCreateKit(false);
              }}
            >
              {showCreateComposite ? 'Cancelar' : 'Criar SKU Composto'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => {
                setShowCreateKit(!showCreateKit);
                setShowCreateComposite(false);
              }}
            >
              {showCreateKit ? 'Cancelar' : 'Criar Kit'}
            </button>
            <button className="btn-secondary" onClick={() => setShowImportKitModal(true)}>
              Importar Kits (CSV)
            </button>
            <button className="btn-secondary" onClick={() => setShowImportCompostoModal(true)}>
              Importar SKUs Compostos (CSV)
            </button>
            <button className="btn-danger" onClick={handleCleanKits} disabled={cleaningKits}>{cleaningKits ? 'Limpando...' : 'Limpar Kits'}</button>
            <button className="btn-danger" onClick={handleCleanCompostos} disabled={cleaningCompostos}>{cleaningCompostos ? 'Limpando...' : 'Limpar Compostos'}</button>
          </div>

          {/* Formulário de criação de SKU composto */}
          {showCreateComposite && (
            <form onSubmit={handleCreateComposite} className="mb-6 p-4 border rounded bg-gray-50">
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">SKU Principal</label>
                <input
                  type="text"
                  value={compositeMainSku}
                  onChange={e => setCompositeMainSku(e.target.value)}
                  className="input-field"
                  required
                  list="datalist-composite-main-sku"
                />
                <datalist id="datalist-composite-main-sku">
                  {fullInventory.filter(i => !i.is_composite).map(i => (
                    <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                  ))}
                </datalist>
              </div>
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Componentes</label>
                {compositeComponents.map((comp, idx) => (
                  <div key={idx} className="flex space-x-2 mb-2">
                    <input
                      type="text"
                      value={comp.sku}
                      onChange={e => {
                        const newComps = [...compositeComponents];
                        newComps[idx].sku = e.target.value;
                        setCompositeComponents(newComps);
                      }}
                      className="input-field"
                      required
                      list={`datalist-composite-component-sku-${idx}`}
                    />
                    <datalist id={`datalist-composite-component-sku-${idx}`}>
                      {fullInventory.filter(i => !i.is_composite && i.sku !== compositeMainSku && !compositeComponents.some((c, cidx) => c.sku === i.sku && cidx !== idx)).map(i => (
                        <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                      ))}
                    </datalist>
                    <input
                      type="number"
                      min="1"
                      value={comp.quantity}
                      onChange={e => {
                        const newComps = [...compositeComponents];
                        newComps[idx].quantity = parseInt(e.target.value) || 1;
                        setCompositeComponents(newComps);
                      }}
                      className="input-field w-24"
                      required
                    />
                    <button type="button" className="btn-danger px-2" onClick={() => {
                      setCompositeComponents(compositeComponents.filter((_, i) => i !== idx));
                    }} disabled={compositeComponents.length <= 2}>-</button>
                  </div>
                ))}
                <button type="button" className="btn-secondary mt-2" onClick={() => setCompositeComponents([...compositeComponents, { sku: '', quantity: 1 }])}>Adicionar Componente</button>
              </div>
              {compositeError && <div className="text-red-600 mb-2">{compositeError}</div>}
              <button type="submit" className="btn-primary">Salvar SKU Composto</button>
              <button type="button" className="btn-secondary ml-2" onClick={() => setShowCreateComposite(false)}>Cancelar</button>
            </form>
          )}

          {/* Formulário de criação de Kit */}
          {showCreateKit && (
            <form onSubmit={handleCreateKit} className="mb-6 p-4 border rounded bg-gray-50">
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">SKU Principal</label>
                <input
                  type="text"
                  value={kitMainSku}
                  onChange={e => setKitMainSku(e.target.value)}
                  className="input-field"
                  required
                  list="datalist-kit-main-sku"
                />
                <datalist id="datalist-kit-main-sku">
                  {fullInventory.filter(i => !i.is_composite).map(i => (
                    <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                  ))}
                </datalist>
              </div>
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Componente</label>
                <input
                  type="text"
                  value={kitComponentSku}
                  onChange={e => setKitComponentSku(e.target.value)}
                  className="input-field"
                  required
                  list="datalist-kit-component-sku"
                />
                <datalist id="datalist-kit-component-sku">
                  {fullInventory.filter(i => !i.is_composite && i.sku !== kitMainSku).map(i => (
                    <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                  ))}
                </datalist>
              </div>
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Quantidade</label>
                <input
                  type="number"
                  min="1"
                  value={kitQuantity}
                  onChange={e => setKitQuantity(parseInt(e.target.value) || 1)}
                  className="input-field"
                  required
                />
              </div>
              {kitError && <div className="text-red-600 mb-2">{kitError}</div>}
              <button type="submit" className="btn-primary">Salvar Kit</button>
            </form>
          )}

          {/* Formulário de edição de SKUs compostos/kits */}
          {editingComposite && (
            <form onSubmit={handleEditComposite} className="mb-6 p-4 border rounded bg-yellow-50">
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">SKU Principal</label>
                <input
                  type="text"
                  value={editingMainSku}
                  onChange={e => setEditingMainSku(e.target.value)}
                  className="input-field"
                  required
                  list="datalist-edit-main-sku"
                />
                <datalist id="datalist-edit-main-sku">
                  {fullInventory.filter(i => !i.is_composite).map(i => (
                    <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                  ))}
                </datalist>
              </div>
              <div className="mb-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">Componentes</label>
                {editingComponents.map((comp, idx) => (
                  <div key={idx} className="flex space-x-2 mb-2">
                    <input
                      type="text"
                      value={comp.sku}
                      onChange={e => {
                        const newComps = [...editingComponents];
                        newComps[idx].sku = e.target.value;
                        setEditingComponents(newComps);
                      }}
                      className="input-field"
                      required
                      list={`datalist-edit-component-sku-${idx}`}
                    />
                    <datalist id={`datalist-edit-component-sku-${idx}`}>
                      {fullInventory.filter(i => !i.is_composite && i.sku !== editingMainSku && !editingComponents.some((c, cidx) => c.sku === i.sku && cidx !== idx)).map(i => (
                        <option key={i.id} value={i.sku}>{i.sku} - {i.title}</option>
                      ))}
                    </datalist>
                    <input
                      type="number"
                      min="1"
                      value={comp.quantity}
                      onChange={e => {
                        const newComps = [...editingComponents];
                        newComps[idx].quantity = parseInt(e.target.value) || 1;
                        setEditingComponents(newComps);
                      }}
                      className="input-field w-24"
                      placeholder="Qtd"
                      required
                    />
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setEditingComponents(editingComponents.filter((_, i) => i !== idx));
                      }}
                      disabled={editingComponents.length <= 1}
                    >
                      Remover
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn-secondary mt-2"
                  onClick={() => setEditingComponents([...editingComponents, { sku: '', quantity: 1 }])}
                >
                  Adicionar Componente
                </button>
              </div>
              {editingError && <div className="text-red-600 mb-2">{editingError}</div>}
              <button type="submit" className="btn-primary">Salvar Alterações</button>
              <button type="button" className="btn-secondary ml-2" onClick={() => setEditingComposite(null)}>Cancelar</button>
            </form>
          )}

          {/* Listagem dos SKUs compostos */}
          {compositeList.length === 0 ? (
            <div className="text-gray-500">Nenhum SKU composto ou kit cadastrado.</div>
          ) : (
            <div className="space-y-6">
              {/* Seção SKUs Compostos */}
              <h3 className="text-base font-bold text-purple-800 mt-8 mb-2">SKUs Compostos</h3>
              {compositeList.filter(c => c.components.length > 1).length === 0 && (
                <div className="mb-4 text-gray-500">Nenhum SKU composto cadastrado.</div>
              )}
              {compositeList.filter(c => c.components.length > 1).map((c, idx) => (
                <div key={c.main_sku_id} className="mb-4 p-4 rounded bg-purple-50">
                  <div className="font-bold text-purple-900 text-lg mb-1">
                    {c.main_sku} - {c.main_title}
                  </div>
                  <div className="mb-2 text-sm font-semibold text-gray-700">Componentes:</div>
                  <ul className="mb-2 ml-4 list-disc text-sm">
                    {c.components.map((comp, i) => (
                      <li key={i}>
                        {comp.component_sku} - {comp.component_title} (Qtd: {comp.quantity})
                      </li>
                    ))}
                  </ul>
                  <button className="btn-secondary mr-2" onClick={() => handleEditComposite(c)}>Editar</button>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      if (window.confirm('Tem certeza que deseja excluir este SKU composto? Esta ação não pode ser desfeita.')) {
                        try {
                          await axios.delete(`/api/inventory/${c.main_sku_id}`);
                          fetchCompositeList();
                          fetchInventory();
                        } catch (error) {
                          alert('Erro ao excluir SKU composto.');
                        }
                      }
                    }}
                  >
                    Excluir
                  </button>
                </div>
              ))}

              {/* Seção Kits */}
              <h3 className="text-base font-bold text-green-800 mt-8 mb-2">Kits</h3>
              {compositeList.filter(c => c.components.length === 1).length === 0 && (
                <div className="mb-4 text-gray-500">Nenhum kit cadastrado.</div>
              )}
              {compositeList.filter(c => c.components.length === 1).map((c, idx) => (
                <div key={c.main_sku_id} className="mb-4 p-4 rounded bg-green-50">
                  <div className="font-bold text-green-900 text-lg mb-1">
                    {c.main_sku} - {c.main_title}
                  </div>
                  <div className="mb-2 text-sm font-semibold text-gray-700">Componente:</div>
                  <ul className="mb-2 ml-4 list-disc text-sm">
                    {c.components.map((comp, i) => (
                      <li key={i}>
                        {comp.component_sku} - {comp.component_title} (Qtd: {comp.quantity})
                      </li>
                    ))}
                  </ul>
                  <button className="btn-secondary mr-2" onClick={() => handleEditKit(c)}>Editar</button>
                  <button
                    className="btn-danger"
                    onClick={async () => {
                      if (window.confirm('Tem certeza que deseja excluir este kit? Esta ação não pode ser desfeita.')) {
                        try {
                          await axios.delete(`/api/inventory/${c.main_sku_id}`);
                          fetchCompositeList();
                          fetchInventory();
                        } catch (error) {
                          alert('Erro ao excluir kit.');
                        }
                      }
                    }}
                  >
                    Excluir
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {activeTab === 'movimentacao' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Movimentação de Estoque</h2>
          <p className="text-gray-600 dark:text-gray-300 mb-4">Registre entradas e saídas de estoque e visualize o histórico de movimentações.</p>
          {/* Formulário de movimentação */}
          <form className="mb-6 flex flex-wrap gap-4 items-end" onSubmit={async (e) => {
            e.preventDefault();
            setMovementError('');
            setMovementLoading(true);
            if (!movementForm.skuId || !movementForm.quantity || movementForm.quantity < 1) {
              setMovementError('Preencha todos os campos corretamente.');
              setMovementLoading(false);
              return;
            }
            // Buscar o id do item pelo SKU digitado
            const item = fullInventory.find(i => limparSkuB(i.sku.trim().toUpperCase()) === limparSkuB(movementForm.skuId.trim().toUpperCase()));
            if (!item) {
              setMovementError('SKU não encontrado no estoque.');
              setMovementLoading(false);
              return;
            }
            try {
              const movement_type = movementForm.type === 'entrada' ? 'in' : 'out';
              await axios.post(`/api/inventory/${item.id}/movement`, {
                movement_type,
                quantity: Number(movementForm.quantity),
                user_id: user.id // Adicionar ID do usuário logado
              });
              setMovementForm({ skuId: '', type: 'entrada', quantity: 1 });
              fetchMovements();
            } catch (err) {
              setMovementError('Erro ao registrar movimentação.');
            } finally {
              setMovementLoading(false);
            }
          }}>
            <div className="w-64">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SKU</label>
              <input
                type="text"
                className="input-field dark:bg-gray-700 dark:text-white dark:border-gray-600"
                required
                value={movementForm.skuId}
                onChange={e => setMovementForm(f => ({ ...f, skuId: e.target.value }))}
                placeholder="Buscar por SKU, EAN ou título..."
                list="datalist-movimentacao-sku"
                autoComplete="off"
              />
              <datalist id="datalist-movimentacao-sku">
                {fullInventory.filter(i => {
                  const termo = movementForm.skuId.trim().toLowerCase();
                  if (!termo) return false;
                  return (
                    i.sku.toLowerCase().includes(termo) ||
                    (i.ean && i.ean.toLowerCase().includes(termo)) ||
                    (i.title && i.title.toLowerCase().includes(termo))
                  );
                }).slice(0, 20).map(i => (
                  <option key={i.id} value={i.sku}>{i.sku} - {i.title}{i.ean ? ` | EAN: ${i.ean}` : ''}</option>
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tipo</label>
              <select className="input-field dark:bg-gray-700 dark:text-white dark:border-gray-600" required value={movementForm.type} onChange={e => setMovementForm(f => ({ ...f, type: e.target.value }))}>
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantidade</label>
              <input type="number" min="1" className="input-field w-24 dark:bg-gray-700 dark:text-white dark:border-gray-600" required value={movementForm.quantity} onChange={e => setMovementForm(f => ({ ...f, quantity: e.target.value }))} />
            </div>
            <button type="submit" className="btn-primary" disabled={movementLoading}>{movementLoading ? 'Registrando...' : 'Registrar'}</button>
            <div className="w-80 ml-auto">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Pesquisar</label>
              <input
                type="text"
                placeholder="Pesquisar por SKU ou título..."
                value={movementsSearchTerm}
                onChange={(e) => setMovementsSearchTerm(e.target.value)}
                className="input-field dark:bg-gray-700 dark:text-white dark:border-gray-600"
              />
            </div>
          </form>
          
          {movementError && <div className="text-red-600 mb-2">{movementError}</div>}
          {/* Histórico de movimentações */}
          <h3 className="text-md font-semibold text-gray-800 dark:text-white mb-2">Histórico</h3>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Data</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">SKU</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Item</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Tipo</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Quantidade</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Usuário</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {movementsLoading ? (
                  <tr>
                    <td className="px-4 py-2 dark:text-white text-center" colSpan={6}>Carregando...</td>
                  </tr>
                ) : movements.length === 0 ? (
                  <tr>
                    <td className="px-4 py-2 dark:text-white text-center" colSpan={6}>
                      {movementsSearchTerm ? 'Nenhuma movimentação encontrada para a pesquisa.' : 'Nenhuma movimentação registrada.'}
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id}>
                      <td className="px-4 py-2 dark:text-white">
                        {(() => {
                          // Formatação correta da data - SQLite salva em UTC, converter para horário local
                          const date = new Date(m.movement_date);
                          return date.toLocaleString('pt-BR', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            timeZone: 'America/Sao_Paulo'
                          });
                        })()}
                      </td>
                      <td className="px-4 py-2 dark:text-white">{m.item_sku}</td>
                      <td className="px-4 py-2 dark:text-white">{m.item_title}</td>
                      <td className="px-4 py-2 dark:text-white">{m.movement_type === 'in' ? 'Entrada' : m.movement_type === 'out' ? 'Saída' : 'Ajuste'}</td>
                      <td className="px-4 py-2 dark:text-white">{m.quantity}</td>
                      <td className="px-4 py-2 dark:text-white">{m.user_name || 'Sistema'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          
          {/* Paginação das movimentações */}
          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-700 dark:text-gray-300">Itens por página:</label>
                <select
                  value={movementsPageSize}
                  onChange={(e) => {
                    setMovementsPageSize(Number(e.target.value));
                    setMovementsPage(1);
                  }}
                  className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
              {movementsTotal > movementsPageSize && (
                <div className="text-sm text-gray-700 dark:text-gray-300">
                  Mostrando {((movementsPage - 1) * movementsPageSize) + 1} a {Math.min(movementsPage * movementsPageSize, movementsTotal)} de {movementsTotal} movimentações
                </div>
              )}
            </div>
            {movementsTotal > movementsPageSize && (
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setMovementsPage(p => Math.max(1, p - 1))}
                  disabled={movementsPage === 1}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Anterior
                </button>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  Página {movementsPage} de {Math.ceil(movementsTotal / movementsPageSize)}
                </span>
                <button
                  onClick={() => setMovementsPage(p => Math.min(Math.ceil(movementsTotal / movementsPageSize), p + 1))}
                  disabled={movementsPage >= Math.ceil(movementsTotal / movementsPageSize)}
                  className="px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded dark:bg-gray-700 dark:text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Próxima
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {activeTab === 'historico-aglutinados' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Histórico de Aglutinados</h2>
          {loadingAglutinados ? (
            <div className="text-center text-gray-500 dark:text-gray-400">Carregando...</div>
          ) : aglutinados.length === 0 ? (
            <div className="text-center text-gray-500 dark:text-gray-400">Nenhum aglutinado salvo.</div>
          ) : (
            <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-700">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Data</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Marketplaces</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Ações</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                  {aglutinados.map(a => (
                    <tr key={a.id}>
                      <td className="px-4 py-2 dark:text-white">{new Date(a.data_criacao).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</td>
                      <td className="px-4 py-2 dark:text-white">{a.marketplaces}</td>
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
      )}
      {showImportKitModal && <ImportKitModal />}
      {showImportCompostoModal && <ImportCompostoModal />}
    </div>
  );
}; 