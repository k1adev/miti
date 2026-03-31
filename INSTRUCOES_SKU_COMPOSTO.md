# Instruções - SKUs Compostos

## O que são SKUs Compostos?

SKUs Compostos são produtos que são montados a partir de outros SKUs do estoque. Eles permitem controlar a composição de produtos complexos e automatizar o processo de montagem.

## Exemplo Prático

**Produto Final**: Kit de Montagem Completo (SKU: KIT001)
- **Componente 1**: Base Metálica (SKU: BASE001) - 1 unidade
- **Componente 2**: Parafusos (SKU: PAR001) - 4 unidades
- **Componente 3**: Manual (SKU: MAN001) - 1 unidade

## Como Criar um SKU Composto

### Passo 1: Cadastrar o Produto Principal

1. Vá para a seção "Estoque"
2. Clique em "Adicionar Item"
3. Preencha os dados básicos:
   - **SKU**: KIT001
   - **Título**: Kit de Montagem Completo
   - **Quantidade**: 0 (será montado conforme necessário)
4. **IMPORTANTE**: Marque a caixa "SKU Composto"
5. Salve o item

### Passo 2: Configurar os Componentes

1. Na lista de estoque, encontre o SKU KIT001
2. Clique no botão "Gerenciar Componentes" (ícone de engrenagem)
3. Adicione os componentes:
   - SKU: BASE001, Quantidade: 1
   - SKU: PAR001, Quantidade: 4
   - SKU: MAN001, Quantidade: 1
4. Salve a configuração

### Passo 3: Montar o Produto

1. Na lista de estoque, encontre o SKU KIT001
2. Clique no botão "Montar SKU" (ícone de chave inglesa)
3. Defina a quantidade a montar (ex: 5)
4. O sistema irá:
   - Verificar se há componentes suficientes
   - Consumir os componentes do estoque
   - Adicionar o produto montado ao estoque
   - Registrar a movimentação

## Funcionalidades Avançadas

### Cálculo de Capacidade

O sistema calcula automaticamente quantas unidades podem ser montadas baseado no estoque disponível dos componentes:

```
Capacidade = min(Componente1/Quantidade1, Componente2/Quantidade2, ...)
```

### Histórico de Movimentações

Todas as operações de montagem são registradas:
- Data e hora da montagem
- Quantidade montada
- Componentes consumidos
- Usuário responsável

### Alertas de Estoque

O sistema alerta quando:
- Não há componentes suficientes para montagem
- Estoque de componentes está baixo
- Produto montado está com estoque baixo

## Casos de Uso Comuns

### 1. Kits de Produtos

**Exemplo**: Kit de Limpeza
- Detergente (1 unidade)
- Esponja (2 unidades)
- Luvas (1 par)

### 2. Produtos Montados

**Exemplo**: Computador Montado
- Processador (1 unidade)
- Memória RAM (2 unidades)
- Placa-mãe (1 unidade)
- Fonte (1 unidade)

### 3. Embalagens Especiais

**Exemplo**: Caixa de Presente
- Caixa (1 unidade)
- Fita decorativa (1 rolo)
- Cartão (1 unidade)

## Dicas Importantes

### 1. Planejamento

- Defina claramente os componentes necessários
- Estabeleça quantidades precisas
- Considere perdas e desperdícios

### 2. Controle de Qualidade

- Verifique componentes antes da montagem
- Mantenha padrões de qualidade
- Documente problemas encontrados

### 3. Gestão de Estoque

- Monitore níveis de componentes
- Estabeleça estoque mínimo
- Planeje reposição antecipada

### 4. Custos

- Calcule custo total do produto montado
- Acompanhe variações de preço
- Analise rentabilidade

## Troubleshooting

### Problema: "Componentes insuficientes"

**Solução**:
1. Verifique o estoque dos componentes
2. Reponha componentes em falta
3. Tente montar quantidade menor

### Problema: "SKU não encontrado"

**Solução**:
1. Verifique se o SKU do componente existe
2. Confirme a grafia do SKU
3. Cadastre o componente se necessário

### Problema: "Erro na montagem"

**Solução**:
1. Verifique se todos os componentes estão cadastrados
2. Confirme as quantidades configuradas
3. Tente novamente com quantidade menor

## Relatórios Disponíveis

### 1. Relatório de Capacidade

Mostra quantas unidades podem ser montadas de cada SKU composto.

### 2. Relatório de Movimentações

Histórico completo de montagens e consumos.

### 3. Relatório de Componentes

Análise de uso dos componentes em SKUs compostos.

## Integração com Vendas

SKUs compostos podem ser vendidos normalmente:
1. O sistema verifica se há estoque disponível
2. Se necessário, monta automaticamente
3. Registra a venda normalmente

## Backup e Segurança

- Todas as configurações são salvas no banco de dados
- Backup automático antes de atualizações
- Histórico completo de alterações

---

**Nota**: Esta funcionalidade é especialmente útil para empresas que montam produtos, criam kits ou trabalham com produtos compostos por outros itens do estoque. 