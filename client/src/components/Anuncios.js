import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search, Upload, RefreshCw, Link2, Unlink, Globe, ToggleLeft, ToggleRight,
  CheckCircle, AlertTriangle, Pause, Play, ExternalLink, Star, Award,
  Download, Send, X, ChevronDown, ChevronUp, ChevronRight, ChevronLeft, Edit3, Trash2, Copy, Package, Plus, MoreVertical, Image, Ruler, Info, GripVertical, Zap, Loader2, History, SlidersHorizontal
} from 'lucide-react';
import axios from 'axios';
import { useDebounce } from '../hooks/useDebounce';
import { useToast } from './Toast';
import { ModelVariationAccordionRow } from './ModelVariationAccordionRow';
import { InventoryAutocomplete } from './InventoryAutocomplete';

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

/** Mostra a aba «Mapeamento multi-marketplace» no modal de modelo. Reativada em M5. */
const SHOW_MODEL_MARKETPLACE_MAPPING_TAB = true;

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

const DEFAULT_MARKETPLACE_MAPPINGS = () => ({
  version: 1,
  canonical: { brand: '', model_name: '', material: '', color: '' },
  channels: {
    mercadolivre: { notes: '' },
    shopee: { category_id: '', category_name: '', brand_id: null, brand_name: '', attributes: {}, title_override: '', notes: '' },
    amazon: { product_type: '', browse_node: '', title_override: '', notes: '' },
    leroy_merlin: { category_id: '', notes: '' },
  },
});

function parseMarketplaceMappings(raw) {
  const d = DEFAULT_MARKETPLACE_MAPPINGS();
  if (raw == null || raw === '') return d;
  try {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || typeof o !== 'object') return d;
    return {
      version: o.version || 1,
      canonical: { ...d.canonical, ...(o.canonical || {}) },
      channels: {
        mercadolivre: { ...d.channels.mercadolivre, ...(o.channels?.mercadolivre || o.channels?.mercado_livre || {}) },
        shopee: { ...d.channels.shopee, ...(o.channels?.shopee || {}) },
        amazon: { ...d.channels.amazon, ...(o.channels?.amazon || {}) },
        leroy_merlin: { ...d.channels.leroy_merlin, ...(o.channels?.leroy_merlin || {}) },
      },
    };
  } catch {
    return d;
  }
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

/**
 * Picker de Marca da Shopee. A lista é fechada por categoria — a Shopee só
 * aceita marcas oficialmente cadastradas OU "Sem Marca" (brand_id=0). Por isso
 * não permitimos texto livre: o seller escolhe de uma lista filtrada por busca.
 */
