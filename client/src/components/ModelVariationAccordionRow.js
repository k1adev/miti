import React from 'react';
import { ChevronUp, ChevronRight, Star, Trash2 } from 'lucide-react';

/** Normaliza para comparar nome digitado com o catálogo ML (acentos, maiúsculas). */
function normalizeMatch(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Converte texto num único campo em value_id + value_name.
 * Se existir valor no catálogo (ID exato ou nome exato), usa o par do ML; senão, texto livre (só value_name).
 */
function resolveComboFromCatalogText(input, catalogValues) {
  const t = String(input || '').trim();
  if (!t) return { value_id: null, value_name: '' };
  const vals = catalogValues || [];
  if (vals.length === 0) return { value_id: null, value_name: t };

  const byId = vals.find((v) => String(v.id) === t);
  if (byId) return { value_id: String(byId.id), value_name: byId.name || t };

  const n = normalizeMatch(t);
  const byName = vals.find((v) => normalizeMatch(v.name || '') === n);
  if (byName) return { value_id: String(byName.id), value_name: byName.name };

  return { value_id: null, value_name: t };
}

/** Texto exibido no input: nome do catálogo se há value_id válido, senão value_name. */
function displayComboInputValue(ac, catalogValues) {
  if (!ac) return '';
  const vals = catalogValues || [];
  if (ac.value_id && vals.length) {
    const opt = vals.find((x) => String(x.id) === String(ac.value_id));
    if (opt) return opt.name || ac.value_name || '';
  }
  return ac.value_name || '';
}

function formatVariationLabel(v) {
  const combos = v.attribute_combinations || [];
  const parts = combos.map((c) => (c.value_name || c.value_id || '').toString().trim()).filter(Boolean);
  return parts.length ? parts.join(' / ') : '';
}

function getVariationGtin(v) {
  const attrs = v.attributes || [];
  const a = attrs.find((x) => x && /^(GTIN|EAN|UPC)$/i.test(String(x.id || '')));
  if (!a) return '';
  return String(a.value_name || a.value_id || '').trim();
}

function patchVariationGtin(v, gtin) {
  const attrs = [...(v.attributes || [])];
  const idx = attrs.findIndex((x) => x && /^(GTIN|EAN|UPC)$/i.test(String(x.id || '')));
  const id = idx >= 0 ? attrs[idx].id : 'GTIN';
  const trimmed = String(gtin || '').trim();
  if (!trimmed) {
    if (idx >= 0) attrs.splice(idx, 1);
  } else if (idx >= 0) {
    attrs[idx] = { ...attrs[idx], id, value_name: trimmed, value_id: null };
  } else {
    attrs.push({ id: 'GTIN', value_name: trimmed, value_id: null });
  }
  return { ...v, attributes: attrs };
}

function swatchColorFromVariation(v) {
  const combos = v.attribute_combinations || [];
  const color = combos.find((c) => /COLOR|COR|PAINT|FINISH/i.test(c.id || ''));
  const s = (color?.value_name || '').toLowerCase();
  const named = {
    preto: '#1a1a1a', black: '#1a1a1a', branco: '#f3f4f6', white: '#f3f4f6', cinza: '#9ca3af', gray: '#9ca3af',
    marrom: '#5d4037', brown: '#5d4037', bege: '#d7ccc8', vermelho: '#c62828', red: '#c62828',
    azul: '#1565c0', blue: '#1565c0', verde: '#2e7d32', green: '#2e7d32', amarelo: '#f9a825', yellow: '#f9a825',
    'dourado ou champanhe': '#c9a227', 'rose gold': '#b76e79', prata: '#c0c0c0', silver: '#c0c0c0', cromado: '#a8a8a8',
  };
  for (const [k, hex] of Object.entries(named)) {
    if (s.includes(k)) return hex;
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 38%, 52%)`;
}

export function ModelVariationAccordionRow({
  vi,
  modelEditModal,
  setModelEditModal,
  modelCategorySchema,
  modelVariationExpanded,
  setModelVariationExpanded,
  modelVariationAxisAttrs,
  setModelVariationAxisChoice,
}) {
  const vars = modelEditModal._variations || [];
  const v = vars[vi];
  if (!v) return null;
  const allPics = modelEditModal._pictures || [];
  const expanded = modelVariationExpanded.has(vi);
  const label = formatVariationLabel(v) || `Variação ${vi + 1}`;
  const gtin = getVariationGtin(v);
  const qty = v.available_quantity ?? 0;
  const sku = v.seller_custom_field || '';

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800/40 overflow-hidden shadow-sm">
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          setModelVariationExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(vi)) next.delete(vi); else next.add(vi);
            return next;
          });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setModelVariationExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(vi)) next.delete(vi); else next.add(vi);
              return next;
            });
          }
        }}
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded-t-xl transition-colors cursor-pointer"
      >
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />}
        <span
          className="w-3.5 h-3.5 rounded-full border border-gray-200 dark:border-gray-600 flex-shrink-0 shadow-inner"
          style={{ background: swatchColorFromVariation(v) }}
          title="Cor (aprox.)"
        />
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate flex-1 min-w-0">{label}</span>
        {vi === 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200 flex-shrink-0">
            <Star className="w-3 h-3" /> Principal
          </span>
        )}
        {!expanded && (
          <>
            <span className="text-[11px] text-gray-500 dark:text-gray-400 hidden sm:inline">Estoque <strong className="text-gray-700 dark:text-gray-200 font-medium">{qty}</strong></span>
            {gtin ? <span className="text-[10px] text-gray-400 font-mono truncate max-w-[100px] hidden md:inline" title={gtin}>{gtin}</span> : null}
            {sku ? <span className="text-[11px] text-gray-500 truncate max-w-[72px] hidden lg:inline">SKU {sku}</span> : null}
          </>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const oldLen = (modelEditModal._variations || []).length;
            setModelEditModal((p) => {
              const nv = (p._variations || []).filter((_, j) => j !== vi);
              if (nv.length === 0 && modelVariationAxisAttrs.length > 0) {
                queueMicrotask(() => setModelVariationAxisChoice(null));
              }
              return { ...p, _variations: nv };
            });
            setModelVariationExpanded((prev) => {
              const next = new Set();
              prev.forEach((i) => {
                if (i === vi) return;
                if (i > vi) next.add(i - 1);
                else next.add(i);
              });
              if (next.size === 0 && oldLen > 1) next.add(0);
              return next;
            });
          }}
          className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 flex-shrink-0"
          title="Remover variação"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-3 space-y-4 bg-gray-50/50 dark:bg-gray-900/20">
          <div className="space-y-2">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Combinação de atributos</span>
            {(v.attribute_combinations || []).map((ac, aci) => {
              const schemaAttr = (modelCategorySchema || []).find((s) => s.id === ac.id);
              const vals = schemaAttr?.values;
              const mandatory = schemaAttr?.tags?.required === true;
              return (
                <div key={aci} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
                  <div className="sm:col-span-4 text-xs text-gray-600 dark:text-gray-300 font-medium pt-2">
                    {schemaAttr?.name || ac.name || ac.id}
                    {mandatory ? <span className="text-red-600 dark:text-red-400 font-normal"> (obrigatório)</span> : null}
                  </div>
                  <div className="sm:col-span-8">
                    {(() => {
                      const hasCatalog = vals && vals.length > 0;
                      const maxLen = typeof schemaAttr?.value_max_length === 'number' && schemaAttr.value_max_length > 0
                        ? schemaAttr.value_max_length
                        : 255;
                      return (
                        <input
                          type="text"
                          value={displayComboInputValue(ac, vals)}
                          maxLength={maxLen}
                          placeholder="Valor"
                          onChange={(e) => {
                            const txt = e.target.value;
                            const u = [...(modelEditModal._variations || [])];
                            const combos = [...(u[vi].attribute_combinations || [])];
                            const cur = combos[aci] || {};
                            combos[aci] = { ...cur, value_id: null, value_name: txt };
                            u[vi] = { ...u[vi], attribute_combinations: combos };
                            setModelEditModal((prev) => ({ ...prev, _variations: u }));
                          }}
                          onBlur={(e) => {
                            const txt = e.target.value.trim();
                            const u = [...(modelEditModal._variations || [])];
                            const combos = [...(u[vi].attribute_combinations || [])];
                            const cur = combos[aci] || {};
                            const resolved = hasCatalog
                              ? resolveComboFromCatalogText(txt, vals)
                              : { value_id: null, value_name: txt };
                            combos[aci] = { ...cur, ...resolved };
                            u[vi] = { ...u[vi], attribute_combinations: combos };
                            setModelEditModal((prev) => ({ ...prev, _variations: u }));
                          }}
                          className="w-full text-sm border border-gray-200 dark:border-gray-600 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder:text-gray-400"
                        />
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
          {allPics.length > 0 && (
            <div>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide block mb-2">Fotos desta variação</span>
              <div className="flex flex-wrap gap-3">
                {allPics.map((pp, ppi) => {
                  const selected = (v.picture_ids || []).some((pid) => String(pid) === String(pp.id));
                  const firstId = (v.picture_ids || [])[0];
                  const isCover = selected && String(pp.id) === String(firstId);
                  return (
                    <div key={String(pp.id || ppi)} className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 ${selected ? 'border-blue-400 bg-blue-50/50 dark:bg-blue-950/30' : 'border-gray-200 dark:border-gray-600'}`}>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={selected} onChange={() => {
                          const u = [...(modelEditModal._variations || [])];
                          const keyStr = String(pp.id);
                          const raw = u[vi].picture_ids || [];
                          const has = raw.some((x) => String(x) === keyStr);
                          const nextIds = has ? raw.filter((x) => String(x) !== keyStr) : [...raw, pp.id];
                          u[vi] = { ...u[vi], picture_ids: nextIds };
                          setModelEditModal((prev) => ({ ...prev, _variations: u }));
                        }} className="rounded" />
                        <img src={pp.source || pp.secure_url} alt="" className="w-12 h-12 rounded object-cover bg-gray-100" />
                      </label>
                      <span className="text-[10px] text-gray-500">Foto {ppi + 1}</span>
                      {selected && (
                        <button
                          type="button"
                          onClick={() => {
                            setModelEditModal((p) => {
                              const vvs = [...(p._variations || [])];
                              const vv = { ...vvs[vi] };
                              const ids = [...(vv.picture_ids || [])].map(String);
                              const key = String(pp.id);
                              vv.picture_ids = [pp.id, ...ids.filter((x) => x !== key)];
                              vvs[vi] = vv;
                              return { ...p, _variations: vvs };
                            });
                          }}
                          className="text-[10px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          {isCover ? 'Capa' : 'Usar como capa'}
                        </button>
                      )}
                      {isCover && <span className="text-[9px] font-bold text-blue-700 dark:text-blue-300 uppercase">Capa</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Estoque no depósito</label>
              <input type="number" value={v.available_quantity ?? 0} onChange={(e) => {
                const u = [...(modelEditModal._variations || [])];
                u[vi] = { ...u[vi], available_quantity: parseInt(e.target.value, 10) || 0 };
                setModelEditModal((prev) => ({ ...prev, _variations: u }));
              }} className="w-full px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Código universal (GTIN/EAN)</label>
              <input
                type="text"
                inputMode="numeric"
                value={gtin}
                onChange={(e) => {
                  const u = [...(modelEditModal._variations || [])];
                  u[vi] = patchVariationGtin(u[vi], e.target.value);
                  setModelEditModal((prev) => ({ ...prev, _variations: u }));
                }}
                className="w-full px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700" placeholder="ex.: 7893313557070"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">SKU (identificação)</label>
              <input type="text" value={v.seller_custom_field || ''} onChange={(e) => {
                const u = [...(modelEditModal._variations || [])];
                u[vi] = { ...u[vi], seller_custom_field: e.target.value };
                setModelEditModal((prev) => ({ ...prev, _variations: u }));
              }} className="w-full px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500 block mb-0.5">Preço (R$)</label>
              <input type="number" step="0.01" value={v.price ?? ''} onChange={(e) => {
                const u = [...(modelEditModal._variations || [])];
                u[vi] = { ...u[vi], price: parseFloat(e.target.value) || 0 };
                setModelEditModal((prev) => ({ ...prev, _variations: u }));
              }} className="w-full px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded text-sm bg-white dark:bg-gray-700" />
            </div>
          </div>
          {vi === 0 ? null : (
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700 dark:text-gray-200">
              <input
                type="radio"
                name="model-main-variation"
                className="rounded-full border-gray-300 text-blue-600"
                onChange={() => {
                  setModelEditModal((p) => {
                    const arr = [...(p._variations || [])];
                    const [item] = arr.splice(vi, 1);
                    arr.unshift(item);
                    return { ...p, _variations: arr };
                  });
                  setModelVariationExpanded(new Set([0]));
                }}
              />
              Definir como variação principal (move para o topo)
            </label>
          )}
        </div>
      )}
    </div>
  );
}
