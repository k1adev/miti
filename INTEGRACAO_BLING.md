# Integração com API do Bling

## Visão Geral

O sistema Apoli agora possui integração com a API do Bling para extrair informações das notas fiscais de saída e facilitar a gestão de pedidos para expedição.

## Configuração

### 1. Criar Aplicativo no Bling

1. Acesse a [Central de Extensões do Bling](https://www.bling.com.br/central-extensoes)
2. Clique em "Área do Integrador"
3. Clique em "CRIAR NOVO APLICATIVO"
4. Configure o aplicativo:
   - **Visibilidade**: Privado (para uso na própria conta)
   - **Nome**: Apoli Sistema de Gestão
   - **Categoria**: Gestão de estoques
   - **Descrição**: Sistema para gestão de estoque e pedidos
   - **Link de redirecionamento**: `http://localhost:3000/api/bling/callback`
   - **Escopos**: `notasfiscais.read`

### 2. Configurar Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

```env
# Configurações do Bling API
BLING_CLIENT_ID=seu_client_id_aqui
BLING_CLIENT_SECRET=seu_client_secret_aqui
BLING_REDIRECT_URI=http://localhost:3000/api/bling/callback
```

### 3. Instalar Dependências

```bash
npm install
```

## Como Usar

### 1. Autorização

1. Acesse a tela "Pedidos" no sistema
2. Clique em "Autorizar Bling"
3. Siga o fluxo de autorização no Bling
4. Após autorizar, o sistema estará conectado

### 2. Buscar Notas Fiscais

1. Na tela "Pedidos", clique em "Buscar Notas"
2. O sistema irá buscar as notas fiscais de saída do Bling
3. As notas serão exibidas em uma tabela

### 3. Aglutinar e Imprimir Pedidos

1. Selecione as notas fiscais desejadas usando os checkboxes
2. Clique em "Imprimir Selecionados"
3. O sistema irá:
   - Agrupar itens por SKU
   - Somar quantidades
   - Identificar marketplaces
   - Gerar relatório para impressão

## Funcionalidades

### Extração de Dados
- Notas fiscais de saída
- Informações do cliente
- Itens e quantidades
- Valores e datas

### Aglutinação Inteligente
- Agrupamento por SKU
- Soma de quantidades
- Identificação de marketplaces
- Eliminação de duplicatas

### Impressão
- Relatório formatado
- Informações organizadas
- Layout otimizado para impressão

## Estrutura do Relatório

O relatório impresso contém:

| Campo | Descrição |
|-------|-----------|
| Nome | Nome do produto |
| SKU | Código do produto |
| Quantidade | Quantidade total aglutinada |
| Marketplace | Origem do pedido |

## Identificação de Marketplaces

O sistema identifica automaticamente a origem dos pedidos:

- **Marketplace**: Notas com "MKT" no número
- **E-commerce**: Notas com "WEB" na série
- **Loja Física**: Notas que começam com "1"
- **Outros**: Demais origens

## Troubleshooting

### Erro de Autorização
- Verifique se o aplicativo está ativo no Bling
- Confirme se os escopos estão corretos
- Refaça a autorização se necessário

### Erro de Conexão
- Verifique as variáveis de ambiente
- Confirme se o servidor está rodando
- Teste a conectividade com a API do Bling

### Token Expirado
- O sistema renova automaticamente os tokens
- Se falhar, reautorize o aplicativo

## Limitações

- Apenas leitura de dados (não edita)
- Notas fiscais de saída apenas
- Máximo de 50 notas por requisição
- Depende da conectividade com a API do Bling

## Suporte

Para problemas técnicos, verifique:
1. Logs do servidor
2. Console do navegador
3. Status da API do Bling
4. Configurações de rede 