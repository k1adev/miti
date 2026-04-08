import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search, Upload, RefreshCw, Link2, Unlink, Globe, ToggleLeft, ToggleRight,
  CheckCircle, AlertTriangle, Pause, Play, ExternalLink, Star, Award,
  Download, Send, X, ChevronDown, ChevronUp, ChevronRight, ChevronLeft, Edit3, Trash2, Copy, Package, Plus, MoreVertical, Image, Ruler
} from 'lucide-react';
import axios from 'axios';
import { useDebounce } from '../hooks/useDebounce';
import { useToast } from './Toast';
import { ModelVariationAccordionRow } from './ModelVariationAccordionRow';

const LISTING_TYPE_MAP = {
  gold_pro: { label: 'Premium', color: 'bg-orange-100 text-orange-700', icon: Star },
  gold_special: { label: 'Clássico', color: 'bg-blue-100 text-blue-700', icon: Award },
  free: { label: 'Grátis', color: 'bg-gray-100 text-gray-600', icon: null },
};

const TEMPLATE_STATUS = {
  draft: { label: 'Rascunho', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400' },
  published: { label: 'Publicado', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' },
  error: { label: 'Erro', cls: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' },
};

/** Atributos que o servidor não envia na publicação ML — não marcar como pendência */
const ML_ATTR_IDS_IGNORE_VALIDATE = ['ITEM_CONDITION'];

const DEFAULT_PACKAGE_FORM = () => ({
  has_factory_packaging: true,
  width_cm: '',
  height_cm: '',
  depth_cm: '',
  weight_kg: '',
  preset_id: null,
});

function parsePackageMeasuresFromModel(row) {
  try {
    const raw = row?.package_measures;
    if (raw == null || raw === '') return DEFAULT_PACKAGE_FORM();
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return DEFAULT_PACKAGE_FORM();
    return {
      ...DEFAULT_PACKAGE_FORM(),
      has_factory_packaging: o.has_factory_packaging !== false,
      width_cm: o.width_cm != null && o.width_cm !== '' ? String(o.width_cm) : '',
      height_cm: o.height_cm != null && o.height_cm !== '' ? String(o.height_cm) : '',
      depth_cm: o.depth_cm != null && o.depth_cm !== '' ? String(o.depth_cm) : '',
      weight_kg: o.weight_kg != null && o.weight_kg !== '' ? String(o.weight_kg) : '',
      preset_id: o.preset_id != null ? o.preset_id : null,
    };
  } catch {
    return DEFAULT_PACKAGE_FORM();
  }
}

function serializePackageMeasuresForApi(pkg) {
  if (!pkg) return null;
  if (pkg.has_factory_packaging === false) return { has_factory_packaging: false };
  const w = parseFloat(pkg.width_cm);
  const h = parseFloat(pkg.height_cm);
  const d = parseFloat(pkg.depth_cm);
  const kg = parseFloat(pkg.weight_kg);
  const o = { has_factory_packaging: true, preset_id: pkg.preset_id != null ? pkg.preset_id : null };
  if (Number.isFinite(w) && w > 0) o.width_cm = w;
  if (Number.isFinite(h) && h > 0) o.height_cm = h;
  if (Number.isFinite(d) && d > 0) o.depth_cm = d;
  if (Number.isFinite(kg) && kg > 0) o.weight_kg = kg;
  return o;
}

function mlAttrValueEmpty(attr) {
  const v = (attr.value_name ?? attr.value_id ?? '').toString().trim();
  return !v;
}

function mlAttrTags(def) {
  const t = def?.tags || {};
  return {
    required: t.required === true,
    catalogRequired: t.catalog_required === true,
    hidden: t.hidden === true,
  };
}

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Filtro da grelha de atributos: nome/ID + exemplo do ML + sinónimos (ex.: «frequência» → MAX_ROTATION_SPEED). */
function modelAttrSearchMatchesRow(r, qRaw) {
  const raw = String(qRaw || '').trim();
  if (!raw) return true;
  const q = stripAccents(raw.toLowerCase());
  const hay = stripAccents(
    [r.attr?.id, r.displayName, r.def?.name, r.def?.example].filter(Boolean).join(' ').toLowerCase()
  );
  if (hay.includes(q)) return true;
  const id = String(r.attr?.id || '').toUpperCase();
  /* No anúncio público o ML às vezes agrupa rotação (rpm) sob rótulos parecidos com «frequência». */
  if (/(frequ|rotac|rotar|rpm|rota(ç|c))/i.test(raw)) {
    if (/FREQUENCY|MAX_ROTATION|ROTATION_SPEED|POWER_MAX_ROTATION/i.test(id)) return true;
    if (/(rpm|hz|rota(ç|c)|velocidade)/i.test(hay)) return true;
  }
  return false;
}

/** Atributos de variação filtrados por “só cor” ou “só voltagem” (IDs/nomes comuns no ML Brasil). */
function filterVariationAttrsByKind(allAxisAttrs, kind) {
  if (!kind || kind === 'full' || kind === 'none') return allAxisAttrs;
  if (kind === 'color') {
    const hit = allAxisAttrs.filter((a) => /COLOR|COR|PAINT|FINISH/i.test(a.id) || /cor|acabamento/i.test(a.name || ''));
    return hit.length ? hit : allAxisAttrs;
  }
  if (kind === 'voltage') {
    const hit = allAxisAttrs.filter((a) => /VOLT|VOLTAG|TENS|ENERG|POWER|WATT/i.test(a.id) || /volt|voltag|tensão|watts/i.test(a.name || ''));
    return hit.length ? hit : allAxisAttrs;
  }
  return allAxisAttrs;
}

/** Ao reabrir um modelo: inferir se era só voltagem/cor para não resetar o filtro de eixos. */
function inferVariationAxisChoiceFromData(vars) {
  const combos = vars.flatMap((v) => v.attribute_combinations || []);
  const ids = new Set(combos.map((c) => c.id).filter(Boolean));
  if (ids.size === 0) return 'full';
  if (ids.size === 1) {
    const id = [...ids][0];
    if (/VOLT|VOLTAG|TENS/i.test(id)) return 'voltage';
    if (/COLOR|COR|PAINT|FINISH/i.test(id)) return 'color';
  }
  return 'full';
}

/** Cor (ou primeiro eixo) como grupo; voltagem (e demais) como filhos — espelha o fluxo do site ML. */
function primarySecondaryVariationAttrs(axes) {
  if (!axes || axes.length === 0) return { primary: [], secondary: [] };
  if (axes.length === 1) return { primary: axes, secondary: [] };
  const color = axes.find((a) => /COLOR|COR|PAINT|FINISH/i.test(a.id || '') || /cor|estrutura|acabamento|cúpula/i.test(a.name || ''));
  const volt = axes.find((a) => /VOLT|VOLTAG|TENS/i.test(a.id || '') || /volt|voltag|tensão/i.test(a.name || ''));
  if (color && volt) {
    const rest = axes.filter((a) => a.id !== color.id && a.id !== volt.id);
    return { primary: [color], secondary: [volt, ...rest] };
  }
  return { primary: [axes[0]], secondary: axes.slice(1) };
}

function buildCombosFromSplit(split, sample, mode) {
  const order = [...split.primary, ...split.secondary];
  if (order.length === 0) return [];
  return order.map((a) => {
    const isSec = split.secondary.some((s) => s.id === a.id);
    if (mode === 'allEmpty') return { id: a.id, name: a.name, value_id: null, value_name: '' };
    if (mode === 'cloneSecondary' && isSec) return { id: a.id, name: a.name, value_id: null, value_name: '' };
    const c = (sample.attribute_combinations || []).find((x) => x.id === a.id);
    return { id: a.id, name: a.name, value_id: c?.value_id ?? null, value_name: c?.value_name ?? '' };
  });
}

function buildVariationGroupMeta(variations, primaryAttrs) {
  if (!primaryAttrs.length) {
    return [{ pk: '_all', label: 'Todas', indices: variations.map((_, vi) => vi) }];
  }
  const map = new Map();
  variations.forEach((v, vi) => {
    const combos = v.attribute_combinations || [];
    const pk = primaryAttrs.map((a) => {
      const c = combos.find((x) => x.id === a.id);
      return `${a.id}:${c?.value_id ?? ''}:${String(c?.value_name ?? '').trim()}`;
    }).join('||');
    const label = primaryAttrs.map((a) => {
      const c = combos.find((x) => x.id === a.id);
      return String(c?.value_name || c?.value_id || '—').trim();
    }).join(' / ');
    if (!map.has(pk)) map.set(pk, { pk, label, indices: [] });
    map.get(pk).indices.push(vi);
  });
  return [...map.values()];
}

/** Valida modelo antes de salvar (variações e termos de venda). */
function validateModelEditModal(m) {
  const errs = [];
  const vars = m._variations || [];
  const terms = (m._sale_terms || []).filter((t) => t && String(t.id || '').trim());

  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    const hasVal = String(t.value_name || '').trim() || String(t.value_id || '').trim();
    if (!hasVal) errs.push(`Termo "${t.id}": preencha valor ou value_id`);
  }

  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    const combos = v.attribute_combinations || [];
    if (combos.length === 0) {
      errs.push(`Variação ${i + 1}: sem combinação de atributos`);
      continue;
    }
    const bad = combos.some((ac) => !String(ac.value_name || '').trim() && !String(ac.value_id || '').trim());
    if (bad) errs.push(`Variação ${i + 1}: preencha valor em cada atributo da combinação`);
  }

  return errs;
}

export const Anuncios = ({ user }) => {
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'ativos';
  const [items, setItems] = useState([]);
  const [mlAccounts, setMlAccounts] = useState([]);
  const [shopeeAccounts, setShopeeAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [linkModal, setLinkModal] = useState(null);
  const [linkSearch, setLinkSearch] = useState('');
  const [pushing, setPushing] = useState({});
  const [expandedItems, setExpandedItems] = useState(new Set());
  const [varLinkModal, setVarLinkModal] = useState(null);
  const [pushingVar, setPushingVar] = useState({});
  const [manualStockModal, setManualStockModal] = useState(null);
  const [manualStockQty, setManualStockQty] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [pushingAll, setPushingAll] = useState(false);
  const [inventory, setInventory] = useState([]);
  const [filterMarketplace, setFilterMarketplace] = useState('all');
  const [filterAccount, setFilterAccount] = useState('all');
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  const debouncedSearch = useDebounce(search, 400);

  const [selectedItems, setSelectedItems] = useState(new Set());
  const [importing, setImporting] = useState(false);

  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const debouncedTemplateSearch = useDebounce(templateSearch, 400);
  const [selectedTemplates, setSelectedTemplates] = useState(new Set());
  const [editModal, setEditModal] = useState(null);
  const [publishModal, setPublishModal] = useState(null);
  const [publishing, setPublishing] = useState(false);

  const [adModels, setAdModels] = useState([]);
  const [adModelsLoading, setAdModelsLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const debouncedModelSearch = useDebounce(modelSearch, 400);
  const [selectedModels, setSelectedModels] = useState(new Set());
  const [modelEditModal, setModelEditModal] = useState(null);
  const [packagePresets, setPackagePresets] = useState([]);
  const [packagePresetsModalOpen, setPackagePresetsModalOpen] = useState(false);
  const [presetNewDraft, setPresetNewDraft] = useState({ name: '', width_cm: '', height_cm: '', depth_cm: '', weight_kg: '' });
  const [presetEditDraft, setPresetEditDraft] = useState(null);
  const [presetSaving, setPresetSaving] = useState(false);
  const [modelPublishModal, setModelPublishModal] = useState(null);
  const [modelPublishing, setModelPublishing] = useState(false);
  const [bulkPublishModal, setBulkPublishModal] = useState(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [modelImportModal, setModelImportModal] = useState(null);
  const [openActionMenu, setOpenActionMenu] = useState(null);
  const [expandedModels, setExpandedModels] = useState(new Set());
  const [pushingModel, setPushingModel] = useState({});
  const [togglingListing, setTogglingListing] = useState({});
  const [modelCategorySchema, setModelCategorySchema] = useState(null);
  const [modelCategorySchemaLoading, setModelCategorySchemaLoading] = useState(false);
  const [modelAttrFilter, setModelAttrFilter] = useState('all');
  const [modelAttrSearch, setModelAttrSearch] = useState('');
  const [modelPicUrlDraft, setModelPicUrlDraft] = useState('');
  const [modelPicUploading, setModelPicUploading] = useState(false);
  const [modelShowPicUrlInput, setModelShowPicUrlInput] = useState(false);
  const [modelPicEditIndex, setModelPicEditIndex] = useState(null);
  const [modelVariationAxisChoice, setModelVariationAxisChoice] = useState(null);
  /** Índices de variação expandidos no modal (acordeão). */
  const [modelVariationExpanded, setModelVariationExpanded] = useState(() => new Set([0]));
  const modelPictureFileInputRef = useRef(null);

  const loadPackagePresets = useCallback(async () => {
    try {
      const r = await axios.get('/api/package-presets');
      setPackagePresets(r.data.presets || []);
    } catch {
      setPackagePresets([]);
    }
  }, []);

  useEffect(() => {
    (async () => { try { const r = await axios.get('/api/ml/accounts'); setMlAccounts(r.data?.accounts || []); } catch { setMlAccounts([]); } })();
    (async () => { try { const r = await axios.get('/api/shopee/accounts'); setShopeeAccounts(r.data?.accounts || []); } catch { setShopeeAccounts([]); } })();
    (async () => { try { const r = await axios.get('/api/inventory', { params: { limit: 99999, offset: 0 } }); setInventory(r.data.items || []); } catch { setInventory([]); } })();
  }, []);

  useEffect(() => {
    if (!openActionMenu) return;
    const close = () => setOpenActionMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openActionMenu]);

  useEffect(() => {
    if (!modelEditModal?.category_id) {
      setModelCategorySchema(null);
      setModelCategorySchemaLoading(false);
      return;
    }
    let cancelled = false;
    setModelCategorySchemaLoading(true);
    setModelCategorySchema(null);
    (async () => {
      try {
        const r = await axios.get(`/api/ml/categories/${encodeURIComponent(modelEditModal.category_id)}/attributes`);
        if (!cancelled) setModelCategorySchema(r.data);
      } catch {
        if (!cancelled) setModelCategorySchema(null);
      } finally {
        if (!cancelled) setModelCategorySchemaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [modelEditModal?.category_id]);

  /** Insere na ficha técnica os atributos obrigatórios da categoria ML que ainda não existem (ex.: MATERIALS, INCLUDES_BULBS). */
  useEffect(() => {
    if (!modelEditModal?.category_id) return;
    if (!Array.isArray(modelCategorySchema) || modelCategorySchema.length === 0) return;
    const required = modelCategorySchema.filter(
      (a) => a && a.id && a.tags && (a.tags.required === true || a.tags.catalog_required === true)
    );
    if (required.length === 0) return;
    setModelEditModal((prev) => {
      if (!prev) return prev;
      const attrs = [...(prev._attributes || [])];
      const ids = new Set(attrs.map((x) => x.id));
      let changed = false;
      for (const def of required) {
        if (!def.id || ids.has(def.id)) continue;
        attrs.push({ id: def.id, name: def.name, value_name: '', value_id: null });
        ids.add(def.id);
        changed = true;
      }
      return changed ? { ...prev, _attributes: attrs } : prev;
    });
  }, [modelCategorySchema, modelEditModal?.category_id]);

  useEffect(() => {
    if (!modelEditModal) return;
    setModelAttrFilter('all');
    setModelAttrSearch('');
    loadPackagePresets();
  }, [modelEditModal?.id, modelEditModal?.category_id, loadPackagePresets]);

  useEffect(() => {
    if (!packagePresetsModalOpen) return;
    loadPackagePresets();
    setPresetNewDraft({ name: '', width_cm: '', height_cm: '', depth_cm: '', weight_kg: '' });
    setPresetEditDraft(null);
  }, [packagePresetsModalOpen, loadPackagePresets]);

  useEffect(() => {
    if (!modelEditModal) {
      setModelPicUrlDraft('');
      setModelShowPicUrlInput(false);
      setModelPicEditIndex(null);
      setModelVariationAxisChoice(null);
      setModelVariationExpanded(new Set([0]));
      return;
    }
    const vars = modelEditModal._variations || [];
    if (vars.length > 0) setModelVariationAxisChoice(inferVariationAxisChoiceFromData(vars));
    else setModelVariationAxisChoice(null);
  }, [modelEditModal?.id]);

  useEffect(() => {
    if (!modelEditModal) return;
    const n = (modelEditModal._variations || []).length;
    if (n === 0) return;
    setModelVariationExpanded((prev) => {
      const valid = [...prev].filter((i) => i < n && i >= 0);
      if (valid.length === 0) return new Set([0]);
      return new Set(valid);
    });
  }, [modelEditModal?.id, modelEditModal?._variations?.length]);

  const modelVariationAxisAttrs = useMemo(() => {
    const arr = Array.isArray(modelCategorySchema) ? modelCategorySchema : [];
    return arr.filter((a) => a.tags?.allow_variations);
  }, [modelCategorySchema]);

  const modelVariationAxisAttrsFiltered = useMemo(() => {
    return filterVariationAttrsByKind(modelVariationAxisAttrs, modelVariationAxisChoice);
  }, [modelVariationAxisAttrs, modelVariationAxisChoice]);

  const modelShowVariationAxisPicker = useMemo(() => {
    if (!modelEditModal) return false;
    return modelVariationAxisAttrs.length > 0 && (modelEditModal._variations || []).length === 0 && modelVariationAxisChoice === null;
  }, [modelEditModal?.id, modelEditModal?._variations?.length, modelVariationAxisAttrs.length, modelVariationAxisChoice]);

  const modelShowVariationEditor = useMemo(() => {
    if (!modelEditModal) return false;
    if (modelShowVariationAxisPicker) return false;
    if (modelVariationAxisChoice === 'none') return false;
    const vs = modelEditModal._variations || [];
    if (vs.length > 0) return true;
    if (['color', 'voltage', 'full'].includes(modelVariationAxisChoice)) return true;
    if (modelVariationAxisChoice === null && modelVariationAxisAttrs.length === 0) return true;
    return false;
  }, [modelEditModal?.id, modelEditModal?._variations?.length, modelShowVariationAxisPicker, modelVariationAxisChoice, modelVariationAxisAttrs.length]);

  const variationAxesUi = useMemo(() => {
    const axesRaw = modelVariationAxisAttrsFiltered.length > 0 ? modelVariationAxisAttrsFiltered : modelVariationAxisAttrs;
    return axesRaw;
  }, [modelVariationAxisAttrsFiltered, modelVariationAxisAttrs]);

  const variationNestedSplit = useMemo(() => primarySecondaryVariationAttrs(variationAxesUi), [variationAxesUi]);

  const useNestedVariationUi = variationNestedSplit.secondary.length > 0;

  const variationGroups = useMemo(() => {
    if (!modelEditModal) return [];
    const vars = modelEditModal._variations || [];
    if (!variationNestedSplit.secondary.length) return [];
    return buildVariationGroupMeta(vars, variationNestedSplit.primary);
  }, [modelEditModal?._variations, variationNestedSplit, modelEditModal]);

  const modelAttrAnalysis = useMemo(() => {
    if (!modelEditModal) {
      return { rows: [], missingCount: 0 };
    }
    const attrs = modelEditModal._attributes || [];
    const schemaArr = Array.isArray(modelCategorySchema) ? modelCategorySchema : [];
    const schemaById = {};
    for (const d of schemaArr) {
      if (d.id) schemaById[d.id] = d;
    }
    let missingCount = 0;
    const rows = attrs.map((attr, index) => {
      const def = schemaById[attr.id];
      const { required, catalogRequired, hidden } = mlAttrTags(def);
      const ignored = ML_ATTR_IDS_IGNORE_VALIDATE.includes(attr.id);
      const mlMandatory = !ignored && !hidden && (required || catalogRequired);
      const empty = mlAttrValueEmpty(attr);
      const issue = mlMandatory && empty;
      if (issue) missingCount++;
      const priority = issue ? 0 : mlMandatory ? 1 : 2;
      const displayName = attr.name || def?.name || attr.id;
      return {
        attr,
        index,
        def,
        required,
        catalogRequired,
        ignored,
        mlMandatory,
        empty,
        issue,
        priority,
        displayName,
      };
    });
    rows.sort((a, b) => a.priority - b.priority || a.displayName.localeCompare(b.displayName, 'pt-BR'));
    return { rows, missingCount };
  }, [modelEditModal, modelCategorySchema]);

  const modelAttrFilteredRows = useMemo(() => {
    return modelAttrAnalysis.rows.filter((r) => {
      if (modelAttrFilter === 'issues' && !r.issue) return false;
      return modelAttrSearchMatchesRow(r, modelAttrSearch);
    });
  }, [modelAttrAnalysis.rows, modelAttrFilter, modelAttrSearch]);

  /** Eixos ML (allow_variations) que batem com a busca — não entram na grelha do item. */
  const modelVariationAxesMatchingSearch = useMemo(() => {
    const raw = modelAttrSearch.trim();
    if (!raw) return [];
    const axes = modelVariationAxisAttrs || [];
    return axes.filter((a) => modelAttrSearchMatchesRow(
      { attr: { id: a.id }, displayName: a.name || a.id, def: a },
      raw
    ));
  }, [modelVariationAxisAttrs, modelAttrSearch]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const [mlRes, shopeeRes] = await Promise.all([
        axios.get('/api/ml/items', { params: { search } }).catch(() => ({ data: [] })),
        axios.get('/api/shopee/items', { params: { search } }).catch(() => ({ data: [] }))
      ]);
      const mlItems = (mlRes.data || []).map(i => ({ ...i, source: 'ml', item_id_display: i.ml_item_id, stock_qty: i.ml_available_quantity, uid: `ml-${i.id}` }));
      const shopeeItems = (shopeeRes.data || []).map(i => ({ ...i, source: 'shopee', item_id_display: i.shopee_item_id, stock_qty: i.shopee_stock, uid: `shopee-${i.id}` }));
      setItems([...mlItems, ...shopeeItems]);
    } catch { setItems([]); }
    setLoading(false);
  }, [search]);

  useEffect(() => { fetchItems(); }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      const r = await axios.get('/api/ml/templates', { params: { search: templateSearch, status: templateFilter || undefined } });
      setTemplates(r.data?.templates || []);
    } catch { setTemplates([]); }
    setTemplatesLoading(false);
  }, [templateSearch, templateFilter]);

  useEffect(() => { if (activeTab === 'modelos') fetchTemplates(); }, [activeTab, debouncedTemplateSearch, templateFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAdModels = useCallback(async () => {
    setAdModelsLoading(true);
    try {
      const r = await axios.get('/api/ad-models/enriched', { params: { search: modelSearch || undefined } });
      setAdModels(r.data?.models || []);
    } catch { setAdModels([]); }
    setAdModelsLoading(false);
  }, [modelSearch]);

  useEffect(() => { if (activeTab === 'modelos') fetchAdModels(); }, [activeTab, debouncedModelSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      let totalSynced = 0, totalItems = 0;
      for (const acc of mlAccounts) { const r = await axios.post('/api/ml/items/sync', { accountId: acc.id }); totalSynced += r.data.synced || 0; totalItems += r.data.total || 0; }
      for (const acc of shopeeAccounts) { try { const r = await axios.post('/api/shopee/items/sync', { accountId: acc.id }); totalSynced += r.data.synced || 0; totalItems += r.data.total || 0; } catch { /* skip */ } }
      toast.success(`Sincronizados ${totalSynced} de ${totalItems} anúncios`);
      fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao sincronizar'); }
    setSyncing(false);
  };

  const handleLink = async (item, inventoryId) => {
    try {
      if (item.source === 'ml') await axios.post('/api/ml/stock-config/link', { inventory_id: inventoryId, ml_account_id: item.ml_account_id, ml_item_id: item.ml_item_id });
      else await axios.post('/api/shopee/stock/link', { inventoryId, shopeeItemId: item.shopee_item_id, shopeeAccountId: item.shopee_account_id });
      toast.success('Vinculado!'); setLinkModal(null); setLinkSearch(''); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao vincular'); }
  };

  const handleUnlink = async (item) => {
    try {
      if (item.source === 'ml') await axios.delete(`/api/ml/stock-config/${item.config_id}`);
      else await axios.delete(`/api/shopee/stock/${item.config_id}`);
      toast.success('Desvinculado'); fetchItems();
    } catch { toast.error('Erro ao desvincular'); }
  };

  const handleToggleRealStock = async (item) => {
    const endpoint = item.source === 'ml' ? `/api/ml/stock-config/${item.config_id}` : `/api/shopee/stock/${item.config_id}`;
    try { await axios.put(endpoint, { use_real_stock: item.use_real_stock ? 0 : 1, fictitious_min: item.fictitious_min, fictitious_max: item.fictitious_max, enabled: item.enabled }); fetchItems(); }
    catch { toast.error('Erro ao atualizar'); }
  };

  const handleToggleEnabled = async (item) => {
    const endpoint = item.source === 'ml' ? `/api/ml/stock-config/${item.config_id}` : `/api/shopee/stock/${item.config_id}`;
    try { await axios.put(endpoint, { use_real_stock: item.use_real_stock, fictitious_min: item.fictitious_min, fictitious_max: item.fictitious_max, enabled: item.enabled ? 0 : 1 }); fetchItems(); }
    catch { toast.error('Erro ao atualizar'); }
  };

  const handleVarLink = async (variation, inventoryId) => {
    try {
      await axios.post('/api/ml/variation-stock/link', {
        inventory_id: inventoryId, ml_account_id: variation.ml_account_id,
        ml_item_id: variation.ml_item_id, variation_id: variation.variation_id
      });
      toast.success('Variação vinculada!'); setVarLinkModal(null); setLinkSearch(''); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao vincular variação'); }
  };

  const handleVarUnlink = async (variation) => {
    try {
      await axios.delete(`/api/ml/variation-stock/${variation.var_config_id}`);
      toast.success('Desvinculado'); fetchItems();
    } catch { toast.error('Erro ao desvincular variação'); }
  };

  const handleVarToggleRealStock = async (v) => {
    try {
      await axios.put(`/api/ml/variation-stock/${v.var_config_id}`, {
        use_real_stock: v.var_use_real_stock ? 0 : 1,
        fictitious_min: v.var_fict_min, fictitious_max: v.var_fict_max, enabled: v.var_enabled
      });
      fetchItems();
    } catch { toast.error('Erro ao atualizar'); }
  };

  const handleVarToggleEnabled = async (v) => {
    try {
      await axios.put(`/api/ml/variation-stock/${v.var_config_id}`, {
        use_real_stock: v.var_use_real_stock,
        fictitious_min: v.var_fict_min, fictitious_max: v.var_fict_max, enabled: v.var_enabled ? 0 : 1
      });
      fetchItems();
    } catch { toast.error('Erro ao atualizar'); }
  };

  const handleManualStock = async () => {
    if (!manualStockModal) return;
    const qty = parseInt(manualStockQty, 10);
    if (isNaN(qty) || qty < 0) return toast.error('Quantidade inválida');
    try {
      await axios.put(`/api/ml/items/${manualStockModal.ml_item_id}/variations/${manualStockModal.variation_id}/stock`, {
        accountId: manualStockModal.ml_account_id, available_quantity: qty
      });
      toast.success(`Estoque da variação atualizado para ${qty}`);
      setManualStockModal(null); setManualStockQty(''); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao atualizar estoque'); }
  };

  const handleVarPush = async (variation) => {
    const key = `var-${variation.var_config_id}`;
    setPushingVar(p => ({ ...p, [key]: true }));
    try {
      const res = await axios.post('/api/ml/variation-stock/push', { configId: variation.var_config_id });
      toast.success(`Estoque variação enviado: ${res.data.pushed_quantity} un.`); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao enviar estoque variação'); }
    setPushingVar(p => ({ ...p, [key]: false }));
  };

  const handlePush = async (item) => {
    const key = `${item.source}-${item.config_id}`;
    setPushing(p => ({ ...p, [key]: true }));
    try {
      const endpoint = item.source === 'ml' ? '/api/ml/stock/push' : '/api/shopee/stock/push';
      const res = await axios.post(endpoint, { configId: item.config_id });
      toast.success(`Estoque enviado: ${res.data.pushed_quantity} un.`); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao enviar'); }
    setPushing(p => ({ ...p, [key]: false }));
  };

  const handlePushAll = async () => {
    setPushingAll(true);
    try {
      let totalPushed = 0, totalErrors = 0;
      for (const acc of mlAccounts) { const r = await axios.post('/api/ml/stock/push-all', { accountId: acc.id }); totalPushed += r.data.pushed || 0; totalErrors += r.data.errors || 0; }
      for (const acc of shopeeAccounts) { try { const r = await axios.post('/api/shopee/stock/push-all', { accountId: acc.id }); totalPushed += r.data.pushed || 0; totalErrors += r.data.errors || 0; } catch { /* skip */ } }
      toast.success(`Enviados: ${totalPushed} | Erros: ${totalErrors}`); fetchItems();
    } catch { toast.error('Erro ao enviar em lote'); }
    setPushingAll(false);
  };

  const handleChangeStatus = async (item, newStatus) => {
    try {
      if (item.source === 'ml') { await axios.put(`/api/ml/items/${item.ml_item_id}/status`, { status: newStatus, accountId: item.ml_account_id }); toast.success(`Anúncio ${newStatus === 'paused' ? 'pausado' : newStatus === 'active' ? 'ativado' : 'encerrado'}`); }
      else { const action = newStatus === 'paused' || newStatus === 'UNLIST' ? 'unlist' : 'relist'; await axios.post(`/api/shopee/items/${item.shopee_item_id}/status`, { action, accountId: item.shopee_account_id }); toast.success(`Anúncio ${action === 'unlist' ? 'pausado' : 'ativado'}`); }
      fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao alterar status'); }
  };

  const toggleSelectItem = (item) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      const key = `${item.source}:${item.item_id_display}:${item.source === 'ml' ? item.ml_account_id : item.shopee_account_id}`;
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const mlItems = items.filter(i => i.source === 'ml');
    if (selectedItems.size === mlItems.length) { setSelectedItems(new Set()); }
    else { setSelectedItems(new Set(mlItems.map(i => `ml:${i.ml_item_id}:${i.ml_account_id}`))); }
  };

  const handleImportSelected = async () => {
    if (selectedItems.size === 0) return;
    setImporting(true);
    const grouped = {};
    for (const key of selectedItems) {
      const [source, itemId, accountId] = key.split(':');
      if (source !== 'ml') continue;
      if (!grouped[accountId]) grouped[accountId] = [];
      grouped[accountId].push(itemId);
    }
    let totalImported = 0, totalErrors = 0;
    for (const [accountId, mlItemIds] of Object.entries(grouped)) {
      try {
        const r = await axios.post('/api/ml/templates/import-bulk', { mlItemIds, accountId: parseInt(accountId, 10) });
        totalImported += r.imported || 0;
        totalErrors += (r.errors || []).length;
      } catch { totalErrors++; }
    }
    toast.success(`Importados: ${totalImported} | Erros: ${totalErrors}`);
    setSelectedItems(new Set());
    setImporting(false);
    if (totalImported > 0) { fetchTemplates(); }
  };

  const handleImportSingle = async (item) => {
    if (item.source !== 'ml') return toast.error('Importação disponível apenas para Mercado Livre');
    try {
      const r = await axios.post('/api/ml/templates/import', { mlItemId: item.ml_item_id, accountId: item.ml_account_id });
      toast.success(`"${r.data.title}" importado como template!`);
      fetchTemplates();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao importar'); }
  };

  const handleDeleteTemplate = async (id) => {
    if (!window.confirm('Excluir este template?')) return;
    try { await axios.delete(`/api/ml/templates/${id}`); toast.success('Template excluído'); fetchTemplates(); }
    catch { toast.error('Erro ao excluir'); }
  };

  const handleDeleteSelectedTemplates = async () => {
    if (selectedTemplates.size === 0) return;
    if (!window.confirm(`Excluir ${selectedTemplates.size} template(s)?`)) return;
    try { await axios.delete('/api/ml/templates', { data: { ids: [...selectedTemplates] } }); toast.success('Templates excluídos'); setSelectedTemplates(new Set()); fetchTemplates(); }
    catch { toast.error('Erro ao excluir'); }
  };

  const handleSaveEdit = async () => {
    if (!editModal) return;
    try {
      const payload = {
        title: editModal.title,
        price: parseFloat(editModal.price) || 0,
        available_quantity: parseInt(editModal.available_quantity, 10) || 1,
        listing_type_id: editModal.listing_type_id,
        description: editModal.description,
        condition: editModal.condition,
        buying_mode: editModal.buying_mode,
        currency_id: editModal.currency_id,
        category_id: editModal.category_id,
        video_id: editModal.video_id || null,
      };
      if (editModal._attributes) payload.attributes = editModal._attributes;
      if (editModal._variations) payload.variations = editModal._variations;
      if (editModal._shipping) payload.shipping = editModal._shipping;
      if (editModal._sale_terms) payload.sale_terms = editModal._sale_terms;
      await axios.put(`/api/ml/templates/${editModal.id}`, payload);
      toast.success('Template atualizado!');
      setEditModal(null);
      fetchTemplates();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao salvar'); }
  };

  const handlePublish = async () => {
    if (!publishModal) return;
    setPublishing(true);
    try {
      if (publishModal.templateIds) {
        const r = await axios.post('/api/ml/templates/publish-bulk', { templateIds: publishModal.templateIds, targetAccountId: publishModal.targetAccountId });
        toast.success(`Publicados: ${r.data.published} | Erros: ${r.data.errors?.length || 0}`);
        if (r.data.errors?.length) console.warn('Publish errors:', r.data.errors);
      } else {
        const r = await axios.post(`/api/ml/templates/${publishModal.templateId}/publish`, { targetAccountId: publishModal.targetAccountId });
        toast.success(`Publicado! Novo ID: ${r.data.newItemId}`);
      }
      setPublishModal(null);
      setSelectedTemplates(new Set());
      fetchTemplates();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao publicar'); }
    setPublishing(false);
  };

  const openPublishModal = (templateId) => setPublishModal({ templateId, targetAccountId: '' });
  const openBulkPublishModal = () => setPublishModal({ templateIds: [...selectedTemplates], targetAccountId: '' });

  const handleModelImportFromItem = async (item, forceOverwrite = false) => {
    if (item.source !== 'ml') return toast.error('Importação disponível apenas para Mercado Livre');
    try {
      const r = await axios.post('/api/ad-models/import', { mlItemId: item.ml_item_id, accountId: item.ml_account_id, forceOverwrite });
      toast.success(`Modelo "${r.data.title}" ${forceOverwrite ? 'atualizado' : 'criado'}!`);
      fetchAdModels();
    } catch (e) {
      if (e.response?.status === 409) {
        const sku = e.response.data.existingSku || 'desconhecido';
        if (window.confirm(`Já existe um modelo com o SKU "${sku}". Deseja sobrescrever com os novos dados?`)) {
          await handleModelImportFromItem(item, true);
        }
      } else {
        toast.error(e.response?.data?.error || 'Erro ao importar');
      }
    }
  };

  const handleModelPictureFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setModelPicUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await axios.post('/api/ad-models/upload-picture', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const raw = r.data?.url || r.data?.path;
      if (!raw) {
        toast.error('Resposta inválida do servidor');
        return;
      }
      const abs = raw.startsWith('http') ? raw : `${window.location.origin}${raw.startsWith('/') ? '' : '/'}${raw}`;
      setModelEditModal((p) => ({ ...p, _pictures: [...(p._pictures || []), { id: `pic-${Date.now()}`, source: abs }] }));
      toast.success('Imagem enviada');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Falha no upload da imagem');
    } finally {
      setModelPicUploading(false);
      e.target.value = '';
    }
  };

  const handlePresetModalAdd = async () => {
    const d = presetNewDraft;
    const n = (d.name || '').trim();
    const w = parseFloat(d.width_cm);
    const h = parseFloat(d.height_cm);
    const dep = parseFloat(d.depth_cm);
    const kg = parseFloat(d.weight_kg);
    if (!n) {
      toast.error('Informe o nome da caixa.');
      return;
    }
    if (![w, h, dep, kg].every((x) => Number.isFinite(x) && x > 0)) {
      toast.error('Preencha largura, altura, profundidade (cm) e peso (kg) com valores válidos.');
      return;
    }
    setPresetSaving(true);
    try {
      await axios.post('/api/package-presets', { name: n, width_cm: w, height_cm: h, depth_cm: dep, weight_kg: kg });
      toast.success('Caixa adicionada.');
      setPresetNewDraft({ name: '', width_cm: '', height_cm: '', depth_cm: '', weight_kg: '' });
      await loadPackagePresets();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao adicionar');
    } finally {
      setPresetSaving(false);
    }
  };

  const handlePresetModalSaveEdit = async () => {
    if (!presetEditDraft?.id) return;
    const n = (presetEditDraft.name || '').trim();
    const w = parseFloat(presetEditDraft.width_cm);
    const h = parseFloat(presetEditDraft.height_cm);
    const dep = parseFloat(presetEditDraft.depth_cm);
    const kg = parseFloat(presetEditDraft.weight_kg);
    if (!n) {
      toast.error('Informe o nome.');
      return;
    }
    if (![w, h, dep, kg].every((x) => Number.isFinite(x) && x > 0)) {
      toast.error('Medidas inválidas.');
      return;
    }
    setPresetSaving(true);
    try {
      await axios.put(`/api/package-presets/${presetEditDraft.id}`, { name: n, width_cm: w, height_cm: h, depth_cm: dep, weight_kg: kg });
      toast.success('Caixa atualizada.');
      setPresetEditDraft(null);
      await loadPackagePresets();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao atualizar');
    } finally {
      setPresetSaving(false);
    }
  };

  const handlePresetModalDelete = async (id) => {
    if (!window.confirm('Excluir esta caixa salva? Modelos que a referenciarem deixarão de encontrar o preset no seletor.')) return;
    setPresetSaving(true);
    try {
      await axios.delete(`/api/package-presets/${id}`);
      toast.success('Caixa removida.');
      if (presetEditDraft?.id === id) setPresetEditDraft(null);
      await loadPackagePresets();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao excluir');
    } finally {
      setPresetSaving(false);
    }
  };

  const handleModelSave = async () => {
    if (!modelEditModal) return;
    const validationErrors = validateModelEditModal(modelEditModal);
    if (validationErrors.length) {
      const msg = validationErrors.slice(0, 4).join(' • ');
      toast.error(msg + (validationErrors.length > 4 ? ` (+${validationErrors.length - 4})` : ''));
      return;
    }
    const pics = modelEditModal._pictures || [];
    if (pics.length === 0) {
      if (!window.confirm('Nenhuma imagem neste modelo. O Mercado Livre exige pelo menos uma foto para publicar. Deseja salvar mesmo assim?')) return;
    }
    try {
      const payload = {
        sku: modelEditModal.sku, ean: modelEditModal.ean, title: modelEditModal.title,
        price: parseFloat(modelEditModal.price) || 0,
        available_quantity: parseInt(modelEditModal.available_quantity, 10) || 1,
        listing_type_id: modelEditModal.listing_type_id,
        description: modelEditModal.description,
        condition: modelEditModal.condition, buying_mode: modelEditModal.buying_mode,
        currency_id: modelEditModal.currency_id, category_id: modelEditModal.category_id, category_name: modelEditModal.category_name,
        video_id: modelEditModal.video_id || null, inventory_id: modelEditModal.inventory_id || null,
      };
      if (modelEditModal._attributes) payload.attributes = modelEditModal._attributes;
      if (modelEditModal._pictures) payload.pictures = modelEditModal._pictures;
      if (modelEditModal._variations) payload.variations = modelEditModal._variations;
      if (modelEditModal._shipping) payload.shipping = modelEditModal._shipping;
      if (modelEditModal._sale_terms) payload.sale_terms = modelEditModal._sale_terms;
      payload.package_measures = serializePackageMeasuresForApi(modelEditModal._package);

      if (modelEditModal.id) {
        await axios.put(`/api/ad-models/${modelEditModal.id}`, payload);
        toast.success('Modelo atualizado!');
      } else {
        await axios.post('/api/ad-models', payload);
        toast.success('Modelo criado!');
      }
      setModelEditModal(null);
      fetchAdModels();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao salvar'); }
  };

  const handleModelPushStock = async (modelId) => {
    setPushingModel(p => ({ ...p, [modelId]: true }));
    try {
      await axios.post(`/api/ad-models/${modelId}/push-stock`);
      toast.success('Estoque enviado para todos os marketplaces!');
      fetchAdModels();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao enviar estoque'); }
    setPushingModel(p => ({ ...p, [modelId]: false }));
  };

  const handleToggleListingStatus = async (modelId, mlItemId, mlAccountId, currentStatus) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    const key = `${mlItemId}_${mlAccountId}`;
    setTogglingListing(p => ({ ...p, [key]: true }));
    try {
      await axios.post(`/api/ad-models/${modelId}/toggle-listing-status`, {
        mlItemId, mlAccountId, status: newStatus
      });
      toast.success(`Anúncio ${newStatus === 'active' ? 'ativado' : 'pausado'}!`);
      fetchAdModels();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao alterar status'); }
    setTogglingListing(p => ({ ...p, [key]: false }));
  };

  const toggleModelExpand = (id) => {
    setExpandedModels(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleModelDelete = async (id) => {
    if (!window.confirm('Excluir este modelo?')) return;
    try { await axios.delete(`/api/ad-models/${id}`); toast.success('Modelo excluído'); fetchAdModels(); }
    catch { toast.error('Erro ao excluir'); }
  };

  const handleModelDeleteBulk = async () => {
    if (selectedModels.size === 0) return;
    if (!window.confirm(`Excluir ${selectedModels.size} modelo(s)?`)) return;
    try { await axios.delete('/api/ad-models', { data: { ids: [...selectedModels] } }); toast.success('Modelos excluídos'); setSelectedModels(new Set()); fetchAdModels(); }
    catch { toast.error('Erro ao excluir'); }
  };

  const openPublishModalForModel = (model) => {
    let variations = [];
    try { variations = JSON.parse(model.variations || '[]'); } catch {}
    const varPrices = {};
    variations.forEach((v, i) => { varPrices[String(i)] = v.price || model.price || 0; });
    setModelPublishModal({
      modelId: model.id,
      modelTitle: model.title,
      modelSku: model.sku,
      step: 1,
      marketplace: 'ml',
      accountId: '',
      price: model.price || 0,
      listing_type_id: model.listing_type_id || 'gold_special',
      available_quantity: model.available_quantity || 1,
      variations,
      variation_prices: varPrices,
    });
  };

  const handleModelPublish = async () => {
    if (!modelPublishModal) return;
    setModelPublishing(true);
    try {
      const r = await axios.post(`/api/ad-models/${modelPublishModal.modelId}/publish`, {
        marketplace: modelPublishModal.marketplace,
        accountId: modelPublishModal.accountId,
        price: modelPublishModal.price,
        listing_type_id: modelPublishModal.listing_type_id,
        available_quantity: modelPublishModal.available_quantity,
        variation_prices: modelPublishModal.variation_prices,
      });
      toast.success(`Publicado! Novo ID: ${r.data.newItemId}`);
      setModelPublishModal(null);
      fetchAdModels();
    } catch (e) {
      const d = e.response?.data;
      toast.error(d?.error || d?.message || 'Erro ao publicar', { duration: 12000 });
    }
    setModelPublishing(false);
  };

  const openModelBulkPublishModal = () => {
    if (selectedModels.size === 0) return;
    const selected = adModels.filter(m => selectedModels.has(m.id));
    const items = selected.map(model => {
      let attributes = [];
      try { attributes = JSON.parse(model.attributes || '[]'); } catch {}
      const brandAttr = attributes.find(a => a.id === 'BRAND');
      const pics = (() => { try { return JSON.parse(model.pictures || '[]'); } catch { return []; } })();
      const thumb = pics[0]?.source || pics[0]?.secure_url || model.inventory?.image || null;
      const hasImages = pics.length > 0;
      return {
        modelId: model.id,
        title: model.title || '',
        sku: model.sku || '',
        price: model.price || 0,
        listing_type_id: model.listing_type_id || 'gold_special',
        available_quantity: model.available_quantity || 1,
        brand: brandAttr?.value_name || '',
        thumbnail: thumb,
        hasImages,
      };
    });
    setBulkPublishModal({ step: 1, marketplace: 'ml', accountId: '', items });
    setBulkProgress(null);
  };

  const handleBulkPublish = async () => {
    if (!bulkPublishModal || !bulkPublishModal.accountId) return;
    setBulkPublishing(true);
    setBulkPublishModal(p => ({ ...p, step: 3 }));
    setBulkProgress({ total: bulkPublishModal.items.length, current: 0, published: 0, errors: [], done: false });
    try {
      const payload = {
        marketplace: bulkPublishModal.marketplace,
        accountId: bulkPublishModal.accountId,
        items: bulkPublishModal.items.map(it => ({
          modelId: it.modelId,
          title: it.title,
          price: it.price,
          listing_type_id: it.listing_type_id,
          available_quantity: it.available_quantity,
          attribute_overrides: it.brand ? { BRAND: it.brand } : undefined,
        })),
      };
      const r = await axios.post('/api/ad-models/bulk-publish', payload);
      setBulkProgress({
        total: r.data.total,
        current: r.data.total,
        published: r.data.published,
        errors: r.data.errors || [],
        done: true,
      });
      if (r.data.published > 0) {
        toast.success(`${r.data.published} anúncio(s) publicado(s)!`);
        fetchAdModels();
      }
      if (r.data.errors?.length > 0) {
        toast.error(`${r.data.errors.length} erro(s) ao publicar`);
      }
      setSelectedModels(new Set());
    } catch (e) {
      setBulkProgress(prev => ({
        ...prev,
        done: true,
        errors: [{ modelId: 0, error: e.response?.data?.error || e.message }],
      }));
      const d = e.response?.data;
      toast.error(d?.error || d?.message || 'Erro ao publicar em massa', { duration: 12000 });
    }
    setBulkPublishing(false);
  };

  const statusMap = {
    active: { label: 'Ativo', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' },
    paused: { label: 'Pausado', cls: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400' },
    closed: { label: 'Encerrado', cls: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' },
    under_review: { label: 'Em revisão', cls: 'bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400' },
    inactive: { label: 'Inativo', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400' },
    NORMAL: { label: 'Ativo', cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' },
    BANNED: { label: 'Banido', cls: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' },
    UNLIST: { label: 'Pausado', cls: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-400' },
    DELETED: { label: 'Excluído', cls: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400' }
  };

  const formatPrice = (v) => v != null ? `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '-';

  const findInventoryBySku = useCallback((sku) => {
    if (!sku || !inventory.length) return null;
    const skuClean = String(sku).replace(/[a-zA-Z]+/g, '').trim();
    if (!skuClean) return null;
    return inventory.find(inv => String(inv.sku) === skuClean)
      || inventory.find(inv => String(inv.sku).startsWith(skuClean))
      || null;
  }, [inventory]);
  const sourceBadge = (item) => {
    if (item.source === 'shopee') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium">Shopee</span>;
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-medium">Mercado Livre</span>;
  };
  const isActive = (item) => item.status === 'active' || item.status === 'NORMAL';
  const isPaused = (item) => item.status === 'paused' || item.status === 'UNLIST';
  const canActivate = (item) => isPaused(item) || item.status === 'closed';

  const filteredItems = items.filter(item => {
    if (filterMarketplace !== 'all' && item.source !== filterMarketplace) return false;
    if (filterAccount !== 'all') {
      const accId = item.source === 'ml' ? item.ml_account_id : item.shopee_account_id;
      if (String(accId) !== filterAccount) return false;
    }
    return true;
  });

  // Paginação
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const startIdx = (currentPage - 1) * pageSize;
  const paginatedItems = filteredItems.slice(startIdx, startIdx + pageSize);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, filterMarketplace, filterAccount]);

  const mlItemsCount = filteredItems.filter(i => i.source === 'ml').length;

  const allAccounts = [
    ...mlAccounts.map(a => ({ id: a.id, name: a.name, source: 'ml' })),
    ...shopeeAccounts.map(a => ({ id: a.id, name: a.name || `Shopee ${a.id}`, source: 'shopee' })),
  ];
  const accountOptions = filterMarketplace === 'all'
    ? allAccounts
    : allAccounts.filter(a => a.source === filterMarketplace);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            {activeTab === 'modelos'
              ? <><Package className="w-8 h-8 text-purple-500" /> Modelos de Anúncio</>
              : <><Globe className="w-8 h-8 text-blue-500" /> Anúncios Ativos</>
            }
          </h1>
          <p className="text-gray-600 dark:text-gray-300 mt-1">
            {activeTab === 'modelos'
              ? 'Modelos universais para publicação em múltiplos marketplaces'
              : 'Controle de estoque, status e importação/exportação de anúncios'
            }
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {activeTab === 'ativos' && (
            <>
              {selectedItems.size > 0 && (
                <button onClick={handleImportSelected} disabled={importing}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
                  <Download className={`w-4 h-4 ${importing ? 'animate-spin' : ''}`} />
                  {importing ? 'Importando...' : `Importar (${selectedItems.size})`}
                </button>
              )}
          <button onClick={handleSyncAll} disabled={syncing}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizando...' : 'Sincronizar'}
          </button>
          <button onClick={handlePushAll} disabled={pushingAll}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
            <Upload className={`w-4 h-4 ${pushingAll ? 'animate-spin' : ''}`} />
            {pushingAll ? 'Enviando...' : 'Enviar Estoque'}
          </button>
            </>
          )}
          {activeTab === 'modelos' && selectedTemplates.size > 0 && (
            <>
              <button onClick={openBulkPublishModal}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors flex items-center gap-2">
                <Send className="w-4 h-4" /> Publicar ({selectedTemplates.size})
              </button>
              <button onClick={handleDeleteSelectedTemplates}
                className="px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg transition-colors flex items-center gap-2">
                <Trash2 className="w-4 h-4" /> Excluir ({selectedTemplates.size})
              </button>
            </>
          )}
        </div>
      </div>

      {/* === TAB: ANÚNCIOS ATIVOS === */}
      {activeTab === 'ativos' && (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-3 mb-4">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Search className="w-5 h-5 text-gray-400 flex-shrink-0" />
          <input type="text" placeholder="Buscar por título, ID ou SKU..." value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
        </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
                {[{ value: 'all', label: 'Todos' }, { value: 'ml', label: 'Mercado Livre' }, { value: 'shopee', label: 'Shopee' }].map(opt => (
                  <button key={opt.value} onClick={() => { setFilterMarketplace(opt.value); setFilterAccount('all'); }}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${filterMarketplace === opt.value ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              {accountOptions.length > 0 && (
                <div className="relative">
                  <select value={filterAccount} onChange={e => setFilterAccount(e.target.value)}
                    className="pl-3 pr-7 py-1.5 border dark:border-gray-600 rounded-lg text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white appearance-none">
                    <option value="all">Todas as contas</option>
                    {accountOptions.map(a => <option key={`${a.source}-${a.id}`} value={String(a.id)}>{a.name}</option>)}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">{filteredItems.length} anúncios</span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="pl-2 pr-7 py-1.5 border dark:border-gray-600 rounded-lg text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white appearance-none">
                  {[20, 50, 100, 150].map(n => <option key={n} value={n}>{n} por página</option>)}
                </select>
              </div>
            </div>
          </div>
        {loading ? (
          <div className="flex justify-center py-12"><RefreshCw className="w-8 h-8 text-blue-500 animate-spin" /></div>
          ) : filteredItems.length === 0 ? (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <Globe className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p className="text-lg font-medium">Nenhum anúncio encontrado</p>
            <p className="text-sm mt-1">Clique em "Sincronizar" para importar os anúncios</p>
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b dark:border-gray-700 text-gray-600 dark:text-gray-400 font-medium text-xs">
                    <th className="py-3 px-2 w-8">
                      <input type="checkbox" checked={selectedItems.size > 0 && selectedItems.size === mlItemsCount} onChange={toggleSelectAll}
                        className="rounded border-gray-300 dark:border-gray-600" title="Selecionar todos ML" />
                    </th>
                  <th className="text-left py-3 px-3">Anúncio</th>
                    <th className="text-left py-3 px-2">SKU</th>
                  <th className="text-center py-3 px-2">Status</th>
                  <th className="text-center py-3 px-2">Tipo</th>
                    <th className="text-center py-3 px-2">Variação</th>
                    <th className="text-left py-3 px-2">Vinculado</th>
                  <th className="text-right py-3 px-2">Preço</th>
                  <th className="text-center py-3 px-2">Real</th>
                    <th className="text-center py-3 px-2">MKT</th>
                  <th className="text-center py-3 px-2">Faixa</th>
                  <th className="text-center py-3 px-2">Usar Real</th>
                  <th className="text-center py-3 px-2">Sync</th>
                  <th className="text-center py-3 px-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                  {paginatedItems.map(item => {
                  const linked = !!item.config_id;
                  const st = statusMap[item.status] || { label: item.status || '-', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400' };
                  const hasDiscount = item.original_price && item.original_price > item.price;
                  const isCatalog = item.source === 'ml' && !!item.is_catalog_listing;
                  const pushKey = `${item.source}-${item.config_id}`;
                    const selectKey = `${item.source}:${item.item_id_display}:${item.source === 'ml' ? item.ml_account_id : item.shopee_account_id}`;
                    const isExpanded = expandedItems.has(item.uid);
                    const itemVars = (item.variations || []);
                  return (
                      <React.Fragment key={item.uid}>
                      <tr className={`border-b dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${isExpanded ? 'bg-violet-50/30 dark:bg-violet-900/10' : ''}`}>
                        <td className="py-2.5 px-2">
                          {item.source === 'ml' && (
                            <input type="checkbox" checked={selectedItems.has(selectKey)} onChange={() => toggleSelectItem(item)}
                              className="rounded border-gray-300 dark:border-gray-600" />
                          )}
                        </td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          {item.thumbnail && <img src={item.thumbnail} alt="" className="w-10 h-10 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                          <div className="min-w-0">
                              <p className="text-gray-900 dark:text-white font-medium text-sm" title={item.title}>
                                {(() => { const inv = item.variation_count === 0 ? findInventoryBySku(item.sku) : null; return inv ? inv.title : item.title; })()}
                              </p>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <a href={item.permalink} target="_blank" rel="noreferrer" className="text-blue-500 dark:text-blue-400 hover:underline text-[11px]">{item.item_id_display}</a>
                              {sourceBadge(item)}
                                {item.account_name && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium">{item.account_name}</span>}
                                {isCatalog && <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 font-medium">Catálogo</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                        <td className="py-2.5 px-2"><span className="text-xs font-mono text-gray-700 dark:text-gray-300">{item.sku || '-'}</span></td>
                        <td className="py-2.5 px-2 text-center"><span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${st.cls}`}>{st.label}</span></td>
                      <td className="py-2.5 px-2 text-center">
                        {item.source === 'ml' && item.listing_type_id && LISTING_TYPE_MAP[item.listing_type_id] ? (
                          <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${LISTING_TYPE_MAP[item.listing_type_id].color}`}>
                            {LISTING_TYPE_MAP[item.listing_type_id].icon && React.createElement(LISTING_TYPE_MAP[item.listing_type_id].icon, { size: 10 })}
                            {LISTING_TYPE_MAP[item.listing_type_id].label}
                          </span>
                          ) : <span className="text-xs text-gray-400">-</span>}
                      </td>
                        <td className="py-2.5 px-2 text-center">
                          {item.variation_count > 0 ? (
                            <button onClick={() => setExpandedItems(prev => {
                              const next = new Set(prev);
                              next.has(item.uid) ? next.delete(item.uid) : next.add(item.uid);
                              return next;
                            })} className="text-left hover:bg-violet-50 dark:hover:bg-violet-900/20 rounded-md px-1 py-0.5 transition-colors w-full" title="Clique para expandir variações">
                              <div className="flex items-center gap-1">
                                {expandedItems.has(item.uid)
                                  ? <ChevronDown className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />
                                  : <ChevronRight className="w-3.5 h-3.5 text-violet-500 flex-shrink-0" />}
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">
                                  {item.variation_count} var.
                          </span>
                              </div>
                          </button>
                          ) : <span className="text-xs text-gray-400">-</span>}
                        </td>
                        <td className="py-2.5 px-2">
                          {item.variation_count > 0 ? (
                            <span className="text-[10px] text-gray-400 italic">Via variações</span>
                          ) : linked ? (
                            <span className="flex items-center gap-1 text-green-700 dark:text-green-400 text-xs font-medium"><Link2 className="w-3.5 h-3.5" /> {item.linked_sku}</span>
                          ) : (() => {
                            const invMatch = findInventoryBySku(item.sku);
                            return (
                              <div className="flex flex-col gap-0.5">
                                {invMatch && (
                                  <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate max-w-[180px]" title={invMatch.title}>
                                    {invMatch.title}
                                  </span>
                                )}
                                <button onClick={() => setLinkModal(item)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> Vincular</button>
                              </div>
                            );
                          })()}
                      </td>
                      <td className="py-2.5 px-2 text-right">
                        <div className="text-xs">
                          <span className="text-gray-900 dark:text-white font-medium">{formatPrice(item.price)}</span>
                            {hasDiscount && <span className="block text-[10px] text-gray-400 line-through">{formatPrice(item.original_price)}</span>}
                        </div>
                      </td>
                        <td className="py-2.5 px-2 text-center font-mono text-sm">{item.variation_count > 0 ? '' : linked ? <span className={item.real_quantity <= 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-900 dark:text-white'}>{item.real_quantity ?? '-'}</span> : '-'}</td>
                      <td className="py-2.5 px-2 text-center font-mono text-sm text-gray-900 dark:text-white">{item.stock_qty ?? '-'}</td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count > 0 ? '' : linked ? <span className="text-xs text-gray-600 dark:text-gray-400">{item.use_real_stock ? 'Real' : `${item.fictitious_min}-${item.fictitious_max}`}{item.fictitious_value != null && !item.use_real_stock && <span className="ml-1 text-yellow-600 dark:text-yellow-400">({item.fictitious_value})</span>}</span> : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count === 0 && linked && <button onClick={() => handleToggleRealStock(item)} title={item.use_real_stock ? 'Usando estoque real' : 'Usando estoque fictício'}>{item.use_real_stock ? <ToggleRight className="w-6 h-6 text-green-600 dark:text-green-400 mx-auto" /> : <ToggleLeft className="w-6 h-6 text-gray-400 mx-auto" />}</button>}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count === 0 && linked && <button onClick={() => handleToggleEnabled(item)} title={item.enabled ? 'Sync ativo' : 'Sync desativado'}>{item.enabled ? <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 mx-auto" /> : <AlertTriangle className="w-5 h-5 text-gray-400 mx-auto" />}</button>}
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                            {item.source === 'ml' && (
                              <button onClick={() => handleModelImportFromItem(item)}
                                className="p-1.5 rounded-md bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors"
                                title="Criar modelo de anúncio">
                                <Download className="w-3.5 h-3.5" />
                            </button>
                          )}
                            {item.variation_count === 0 && linked && <button onClick={() => handlePush(item)} disabled={pushing[pushKey]} className="p-1.5 rounded-md bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors" title="Enviar estoque"><Upload className={`w-3.5 h-3.5 ${pushing[pushKey] ? 'animate-spin' : ''}`} /></button>}
                            {isActive(item) && <button onClick={() => handleChangeStatus(item, item.source === 'ml' ? 'paused' : 'UNLIST')} className="p-1.5 rounded-md bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-200 dark:hover:bg-yellow-900/50 transition-colors" title="Pausar"><Pause className="w-3.5 h-3.5" /></button>}
                            {canActivate(item) && <button onClick={() => handleChangeStatus(item, item.source === 'ml' ? 'active' : 'NORMAL')} className="p-1.5 rounded-md bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors" title="Ativar"><Play className="w-3.5 h-3.5" /></button>}
                            {item.permalink && <a href={item.permalink} target="_blank" rel="noreferrer" className="p-1.5 rounded-md bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors" title="Abrir"><ExternalLink className="w-3.5 h-3.5" /></a>}
                            {item.variation_count === 0 && linked && <button onClick={() => handleUnlink(item)} className="p-1.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors" title="Desvincular"><Unlink className="w-3.5 h-3.5" /></button>}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && itemVars.length > 0 && itemVars.map(v => {
                        let combos = [];
                        try { combos = JSON.parse(v.attribute_combinations || '[]'); } catch {}
                        const comboStr = combos.map(c => `${c.name || c.id}: ${c.value_name || c.value_id || '?'}`).join(' | ');
                        const varLinked = !!v.var_config_id;
                        const varPushKey = `var-${v.var_config_id}`;
                        return (
                          <tr key={`var-${v.id}`} className="bg-violet-50/50 dark:bg-violet-900/10 border-b dark:border-gray-700/30">
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-3">
                              <div className="flex items-center gap-2 pl-4">
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0"></span>
                                {v.thumbnail && <img src={v.thumbnail} alt="" className="w-7 h-7 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                                <div className="min-w-0">
                                  {(() => { const inv = findInventoryBySku(v.sku); return inv ? (
                                    <>
                                      <p className="text-xs text-violet-700 dark:text-violet-300 font-medium truncate max-w-[200px]" title={inv.title}>{inv.title}</p>
                                      <span className="text-[10px] text-gray-400">{comboStr} | ID: {v.variation_id}</span>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-xs text-violet-700 dark:text-violet-300 font-medium">{comboStr || 'Variação ' + v.variation_id}</p>
                                      <span className="text-[10px] text-gray-400">ID: {v.variation_id}</span>
                                    </>
                                  ); })()}
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 px-2"><span className="text-xs font-mono text-gray-600 dark:text-gray-400">{v.sku || '-'}</span></td>
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-2 text-center">
                              {combos.map((c, ci) => (
                                <span key={ci} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 mr-0.5 mb-0.5">
                                  {c.value_name || c.value_id}
                                </span>
                              ))}
                            </td>
                            <td className="py-1.5 px-2">
                              {varLinked ? (
                                <span className="flex items-center gap-1 text-green-700 dark:text-green-400 text-xs font-medium"><Link2 className="w-3 h-3" /> {v.var_linked_sku}</span>
                              ) : (() => {
                                const invMatch = findInventoryBySku(v.sku);
                                return (
                                  <div className="flex flex-col gap-0.5">
                                    {invMatch && (
                                      <span className="text-[10px] text-gray-500 dark:text-gray-400 truncate max-w-[160px]" title={invMatch.title}>
                                        {invMatch.title}
                                      </span>
                                    )}
                                    <button onClick={() => setVarLinkModal(v)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-0.5"><Link2 className="w-3 h-3" /> Vincular</button>
                                  </div>
                                );
                              })()}
                            </td>
                            <td className="py-1.5 px-2 text-right">
                              <span className="text-xs text-gray-700 dark:text-gray-300">{formatPrice(v.price)}</span>
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono text-xs">
                              {varLinked ? <span className={v.var_real_quantity <= 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-700 dark:text-gray-300'}>{v.var_real_quantity ?? '-'}</span> : '-'}
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono text-xs text-gray-700 dark:text-gray-300">{v.available_quantity}</td>
                            <td className="py-1.5 px-2 text-center">
                              {varLinked ? <span className="text-[10px] text-gray-500">{v.var_use_real_stock ? 'Real' : `${v.var_fict_min}-${v.var_fict_max}`}{v.var_fict_value != null && !v.var_use_real_stock && <span className="ml-0.5 text-yellow-600 dark:text-yellow-400">({v.var_fict_value})</span>}</span> : ''}
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {varLinked && <button onClick={() => handleVarToggleRealStock(v)} title={v.var_use_real_stock ? 'Usando estoque real' : 'Usando estoque fictício'}>{v.var_use_real_stock ? <ToggleRight className="w-5 h-5 text-green-600 dark:text-green-400 mx-auto" /> : <ToggleLeft className="w-5 h-5 text-gray-400 mx-auto" />}</button>}
                            </td>
                            <td className="py-1.5 px-2 text-center">
                              {varLinked && <button onClick={() => handleVarToggleEnabled(v)} title={v.var_enabled ? 'Sync ativo' : 'Sync desativado'}>{v.var_enabled ? <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400 mx-auto" /> : <AlertTriangle className="w-4 h-4 text-gray-400 mx-auto" />}</button>}
                            </td>
                            <td className="py-1.5 px-2">
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => { setManualStockModal(v); setManualStockQty(String(v.available_quantity || 0)); }} className="p-1 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors" title="Definir estoque manual"><Plus className="w-3 h-3" /></button>
                                {varLinked && <button onClick={() => handleVarPush(v)} disabled={pushingVar[varPushKey]} className="p-1 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors" title="Enviar estoque variação"><Upload className={`w-3 h-3 ${pushingVar[varPushKey] ? 'animate-spin' : ''}`} /></button>}
                                {varLinked && <button onClick={() => handleVarUnlink(v)} className="p-1 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors" title="Desvincular variação"><Unlink className="w-3 h-3" /></button>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t dark:border-gray-700">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Página {currentPage} de {totalPages} • {filteredItems.length} anúncios
                </span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage <= 1}
                    className="p-2 rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum;
                    if (totalPages <= 5) pageNum = i + 1;
                    else if (currentPage <= 3) pageNum = i + 1;
                    else if (currentPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                    else pageNum = currentPage - 2 + i;
                    return (
                      <button key={pageNum} onClick={() => setCurrentPage(pageNum)}
                        className={`min-w-[32px] py-1.5 px-2 rounded-lg text-xs font-medium transition-colors ${currentPage === pageNum ? 'bg-blue-600 text-white' : 'border dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
                        {pageNum}
                      </button>
                    );
                  })}
                  <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}
                    className="p-2 rounded-lg border dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
          )}
        </div>
      )}

      {/* === TAB: MODELOS DE ANÚNCIO === */}
      {activeTab === 'modelos' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
          <div className="flex flex-col md:flex-row items-start md:items-center gap-3 mb-4">
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-5 h-5 text-gray-400" />
              <input type="text" placeholder="Buscar por título, SKU ou EAN..." value={modelSearch} onChange={e => setModelSearch(e.target.value)}
                className="flex-1 px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setModelImportModal({ step: 'select' })}
                className="px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5">
                <Download className="w-4 h-4" /> Importar de Anúncio
                            </button>
              <button onClick={() => setModelEditModal({ title: '', sku: '', ean: '', price: 0, available_quantity: 1, listing_type_id: 'gold_special', condition: 'new', buying_mode: 'buy_it_now', currency_id: 'BRL', category_id: '', description: '', video_id: '', _attributes: [], _variations: [], _shipping: null, _sale_terms: [], _pictures: [], _package: DEFAULT_PACKAGE_FORM() })}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> Novo Modelo
              </button>
              <button type="button" onClick={() => setPackagePresetsModalOpen(true)}
                className="px-3 py-2 border border-amber-400/80 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-sm rounded-lg transition-colors flex items-center gap-1.5 hover:bg-amber-100 dark:hover:bg-amber-900/50">
                <Ruler className="w-4 h-4" /> Caixas (presets)
              </button>
              {selectedModels.size > 0 && (
                <>
                  <button onClick={openModelBulkPublishModal}
                    className="px-3 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5">
                    <Send className="w-4 h-4" /> Publicar em Massa ({selectedModels.size})
                  </button>
                  <button onClick={handleModelDeleteBulk}
                    className="px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5">
                    <Trash2 className="w-4 h-4" /> Excluir ({selectedModels.size})
                  </button>
                </>
              )}
            </div>
          </div>

          {adModelsLoading ? (
            <div className="flex justify-center py-12"><RefreshCw className="w-8 h-8 text-blue-500 animate-spin" /></div>
          ) : adModels.length === 0 ? (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <Package className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="text-lg font-medium">Nenhum modelo de anúncio</p>
              <p className="text-sm mt-1">Importe de um anúncio ativo ou crie manualmente</p>
            </div>
          ) : (
            <div className="space-y-3">
              {adModels.map(model => {
                const pics = (() => { try { return JSON.parse(model.pictures || '[]'); } catch { return []; } })();
                const thumb = pics[0]?.source || pics[0]?.secure_url || model.inventory?.image || null;
                let varCount = 0;
                try { varCount = JSON.parse(model.variations || '[]').length; } catch {}
                const isExpanded = expandedModels.has(model.id);
                const mlListings = model.marketplace_listings?.ml || [];
                const shopeeListings = model.marketplace_listings?.shopee || [];
                const mlStatus = model.marketplace_status?.ml || 'none';
                const shopeeStatus = model.marketplace_status?.shopee || 'none';
                const invQty = model.inventory?.quantity;

                const statusDotColor = (s) => s === 'active' ? 'bg-green-500' : s === 'paused' ? 'bg-yellow-500' : s === 'closed' ? 'bg-red-500' : 'bg-gray-400';

                return (
                  <div key={model.id} className="border dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                    <div className="flex items-start gap-4 p-4 cursor-pointer" onClick={() => toggleModelExpand(model.id)}>
                      {/* Checkbox */}
                      <div className="pt-1">
                        <input type="checkbox" checked={selectedModels.has(model.id)}
                          onClick={e => e.stopPropagation()}
                          onChange={() => { const next = new Set(selectedModels); next.has(model.id) ? next.delete(model.id) : next.add(model.id); setSelectedModels(next); }}
                          className="rounded border-gray-300 dark:border-gray-600" />
                      </div>

                      {/* Photo */}
                      <div className="flex-shrink-0">
                        {thumb
                          ? <img src={thumb} alt="" className="w-16 h-16 rounded-lg object-cover bg-gray-100 dark:bg-gray-700" />
                          : <div className="w-16 h-16 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center"><Package className="w-6 h-6 text-gray-400" /></div>
                        }
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate pr-4">{model.title || 'Sem título'}</h3>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {invQty != null && (
                                <span className="flex items-center gap-1">
                                  <Package className="w-3 h-3" /> Estoque: <span className={`font-semibold ${invQty > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{invQty}</span>
                                </span>
                              )}
                              {varCount > 0 && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">{varCount} var.</span>}
                              {model.condition === 'new' ? <span className="text-[10px] text-gray-400">Novo</span> : model.condition === 'used' ? <span className="text-[10px] text-gray-400">Usado</span> : null}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs font-mono text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">{model.sku || 'Sem SKU'}</span>
                              {model.ean && <span className="text-[10px] text-gray-400 font-mono">EAN: {model.ean}</span>}
                              {model.created_at && <span className="text-[10px] text-gray-400">{new Date(model.created_at).toLocaleDateString('pt-BR')}</span>}
                            </div>
                          </div>

                          {/* Right side - price, icons, actions */}
                          <div className="flex flex-col items-end gap-2 flex-shrink-0">
                            <span className="text-base font-bold text-gray-900 dark:text-white">{formatPrice(model.price)}</span>

                            {/* Marketplace icons with status dots */}
                            <div className="flex items-center gap-2">
                              <div className="relative group" title={`ML: ${mlStatus === 'active' ? 'Ativo' : mlStatus === 'paused' ? 'Pausado' : mlStatus === 'closed' ? 'Encerrado' : 'Sem anúncio'} (${mlListings.length})`}>
                                <img src="/mercado-livre.png" alt="ML" className="w-6 h-6 rounded-sm object-contain" style={{ filter: mlStatus === 'none' ? 'grayscale(100%) opacity(0.4)' : 'none' }} />
                                <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-gray-800 ${statusDotColor(mlStatus)}`}></span>
                                {mlListings.length > 1 && <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-blue-500 text-white rounded-full w-3.5 h-3.5 flex items-center justify-center">{mlListings.length}</span>}
                              </div>
                              <div className="relative group" title={`Shopee: ${shopeeStatus === 'active' ? 'Ativo' : shopeeStatus === 'paused' ? 'Pausado' : 'Sem anúncio'} (${shopeeListings.length})`}>
                                <img src="/shopee.png" alt="Shopee" className="w-6 h-6 rounded-sm object-contain" style={{ filter: shopeeStatus === 'none' ? 'grayscale(100%) opacity(0.4)' : 'none' }} />
                                <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-gray-800 ${statusDotColor(shopeeStatus)}`}></span>
                                {shopeeListings.length > 1 && <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-orange-500 text-white rounded-full w-3.5 h-3.5 flex items-center justify-center">{shopeeListings.length}</span>}
                              </div>
                            </div>

                            {/* Action buttons */}
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); openPublishModalForModel(model); }}
                                className="px-2 py-1 text-[10px] font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors"
                                title="Criar novo anúncio">
                                Criar Anúncio
                            </button>
                              <div className="relative">
                                <button onClick={(e) => { e.stopPropagation(); setOpenActionMenu(openActionMenu === model.id ? null : model.id); }}
                                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                                  <MoreVertical className="w-4 h-4" />
                                </button>
                                {openActionMenu === model.id && (
                                  <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-800 rounded-lg shadow-xl border dark:border-gray-700 py-1 z-50"
                                    onClick={(e) => e.stopPropagation()}>
                                    <button onClick={() => {
                                      let _attributes = [], _variations = [], _shipping = null, _sale_terms = [], _pictures = [];
                                      try { _attributes = JSON.parse(model.attributes || '[]'); } catch {}
                                      try { _variations = JSON.parse(model.variations || '[]'); } catch {}
                                      try { _shipping = JSON.parse(model.shipping || 'null'); } catch {}
                                      try { _sale_terms = JSON.parse(model.sale_terms || '[]'); } catch {}
                                      try { _pictures = JSON.parse(model.pictures || '[]'); } catch {}
                                      setModelEditModal({ ...model, description: model.description || '', _attributes, _variations, _shipping, _sale_terms, _pictures, _package: parsePackageMeasuresFromModel(model) });
                                      setOpenActionMenu(null);
                                    }}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Edit3 className="w-3.5 h-3.5 text-blue-500" /> Editar modelo
                                    </button>
                                    <button onClick={() => { handleModelPushStock(model.id); setOpenActionMenu(null); }}
                                      disabled={!model.inventory_id}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors disabled:opacity-40">
                                      <Upload className="w-3.5 h-3.5 text-green-500" /> Enviar estoque
                                    </button>
                                    <button onClick={() => { openPublishModalForModel(model); setOpenActionMenu(null); }}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Send className="w-3.5 h-3.5 text-green-500" /> Publicar
                                    </button>
                                    <a href={`/api/ad-models/${model.id}/pictures/download`} target="_blank" rel="noreferrer"
                                      onClick={() => setOpenActionMenu(null)}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Download className="w-3.5 h-3.5 text-purple-500" /> Download fotos
                                    </a>
                                    <button onClick={() => { const m = model; const dup = { ...m, id: undefined, title: `${m.title} (cópia)` }; setModelEditModal({ ...dup, description: dup.description || '', _attributes: (() => { try { return JSON.parse(m.attributes || '[]'); } catch { return []; } })(), _variations: (() => { try { return JSON.parse(m.variations || '[]'); } catch { return []; } })(), _shipping: (() => { try { return JSON.parse(m.shipping || 'null'); } catch { return null; } })(), _sale_terms: (() => { try { return JSON.parse(m.sale_terms || '[]'); } catch { return []; } })(), _pictures: (() => { try { return JSON.parse(m.pictures || '[]'); } catch { return []; } })(), _package: parsePackageMeasuresFromModel(m) }); setOpenActionMenu(null); }}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Copy className="w-3.5 h-3.5 text-indigo-500" /> Duplicar modelo
                                    </button>
                                    <div className="border-t dark:border-gray-700 my-1"></div>
                                    <button onClick={() => { handleModelDelete(model.id); setOpenActionMenu(null); }}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                                      <Trash2 className="w-3.5 h-3.5" /> Excluir modelo
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Expand chevron */}
                      <div className="pt-1 flex-shrink-0">
                        {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                      </div>
                    </div>

                    {/* Expanded panel with marketplace listings */}
                    {isExpanded && (
                      <div className="border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                        {/* ML Listings */}
                        <div className="p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <img src="/mercado-livre.png" alt="ML" className="w-5 h-5 rounded-sm object-contain" />
                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Mercado Livre</h4>
                            <span className="text-[10px] text-gray-400">({mlListings.length} anúncio{mlListings.length !== 1 ? 's' : ''})</span>
                          </div>
                          {mlListings.length === 0 ? (
                            <p className="text-xs text-gray-400 dark:text-gray-500 ml-7">Nenhum anúncio ML com SKU "{model.sku}"</p>
                          ) : (
                            <div className="space-y-2 ml-7">
                              {mlListings.map((listing, idx) => {
                                const listingStatus = statusMap[listing.status] || { label: listing.status, cls: 'bg-gray-100 text-gray-600' };
                                const toggleKey = `${listing.ml_item_id}_${listing.ml_account_id}`;
                                return (
                                  <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded-lg px-3 py-2.5 border dark:border-gray-700 text-xs">
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                      {listing.thumbnail && <img src={listing.thumbnail} alt="" className="w-8 h-8 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                                      <div className="min-w-0">
                                        <a href={listing.permalink} target="_blank" rel="noreferrer"
                                          className="text-blue-600 dark:text-blue-400 hover:underline font-medium truncate block max-w-[300px]" title={listing.title}>
                                          {listing.ml_item_id}
                                        </a>
                                        <span className="text-gray-400">{listing.account_name}</span>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-3 flex-shrink-0">
                                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${listingStatus.cls}`}>{listingStatus.label}</span>
                                      <span className="text-gray-500 dark:text-gray-400">Est: <span className="font-semibold text-gray-900 dark:text-white">{listing.ml_available_quantity ?? '-'}</span></span>
                                      {listing.stock_config_id && listing.last_pushed_at && (
                                        <span className="text-[10px] text-gray-400" title="Último push">{new Date(listing.last_pushed_at).toLocaleDateString('pt-BR')}</span>
                                      )}
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleToggleListingStatus(model.id, listing.ml_item_id, listing.ml_account_id, listing.status); }}
                                        disabled={togglingListing[toggleKey]}
                                        title={listing.status === 'active' ? 'Pausar anúncio' : 'Ativar anúncio'}
                                        className={`p-1 rounded transition-colors ${listing.status === 'active' ? 'text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20' : 'text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/20'} disabled:opacity-40`}>
                                        {togglingListing[toggleKey]
                                          ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                          : listing.status === 'active' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />
                                        }
                                      </button>
                                      {listing.permalink && (
                                        <a href={listing.permalink} target="_blank" rel="noreferrer" className="p-1 text-gray-400 hover:text-blue-500 transition-colors" title="Abrir no ML">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Shopee Listings */}
                        <div className="p-4 pt-0">
                          <div className="flex items-center gap-2 mb-3">
                            <img src="/shopee.png" alt="Shopee" className="w-5 h-5 rounded-sm object-contain" />
                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Shopee</h4>
                            <span className="text-[10px] text-gray-400">({shopeeListings.length} anúncio{shopeeListings.length !== 1 ? 's' : ''})</span>
                          </div>
                          {shopeeListings.length === 0 ? (
                            <p className="text-xs text-gray-400 dark:text-gray-500 ml-7">Nenhum anúncio Shopee com SKU "{model.sku}"</p>
                          ) : (
                            <div className="space-y-2 ml-7">
                              {shopeeListings.map((listing, idx) => {
                                const listingStatus = statusMap[listing.status] || { label: listing.status, cls: 'bg-gray-100 text-gray-600' };
                                return (
                                  <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 rounded-lg px-3 py-2.5 border dark:border-gray-700 text-xs">
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                      {listing.thumbnail && <img src={listing.thumbnail} alt="" className="w-8 h-8 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                                      <div className="min-w-0">
                                        <span className="text-gray-900 dark:text-white font-medium truncate block max-w-[300px]">{listing.shopee_item_id}</span>
                                        <span className="text-gray-400">{listing.account_name}</span>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-3 flex-shrink-0">
                                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${listingStatus.cls}`}>{listingStatus.label}</span>
                                      <span className="text-gray-500 dark:text-gray-400">Est: <span className="font-semibold text-gray-900 dark:text-white">{listing.shopee_stock ?? '-'}</span></span>
                                      {listing.permalink && (
                                        <a href={listing.permalink} target="_blank" rel="noreferrer" className="p-1 text-gray-400 hover:text-orange-500 transition-colors" title="Abrir na Shopee">
                                          <ExternalLink className="w-3.5 h-3.5" />
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Bottom actions */}
                        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t dark:border-gray-700 bg-gray-100/50 dark:bg-gray-800/80">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleModelPushStock(model.id); }}
                            disabled={!model.inventory_id || pushingModel[model.id]}
                            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-1.5">
                            {pushingModel[model.id] ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                            Enviar Estoque
                          </button>
                          {mlListings.some(l => l.status === 'active') && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                for (const l of mlListings.filter(l => l.status === 'active')) {
                                  await handleToggleListingStatus(model.id, l.ml_item_id, l.ml_account_id, 'active');
                                }
                              }}
                              className="px-3 py-1.5 text-xs font-medium bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg transition-colors flex items-center gap-1.5">
                              <Pause className="w-3 h-3" /> Pausar Todos ML
                            </button>
                          )}
                          {mlListings.some(l => l.status === 'paused') && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                for (const l of mlListings.filter(l => l.status === 'paused')) {
                                  await handleToggleListingStatus(model.id, l.ml_item_id, l.ml_account_id, 'paused');
                                }
                              }}
                              className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors flex items-center gap-1.5">
                              <Play className="w-3 h-3" /> Ativar Todos ML
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Link Modal */}
      {linkModal && (() => {
        const nonComposite = inventory.filter(i => !i.is_composite);
        const anuncioSku = (linkModal.sku || '').trim();

        let suggestion = null;
        if (anuncioSku) {
          const exact = nonComposite.find(inv => inv.sku && inv.sku.toLowerCase() === anuncioSku.toLowerCase());
          if (exact) {
            suggestion = exact;
          } else {
            const partial = nonComposite.filter(inv => inv.sku && (
              inv.sku.toLowerCase().includes(anuncioSku.toLowerCase()) ||
              anuncioSku.toLowerCase().includes(inv.sku.toLowerCase())
            ));
            if (partial.length > 0) suggestion = partial[0];
          }
        }

        const searchLower = linkSearch.toLowerCase();
        const filtered = searchLower
          ? nonComposite.filter(inv => (inv.sku && inv.sku.toLowerCase().includes(searchLower)) || (inv.title && inv.title.toLowerCase().includes(searchLower)) || (inv.ean && inv.ean.toLowerCase().includes(searchLower)))
          : nonComposite;

        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Vincular Anúncio a SKU</h3>
              <button onClick={() => { setLinkModal(null); setLinkSearch(''); }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-1 truncate">{linkModal.title}</p>
            {anuncioSku && <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">SKU do anúncio: <span className="font-mono font-semibold text-gray-700 dark:text-gray-300">{anuncioSku}</span></p>}

            {suggestion && (
              <div className="mb-3">
                <p className="text-xs font-medium text-green-600 dark:text-green-400 mb-1.5 flex items-center gap-1"><Star className="w-3.5 h-3.5" /> Sugestão</p>
                <button onClick={() => handleLink(linkModal, suggestion.id)}
                  className="w-full text-left px-4 py-3 bg-green-50 dark:bg-green-900/20 border-2 border-green-300 dark:border-green-700 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors flex justify-between items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-bold text-green-800 dark:text-green-300 text-sm font-mono">{suggestion.sku}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{suggestion.title}</span>
                  </div>
                  <span className="text-xs font-mono text-green-700 dark:text-green-400 flex-shrink-0 ml-2">Qtd: {suggestion.quantity}</span>
                </button>
              </div>
            )}

            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Buscar por SKU, nome ou EAN..." value={linkSearch} onChange={e => setLinkSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                autoFocus />
            </div>

            <p className="text-xs text-gray-500 mb-2">{filtered.length} itens no inventário</p>

            <div className="flex-1 overflow-y-auto border dark:border-gray-700 rounded-lg min-h-0" style={{ maxHeight: '400px' }}>
              {filtered.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Nenhum item encontrado</div>
              ) : filtered.map(inv => (
                <button key={inv.id} onClick={() => handleLink(linkModal, inv.id)}
                  className={`w-full text-left px-4 py-2.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-b dark:border-gray-700/50 transition-colors flex justify-between items-center ${suggestion && suggestion.id === inv.id ? 'bg-green-50/50 dark:bg-green-900/10' : ''}`}>
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-white text-sm font-mono flex-shrink-0">{inv.sku}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{inv.title}</span>
                  </div>
                  <span className="text-xs font-mono text-gray-600 dark:text-gray-400 flex-shrink-0 ml-2">Qtd: {inv.quantity}</span>
                </button>
              ))}
            </div>

            <div className="mt-4 flex justify-end">
              <button onClick={() => { setLinkModal(null); setLinkSearch(''); }} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
        );
      })()}

      {manualStockModal && (() => {
        let combos = [];
        try { combos = JSON.parse(manualStockModal.attribute_combinations || '[]'); } catch {}
        const comboStr = combos.map(c => `${c.name || c.id}: ${c.value_name || '?'}`).join(' | ');
        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Estoque Manual</h3>
              <button onClick={() => setManualStockModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-violet-600 dark:text-violet-400 mb-1 font-medium">{comboStr || 'Variação ' + manualStockModal.variation_id}</p>
            {manualStockModal.sku && <p className="text-xs text-gray-500 mb-3">SKU: <span className="font-mono font-semibold">{manualStockModal.sku}</span></p>}
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Estoque atual no ML: <span className="font-mono font-bold text-gray-700 dark:text-gray-300">{manualStockModal.available_quantity}</span></p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mt-3 mb-1">Nova quantidade</label>
            <input type="number" min="0" value={manualStockQty} onChange={e => setManualStockQty(e.target.value)}
              className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-lg"
              autoFocus onKeyDown={e => e.key === 'Enter' && handleManualStock()} />
            <p className="text-[10px] text-gray-400 mt-1">Essa quantidade será enviada diretamente ao Mercado Livre para esta variação.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setManualStockModal(null)} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Cancelar</button>
              <button onClick={handleManualStock} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors">Enviar</button>
            </div>
          </div>
        </div>
        );
      })()}

      {varLinkModal && (() => {
        const nonComposite = inventory.filter(i => !i.is_composite);
        const varSku = (varLinkModal.sku || '').trim();

        let suggestion = null;
        if (varSku) {
          const exact = nonComposite.find(inv => inv.sku && inv.sku.toLowerCase() === varSku.toLowerCase());
          if (exact) { suggestion = exact; }
          else {
            const partial = nonComposite.filter(inv => inv.sku && (inv.sku.toLowerCase().includes(varSku.toLowerCase()) || varSku.toLowerCase().includes(inv.sku.toLowerCase())));
            if (partial.length > 0) suggestion = partial[0];
          }
        }
        const searchLower = linkSearch.toLowerCase();
        const filtered = searchLower
          ? nonComposite.filter(inv => (inv.sku && inv.sku.toLowerCase().includes(searchLower)) || (inv.title && inv.title.toLowerCase().includes(searchLower)) || (inv.ean && inv.ean.toLowerCase().includes(searchLower)))
          : nonComposite;

        let combos = [];
        try { combos = JSON.parse(varLinkModal.attribute_combinations || '[]'); } catch {}
        const comboStr = combos.map(c => `${c.name || c.id}: ${c.value_name || '?'}`).join(' | ');

        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Vincular Variação a SKU</h3>
              <button onClick={() => { setVarLinkModal(null); setLinkSearch(''); }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-violet-600 dark:text-violet-400 mb-1">{comboStr || 'Variação ' + varLinkModal.variation_id}</p>
            {varSku && <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">SKU da variação: <span className="font-mono font-semibold text-gray-700 dark:text-gray-300">{varSku}</span></p>}

            {suggestion && (
              <div className="mb-3">
                <p className="text-xs font-medium text-green-600 dark:text-green-400 mb-1.5 flex items-center gap-1"><Star className="w-3.5 h-3.5" /> Sugestão</p>
                <button onClick={() => handleVarLink(varLinkModal, suggestion.id)}
                  className="w-full text-left px-4 py-3 bg-green-50 dark:bg-green-900/20 border-2 border-green-300 dark:border-green-700 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors flex justify-between items-center">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-bold text-green-800 dark:text-green-300 text-sm font-mono">{suggestion.sku}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{suggestion.title}</span>
                  </div>
                  <span className="text-xs font-mono text-green-700 dark:text-green-400 flex-shrink-0 ml-2">Qtd: {suggestion.quantity}</span>
                </button>
              </div>
            )}

            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Buscar por SKU, nome ou EAN..." value={linkSearch} onChange={e => setLinkSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                autoFocus />
            </div>
            <p className="text-xs text-gray-500 mb-2">{filtered.length} itens no inventário</p>

            <div className="flex-1 overflow-y-auto border dark:border-gray-700 rounded-lg min-h-0" style={{ maxHeight: '400px' }}>
              {filtered.length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Nenhum item encontrado</div>
              ) : filtered.map(inv => (
                <button key={inv.id} onClick={() => handleVarLink(varLinkModal, inv.id)}
                  className={`w-full text-left px-4 py-2.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-b dark:border-gray-700/50 transition-colors flex justify-between items-center ${suggestion && suggestion.id === inv.id ? 'bg-green-50/50 dark:bg-green-900/10' : ''}`}>
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-white text-sm font-mono flex-shrink-0">{inv.sku}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{inv.title}</span>
                  </div>
                  <span className="text-xs font-mono text-gray-600 dark:text-gray-400 flex-shrink-0 ml-2">Qtd: {inv.quantity}</span>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => { setVarLinkModal(null); setLinkSearch(''); }} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Edit Template Modal */}
      {editModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Editar Template</h3>
              <button onClick={() => setEditModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">

              {editModal.title?.length > 60 && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-3 text-xs text-yellow-700 dark:text-yellow-400">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  Título tem {editModal.title.length} caracteres. Algumas categorias limitam a 60 caracteres. Será truncado automaticamente na publicação.
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Título ({editModal.title?.length || 0}/60)</label>
                <input type="text" value={editModal.title} onChange={e => setEditModal(p => ({ ...p, title: e.target.value }))}
                  className={`w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${editModal.title?.length > 60 ? 'border-yellow-400 dark:border-yellow-500' : 'dark:border-gray-600'}`} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">ID Origem (ML)</label>
                  <input type="text" value={editModal.source_ml_item_id || ''} readOnly
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Categoria</label>
                  <input type="text" value={editModal.category_id || ''} onChange={e => setEditModal(p => ({ ...p, category_id: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Preço (R$)</label>
                  <input type="number" step="0.01" value={editModal.price} onChange={e => setEditModal(p => ({ ...p, price: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Quantidade</label>
                  <input type="number" value={editModal.available_quantity} onChange={e => setEditModal(p => ({ ...p, available_quantity: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tipo de anúncio (Mercado Livre)</label>
                  <select value={editModal.listing_type_id} onChange={e => setEditModal(p => ({ ...p, listing_type_id: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                    <option value="gold_pro">Premium</option>
                    <option value="gold_special">Clássico</option>
                    <option value="free">Grátis</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Condição</label>
                  <select value={editModal.condition || 'new'} onChange={e => setEditModal(p => ({ ...p, condition: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                    <option value="new">Novo</option>
                    <option value="used">Usado</option>
                    <option value="not_specified">Não especificado</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Modo de compra</label>
                  <select value={editModal.buying_mode || 'buy_it_now'} onChange={e => setEditModal(p => ({ ...p, buying_mode: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                    <option value="buy_it_now">Comprar agora</option>
                    <option value="auction">Leilão</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Moeda</label>
                  <input type="text" value={editModal.currency_id || 'BRL'} onChange={e => setEditModal(p => ({ ...p, currency_id: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Descrição</label>
                <textarea rows={5} value={editModal.description} onChange={e => setEditModal(p => ({ ...p, description: e.target.value }))}
                  className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-y" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Video ID</label>
                <input type="text" value={editModal.video_id || ''} onChange={e => setEditModal(p => ({ ...p, video_id: e.target.value }))}
                  placeholder="(vazio)" className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              </div>

              {/* Imagens */}
              {editModal._pictures && editModal._pictures.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Imagens ({editModal._pictures.length})</label>
                  <div className="flex gap-2 flex-wrap">
                    {editModal._pictures.map((p, i) => <img key={i} src={p.source || p.secure_url} alt="" className="w-16 h-16 rounded object-cover bg-gray-100 dark:bg-gray-700" />)}
                  </div>
                </div>
              )}

              {/* Atributos */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                  Atributos ({(editModal._attributes || []).length})
                </label>
                {(editModal._attributes || []).length > 0 ? (
                  <div className="border dark:border-gray-600 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                        <tr>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">ID</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Nome</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Valor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y dark:divide-gray-700">
                        {editModal._attributes.map((attr, i) => (
                          <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                            <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 font-mono">{attr.id}</td>
                            <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{attr.name || '-'}</td>
                            <td className="px-3 py-1.5">
                              <input type="text" value={attr.value_name || attr.value_id || ''}
                                onChange={e => {
                                  const updated = [...editModal._attributes];
                                  updated[i] = { ...updated[i], value_name: e.target.value };
                                  setEditModal(p => ({ ...p, _attributes: updated }));
                                }}
                                className="w-full px-2 py-0.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                placeholder="(vazio)" />
                      </td>
                    </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">Nenhum atributo importado</p>
                )}
              </div>

              {/* Variações */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                  Variações ({(editModal._variations || []).length})
                </label>
                {(editModal._variations || []).length > 0 ? (
                  <div className="border dark:border-gray-600 rounded-lg overflow-hidden max-h-52 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                        <tr>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Combinação</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">SKU</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Qtd</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Preço</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y dark:divide-gray-700">
                        {editModal._variations.map((v, i) => (
                          <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                            <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">
                              {(v.attribute_combinations || []).map(ac => `${ac.name || ac.id}: ${ac.value_name || ac.value_id}`).join(', ') || '-'}
                            </td>
                            <td className="px-3 py-1.5">
                              <input type="text" value={v.seller_custom_field || ''}
                                onChange={e => {
                                  const updated = [...editModal._variations];
                                  updated[i] = { ...updated[i], seller_custom_field: e.target.value };
                                  setEditModal(p => ({ ...p, _variations: updated }));
                                }}
                                className="w-full px-2 py-0.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                placeholder="(vazio)" />
                            </td>
                            <td className="px-3 py-1.5">
                              <input type="number" value={v.available_quantity || 0}
                                onChange={e => {
                                  const updated = [...editModal._variations];
                                  updated[i] = { ...updated[i], available_quantity: parseInt(e.target.value, 10) || 0 };
                                  setEditModal(p => ({ ...p, _variations: updated }));
                                }}
                                className="w-16 px-2 py-0.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                            </td>
                            <td className="px-3 py-1.5">
                              <input type="number" step="0.01" value={v.price || ''}
                                onChange={e => {
                                  const updated = [...editModal._variations];
                                  updated[i] = { ...updated[i], price: parseFloat(e.target.value) || 0 };
                                  setEditModal(p => ({ ...p, _variations: updated }));
                                }}
                                className="w-20 px-2 py-0.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                placeholder="(vazio)" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">Nenhuma variação</p>
                )}
              </div>

              {/* Termos de Venda */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
                  Termos de Venda ({(editModal._sale_terms || []).length})
                </label>
                {(editModal._sale_terms || []).length > 0 ? (
                  <div className="border dark:border-gray-600 rounded-lg overflow-hidden max-h-36 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-700/50 sticky top-0">
                        <tr>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">ID</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Nome</th>
                          <th className="px-3 py-1.5 text-left text-gray-500 dark:text-gray-400 font-medium">Valor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y dark:divide-gray-700">
                        {editModal._sale_terms.map((t, i) => (
                          <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                            <td className="px-3 py-1.5 text-gray-500 dark:text-gray-400 font-mono">{t.id}</td>
                            <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{t.name || '-'}</td>
                            <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{t.value_name || t.value_id || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">Nenhum termo de venda</p>
                )}
              </div>

              {/* Shipping (somente leitura) */}
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">Frete (da origem - não será enviado na publicação)</label>
                {editModal._shipping ? (
                  <div className="bg-gray-50 dark:bg-gray-700/30 border dark:border-gray-600 rounded-lg p-3 text-xs space-y-1">
                    <div className="grid grid-cols-2 gap-x-4">
                      <span className="text-gray-500 dark:text-gray-400">Modo:</span>
                      <span className="text-gray-700 dark:text-gray-300">{editModal._shipping.mode || '-'}</span>
                      <span className="text-gray-500 dark:text-gray-400">Tipo logístico:</span>
                      <span className="text-gray-700 dark:text-gray-300">{editModal._shipping.logistic_type || '-'}</span>
                      <span className="text-gray-500 dark:text-gray-400">Frete grátis:</span>
                      <span className="text-gray-700 dark:text-gray-300">{editModal._shipping.free_shipping ? 'Sim' : 'Não'}</span>
                      <span className="text-gray-500 dark:text-gray-400">Retirada no local:</span>
                      <span className="text-gray-700 dark:text-gray-300">{editModal._shipping.local_pick_up ? 'Sim' : 'Não'}</span>
                      {editModal._shipping.dimensions && (<>
                        <span className="text-gray-500 dark:text-gray-400">Dimensões:</span>
                        <span className="text-gray-700 dark:text-gray-300">{editModal._shipping.dimensions}</span>
                      </>)}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 italic">Nenhum dado de frete</p>
                )}
              </div>

              {editModal.error_message && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3 text-xs text-red-700 dark:text-red-400">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  <strong>Último erro:</strong> {editModal.error_message}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setEditModal(null)} className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
              <button onClick={handleSaveEdit} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">Salvar Alterações</button>
            </div>
          </div>
        </div>
      )}

      {/* Publish Modal (old templates) */}
      {publishModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                Publicar {publishModal.templateIds ? `${publishModal.templateIds.length} template(s)` : 'Template'}
              </h3>
              <button onClick={() => setPublishModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Selecione a conta de destino onde os anúncios serão criados:</p>
            <div className="space-y-2 mb-6">
              {mlAccounts.map(acc => (
                <button key={acc.id} onClick={() => setPublishModal(p => ({ ...p, targetAccountId: acc.id }))}
                  className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all flex items-center justify-between ${
                    publishModal.targetAccountId === acc.id
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                      : 'border-gray-200 dark:border-gray-600 hover:border-blue-300'
                  }`}>
                  <div>
                    <span className="font-medium text-gray-900 dark:text-white text-sm">{acc.name}</span>
                    {acc.ml_user_id && <span className="text-xs text-gray-400 ml-2">ID: {acc.ml_user_id}</span>}
                  </div>
                  {publishModal.targetAccountId === acc.id && <CheckCircle className="w-5 h-5 text-green-500" />}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPublishModal(null)} className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
              <button onClick={handlePublish} disabled={!publishModal.targetAccountId || publishing}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-lg text-sm font-medium flex items-center gap-2">
                {publishing ? <><RefreshCw className="w-4 h-4 animate-spin" /> Publicando...</> : <><Send className="w-4 h-4" /> Publicar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Model Edit Modal */}
      {modelEditModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-[min(96rem,98vw)] max-h-[92vh] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{modelEditModal.id ? 'Editar Modelo' : 'Novo Modelo de Anúncio'}</h3>
              <button onClick={() => setModelEditModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 xl:gap-4 items-start">
                <div className="xl:col-span-3 min-w-0">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Categoria</label>
                  <input type="text" value={modelEditModal.category_name || modelEditModal.category_id || ''} readOnly
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-gray-50 dark:bg-gray-700/50 text-gray-900 dark:text-white cursor-default" />
                  {modelEditModal.category_id && (
                    <span className="text-[10px] text-gray-400 mt-0.5 block font-mono truncate" title={modelEditModal.category_id}>{modelEditModal.category_id}</span>
                  )}
                </div>
                <div className="xl:col-span-6 min-w-0">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Título ({modelEditModal.title?.length || 0}/60)</label>
                  <input type="text" value={modelEditModal.title || ''} onChange={e => setModelEditModal(p => ({ ...p, title: e.target.value }))}
                    className={`w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${modelEditModal.title?.length > 60 ? 'border-yellow-400 dark:border-yellow-500' : 'dark:border-gray-600'}`} />
                </div>
                <div className="xl:col-span-3 min-w-0">
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Condição</label>
                  <select value={modelEditModal.condition || 'new'} onChange={e => setModelEditModal(p => ({ ...p, condition: e.target.value }))}
                    className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                    <option value="new">Novo</option>
                    <option value="used">Usado</option>
                  </select>
                </div>
              </div>

              {modelEditModal.title?.length > 60 && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg p-3 text-xs text-yellow-700 dark:text-yellow-400">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  Título tem {modelEditModal.title.length} caracteres. Será truncado para 60 na publicação.
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Descrição</label>
                <textarea rows={4} value={modelEditModal.description || ''} onChange={e => setModelEditModal(p => ({ ...p, description: e.target.value }))}
                  className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-y" />
              </div>

              {/* Imagens */}
              <div className="border border-gray-200 dark:border-gray-600 rounded-xl p-4 space-y-3 bg-gray-50/50 dark:bg-gray-900/20">
                <div className="flex flex-wrap items-center gap-2">
                  <Image className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Imagens ({(modelEditModal._pictures || []).length})</span>
                </div>
                <input ref={modelPictureFileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleModelPictureFile} />
                {(modelEditModal._pictures || []).length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Nenhuma imagem ainda. Adicione pelo menos uma antes de publicar.</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {(modelEditModal._pictures || []).map((p, pi) => (
                      <div key={String(p.id || p.source || pi)} className="flex items-start gap-2 p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                        <span className="text-[10px] text-gray-400 w-6 pt-1 text-right flex-shrink-0">{pi + 1}</span>
                        <img src={p.source || p.secure_url} alt="" className="w-14 h-14 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" onError={(e) => { e.target.style.opacity = 0.35; }} />
                        <div className="flex-1 min-w-0">
                          <label className="text-[10px] text-gray-500 dark:text-gray-400 block mb-0.5">Link da imagem</label>
                          <input type="text" value={p.source || p.secure_url || ''} onChange={(e) => {
                            const u = [...(modelEditModal._pictures || [])];
                            u[pi] = { ...u[pi], source: e.target.value };
                            setModelEditModal((prev) => ({ ...prev, _pictures: u }));
                          }} className="w-full text-sm border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div className="flex flex-col gap-0.5 flex-shrink-0">
                          <button type="button" disabled={pi === 0} onClick={() => {
                            const u = [...(modelEditModal._pictures || [])];
                            if (pi === 0) return;
                            [u[pi - 1], u[pi]] = [u[pi], u[pi - 1]];
                            setModelEditModal((prev) => ({ ...prev, _pictures: u }));
                          }} className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-25" title="Subir"><ChevronUp className="w-4 h-4" /></button>
                          <button type="button" disabled={pi >= (modelEditModal._pictures || []).length - 1} onClick={() => {
                            const u = [...(modelEditModal._pictures || [])];
                            if (pi >= u.length - 1) return;
                            [u[pi], u[pi + 1]] = [u[pi + 1], u[pi]];
                            setModelEditModal((prev) => ({ ...prev, _pictures: u }));
                          }} className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-25" title="Descer"><ChevronDown className="w-4 h-4" /></button>
                          <button type="button" onClick={() => {
                            const pid = p.id;
                            const pics = [...(modelEditModal._pictures || [])];
                            pics.splice(pi, 1);
                            const vars = (modelEditModal._variations || []).map((vv) => ({
                              ...vv,
                              picture_ids: (vv.picture_ids || []).filter((x) => String(x) !== String(pid)),
                            }));
                            setModelEditModal((prev) => ({ ...prev, _pictures: pics, _variations: vars }));
                          }} className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded" title="Remover"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => {
                    setModelShowPicUrlInput((s) => {
                      if (s) setModelPicUrlDraft('');
                      return !s;
                    });
                  }}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium whitespace-nowrap">
                    Adicionar URL
                  </button>
                  <button type="button" disabled={modelPicUploading} onClick={() => modelPictureFileInputRef.current?.click()}
                    className="px-4 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-lg text-sm font-medium whitespace-nowrap flex items-center justify-center gap-2 disabled:opacity-50">
                    {modelPicUploading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Enviar arquivo
                  </button>
                </div>
                {modelShowPicUrlInput && (
                  <div className="flex flex-col sm:flex-row gap-2 flex-wrap pt-1 border-t border-gray-200 dark:border-gray-600">
                    <input type="url" placeholder="Cole o link da imagem (https://...)" value={modelPicUrlDraft} onChange={e => setModelPicUrlDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const url = modelPicUrlDraft.trim();
                          if (!url) return;
                          setModelEditModal((p) => ({ ...p, _pictures: [...(p._pictures || []), { id: `pic-${Date.now()}`, source: url }] }));
                          setModelPicUrlDraft('');
                          setModelShowPicUrlInput(false);
                        }
                      }}
                      className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                    <button type="button" onClick={() => {
                      const url = modelPicUrlDraft.trim();
                      if (!url) return;
                      setModelEditModal((p) => ({ ...p, _pictures: [...(p._pictures || []), { id: `pic-${Date.now()}`, source: url }] }));
                      setModelPicUrlDraft('');
                      setModelShowPicUrlInput(false);
                    }} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium whitespace-nowrap">Incluir link</button>
                    <button type="button" onClick={() => { setModelShowPicUrlInput(false); setModelPicUrlDraft(''); }} className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
                  </div>
                )}
              </div>

              {modelEditModal.category_id && (
                <div className="space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <div>
                      <label className="block text-sm font-semibold text-gray-800 dark:text-gray-200">Ficha técnica — Atributos do item ({(modelEditModal._attributes || []).length})</label>
                      <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                        Campos obrigatórios da categoria ML (<span className="font-mono">{modelEditModal.category_id}</span>) são adicionados automaticamente quando faltam (ex.: <span className="font-mono">MATERIALS</span>, <span className="font-mono">INCLUDES_BULBS</span>). Preencha o valor em cada cartão. Atributos de <strong className="font-medium text-gray-600 dark:text-gray-300">variação</strong> (cor, voltagem, etc.) ficam na secção <strong className="font-medium text-gray-600 dark:text-gray-300">Variações</strong>.
                      </p>
                    </div>
                    {modelCategorySchemaLoading && (
                      <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Carregando regras do ML…
                      </span>
                    )}
                  </div>

                  {!modelCategorySchemaLoading && modelEditModal.category_id && modelCategorySchema === null && (
                    <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1 align-text-bottom" />
                      Não foi possível carregar as regras da categoria. Os destaques de obrigatoriedade podem não aparecer.
                    </div>
                  )}

                  {modelAttrAnalysis.missingCount > 0 && (
                    <div className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2.5 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <div>
                        <strong>{modelAttrAnalysis.missingCount}</strong> atributo(s) obrigatório(s) pelo Mercado Livre estão sem valor. Preencha antes de publicar para evitar erro 400.
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <input
                      type="search"
                      value={modelAttrSearch}
                      onChange={e => setModelAttrSearch(e.target.value)}
                      placeholder="Buscar por nome ou ID…"
                      className="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                    <div className="flex rounded-lg border border-gray-200 dark:border-gray-600 overflow-hidden text-xs font-medium">
                      <button
                        type="button"
                        onClick={() => setModelAttrFilter('all')}
                        className={`px-3 py-2 transition-colors ${modelAttrFilter === 'all' ? 'bg-gray-100 dark:bg-gray-600 text-gray-900 dark:text-white' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                      >
                        Todos ({modelAttrAnalysis.rows.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setModelAttrFilter('issues')}
                        className={`px-3 py-2 transition-colors border-l border-gray-200 dark:border-gray-600 ${modelAttrFilter === 'issues' ? 'bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300' : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                      >
                        Pendências ({modelAttrAnalysis.rows.filter(r => r.issue).length})
                      </button>
                    </div>
                  </div>

                  <div className="border border-gray-200 dark:border-gray-600 rounded-xl max-h-[min(36rem,62vh)] overflow-y-auto p-2 bg-gray-50/50 dark:bg-gray-900/20">
                    {modelCategorySchemaLoading && (modelEditModal._attributes || []).length === 0 ? (
                      <div className="text-sm text-gray-500 text-center py-8 px-2 flex items-center justify-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                        A carregar atributos da categoria…
                      </div>
                    ) : modelAttrFilteredRows.length === 0 ? (
                      <div className="text-sm text-gray-500 text-center py-6 space-y-2 px-2">
                        <p>Nenhum atributo do <strong className="font-medium text-gray-700 dark:text-gray-300">item</strong> para este filtro.</p>
                        {modelAttrSearch.trim() && modelVariationAxesMatchingSearch.length > 0 ? (
                          <p className="text-xs text-amber-800 dark:text-amber-200/90 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 text-left">
                            O termo coincide com atributos de <strong>variação</strong> no ML ({modelVariationAxesMatchingSearch.map((a) => a.name || a.id).join(', ')}). Abra cada variação abaixo e edite <strong>Combinação de atributos</strong>.
                          </p>
                        ) : modelAttrSearch.trim() && /frequ|rota|rpm/i.test(modelAttrSearch) ? (
                          <p className="text-xs text-gray-600 dark:text-gray-400 text-left max-w-lg mx-auto">
                            Rotação em rpm costuma ser <strong className="font-medium">Velocidade máxima de rotação</strong> (<span className="font-mono">MAX_ROTATION_SPEED</span>) nesta lista, ou um eixo na secção Variações. «Frequência» no ML (Hz) é outro campo (<span className="font-mono">FREQUENCY</span>).
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                        {modelAttrFilteredRows.map((r) => {
                          const val = (r.attr.value_name || r.attr.value_id || '').toString();
                          const maxLen = r.def?.value_max_length;
                          const listVals = r.def?.values;
                          const hasList = Array.isArray(listVals) && listVals.length > 0;
                          let selectVal = '';
                          if (hasList) {
                            if (r.attr.value_id != null && String(r.attr.value_id).trim() !== '') {
                              selectVal = String(r.attr.value_id);
                            } else {
                              const byName = listVals.find((v) => v.name === r.attr.value_name);
                              selectVal = byName ? String(byName.id) : '';
                            }
                          }
                          const inputBorder = r.issue
                            ? 'border-red-400 ring-1 ring-red-100 dark:ring-red-900/50'
                            : r.mlMandatory && !r.empty
                              ? 'border-emerald-300 dark:border-emerald-700'
                              : 'border-gray-200 dark:border-gray-600';
                          return (
                            <div
                              key={`${r.attr.id}-${r.index}`}
                              className={`rounded-lg border p-2 min-w-0 transition-colors ${
                                r.issue
                                  ? 'border-red-300 bg-red-50/80 dark:bg-red-950/25 dark:border-red-800'
                                  : r.mlMandatory && !r.empty
                                    ? 'border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/10 dark:border-emerald-700/50'
                                    : 'border-gray-200 bg-white dark:bg-gray-800/80 dark:border-gray-600'
                              }`}
                            >
                              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 mb-1">
                                <span className="text-xs font-semibold text-gray-900 dark:text-white leading-tight break-words">{r.displayName}</span>
                                <span className="text-[9px] font-mono text-gray-400 dark:text-gray-500 shrink-0">{r.attr.id}</span>
                              </div>
                              {r.def?.hint ? (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1.5 leading-snug">{r.def.hint}</p>
                              ) : null}
                              <div className="flex flex-wrap gap-1 mb-1.5">
                                {r.ignored && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">Ignorado</span>
                                )}
                                {!r.ignored && r.required && (
                                  <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200">Obrig. ML</span>
                                )}
                                {!r.ignored && !r.required && r.catalogRequired && (
                                  <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">Catálogo</span>
                                )}
                                {r.issue && (
                                  <span className="text-[9px] font-bold text-red-700 dark:text-red-400">Preencher</span>
                                )}
                              </div>
                              {hasList ? (
                                <select
                                  value={selectVal}
                                  onChange={(e) => {
                                    const vid = e.target.value;
                                    const u = [...modelEditModal._attributes];
                                    const opt = listVals.find((v) => String(v.id) === String(vid));
                                    u[r.index] = {
                                      ...u[r.index],
                                      value_id: vid || null,
                                      value_name: opt ? opt.name : '',
                                    };
                                    setModelEditModal((p) => ({ ...p, _attributes: u }));
                                  }}
                                  className={`w-full min-w-0 px-2 py-1.5 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${inputBorder}`}
                                >
                                  <option value="">— Selecione —</option>
                                  {listVals.map((v) => (
                                    <option key={v.id} value={String(v.id)}>{v.name}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={val}
                                  onChange={(e) => {
                                    const u = [...modelEditModal._attributes];
                                    u[r.index] = { ...u[r.index], value_name: e.target.value, value_id: null };
                                    setModelEditModal((p) => ({ ...p, _attributes: u }));
                                  }}
                                  placeholder="Valor"
                                  maxLength={typeof maxLen === 'number' && maxLen > 0 ? maxLen : undefined}
                                  className={`w-full min-w-0 px-2 py-1.5 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${inputBorder}`}
                                />
                              )}
                              <div className="mt-1 text-[9px] text-gray-500 dark:text-gray-400 flex flex-wrap justify-between gap-x-2 gap-y-0">
                                <span className="tabular-nums">
                                  {hasList ? (
                                    <span className="font-mono">lista ML</span>
                                  ) : (
                                    <>
                                      {typeof maxLen === 'number' && maxLen > 0 ? `${val.length}/${maxLen}` : val.length}
                                      {r.def?.value_type ? (
                                        <span className="text-gray-400 dark:text-gray-500"> · <span className="font-mono">{r.def.value_type}</span></span>
                                      ) : null}
                                    </>
                                  )}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Medidas da embalagem — acima das variações (ML: PACKAGE_* no POST /items) */}
              <div className="border border-amber-200 dark:border-amber-900/50 rounded-xl p-4 space-y-3 bg-amber-50/40 dark:bg-amber-950/15">
                <div className="flex flex-wrap items-center gap-2">
                  <Ruler className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Medidas da embalagem</span>
                </div>
                <div className="space-y-2">
                  <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={modelEditModal._package?.has_factory_packaging !== false}
                      onChange={() => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), has_factory_packaging: true } }))}
                    />
                    <span>Tem caixa, envelope ou embalagem de fábrica — informe as medidas abaixo (ou escolha uma caixa salva).</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={modelEditModal._package?.has_factory_packaging === false}
                      onChange={() => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), has_factory_packaging: false, preset_id: null } }))}
                    />
                    <span>Meu produto não tem embalagem com essas características (não enviamos medidas ao ML).</span>
                  </label>
                </div>
                {modelEditModal._package?.has_factory_packaging !== false && (
                  <div className="space-y-3 pt-1">
                    <div className="min-w-0">
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Caixas salvas</label>
                      <select
                        value={modelEditModal._package?.preset_id != null ? String(modelEditModal._package.preset_id) : ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), preset_id: null } }));
                            return;
                          }
                          const pr = packagePresets.find((x) => String(x.id) === v);
                          if (!pr) return;
                          setModelEditModal((p) => ({
                            ...p,
                            _package: {
                              ...(p._package || DEFAULT_PACKAGE_FORM()),
                              preset_id: pr.id,
                              has_factory_packaging: true,
                              width_cm: String(pr.width_cm),
                              height_cm: String(pr.height_cm),
                              depth_cm: String(pr.depth_cm),
                              weight_kg: String(pr.weight_kg),
                            },
                          }));
                        }}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      >
                        <option value="">— Medidas manuais —</option>
                        {packagePresets.map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.name} ({pr.width_cm}×{pr.height_cm}×{pr.depth_cm} cm, {pr.weight_kg} kg)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div>
                        <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Largura (cm)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={modelEditModal._package?.width_cm ?? ''}
                          onChange={(e) => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), width_cm: e.target.value, preset_id: null } }))}
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Altura (cm)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={modelEditModal._package?.height_cm ?? ''}
                          onChange={(e) => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), height_cm: e.target.value, preset_id: null } }))}
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Profundidade (cm)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={modelEditModal._package?.depth_cm ?? ''}
                          onChange={(e) => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), depth_cm: e.target.value, preset_id: null } }))}
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Peso (kg)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={modelEditModal._package?.weight_kg ?? ''}
                          onChange={(e) => setModelEditModal((p) => ({ ...p, _package: { ...(p._package || DEFAULT_PACKAGE_FORM()), weight_kg: e.target.value, preset_id: null } }))}
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border border-gray-200 dark:border-gray-600 rounded-xl p-4 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Variações ({(modelEditModal._variations || []).length})</span>
                  {modelShowVariationEditor && (
                    <button type="button" onClick={() => {
                      const axesRaw = modelVariationAxisAttrsFiltered.length > 0 ? modelVariationAxisAttrsFiltered : modelVariationAxisAttrs;
                      const axes = axesRaw.length > 0 ? axesRaw : [];
                      const basePrice = parseFloat(modelEditModal.price) || 0;
                      const prev = (modelEditModal._variations || []).length > 0
                        ? modelEditModal._variations[modelEditModal._variations.length - 1]
                        : null;
                      let combos;
                      if (useNestedVariationUi && variationNestedSplit.secondary.length > 0) {
                        const split = primarySecondaryVariationAttrs(axes.length > 0 ? axes : modelVariationAxisAttrs);
                        combos = buildCombosFromSplit(split, { attribute_combinations: [] }, 'allEmpty');
                      } else {
                        combos = axes.length > 0
                          ? axes.map((a) => ({ id: a.id, name: a.name, value_id: null, value_name: '' }))
                          : [{ id: 'VAR', name: 'Variação', value_id: null, value_name: '' }];
                      }
                      const newIdx = (modelEditModal._variations || []).length;
                      setModelEditModal((p) => ({
                        ...p,
                        _variations: [...(p._variations || []), {
                          attribute_combinations: combos,
                          price: prev != null ? (prev.price ?? basePrice) : basePrice,
                          available_quantity: prev != null ? (prev.available_quantity ?? 1) : 1,
                          picture_ids: prev ? [...(prev.picture_ids || [])] : [],
                          seller_custom_field: '',
                          attributes: [],
                        }],
                      }));
                      setModelVariationExpanded((prev) => new Set([...prev, newIdx]));
                    }} className="text-xs font-medium px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700">
                      {useNestedVariationUi ? '+ Nova cor (grupo)' : '+ Adicionar variação'}
                    </button>
                  )}
                </div>

                {modelShowVariationEditor && modelVariationAxisChoice != null && modelVariationAxisChoice !== 'none' && (
                  <div className="flex flex-wrap items-end gap-3 pb-3 border-b border-gray-200 dark:border-gray-600/80">
                    <div className="w-full sm:w-44">
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Preço base (R$)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={modelEditModal.price || ''}
                        onChange={e => setModelEditModal(p => ({ ...p, price: e.target.value }))}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      />
                    </div>
                  </div>
                )}

                {modelShowVariationAxisPicker && (
                  <div className="rounded-xl border-2 border-dashed border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-4 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setModelVariationAxisChoice('color')}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500 text-gray-800 dark:text-gray-200">Cor</button>
                      <button type="button" onClick={() => setModelVariationAxisChoice('voltage')}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500 text-gray-800 dark:text-gray-200">Voltagem</button>
                      <button type="button" onClick={() => setModelVariationAxisChoice('full')}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-500 text-gray-800 dark:text-gray-200">Cor e voltagem</button>
                      <button type="button" onClick={() => { setModelVariationAxisChoice('none'); setModelEditModal((p) => ({ ...p, _variations: [] })); }}
                        className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600">Sem variação</button>
                    </div>
                  </div>
                )}

                {modelVariationAxisChoice === 'none' && (
                  <div className="text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/30 rounded-lg px-3 py-2">
                    Modelo sem variações (um único SKU).
                    <button type="button" onClick={() => {
                      setModelVariationAxisChoice(null);
                      setModelEditModal((p) => ({ ...p, _variations: [] }));
                    }} className="ml-2 text-blue-600 dark:text-blue-400 font-medium hover:underline">Alterar</button>
                  </div>
                )}

                {modelVariationAxisAttrs.length === 0 && (modelEditModal._variations || []).length > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                    Carregue a categoria ou defina combinações manualmente (edição de valor abaixo).
                  </p>
                )}
                {modelShowVariationEditor && (modelEditModal._variations || []).length === 0 && (
                  <p className="text-xs text-gray-400 italic">Nenhuma linha ainda. Use &quot;Adicionar variação&quot; copiando preço e estoque do anúncio — ajuste só cor ou voltagem em cada linha.</p>
                )}
                {modelShowVariationEditor && (modelEditModal._variations || []).length > 0 && (
                  <div className="space-y-3 max-h-[min(36rem,58vh)] overflow-y-auto pr-1">
                    {useNestedVariationUi ? (
                      variationGroups.map((g) => (
                        <div
                          key={g.indices && g.indices.length ? `vg-${g.indices.join('-')}` : g.pk}
                          className="rounded-xl border-2 border-violet-200/80 dark:border-violet-800/60 bg-violet-50/30 dark:bg-violet-950/15 overflow-hidden"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-violet-200/60 dark:border-violet-800/50 bg-violet-100/40 dark:bg-violet-900/25">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[10px] font-bold text-violet-900 dark:text-violet-200 uppercase tracking-wide flex-shrink-0">Cor / grupo</span>
                              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{g.label}</span>
                            </div>
                            {g.indices[0] != null && (
                              <button
                                type="button"
                                onClick={() => {
                                  const sampleVi = g.indices[0];
                                  setModelEditModal((p) => {
                                    const vars = p._variations || [];
                                    const sample = vars[sampleVi];
                                    if (!sample) return p;
                                    const axes = variationAxesUi.length > 0 ? variationAxesUi : modelVariationAxisAttrs;
                                    const split = primarySecondaryVariationAttrs(axes);
                                    const combos = buildCombosFromSplit(split, sample, 'cloneSecondary');
                                    const basePrice = parseFloat(p.price) || 0;
                                    const prev = sample;
                                    const newIdx = vars.length;
                                    queueMicrotask(() => setModelVariationExpanded((prevE) => new Set([...prevE, newIdx])));
                                    return {
                                      ...p,
                                      _variations: [...vars, {
                                        attribute_combinations: combos,
                                        price: prev.price ?? basePrice,
                                        available_quantity: prev.available_quantity ?? 1,
                                        picture_ids: [...(prev.picture_ids || [])],
                                        seller_custom_field: '',
                                        attributes: [],
                                      }],
                                    };
                                  });
                                }}
                                className="text-xs font-medium px-2.5 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-violet-300 dark:border-violet-600 text-violet-800 dark:text-violet-200 hover:bg-violet-50 dark:hover:bg-violet-900/40"
                              >
                                + Adicionar voltagem nesta cor
                              </button>
                            )}
                          </div>
                          <div className="p-2 space-y-2">
                            {g.indices.map((vi) => (
                              <ModelVariationAccordionRow
                                key={vi}
                                vi={vi}
                                modelEditModal={modelEditModal}
                                setModelEditModal={setModelEditModal}
                                modelCategorySchema={modelCategorySchema}
                                modelVariationExpanded={modelVariationExpanded}
                                setModelVariationExpanded={setModelVariationExpanded}
                                modelVariationAxisAttrs={modelVariationAxisAttrs}
                                setModelVariationAxisChoice={setModelVariationAxisChoice}
                              />
                            ))}
                          </div>
                        </div>
                      ))
                    ) : (
                      (modelEditModal._variations || []).map((_, vi) => (
                        <ModelVariationAccordionRow
                          key={vi}
                          vi={vi}
                          modelEditModal={modelEditModal}
                          setModelEditModal={setModelEditModal}
                          modelCategorySchema={modelCategorySchema}
                          modelVariationExpanded={modelVariationExpanded}
                          setModelVariationExpanded={setModelVariationExpanded}
                          modelVariationAxisAttrs={modelVariationAxisAttrs}
                          setModelVariationAxisChoice={setModelVariationAxisChoice}
                        />
                      ))
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-200 dark:border-gray-600">
                      <button
                        type="button"
                        onClick={() => {
                          const axesRaw = modelVariationAxisAttrsFiltered.length > 0 ? modelVariationAxisAttrsFiltered : modelVariationAxisAttrs;
                          const axes = axesRaw.length > 0 ? axesRaw : [];
                          const basePrice = parseFloat(modelEditModal.price) || 0;
                          const prev = (modelEditModal._variations || []).length > 0
                            ? modelEditModal._variations[modelEditModal._variations.length - 1]
                            : null;
                          let combos;
                          if (useNestedVariationUi && variationNestedSplit.secondary.length > 0) {
                            const split = primarySecondaryVariationAttrs(axes.length > 0 ? axes : modelVariationAxisAttrs);
                            combos = buildCombosFromSplit(split, { attribute_combinations: [] }, 'allEmpty');
                          } else {
                            combos = axes.length > 0
                              ? axes.map((a) => ({ id: a.id, name: a.name, value_id: null, value_name: '' }))
                              : [{ id: 'VAR', name: 'Variação', value_id: null, value_name: '' }];
                          }
                          const newIdx = (modelEditModal._variations || []).length;
                          setModelEditModal((p) => ({
                            ...p,
                            _variations: [...(p._variations || []), {
                              attribute_combinations: combos,
                              price: prev != null ? (prev.price ?? basePrice) : basePrice,
                              available_quantity: prev != null ? (prev.available_quantity ?? 1) : 1,
                              picture_ids: prev ? [...(prev.picture_ids || [])] : [],
                              seller_custom_field: '',
                              attributes: [],
                            }],
                          }));
                          setModelVariationExpanded((prev) => new Set([...prev, newIdx]));
                        }}
                        className="text-xs font-medium px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                      >
                        {useNestedVariationUi ? '+ Adicionar outra cor (novo grupo)' : '+ Adicionar outra linha de variação'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {modelVariationAxisChoice === 'none' && (
                <div className="border border-emerald-200 dark:border-emerald-800 rounded-xl p-4 sm:p-5 space-y-3 bg-emerald-50/40 dark:bg-emerald-950/20">
                  <div>
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">Identificação e valores (SKU único)</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">SKU</label>
                      <input type="text" value={modelEditModal.sku || ''} onChange={e => setModelEditModal(p => ({ ...p, sku: e.target.value }))}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">EAN</label>
                      <input type="text" value={modelEditModal.ean || ''} onChange={e => setModelEditModal(p => ({ ...p, ean: e.target.value }))}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Preço (R$)</label>
                      <input type="number" step="0.01" value={modelEditModal.price || ''} onChange={e => setModelEditModal(p => ({ ...p, price: e.target.value }))}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Quantidade</label>
                      <input type="number" value={modelEditModal.available_quantity || ''} onChange={e => setModelEditModal(p => ({ ...p, available_quantity: e.target.value }))}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setModelEditModal(null)} className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
              <button onClick={handleModelSave} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* Model Publish Modal - Multi-step */}
      {modelPublishModal && (() => {
        const pm = modelPublishModal;
        const step = pm.step || 1;
        const hasVariations = pm.variations && pm.variations.length > 0 && pm.variations.some(v => v.attribute_combinations && v.attribute_combinations.length > 0);
        const selectedAccount = (pm.marketplace === 'ml' ? mlAccounts : shopeeAccounts).find(a => a.id === pm.accountId);

        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                  <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                    {step === 1 ? 'Publicar Modelo' : pm.marketplace === 'ml' ? 'Configurar para Mercado Livre' : 'Configurar para Shopee'}
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[350px]">{pm.modelTitle} {pm.modelSku && `(${pm.modelSku})`}</p>
                  </div>
                <button onClick={() => setModelPublishModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
              </div>

              {/* Step indicator */}
              <div className="flex items-center gap-2 mb-5">
                <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 1 ? 'text-blue-600 dark:text-blue-400' : 'text-green-600 dark:text-green-400'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${step === 1 ? 'bg-blue-500' : 'bg-green-500'}`}>{step === 1 ? '1' : '✓'}</span>
                  Destino
                </div>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 2 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${step === 2 ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>2</span>
                  Configuração
                </div>
              </div>

              {/* STEP 1: Marketplace + Account */}
              {step === 1 && (
                <>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Marketplace</p>
                  <div className="flex gap-2 mb-4">
                    <button onClick={() => setModelPublishModal(p => ({ ...p, marketplace: 'ml', accountId: '' }))}
                      className={`flex-1 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all flex items-center justify-center gap-2 ${pm.marketplace === 'ml' ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' : 'border-gray-200 dark:border-gray-600 text-gray-500 hover:border-gray-300'}`}>
                      <img src="/mercado-livre.png" alt="" className="w-5 h-5 object-contain" /> Mercado Livre
                    </button>
                    <button onClick={() => setModelPublishModal(p => ({ ...p, marketplace: 'shopee', accountId: '' }))}
                      className={`flex-1 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all flex items-center justify-center gap-2 ${pm.marketplace === 'shopee' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-200 dark:border-gray-600 text-gray-500 hover:border-gray-300'}`}>
                      <img src="/shopee.png" alt="" className="w-5 h-5 object-contain" /> Shopee
                    </button>
                  </div>

                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Conta de destino</p>
                  <div className="space-y-2 mb-5">
                    {(pm.marketplace === 'ml' ? mlAccounts : shopeeAccounts).map(acc => (
                      <button key={acc.id} onClick={() => setModelPublishModal(p => ({ ...p, accountId: acc.id }))}
                        className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all flex items-center justify-between ${
                          pm.accountId === acc.id ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-gray-200 dark:border-gray-600 hover:border-blue-300'
                        }`}>
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white text-sm">{acc.name}</span>
                          {acc.ml_user_id && <span className="text-xs text-gray-400 ml-2">ID: {acc.ml_user_id}</span>}
                        </div>
                        {pm.accountId === acc.id && <CheckCircle className="w-5 h-5 text-green-500" />}
                </button>
              ))}
                    {(pm.marketplace === 'ml' ? mlAccounts : shopeeAccounts).length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-4">Nenhuma conta configurada</p>
                    )}
            </div>

                  <div className="flex justify-end gap-3">
                    <button onClick={() => setModelPublishModal(null)} className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
                    <button onClick={() => setModelPublishModal(p => ({ ...p, step: 2 }))} disabled={!pm.accountId}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center gap-2">
                      Avançar <ChevronRight className="w-4 h-4" />
              </button>
            </div>
                </>
              )}

              {/* STEP 2: Marketplace-specific config */}
              {step === 2 && pm.marketplace === 'ml' && (
                <>
                  <div className="flex items-center gap-2 mb-4 text-xs text-gray-500 dark:text-gray-400">
                    <img src="/mercado-livre.png" alt="" className="w-4 h-4 object-contain" />
                    <span>Conta: <strong className="text-gray-700 dark:text-gray-300">{selectedAccount?.name || '?'}</strong></span>
          </div>

                  {/* Listing type */}
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Tipo de anúncio (Mercado Livre)</p>
                  <div className="flex gap-2 mb-4">
                    <button onClick={() => setModelPublishModal(p => ({ ...p, listing_type_id: 'gold_special' }))}
                      className={`flex-1 px-3 py-3 rounded-lg border-2 text-sm transition-all ${pm.listing_type_id === 'gold_special'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-gray-300'}`}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <Award className="w-4 h-4 text-blue-500" />
                        <span className="font-semibold text-gray-900 dark:text-white">Clássico</span>
        </div>
                      <span className="text-[10px] text-gray-500 dark:text-gray-400">Tarifa menor (~11%)</span>
                    </button>
                    <button onClick={() => setModelPublishModal(p => ({ ...p, listing_type_id: 'gold_pro' }))}
                      className={`flex-1 px-3 py-3 rounded-lg border-2 text-sm transition-all ${pm.listing_type_id === 'gold_pro'
                        ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-gray-300'}`}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <Star className="w-4 h-4 text-orange-500" />
                        <span className="font-semibold text-gray-900 dark:text-white">Premium</span>
                      </div>
                      <span className="text-[10px] text-gray-500 dark:text-gray-400">Mais visibilidade (~16%)</span>
                    </button>
                  </div>

                  {/* Price */}
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {hasVariations ? 'Preço Base' : 'Preço'}
                  </p>
                  <div className="relative mb-4">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">R$</span>
                    <input type="number" step="0.01" min="0" value={pm.price}
                      onChange={e => setModelPublishModal(p => ({ ...p, price: Number(e.target.value) }))}
                      className="w-full pl-10 pr-3 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium" />
                  </div>

                  {/* Quantity (only if no variations) */}
                  {!hasVariations && (
                    <>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Quantidade</p>
                      <input type="number" min="1" value={pm.available_quantity}
                        onChange={e => setModelPublishModal(p => ({ ...p, available_quantity: Number(e.target.value) }))}
                        className="w-full px-3 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium mb-4" />
                    </>
                  )}

                  {/* Variations table */}
                  {hasVariations && (
                    <>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Variações ({pm.variations.filter(v => v.attribute_combinations?.length > 0).length})</p>
                      <div className="border dark:border-gray-700 rounded-lg overflow-hidden mb-4">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                              <th className="text-left py-2 px-3 font-medium">Variação</th>
                              <th className="text-left py-2 px-3 font-medium">SKU</th>
                              <th className="text-right py-2 px-3 font-medium w-28">Preço (R$)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pm.variations.map((v, idx) => {
                              if (!v.attribute_combinations || v.attribute_combinations.length === 0) return null;
                              const label = v.attribute_combinations.map(ac => ac.value_name || ac.value_id).join(' / ');
                              const vSku = v.seller_custom_field || (v.attributes?.find(a => a.id === 'SELLER_SKU')?.value_name) || '-';
                              return (
                                <tr key={idx} className="border-t dark:border-gray-700/50">
                                  <td className="py-2 px-3 text-gray-700 dark:text-gray-300">{label}</td>
                                  <td className="py-2 px-3 text-gray-500 dark:text-gray-400 font-mono">{vSku}</td>
                                  <td className="py-2 px-3">
                                    <input type="number" step="0.01" min="0"
                                      value={pm.variation_prices[String(idx)] ?? v.price ?? pm.price}
                                      onChange={e => setModelPublishModal(p => ({
                                        ...p, variation_prices: { ...p.variation_prices, [String(idx)]: Number(e.target.value) }
                                      }))}
                                      className="w-full px-2 py-1 border dark:border-gray-600 rounded text-right text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium" />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <button onClick={() => {
                        const newPrices = {};
                        pm.variations.forEach((_, i) => { newPrices[String(i)] = pm.price; });
                        setModelPublishModal(p => ({ ...p, variation_prices: newPrices }));
                      }}
                        className="text-[10px] text-blue-500 hover:text-blue-600 mb-4 block">
                        Aplicar preço base a todas as variações
                      </button>
                    </>
                  )}

                  <div className="flex justify-between gap-3 pt-2 border-t dark:border-gray-700">
                    <button onClick={() => setModelPublishModal(p => ({ ...p, step: 1 }))}
                      className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 rotate-180" /> Voltar
                    </button>
                    <button onClick={handleModelPublish} disabled={modelPublishing}
                      className="px-5 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-lg text-sm font-medium flex items-center gap-2">
                      {modelPublishing ? <><RefreshCw className="w-4 h-4 animate-spin" /> Publicando...</> : <><Send className="w-4 h-4" /> Publicar no ML</>}
                    </button>
                  </div>
                </>
              )}

              {/* STEP 2: Shopee placeholder */}
              {step === 2 && pm.marketplace === 'shopee' && (
                <>
                  <div className="flex items-center gap-2 mb-4 text-xs text-gray-500 dark:text-gray-400">
                    <img src="/shopee.png" alt="" className="w-4 h-4 object-contain" />
                    <span>Conta: <strong className="text-gray-700 dark:text-gray-300">{selectedAccount?.name || '?'}</strong></span>
                  </div>

                  {/* Price */}
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Preço</p>
                  <div className="relative mb-4">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">R$</span>
                    <input type="number" step="0.01" min="0" value={pm.price}
                      onChange={e => setModelPublishModal(p => ({ ...p, price: Number(e.target.value) }))}
                      className="w-full pl-10 pr-3 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium" />
                  </div>

                  {/* Logistics placeholder */}
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Logística</p>
                  <div className="px-3 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-gray-50 dark:bg-gray-700/50 text-gray-400 dark:text-gray-500 mb-4">
                    Configuração de logística será habilitada em breve
                  </div>

                  <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-orange-700 dark:text-orange-400">
                        A publicação na Shopee está em desenvolvimento. Os campos estão preparados, mas a criação do anúncio ainda não está disponível.
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-between gap-3 pt-2 border-t dark:border-gray-700">
                    <button onClick={() => setModelPublishModal(p => ({ ...p, step: 1 }))}
                      className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 rotate-180" /> Voltar
                    </button>
                    <button disabled
                      className="px-5 py-2 bg-gray-400 text-white rounded-lg text-sm font-medium cursor-not-allowed flex items-center gap-2">
                      <Send className="w-4 h-4" /> Em breve
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Bulk Publish Modal */}
      {bulkPublishModal && (() => {
        const bp = bulkPublishModal;
        const step = bp.step || 1;
        const selectedAccount = (bp.marketplace === 'ml' ? mlAccounts : shopeeAccounts).find(a => a.id === bp.accountId);
        const itemsWithoutImages = bp.items.filter(it => !it.hasImages);

        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                    {step === 1 ? 'Publicar em Massa' : step === 2 ? 'Configurar Anúncios' : 'Progresso da Publicação'}
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5">{bp.items.length} modelo(s) selecionado(s)</p>
                </div>
                {step !== 3 && (
                  <button onClick={() => setBulkPublishModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
                )}
              </div>

              {/* Step indicator */}
              <div className="flex items-center gap-2 mb-5">
                <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 1 ? 'text-blue-600 dark:text-blue-400' : 'text-green-600 dark:text-green-400'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${step === 1 ? 'bg-blue-500' : 'bg-green-500'}`}>{step > 1 ? '✓' : '1'}</span>
                  Destino
                </div>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 2 ? 'text-blue-600 dark:text-blue-400' : step > 2 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${step === 2 ? 'bg-blue-500' : step > 2 ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}>{step > 2 ? '✓' : '2'}</span>
                  Configuração
                </div>
                <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
                <div className={`flex items-center gap-1.5 text-xs font-medium ${step === 3 ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400'}`}>
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${step === 3 ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>3</span>
                  Resultado
                </div>
              </div>

              {/* STEP 1: Marketplace + Account */}
              {step === 1 && (
                <>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Marketplace</p>
                  <div className="flex gap-2 mb-4">
                    <button onClick={() => setBulkPublishModal(p => ({ ...p, marketplace: 'ml', accountId: '' }))}
                      className={`flex-1 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all flex items-center justify-center gap-2 ${bp.marketplace === 'ml' ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' : 'border-gray-200 dark:border-gray-600 text-gray-500 hover:border-gray-300'}`}>
                      <img src="/mercado-livre.png" alt="" className="w-5 h-5 object-contain" /> Mercado Livre
                    </button>
                    <button onClick={() => setBulkPublishModal(p => ({ ...p, marketplace: 'shopee', accountId: '' }))}
                      className={`flex-1 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all flex items-center justify-center gap-2 ${bp.marketplace === 'shopee' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-200 dark:border-gray-600 text-gray-500 hover:border-gray-300'}`}>
                      <img src="/shopee.png" alt="" className="w-5 h-5 object-contain" /> Shopee
                    </button>
                  </div>

                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Conta de destino</p>
                  <div className="space-y-2 mb-5">
                    {(bp.marketplace === 'ml' ? mlAccounts : shopeeAccounts).map(acc => (
                      <button key={acc.id} onClick={() => setBulkPublishModal(p => ({ ...p, accountId: acc.id }))}
                        className={`w-full text-left px-4 py-3 rounded-lg border-2 transition-all flex items-center justify-between ${
                          bp.accountId === acc.id ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : 'border-gray-200 dark:border-gray-600 hover:border-blue-300'
                        }`}>
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white text-sm">{acc.name}</span>
                          {acc.ml_user_id && <span className="text-xs text-gray-400 ml-2">ID: {acc.ml_user_id}</span>}
                        </div>
                        {bp.accountId === acc.id && <CheckCircle className="w-5 h-5 text-green-500" />}
                      </button>
                    ))}
                    {(bp.marketplace === 'ml' ? mlAccounts : shopeeAccounts).length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-4">Nenhuma conta configurada</p>
                    )}
                  </div>

                  <div className="flex justify-end gap-3">
                    <button onClick={() => setBulkPublishModal(null)} className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700">Cancelar</button>
                    <button onClick={() => setBulkPublishModal(p => ({ ...p, step: 2 }))} disabled={!bp.accountId}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium flex items-center gap-2">
                      Avançar <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </>
              )}

              {/* STEP 2: Bulk config table */}
              {step === 2 && bp.marketplace === 'ml' && (
                <>
                  <div className="flex items-center gap-2 mb-3 text-xs text-gray-500 dark:text-gray-400">
                    <img src="/mercado-livre.png" alt="" className="w-4 h-4 object-contain" />
                    <span>Conta: <strong className="text-gray-700 dark:text-gray-300">{selectedAccount?.name || '?'}</strong></span>
                  </div>

                  {itemsWithoutImages.length > 0 && (
                    <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-3">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-orange-700 dark:text-orange-400">
                          {itemsWithoutImages.length} modelo(s) sem imagens. Imagens são obrigatórias para publicar no ML.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Apply to all bar */}
                  <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
                    <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 mb-2">Aplicar a Todos</p>
                    <div className="flex flex-wrap gap-2 items-end">
                      <div className="flex items-center gap-1.5">
                        <label className="text-[10px] text-gray-500 dark:text-gray-400">Tipo</label>
                        <select className="text-xs border dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          defaultValue=""
                          onChange={e => {
                            if (!e.target.value) return;
                            setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, listing_type_id: e.target.value })) }));
                            e.target.value = '';
                          }}>
                          <option value="">Selecionar...</option>
                          <option value="gold_special">Clássico</option>
                          <option value="gold_pro">Premium</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-[10px] text-gray-500 dark:text-gray-400">Marca</label>
                        <input type="text" placeholder="Marca..."
                          className="text-xs border dark:border-gray-600 rounded px-2 py-1.5 w-28 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          onKeyDown={e => {
                            if (e.key === 'Enter' && e.target.value.trim()) {
                              const val = e.target.value.trim();
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, brand: val })) }));
                              e.target.value = '';
                            }
                          }}
                          onBlur={e => {
                            if (e.target.value.trim()) {
                              const val = e.target.value.trim();
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, brand: val })) }));
                              e.target.value = '';
                            }
                          }} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-[10px] text-gray-500 dark:text-gray-400">Preço</label>
                        <input type="number" step="0.01" min="0" placeholder="R$"
                          className="text-xs border dark:border-gray-600 rounded px-2 py-1.5 w-24 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          onKeyDown={e => {
                            if (e.key === 'Enter' && e.target.value) {
                              const val = Number(e.target.value);
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, price: val })) }));
                              e.target.value = '';
                            }
                          }}
                          onBlur={e => {
                            if (e.target.value) {
                              const val = Number(e.target.value);
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, price: val })) }));
                              e.target.value = '';
                            }
                          }} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <label className="text-[10px] text-gray-500 dark:text-gray-400">Qtd</label>
                        <input type="number" min="1" placeholder="Qtd"
                          className="text-xs border dark:border-gray-600 rounded px-2 py-1.5 w-16 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          onKeyDown={e => {
                            if (e.key === 'Enter' && e.target.value) {
                              const val = Number(e.target.value);
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, available_quantity: val })) }));
                              e.target.value = '';
                            }
                          }}
                          onBlur={e => {
                            if (e.target.value) {
                              const val = Number(e.target.value);
                              setBulkPublishModal(p => ({ ...p, items: p.items.map(it => ({ ...it, available_quantity: val })) }));
                              e.target.value = '';
                            }
                          }} />
                      </div>
                    </div>
                  </div>

                  {/* Items table */}
                  <div className="border dark:border-gray-700 rounded-lg overflow-hidden mb-4">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-gray-700/50 text-gray-500 dark:text-gray-400">
                            <th className="text-left py-2 px-2 font-medium w-10"></th>
                            <th className="text-left py-2 px-2 font-medium">Produto</th>
                            <th className="text-left py-2 px-2 font-medium w-28">Tipo</th>
                            <th className="text-left py-2 px-2 font-medium w-28">Marca</th>
                            <th className="text-right py-2 px-2 font-medium w-24">Preço (R$)</th>
                            <th className="text-right py-2 px-2 font-medium w-16">Qtd</th>
                            <th className="text-center py-2 px-2 font-medium w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {bp.items.map((item, idx) => (
                            <tr key={item.modelId} className="border-t dark:border-gray-700/50 hover:bg-gray-50/50 dark:hover:bg-gray-700/20">
                              <td className="py-2 px-2">
                                {item.thumbnail ? (
                                  <img src={item.thumbnail} alt="" className="w-8 h-8 rounded object-cover" />
                                ) : (
                                  <div className="w-8 h-8 rounded bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                                    <Package className="w-4 h-4 text-gray-400" />
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-2">
                                <div className="max-w-[200px]">
                                  <p className="text-gray-900 dark:text-white font-medium truncate text-[11px]">{item.title}</p>
                                  <p className="text-gray-400 text-[10px] font-mono">{item.sku || '-'}</p>
                                  {!item.hasImages && <span className="text-[9px] text-orange-500 font-medium">⚠ Sem imagens</span>}
                                </div>
                              </td>
                              <td className="py-2 px-2">
                                <select value={item.listing_type_id}
                                  onChange={e => setBulkPublishModal(p => ({
                                    ...p, items: p.items.map((it, i) => i === idx ? { ...it, listing_type_id: e.target.value } : it)
                                  }))}
                                  className="w-full text-xs border dark:border-gray-600 rounded px-1.5 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                                  <option value="gold_special">Clássico</option>
                                  <option value="gold_pro">Premium</option>
                                </select>
                              </td>
                              <td className="py-2 px-2">
                                <input type="text" value={item.brand}
                                  onChange={e => setBulkPublishModal(p => ({
                                    ...p, items: p.items.map((it, i) => i === idx ? { ...it, brand: e.target.value } : it)
                                  }))}
                                  placeholder="Marca..."
                                  className="w-full text-xs border dark:border-gray-600 rounded px-1.5 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                              </td>
                              <td className="py-2 px-2">
                                <input type="number" step="0.01" min="0" value={item.price}
                                  onChange={e => setBulkPublishModal(p => ({
                                    ...p, items: p.items.map((it, i) => i === idx ? { ...it, price: Number(e.target.value) } : it)
                                  }))}
                                  className="w-full text-xs border dark:border-gray-600 rounded px-1.5 py-1 text-right bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium" />
                              </td>
                              <td className="py-2 px-2">
                                <input type="number" min="1" value={item.available_quantity}
                                  onChange={e => setBulkPublishModal(p => ({
                                    ...p, items: p.items.map((it, i) => i === idx ? { ...it, available_quantity: Number(e.target.value) } : it)
                                  }))}
                                  className="w-full text-xs border dark:border-gray-600 rounded px-1.5 py-1 text-right bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                              </td>
                              <td className="py-2 px-2 text-center">
                                {bp.items.length > 1 && (
                                  <button onClick={() => setBulkPublishModal(p => ({
                                    ...p, items: p.items.filter((_, i) => i !== idx)
                                  }))}
                                    className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                    title="Remover do lote">
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="flex justify-between gap-3 pt-2 border-t dark:border-gray-700">
                    <button onClick={() => setBulkPublishModal(p => ({ ...p, step: 1 }))}
                      className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 rotate-180" /> Voltar
                    </button>
                    <button onClick={handleBulkPublish} disabled={bulkPublishing || bp.items.length === 0}
                      className="px-5 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-lg text-sm font-medium flex items-center gap-2">
                      <Send className="w-4 h-4" /> Publicar {bp.items.length} anúncio(s)
                    </button>
                  </div>
                </>
              )}

              {/* STEP 2: Shopee placeholder */}
              {step === 2 && bp.marketplace === 'shopee' && (
                <>
                  <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-orange-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-orange-700 dark:text-orange-400">
                        A publicação em massa na Shopee está em desenvolvimento.
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-between gap-3 pt-2 border-t dark:border-gray-700">
                    <button onClick={() => setBulkPublishModal(p => ({ ...p, step: 1 }))}
                      className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 rotate-180" /> Voltar
                    </button>
                    <button disabled className="px-5 py-2 bg-gray-400 text-white rounded-lg text-sm font-medium cursor-not-allowed flex items-center gap-2">
                      <Send className="w-4 h-4" /> Em breve
                    </button>
                  </div>
                </>
              )}

              {/* STEP 3: Progress & Results */}
              {step === 3 && bulkProgress && (
                <>
                  <div className="mb-4">
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="text-gray-600 dark:text-gray-400">
                        {bulkProgress.done ? 'Concluído' : 'Publicando...'}
                      </span>
                      <span className="font-medium text-gray-900 dark:text-white">
                        {bulkProgress.done ? `${bulkProgress.published} de ${bulkProgress.total}` : `Processando ${bulkProgress.total} anúncios...`}
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-3 overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-500 ${bulkProgress.done ? (bulkProgress.errors.length > 0 ? 'bg-orange-500' : 'bg-green-500') : 'bg-blue-500 animate-pulse'}`}
                        style={{ width: bulkProgress.done ? '100%' : '60%' }} />
                    </div>
                  </div>

                  {bulkProgress.done && (
                    <>
                      <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-green-600 dark:text-green-400">{bulkProgress.published}</p>
                          <p className="text-xs text-green-700 dark:text-green-400">Publicado(s)</p>
                        </div>
                        <div className={`border rounded-lg p-3 text-center ${bulkProgress.errors.length > 0 ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-700'}`}>
                          <p className={`text-2xl font-bold ${bulkProgress.errors.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400'}`}>{bulkProgress.errors.length}</p>
                          <p className={`text-xs ${bulkProgress.errors.length > 0 ? 'text-red-700 dark:text-red-400' : 'text-gray-500'}`}>Erro(s)</p>
                        </div>
                      </div>

                      {bulkProgress.errors.length > 0 && (
                        <div className="border dark:border-gray-700 rounded-lg overflow-hidden mb-4">
                          <div className="bg-red-50 dark:bg-red-900/20 px-3 py-2 border-b dark:border-gray-700">
                            <p className="text-xs font-semibold text-red-700 dark:text-red-400">Detalhes dos erros</p>
                          </div>
                          <div className="max-h-40 overflow-y-auto">
                            {bulkProgress.errors.map((err, i) => (
                              <div key={i} className="px-3 py-2 border-b dark:border-gray-700/50 last:border-b-0">
                                <p className="text-xs font-medium text-gray-900 dark:text-white">{err.title || `Modelo #${err.modelId}`}</p>
                                <p className="text-[10px] text-red-600 dark:text-red-400 mt-0.5 whitespace-pre-wrap">{err.error}</p>
                                {err.details?.cause?.length > 0 && (
                                  <p className="text-[10px] text-gray-600 dark:text-gray-400 mt-1 font-mono break-all">
                                    {JSON.stringify(err.details.cause)}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button onClick={() => { setBulkPublishModal(null); setBulkProgress(null); }}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium">
                          Fechar
                        </button>
                      </div>
                    </>
                  )}

                  {!bulkProgress.done && (
                    <div className="flex items-center justify-center py-8">
                      <RefreshCw className="w-6 h-6 text-blue-500 animate-spin mr-2" />
                      <span className="text-sm text-gray-500 dark:text-gray-400">Publicando anúncios, aguarde...</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Presets de embalagem (caixas salvas) */}
      {packagePresetsModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-3 sm:p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <Package className="w-5 h-5 text-amber-600" /> Caixas de embalagem
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Presets reutilizáveis ao editar modelos (medidas enviadas ao ML como PACKAGE_*).</p>
              </div>
              <button type="button" onClick={() => setPackagePresetsModalOpen(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-3">
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Nova caixa</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Nome</label>
                    <input
                      type="text"
                      placeholder="Ex.: Caixa P — ventilador"
                      value={presetNewDraft.name}
                      onChange={(e) => setPresetNewDraft((p) => ({ ...p, name: e.target.value }))}
                      className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Largura (cm)</label>
                    <input type="number" min="0" step="0.1" value={presetNewDraft.width_cm} onChange={(e) => setPresetNewDraft((p) => ({ ...p, width_cm: e.target.value }))}
                      className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Altura (cm)</label>
                    <input type="number" min="0" step="0.1" value={presetNewDraft.height_cm} onChange={(e) => setPresetNewDraft((p) => ({ ...p, height_cm: e.target.value }))}
                      className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Profundidade (cm)</label>
                    <input type="number" min="0" step="0.1" value={presetNewDraft.depth_cm} onChange={(e) => setPresetNewDraft((p) => ({ ...p, depth_cm: e.target.value }))}
                      className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-600 dark:text-gray-400 mb-0.5">Peso (kg)</label>
                    <input type="number" min="0" step="0.001" value={presetNewDraft.weight_kg} onChange={(e) => setPresetNewDraft((p) => ({ ...p, weight_kg: e.target.value }))}
                      className="w-full px-2 py-1.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={presetSaving}
                  onClick={handlePresetModalAdd}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
                >
                  {presetSaving ? 'Salvando…' : 'Adicionar caixa'}
                </button>
              </div>

              <div>
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-2">Suas caixas ({packagePresets.length})</p>
                {packagePresets.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center border border-dashed border-gray-300 dark:border-gray-600 rounded-lg">Nenhuma caixa salva ainda.</p>
                ) : (
                  <ul className="space-y-2">
                    {packagePresets.map((pr) => (
                      <li key={pr.id} className="border border-gray-200 dark:border-gray-600 rounded-lg p-3 bg-gray-50/80 dark:bg-gray-900/30">
                        {presetEditDraft?.id === pr.id ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={presetEditDraft.name}
                              onChange={(e) => setPresetEditDraft((d) => ({ ...d, name: e.target.value }))}
                              className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                            />
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              {['width_cm', 'height_cm', 'depth_cm', 'weight_kg'].map((k) => (
                                <input
                                  key={k}
                                  type="number"
                                  min="0"
                                  step={k === 'weight_kg' ? '0.001' : '0.1'}
                                  value={presetEditDraft[k]}
                                  onChange={(e) => setPresetEditDraft((d) => ({ ...d, [k]: e.target.value }))}
                                  className="px-2 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                  placeholder={k === 'weight_kg' ? 'kg' : 'cm'}
                                />
                              ))}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button type="button" disabled={presetSaving} onClick={handlePresetModalSaveEdit} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded-lg disabled:opacity-50">Salvar</button>
                              <button type="button" disabled={presetSaving} onClick={() => setPresetEditDraft(null)} className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 text-xs rounded-lg text-gray-700 dark:text-gray-200">Cancelar</button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-white">{pr.name}</p>
                              <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                {pr.width_cm} × {pr.height_cm} × {pr.depth_cm} cm · {pr.weight_kg} kg
                              </p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button
                                type="button"
                                onClick={() => setPresetEditDraft({
                                  id: pr.id,
                                  name: pr.name,
                                  width_cm: String(pr.width_cm),
                                  height_cm: String(pr.height_cm),
                                  depth_cm: String(pr.depth_cm),
                                  weight_kg: String(pr.weight_kg),
                                })}
                                className="px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePresetModalDelete(pr.id)}
                                disabled={presetSaving}
                                className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                                title="Excluir"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
              <button type="button" onClick={() => setPackagePresetsModalOpen(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-100 rounded-lg text-sm hover:bg-gray-300 dark:hover:bg-gray-500">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Model Import Modal */}
      {modelImportModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Importar de Anúncio Ativo</h3>
              <button onClick={() => setModelImportModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Selecione um anúncio ML ativo para criar o modelo:</p>
            <div className="flex-1 overflow-y-auto border dark:border-gray-700 rounded-lg min-h-0" style={{ maxHeight: '500px' }}>
              {items.filter(i => i.source === 'ml').length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Nenhum anúncio ML sincronizado. Sincronize primeiro na aba "Anúncios Ativos".</div>
              ) : items.filter(i => i.source === 'ml').map(item => (
                <button key={item.uid} onClick={async () => { await handleModelImportFromItem(item); setModelImportModal(null); }}
                  className="w-full text-left px-4 py-3 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-b dark:border-gray-700/50 transition-colors flex items-center gap-3">
                  {item.thumbnail && <img src={item.thumbnail} alt="" className="w-10 h-10 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 dark:text-white font-medium truncate">{item.title}</p>
                    <div className="flex items-center gap-2 text-[11px] text-gray-400">
                      <span>{item.ml_item_id}</span>
                      {item.sku && <span className="font-mono">SKU: {item.sku}</span>}
                      <span>{formatPrice(item.price)}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setModelImportModal(null)} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
