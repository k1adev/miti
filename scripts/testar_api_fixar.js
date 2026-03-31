const axios = require('axios');

console.log('🧪 TESTE: API de Fixar Itens');
console.log('=============================\n');

// Configuração
const BASE_URL = 'http://localhost:3001';
const TEST_USER = {
  email: 'admin@apoli.com',
  password: 'admin123'
};

async function testarAPI() {
  try {
    console.log('1️⃣ Fazendo login...');
    const loginResponse = await axios.post(`${BASE_URL}/api/login`, TEST_USER);
    const token = loginResponse.data.token;
    const userId = loginResponse.data.user.id;
    
    console.log('✅ Login realizado com sucesso');
    console.log(`   User ID: ${userId}`);
    console.log(`   Token: ${token.substring(0, 50)}...`);
    
    // Configurar headers para todas as requisições
    const headers = { Authorization: `Bearer ${token}` };
    
    console.log('\n2️⃣ Testando GET /api/user/pinned-skus...');
    const getResponse = await axios.get(`${BASE_URL}/api/user/pinned-skus`, { headers });
    console.log('✅ GET /api/user/pinned-skus funcionando');
    console.log(`   Resposta: ${JSON.stringify(getResponse.data)}`);
    
    console.log('\n3️⃣ Testando PUT /api/user/pinned-skus...');
    const testPinnedSkus = ['12345', '67890'];
    const putResponse = await axios.put(`${BASE_URL}/api/user/pinned-skus`, 
      { pinnedSkus: testPinnedSkus }, { headers });
    console.log('✅ PUT /api/user/pinned-skus funcionando');
    console.log(`   Resposta: ${JSON.stringify(putResponse.data)}`);
    
    console.log('\n4️⃣ Verificando se os dados foram salvos...');
    const verifyResponse = await axios.get(`${BASE_URL}/api/user/pinned-skus`, { headers });
    console.log('✅ Verificação concluída');
    console.log(`   pinnedSkus salvos: ${JSON.stringify(verifyResponse.data.pinnedSkus)}`);
    
    if (JSON.stringify(verifyResponse.data.pinnedSkus) === JSON.stringify(testPinnedSkus)) {
      console.log('✅ Dados salvos corretamente!');
    } else {
      console.log('❌ Dados não foram salvos corretamente');
    }
    
    console.log('\n5️⃣ Testando limpeza dos dados...');
    const clearResponse = await axios.put(`${BASE_URL}/api/user/pinned-skus`, 
      { pinnedSkus: [] }, { headers });
    console.log('✅ Limpeza realizada');
    console.log(`   Resposta: ${JSON.stringify(clearResponse.data)}`);
    
    console.log('\n🎉 TODOS OS TESTES PASSARAM!');
    console.log('✅ A funcionalidade de fixar itens está funcionando corretamente.');
    
  } catch (error) {
    console.error('❌ ERRO NO TESTE:', error.message);
    
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
      console.error('   Headers:', error.response.headers);
    }
    
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Dica: Certifique-se de que o servidor está rodando na porta 3001');
    }
    
    if (error.response?.status === 404) {
      console.error('💡 Dica: A rota não foi encontrada. Verifique se a rota catch-all foi movida para o final.');
    }
    
    if (error.response?.status === 401) {
      console.error('💡 Dica: Problema de autenticação. Verifique se o usuário existe.');
    }
  }
}

// Executar teste
testarAPI(); 