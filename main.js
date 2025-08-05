const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');

let mainWindow;

function createWindow() {
  // Criar a janela do navegador
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true
    },
    icon: path.join(__dirname, 'assets/icon.png'),
    show: false,
    titleBarStyle: 'default',
    autoHideMenuBar: false
  });

  // Carregar a aplicação
  if (isDev) {
    // Em desenvolvimento, carrega o servidor de desenvolvimento
    mainWindow.loadURL('http://localhost:3001');
    mainWindow.webContents.openDevTools();
  } else {
    // Em produção, carrega o arquivo build
    mainWindow.loadFile(path.join(__dirname, 'client/build/index.html'));
  }

  // Mostrar a janela quando estiver pronta
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Fechar a janela quando a aplicação for fechada
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevenir navegação para URLs externas
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    if (isDev && parsedUrl.origin === 'http://localhost:3001') {
      return; // Permitir navegação local em desenvolvimento
    }
    
    if (parsedUrl.protocol === 'file:') {
      return; // Permitir arquivos locais
    }
    
    event.preventDefault();
  });
}

// Este método será chamado quando o Electron terminar de inicializar
app.whenReady().then(() => {
  createWindow();

  // Criar menu personalizado
  const template = [
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Sobre Apoli',
          click: () => {
            // Mostrar informações sobre a aplicação
            require('electron').dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Sobre Apoli',
              message: 'Apoli - Sistema de Gestão',
              detail: 'Versão 2.0.0\nSistema completo de gestão com controle de estoque, SKUs compostos e APIs externas.'
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Sair',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit();
          }
        }
      ]
    },
    {
      label: 'Visualizar',
      submenu: [
        {
          label: 'Recarregar',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            mainWindow.reload();
          }
        },
        {
          label: 'Forçar Recarregamento',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            mainWindow.webContents.reloadIgnoringCache();
          }
        },
        { type: 'separator' },
        {
          label: 'Ferramentas de Desenvolvedor',
          accelerator: 'F12',
          click: () => {
            mainWindow.webContents.toggleDevTools();
          }
        }
      ]
    },
    {
      label: 'Janela',
      submenu: [
        {
          label: 'Minimizar',
          accelerator: 'CmdOrCtrl+M',
          click: () => {
            mainWindow.minimize();
          }
        },
        {
          label: 'Fechar',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            mainWindow.close();
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
});

// Quit quando todas as janelas estiverem fechadas
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Prevenir múltiplas instâncias
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Alguém tentou executar uma segunda instância, devemos focar nossa janela
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
} 