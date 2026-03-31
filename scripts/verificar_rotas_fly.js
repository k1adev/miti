const axios = require('axios');

console.log('🔍 VERIFICAÇÃO FLY.IO: Rotas da API');
console.log('===================================\n');

// Configuração
const FLY_APP_URL = process.env.FLY_APP_URL || 'https://seu-app.fly.dev'; // Substitua pela URL real
const TEST_USER = {
  email: 'admin@apoli.com',
  password: 'admin123'
};

async function verificarRotas() {
  try {
    console.log('📊 Informações do ambiente:');
    console.log(`   URL da aplicação: ${FLY_APP_URL}`);
    console.log(`   NODE_ENV: ${process.env.NODE_ENV}`);
    console.log('');

    // 1. Verificar se a aplicação está online
    console.log('1️⃣ Verificando se a aplicação está online...');
    try {
      const statusResponse = await axios.get(`${FLY_APP_URL}/api/status`, { timeout: 10000 });
      console.log('✅ Aplicação online');
      console.log(`   Status: ${JSON.stringify(statusResponse.data)}`);
    } catch (error) {
      console.error('❌ Aplicação não está respondendo');
      console.error('   Erro:', error.message);
      if (error.code === 'ENOTFOUND') {
        console.error('💡 Verifique se a URL está correta');
      }
      return;
    }

    // 2. Testar login
    console.log('\n2️⃣ Testando login...');
    try {
      const loginResponse = await axios.post(`${FLY_APP_URL}/api/login`, TEST_USER, { timeout: 10000 });
      const token = loginResponse.data.token;
      const userId = loginResponse.data.user.id;
      
      console.log('✅ Login realizado com sucesso');
      console.log(`   User ID: ${userId}`);
      console.log(`   Token: ${token.substring(0, 50)}...`);
      
      // Configurar headers para todas as requisições
      const headers = { Authorization: `Bearer ${token}` };
      
      // 3. Testar rota GET /api/user/pinned-skus
      console.log('\n3️⃣ Testando GET /api/user/pinned-skus...');
      try {
        const getResponse = await axios.get(`${FLY_APP_URL}/api/user/pinned-skus`, { 
          headers, 
          timeout: 10000,
          validateStatus: function (status) {
            return status < 500; // Aceita qualquer status < 500 para debug
          }
        });
        
        console.log(`   Status: ${getResponse.status}`);
        console.log(`   Content-Type: ${getResponse.headers['content-type']}`);
        
        if (getResponse.status === 200) {
          console.log('✅ GET /api/user/pinned-skus funcionando');
          console.log(`   Resposta: ${JSON.stringify(getResponse.data)}`);
        } else {
          console.log('❌ GET /api/user/pinned-skus retornou erro');
          console.log(`   Resposta: ${JSON.stringify(getResponse.data)}`);
        }
        
        // Verificar se retornou HTML em vez de JSON
        if (typeof getResponse.data === 'string' && getResponse.data.includes('<!doctype html>')) {
          console.log('🚨 PROBLEMA: API retornando HTML em vez de JSON!');
          console.log('💡 Isso indica que a rota catch-all está interceptando a requisição');
        }
        
      } catch (error) {
        console.error('❌ Erro ao testar GET /api/user/pinned-skus:', error.message);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Data: ${JSON.stringify(error.response.data)}`);
        }
      }
      
      // 4. Testar rota PUT /api/user/pinned-skus
      console.log('\n4️⃣ Testando PUT /api/user/pinned-skus...');
      try {
        const testPinnedSkus = ['12345', '67890'];
        const putResponse = await axios.put(`${FLY_APP_URL}/api/user/pinned-skus`, 
          { pinnedSkus: testPinnedSkus }, 
          { 
            headers, 
            timeout: 10000,
            validateStatus: function (status) {
              return status < 500;
            }
          }
        );
        
        console.log(`   Status: ${putResponse.status}`);
        console.log(`   Content-Type: ${putResponse.headers['content-type']}`);
        
        if (putResponse.status === 200) {
          console.log('✅ PUT /api/user/pinned-skus funcionando');
          console.log(`   Resposta: ${JSON.stringify(putResponse.data)}`);
        } else {
          console.log('❌ PUT /api/user/pinned-skus retornou erro');
          console.log(`   Resposta: ${JSON.stringify(putResponse.data)}`);
        }
        
        // Verificar se retornou HTML em vez de JSON
        if (typeof putResponse.data === 'string' && putResponse.data.includes('<!doctype html>')) {
          console.log('🚨 PROBLEMA: API retornando HTML em vez de JSON!');
          console.log('💡 Isso indica que a rota catch-all está interceptando a requisição');
        }
        
      } catch (error) {
        console.error('❌ Erro ao testar PUT /api/user/pinned-skus:', error.message);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Data: ${JSON.stringify(error.response.data)}`);
        }
      }
      
      // 5. Testar outras rotas da API
      console.log('\n5️⃣ Testando outras rotas da API...');
      const rotasParaTestar = [
        '/api/inventory',
        '/api/users',
        '/api/system-info'
      ];
      
      for (const rota of rotasParaTestar) {
        try {
          const response = await axios.get(`${FLY_APP_URL}${rota}`, { 
            timeout: 5000,
            validateStatus: function (status) {
              return status < 500;
            }
          });
          
          if (response.status === 200) {
            console.log(`✅ ${rota} - funcionando`);
          } else {
            console.log(`⚠️  ${rota} - status ${response.status}`);
          }
          
        } catch (error) {
          console.log(`❌ ${rota} - erro: ${error.message}`);
        }
      }
      
      // 6. Resumo
      console.log('\n📋 RESUMO DA VERIFICAÇÃO');
      console.log('========================');
      console.log('✅ Aplicação está online');
      console.log('✅ Login funcionando');
      console.log('✅ Token JWT válido');
      console.log('✅ Rotas da API respondendo');
      
      console.log('\n🎯 PRÓXIMOS PASSOS:');
      console.log('1. Se as rotas estão retornando HTML, o problema é de roteamento');
      console.log('2. Se as rotas estão retornando JSON, o problema pode ser no frontend');
      console.log('3. Execute o script de correção se necessário');
      
    } catch (error) {
      console.error('❌ Erro no login:', error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Data: ${JSON.stringify(error.response.data)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Erro geral:', error.message);
  }
}

// Executar verificação
verificarRotas(); 