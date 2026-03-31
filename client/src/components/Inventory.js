import React, { useState, useEffect, useRef } from 'react';
import { 
  Plus, Edit as EditIcon, Trash2, Package, Search, Download, Upload, 
  TrendingUp, AlertTriangle, MapPin, Barcode, Hash, Settings, 
  Wrench, CheckCircle, Funnel, Star, RefreshCw, ChevronDown
} from 'lucide-react';
import axios from 'axios';
import { InventoryImport } from './InventoryImport';
import { CompositeSkuManager } from './CompositeSkuManager';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDebounce } from '../hooks/useDebounce';
import { useToast } from './Toast';

export const Inventory = ({ user }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
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
  const [blingAccounts, setBlingAccounts] = useState([]);
  const [activeAccountFilter, setActiveAccountFilter] = useState('all');
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
  
  // Estados de imagem do SKU
  const [imageUpload, setImageUpload] = useState({ mime: '', base64: '' });
  const [imageBySku, setImageBySku] = useState({});
  const [existingImageUrl, setExistingImageUrl] = useState('');
  const [imageCache, setImageCache] = useState({});

  const debouncedSearchTerm = useDebounce(searchTerm, 400);

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
    cubic_weight: '',
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
  const [showCompostosActionsMenu, setShowCompostosActionsMenu] = useState(false);
  const compostosActionsRef = useRef(null);
  const [aglutinados, setAglutinados] = useState([]);
  const [visualizarAglutinado, setVisualizarAglutinado] = useState(null);
  const [loadingAglutinados, setLoadingAglutinados] = useState(false);
  const [aglutinadosPage, setAglutinadosPage] = useState(1);
  const [aglutinadosPerPage, setAglutinadosPerPage] = useState(15);
  const [aglutinadoMenuOpen, setAglutinadoMenuOpen] = useState(null);

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

  // Sincronizar aba ativa com o parâmetro 'tab' da URL (aba "Fluxo dia" / consulta removida)
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab === 'consulta') {
      setActiveTab('itens');
      navigate('/inventory?tab=itens', { replace: true });
      return;
    }
    if (tab && ['itens', 'compostos', 'movimentacao', 'historico-aglutinados'].includes(tab) && tab !== activeTab) {
      setActiveTab(tab);
    }
  }, [location.search, activeTab, navigate]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await axios.get('/api/bling/accounts');
        const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : [];
        if (!mounted) return;
        setBlingAccounts(accounts);
      } catch {
        if (mounted) setBlingAccounts([]);
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    fetchInventory();
  }, [debouncedSearchTerm, page, pageSize, filterLowStock, filterNoStock, filterWithStock]);

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
  }, [activeTab, movementsPage, movementsPageSize, movementsSearchTerm, activeAccountFilter]);

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
      if (showCompostosActionsMenu && compostosActionsRef.current && !compostosActionsRef.current.contains(event.target)) {
        setShowCompostosActionsMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilter, showReportsMenu, showCompostosActionsMenu]);

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
      toast.error('Erro ao atualizar SKUs fixados. Faça login novamente.');
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
      if (debouncedSearchTerm) params.append('search', debouncedSearchTerm);
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
      if (activeAccountFilter && activeAccountFilter !== 'all') {
        params.append('accountId', activeAccountFilter);
      }
      
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
      let savedSku = formData.sku;
      if (selectedItem) {
        await axios.put(`/api/inventory/${selectedItem.id}`, dataToSend);
      } else {
        await axios.post('/api/inventory', dataToSend);
      }
      // Upload de imagem se houver
      if (imageUpload.base64 && savedSku) {
        await axios.post(`/api/inventory/${savedSku}/image`, { mime: imageUpload.mime, image_base64: imageUpload.base64 });
      }
      resetForm();
      fetchInventory();
    } catch (error) {
      console.error('Erro ao salvar item:', error);
      toast.error('Erro ao salvar item. Verifique os dados.');
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
        toast.error('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        toast.error('Sessão expirada. Faça login novamente.');
      } else {
        toast.error('Erro na exportação.');
      }
    }
  };

  // Exportar imagens (CSV)
  const handleExportImages = async () => {
    try {
      const res = await axios.get('/api/inventory/images/export-csv', { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a'); a.href = url; a.download = 'inventory_images.csv'; a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('Erro ao exportar imagens.');
    }
  };

  // Importar imagens em lote (CSV: SKU,MIME,BASE64) ou JSON
  const [bulkImagesText, setBulkImagesText] = useState('');
  const [showBulkImageModal, setShowBulkImageModal] = useState(false);
  const handleImportImages = async () => {
    let items = [];
    const txt = bulkImagesText.trim();
    try {
      if (txt.startsWith('[')) {
        items = JSON.parse(txt);
      } else {
        // CSV simples
        const lines = txt.split(/\r?\n/).filter(l => l.trim());
        const start = lines[0].toLowerCase().includes('sku') ? 1 : 0;
        for (let i = start; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 3) continue;
          const sku = cols[0].replace(/^"|"$/g,'').trim();
          const mime = cols[1].replace(/^"|"$/g,'').trim();
          const b64 = cols.slice(2).join(',').replace(/^"|"$/g,'').trim();
          items.push({ sku, mime, image_base64: b64 });
        }
      }
      const res = await axios.post('/api/inventory/images/bulk', items);
      toast.success(`Importadas: ${res.data.imported} | Falhas: ${res.data.failed}`);
      setShowBulkImageModal(false); setBulkImagesText('');
    } catch (e) {
      toast.error('Erro ao importar imagens (verifique o formato).');
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
        toast.error('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        toast.error('Sessão expirada. Faça login novamente.');
      } else {
        toast.error('Erro na exportação do relatório.');
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
        toast.error('Acesso negado. Nível de usuário insuficiente.');
      } else if (error.response?.status === 401) {
        toast.error('Sessão expirada. Faça login novamente.');
      } else {
        toast.error('Erro na exportação do relatório.');
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
    setImageUpload({ mime: '', base64: '' });
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
      cubic_weight: item.cubic_weight || '',
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
      cubic_weight: '',
      notes: '',
      is_composite: false
    });
    setSelectedItem(null);
    setShowForm(false);
    setImageUpload({ mime: '', base64: '' });
    setExistingImageUrl('');
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
    
    // Buscar os IDs a partir dos SKUs digitados (usa limparSkuB para 95095 = 95095B)
    const mainItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(compositeMainSku || '')));
    if (!mainItem) {
      setCompositeError('SKU principal não encontrado.');
      return;
    }
    
    const componentsWithId = compositeComponents.map(c => {
      const compItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(c.sku || '')));
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
      toast.success('SKU composto criado com sucesso.');
    } catch (err) {
      setCompositeError(err?.response?.data?.error || 'Erro ao criar SKU composto. Verifique os dados.');
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
    if (limparSkuB(String(kitMainSku || '')) === limparSkuB(String(kitComponentSku || ''))) {
      setKitError('O SKU principal não pode ser o mesmo do componente.');
      return;
    }
    const mainItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(kitMainSku || '')));
    const componentItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(kitComponentSku || '')));
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
      await axios.post('/api/composite-skus', payload);
      await axios.put(`/api/inventory/${mainItem.id}`, { ...mainItem, is_composite: 1 });
      
      setShowCreateKit(false);
      setKitMainSku('');
      setKitComponentSku('');
      setKitQuantity(1);
      fetchCompositeList();
      fetchInventory();
      toast.success('Kit criado com sucesso.');
    } catch (err) {
      setKitError(err?.response?.data?.error || 'Erro ao criar kit. Verifique os dados.');
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
    if (editingComponents.some(c => limparSkuB(String(c.sku || '')) === limparSkuB(String(editingMainSku || '')))) {
      setEditingError('O SKU principal não pode ser um componente.');
      return;
    }
    const skus = editingComponents.map(c => limparSkuB(String(c.sku || '')));
    if (new Set(skus).size !== skus.length) {
      setEditingError('Não repita SKUs nos componentes.');
      return;
    }
    const mainItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(editingMainSku || '')));
    if (!mainItem) {
      setEditingError('SKU principal não encontrado.');
      return;
    }
    const componentsWithId = editingComponents.map(c => {
      const compItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(c.sku || '')));
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
    setEditingKitMainSku(fullInventory.find(i => i.id === kit.main_sku_id)?.sku || kit.main_sku || '');
    setEditingKitComponentSku(fullInventory.find(i => i.id === kit.components[0].component_sku_id)?.sku || kit.components[0].component_sku || '');
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
    if (limparSkuB(String(editingKitMainSku || '')) === limparSkuB(String(editingKitComponentSku || ''))) {
      setEditingKitError('O SKU principal não pode ser o mesmo do componente.');
      return;
    }
    const mainItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(editingKitMainSku || '')));
    const componentItem = fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(editingKitComponentSku || '')));
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
    const findItemBySku = (sku) => fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(sku || '')));
    const handleFileUpload = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setCsvData(event.target.result);
        };
        reader.readAsText(file, 'UTF-8');
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
          const mainItem = findItemBySku(mainSku);
          const componentItem = findItemBySku(compSku);
          if (!mainItem || !componentItem) {
            fail++;
            const missing = [!mainItem && mainSku, !componentItem && compSku].filter(Boolean).join(', ');
            errors.push(`Linha ${i+1}: SKU não encontrado no estoque (${missing})`);
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
        if (ok > 0) toast.success(`${ok} kit(s) importado(s) com sucesso.`);
      } catch (err) {
        setResult({ ok: 0, fail: 1, errors: [err.message] });
        toast.error('Erro ao importar kits.');
      }
      setLoading(false);
    };
    const templateCsv = 'SKU_PRINCIPAL,SKU_COMPONENTE,QUANTIDADE\n95095,S0130,2\n';
    const downloadTemplate = () => {
      const blob = new Blob([templateCsv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'template_kits.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg">
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-blue-600" />
              Importar Kits via CSV
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Formato: SKU principal, SKU componente, quantidade (3 colunas)</p>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-colors">
                <Upload className="w-5 h-5 text-gray-500" />
                <span className="text-sm font-medium">Selecionar arquivo CSV</span>
                <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
              </label>
              <button type="button" onClick={downloadTemplate} className="btn-secondary whitespace-nowrap">
                <Download className="w-4 h-4 mr-1 inline" /> Template
              </button>
            </div>
            <textarea className="input-field w-full text-sm font-mono" rows={6} value={csvData} onChange={e => setCsvData(e.target.value)} placeholder={'SKU_PRINCIPAL,SKU_COMPONENTE,QUANTIDADE\n95095,S0130,2\n95437,52525,2'} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={handleImport} disabled={loading || !csvData.trim()}>
                {loading ? 'Importando...' : 'Importar'}
              </button>
              <button className="btn-secondary" onClick={() => setShowImportKitModal(false)} disabled={loading}>Fechar</button>
            </div>
            {result && (
              <div className={`p-3 rounded-lg text-sm ${result.fail > 0 ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200' : 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'}`}>
                <strong>{result.ok}</strong> importados, <strong>{result.fail}</strong> falharam.
                {result.errors?.length > 0 && (
                  <ul className="mt-2 list-disc ml-5 text-red-600 dark:text-red-400 max-h-24 overflow-y-auto">{result.errors.slice(0, 10).map((e,i) => <li key={i}>{e}</li>)}{result.errors.length > 10 && <li>... e mais {result.errors.length - 10} erros</li>}</ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 5. Modal de importação de compostos
  function ImportCompostoModal() {
    const [csvData, setCsvData] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);
    const findItemBySku = (sku) => fullInventory.find(i => limparSkuB(String(i.sku || '')) === limparSkuB(String(sku || '')));
    const handleFileUpload = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setCsvData(event.target.result);
        };
        reader.readAsText(file, 'UTF-8');
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
          const mainItem = findItemBySku(mainSku);
          if (!mainItem) {
            fail++;
            errors.push(`Linha ${i+1}: SKU principal '${mainSku}' não encontrado no estoque`);
            continue;
          }
          let allOk = true;
          let components = [];
          for (let j = 1; j < cols.length; j += 2) {
            const compSku = cols[j];
            const qty = cols[j+1];
            const compItem = findItemBySku(compSku);
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
        if (ok > 0) toast.success(`${ok} composto(s) importado(s) com sucesso.`);
      } catch (err) {
        setResult({ ok: 0, fail: 1, errors: [err.message] });
        toast.error('Erro ao importar compostos.');
      }
      setLoading(false);
    };
    const templateCsv = 'SKU_PRINCIPAL,COMP1,QTD1,COMP2,QTD2\n12345,S0130,2,S0140,1\n';
    const downloadTemplate = () => {
      const blob = new Blob([templateCsv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'template_compostos.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    };
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg">
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-blue-600" />
              Importar SKUs Compostos via CSV
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Formato: SKU principal, COMP1, QTD1, COMP2, QTD2, ... (ímpar de colunas)</p>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex gap-2">
              <label className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-colors">
                <Upload className="w-5 h-5 text-gray-500" />
                <span className="text-sm font-medium">Selecionar arquivo CSV</span>
                <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
              </label>
              <button type="button" onClick={downloadTemplate} className="btn-secondary whitespace-nowrap">
                <Download className="w-4 h-4 mr-1 inline" /> Template
              </button>
            </div>
            <textarea className="input-field w-full text-sm font-mono" rows={6} value={csvData} onChange={e => setCsvData(e.target.value)} placeholder={'SKU_PRINCIPAL,COMP1,QTD1,COMP2,QTD2\n12345,S0130,2,S0140,1'} />
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={handleImport} disabled={loading || !csvData.trim()}>
                {loading ? 'Importando...' : 'Importar'}
              </button>
              <button className="btn-secondary" onClick={() => setShowImportCompostoModal(false)} disabled={loading}>Fechar</button>
            </div>
            {result && (
              <div className={`p-3 rounded-lg text-sm ${result.fail > 0 ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200' : 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'}`}>
                <strong>{result.ok}</strong> importados, <strong>{result.fail}</strong> falharam.
                {result.errors?.length > 0 && (
                  <ul className="mt-2 list-disc ml-5 text-red-600 dark:text-red-400 max-h-24 overflow-y-auto">{result.errors.slice(0, 10).map((e,i) => <li key={i}>{e}</li>)}{result.errors.length > 10 && <li>... e mais {result.errors.length - 10} erros</li>}</ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 2. Função para limpar todos os kits
  async function handleCleanKits() {
    if (!window.confirm('Tem certeza que deseja remover TODOS os kits? Esta ação não pode ser desfeita.')) return;
    setCleaningKits(true);
    try {
      const res = await axios.get('/api/composite-skus');
      const kitEntries = res.data.filter(c => c.components.length === 1);
      const mainIds = [...new Set(kitEntries.map(c => c.main_sku_id))];
      for (const c of kitEntries) {
        for (const comp of c.components) {
          if (comp.id) await axios.delete(`/api/composite-skus/${comp.id}`);
        }
      }
      for (const mid of mainIds) {
        const item = fullInventory.find(i => i.id === mid);
        if (item) await axios.put(`/api/inventory/${mid}`, { ...item, is_composite: 0 });
      }
      fetchCompositeList();
      fetchInventory();
      toast.success(`${kitEntries.length} kit(s) removido(s).`);
    } catch (err) {
      toast.error('Erro ao limpar kits.');
    }
    setCleaningKits(false);
  }

  // 3. Função para limpar todos os compostos
  async function handleCleanCompostos() {
    if (!window.confirm('Tem certeza que deseja remover TODOS os SKUs compostos? Esta ação não pode ser desfeita.')) return;
    setCleaningCompostos(true);
    try {
      const res = await axios.get('/api/composite-skus');
      const compEntries = res.data.filter(c => c.components.length > 1);
      const mainIds = [...new Set(compEntries.map(c => c.main_sku_id))];
      for (const c of compEntries) {
        for (const comp of c.components) {
          if (comp.id) await axios.delete(`/api/composite-skus/${comp.id}`);
        }
      }
      for (const mid of mainIds) {
        const item = fullInventory.find(i => i.id === mid);
        if (item) await axios.put(`/api/inventory/${mid}`, { ...item, is_composite: 0 });
      }
      fetchCompositeList();
      fetchInventory();
      toast.success(`${compEntries.length} composto(s) removido(s).`);
    } catch (err) {
      toast.error('Erro ao limpar compostos.');
    }
    setCleaningCompostos(false);
  }

  // Função utilitária para limpar o 'B' do final do SKU
  function limparSkuB(sku) {
    return typeof sku === 'string' ? sku.replace(/B$/, '') : sku;
  }

  const getAccountLabel = (accountId) => {
    const match = blingAccounts.find(acc => Number(acc.id) === Number(accountId));
    return match?.name || (accountId ? `Conta ${accountId}` : '—');
  };

  async function onImageFileSelected(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full = String(ev.target.result || '');
      const base64 = full.includes(',') ? full.split(',')[1] : full;
      setImageUpload({ mime: file.type, base64 });
    };
    reader.readAsDataURL(file);
  }

  // Carregar imagem existente ao abrir o modal de edição
  useEffect(() => {
    const sku = selectedItem?.sku ? String(selectedItem.sku).replace(/[^0-9A-Za-z_-]/g, '') : '';
    if (!sku) { setExistingImageUrl(''); return; }
    const cached = imageBySku[sku] || imageCache[sku];
    if (cached) { setExistingImageUrl(cached); return; }
    (async () => {
      try {
        const res = await axios.get(`/api/inventory/${encodeURIComponent(sku)}/image`, { validateStatus: () => true });
        if (res.status === 200 && res.data?.image_base64 && res.data?.mime) {
          setExistingImageUrl(`data:${res.data.mime};base64,${res.data.image_base64}`);
        } else {
          setExistingImageUrl('');
        }
      } catch {
        setExistingImageUrl('');
      }
    })();
  }, [selectedItem, imageBySku, imageCache]);

  // Buscar miniaturas para os itens visíveis
  useEffect(() => {
    const visibleSkus = sortedPaginatedItems.map(i => i.sku).filter(Boolean);
    visibleSkus.forEach(async (sku) => {
      if (imageBySku[sku]) return;
      try {
        const res = await axios.get(`/api/inventory/${encodeURIComponent(sku)}/image`, { validateStatus: () => true });
        if (res.status === 200 && res.data?.image_base64 && res.data?.mime) {
          const dataUrl = `data:${res.data.mime};base64,${res.data.image_base64}`;
          setImageBySku(prev => ({ ...prev, [sku]: dataUrl }));
        }
      } catch {}
    });
    // eslint-disable-next-line
  }, [sortedPaginatedItems.length, page, pageSize]);

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
                        handleExportImages();
                        setShowReportsMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900 border-b border-gray-100 dark:border-gray-600"
                    >
                      Exportar Imagens (CSV)
                    </button>
                    <button
                      onClick={() => {
                        setShowBulkImageModal(true);
                        setShowReportsMenu(false);
                      }}
                      className="w-full text-left px-4 py-2 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900 border-b border-gray-100 dark:border-gray-600"
                    >
                      Importar Imagens (CSV/JSON)
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

          {/* Modal de importação de imagens */}
          {showBulkImageModal && (
            <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
              <div className="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl">
                <h2 className="text-lg font-bold mb-2">Importar Imagens (CSV/JSON)</h2>
                <p className="text-sm text-gray-600 mb-2">CSV: SKU,MIME,BASE64 (uma por linha). Ou cole um array JSON de objetos {`{sku,mime,image_base64}`}</p>
                <textarea className="input-field w-full" rows={10} value={bulkImagesText} onChange={e => setBulkImagesText(e.target.value)} placeholder="SKU,MIME,BASE64\n12345,image/jpeg,/9j/4AAQSkZJRg..." />
                <div className="flex gap-2 mt-3">
                  <button className="btn-primary" onClick={handleImportImages}>Importar</button>
                  <button className="btn-secondary" onClick={() => setShowBulkImageModal(false)}>Fechar</button>
                </div>
              </div>
            </div>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                        Peso cúbico (kg)
                      </label>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        value={formData.cubic_weight}
                        onChange={(e) => setFormData({ ...formData, cubic_weight: e.target.value })}
                        className="input-field"
                        placeholder="Ex.: 0.250"
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
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="p-6 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
              Painel de SKUs Compostos e Kits
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mt-1 text-sm">Crie e gerencie SKUs compostos (múltiplos componentes) e kits (um componente com múltiplas unidades).</p>
          </div>
          
          {/* Menu de ações (discreto) */}
          <div className="px-6 py-3 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              <button
                className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${showCreateComposite ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                onClick={() => { setShowCreateComposite(!showCreateComposite); setShowCreateKit(false); }}
              >
                <Plus className="w-4 h-4" />
                {showCreateComposite ? 'Cancelar' : 'Criar Composto'}
              </button>
              <button
                className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${showCreateKit ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                onClick={() => { setShowCreateKit(!showCreateKit); setShowCreateComposite(false); }}
              >
                <Plus className="w-4 h-4" />
                {showCreateKit ? 'Cancelar' : 'Criar Kit'}
              </button>
            </div>
            <div className="relative" ref={compostosActionsRef}>
              <button
                onClick={() => setShowCompostosActionsMenu(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                <Settings className="w-4 h-4" />
                Mais ações
                <ChevronDown className={`w-4 h-4 transition-transform ${showCompostosActionsMenu ? 'rotate-180' : ''}`} />
              </button>
              {showCompostosActionsMenu && (
                <div className="absolute right-0 mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-20 py-1">
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Importar</div>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={() => { setShowImportKitModal(true); setShowCompostosActionsMenu(false); }}>
                    <Upload className="w-4 h-4" /> Importar Kits (CSV)
                  </button>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={() => { setShowImportCompostoModal(true); setShowCompostosActionsMenu(false); }}>
                    <Upload className="w-4 h-4" /> Importar Compostos (CSV)
                  </button>
                  <div className="border-t border-gray-200 dark:border-gray-600 my-1" />
                  <div className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase">Limpar</div>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 text-red-600 dark:text-red-400" onClick={() => { handleCleanKits(); setShowCompostosActionsMenu(false); }} disabled={cleaningKits}>
                    <Trash2 className="w-4 h-4" /> {cleaningKits ? 'Limpando...' : 'Limpar Kits'}
                  </button>
                  <button className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 text-red-600 dark:text-red-400" onClick={() => { handleCleanCompostos(); setShowCompostosActionsMenu(false); }} disabled={cleaningCompostos}>
                    <Trash2 className="w-4 h-4" /> {cleaningCompostos ? 'Limpando...' : 'Limpar Compostos'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Formulário de criação de SKU composto */}
          {showCreateComposite && (
            <form onSubmit={handleCreateComposite} className="mx-6 mb-6 p-5 border border-indigo-200 dark:border-indigo-800 rounded-xl bg-indigo-50/50 dark:bg-indigo-900/10">
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
            <form onSubmit={handleCreateKit} className="mx-6 mb-6 p-5 border border-emerald-200 dark:border-emerald-800 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10">
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

          {/* Listagem em duas colunas */}
          <div className="px-6 pb-6">
          {compositeList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Package className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" />
              <p className="text-gray-500 dark:text-gray-400">Nenhum SKU composto ou kit cadastrado.</p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Use os botões acima para criar ou importar.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Coluna SKUs Compostos */}
              <section className="min-h-[200px]">
                <h3 className="text-sm font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Settings className="w-4 h-4" />
                  SKUs Compostos ({compositeList.filter(c => c.components.length > 1).length})
                </h3>
                {compositeList.filter(c => c.components.length > 1).length === 0 ? (
                  <div className="text-gray-500 dark:text-gray-400 text-sm py-6 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 text-center">
                    Nenhum SKU composto cadastrado.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {compositeList.filter(c => c.components.length > 1).map((c) => (
                      <div key={c.main_sku_id} className="p-4 rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/80 dark:bg-purple-900/20 hover:shadow-md transition-shadow">
                        <div className="font-semibold text-purple-900 dark:text-purple-100 mb-2">
                          {c.main_sku} — {c.main_title}
                        </div>
                        <ul className="mb-3 space-y-1 text-sm text-gray-600 dark:text-gray-400">
                          {c.components.map((comp, i) => (
                            <li key={i} className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-purple-400" />
                              {comp.component_sku} × {comp.quantity}
                            </li>
                          ))}
                        </ul>
                        <div className="flex gap-2">
                          <button className="btn-secondary text-xs py-1.5" onClick={() => handleEditComposite(c)}><EditIcon className="w-3.5 h-3.5 inline mr-1" />Editar</button>
                          <button className="btn-danger text-xs py-1.5" onClick={async () => {
                            if (window.confirm('Excluir este SKU composto? Esta ação não pode ser desfeita.')) {
                              try {
                                await axios.delete(`/api/inventory/${c.main_sku_id}`);
                                fetchCompositeList();
                                fetchInventory();
                                toast.success('SKU composto excluído.');
                              } catch { toast.error('Erro ao excluir.'); }
                            }
                          }}><Trash2 className="w-3.5 h-3.5 inline mr-1" />Excluir</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Coluna Kits */}
              <section className="min-h-[200px]">
                <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Package className="w-4 h-4" />
                  Kits ({compositeList.filter(c => c.components.length === 1).length})
                </h3>
                {compositeList.filter(c => c.components.length === 1).length === 0 ? (
                  <div className="text-gray-500 dark:text-gray-400 text-sm py-6 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 text-center">
                    Nenhum kit cadastrado.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {compositeList.filter(c => c.components.length === 1).map((c) => (
                      <div key={c.main_sku_id} className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-900/20 hover:shadow-md transition-shadow">
                        <div className="font-semibold text-emerald-900 dark:text-emerald-100 mb-2">
                          {c.main_sku} — {c.main_title}
                        </div>
                        <div className="mb-3 text-sm text-gray-600 dark:text-gray-400">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block mr-2 align-middle" />
                          {c.components[0].component_sku} × {c.components[0].quantity}
                        </div>
                        <div className="flex gap-2">
                          <button className="btn-secondary text-xs py-1.5" onClick={() => handleEditKit(c)}><EditIcon className="w-3.5 h-3.5 inline mr-1" />Editar</button>
                          <button className="btn-danger text-xs py-1.5" onClick={async () => {
                            if (window.confirm('Excluir este kit? Esta ação não pode ser desfeita.')) {
                              try {
                                await axios.delete(`/api/inventory/${c.main_sku_id}`);
                                fetchCompositeList();
                                fetchInventory();
                                toast.success('Kit excluído.');
                              } catch { toast.error('Erro ao excluir.'); }
                            }
                          }}><Trash2 className="w-3.5 h-3.5 inline mr-1" />Excluir</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
          </div>
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
                user_id: user.id, // Adicionar ID do usuário logado
                accountId: activeAccountFilter !== 'all' ? activeAccountFilter : null
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
            {blingAccounts.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Conta</label>
                <select
                  className="input-field dark:bg-gray-700 dark:text-white dark:border-gray-600"
                  value={activeAccountFilter}
                  onChange={e => { setActiveAccountFilter(e.target.value); setMovementsPage(1); }}
                >
                  <option value="all">Todas as contas</option>
                  {blingAccounts.map(acc => (
                    <option key={acc.id} value={String(acc.id)}>{acc.name}</option>
                  ))}
                </select>
              </div>
            )}
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
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Conta</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Usuário</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {movementsLoading ? (
                  <tr>
                    <td className="px-4 py-2 dark:text-white text-center" colSpan={7}>Carregando...</td>
                  </tr>
                ) : movements.length === 0 ? (
                  <tr>
                    <td className="px-4 py-2 dark:text-white text-center" colSpan={7}>
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
                      <td className="px-4 py-2 dark:text-white">{m.account_name || getAccountLabel(m.account_id)}</td>
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
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Histórico de Aglutinados</h2>
          {loadingAglutinados ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">Carregando...</div>
          ) : aglutinados.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">Nenhum aglutinado salvo.</div>
          ) : (
            <>
              <div className="space-y-3">
                {aglutinados.slice((aglutinadosPage - 1) * aglutinadosPerPage, aglutinadosPage * aglutinadosPerPage).map(a => {
                  const dataExibir = a.data_criacao_br || (() => {
                    try {
                      let d = a.data_criacao;
                      if (typeof d === 'string' && !d.endsWith('Z') && !d.includes('+') && !d.includes('-', 10)) d = d.replace(' ', 'T') + 'Z';
                      return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    } catch { return a.data_criacao || '-'; }
                  })();
                  const mks = (a.marketplaces || '').split(',').map(s => s.trim()).filter(Boolean);
                  return (
                    <div key={a.id} className="flex items-center justify-between gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50/50 dark:bg-gray-700/30 hover:bg-gray-100/50 dark:hover:bg-gray-700/50">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap gap-2 mb-2">
                          {mks.map((mk, i) => (
                            <span key={i} className="px-3 py-1 rounded-lg text-sm font-semibold bg-blue-500 dark:bg-blue-600 text-white shadow-sm">{mk}</span>
                          ))}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">{dataExibir}</div>
                      </div>
                      <div className="relative flex-shrink-0">
                        <button onClick={() => setAglutinadoMenuOpen(aglutinadoMenuOpen === a.id ? null : a.id)} className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400">
                          <span className="sr-only">Ações</span>
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="6" r="1.5" /><circle cx="12" cy="18" r="1.5" /></svg>
                        </button>
                        {aglutinadoMenuOpen === a.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setAglutinadoMenuOpen(null)} />
                            <div className="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-20 py-1">
                              <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={() => { handleVisualizarAglutinado(a.id); setAglutinadoMenuOpen(null); }}>Visualizar</button>
                              <button className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-gray-700 dark:text-gray-200" onClick={async () => {
                                const res = await axios.get(`/api/aglutinados/${a.id}`);
                                handleImprimirAglutinado(res.data.conteudo_html);
                                setAglutinadoMenuOpen(null);
                              }}>Imprimir</button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Exibindo {(aglutinadosPage - 1) * aglutinadosPerPage + 1}–{Math.min(aglutinadosPage * aglutinadosPerPage, aglutinados.length)} de {aglutinados.length}
                </span>
                <div className="flex items-center gap-2">
                  <button className="px-3 py-1.5 rounded border text-sm disabled:opacity-50" disabled={aglutinadosPage === 1} onClick={() => setAglutinadosPage(p => Math.max(1, p - 1))}>Anterior</button>
                  <span className="text-sm text-gray-600 dark:text-gray-400">Página {aglutinadosPage} de {Math.max(1, Math.ceil(aglutinados.length / aglutinadosPerPage))}</span>
                  <button className="px-3 py-1.5 rounded border text-sm disabled:opacity-50" disabled={aglutinadosPage >= Math.ceil(aglutinados.length / aglutinadosPerPage)} onClick={() => setAglutinadosPage(p => Math.min(Math.ceil(aglutinados.length / aglutinadosPerPage), p + 1))}>Próxima</button>
                  <select value={aglutinadosPerPage} onChange={e => { setAglutinadosPerPage(Number(e.target.value)); setAglutinadosPage(1); }} className="ml-2 border rounded text-sm px-2 py-1.5 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    {[10, 15, 25, 50].map(n => <option key={n} value={n}>{n} por página</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {visualizarAglutinado && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => setVisualizarAglutinado(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-auto p-6 relative" onClick={e => e.stopPropagation()}>
            <button className="absolute top-4 right-4 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700" onClick={() => setVisualizarAglutinado(null)}>×</button>
            <div dangerouslySetInnerHTML={{ __html: visualizarAglutinado.conteudo_html }} />
          </div>
        </div>
      )}

      {showImportKitModal && <ImportKitModal />}
      {showImportCompostoModal && <ImportCompostoModal />}
    </div>
  );
}; 