# 🚀 Instalação Rápida - Apoli Sistema de Gestão

## Pré-requisitos

- **Windows 10/11**
- **Node.js 16+** (baixe em: https://nodejs.org/)
- **Conexão com internet** (para baixar dependências)

## ⚡ Instalação em 3 Passos

### Passo 1: Verificar Node.js
Abra o PowerShell ou Prompt de Comando e execute:
```bash
node --version
npm --version
```

Se não funcionar, instale o Node.js primeiro.

### Passo 2: Instalar o Sistema
Execute o script de instalação:
```bash
install.bat
```

O script irá:
- ✅ Verificar Node.js
- ✅ Instalar dependências
- ✅ Criar configurações
- ✅ Preparar o sistema

### Passo 3: Iniciar a Aplicação
Execute o script de inicialização:
```bash
start.bat
```

A aplicação estará disponível em: **http://localhost:3001**

## 🎯 Modos de Uso

### Modo Desenvolvimento (Recomendado)
```bash
npm run dev
```
- Frontend: http://localhost:3000
- Backend: http://localhost:3001
- Hot reload ativado

### Modo Produção
```bash
npm start
```
- Aplicação completa: http://localhost:3001
- Otimizado para performance

### Modo Desktop (Electron)
```bash
npm run electron
```
- Aplicação como programa desktop
- Interface nativa do Windows

## 🌐 Acesso na Rede

Para acessar de outros computadores:

1. **Descubra seu IP**:
   ```bash
   ipconfig
   ```

2. **Acesse de outros computadores**:
   ```
   http://[SEU_IP]:3001
   ```

## 🔧 Scripts Úteis

| Script | Função |
|--------|--------|
| `install.bat` | Instala dependências |
| `start.bat` | Inicia aplicação |
| `update.bat` | Atualiza sistema |
| `package.bat` | Cria executável |
| `clean.bat` | Limpa arquivos |
| `health-check.bat` | Verifica sistema |

## 🐛 Solução de Problemas

### Erro: "Node.js não encontrado"
- Instale o Node.js: https://nodejs.org/
- Reinicie o computador
- Execute `install.bat` novamente

### Erro: "Porta em uso"
```bash
taskkill /f /im node.exe
```

### Erro: "Dependências não encontradas"
```bash
clean.bat
install.bat
```

### Erro: "Acesso negado"
- Execute como Administrador
- Verifique antivírus/firewall

## 📞 Suporte

Se encontrar problemas:

1. Execute `health-check.bat`
2. Consulte o `README.md`
3. Verifique os logs do sistema

## 🎉 Próximos Passos

Após a instalação:

1. **Configure o estoque**:
   - Adicione produtos
   - Configure categorias
   - Defina preços

2. **Configure SKUs compostos**:
   - Leia `INSTRUCOES_SKU_COMPOSTO.md`
   - Crie produtos compostos
   - Configure componentes

3. **Configure APIs externas**:
   - Adicione endpoints
   - Configure chaves
   - Teste conectividade

4. **Faça backup**:
   - O sistema faz backup automático
   - Mantenha cópias do banco de dados

---

**🎯 Sistema pronto para uso!** 