function ShopeeBrandPicker({ accountId, categoryId, brandId, brandName, onPick, onClear }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !accountId || !categoryId) return;
    const tid = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await axios.get(`/api/shopee/categories/${categoryId}/brands`, { params: { accountId, search } });
        setItems(Array.isArray(r.data?.brands) ? r.data.brands : []);
      } catch (e) {
        setItems([]);
        setError(e.response?.data?.error || e.message);
      }
      setLoading(false);
    }, 260);
    return () => clearTimeout(tid);
  }, [open, accountId, categoryId, search]);

  const openPicker = () => {
    if (!categoryId) return;
    setSearch('');
    setOpen(true);
  };

  const pick = (b) => {
    onPick({ brand_id: b.brand_id, name: b.name });
    setOpen(false);
    setSearch('');
  };

  const hasPick = brandId != null && brandName;

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        Marca <span className="text-red-600 dark:text-red-400">*</span>
      </label>
      {!categoryId ? (
        <div className="w-full px-3 py-2 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40">
          Escolha a categoria Shopee acima para liberar a lista de marcas.
        </div>
      ) : hasPick ? (
        <div className="flex items-start gap-2 p-2 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{brandName}</p>
            <p className="text-[11px] font-mono text-emerald-800 dark:text-emerald-300">brand_id: {brandId}</p>
          </div>
          <button type="button" onClick={openPicker}
            className="text-xs px-2 py-1 rounded border border-emerald-400 text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40">
            Trocar
          </button>
          <button type="button" onClick={onClear}
            className="text-xs px-2 py-1 rounded text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button type="button" onClick={openPicker}
          className="w-full px-3 py-2 border border-dashed border-orange-400 dark:border-orange-700 rounded-lg text-sm text-orange-700 dark:text-orange-200 bg-white dark:bg-gray-800/40 hover:bg-orange-50 dark:hover:bg-orange-950/40 flex items-center justify-center gap-2">
          <Search className="w-4 h-4" /> Escolher marca Shopee
        </button>
      )}

      {open && (
        <div className="mt-2 rounded-lg border border-orange-300 dark:border-orange-700 bg-white dark:bg-gray-800 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-gray-400" />
            <input type="text" autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder='Buscar marca (ex.: "Single Light", "Ventax"…) ou deixe vazio para ver "Sem Marca"'
              className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            <button type="button" onClick={() => setOpen(false)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="max-h-56 overflow-auto border border-gray-100 dark:border-gray-700 rounded">
            {loading ? (
              <div className="p-3 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando marcas…</div>
            ) : error ? (
              <div className="p-3 text-xs space-y-1">
                <p className="text-red-700 dark:text-red-300 font-medium">Não foi possível listar as marcas.</p>
                <p className="text-red-600 dark:text-red-400 break-all">{error}</p>
                <p className="text-gray-500 dark:text-gray-400">Você pode mesmo assim usar "Sem Marca" — o sistema enviará brand_id=0.</p>
                <button type="button" onClick={() => pick({ brand_id: 0, name: 'Sem Marca' })}
                  className="mt-1 text-xs px-3 py-1.5 rounded bg-orange-600 hover:bg-orange-700 text-white">
                  Usar Sem Marca
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="p-3 text-xs text-gray-500">Nenhuma marca encontrada para "{search}".</div>
            ) : items.map((b) => (
              <button key={`${b.brand_id}-${b.name}`} type="button" onClick={() => pick(b)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-orange-50 dark:hover:bg-orange-950/30 border-b border-gray-100 dark:border-gray-700 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-gray-500 shrink-0 w-10">{b.brand_id}</span>
                  <span className="text-gray-800 dark:text-gray-200 truncate">{b.name}</span>
                </div>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            A Shopee só aceita marcas oficialmente cadastradas. Se sua marca (ex.: "Single Light") não aparece, registre-a no Seller Center primeiro ou use "Sem Marca".
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Ficha técnica Shopee: lista os atributos da categoria escolhida e permite
 * ao seller preencher valores. Suporta 2 modos:
 *
 *  • auto  — /get_attributes funcionou; mostramos inputs tipados (dropdown
 *            para DROP_DOWN/COMBO_BOX, texto para INT/FLOAT/STRING_TYPE).
 *  • manual — /get_attributes retornou 403 (API bloqueada pelo partner Shopee).
 *            O seller insere attribute_id + valor em linhas (add/remove).
 *            Os attribute_ids obrigatórios aparecem nos erros de publicação.
 */
function ShopeeAttributesBlock({ accountId, categoryId, value, onChange, autoOpenImport }) {
  const toast = useToast();
  const [attrs, setAttrs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('auto');
  const [error, setError] = useState(null);
  const [onlyMandatory, setOnlyMandatory] = useState(true);
  const [search, setSearch] = useState('');
  const [errorPaste, setErrorPaste] = useState('');
  const [errorPasteOpen, setErrorPasteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (autoOpenImport) setImportOpen(true);
  }, [autoOpenImport]);
  const [importRef, setImportRef] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importSuggestions, setImportSuggestions] = useState([]);
  const [importSuggestionsLoading, setImportSuggestionsLoading] = useState(false);
  const [pasteJsonOpen, setPasteJsonOpen] = useState(false);
  const [pasteJsonText, setPasteJsonText] = useState('');
  const [pasteJsonLoading, setPasteJsonLoading] = useState(false);

  // Salva um override manual de atributos para a categoria a partir de um JSON
  // copiado do DevTools do Seller Center Shopee. Após salvar, recarrega os
  // atributos para usar a lista oficial.
  const submitPasteJson = async () => {
    if (!pasteJsonText.trim()) { toast.error('Cole o JSON primeiro.'); return; }
    if (!categoryId) { toast.error('Selecione uma categoria primeiro.'); return; }
    setPasteJsonLoading(true);
    try {
      const r = await axios.post(`/api/shopee/categories/${categoryId}/attributes/override`, {
        raw: pasteJsonText,
      });
      toast.success(`${r.data.total} atributo(s) salvos — ${r.data.with_value_ids} com value_ids oficiais.`);
      setPasteJsonText('');
      setPasteJsonOpen(false);
      // Recarrega a lista de atributos pra pegar o override recém salvo.
      try {
        const fresh = await axios.get(`/api/shopee/categories/${categoryId}/attributes`, { params: { accountId } });
        setAttrs(Array.isArray(fresh.data?.attributes) ? fresh.data.attributes : []);
        setMode('auto');
      } catch (_) {}
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toast.error(`Falha ao processar JSON: ${msg}`, { duration: 15000 });
    } finally {
      setPasteJsonLoading(false);
    }
  };

  // Importa atributos de um anúncio Shopee já publicado (item_id ou URL).
  // Necessário porque o get_attribute_tree pode estar bloqueado, e get_item_base_info
  // com need_attribute=true retorna os value_ids oficiais que a Shopee aceita.
  const importFromItem = async (ref) => {
    const r = (ref || importRef).trim();
    if (!r) { toast.error('Informe o item_id ou cole a URL do anúncio Shopee.'); return; }
    setImportLoading(true);
    try {
      const resp = await axios.get(`/api/shopee/items/${encodeURIComponent(r)}/attributes`, { params: { accountId } });
      const imported = Array.isArray(resp.data?.attributes) ? resp.data.attributes : [];
      if (!imported.length) {
        toast.info('O anúncio encontrado não tinha ficha técnica preenchida.');
      } else {
        const current = { ...(value || {}) };
        let added = 0;
        for (const a of imported) {
          if (a.value_id != null && a.value_id !== 0) {
            current[String(a.attribute_id)] = {
              value_id: a.value_id,
              original_value_name: a.original_value_name || a.display_value_name || '',
              _suggested_name: a.name,
            };
            added++;
          } else if (a.original_value_name || a.display_value_name) {
            current[String(a.attribute_id)] = {
              original_value_name: a.original_value_name || a.display_value_name,
              _suggested_name: a.name,
            };
            added++;
          }
        }
        onChange(current);
        const persisted = resp.data?.persisted;
        if (persisted && persisted.defaults_upserted > 0) {
          toast.success(`${added} atributo(s) importado(s) e salvos como padrão desta categoria. Próximos modelos vão abrir já preenchidos.`, { duration: 6000 });
        } else {
          toast.success(`${added} atributo(s) importado(s) com value_ids oficiais da Shopee.`);
        }
        setImportOpen(false);
        setImportRef('');
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      toast.error(`Falha ao importar: ${msg}`);
    } finally {
      setImportLoading(false);
    }
  };

  // Quando abrir a modal de import, carrega sugestões da própria loja na categoria.
  useEffect(() => {
    if (!importOpen || !accountId) return;
    let cancelled = false;
    (async () => {
      setImportSuggestionsLoading(true);
      try {
        const r = await axios.get('/api/shopee/items/by-category', {
          params: { accountId, categoryId, pageSize: 50 },
        });
        if (cancelled) return;
        setImportSuggestions(Array.isArray(r.data?.items) ? r.data.items : []);
      } catch {
        if (!cancelled) setImportSuggestions([]);
      } finally {
        if (!cancelled) setImportSuggestionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [importOpen, accountId, categoryId]);

  // Extrai pares (attribute_id, name) de uma mensagem de erro crua da Shopee.
  // Aceita formatos como:
  //   "Attribute is mandatory: id: 102385, name: Electrical Cables"
  //   '"msg":"Attribute is mandatory: id: 100408, name: Connection Type"'
  //   'Attribute "Electrical Cables" is mandatory required'
  const parseShopeeErrorMessage = (raw) => {
    if (!raw) return [];
    const found = new Map();
    const reIdName = /id[:\s]+(\d+)\s*,\s*name[:\s]+([^"}\n]+?)(?=["}\n,]|$)/gi;
    let m;
    while ((m = reIdName.exec(raw)) !== null) {
      const id = m[1].trim();
      const name = m[2].trim();
      if (id && !found.has(id)) found.set(id, name);
    }
    // Fallback: capturar "Attribute "Xxx" is mandatory" sem ID numérico — nesse
    // caso criamos um ID negativo temporário só pra o seller saber que falta.
    const reNameOnly = /Attribute\s+"([^"]+)"\s+is\s+mandatory/gi;
    while ((m = reNameOnly.exec(raw)) !== null) {
      const name = m[1].trim();
      const hasId = [...found.values()].some(v => v.toLowerCase() === name.toLowerCase());
      if (!hasId && name) {
        // Placeholder — o seller precisa descobrir o ID. Mostramos o nome mesmo assim.
        const placeholder = `pendente_${name.toLowerCase().replace(/\s+/g, '_')}`;
        if (!found.has(placeholder)) found.set(placeholder, name);
      }
    }
    return Array.from(found.entries()).map(([id, name]) => ({ attribute_id: id, name }));
  };

  const applyErrorPaste = () => {
    const parsed = parseShopeeErrorMessage(errorPaste);
    if (!parsed.length) {
      toast.error('Não consegui identificar IDs de atributo nessa mensagem. Cole o "debug_message" completo do erro.');
      return;
    }
    const current = { ...(value || {}) };
    let added = 0;
    for (const p of parsed) {
      // Só adiciona IDs numéricos (ignora os placeholders sem ID).
      if (!/^\d+$/.test(p.attribute_id)) continue;
      if (!current[p.attribute_id]) {
        current[p.attribute_id] = { original_value_name: '', _suggested_name: p.name };
        added++;
      }
    }
    if (added === 0) {
      toast.info('Todos os IDs já estavam na lista.');
    } else {
      toast.success(`${added} atributo(s) adicionado(s). Preencha os valores e salve.`);
      setErrorPaste('');
      setErrorPasteOpen(false);
    }
    onChange(current);
  };

  useEffect(() => {
    if (!accountId || !categoryId) {
      setAttrs([]); setMode('auto'); setError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await axios.get(`/api/shopee/categories/${categoryId}/attributes`, { params: { accountId } });
        if (cancelled) return;
        const list = Array.isArray(r.data?.attributes) ? r.data.attributes : [];
        setAttrs(list);
        setMode('auto');
        // Pré-preenchimento a partir dos defaults salvos pela categoria (vêm
        // do último import/merge). Só preenche campos VAZIOS — se o seller
        // já configurou algo no modelo, respeita a escolha dele.
        const currentValue = value || {};
        const prefill = {};
        for (const a of list) {
          const cur = currentValue[String(a.attribute_id)];
          const hasVal = cur && (cur.value_id != null || cur.original_value_name);
          if (hasVal) continue;
          if (a.default && (a.default.value_id != null || a.default.original_value_name)) {
            prefill[String(a.attribute_id)] = {
              ...(a.default.value_id != null ? { value_id: a.default.value_id } : {}),
              ...(a.default.original_value_name ? { original_value_name: a.default.original_value_name } : {}),
              ...(a.default.value_unit ? { value_unit: a.default.value_unit } : {}),
              _suggested_name: a.default.display_value_name || a.default.original_value_name || a.name,
              _from_category_default: true,
            };
          }
        }
        if (Object.keys(prefill).length > 0) {
          onChange({ ...currentValue, ...prefill });
        }
      } catch (e) {
        if (cancelled) return;
        const blocked = e.response?.status === 424 || e.response?.data?.error === 'blocked';
        setError({
          blocked,
          message: e.response?.data?.message || e.response?.data?.error || e.message,
        });
        setMode(blocked ? 'manual' : 'manual');
        setAttrs([]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, categoryId]);

  const updateAttr = (attrId, patch) => {
    const current = { ...(value || {}) };
    const prev = current[String(attrId)] || {};
    const merged = { ...prev, ...patch };
    // Se o usuário limpou tudo, remove a entrada.
    if (!merged.original_value_name && merged.value_id == null) {
      delete current[String(attrId)];
    } else {
      current[String(attrId)] = merged;
    }
    onChange(current);
  };

  const removeAttr = (attrId) => {
    const current = { ...(value || {}) };
    delete current[String(attrId)];
    onChange(current);
  };

  // Mescla atributos retornados pela API com IDs que o seller já configurou
  // (ou que foram pré-preenchidos pelo erro de publicação). Assim nenhum ID
  // fica invisível mesmo se a API Shopee não retornar aquele atributo.
  const attrsById = new Map(attrs.map(a => [String(a.attribute_id), a]));
  for (const [idStr, v] of Object.entries(value || {})) {
    if (!attrsById.has(idStr)) {
      attrsById.set(idStr, {
        attribute_id: parseInt(idStr, 10),
        name: v._suggested_name || `Atributo ${idStr}`,
        is_mandatory: !!v._suggested_name,
        input_type: 'TEXT_FILED',
        values: [],
        _synthetic: true,
      });
    }
  }
  const mergedAttrs = Array.from(attrsById.values());
  const filtered = mergedAttrs.filter(a => {
    if (onlyMandatory && !a.is_mandatory) return false;
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return a.name.toLowerCase().includes(s) || String(a.attribute_id).includes(s);
  });

  if (!categoryId) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 p-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Ficha técnica Shopee</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">Escolha a categoria Shopee acima para ver os atributos obrigatórios.</p>
      </div>
    );
  }

  const filledCount = Object.keys(value || {}).length;
  const mandatoryCount = mergedAttrs.filter(a => a.is_mandatory).length;
  const manualEntries = Object.entries(value || {});

  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">Ficha técnica Shopee</p>
          <p className="text-[11px] text-gray-600 dark:text-gray-400">
            {mode === 'auto'
              ? <>Atributos obrigatórios da categoria Shopee. Preenchidos: <span className="font-mono">{filledCount}</span> / <span className="font-mono">{mandatoryCount}</span> obrigatórios.</>
              : <>Modo manual — o partner Shopee do miti não tem permissão "Product Info". Informe os atributos manualmente (os IDs aparecem nas mensagens de erro ao publicar).</>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="px-2 py-1 rounded bg-orange-500 hover:bg-orange-600 text-white text-[11px] font-medium flex items-center gap-1"
            title="Copiar a ficha técnica (com value_ids oficiais) de um anúncio Shopee já publicado"
          >
            <Copy className="w-3 h-3" /> Importar de anúncio Shopee
          </button>
          {mode === 'auto' && attrs.length > 0 && (
            <label className="flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-400">
              <input type="checkbox" checked={onlyMandatory} onChange={(e) => setOnlyMandatory(e.target.checked)} />
              Só obrigatórios
            </label>
          )}
        </div>
      </div>

      {importOpen && (
        <div className="rounded border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-900/20 p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-orange-900 dark:text-orange-200">Importar ficha técnica de um anúncio Shopee existente</p>
              <p className="text-[11px] text-orange-800 dark:text-orange-300">
                Cole a URL do anúncio Shopee (ex.: <code>https://shopee.com.br/…-i.1234.5678</code>) <strong>ou</strong> só o item_id.
                A loja conectada precisa ser dona desse anúncio (é seu próprio item já publicado nesta categoria).
              </p>
              <div className="rounded border border-orange-300 bg-white/60 dark:bg-orange-950/30 p-2 text-[11px] text-orange-900 dark:text-orange-200 space-y-1">
                <p className="font-semibold">É o seu 1º anúncio nesta categoria?</p>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>Acesse o <a href="https://banxa.shopee.com.br/portal/product/list" target="_blank" rel="noopener noreferrer" className="underline font-medium">Seller Center Shopee</a> no navegador.</li>
                  <li>Crie e publique 1 produto simples nesta mesma categoria preenchendo os atributos obrigatórios manualmente.</li>
                  <li>Volte aqui e importe por URL (ou escolha na lista abaixo) — os value_ids oficiais vão ser copiados pro miti.</li>
                  <li>Pronto: todos os próximos anúncios dessa categoria vão funcionar direto daqui.</li>
                </ol>
              </div>
            </div>
            <button type="button" onClick={() => { setImportOpen(false); setImportRef(''); }}
              className="text-orange-900 dark:text-orange-200 hover:opacity-70"><X className="w-4 h-4" /></button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={importRef}
              onChange={(e) => setImportRef(e.target.value)}
              placeholder="URL do anúncio Shopee ou item_id"
              className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              onKeyDown={(e) => { if (e.key === 'Enter') importFromItem(); }}
            />
            <button
              type="button"
              disabled={importLoading || !importRef.trim()}
              onClick={() => importFromItem()}
              className="px-3 py-1.5 rounded bg-orange-600 text-white text-xs font-semibold hover:bg-orange-700 disabled:opacity-50 flex items-center gap-1"
            >
              {importLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Importar
            </button>
          </div>
          <div className="pt-1 border-t border-orange-300 dark:border-orange-700">
            <button
              type="button"
              onClick={() => setPasteJsonOpen(v => !v)}
              className="text-[11px] font-medium text-orange-900 dark:text-orange-200 hover:underline flex items-center gap-1"
            >
              {pasteJsonOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Alternativa avançada: colar JSON do Seller Center (DevTools)
            </button>
            {pasteJsonOpen && (
              <div className="mt-2 space-y-2 rounded border border-orange-300 dark:border-orange-700 bg-white/70 dark:bg-gray-800/60 p-2">
                <ol className="list-decimal pl-4 text-[11px] text-orange-900 dark:text-orange-200 space-y-0.5">
                  <li>Abra <a href="https://banxa.shopee.com.br/portal/product/new" target="_blank" rel="noopener noreferrer" className="underline font-medium">Seller Center → Adicionar Produto</a> e escolha a mesma categoria deste modelo.</li>
                  <li>Aperte <kbd className="px-1 bg-gray-200 dark:bg-gray-700 rounded font-mono text-[10px]">F12</kbd> para abrir DevTools → aba <strong>Network</strong> → filtre por <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">attribute</code>.</li>
                  <li>Role ou clique em qualquer dropdown da Shopee; alguma requisição com "get_attribute" aparece. Clique nela → aba <strong>Response</strong>.</li>
                  <li>Selecione todo o JSON (Ctrl+A), copie (Ctrl+C) e cole aqui embaixo.</li>
                </ol>
                <textarea
                  value={pasteJsonText}
                  onChange={(e) => setPasteJsonText(e.target.value)}
                  placeholder='Cole aqui o JSON da resposta (ex.: {"data":{"attribute_list":[...]}})'
                  rows={6}
                  className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-[11px] font-mono bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                />
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => { setPasteJsonText(''); setPasteJsonOpen(false); }}
                    className="px-2 py-1 text-[11px] text-orange-900 dark:text-orange-200 hover:underline">Cancelar</button>
                  <button type="button" disabled={pasteJsonLoading || !pasteJsonText.trim()} onClick={submitPasteJson}
                    className="px-3 py-1 rounded bg-orange-600 hover:bg-orange-700 text-white text-[11px] font-semibold disabled:opacity-50 flex items-center gap-1">
                    {pasteJsonLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                    Salvar ficha da categoria
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="pt-1">
            <p className="text-[11px] font-medium text-orange-900 dark:text-orange-200 mb-1">Ou escolha um anúncio seu desta categoria:</p>
            {importSuggestionsLoading ? (
              <div className="flex items-center gap-1 text-[11px] text-orange-800"><Loader2 className="w-3 h-3 animate-spin" /> buscando…</div>
            ) : importSuggestions.length === 0 ? (
              <p className="text-[11px] text-orange-800/80 dark:text-orange-300/80">Nenhum anúncio ativo da sua loja nessa categoria.</p>
            ) : (
              <div className="max-h-28 overflow-auto space-y-1">
                {importSuggestions.map(it => (
                  <button
                    key={it.item_id}
                    type="button"
                    onClick={() => importFromItem(String(it.item_id))}
                    disabled={importLoading}
                    className="w-full text-left px-2 py-1 rounded bg-white dark:bg-gray-800 border border-orange-200 dark:border-orange-800 hover:bg-orange-100 dark:hover:bg-orange-900/30 text-[11px] flex items-center justify-between gap-2 disabled:opacity-50"
                  >
                    <span className="truncate">{it.item_name}</span>
                    <span className="font-mono text-[10px] text-gray-500 shrink-0">#{it.item_id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando ficha técnica…</div>
      )}

      {!loading && mode === 'auto' && (
        <>
          {mergedAttrs.length === 0 ? (
            <div className="rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2 text-[11px] text-amber-900 dark:text-amber-200">
              <p>A Shopee não retornou atributos para essa categoria. Isso pode ser:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Permissão "Product Info" do app Shopee não aprovada.</li>
                <li>Categoria realmente sem atributos obrigatórios (raro).</li>
              </ul>
              <p className="pt-1">Tente publicar mesmo assim — se a Shopee reclamar algum atributo obrigatório, o miti vai <strong>pré-popular o ID aqui automaticamente</strong> pra você só preencher o valor.</p>
              <button type="button" onClick={() => setMode('manual')}
                className="mt-1 px-2 py-1 rounded bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700">
                Configurar manualmente
              </button>
            </div>
          ) : (
            <>
              {mergedAttrs.some(a => a.from_static_catalog) && (
                <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-100/70 dark:bg-amber-900/30 p-2.5 space-y-1.5">
                  <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Atenção: atributos "Sugerido" não têm o value_id oficial da Shopee
                  </p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300">
                    Como a API Shopee está bloqueada para este app, o miti está mostrando as opções comuns dessa categoria, mas <strong>sem o ID numérico oficial</strong>. Para atributos de dropdown fechado (ex.: "Connection Type"), a Shopee rejeita a publicação com "value cannot be customized".
                  </p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-300">
                    <strong>Solução:</strong> clique em <em>"Importar de anúncio Shopee"</em> acima e cole o link de um anúncio seu já publicado nessa categoria — o miti copia os value_ids corretos. Se for o seu primeiro item, publique pelo Seller Center web uma vez e depois use a importação aqui pros próximos.
                  </p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Search className="w-4 h-4 text-gray-400" />
                <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar atributo…"
                  className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[420px] overflow-auto pr-1">
                {filtered.map((a) => {
                  const cur = value?.[String(a.attribute_id)] || {};
                  const hasOptions = a.values && a.values.length > 0;
                  // Detecta se os options são do catálogo manual (sem value_id real).
                  // Nesse caso, usamos o original_name como chave do select (a
                  // Shopee casa pelo nome em inglês) em vez do value_id=0.
                  const catalogMode = hasOptions && a.values.every(v => !v.value_id);
                  const selectedKey = catalogMode
                    ? (cur.original_value_name || '')
                    : (cur.value_id != null ? String(cur.value_id) : '');
                  return (
                    <div key={a.attribute_id} className="rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-800/60 p-2">
                      <div className="flex items-start justify-between gap-1 mb-1">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate flex items-center gap-1.5">
                            {a.name}
                            {a.is_mandatory && <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300">Obrigatório</span>}
                            {a.from_static_catalog && <span className="text-[9px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300" title="Opções curadas pelo miti porque a API Shopee não está respondendo">Sugerido</span>}
                            {catalogMode && cur.original_value_name && (cur.value_id == null || cur.value_id === 0) && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300" title="Dropdown fechado: Shopee vai rejeitar publish sem o value_id oficial">⚠ value_id faltando</span>
                            )}
                          </p>
                          <p className="text-[10px] font-mono text-gray-400">id {a.attribute_id} · {a.input_type || '—'}</p>
                        </div>
                      </div>
                      {hasOptions ? (
                        <div className="space-y-1">
                          <select value={selectedKey}
                            onChange={(e) => {
                              const key = e.target.value;
                              if (!key) { removeAttr(a.attribute_id); return; }
                              if (catalogMode) {
                                const match = a.values.find(v => (v.original_name || v.name) === key);
                                updateAttr(a.attribute_id, {
                                  value_id: null,
                                  original_value_name: match?.original_name || match?.name || key,
                                });
                              } else {
                                const match = a.values.find(v => String(v.value_id) === key);
                                updateAttr(a.attribute_id, {
                                  value_id: Number(key),
                                  original_value_name: match?.original_name || match?.name || '',
                                });
                              }
                            }}
                            className="w-full px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                            <option value="">— Selecione —</option>
                            {a.values.map((v, idx) => {
                              const key = catalogMode ? (v.original_name || v.name) : String(v.value_id);
                              const label = catalogMode && v.name !== v.original_name && v.original_name
                                ? `${v.name} (${v.original_name})`
                                : v.name;
                              return <option key={`${a.attribute_id}-${idx}`} value={key}>{label}</option>;
                            })}
                          </select>
                          {catalogMode && cur.original_value_name && (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                value={cur.value_id ?? ''}
                                onChange={(e) => {
                                  const v = e.target.value.trim();
                                  updateAttr(a.attribute_id, { value_id: v ? Number(v) : null });
                                }}
                                placeholder="value_id oficial (opcional)"
                                className="flex-1 px-1.5 py-0.5 border dark:border-gray-600 rounded text-[10px] bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono"
                                title="Se você souber o value_id oficial da Shopee para esta opção, informe aqui. Sem ele, dropdowns fechados podem ser rejeitados."
                              />
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex gap-1">
                          <input type="text" value={cur.original_value_name || ''}
                            onChange={(e) => updateAttr(a.attribute_id, { value_id: null, original_value_name: e.target.value })}
                            placeholder="Valor"
                            className="flex-1 px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                          {a.attribute_unit && a.attribute_unit.length > 0 && (
                            <select value={cur.value_unit || ''} onChange={(e) => updateAttr(a.attribute_id, { value_unit: e.target.value })}
                              className="px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                              <option value="">—</option>
                              {a.attribute_unit.map(u => (<option key={u} value={u}>{u}</option>))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {!loading && mode === 'manual' && (
        <>
          {error?.blocked && (
            <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-100 dark:bg-amber-900/30 p-2 text-[11px] text-amber-900 dark:text-amber-100 space-y-1.5">
              <p className="font-medium">A Shopee não retornou a lista de atributos dessa categoria.</p>
              <p className="whitespace-pre-wrap break-words">{error.message}</p>
              <p className="text-[10px] opacity-80">
                Dica prática: <strong>tente publicar o modelo normalmente</strong>. Quando a Shopee recusar por atributo obrigatório, o miti abre essa aba aqui com os IDs já prontos — você só precisa preencher o valor e tentar de novo.
              </p>
            </div>
          )}
          {error && !error.blocked && (
            <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-[11px] text-red-700 dark:text-red-300 break-words">
              Erro: {error.message}
            </div>
          )}

          {/* Atalho: colar mensagem de erro da Shopee pra extrair IDs de atributos obrigatórios */}
          <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-2">
            <button type="button"
              onClick={() => setErrorPasteOpen(!errorPasteOpen)}
              className="w-full flex items-center justify-between text-[11px] font-medium text-blue-800 dark:text-blue-200">
              <span className="flex items-center gap-1.5">
                <ChevronRight className={`w-3 h-3 transition-transform ${errorPasteOpen ? 'rotate-90' : ''}`} />
                Colar mensagem de erro da Shopee para extrair IDs automaticamente
              </span>
              <span className="text-[10px] opacity-70">(atalho)</span>
            </button>
            {errorPasteOpen && (
              <div className="mt-2 space-y-1.5">
                <p className="text-[10px] text-blue-900 dark:text-blue-100 leading-relaxed">
                  Cole aqui o <span className="font-mono">debug_message</span> completo de uma tentativa de publicação que falhou.
                  O miti vai extrair automaticamente os <span className="font-mono">attribute_id</span> e nomes obrigatórios e criar as linhas abaixo.
                </p>
                <textarea value={errorPaste} onChange={(e) => setErrorPaste(e.target.value)}
                  rows={4}
                  placeholder='Ex.: Failed to create product : validation: [Rule Type: classification.attribute.mandatory, Detail: {"code":100010237,"msg":"Attribute is mandatory: id: 102385, name: Electrical Cables"}] ...'
                  className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-[11px] bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                <div className="flex gap-1.5">
                  <button type="button" onClick={applyErrorPaste}
                    className="px-2 py-1 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700">
                    Extrair IDs e adicionar
                  </button>
                  <button type="button" onClick={() => { setErrorPaste(''); setErrorPasteOpen(false); }}
                    className="px-2 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 text-[11px] hover:bg-blue-100 dark:hover:bg-blue-900/30">
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-1.5 max-h-[360px] overflow-auto pr-1">
            {manualEntries.length === 0 ? (
              <p className="text-xs text-gray-500">Nenhum atributo configurado ainda. Clique em "Adicionar atributo".</p>
            ) : manualEntries.map(([attrIdStr, v]) => (
              <div key={attrIdStr} className="rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-800/60 p-2">
                {v._suggested_name && (
                  <p className="text-[11px] font-medium text-amber-900 dark:text-amber-200 mb-1 flex items-center gap-1">
                    <span className="text-[9px] px-1 py-0.5 rounded bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300">Obrigatório</span>
                    {v._suggested_name}
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  <input type="number" value={attrIdStr}
                    onChange={(e) => {
                      const newId = e.target.value;
                      const current = { ...(value || {}) };
                      delete current[attrIdStr];
                      if (newId) current[newId] = v;
                      onChange(current);
                    }}
                    placeholder="attribute_id"
                    title="ID oficial da Shopee para esse atributo"
                    className="w-28 px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                  <input type="text" value={v.original_value_name || ''}
                    onChange={(e) => updateAttr(parseInt(attrIdStr, 10), { value_id: v.value_id ?? null, original_value_name: e.target.value, _suggested_name: v._suggested_name })}
                    placeholder={v._suggested_name ? `Valor de "${v._suggested_name}"` : 'Valor (ex.: "Plástico", "2 metros", "Não")'}
                    className="flex-1 px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                  <input type="number" value={v.value_id ?? ''}
                    onChange={(e) => updateAttr(parseInt(attrIdStr, 10), { value_id: e.target.value === '' ? null : Number(e.target.value), original_value_name: v.original_value_name || '', _suggested_name: v._suggested_name })}
                    placeholder="value_id"
                    title="Opcional: ID oficial do valor na Shopee. Se deixado vazio, mandamos só o texto."
                    className="w-24 px-2 py-1 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                  <button type="button" onClick={() => removeAttr(parseInt(attrIdStr, 10))}
                    className="p-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => {
            const existing = new Set(Object.keys(value || {}));
            let next = 100001;
            while (existing.has(String(next))) next++;
            updateAttr(next, { original_value_name: '' });
          }}
            className="text-xs px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white inline-flex items-center gap-1.5">
            + Adicionar atributo manual
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Bloco da aba Mapeamento dedicado à Shopee. Inclui autocomplete de categoria
 * alimentado por /api/shopee/categories (árvore oficial da Shopee por loja).
 * Recebe:
 *  - channel: objeto {category_id, category_name, title_override, notes, ...}
 *  - mlCategoryName: nome humano da categoria ML (usado como sugestão de busca)
 *  - shopeeAccounts: lista de contas conectadas
 *  - onChange(patch): mescla patch em channel
 */
function ShopeeMappingBlock({ channel, mlCategoryName, mlCategoryId, shopeeAccounts, onChange }) {
  const [accountId, setAccountId] = useState(shopeeAccounts[0]?.id || '');
  const [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [manualId, setManualId] = useState('');

  useEffect(() => {
    if (!accountId && shopeeAccounts.length > 0) setAccountId(shopeeAccounts[0].id);
  }, [shopeeAccounts, accountId]);

  useEffect(() => {
    if (!showPicker || !accountId) return;
    const tid = setTimeout(async () => {
      setLoading(true);
      setApiError(null);
      try {
        const r = await axios.get('/api/shopee/categories', { params: { accountId, search } });
        setSuggestions(Array.isArray(r.data?.items) ? r.data.items : []);
      } catch (e) {
        setSuggestions([]);
        setApiError(e.response?.data || { error: e.message });
      }
      setLoading(false);
    }, 260);
    return () => clearTimeout(tid);
  }, [search, accountId, showPicker]);

  const applyCategory = (cat) => {
    onChange({ category_id: cat.category_id, category_name: cat.path || cat.display_name || cat.name });
    setShowPicker(false);
    setSearch('');
  };

  const openPicker = () => {
    if (!accountId) return;
    const hint = mlCategoryName ? mlCategoryName.split('>').pop().trim() : '';
    setSearch(hint);
    setShowPicker(true);
  };

  return (
    <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/20 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <img src="/shopee.png" alt="" className="w-6 h-6 rounded-sm object-contain" />
        <span className="font-semibold text-gray-900 dark:text-white">Shopee</span>
      </div>

      {shopeeAccounts.length === 0 ? (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-2 text-xs text-amber-800 dark:text-amber-200">
          Conecte uma conta Shopee para poder escolher a categoria direto da árvore oficial.
        </div>
      ) : (
        <div>
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Conta usada para listar categorias</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
            className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
            {shopeeAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>{acc.name || `Shopee ${acc.id}`}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Categoria na Shopee</label>
        {channel.category_id ? (
          <div className="flex items-start gap-2 p-2 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-emerald-800 dark:text-emerald-300">{channel.category_id}</p>
              {channel.category_name && <p className="text-xs text-gray-700 dark:text-gray-200 mt-0.5">{channel.category_name}</p>}
            </div>
            <button type="button" onClick={openPicker} disabled={!accountId}
              className="text-xs px-2 py-1 rounded border border-emerald-400 text-emerald-700 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-40">
              Trocar
            </button>
            <button type="button" onClick={() => onChange({ category_id: '', category_name: '' })}
              className="text-xs px-2 py-1 rounded text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button type="button" onClick={openPicker} disabled={!accountId}
            className="w-full px-3 py-2 border border-dashed border-orange-400 dark:border-orange-700 rounded-lg text-sm text-orange-700 dark:text-orange-200 bg-white dark:bg-gray-800/40 hover:bg-orange-50 dark:hover:bg-orange-950/40 flex items-center justify-center gap-2 disabled:opacity-40">
            <Search className="w-4 h-4" /> Escolher categoria Shopee
          </button>
        )}
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
          A Shopee tem a própria árvore de categorias. O miti busca a árvore da loja conectada e sugere uma pelo nome da categoria que você escolheu no Mercado Livre.
          {mlCategoryName && <> Categoria ML atual: <span className="italic">{mlCategoryName}</span>.</>}
        </p>
      </div>

      {showPicker && (
        <div className="rounded-lg border border-orange-300 dark:border-orange-700 bg-white dark:bg-gray-800 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-gray-400" />
            <input type="text" autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Digite parte do nome (ex.: luminária, luminaria de teto)…"
              className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            <button type="button" onClick={() => setShowPicker(false)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="max-h-52 overflow-auto border border-gray-100 dark:border-gray-700 rounded">
            {loading ? (
              <div className="p-3 text-xs text-gray-500 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando categorias Shopee…</div>
            ) : apiError ? (
              <div className="p-3 text-xs space-y-1">
                <p className="text-red-700 dark:text-red-300 font-medium">A Shopee recusou a requisição.</p>
                <p className="text-red-600 dark:text-red-400 break-all">
                  {apiError.error || 'Erro desconhecido'}{apiError.shopee_error && <span className="font-mono ml-1">({apiError.shopee_error})</span>}
                </p>
                {apiError.hint && <p className="text-gray-500 dark:text-gray-400">{apiError.hint}</p>}
                {apiError.request_id && <p className="text-[10px] text-gray-400 font-mono">request_id: {apiError.request_id}</p>}
              </div>
            ) : suggestions.length === 0 ? (
              <div className="p-3 text-xs text-gray-500">Nenhuma categoria encontrada para "{search}".</div>
            ) : suggestions.map((cat) => (
              <button key={cat.category_id} type="button" onClick={() => applyCategory(cat)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-orange-50 dark:hover:bg-orange-950/30 border-b border-gray-100 dark:border-gray-700 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-gray-500 shrink-0">{cat.category_id}</span>
                  <span className="text-gray-800 dark:text-gray-200 truncate">{cat.path || cat.display_name || cat.name}</span>
                </div>
              </button>
            ))}
          </div>

          {/* Entrada manual como fallback: abre a Shopee em nova aba e permite colar o ID */}
          <div className="pt-2 border-t border-gray-100 dark:border-gray-700 space-y-1.5">
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              Prefere digitar manualmente? Abra a árvore da Shopee e cole o ID aqui.
              {' '}
              <a href="https://seller.shopee.com.br" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">Abrir Seller Center</a>
            </p>
            <div className="flex gap-2">
              <input type="text" value={manualId} onChange={(e) => setManualId(e.target.value.replace(/\D/g, ''))}
                placeholder="ID da categoria (ex.: 100053)"
                className="flex-1 px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
              <button type="button" disabled={!manualId}
                onClick={() => { applyCategory({ category_id: manualId, path: '', display_name: `Categoria ${manualId}` }); setManualId(''); }}
                className="px-3 py-1.5 text-xs font-medium rounded bg-orange-600 hover:bg-orange-700 disabled:bg-orange-300 text-white">
                Usar
              </button>
            </div>
          </div>
        </div>
      )}

      <ShopeeBrandPicker
        accountId={accountId}
        categoryId={channel.category_id}
        brandId={channel.brand_id}
        brandName={channel.brand_name}
        onPick={(b) => onChange({ brand_id: b.brand_id, brand_name: b.name })}
        onClear={() => onChange({ brand_id: null, brand_name: '' })}
      />

      <ShopeeAttributesBlock
        accountId={accountId}
        categoryId={channel.category_id}
        value={channel.attributes || {}}
        onChange={(attrs) => onChange({ attributes: attrs })}
      />

      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Título alternativo (opcional)</label>
        <input type="text" value={channel.title_override || ''}
          onChange={(e) => onChange({ title_override: e.target.value })}
          placeholder="Se preenchido, será usado só na Shopee. Senão, usa o título do modelo."
          className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Observações internas</label>
        <textarea rows={2} value={channel.notes || ''}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Anotações só para a sua equipe (não são enviadas à Shopee)"
          className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
      </div>
    </div>
  );
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
  // C2 — modal de ajuste de faixa fictícia. `mode='single'` edita um único
  // config (recebe o item); `mode='bulk'` aplica para uma lista de items
  // pré-selecionados (os que têm config_id).
  const [rangeModal, setRangeModal] = useState(null);
  const [rangeForm, setRangeForm] = useState({ min: '', max: '', saving: false });
  // D2 — modal "detalhes da divergência" aberto pelo badge Divergente.
  const [divergenceModal, setDivergenceModal] = useState(null);
  // D5 — modal "histórico de estoque".
  const [historyModal, setHistoryModal] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pushingAll, setPushingAll] = useState(false);
  const [inventory, setInventory] = useState([]);
  const [filterMarketplace, setFilterMarketplace] = useState('all');
  const [filterAccount, setFilterAccount] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all'); // 'all'|'active'|'paused'|'closed'
  const [filterLinked, setFilterLinked] = useState('all'); // 'all'|'linked'|'unlinked'
  const [filterHasStock, setFilterHasStock] = useState('all'); // 'all'|'yes'|'no'
  const [filterDivergence, setFilterDivergence] = useState(false);
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  // Totais e paginação devolvidos pelo /api/ad-items (server-side).
  const [itemsTotal, setItemsTotal] = useState(0);
  const [itemsTotalPages, setItemsTotalPages] = useState(1);
  const [itemsTotals, setItemsTotals] = useState({ ml: 0, shopee: 0 });
  const debouncedSearch = useDebounce(search, 400);

  // selectedItems: Map<key, item> — o valor armazena uma referência ao item da
  // página atual quando ele é marcado, suficiente para executar ações em massa
  // sem precisar reabrir cada página para recolher o objeto.
  const [selectedItems, setSelectedItems] = useState(new Map());
  const [importing, setImporting] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(null); // 'pause'|'activate'|'link'|'push'|'refresh'
  // UX — menu consolidado de sincronização e filtros colapsáveis, para manter
  // o topo da tela mais discreto (pedido do usuário).
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const syncMenuRef = useRef(null);
  useEffect(() => {
    if (!syncMenuOpen) return;
    const handler = (e) => {
      if (syncMenuRef.current && !syncMenuRef.current.contains(e.target)) setSyncMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [syncMenuOpen]);

  // Estado legado dos templates ML foi removido: a aba "Modelos" agora usa exclusivamente
  // ad_models (source única de verdade).

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
  const [multiPublishModal, setMultiPublishModal] = useState(null);
  const [multiPublishRunning, setMultiPublishRunning] = useState(false);
  const [multiPublishResults, setMultiPublishResults] = useState(null);
  const [modelPublishing, setModelPublishing] = useState(false);
  const [bulkPublishModal, setBulkPublishModal] = useState(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [modelImportModal, setModelImportModal] = useState(null);
  const [importByIdModal, setImportByIdModal] = useState(null);
  const [importByIdLoading, setImportByIdLoading] = useState(false);
  const [mediaLibraryModal, setMediaLibraryModal] = useState(null);
  const [mediaLibraryItems, setMediaLibraryItems] = useState([]);
  const [mediaLibraryLoading, setMediaLibraryLoading] = useState(false);
  const [mediaLibrarySearch, setMediaLibrarySearch] = useState('');
  const [mediaLibrarySelected, setMediaLibrarySelected] = useState(new Set());
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
  /** Após "Alterar", mostra o seletor Cor/Voltagem/… sem voltar a aplicar «Sem variação» por defeito. */
  const [variationPickerRequested, setVariationPickerRequested] = useState(false);
  /** Índices de variação expandidos no modal (acordeão). */
  const [modelVariationExpanded, setModelVariationExpanded] = useState(() => new Set([0]));
  const [modelEditViewTab, setModelEditViewTab] = useState('detalhes');
  const [modelValidationResult, setModelValidationResult] = useState(null);
  const [modelValidationLoading, setModelValidationLoading] = useState(false);
  /** No editor de modelo: ocultar códigos ML (BRAND, etc.) por defeito — mais limpo para o utilizador. */
  const [modelShowTechnicalIds, setModelShowTechnicalIds] = useState(false);
  /** Reordenar imagens no modal: drag-and-drop (índice de origem durante arrasto) */
  const modelPictureDragFromRef = useRef(null);
  const [modelPictureDragOverIndex, setModelPictureDragOverIndex] = useState(null);
  const [modelPictureDraggingIndex, setModelPictureDraggingIndex] = useState(null);
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
    (async () => {
      try {
        const r = await axios.get('/api/inventory', { params: { limit: 300, offset: 0 } });
        setInventory(r.data.items || []);
      } catch { setInventory([]); }
    })();
  }, []);

  useEffect(() => {
    if (!openActionMenu) return;
    const close = () => setOpenActionMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openActionMenu]);

  // Busca sob demanda no inventário quando os modais de vínculo (linkModal/varLinkModal)
  // estão abertos. Mantém o cache anterior (evita piscar a lista) e faz o merge por id.
  useEffect(() => {
    if (!linkModal && !varLinkModal) return;
    const tid = setTimeout(async () => {
      try {
        const q = (linkSearch || '').trim();
        const r = await axios.get('/api/inventory', { params: { search: q, limit: 200 } });
        const items = Array.isArray(r.data?.items) ? r.data.items : [];
        setInventory((prev) => {
          const map = new Map();
          for (const it of items) map.set(it.id, it);
          for (const it of prev) if (!map.has(it.id)) map.set(it.id, it);
          return Array.from(map.values());
        });
      } catch {}
    }, 220);
    return () => clearTimeout(tid);
  }, [linkSearch, linkModal, varLinkModal]);

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
    if (modelEditModal) {
      setModelEditViewTab('detalhes');
      setModelShowTechnicalIds(false);
      setVariationPickerRequested(false);
    }
  }, [modelEditModal?.id]);

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
      setVariationPickerRequested(false);
      setModelVariationExpanded(new Set([0]));
      setModelShowTechnicalIds(false);
      modelPictureDragFromRef.current = null;
      setModelPictureDragOverIndex(null);
      setModelPictureDraggingIndex(null);
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

  /** Modelo sem linhas de variação + categoria com eixos ML: «Sem variação» fica explícito (evita o seletor vazio). */
  useEffect(() => {
    if (!modelEditModal) return;
    if ((modelEditModal._variations || []).length > 0) return;
    if (modelVariationAxisAttrs.length === 0) return;
    if (modelVariationAxisChoice !== null) return;
    if (variationPickerRequested) return;
    setModelVariationAxisChoice('none');
  }, [
    modelEditModal?.id,
    modelEditModal?._variations?.length,
    modelVariationAxisAttrs.length,
    modelVariationAxisChoice,
    variationPickerRequested,
  ]);

  useEffect(() => {
    if (modelVariationAxisChoice != null) setVariationPickerRequested(false);
  }, [modelVariationAxisChoice]);

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
      const params = {
        page: currentPage,
        pageSize,
        marketplace: filterMarketplace,
        search: search || undefined,
      };
      if (filterAccount !== 'all') params.accountId = filterAccount;
      if (filterStatus !== 'all') params.status = filterStatus;
      if (filterLinked !== 'all') params.linked = filterLinked;
      if (filterHasStock !== 'all') params.hasStock = filterHasStock;
      if (filterDivergence) params.divergence = 'yes';
      const r = await axios.get('/api/ad-items', { params });
      // Normaliza variações de ambos os marketplaces para um shape comum que o
      // JSX da expansão possa consumir sem if/else no meio do markup.
      const normalized = (r.data?.items || []).map((it) => {
        if (!Array.isArray(it.variations) || it.variations.length === 0) return it;
        const variations = it.variations.map((v) => {
          if (it.source === 'ml') {
            let combos = [];
            try { combos = JSON.parse(v.attribute_combinations || '[]'); } catch { /* noop */ }
            const combo_str = combos.map((c) => `${c.name || c.id}: ${c.value_name || c.value_id || '?'}`).join(' | ');
            return {
              ...v,
              __src: 'ml',
              __sku: v.sku,
              __ref_id: v.variation_id,
              __combo_str: combo_str,
              __combos: combos,
              __available: v.available_quantity,
              __thumbnail: v.thumbnail,
            };
          }
          return {
            ...v,
            __src: 'shopee',
            __sku: v.model_sku || v.sku || '',
            __ref_id: v.model_id,
            __combo_str: v.name || '',
            __combos: [],
            __available: v.stock,
            __thumbnail: v.thumbnail,
          };
        });
        return { ...it, variations };
      });
      setItems(normalized);
      setItemsTotal(r.data?.total || 0);
      setItemsTotalPages(r.data?.totalPages || 1);
      setItemsTotals(r.data?.totals || { ml: 0, shopee: 0 });
    } catch {
      setItems([]); setItemsTotal(0); setItemsTotalPages(1); setItemsTotals({ ml: 0, shopee: 0 });
    }
    setLoading(false);
  }, [search, currentPage, pageSize, filterMarketplace, filterAccount, filterStatus, filterLinked, filterHasStock, filterDivergence]);

  useEffect(() => { fetchItems(); }, [debouncedSearch, currentPage, pageSize, filterMarketplace, filterAccount, filterStatus, filterLinked, filterHasStock, filterDivergence]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const [syncingFast, setSyncingFast] = useState(false);
  const handleSyncFast = async () => {
    setSyncingFast(true);
    try {
      const r = await axios.post('/api/ad-items/sync-fast', {});
      const results = r.data?.results || [];
      const added = results.reduce((s, x) => s + (x.added || 0), 0);
      const refreshed = results.reduce((s, x) => s + (x.refreshed || 0) + (x.synced || 0), 0);
      const errors = results.reduce((s, x) => s + (x.errors || 0) + (x.error ? 1 : 0), 0);
      toast.success(`Sync rápido concluído — novos: ${added} · atualizados: ${refreshed}${errors ? ` · erros: ${errors}` : ''}`);
      fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro no sync rápido'); }
    setSyncingFast(false);
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

  // C2 — abre o modal de ajuste de faixa. Para uma única linha passa o item;
  // para massa passa uma lista já filtrada (somente com config_id).
  const openRangeModal = (payload) => {
    const isBulk = payload?.mode === 'bulk';
    const ref = isBulk ? (payload.items?.[0] || null) : payload;
    const seedMin = ref?.fictitious_min ?? 450;
    const seedMax = ref?.fictitious_max ?? 499;
    setRangeModal(payload);
    setRangeForm({ min: String(seedMin), max: String(seedMax), saving: false });
  };

  // D5 — abre timeline. Busca combinando movimentações e stock_audit_log.
  const openHistoryModal = async (item) => {
    const invId = item.inventory_id;
    if (!invId) {
      toast.error('Item sem vínculo com o inventário.');
      return;
    }
    setHistoryModal(item);
    setHistoryEntries([]);
    setHistoryLoading(true);
    try {
      const res = await axios.get(`/api/inventory/${invId}/stock-history`, { params: { limit: 50 } });
      setHistoryEntries(Array.isArray(res.data) ? res.data : []);
    } catch {
      toast.error('Erro ao carregar histórico');
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleSaveRange = async () => {
    const minN = parseInt(rangeForm.min, 10);
    const maxN = parseInt(rangeForm.max, 10);
    if (!Number.isFinite(minN) || !Number.isFinite(maxN)) return toast.error('Informe números válidos');
    if (minN < 0 || maxN < 0) return toast.error('Valores não podem ser negativos');
    if (minN > maxN) return toast.error('Mínimo não pode ser maior que o máximo');
    setRangeForm(f => ({ ...f, saving: true }));
    try {
      if (rangeModal?.mode === 'bulk') {
        const items = rangeModal.items || [];
        const mlIds = items.filter(i => i.source === 'ml' && i.config_id).map(i => i.config_id);
        const shopeeIds = items.filter(i => i.source === 'shopee' && i.config_id).map(i => i.config_id);
        if (mlIds.length === 0 && shopeeIds.length === 0) {
          toast.error('Nenhum item selecionado com vínculo de configuração');
          setRangeForm(f => ({ ...f, saving: false }));
          return;
        }
        const tasks = [];
        if (mlIds.length) tasks.push(axios.post('/api/ml/stock-config/bulk-range', { config_ids: mlIds, fictitious_min: minN, fictitious_max: maxN }));
        if (shopeeIds.length) tasks.push(axios.post('/api/shopee/stock-config/bulk-range', { config_ids: shopeeIds, fictitious_min: minN, fictitious_max: maxN }));
        const results = await Promise.all(tasks);
        const total = results.reduce((a, r) => a + (r.data?.updated || 0), 0);
        toast.success(`Faixa aplicada em ${total} configurações.`);
      } else {
        const item = rangeModal;
        const endpoint = item.source === 'ml' ? `/api/ml/stock-config/${item.config_id}` : `/api/shopee/stock/${item.config_id}`;
        await axios.put(endpoint, { use_real_stock: item.use_real_stock, fictitious_min: minN, fictitious_max: maxN, enabled: item.enabled });
        toast.success('Faixa atualizada.');
      }
      setRangeModal(null);
      fetchItems();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao salvar faixa');
    } finally {
      setRangeForm(f => ({ ...f, saving: false }));
    }
  };

  const handleVarLink = async (variation, inventoryId) => {
    try {
      if (variation.__src === 'shopee') {
        await axios.post('/api/shopee/variation-stock/link', {
          inventory_id: inventoryId,
          shopee_account_id: variation.shopee_account_id,
          shopee_item_id: variation.shopee_item_id,
          model_id: variation.model_id,
        });
      } else {
        await axios.post('/api/ml/variation-stock/link', {
          inventory_id: inventoryId, ml_account_id: variation.ml_account_id,
          ml_item_id: variation.ml_item_id, variation_id: variation.variation_id
        });
      }
      toast.success('Variação vinculada!'); setVarLinkModal(null); setLinkSearch(''); fetchItems();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao vincular variação'); }
  };

  const handleVarUnlink = async (variation) => {
    try {
      const base = variation.__src === 'shopee' ? '/api/shopee/variation-stock' : '/api/ml/variation-stock';
      await axios.delete(`${base}/${variation.var_config_id}`);
      toast.success('Desvinculado'); fetchItems();
    } catch { toast.error('Erro ao desvincular variação'); }
  };

  const handleVarToggleRealStock = async (v) => {
    try {
      const base = v.__src === 'shopee' ? '/api/shopee/variation-stock' : '/api/ml/variation-stock';
      await axios.put(`${base}/${v.var_config_id}`, {
        use_real_stock: v.var_use_real_stock ? 0 : 1,
        fictitious_min: v.var_fict_min, fictitious_max: v.var_fict_max, enabled: v.var_enabled
      });
      fetchItems();
    } catch { toast.error('Erro ao atualizar'); }
  };

  const handleVarToggleEnabled = async (v) => {
    try {
      const base = v.__src === 'shopee' ? '/api/shopee/variation-stock' : '/api/ml/variation-stock';
      await axios.put(`${base}/${v.var_config_id}`, {
        use_real_stock: v.var_use_real_stock,
        fictitious_min: v.var_fict_min, fictitious_max: v.var_fict_max, enabled: v.var_enabled ? 0 : 1
      });
      fetchItems();
    } catch { toast.error('Erro ao atualizar'); }
  };

  // ─── Edição inline de preço e refresh por item (A5) ──────────────────
  const [priceEditModal, setPriceEditModal] = useState(null); // { item, value }
  const [savingPrice, setSavingPrice] = useState(false);
  const [refreshingItem, setRefreshingItem] = useState({});

  const openPriceEdit = (item) => setPriceEditModal({ item, value: String(item.price ?? '') });

  const savePriceEdit = async () => {
    if (!priceEditModal) return;
    const { item } = priceEditModal;
    const price = Number(priceEditModal.value);
    if (!Number.isFinite(price) || price <= 0) return toast.error('Preço inválido');
    setSavingPrice(true);
    try {
      if (item.source === 'ml') {
        await axios.put(`/api/ml/items/${item.ml_item_id}/price`, { price, accountId: item.ml_account_id });
      } else {
        await axios.put(`/api/shopee/items/${item.shopee_item_id}/price`, { price, accountId: item.shopee_account_id });
      }
      toast.success('Preço atualizado!');
      setPriceEditModal(null);
      fetchItems();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao alterar preço');
    }
    setSavingPrice(false);
  };

  const handleRefreshItem = async (item) => {
    const key = `${item.source}-${item.uid}`;
    setRefreshingItem((s) => ({ ...s, [key]: true }));
    try {
      if (item.source === 'ml') {
        await axios.post(`/api/ml/items/${item.ml_item_id}/refresh`, { accountId: item.ml_account_id });
      } else {
        await axios.post(`/api/shopee/items/${item.shopee_item_id}/refresh`, { accountId: item.shopee_account_id });
      }
      toast.success('Atualizado do marketplace');
      fetchItems();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erro ao atualizar do marketplace');
    }
    setRefreshingItem((s) => ({ ...s, [key]: false }));
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
      const endpoint = variation.__src === 'shopee' ? '/api/shopee/variation-stock/push' : '/api/ml/variation-stock/push';
      const res = await axios.post(endpoint, { configId: variation.var_config_id });
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

  const itemKey = (item) => `${item.source}:${item.item_id_display}:${item.source === 'ml' ? item.ml_account_id : item.shopee_account_id}`;

  const toggleSelectItem = (item) => {
    setSelectedItems(prev => {
      const next = new Map(prev);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key); else next.set(key, item);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const importable = items.filter((i) => i.source === 'ml' || i.source === 'shopee');
    // Se TODOS os itens da página atual já estão selecionados, deseleciona-os
    // (mantendo seleção de outras páginas). Caso contrário, adiciona os da
    // página atual ao Map de seleção.
    setSelectedItems(prev => {
      const next = new Map(prev);
      const allSelected = importable.every((i) => next.has(itemKey(i)));
      if (allSelected) {
        importable.forEach((i) => next.delete(itemKey(i)));
      } else {
        importable.forEach((i) => next.set(itemKey(i), i));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedItems(new Map());

  const buildImportPayload = (source, itemId, accountId) => {
    const acc = parseInt(accountId, 10);
    if (source === 'shopee') {
      return { marketplace: 'shopee', shopeeItemId: String(itemId), shopeeAccountId: acc, forceOverwrite: true };
    }
    return { marketplace: 'ml', mlItemId: itemId, accountId: acc, forceOverwrite: true };
  };

  const handleImportSelected = async () => {
    if (selectedItems.size === 0) return;
    setImporting(true);
    let totalImported = 0, totalErrors = 0;
    for (const key of selectedItems.keys()) {
      const [source, itemId, accountId] = key.split(':');
      if (source !== 'ml' && source !== 'shopee') continue;
      try {
        await axios.post('/api/ad-models/import', buildImportPayload(source, itemId, accountId));
        totalImported++;
      } catch { totalErrors++; }
    }
    toast.success(`Modelos importados: ${totalImported} | Erros: ${totalErrors}`);
    setSelectedItems(new Map());
    setImporting(false);
    if (totalImported > 0) { fetchAdModels(); }
  };

  // ─── Ações em massa (A4) ────────────────────────────────────────────────
  // Executa worker(item) com no máximo `concurrency` requisições em paralelo,
  // protegendo as APIs de rate-limit e mantendo o painel responsivo.
  const runBulk = async (concurrency, list, worker) => {
    const out = { ok: 0, fail: 0, errors: [] };
    let idx = 0;
    const next = async () => {
      while (idx < list.length) {
        const i = idx++;
        try { await worker(list[i]); out.ok++; }
        catch (e) { out.fail++; out.errors.push({ item: list[i], message: e.response?.data?.error || e.message }); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, next));
    return out;
  };

  const handleBulkChangeStatus = async (newStatus) => {
    const targets = Array.from(selectedItems.values()).filter((it) =>
      newStatus === 'paused' ? isActive(it) : canActivate(it)
    );
    if (targets.length === 0) return toast.error('Nenhum item elegível para esta ação na seleção.');
    const verb = newStatus === 'paused' ? 'pause' : 'activate';
    setBulkRunning(verb);
    const result = await runBulk(3, targets, async (item) => {
      if (item.source === 'ml') {
        await axios.put(`/api/ml/items/${item.ml_item_id}/status`, { status: newStatus, accountId: item.ml_account_id });
      } else {
        const action = newStatus === 'paused' ? 'unlist' : 'relist';
        await axios.post(`/api/shopee/items/${item.shopee_item_id}/status`, { action, accountId: item.shopee_account_id });
      }
    });
    setBulkRunning(null);
    toast.success(`${newStatus === 'paused' ? 'Pausados' : 'Ativados'}: ${result.ok} | Erros: ${result.fail}`);
    fetchItems();
  };

  // Faz vínculo automático com inventário usando o SKU exato. Trabalha em duas
  // etapas: garante o cache de inventário (busca os SKUs em falta) e depois
  // dispara os links em paralelo.
  const handleBulkLinkBySku = async () => {
    const targets = Array.from(selectedItems.values()).filter((it) => !it.config_id && (it.variation_count || 0) === 0 && it.sku);
    if (targets.length === 0) return toast.error('Nenhum item elegível: precisam estar sem vínculo, sem variações e ter SKU.');
    setBulkRunning('link');
    // Pré-carrega inventário pelos SKUs ainda não conhecidos.
    const knownSkus = new Set(inventory.map((i) => String(i.sku)));
    const unknown = Array.from(new Set(targets.map((t) => String(t.sku)).filter((s) => !knownSkus.has(s))));
    if (unknown.length > 0) {
      try {
        // Server-side search é uma LIKE, então buscamos lote a lote.
        const results = await Promise.all(unknown.map((sku) =>
          axios.get('/api/inventory', { params: { search: sku, limit: 5 } }).then((r) => r.data?.items || []).catch(() => [])));
        const seen = new Set(inventory.map((i) => i.id));
        const merge = [];
        for (const arr of results) for (const inv of arr) if (!seen.has(inv.id)) { seen.add(inv.id); merge.push(inv); }
        if (merge.length > 0) setInventory((prev) => [...prev, ...merge]);
      } catch { /* segue com inventory parcial */ }
    }
    // Refaz lookup local depois do carregamento.
    const lookup = new Map();
    for (const inv of inventory) lookup.set(String(inv.sku), inv);
    // Reaplica caso o setInventory acima tenha trazido mais itens — pode não ter
    // sido refletido ainda no estado, então tentamos refetch via axios direto.
    const result = await runBulk(4, targets, async (item) => {
      let inv = lookup.get(String(item.sku));
      if (!inv) {
        const r = await axios.get('/api/inventory', { params: { search: item.sku, limit: 5 } });
        inv = (r.data?.items || []).find((x) => String(x.sku) === String(item.sku));
        if (!inv) throw new Error('SKU não encontrado no inventário');
      }
      if (item.source === 'ml') {
        await axios.post('/api/ml/stock-config/link', { inventory_id: inv.id, ml_account_id: item.ml_account_id, ml_item_id: item.ml_item_id });
      } else {
        await axios.post('/api/shopee/stock/link', { inventoryId: inv.id, shopeeItemId: item.shopee_item_id, shopeeAccountId: item.shopee_account_id });
      }
    });
    setBulkRunning(null);
    toast.success(`Vinculados: ${result.ok} | Erros: ${result.fail}`);
    fetchItems();
  };

  const handleBulkPush = async () => {
    const targets = Array.from(selectedItems.values()).filter((it) => it.config_id && (it.variation_count || 0) === 0);
    if (targets.length === 0) return toast.error('Nenhum item vinculado (sem variações) na seleção.');
    setBulkRunning('push');
    const result = await runBulk(3, targets, async (item) => {
      const endpoint = item.source === 'ml' ? '/api/ml/stock/push' : '/api/shopee/stock/push';
      await axios.post(endpoint, { configId: item.config_id });
    });
    setBulkRunning(null);
    toast.success(`Estoque enviado: ${result.ok} | Erros: ${result.fail}`);
    fetchItems();
  };

  const handleBulkRefresh = async () => {
    // Refresh é uma feature do ML (POST /api/ml/items/:id/refresh). Para Shopee
    // a forma é re-sincronizar a conta inteira; aqui mantemos só ML.
    const targets = Array.from(selectedItems.values()).filter((it) => it.source === 'ml');
    if (targets.length === 0) return toast.error('Refresh disponível apenas para itens do Mercado Livre.');
    setBulkRunning('refresh');
    const result = await runBulk(2, targets, async (item) => {
      await axios.post(`/api/ml/items/${item.ml_item_id}/refresh`, { accountId: item.ml_account_id });
    });
    setBulkRunning(null);
    toast.success(`Atualizados: ${result.ok} | Erros: ${result.fail}`);
    fetchItems();
  };

  const handleImportSingle = async (item) => {
    try {
      const payload = item.source === 'shopee'
        ? { marketplace: 'shopee', shopeeItemId: String(item.shopee_item_id), shopeeAccountId: item.shopee_account_id, forceOverwrite: true }
        : { marketplace: 'ml', mlItemId: item.ml_item_id, accountId: item.ml_account_id, forceOverwrite: true };
      const r = await axios.post('/api/ad-models/import', payload);
      toast.success(`Modelo "${r.data.title}" ${r.data.updated ? 'atualizado' : 'criado'}!`);
      fetchAdModels();
    } catch (e) { toast.error(e.response?.data?.error || 'Erro ao importar'); }
  };

  const handleModelImportFromItem = async (item, forceOverwrite = false) => {
    try {
      const payload = item.source === 'shopee'
        ? { marketplace: 'shopee', shopeeItemId: String(item.shopee_item_id), shopeeAccountId: item.shopee_account_id, forceOverwrite }
        : { marketplace: 'ml', mlItemId: item.ml_item_id, accountId: item.ml_account_id, forceOverwrite };
      const r = await axios.post('/api/ad-models/import', payload);
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

  const reorderModelPictures = (fromIndex, toIndex) => {
    if (fromIndex == null || toIndex == null || fromIndex === toIndex) return;
    setModelEditModal((prev) => {
      const pics = [...(prev._pictures || [])];
      if (fromIndex < 0 || fromIndex >= pics.length || toIndex < 0 || toIndex >= pics.length) return prev;
      const [moved] = pics.splice(fromIndex, 1);
      pics.splice(toIndex, 0, moved);
      return { ...prev, _pictures: pics };
    });
  };

  const handleModelPictureDragStart = (e, pi) => {
    modelPictureDragFromRef.current = pi;
    setModelPictureDraggingIndex(pi);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(pi));
  };

  const handleModelPictureDragEnd = () => {
    modelPictureDragFromRef.current = null;
    setModelPictureDragOverIndex(null);
    setModelPictureDraggingIndex(null);
  };

  const handleModelPictureDragOver = (e, pi) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setModelPictureDragOverIndex((cur) => (cur === pi ? cur : pi));
  };

  const handleModelPictureDrop = (e, dropIndex) => {
    e.preventDefault();
    const from = modelPictureDragFromRef.current;
    modelPictureDragFromRef.current = null;
    setModelPictureDragOverIndex(null);
    setModelPictureDraggingIndex(null);
    if (from == null || from === dropIndex) return;
    reorderModelPictures(from, dropIndex);
  };

  const handleModelPictureDragLeaveCard = (e) => {
    const rel = e.relatedTarget;
    if (rel && e.currentTarget.contains(rel)) return;
    setModelPictureDragOverIndex(null);
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
      if (modelEditModal._marketplace_mappings) payload.marketplace_mappings = modelEditModal._marketplace_mappings;

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

  /** Pede ao backend uma validação prévia do modelo para um marketplace específico. */
  const runModelValidation = useCallback(async (marketplace) => {
    if (!modelEditModal?.id) {
      toast.error('Salve o modelo antes de validar.');
      return;
    }
    setModelValidationLoading(true);
    try {
      const r = await axios.post(`/api/ad-models/${modelEditModal.id}/validate-publish`, { marketplace });
      setModelValidationResult({ marketplace, ...r.data });
    } catch (e) {
      setModelValidationResult({
        marketplace,
        ok: false,
        issues: [{ code: 'server', message: e.response?.data?.error || e.message || 'Erro ao validar' }],
        warnings: [],
      });
    } finally {
      setModelValidationLoading(false);
    }
  }, [modelEditModal?.id, toast]);

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
      const msg = d?.error || d?.message || 'Erro ao publicar';
      toast.error(msg, { duration: 18000 });
      // Se for Shopee com atributos faltando, abre direto a aba "Ficha técnica
      // Shopee" no modal de edição, com os IDs faltantes já pré-criados vazios
      // para o seller só preencher o valor.
      const missingAttrs = d?.shopee?.missingAttributes || [];
      const missingValueIds = d?.shopee?.missingValueIds || [];
      if (missingAttrs.length > 0 || missingValueIds.length > 0) {
        const model = adModels.find(m => m.id === modelPublishModal.modelId);
        if (model) {
          const mm = parseMarketplaceMappings(model.marketplace_mappings);
          const currentAttrs = mm.channels.shopee.attributes || {};
          const updatedAttrs = { ...currentAttrs };
          for (const ma of missingAttrs) {
            if (!updatedAttrs[String(ma.attribute_id)]) {
              updatedAttrs[String(ma.attribute_id)] = { original_value_name: '', _suggested_name: ma.name };
            }
          }
          const updatedMm = {
            ...mm,
            channels: { ...mm.channels, shopee: { ...mm.channels.shopee, attributes: updatedAttrs } },
          };
          setTimeout(() => {
            setModelEditModal({
              ...model,
              description: model.description || '',
              _attributes: (() => { try { return JSON.parse(model.attributes || '[]'); } catch { return []; } })(),
              _variations: (() => { try { return JSON.parse(model.variations || '[]'); } catch { return []; } })(),
              _shipping: (() => { try { return JSON.parse(model.shipping || 'null'); } catch { return null; } })(),
              _sale_terms: (() => { try { return JSON.parse(model.sale_terms || '[]'); } catch { return []; } })(),
              _pictures: (() => { try { return JSON.parse(model.pictures || '[]'); } catch { return []; } })(),
              _package: parsePackageMeasuresFromModel(model),
              _marketplace_mappings: updatedMm,
              // Sinaliza ao ShopeeAttributesBlock pra abrir direto o painel de
              // importação quando o erro foi por value_id faltando (pre-flight).
              _openShopeeImport: missingValueIds.length > 0,
            });
            setModelEditViewTab('shopee');
          }, 400);
        }
      }
    }
    setModelPublishing(false);
  };

  /** Abre o modal da biblioteca de mídia e dispara a busca inicial. */
  const openMediaLibrary = () => {
    setMediaLibrarySelected(new Set());
    setMediaLibrarySearch('');
    setMediaLibraryModal({ open: true });
  };

  useEffect(() => {
    if (!mediaLibraryModal?.open) return;
    const tid = setTimeout(async () => {
      setMediaLibraryLoading(true);
      try {
        const r = await axios.get('/api/ad-models/media-library', { params: { search: mediaLibrarySearch || '', limit: 120 } });
        setMediaLibraryItems(Array.isArray(r.data?.items) ? r.data.items : []);
      } catch { setMediaLibraryItems([]); }
      setMediaLibraryLoading(false);
    }, 220);
    return () => clearTimeout(tid);
  }, [mediaLibrarySearch, mediaLibraryModal?.open]);

  const addSelectedMediaToModel = () => {
    const selected = mediaLibraryItems.filter((it) => mediaLibrarySelected.has(it.url));
    if (selected.length === 0) { setMediaLibraryModal(null); return; }
    setModelEditModal((p) => {
      const existing = new Set((p._pictures || []).map((pic) => pic.source || pic.secure_url));
      const newPics = selected
        .filter((it) => !existing.has(it.url))
        .map((it) => ({ id: `pic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, source: it.url }));
      return { ...p, _pictures: [...(p._pictures || []), ...newPics] };
    });
    setMediaLibraryModal(null);
  };

  /** Importa um anúncio (ML/Shopee) a partir de um ID fornecido manualmente. */
  const handleImportById = async () => {
    if (!importByIdModal) return;
    const { marketplace, itemId, accountId } = importByIdModal;
    if (!itemId || !accountId) {
      toast.error('Preencha o ID do anúncio e selecione a conta');
      return;
    }
    setImportByIdLoading(true);
    try {
      const payload = { marketplace, accountId: Number(accountId), forceOverwrite: true };
      if (marketplace === 'shopee') payload.shopeeItemId = String(itemId).trim();
      else payload.mlItemId = String(itemId).trim();
      const r = await axios.post('/api/ad-models/import', payload);
      toast.success(`Modelo importado: ${r.data?.model?.title || r.data?.model?.sku || 'OK'}`);
      setImportByIdModal(null);
      fetchAdModels();
    } catch (e) {
      const d = e.response?.data;
      toast.error(d?.error || d?.message || 'Erro ao importar por ID', { duration: 10000 });
    }
    setImportByIdLoading(false);
  };

  /** Abre o modal de publicação multi-destino para um modelo, pré-selecionando nenhum destino. */
  const openMultiPublishForModel = (model) => {
    setMultiPublishResults(null);
    setMultiPublishModal({
      modelId: model.id,
      modelTitle: model.title || '',
      modelSku: model.sku || '',
      basePrice: Number(model.price) || 0,
      targets: [],
    });
  };

  const toggleMultiTarget = (marketplace, accountId, accountName) => {
    setMultiPublishModal((p) => {
      if (!p) return p;
      const idx = p.targets.findIndex((t) => t.marketplace === marketplace && Number(t.accountId) === Number(accountId));
      const next = [...p.targets];
      if (idx >= 0) next.splice(idx, 1);
      else next.push({ marketplace, accountId, accountName, price: p.basePrice, listing_type_id: marketplace === 'ml' ? 'gold_special' : undefined, status: 'pending' });
      return { ...p, targets: next };
    });
  };

  const updateMultiTargetField = (marketplace, accountId, field, value) => {
    setMultiPublishModal((p) => ({
      ...p,
      targets: p.targets.map((t) =>
        t.marketplace === marketplace && Number(t.accountId) === Number(accountId) ? { ...t, [field]: value } : t
      ),
    }));
  };

  const handleMultiPublishRun = async () => {
    if (!multiPublishModal) return;
    if (multiPublishModal.targets.length === 0) {
      toast.error('Selecione ao menos um destino');
      return;
    }
    setMultiPublishRunning(true);
    setMultiPublishResults(null);
    setMultiPublishModal((p) => ({ ...p, targets: p.targets.map((t) => ({ ...t, status: 'running' })) }));
    try {
      const r = await axios.post(`/api/ad-models/${multiPublishModal.modelId}/publish-multi`, {
        targets: multiPublishModal.targets.map((t) => ({
          marketplace: t.marketplace,
          accountId: Number(t.accountId),
          price: Number(t.price) || undefined,
          listing_type_id: t.listing_type_id || undefined,
          available_quantity: t.available_quantity != null ? Number(t.available_quantity) : undefined,
        })),
      });
      setMultiPublishResults(r.data);
      setMultiPublishModal((p) => ({
        ...p,
        targets: p.targets.map((t) => {
          const res = (r.data.results || []).find((x) => x.marketplace === t.marketplace && Number(x.accountId) === Number(t.accountId));
          return { ...t, status: res?.success ? 'ok' : 'error', error: res?.success ? null : res?.error, item_id: res?.item_id, permalink: res?.permalink };
        }),
      }));
      if (r.data.published > 0) {
        toast.success(`${r.data.published}/${r.data.total} destino(s) publicado(s)`);
        fetchAdModels();
      }
      if (r.data.published < r.data.total) {
        toast.error(`${r.data.total - r.data.published} destino(s) com erro`, { duration: 10000 });
      }
    } catch (e) {
      const d = e.response?.data;
      toast.error(d?.error || d?.message || 'Erro ao publicar em múltiplos destinos', { duration: 12000 });
      setMultiPublishModal((p) => ({ ...p, targets: p.targets.map((t) => ({ ...t, status: 'error', error: d?.error || e.message })) }));
    }
    setMultiPublishRunning(false);
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

  // Busca inventário por SKU:
  //   1) match exato (case-insensitive, trim)
  //   2) prefixo exato — útil quando o marketplace concatena sufixos (ex.: ABC-01 → ABC)
  // NÃO removemos mais letras do SKU (heurística antiga confundia SKUs alfanuméricos).
  const findInventoryBySku = useCallback((sku) => {
    if (!sku || !inventory.length) return null;
    const clean = String(sku).trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();
    return inventory.find(inv => String(inv.sku || '').trim().toLowerCase() === lower)
      || inventory.find(inv => String(inv.sku || '').trim().toLowerCase().startsWith(lower))
      || null;
  }, [inventory]);
  const sourceBadge = (item) => {
    if (item.source === 'shopee') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium">Shopee</span>;
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-medium">Mercado Livre</span>;
  };
  const isActive = (item) => item.status === 'active' || item.status === 'NORMAL';
  const isPaused = (item) => item.status === 'paused' || item.status === 'UNLIST';
  const canActivate = (item) => isPaused(item) || item.status === 'closed';

  // A filtragem (marketplace/conta/busca) e a paginação acontecem no backend
  // via /api/ad-items, então aqui só usamos a página corrente recebida.
  const filteredItems = items;
  const totalPages = itemsTotalPages;
  const paginatedItems = items;

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, filterMarketplace, filterAccount, filterStatus, filterLinked, filterHasStock, filterDivergence]);

  // Quantos itens da página atual são selecionáveis para "Selecionar todos".
  const importableItemsCount = paginatedItems.filter((i) => i.source === 'ml' || i.source === 'shopee').length;

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
          {/* Menu consolidado de sincronização — agrupa 'Sync rápido',
              'Sincronizar' e 'Enviar Estoque' num único botão discreto. */}
          <div className="relative" ref={syncMenuRef}>
            <button
              onClick={() => setSyncMenuOpen(v => !v)}
              disabled={syncing || syncingFast || pushingAll}
              title="Ações de sincronização e envio de estoque"
              className="px-3 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-100 text-sm rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2 border border-gray-200 dark:border-gray-600">
              {(syncing || syncingFast || pushingAll) ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span className="hidden sm:inline">
                {syncingFast ? 'Sync rápido…' : syncing ? 'Sincronizando…' : pushingAll ? 'Enviando…' : 'Sincronização'}
              </span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${syncMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {syncMenuOpen && (
              <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-30 overflow-hidden">
                <button
                  onClick={() => { setSyncMenuOpen(false); handleSyncFast(); }}
                  disabled={syncingFast || syncing}
                  className="w-full px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 flex items-start gap-3 disabled:opacity-50">
                  <Zap className={`w-4 h-4 text-sky-500 mt-0.5 ${syncingFast ? 'animate-pulse' : ''}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {syncingFast ? 'Sync rápido…' : 'Sync rápido'}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      Atualiza apenas itens novos ou alterados
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setSyncMenuOpen(false); handleSyncAll(); }}
                  disabled={syncing || syncingFast}
                  className="w-full px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 flex items-start gap-3 disabled:opacity-50 border-t border-gray-100 dark:border-gray-700">
                  <RefreshCw className={`w-4 h-4 text-blue-500 mt-0.5 ${syncing ? 'animate-spin' : ''}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {syncing ? 'Sincronizando…' : 'Sincronizar tudo'}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      Busca todos os anúncios de todas as contas
                    </div>
                  </div>
                </button>
                <button
                  onClick={() => { setSyncMenuOpen(false); handlePushAll(); }}
                  disabled={pushingAll}
                  className="w-full px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 flex items-start gap-3 disabled:opacity-50 border-t border-gray-100 dark:border-gray-700">
                  <Upload className={`w-4 h-4 text-green-600 mt-0.5 ${pushingAll ? 'animate-spin' : ''}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {pushingAll ? 'Enviando…' : 'Enviar estoque'}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                      Publica o estoque atual em todos os marketplaces
                    </div>
                  </div>
                </button>
              </div>
            )}
          </div>
            </>
          )}
        </div>
      </div>

      {/* === TAB: ANÚNCIOS ATIVOS === */}
      {activeTab === 'ativos' && (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4">
          {/* Linha 1 — Busca + marketplace + conta + paginação. */}
          <div className="flex flex-col md:flex-row items-start md:items-center gap-3 mb-3">
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
                <span className="text-xs text-gray-400">
                  {itemsTotal} {itemsTotal === 1 ? 'anúncio' : 'anúncios'}
                  {filterMarketplace === 'all' && (itemsTotals.ml > 0 || itemsTotals.shopee > 0) && (
                    <span className="ml-1 opacity-75">· ML {itemsTotals.ml} · Shopee {itemsTotals.shopee}</span>
                  )}
                </span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}
                  className="pl-2 pr-7 py-1.5 border dark:border-gray-600 rounded-lg text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white appearance-none">
                  {[20, 50, 100, 150].map(n => <option key={n} value={n}>{n} por página</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Linha 2 — Filtros avançados, colapsáveis atrás de um botão discreto.
              Quando fechado, mostramos apenas um resumo dos filtros ativos. */}
          {(() => {
            const activeFilters = [];
            if (filterStatus !== 'all') {
              const lbl = { active: 'Ativos', paused: 'Pausados', closed: 'Encerrados' }[filterStatus] || filterStatus;
              activeFilters.push({ key: 'status', label: lbl, clear: () => setFilterStatus('all') });
            }
            if (filterLinked !== 'all') {
              activeFilters.push({ key: 'linked', label: filterLinked === 'linked' ? 'Vinculados' : 'Sem vínculo', clear: () => setFilterLinked('all') });
            }
            if (filterHasStock !== 'all') {
              activeFilters.push({ key: 'stock', label: filterHasStock === 'yes' ? 'Com estoque' : 'Sem estoque', clear: () => setFilterHasStock('all') });
            }
            if (filterDivergence) {
              activeFilters.push({ key: 'div', label: 'Divergente', clear: () => setFilterDivergence(false) });
            }
            const activeCount = activeFilters.length;
            return (
              <div className="mb-4 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setFiltersOpen(v => !v)}
                    className={`px-2.5 py-1.5 rounded-md font-medium border flex items-center gap-2 transition-colors ${filtersOpen || activeCount > 0 ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800' : 'border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    <span>Filtros</span>
                    {activeCount > 0 && (
                      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold">{activeCount}</span>
                    )}
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {/* Chips compactos dos filtros ativos (visíveis mesmo com o painel fechado). */}
                  {!filtersOpen && activeFilters.map(f => (
                    <span key={f.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-[11px]">
                      {f.label}
                      <button onClick={f.clear} className="hover:text-red-500" title="Remover filtro">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  {!filtersOpen && activeCount > 1 && (
                    <button onClick={() => { setFilterStatus('all'); setFilterLinked('all'); setFilterHasStock('all'); setFilterDivergence(false); }}
                      className="text-blue-600 dark:text-blue-400 hover:underline">Limpar</button>
                  )}
                </div>
                {filtersOpen && (
                  <div className="mt-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-1 bg-white dark:bg-gray-700 rounded-lg p-0.5 border border-gray-200 dark:border-gray-600">
                      {[
                        { value: 'all', label: 'Qualquer status' },
                        { value: 'active', label: 'Ativos' },
                        { value: 'paused', label: 'Pausados' },
                        { value: 'closed', label: 'Encerrados' },
                      ].map(opt => (
                        <button key={opt.value} onClick={() => setFilterStatus(opt.value)}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors ${filterStatus === opt.value ? 'bg-gray-100 dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 bg-white dark:bg-gray-700 rounded-lg p-0.5 border border-gray-200 dark:border-gray-600">
                      {[
                        { value: 'all', label: 'Vínculo: todos' },
                        { value: 'linked', label: 'Vinculados' },
                        { value: 'unlinked', label: 'Sem vínculo' },
                      ].map(opt => (
                        <button key={opt.value} onClick={() => setFilterLinked(opt.value)}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors ${filterLinked === opt.value ? 'bg-gray-100 dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 bg-white dark:bg-gray-700 rounded-lg p-0.5 border border-gray-200 dark:border-gray-600">
                      {[
                        { value: 'all', label: 'Estoque: todos' },
                        { value: 'yes', label: 'Com estoque' },
                        { value: 'no', label: 'Sem estoque' },
                      ].map(opt => (
                        <button key={opt.value} onClick={() => setFilterHasStock(opt.value)}
                          className={`px-2.5 py-1 rounded-md font-medium transition-colors ${filterHasStock === opt.value ? 'bg-gray-100 dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <button onClick={() => setFilterDivergence(v => !v)}
                      title="Mostra apenas configs com 'usar real' ligado e estoque do marketplace diferente do real"
                      className={`px-2.5 py-1 rounded-md font-medium border transition-colors ${filterDivergence ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700' : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}>
                      Divergente
                    </button>
                    {activeCount > 0 && (
                      <button onClick={() => { setFilterStatus('all'); setFilterLinked('all'); setFilterHasStock('all'); setFilterDivergence(false); }}
                        className="text-blue-600 dark:text-blue-400 hover:underline ml-auto">Limpar filtros</button>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Barra de ações em massa — só aparece quando há seleção. */}
          {selectedItems.size > 0 && (
            <div className="mb-4 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex items-center gap-2 flex-wrap text-xs">
              <span className="text-blue-700 dark:text-blue-300 font-medium">
                {selectedItems.size} selecionado{selectedItems.size === 1 ? '' : 's'}
              </span>
              <span className="text-blue-300 dark:text-blue-700">|</span>
              <button onClick={() => handleBulkChangeStatus('active')} disabled={!!bulkRunning}
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-green-50 dark:hover:bg-green-900/30 text-green-700 dark:text-green-400 font-medium disabled:opacity-50 flex items-center gap-1">
                {bulkRunning === 'activate' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                Ativar
              </button>
              <button onClick={() => handleBulkChangeStatus('paused')} disabled={!!bulkRunning}
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-medium disabled:opacity-50 flex items-center gap-1">
                {bulkRunning === 'pause' ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlertTriangle className="w-3 h-3" />}
                Pausar
              </button>
              <button onClick={handleBulkLinkBySku} disabled={!!bulkRunning}
                title="Tenta vincular cada item ao inventário usando o SKU exato."
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-blue-700 dark:text-blue-400 font-medium disabled:opacity-50 flex items-center gap-1">
                {bulkRunning === 'link' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                Vincular por SKU
              </button>
              <button onClick={handleBulkPush} disabled={!!bulkRunning}
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 font-medium disabled:opacity-50 flex items-center gap-1">
                {bulkRunning === 'push' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                Enviar estoque
              </button>
              <button onClick={handleBulkRefresh} disabled={!!bulkRunning}
                title="Atualiza informações dos itens ML diretamente do Mercado Livre."
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-violet-50 dark:hover:bg-violet-900/30 text-violet-700 dark:text-violet-400 font-medium disabled:opacity-50 flex items-center gap-1">
                {bulkRunning === 'refresh' ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Atualizar do ML
              </button>
              <button onClick={() => openRangeModal({ mode: 'bulk', items: Array.from(selectedItems.values()).filter(i => i && i.config_id) })} disabled={!!bulkRunning}
                title="Aplica a mesma faixa fictícia para todos os selecionados com vínculo."
                className="px-2.5 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium disabled:opacity-50 flex items-center gap-1">
                <Edit3 className="w-3 h-3" /> Ajustar faixa
              </button>
              <span className="text-blue-300 dark:text-blue-700">|</span>
              <button onClick={clearSelection}
                className="px-2 py-1 text-blue-700 dark:text-blue-400 hover:underline font-medium">
                Limpar seleção
              </button>
            </div>
          )}
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
                      <input type="checkbox"
                        checked={importableItemsCount > 0 && paginatedItems.every((i) => selectedItems.has(itemKey(i)))}
                        onChange={toggleSelectAll}
                        className="rounded border-gray-300 dark:border-gray-600" title="Selecionar todos (ML + Shopee) desta página" />
                    </th>
                  <th className="text-left py-3 px-3">Anúncio</th>
                    <th className="text-left py-3 px-2">SKU</th>
                  <th className="text-center py-3 px-2">Status</th>
                  <th className="text-center py-3 px-2">Tipo</th>
                    <th className="text-center py-3 px-2">Variação</th>
                    <th className="text-left py-3 px-2">Vinculado</th>
                  <th className="text-right py-3 px-2">Preço</th>
                  <th className="text-center py-3 px-2" title="Saldo do SKU no estoque Miti (para compostos, calculado pelos componentes)">Real</th>
                  <th className="text-center py-3 px-2" title="Real menos pedidos em aberto — é a base do que será enviado para o canal">Disponível</th>
                    <th className="text-center py-3 px-2">MKT</th>
                  <th className="text-center py-3 px-2">Faixa</th>
                  <th className="text-center py-3 px-2" title="Enviar quantidade real; se desligado, usa a faixa fictícia">Usar Real</th>
                  <th className="text-center py-3 px-2" title="Quando ligada, estoque é enviado automaticamente após cada movimentação.">Automação</th>
                  <th className="text-center py-3 px-2">Ações</th>
                </tr>
              </thead>
              <tbody>
                  {paginatedItems.map(item => {
                  const linked = !!item.config_id;
                  const st = statusMap[item.status] || { label: item.status || '-', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400' };
                  const hasDiscount = item.original_price && item.original_price > item.price;
                  const isCatalog = item.source === 'ml' && !!item.is_catalog_listing;
                  // Indicadores derivados — usados como badges de alerta na linha.
                  const noLink = !linked && (item.variation_count || 0) === 0;
                  const stockMkt = item.stock_qty;
                  const noStock = (stockMkt == null || Number(stockMkt) === 0) && (item.variation_count || 0) === 0;
                  const divergent = linked && !!item.use_real_stock && Math.abs(Number(stockMkt || 0) - Number(item.real_quantity || 0)) > 0;
                  const pushKey = `${item.source}-${item.config_id}`;
                    const selectKey = `${item.source}:${item.item_id_display}:${item.source === 'ml' ? item.ml_account_id : item.shopee_account_id}`;
                    const isExpanded = expandedItems.has(item.uid);
                    const itemVars = (item.variations || []);
                  return (
                      <React.Fragment key={item.uid}>
                      <tr className={`border-b dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors ${isExpanded ? 'bg-violet-50/30 dark:bg-violet-900/10' : ''}`}>
                        <td className="py-2.5 px-2">
                          {(item.source === 'ml' || item.source === 'shopee') && (
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
                                {noLink && <span title="Anúncio sem vínculo com o inventário" className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 font-medium">Sem vínculo</span>}
                                {noStock && isActive(item) && <span title="Sem estoque no marketplace" className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 font-medium">Sem estoque</span>}
                                {divergent && (
                                  <button onClick={() => setDivergenceModal(item)}
                                    title="Ver detalhes e corrigir"
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium hover:bg-amber-200 dark:hover:bg-amber-900/50">
                                    Divergente
                                  </button>
                                )}
                                {item.last_error_message && (
                                  <span
                                    title={`Último erro (${item.last_error_at || 's/ data'}): ${item.last_error_message}`}
                                    className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 font-medium cursor-help"
                                  >
                                    Erro no último push
                                  </span>
                                )}
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
                          <div className="flex items-center justify-end gap-1 group">
                            <span className="text-gray-900 dark:text-white font-medium">{formatPrice(item.price)}</span>
                            {(item.variation_count || 0) === 0 && (
                              <button onClick={() => openPriceEdit(item)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                                title="Editar preço no marketplace">
                                <Edit3 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                            {hasDiscount && <span className="block text-[10px] text-gray-400 line-through">{formatPrice(item.original_price)}</span>}
                        </div>
                      </td>
                        <td className="py-2.5 px-2 text-center font-mono text-sm">
                          {item.variation_count > 0 ? '' : linked ? (
                            <div className="flex flex-col items-center gap-0.5">
                              {(() => {
                                const isComp = !!item.is_composite;
                                const shown = isComp ? (item.composite_qty ?? 0) : (item.real_quantity ?? 0);
                                return (
                                  <span className={Number(shown) <= 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-gray-900 dark:text-white'}
                                    title={isComp ? `Saldo calculado por componentes: ${shown}` : `Saldo direto do SKU: ${shown}`}>
                                    {shown}
                                  </span>
                                );
                              })()}
                              {(item.is_composite || item.has_components) && (
                                <span title="Este SKU é composto (kit). Saldo = MIN(componente / receita)" className="text-[9px] px-1 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 font-semibold">
                                  Composto
                                </span>
                              )}
                            </div>
                          ) : '-'}
                        </td>
                      <td className="py-2.5 px-2 text-center font-mono text-sm">
                        {item.variation_count > 0 ? '' : linked ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={Number(item.real_available ?? 0) <= 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-emerald-700 dark:text-emerald-400'}>
                              {item.real_available ?? 0}
                            </span>
                            {Number(item.open_orders_qty) > 0 && (
                              <span title={`${item.open_orders_qty} unidade(s) em pedidos abertos, descontados do real`} className="text-[9px] px-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium">
                                -{item.open_orders_qty}
                              </span>
                            )}
                          </div>
                        ) : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-center font-mono text-sm text-gray-900 dark:text-white">{item.stock_qty ?? '-'}</td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count > 0 ? '' : linked ? (() => {
                            const preview = item.use_real_stock
                              ? Number(item.real_available ?? 0)
                              : (item.fictitious_value != null
                                  ? Number(item.fictitious_value)
                                  : Math.floor((Number(item.fictitious_min || 0) + Number(item.fictitious_max || 0)) / 2));
                            return (
                              <button
                                type="button"
                                onClick={() => openRangeModal(item)}
                                className="text-xs text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                                title={`Próximo push enviará ${preview}`}>
                                <div className="leading-tight">
                                  <div>{item.use_real_stock ? 'Real' : `${item.fictitious_min}-${item.fictitious_max}`}</div>
                                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold">→ envia {preview}</div>
                                </div>
                              </button>
                            );
                          })() : '-'}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count === 0 && linked && <button onClick={() => handleToggleRealStock(item)} title={item.use_real_stock ? 'Usando estoque real' : 'Usando estoque fictício'}>{item.use_real_stock ? <ToggleRight className="w-6 h-6 text-green-600 dark:text-green-400 mx-auto" /> : <ToggleLeft className="w-6 h-6 text-gray-400 mx-auto" />}</button>}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                          {item.variation_count === 0 && linked && <button onClick={() => handleToggleEnabled(item)} title={item.enabled ? 'Sync ativo' : 'Sync desativado'}>{item.enabled ? <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400 mx-auto" /> : <AlertTriangle className="w-5 h-5 text-gray-400 mx-auto" />}</button>}
                      </td>
                      <td className="py-2.5 px-2">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                            {(item.source === 'ml' || item.source === 'shopee') && (
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
                            <button onClick={() => handleRefreshItem(item)}
                              disabled={refreshingItem[`${item.source}-${item.uid}`]}
                              className="p-1.5 rounded-md bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 hover:bg-violet-200 dark:hover:bg-violet-900/50 transition-colors disabled:opacity-50"
                              title="Atualizar dados deste anúncio diretamente do marketplace">
                              <RefreshCw className={`w-3.5 h-3.5 ${refreshingItem[`${item.source}-${item.uid}`] ? 'animate-spin' : ''}`} />
                            </button>
                            {linked && (
                              <button onClick={() => openHistoryModal(item)}
                                className="p-1.5 rounded-md bg-slate-100 dark:bg-slate-700/40 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700/60 transition-colors"
                                title="Ver histórico de estoque">
                                <History className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {item.variation_count === 0 && linked && <button onClick={() => handleUnlink(item)} className="p-1.5 rounded-md bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors" title="Desvincular"><Unlink className="w-3.5 h-3.5" /></button>}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && itemVars.length > 0 && itemVars.map(v => {
                        const combos = v.__combos || [];
                        const comboStr = v.__combo_str || '';
                        const vSku = v.__sku || '';
                        const vRefId = v.__ref_id || '';
                        const vAvailable = v.__available;
                        const vThumb = v.__thumbnail;
                        const varLinked = !!v.var_config_id;
                        const varPushKey = `var-${v.var_config_id}`;
                        const isMlVar = v.__src === 'ml';
                        return (
                          <tr key={`var-${v.__src}-${v.id}`} className="bg-violet-50/50 dark:bg-violet-900/10 border-b dark:border-gray-700/30">
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-3">
                              <div className="flex items-center gap-2 pl-4">
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0"></span>
                                {vThumb && <img src={vThumb} alt="" className="w-7 h-7 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                                <div className="min-w-0">
                                  {(() => { const inv = findInventoryBySku(vSku); return inv ? (
                                    <>
                                      <p className="text-xs text-violet-700 dark:text-violet-300 font-medium truncate max-w-[200px]" title={inv.title}>{inv.title}</p>
                                      <span className="text-[10px] text-gray-400">{comboStr || '—'} | ID: {vRefId}</span>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-xs text-violet-700 dark:text-violet-300 font-medium">{comboStr || `Variação ${vRefId}`}</p>
                                      <span className="text-[10px] text-gray-400">ID: {vRefId}</span>
                                    </>
                                  ); })()}
                                </div>
                              </div>
                            </td>
                            <td className="py-1.5 px-2"><span className="text-xs font-mono text-gray-600 dark:text-gray-400">{vSku || '-'}</span></td>
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-2"></td>
                            <td className="py-1.5 px-2 text-center">
                              {combos.length > 0 ? combos.map((c, ci) => (
                                <span key={ci} className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400 mr-0.5 mb-0.5">
                                  {c.value_name || c.value_id}
                                </span>
                              )) : (comboStr ? <span className="text-[10px] text-gray-500 dark:text-gray-400">{comboStr}</span> : '')}
                            </td>
                            <td className="py-1.5 px-2">
                              {varLinked ? (
                                <span className="flex items-center gap-1 text-green-700 dark:text-green-400 text-xs font-medium"><Link2 className="w-3 h-3" /> {v.var_linked_sku}</span>
                              ) : (() => {
                                const invMatch = findInventoryBySku(vSku);
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
                            <td className="py-1.5 px-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">
                              {varLinked ? <span title="Disponível em variações ainda não considera pedidos abertos nem kits — em breve." className="text-[10px]">—</span> : ''}
                            </td>
                            <td className="py-1.5 px-2 text-center font-mono text-xs text-gray-700 dark:text-gray-300">{vAvailable ?? '-'}</td>
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
                                {isMlVar && (
                                  <button onClick={() => { setManualStockModal(v); setManualStockQty(String(vAvailable || 0)); }} className="p-1 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors" title="Definir estoque manual"><Plus className="w-3 h-3" /></button>
                                )}
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
                  Página {currentPage} de {totalPages} • {itemsTotal} {itemsTotal === 1 ? 'anúncio' : 'anúncios'}
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
              <button onClick={() => setImportByIdModal({ marketplace: 'ml', itemId: '', accountId: '' })}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5"
                title="Importar um anúncio fornecendo o ID do item (ML ou Shopee)">
                <Link2 className="w-4 h-4" /> Importar por ID
              </button>
              <button onClick={() => setModelEditModal({ title: '', sku: '', ean: '', price: 0, available_quantity: 1, listing_type_id: 'gold_special', condition: 'new', buying_mode: 'buy_it_now', currency_id: 'BRL', category_id: '', description: '', video_id: '', _attributes: [], _variations: [], _shipping: null, _sale_terms: [], _pictures: [], _package: DEFAULT_PACKAGE_FORM(), _marketplace_mappings: DEFAULT_MARKETPLACE_MAPPINGS() })}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg transition-colors flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> Novo Modelo
              </button>
              <button type="button" onClick={() => setPackagePresetsModalOpen(true)}
                className="px-3 py-2 border border-amber-400/80 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 text-sm rounded-lg transition-colors flex items-center gap-1.5 hover:bg-amber-100 dark:hover:bg-amber-900/50">
                <Ruler className="w-4 h-4" /> Caixas
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
                  <div key={model.id} className="border dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 shadow-sm hover:shadow-md transition-shadow overflow-visible">
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
                              <div className="relative z-20">
                                <button onClick={(e) => { e.stopPropagation(); setOpenActionMenu(openActionMenu === model.id ? null : model.id); }}
                                  className="p-1 rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                                  <MoreVertical className="w-4 h-4" />
                                </button>
                                {openActionMenu === model.id && (
                                  <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-gray-800 rounded-lg shadow-xl border dark:border-gray-700 py-1 z-[200]"
                                    onClick={(e) => e.stopPropagation()}>
                                    <button onClick={() => {
                                      let _attributes = [], _variations = [], _shipping = null, _sale_terms = [], _pictures = [];
                                      try { _attributes = JSON.parse(model.attributes || '[]'); } catch {}
                                      try { _variations = JSON.parse(model.variations || '[]'); } catch {}
                                      try { _shipping = JSON.parse(model.shipping || 'null'); } catch {}
                                      try { _sale_terms = JSON.parse(model.sale_terms || '[]'); } catch {}
                                      try { _pictures = JSON.parse(model.pictures || '[]'); } catch {}
                                      setModelEditModal({ ...model, description: model.description || '', _attributes, _variations, _shipping, _sale_terms, _pictures, _package: parsePackageMeasuresFromModel(model), _marketplace_mappings: parseMarketplaceMappings(model.marketplace_mappings) });
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
                                    <button onClick={() => { openMultiPublishForModel(model); setOpenActionMenu(null); }}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Zap className="w-3.5 h-3.5 text-purple-500" /> Publicar em vários
                                    </button>
                                    <a href={`/api/ad-models/${model.id}/pictures/download`} target="_blank" rel="noreferrer"
                                      onClick={() => setOpenActionMenu(null)}
                                      className="w-full text-left px-3 py-2 text-sm flex items-center gap-2.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                      <Download className="w-3.5 h-3.5 text-purple-500" /> Download fotos
                                    </a>
                                    <button onClick={() => { const m = model; const dup = { ...m, id: undefined, title: `${m.title} (cópia)` }; setModelEditModal({ ...dup, description: dup.description || '', _attributes: (() => { try { return JSON.parse(m.attributes || '[]'); } catch { return []; } })(), _variations: (() => { try { return JSON.parse(m.variations || '[]'); } catch { return []; } })(), _shipping: (() => { try { return JSON.parse(m.shipping || 'null'); } catch { return null; } })(), _sale_terms: (() => { try { return JSON.parse(m.sale_terms || '[]'); } catch { return []; } })(), _pictures: (() => { try { return JSON.parse(m.pictures || '[]'); } catch { return []; } })(), _package: parsePackageMeasuresFromModel(m), _marketplace_mappings: parseMarketplaceMappings(m.marketplace_mappings) }); setOpenActionMenu(null); }}
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

      {/* D5 — Modal de histórico de estoque (movimentos + auditoria) */}
      {historyModal && (() => {
        const labelForAction = (e) => {
          if (e.kind === 'movement') {
            const map = { in: 'Entrada', out: 'Saída', adjustment: 'Ajuste' };
            return map[e.action] || e.action || 'Movimento';
          }
          const map = {
            push_manual: 'Push manual',
            push_auto: 'Push automático',
            push_bulk: 'Push em massa',
            config_update: 'Config. alterada',
            config_bulk_range: 'Faixa em massa',
          };
          return map[e.action] || e.action || 'Ação';
        };
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <History className="w-5 h-5" /> Histórico de estoque
                </h3>
                <button onClick={() => { setHistoryModal(null); setHistoryEntries([]); }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-2 truncate" title={historyModal.title}>
                {historyModal.linked_sku ? <span className="font-mono text-xs mr-2">{historyModal.linked_sku}</span> : ''}
                {historyModal.title}
              </p>
              <div className="flex-1 overflow-y-auto border dark:border-gray-700 rounded-lg min-h-0 divide-y divide-gray-100 dark:divide-gray-700/60">
                {historyLoading ? (
                  <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-blue-500 animate-spin" /></div>
                ) : historyEntries.length === 0 ? (
                  <div className="text-center py-8 text-gray-400 text-sm">Nenhum registro encontrado</div>
                ) : historyEntries.map((e, idx) => {
                  const isMovement = e.kind === 'movement';
                  const cls = isMovement
                    ? (e.action === 'in' ? 'text-emerald-700 dark:text-emerald-400' : e.action === 'out' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400')
                    : (e.action?.startsWith('push') ? 'text-blue-700 dark:text-blue-400' : 'text-violet-700 dark:text-violet-400');
                  const when = e.created_at ? new Date(e.created_at) : null;
                  return (
                    <div key={`${e.kind}-${e.id}-${idx}`} className="px-3 py-2 text-xs flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`font-semibold ${cls}`}>{labelForAction(e)}</span>
                          {e.target_marketplace && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 uppercase">{e.target_marketplace}</span>
                          )}
                          {e.user_name && <span className="text-gray-500 dark:text-gray-400">por {e.user_name}</span>}
                        </div>
                        <div className="mt-0.5 text-gray-600 dark:text-gray-300">
                          {isMovement ? (
                            <>Qtd: <span className="font-mono">{e.before_value ?? '?'}</span> → <span className="font-mono font-semibold">{e.after_value ?? '?'}</span>{e.meta && <span className="ml-2 text-gray-400">— {e.meta}</span>}</>
                          ) : (
                            <>
                              {e.before_value && <span className="font-mono text-[11px] text-gray-400">antes: {e.before_value} </span>}
                              {e.after_value && <span className="font-mono text-[11px] text-gray-700 dark:text-gray-300">depois: {e.after_value}</span>}
                            </>
                          )}
                        </div>
                      </div>
                      <span className="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap">{when ? when.toLocaleString('pt-BR') : '—'}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex justify-end">
                <button onClick={() => { setHistoryModal(null); setHistoryEntries([]); }}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Fechar</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* D2 — Modal de detalhes de divergência (real x marketplace) */}
      {divergenceModal && (() => {
        const real = Number(divergenceModal.real_quantity ?? 0);
        const available = Number(divergenceModal.real_available ?? real);
        const mkt = Number(divergenceModal.stock_qty ?? 0);
        const diff = mkt - available;
        const last = divergenceModal.last_pushed_at ? new Date(divergenceModal.last_pushed_at) : null;
        const pushing_ = !!pushing[`${divergenceModal.source}-${divergenceModal.config_id}`];
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Detalhes da divergência</h3>
                <button onClick={() => setDivergenceModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300 mb-3 truncate" title={divergenceModal.title}>{divergenceModal.title}</p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
                <div className="p-2 bg-gray-50 dark:bg-gray-700/50 rounded-md">
                  <div className="text-gray-500 dark:text-gray-400 mb-0.5">Real</div>
                  <div className="text-base font-mono font-bold text-gray-900 dark:text-white">{real}</div>
                </div>
                <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-md">
                  <div className="text-emerald-700 dark:text-emerald-400 mb-0.5">Disponível</div>
                  <div className="text-base font-mono font-bold text-emerald-700 dark:text-emerald-400">{available}</div>
                </div>
                <div className="p-2 bg-amber-50 dark:bg-amber-900/20 rounded-md">
                  <div className="text-amber-700 dark:text-amber-400 mb-0.5">Marketplace</div>
                  <div className="text-base font-mono font-bold text-amber-700 dark:text-amber-400">{mkt}</div>
                </div>
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1 mb-4">
                <div>Diferença: <span className={`font-semibold ${diff > 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}`}>{diff > 0 ? `+${diff}` : diff}</span> (marketplace - disponível)</div>
                <div>Último push: <span className="font-mono">{last ? last.toLocaleString('pt-BR') : '—'}</span></div>
                {Number(divergenceModal.open_orders_qty) > 0 && (
                  <div className="text-amber-700 dark:text-amber-400">
                    {divergenceModal.open_orders_qty} un. em pedidos abertos já descontadas do disponível.
                  </div>
                )}
                {divergenceModal.last_error_message && (
                  <div className="text-rose-700 dark:text-rose-400 truncate" title={divergenceModal.last_error_message}>
                    Último erro: {divergenceModal.last_error_message}
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setDivergenceModal(null)}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors">Fechar</button>
                <button onClick={async () => { await handlePush(divergenceModal); setDivergenceModal(null); }} disabled={pushing_}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2">
                  {pushing_ ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Corrigir agora
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* C2 — Modal de ajuste de faixa fictícia (single / bulk) */}
      {rangeModal && (() => {
        const bulk = rangeModal?.mode === 'bulk';
        const items = bulk ? (rangeModal.items || []) : [rangeModal];
        const count = items.filter(i => i.config_id).length;
        const minN = parseInt(rangeForm.min, 10);
        const maxN = parseInt(rangeForm.max, 10);
        const mid = Number.isFinite(minN) && Number.isFinite(maxN) && minN <= maxN ? Math.floor((minN + maxN) / 2) : null;
        const invalid = !Number.isFinite(minN) || !Number.isFinite(maxN) || minN < 0 || maxN < 0 || minN > maxN;
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  {bulk ? `Ajustar faixa fictícia (${count})` : 'Ajustar faixa fictícia'}
                </h3>
                <button onClick={() => setRangeModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
              </div>
              {!bulk && (
                <p className="text-sm text-gray-600 dark:text-gray-300 mb-3 truncate" title={rangeModal.title}>
                  {rangeModal.title}
                </p>
              )}
              {bulk && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                  A mesma faixa será aplicada em {count} configuração(ões) selecionada(s) (ML + Shopee).
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Mínimo
                  <input type="number" min="0" value={rangeForm.min}
                    onChange={e => setRangeForm(f => ({ ...f, min: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" autoFocus />
                </label>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Máximo
                  <input type="number" min="0" value={rangeForm.max}
                    onChange={e => setRangeForm(f => ({ ...f, max: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
                </label>
              </div>
              <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                {invalid ? (
                  <span className="text-rose-600 dark:text-rose-400">Valores inválidos — verifique mínimo ≤ máximo.</span>
                ) : (
                  <>No próximo push sem "Usar Real" será enviado <span className="font-semibold text-gray-900 dark:text-gray-100">{mid}</span> (ponto médio).</>
                )}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button onClick={() => setRangeModal(null)} disabled={rangeForm.saving}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors disabled:opacity-50">Cancelar</button>
                <button onClick={handleSaveRange} disabled={invalid || rangeForm.saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2">
                  {rangeForm.saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  Salvar
                </button>
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

      {priceEditModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Editar preço no marketplace</h3>
              <button onClick={() => setPriceEditModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-1 truncate" title={priceEditModal.item.title}>{priceEditModal.item.title}</p>
            <p className="text-[11px] text-gray-400 mb-3">
              {priceEditModal.item.source === 'ml' ? 'Mercado Livre' : 'Shopee'} · {priceEditModal.item.item_id_display}
            </p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Novo preço (R$)</label>
            <input type="number" min="0.01" step="0.01"
              value={priceEditModal.value}
              onChange={(e) => setPriceEditModal((m) => ({ ...m, value: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && savePriceEdit()}
              autoFocus
              className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-lg" />
            <p className="text-[10px] text-gray-400 mt-1">O valor será enviado diretamente ao marketplace.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPriceEditModal(null)} disabled={savingPrice}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-500 text-sm transition-colors disabled:opacity-50">Cancelar</button>
              <button onClick={savePriceEdit} disabled={savingPrice}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2">
                {savingPrice && <Loader2 className="w-4 h-4 animate-spin" />}
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}

      {varLinkModal && (() => {
        const nonComposite = inventory.filter(i => !i.is_composite);
        const varSku = ((varLinkModal.__sku ?? varLinkModal.sku) || '').trim();

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

        const comboStr = varLinkModal.__combo_str || (() => {
          let combos = [];
          try { combos = JSON.parse(varLinkModal.attribute_combinations || '[]'); } catch { /* noop */ }
          return combos.map(c => `${c.name || c.id}: ${c.value_name || '?'}`).join(' | ');
        })();
        const varRefId = varLinkModal.__ref_id ?? varLinkModal.variation_id ?? varLinkModal.model_id ?? '';

        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6" style={{ animation: 'modalFadeIn 0.25s ease-out' }}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Vincular Variação a SKU</h3>
              <button onClick={() => { setVarLinkModal(null); setLinkSearch(''); }} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-violet-600 dark:text-violet-400 mb-1">{comboStr || `Variação ${varRefId}`}</p>
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
      {/* Modais legados de Templates (edit/publish) foram removidos junto com a consolidação em ad_models. */}

      {/* Model Edit Modal */}
      {modelEditModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3 sm:p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-[min(72rem,98vw)] max-h-[92vh] overflow-y-auto p-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">{modelEditModal.id ? 'Editar Modelo' : 'Novo Modelo de Anúncio'}</h3>
              <button onClick={() => setModelEditModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            {SHOW_MODEL_MARKETPLACE_MAPPING_TAB && (
              <div className="flex flex-wrap gap-1.5 mb-3 border-b border-gray-200 dark:border-gray-600">
                <button
                  type="button"
                  onClick={() => setModelEditViewTab('detalhes')}
                  className={`px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
                    modelEditViewTab === 'detalhes'
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                  title="Informações compartilhadas: título, descrição, imagens, variações, preço e marca."
                >
                  Detalhes
                </button>
                <button
                  type="button"
                  onClick={() => setModelEditViewTab('mercadolivre')}
                  className={`px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
                    modelEditViewTab === 'mercadolivre'
                      ? 'border-yellow-500 text-yellow-600 dark:text-yellow-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                  title="Informações exclusivas do Mercado Livre: categoria ML e ficha técnica ML."
                >
                  <img src="/mercado-livre.png" alt="" className="w-4 h-4 rounded-sm object-contain" /> Mercado Livre
                </button>
                <button
                  type="button"
                  onClick={() => setModelEditViewTab('shopee')}
                  className={`px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
                    modelEditViewTab === 'shopee'
                      ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
                  title="Informações exclusivas da Shopee: categoria Shopee e ficha técnica Shopee."
                >
                  <img src="/shopee.png" alt="" className="w-4 h-4 rounded-sm object-contain" /> Shopee
                </button>
              </div>
            )}
            {(SHOW_MODEL_MARKETPLACE_MAPPING_TAB ? modelEditViewTab === 'detalhes' : true) && (
            <div className="space-y-4">
              {/* Bloco principal: texto + descrição — menos “ar livre” que campos soltos */}
              <div className="rounded-xl border border-slate-200/90 dark:border-slate-600/80 bg-slate-50/70 dark:bg-slate-900/35 p-4 space-y-3">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
                  <div className="lg:col-span-4 min-w-0">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Categoria</label>
                    <input type="text" value={modelEditModal.category_name || modelEditModal.category_id || '—'} readOnly
                      className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white/80 dark:bg-gray-800/80 text-gray-900 dark:text-white cursor-default leading-snug" />
                    {modelEditModal.category_id && (
                      <details className="mt-1.5 group">
                        <summary className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer select-none list-inside">
                          ID da categoria (técnico)
                        </summary>
                        <p className="text-[10px] font-mono text-gray-500 dark:text-gray-400 mt-1 pl-0.5 break-all">{modelEditModal.category_id}</p>
                      </details>
                    )}
                  </div>
                  <div className="lg:col-span-5 min-w-0">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Título <span className="text-gray-400 font-normal">({modelEditModal.title?.length || 0}/60)</span></label>
                    <input type="text" value={modelEditModal.title || ''} onChange={e => setModelEditModal(p => ({ ...p, title: e.target.value }))}
                      className={`w-full px-3 py-2 border rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white ${modelEditModal.title?.length > 60 ? 'border-yellow-400 dark:border-yellow-500' : 'dark:border-gray-600'}`} />
                  </div>
                  <div className="lg:col-span-3 min-w-0">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Condição</label>
                    <select value={modelEditModal.condition || 'new'} onChange={e => setModelEditModal(p => ({ ...p, condition: e.target.value }))}
                      className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                      <option value="new">Novo</option>
                      <option value="used">Usado</option>
                    </select>
                  </div>
                </div>

                {modelEditModal.title?.length > 60 && (
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-700 rounded-lg px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
                    <AlertTriangle className="w-4 h-4 inline mr-1 align-text-bottom" />
                    O título será cortado para 60 caracteres na publicação.
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Descrição</label>
                  <textarea rows={3} value={modelEditModal.description || ''} onChange={e => setModelEditModal(p => ({ ...p, description: e.target.value }))}
                    placeholder="Texto que aparecerá no anúncio…"
                    className="w-full min-h-[5.5rem] max-h-40 px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white resize-y leading-relaxed" />
                </div>
              </div>

              {/* Imagens — grelha compacta; URL editável sem ocupar sempre a linha inteira */}
              <div className="border border-gray-200 dark:border-gray-600 rounded-xl p-3 sm:p-4 space-y-2 bg-gray-50/50 dark:bg-gray-900/20">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Image className="w-4 h-4 text-blue-500 flex-shrink-0" />
                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">Imagens ({(modelEditModal._pictures || []).length})</span>
                  </div>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 text-right sm:text-left max-w-[16rem] sm:max-w-none leading-snug">
                    A primeira foto é a capa no ML · Arraste pela alça à esquerda para mudar a ordem
                  </span>
                </div>
                <input ref={modelPictureFileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="hidden" onChange={handleModelPictureFile} />
                {(modelEditModal._pictures || []).length === 0 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400">Nenhuma imagem. Adicione pelo menos uma antes de publicar.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[min(260px,38vh)] overflow-y-auto pr-0.5">
                    {(modelEditModal._pictures || []).map((p, pi) => (
                      <div
                        key={String(p.id || p.source || pi)}
                        className={`flex gap-2 p-2 rounded-lg bg-white dark:bg-gray-800 border transition-colors ${
                          modelPictureDragOverIndex === pi
                            ? 'border-blue-400 ring-2 ring-blue-400/35 bg-blue-50/60 dark:bg-blue-950/25 dark:border-blue-500'
                            : 'border-gray-100 dark:border-gray-700'
                        } ${modelPictureDraggingIndex === pi ? 'opacity-55' : ''}`}
                        onDragOver={(e) => handleModelPictureDragOver(e, pi)}
                        onDrop={(e) => handleModelPictureDrop(e, pi)}
                        onDragLeave={handleModelPictureDragLeaveCard}
                      >
                        <div
                          draggable
                          onDragStart={(e) => handleModelPictureDragStart(e, pi)}
                          onDragEnd={handleModelPictureDragEnd}
                          className="flex items-center gap-1.5 flex-shrink-0 cursor-grab active:cursor-grabbing select-none rounded-lg p-1 -m-0.5 hover:bg-gray-100/90 dark:hover:bg-gray-700/80"
                          title="Arrastar para reordenar"
                        >
                          <GripVertical className="w-4 h-4 text-gray-400 flex-shrink-0" aria-hidden />
                          <span className="text-[10px] text-gray-500 w-4 text-center font-bold tabular-nums">{pi + 1}</span>
                          <img
                            src={p.source || p.secure_url}
                            alt=""
                            draggable={false}
                            className="w-16 h-16 rounded-md object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0 border border-gray-100 dark:border-gray-600 pointer-events-none"
                            onError={(e) => { e.target.style.opacity = 0.35; }}
                          />
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col gap-1">
                          <details className="min-w-0">
                            <summary className="text-[11px] text-blue-600 dark:text-blue-400 cursor-pointer hover:underline list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1">
                              <Link2 className="w-3 h-3 shrink-0 opacity-70" />
                              Editar URL
                            </summary>
                            <p className="text-[10px] text-gray-400 truncate mt-1 mb-1" title={p.source || p.secure_url || ''}>{(p.source || p.secure_url || '').slice(0, 80)}{((p.source || p.secure_url || '').length > 80 ? '…' : '')}</p>
                            <label className="sr-only">URL da imagem</label>
                            <input
                              type="text"
                              value={p.source || p.secure_url || ''}
                              onChange={(e) => {
                                const u = [...(modelEditModal._pictures || [])];
                                u[pi] = { ...u[pi], source: e.target.value };
                                setModelEditModal((prev) => ({ ...prev, _pictures: u }));
                              }}
                              className="w-full mt-1 text-xs border border-gray-200 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                              placeholder="https://…"
                            />
                          </details>
                          <div className="flex justify-end pt-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                const pid = p.id;
                                const pics = [...(modelEditModal._pictures || [])];
                                pics.splice(pi, 1);
                                const vars = (modelEditModal._variations || []).map((vv) => ({
                                  ...vv,
                                  picture_ids: (vv.picture_ids || []).filter((x) => String(x) !== String(pid)),
                                }));
                                setModelEditModal((prev) => ({ ...prev, _pictures: pics, _variations: vars }));
                              }}
                              className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded"
                              title="Remover imagem"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                  <button type="button" onClick={openMediaLibrary}
                    className="px-4 py-2 border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950/40 text-purple-800 dark:text-purple-200 rounded-lg text-sm font-medium whitespace-nowrap flex items-center justify-center gap-2 hover:bg-purple-100 dark:hover:bg-purple-900/60"
                    title="Reaproveitar fotos de outros modelos">
                    <Image className="w-4 h-4" /> Biblioteca
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
                <div className="space-y-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800/50 p-3 sm:p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <label className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                        Ficha técnica <span className="font-normal text-gray-500 dark:text-gray-400">({(modelEditModal._attributes || []).length} campos)</span>
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 dark:border-gray-500 text-blue-600 focus:ring-blue-500"
                          checked={modelShowTechnicalIds}
                          onChange={(e) => setModelShowTechnicalIds(e.target.checked)}
                        />
                        Mostrar códigos ML
                      </label>
                      <details className="text-xs">
                        <summary className="cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 inline-flex items-center gap-1 list-none [&::-webkit-details-marker]:hidden">
                          <Info className="w-3.5 h-3.5" /> Ajuda
                        </summary>
                        <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400 leading-snug max-w-xl border-t border-gray-100 dark:border-gray-700 pt-2">
                          Os campos obrigatórios do Mercado Livre para esta categoria aparecem destacados. Cor, voltagem e similares editam-se em <strong className="font-medium text-gray-600 dark:text-gray-300">Variações</strong>, não aqui.
                        </p>
                      </details>
                    </div>
                    {modelCategorySchemaLoading && (
                      <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1.5 shrink-0">
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> A carregar regras…
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
                      placeholder="Buscar atributo…"
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

                  <div className="border border-gray-200 dark:border-gray-600 rounded-lg max-h-[min(32rem,52vh)] overflow-y-auto p-2 bg-gray-50/50 dark:bg-gray-900/20">
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
                            Rotação (rpm) costuma aparecer como <strong className="font-medium">velocidade máxima de rotação</strong> na lista{modelShowTechnicalIds && <> (<span className="font-mono">MAX_ROTATION_SPEED</span>)</>} ou na secção Variações.{modelShowTechnicalIds && <> «Frequência» (Hz) é outro campo (<span className="font-mono">FREQUENCY</span>).</>}
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
                                {modelShowTechnicalIds && (
                                  <span className="text-[9px] font-mono text-gray-400 dark:text-gray-500 shrink-0">{r.attr.id}</span>
                                )}
                              </div>
                              {r.def?.hint ? (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-1.5 leading-snug line-clamp-2" title={r.def.hint}>{r.def.hint}</p>
                              ) : null}
                              <div className="flex flex-wrap gap-1 mb-1.5">
                                {r.ignored && (
                                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-300">Ignorado</span>
                                )}
                                {!r.ignored && r.required && (
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200">Obrigatório</span>
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
                              <div className="mt-1 text-[9px] text-gray-500 dark:text-gray-400 flex flex-wrap justify-between gap-x-2 gap-y-0 min-h-[1rem]">
                                <span className="tabular-nums">
                                  {!modelShowTechnicalIds ? (
                                    <>
                                      {!hasList && typeof maxLen === 'number' && maxLen > 0 ? `${val.length}/${maxLen}` : null}
                                      {hasList ? <span className="text-gray-400">Lista fechada</span> : null}
                                    </>
                                  ) : hasList ? (
                                    <span className="font-mono">lista ML</span>
                                  ) : (
                                    <>
                                      {typeof maxLen === 'number' && maxLen > 0 ? `${val.length}/${maxLen}` : val.length > 0 ? `${val.length} caracteres` : null}
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
                      setVariationPickerRequested(true);
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
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Vincular ao estoque
                      <span className="ml-1 text-gray-400 font-normal">(sincroniza saldo com o inventário)</span>
                    </label>
                    <InventoryAutocomplete
                      value={modelEditModal.inventory_id || null}
                      onChange={(id) => setModelEditModal((p) => ({ ...p, inventory_id: id }))}
                      placeholder="Buscar item do estoque por SKU, título ou EAN…"
                    />
                  </div>
                </div>
              )}
            </div>
            )}

            {SHOW_MODEL_MARKETPLACE_MAPPING_TAB && modelEditViewTab === 'mercadolivre' && modelEditModal && (() => {
              const mm = parseMarketplaceMappings(modelEditModal._marketplace_mappings);
              const ch = mm.channels;
              const updateChannel = (channelKey, patch) => {
                setModelEditModal((p) => {
                  const m = parseMarketplaceMappings(p._marketplace_mappings);
                  return {
                    ...p,
                    _marketplace_mappings: {
                      ...m,
                      channels: { ...m.channels, [channelKey]: { ...m.channels[channelKey], ...patch } },
                    },
                  };
                });
              };
              const updateShared = (patch) => {
                setModelEditModal((p) => {
                  const m = parseMarketplaceMappings(p._marketplace_mappings);
                  return {
                    ...p,
                    _marketplace_mappings: { ...m, canonical: { ...m.canonical, ...patch } },
                  };
                });
              };
              return (
                <div className="space-y-5 max-h-[min(70vh,840px)] overflow-y-auto pr-1 text-sm">
                  {/* Aba Mercado Livre: explicação curta, sem misturar com Shopee. */}
                  <div className="rounded-xl border border-yellow-200 dark:border-yellow-800 bg-yellow-50/60 dark:bg-yellow-950/25 p-4 text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                    <p className="font-semibold text-gray-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                      <img src="/mercado-livre.png" alt="" className="w-4 h-4 rounded-sm object-contain" /> Informações exclusivas do Mercado Livre
                    </p>
                    <p className="mb-0">
                      A categoria ML e a ficha técnica ML continuam na aba <strong>Detalhes</strong> (são usadas também para definir variações do modelo). Aqui ficam apenas informações compartilhadas (marca, modelo, etc.), notas internas e a validação do payload ML.
                    </p>
                  </div>
                  {/* Resumo da categoria ML + notas internas */}
                  <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <img src="/mercado-livre.png" alt="" className="w-6 h-6 rounded-sm object-contain" />
                      <span className="font-semibold text-gray-900 dark:text-white">Categoria do Mercado Livre</span>
                    </div>
                    <div className="text-xs">
                      <span className="text-gray-500 dark:text-gray-400">Categoria: </span>
                      <span className="font-mono text-gray-700 dark:text-gray-200">{modelEditModal.category_id || '— não definida —'}</span>
                      {modelEditModal.category_name && <span className="ml-1 text-gray-600 dark:text-gray-300">({modelEditModal.category_name})</span>}
                    </div>
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">
                      Para alterar a categoria ou preencher a ficha técnica ML, volte à aba <strong>Detalhes</strong>.
                    </p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mt-2">Observações internas (Mercado Livre)</label>
                      <textarea rows={2}
                        value={ch.mercadolivre.notes || ''}
                        onChange={(e) => updateChannel('mercadolivre', { notes: e.target.value })}
                        className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                        placeholder="Anote aqui informações só para a sua equipe (não são enviadas ao ML)" />
                    </div>
                  </div>

                  {/* Informações compartilhadas — usadas também por outros canais */}
                  <div className="rounded-xl border border-gray-200 dark:border-gray-600 p-4 space-y-3 bg-white dark:bg-gray-800/50">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe className="w-4 h-4 text-gray-500" />
                      <h4 className="font-semibold text-gray-900 dark:text-white">Informações compartilhadas entre canais</h4>
                    </div>
                    <p className="text-[11px] text-gray-500 dark:text-gray-400 -mt-1.5">Valores que valem para qualquer marketplace. Preencha uma vez e serão reaproveitados nas publicações.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { key: 'brand', label: 'Marca', placeholder: 'ex.: Lumi' },
                        { key: 'model_name', label: 'Nome do modelo', placeholder: 'ex.: Trilho Spot Completo' },
                        { key: 'material', label: 'Material principal', placeholder: 'ex.: Alumínio' },
                        { key: 'color', label: 'Cor principal', placeholder: 'ex.: Preto' },
                      ].map(({ key, label, placeholder }) => (
                        <div key={key}>
                          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
                          <input
                            type="text"
                            value={mm.canonical[key] || ''}
                            placeholder={placeholder}
                            onChange={(e) => updateShared({ [key]: e.target.value })}
                            className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Amazon/Leroy Merlin — seção recolhida, fora do escopo atual */}
                  <details className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/30">
                    <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-gray-600 dark:text-gray-300 flex items-center gap-2">
                      <ChevronRight className="w-3.5 h-3.5" /> Outros marketplaces (Amazon / Leroy Merlin) — integração futura
                    </summary>
                    <div className="px-4 pb-4 pt-1 text-xs text-gray-500 dark:text-gray-400 space-y-3">
                      <p>Estas integrações ainda não publicam automaticamente. Os campos aqui são apenas para referência interna.</p>

                      <div className="rounded-lg border border-gray-200 dark:border-gray-600 p-3 space-y-2 bg-white dark:bg-gray-800/40">
                        <div className="flex items-center gap-2">
                          <img src="/amazon.png" alt="" className="w-5 h-5 rounded-sm object-contain" />
                          <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Amazon</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input type="text" value={ch.amazon.product_type || ''}
                            onChange={(e) => updateChannel('amazon', { product_type: e.target.value })}
                            placeholder="Product type (ex.: LAMP)"
                            className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 font-mono text-gray-900 dark:text-white" />
                          <input type="text" value={ch.amazon.browse_node || ''}
                            onChange={(e) => updateChannel('amazon', { browse_node: e.target.value })}
                            placeholder="Browse node"
                            className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <textarea rows={2} value={ch.amazon.notes || ''}
                          onChange={(e) => updateChannel('amazon', { notes: e.target.value })}
                          placeholder="Notas Amazon"
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                      </div>

                      <div className="rounded-lg border border-gray-200 dark:border-gray-600 p-3 space-y-2 bg-white dark:bg-gray-800/40">
                        <div className="flex items-center gap-2">
                          <img src="/leroy-merlin.png" alt="" className="w-5 h-5 rounded-sm object-contain" />
                          <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Leroy Merlin</span>
                        </div>
                        <input type="text" value={ch.leroy_merlin?.category_id || ''}
                          onChange={(e) => updateChannel('leroy_merlin', { category_id: e.target.value })}
                          placeholder="Categoria interna LM"
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        <textarea rows={2} value={ch.leroy_merlin?.notes || ''}
                          onChange={(e) => updateChannel('leroy_merlin', { notes: e.target.value })}
                          placeholder="Notas Leroy Merlin"
                          className="w-full px-2 py-1.5 border dark:border-gray-600 rounded text-xs bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                      </div>
                    </div>
                  </details>

                  {/* Validação para publicação no Mercado Livre */}
                  <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/15 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-indigo-500" />
                      <span className="font-semibold text-gray-900 dark:text-white">Validação Mercado Livre</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400">Dispara uma verificação local + no backend antes de publicar no Mercado Livre. Identifica campos vazios, atributos obrigatórios do ML e outros problemas.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={modelValidationLoading || !modelEditModal.id}
                        onClick={() => runModelValidation('ml')}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200 hover:bg-yellow-200 dark:hover:bg-yellow-900/60 disabled:opacity-50 inline-flex items-center gap-1.5">
                        {modelValidationLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <img src="/mercado-livre.png" alt="" className="w-3.5 h-3.5" />}
                        Validar para Mercado Livre
                      </button>
                      {!modelEditModal.id && (
                        <span className="text-[11px] text-gray-500 italic self-center">Salve o modelo primeiro para validar.</span>
                      )}
                    </div>
                    {modelValidationResult && modelValidationResult.marketplace === 'ml' && (
                      <div className={`rounded-lg border p-3 text-xs ${modelValidationResult.ok ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30' : 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-gray-900 dark:text-white uppercase tracking-wide">
                            Mercado Livre — {modelValidationResult.ok ? 'Pronto para publicar' : 'Precisa ajustes'}
                          </span>
                          <button type="button" onClick={() => setModelValidationResult(null)} className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                        {(modelValidationResult.issues || []).length > 0 && (
                          <div>
                            <p className="text-red-700 dark:text-red-300 font-medium mb-1">Pendências:</p>
                            <ul className="list-disc pl-5 space-y-0.5 text-red-700 dark:text-red-300">
                              {modelValidationResult.issues.map((it, i) => (
                                <li key={i}><span className="font-mono text-[10px] opacity-70">[{it.code}]</span> {it.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {(modelValidationResult.warnings || []).length > 0 && (
                          <div className="mt-2">
                            <p className="text-amber-700 dark:text-amber-300 font-medium mb-1">Alertas:</p>
                            <ul className="list-disc pl-5 space-y-0.5 text-amber-700 dark:text-amber-300">
                              {modelValidationResult.warnings.map((it, i) => (
                                <li key={i}><span className="font-mono text-[10px] opacity-70">[{it.code}]</span> {it.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {SHOW_MODEL_MARKETPLACE_MAPPING_TAB && modelEditViewTab === 'shopee' && modelEditModal && (() => {
              const mm = parseMarketplaceMappings(modelEditModal._marketplace_mappings);
              const shopeeCh = mm.channels.shopee;
              const updateShopeeChannel = (patch) => {
                setModelEditModal((p) => {
                  const m = parseMarketplaceMappings(p._marketplace_mappings);
                  return {
                    ...p,
                    _marketplace_mappings: {
                      ...m,
                      channels: { ...m.channels, shopee: { ...m.channels.shopee, ...patch } },
                    },
                  };
                });
              };
              const updateShopeeAttrs = (attrs) => updateShopeeChannel({ attributes: attrs });
              return (
                <div className="space-y-4 max-h-[min(70vh,840px)] overflow-y-auto pr-1 text-sm">
                  {/* Intro — explica o papel da aba e distingue das demais */}
                  <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-950/25 p-4 text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                    <p className="font-semibold text-gray-900 dark:text-white mb-1.5 flex items-center gap-1.5">
                      <img src="/shopee.png" alt="" className="w-4 h-4 rounded-sm object-contain" /> Informações exclusivas da Shopee
                    </p>
                    <p className="mb-0">
                      Cada categoria da Shopee tem seu próprio código e seus próprios atributos obrigatórios, que <strong>não são os mesmos</strong> do Mercado Livre. Aqui você define a categoria Shopee, preenche a ficha técnica Shopee (com importação automática de value_ids) e valida antes de publicar.
                    </p>
                  </div>

                  {/* Passo 1: categoria Shopee + autocomplete + hint baseado na cat ML */}
                  <ShopeeMappingBlock
                    channel={shopeeCh}
                    mlCategoryName={modelEditModal.category_name}
                    mlCategoryId={modelEditModal.category_id}
                    shopeeAccounts={shopeeAccounts}
                    onChange={updateShopeeChannel}
                  />

                  {/* Passo 2: ficha técnica Shopee — só faz sentido depois de ter categoria */}
                  {shopeeCh.category_id ? (
                    <>
                      <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/20 px-3 py-2 text-[11px] text-gray-600 dark:text-gray-400">
                        Categoria Shopee selecionada: <span className="font-mono text-gray-800 dark:text-gray-200">{shopeeCh.category_id}</span>
                        {shopeeCh.category_name && <> — {shopeeCh.category_name}</>}
                      </div>
                      <ShopeeAttributesBlock
                        accountId={shopeeAccounts[0]?.id || ''}
                        categoryId={shopeeCh.category_id}
                        value={shopeeCh.attributes || {}}
                        onChange={updateShopeeAttrs}
                        autoOpenImport={!!modelEditModal?._openShopeeImport}
                      />
                    </>
                  ) : (
                    <div className="rounded-xl border border-dashed border-orange-300 dark:border-orange-700 bg-orange-50/30 dark:bg-orange-950/10 p-4 text-xs text-gray-500 dark:text-gray-400">
                      Defina a <strong>categoria Shopee</strong> acima para carregar a ficha técnica (atributos obrigatórios, dropdowns com value_ids oficiais etc.).
                    </div>
                  )}

                  {/* Notas internas Shopee */}
                  <div className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800/50 p-4 space-y-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Observações internas (Shopee)</label>
                    <textarea rows={2}
                      value={shopeeCh.notes || ''}
                      onChange={(e) => updateShopeeChannel({ notes: e.target.value })}
                      className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      placeholder="Notas de operação Shopee (não são enviadas para a Shopee)." />
                  </div>

                  {/* Validação Shopee */}
                  <div className="rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50/40 dark:bg-orange-950/15 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-5 h-5 text-orange-500" />
                      <span className="font-semibold text-gray-900 dark:text-white">Validação Shopee</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-400">Verifica categoria, atributos obrigatórios, value_ids e payload antes de publicar na Shopee.</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={modelValidationLoading || !modelEditModal.id}
                        onClick={() => runModelValidation('shopee')}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 hover:bg-orange-200 dark:hover:bg-orange-900/60 disabled:opacity-50 inline-flex items-center gap-1.5">
                        {modelValidationLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <img src="/shopee.png" alt="" className="w-3.5 h-3.5" />}
                        Validar para Shopee
                      </button>
                      {!modelEditModal.id && (
                        <span className="text-[11px] text-gray-500 italic self-center">Salve o modelo primeiro para validar.</span>
                      )}
                    </div>
                    {modelValidationResult && modelValidationResult.marketplace === 'shopee' && (
                      <div className={`rounded-lg border p-3 text-xs ${modelValidationResult.ok ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30' : 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-gray-900 dark:text-white uppercase tracking-wide">
                            Shopee — {modelValidationResult.ok ? 'Pronto para publicar' : 'Precisa ajustes'}
                          </span>
                          <button type="button" onClick={() => setModelValidationResult(null)} className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                        {(modelValidationResult.issues || []).length > 0 && (
                          <div>
                            <p className="text-red-700 dark:text-red-300 font-medium mb-1">Pendências:</p>
                            <ul className="list-disc pl-5 space-y-0.5 text-red-700 dark:text-red-300">
                              {modelValidationResult.issues.map((it, i) => (
                                <li key={i}><span className="font-mono text-[10px] opacity-70">[{it.code}]</span> {it.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {(modelValidationResult.warnings || []).length > 0 && (
                          <div className="mt-2">
                            <p className="text-amber-700 dark:text-amber-300 font-medium mb-1">Alertas:</p>
                            <ul className="list-disc pl-5 space-y-0.5 text-amber-700 dark:text-amber-300">
                              {modelValidationResult.warnings.map((it, i) => (
                                <li key={i}><span className="font-mono text-[10px] opacity-70">[{it.code}]</span> {it.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Preview local do payload Shopee (tier_variations + modelos) */}
                    {(() => {
                      const vars = modelEditModal._variations || [];
                      if (vars.length === 0) return null;
                      const tierMap = new Map();
                      for (const v of vars) {
                        for (const c of v.attribute_combinations || []) {
                          const name = (c.name || c.id || '').toString().trim();
                          if (!name) continue;
                          if (!tierMap.has(name)) tierMap.set(name, new Set());
                          const opt = (c.value_name || c.value_id || '').toString().trim();
                          if (opt) tierMap.get(name).add(opt);
                        }
                      }
                      const tiers = Array.from(tierMap.entries()).map(([name, set]) => ({ name, options: Array.from(set) }));
                      return (
                        <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-white/60 dark:bg-gray-900/30 p-3 text-[11px] space-y-1">
                          <p className="font-semibold text-gray-700 dark:text-gray-200">Preview Shopee (payload init_tier_variation)</p>
                          <p>Tiers detectados: <strong>{tiers.length}</strong> {tiers.length > 2 && <span className="text-amber-600 dark:text-amber-400">(Shopee aceita no máximo 2 — tiers extras serão ignorados)</span>}</p>
                          <ul className="list-disc pl-5 space-y-0.5">
                            {tiers.map((t, i) => (
                              <li key={i}><span className="font-medium">{t.name}</span>: {t.options.join(', ') || '—'}</li>
                            ))}
                          </ul>
                          <p>Modelos (variações) que serão criados: <strong>{vars.length}</strong></p>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })()}

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

              {/* STEP 2: Shopee publish */}
              {step === 2 && pm.marketplace === 'shopee' && (
                <>
                  <div className="flex items-center gap-2 mb-4 text-xs text-gray-500 dark:text-gray-400">
                    <img src="/shopee.png" alt="" className="w-4 h-4 object-contain" />
                    <span>Conta: <strong className="text-gray-700 dark:text-gray-300">{selectedAccount?.name || '?'}</strong></span>
                  </div>

                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Preço base</p>
                  <div className="relative mb-4">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">R$</span>
                    <input type="number" step="0.01" min="0" value={pm.price}
                      onChange={(e) => setModelPublishModal((p) => ({ ...p, price: Number(e.target.value) }))}
                      className="w-full pl-10 pr-3 py-2.5 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-medium" />
                  </div>

                  {pm.variations && pm.variations.length > 0 && (
                    <div className="mb-4">
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Variações ({pm.variations.length})</p>
                      <div className="border dark:border-gray-600 rounded-lg divide-y dark:divide-gray-700 max-h-56 overflow-y-auto">
                        {pm.variations.map((v, i) => {
                          const label = (v.attribute_combinations || []).map((c) => c.value_name).filter(Boolean).join(' / ') || v.seller_custom_field || `Variação ${i + 1}`;
                          return (
                            <div key={i} className="flex items-center gap-2 px-3 py-2 text-xs">
                              <span className="flex-1 truncate" title={label}>{label}</span>
                              <span className="text-gray-400">SKU {v.seller_custom_field || '—'}</span>
                              <span className="text-gray-400">Qtd {v.available_quantity ?? 0}</span>
                              <span className="text-gray-700 dark:text-gray-200 font-mono">R$ {Number(v.price) > 0 ? Number(v.price).toFixed(2) : Number(pm.price).toFixed(2)}</span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-gray-400 mt-1">Edite preços/SKU/estoque por variação dentro de «Editar Modelo». A Shopee aceita até 2 tiers de variação.</p>
                    </div>
                  )}

                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 mb-4">
                    <div className="flex items-start gap-2">
                      <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-blue-700 dark:text-blue-300">
                        Certifique-se de que o <strong>category_id da Shopee</strong> está preenchido em <em>Modelo → Mapeamento multi-marketplace</em>.
                        A logística será inferida automaticamente dos canais ativos da conta.
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-between gap-3 pt-2 border-t dark:border-gray-700">
                    <button onClick={() => setModelPublishModal((p) => ({ ...p, step: 1 }))}
                      className="px-4 py-2 border dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1">
                      <ChevronRight className="w-4 h-4 rotate-180" /> Voltar
                    </button>
                    <button onClick={handleModelPublish} disabled={modelPublishing}
                      className="px-5 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-orange-400 text-white rounded-lg text-sm font-medium flex items-center gap-2">
                      {modelPublishing ? <><RefreshCw className="w-4 h-4 animate-spin" /> Publicando…</> : <><Send className="w-4 h-4" /> Publicar na Shopee</>}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Multi-destination Publish Modal (1 clique, N destinos) */}
      {multiPublishModal && (() => {
        const mp = multiPublishModal;
        const isTargetSelected = (marketplace, accountId) => mp.targets.some((t) => t.marketplace === marketplace && Number(t.accountId) === Number(accountId));
        const getTarget = (marketplace, accountId) => mp.targets.find((t) => t.marketplace === marketplace && Number(t.accountId) === Number(accountId));
        const allAccounts = [
          ...mlAccounts.map((a) => ({ ...a, _mp: 'ml' })),
          ...shopeeAccounts.map((a) => ({ ...a, _mp: 'shopee' })),
        ];
        const doneCount = mp.targets.filter((t) => t.status === 'ok').length;
        const errorCount = mp.targets.filter((t) => t.status === 'error').length;

        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                    <Zap className="w-5 h-5 text-purple-500" /> Publicar em múltiplos destinos
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">{mp.modelTitle} {mp.modelSku && `(${mp.modelSku})`}</p>
                </div>
                <button onClick={() => { if (!multiPublishRunning) setMultiPublishModal(null); }} disabled={multiPublishRunning}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {allAccounts.length === 0 ? (
                <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-800 dark:text-amber-200">
                  Nenhuma conta conectada. Conecte pelo menos uma conta Mercado Livre ou Shopee para publicar.
                </div>
              ) : (
                <>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Selecione as contas de destino. Você pode sobrescrever o preço por destino. A publicação é feita sequencialmente com um pequeno intervalo para respeitar rate limits das APIs.</p>

                  <div className="space-y-4 mb-4">
                    {mlAccounts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                          <img src="/mercado-livre.png" alt="" className="w-4 h-4" /> Mercado Livre
                        </p>
                        <div className="space-y-1.5">
                          {mlAccounts.map((acc) => {
                            const selected = isTargetSelected('ml', acc.id);
                            const t = getTarget('ml', acc.id);
                            return (
                              <div key={`ml-${acc.id}`} className={`rounded-lg border p-2 flex items-center gap-3 ${selected ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-950/20' : 'border-gray-200 dark:border-gray-700'}`}>
                                <input type="checkbox" checked={selected} disabled={multiPublishRunning}
                                  onChange={() => toggleMultiTarget('ml', acc.id, acc.name)} className="w-4 h-4" />
                                <span className="flex-1 text-sm text-gray-900 dark:text-white truncate" title={acc.name}>{acc.name}</span>
                                {selected && (
                                  <>
                                    <div className="relative">
                                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">R$</span>
                                      <input type="number" step="0.01" min="0" value={t?.price ?? ''} disabled={multiPublishRunning}
                                        onChange={(e) => updateMultiTargetField('ml', acc.id, 'price', Number(e.target.value))}
                                        className="w-24 pl-7 pr-2 py-1 text-xs border dark:border-gray-600 rounded bg-white dark:bg-gray-700" />
                                    </div>
                                    <select value={t?.listing_type_id || 'gold_special'} disabled={multiPublishRunning}
                                      onChange={(e) => updateMultiTargetField('ml', acc.id, 'listing_type_id', e.target.value)}
                                      className="text-xs py-1 border dark:border-gray-600 rounded bg-white dark:bg-gray-700">
                                      <option value="gold_special">Clássico</option>
                                      <option value="gold_pro">Premium</option>
                                    </select>
                                  </>
                                )}
                                {t?.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
                                {t?.status === 'ok' && <CheckCircle className="w-4 h-4 text-green-500" />}
                                {t?.status === 'error' && <AlertTriangle className="w-4 h-4 text-red-500" />}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {shopeeAccounts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-1.5">
                          <img src="/shopee.png" alt="" className="w-4 h-4" /> Shopee
                        </p>
                        <div className="space-y-1.5">
                          {shopeeAccounts.map((acc) => {
                            const selected = isTargetSelected('shopee', acc.id);
                            const t = getTarget('shopee', acc.id);
                            return (
                              <div key={`sh-${acc.id}`} className={`rounded-lg border p-2 flex items-center gap-3 ${selected ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/20' : 'border-gray-200 dark:border-gray-700'}`}>
                                <input type="checkbox" checked={selected} disabled={multiPublishRunning}
                                  onChange={() => toggleMultiTarget('shopee', acc.id, acc.name || `Shopee ${acc.id}`)} className="w-4 h-4" />
                                <span className="flex-1 text-sm text-gray-900 dark:text-white truncate" title={acc.name}>{acc.name || `Shopee ${acc.id}`}</span>
                                {selected && (
                                  <div className="relative">
                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">R$</span>
                                    <input type="number" step="0.01" min="0" value={t?.price ?? ''} disabled={multiPublishRunning}
                                      onChange={(e) => updateMultiTargetField('shopee', acc.id, 'price', Number(e.target.value))}
                                      className="w-24 pl-7 pr-2 py-1 text-xs border dark:border-gray-600 rounded bg-white dark:bg-gray-700" />
                                  </div>
                                )}
                                {t?.status === 'running' && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
                                {t?.status === 'ok' && <CheckCircle className="w-4 h-4 text-green-500" />}
                                {t?.status === 'error' && <AlertTriangle className="w-4 h-4 text-red-500" />}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {multiPublishResults && (
                    <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
                      <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Resultado: {doneCount}/{mp.targets.length} publicados {errorCount > 0 && <span className="text-red-500">• {errorCount} com erro</span>}</p>
                      <div className="space-y-1 max-h-40 overflow-auto">
                        {mp.targets.map((t, i) => (
                          <div key={i} className="text-[11px] flex items-center gap-2">
                            <span className="w-14 font-mono uppercase text-gray-500">{t.marketplace}</span>
                            <span className="flex-1 truncate">{t.accountName}</span>
                            {t.status === 'ok' ? (
                              <a href={t.permalink || '#'} target="_blank" rel="noreferrer" className="text-green-600 dark:text-green-400 inline-flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" /> {t.item_id}
                              </a>
                            ) : t.status === 'error' ? (
                              <span className="text-red-600 dark:text-red-400 truncate max-w-[200px]" title={t.error}>{t.error}</span>
                            ) : (
                              <span className="text-gray-400">aguardando…</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end gap-2 pt-3 border-t dark:border-gray-700">
                    <button onClick={() => setMultiPublishModal(null)} disabled={multiPublishRunning}
                      className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-40">Fechar</button>
                    <button onClick={handleMultiPublishRun} disabled={multiPublishRunning || mp.targets.length === 0}
                      className="px-5 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white rounded-lg text-sm font-medium inline-flex items-center gap-2">
                      {multiPublishRunning ? <><RefreshCw className="w-4 h-4 animate-spin" /> Publicando {mp.targets.length} destino(s)…</> : <><Zap className="w-4 h-4" /> Publicar em {mp.targets.length || '0'} destino(s)</>}
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
      {mediaLibraryModal?.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-4xl p-6 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  <Image className="w-5 h-5 text-purple-500" /> Biblioteca de mídia
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Reaproveite fotos usadas em outros modelos. Selecione uma ou mais para adicionar ao modelo atual.</p>
              </div>
              <button onClick={() => setMediaLibraryModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input type="text" placeholder="Filtrar por título ou SKU do modelo de origem…"
                value={mediaLibrarySearch} onChange={(e) => setMediaLibrarySearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
            </div>

            <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg">
              {mediaLibraryLoading ? (
                <div className="flex items-center justify-center py-12 text-sm text-gray-500"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando biblioteca…</div>
              ) : mediaLibraryItems.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-gray-500">Nenhuma imagem encontrada.</div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 p-2">
                  {mediaLibraryItems.map((it) => {
                    const selected = mediaLibrarySelected.has(it.url);
                    return (
                      <button key={it.url} type="button"
                        onClick={() => setMediaLibrarySelected((prev) => { const next = new Set(prev); if (next.has(it.url)) next.delete(it.url); else next.add(it.url); return next; })}
                        className={`relative group rounded-lg border-2 overflow-hidden text-left transition-all ${selected ? 'border-purple-500 ring-2 ring-purple-400/50' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}>
                        <img src={it.url} alt="" className="w-full aspect-square object-cover bg-gray-100 dark:bg-gray-700"
                          onError={(e) => { e.target.style.opacity = 0.25; }} />
                        {selected && (
                          <div className="absolute inset-0 bg-purple-500/30 flex items-center justify-center">
                            <CheckCircle className="w-8 h-8 text-white drop-shadow" />
                          </div>
                        )}
                        {it.usage_count > 1 && (
                          <span className="absolute top-1 right-1 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5">×{it.usage_count}</span>
                        )}
                        <div className="p-1.5 bg-white dark:bg-gray-800">
                          <p className="text-[10px] text-gray-600 dark:text-gray-400 truncate" title={it.source_model_title}>{it.source_model_title || '—'}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 pt-3 mt-3 border-t dark:border-gray-700">
              <span className="text-xs text-gray-500 dark:text-gray-400">{mediaLibrarySelected.size} selecionada(s) · {mediaLibraryItems.length} disponíveis</span>
              <div className="flex gap-2">
                <button onClick={() => setMediaLibraryModal(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">Cancelar</button>
                <button onClick={addSelectedMediaToModel} disabled={mediaLibrarySelected.size === 0}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white rounded-lg text-sm font-medium inline-flex items-center gap-2">
                  <Plus className="w-4 h-4" /> Adicionar {mediaLibrarySelected.size > 0 ? `(${mediaLibrarySelected.size})` : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {importByIdModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                <Link2 className="w-5 h-5 text-indigo-500" /> Importar por ID
              </h3>
              <button onClick={() => !importByIdLoading && setImportByIdModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">Cole o ID do anúncio do marketplace para criar (ou atualizar) o modelo correspondente.</p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Marketplace</label>
                <div className="flex gap-2">
                  {[{ id: 'ml', label: 'Mercado Livre', icon: '/mercado-livre.png' }, { id: 'shopee', label: 'Shopee', icon: '/shopee.png' }].map((opt) => (
                    <button key={opt.id} type="button"
                      onClick={() => setImportByIdModal((p) => ({ ...p, marketplace: opt.id, accountId: '' }))}
                      className={`flex-1 px-3 py-2 text-sm rounded-lg border flex items-center justify-center gap-2 transition-colors ${importByIdModal.marketplace === opt.id ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300' : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}>
                      <img src={opt.icon} alt="" className="w-4 h-4" /> {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {importByIdModal.marketplace === 'shopee' ? 'Shopee item_id' : 'ID do anúncio (MLB...)'}
                </label>
                <input type="text" value={importByIdModal.itemId}
                  onChange={(e) => setImportByIdModal((p) => ({ ...p, itemId: e.target.value }))}
                  placeholder={importByIdModal.marketplace === 'shopee' ? 'ex: 12345678901' : 'ex: MLB1234567890'}
                  className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Conta</label>
                <select value={importByIdModal.accountId}
                  onChange={(e) => setImportByIdModal((p) => ({ ...p, accountId: e.target.value }))}
                  className="w-full px-3 py-2 border dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white">
                  <option value="">Selecione a conta…</option>
                  {(importByIdModal.marketplace === 'shopee' ? shopeeAccounts : mlAccounts).map((acc) => (
                    <option key={acc.id} value={acc.id}>{acc.name || `Conta ${acc.id}`}</option>
                  ))}
                </select>
                {(importByIdModal.marketplace === 'shopee' ? shopeeAccounts : mlAccounts).length === 0 && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">Nenhuma conta conectada para este marketplace.</p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-4 mt-4 border-t dark:border-gray-700">
              <button onClick={() => setImportByIdModal(null)} disabled={importByIdLoading}
                className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-40">Cancelar</button>
              <button onClick={handleImportById} disabled={importByIdLoading || !importByIdModal.itemId || !importByIdModal.accountId}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white rounded-lg text-sm font-medium inline-flex items-center gap-2">
                {importByIdLoading ? <><RefreshCw className="w-4 h-4 animate-spin" /> Importando…</> : <><Download className="w-4 h-4" /> Importar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {modelImportModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">Importar de Anúncio Ativo</h3>
              <button onClick={() => setModelImportModal(null)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Selecione um anúncio ativo (Mercado Livre ou Shopee) para criar o modelo:</p>
            <div className="flex-1 overflow-y-auto border dark:border-gray-700 rounded-lg min-h-0" style={{ maxHeight: '500px' }}>
              {items.filter((i) => i.source === 'ml' || i.source === 'shopee').length === 0 ? (
                <div className="text-center py-8 text-gray-400 text-sm">Nenhum anúncio sincronizado. Sincronize primeiro na aba "Anúncios Ativos".</div>
              ) : items.filter((i) => i.source === 'ml' || i.source === 'shopee').map((item) => (
                <button key={item.uid} onClick={async () => { await handleModelImportFromItem(item); setModelImportModal(null); }}
                  className="w-full text-left px-4 py-3 hover:bg-blue-50 dark:hover:bg-blue-900/30 border-b dark:border-gray-700/50 transition-colors flex items-center gap-3">
                  {item.thumbnail && <img src={item.thumbnail} alt="" className="w-10 h-10 rounded object-cover bg-gray-100 dark:bg-gray-700 flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      {sourceBadge(item)}
                      <p className="text-sm text-gray-900 dark:text-white font-medium truncate">{item.title}</p>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-400">
                      <span>{item.item_id_display}</span>
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
