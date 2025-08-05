import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

export const Login = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [dateTime, setDateTime] = useState(new Date());
  const navigate = useNavigate();

  useEffect(() => {
    const interval = setInterval(() => setDateTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await axios.post('/api/login', { email, password });
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data.user));
      if (onLogin) onLogin(res.data.user);
      navigate('/');
    } catch (err) {
      setError('Usuário ou senha inválidos');
    }
  };

  const hora = dateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const data = dateTime.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  return (
    <div style={{ minHeight: '100vh', width: '100vw', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '900px', maxWidth: '100vw', height: '600px', maxHeight: '100vh', display: 'flex', borderRadius: 24, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 0 0 1px #0001' }}>
        {/* Lado esquerdo: logo e nome */}
        <div style={{ flex: 1, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: '2px 0 16px 0 rgba(0,0,0,0.06)' }}>
          <img src={process.env.PUBLIC_URL + '/miti-logo.png'} alt="Logo Miti" style={{ height: 120, marginBottom: 24 }} />
          {/* Removido o título 'miti' */}
          <div style={{ fontSize: 18, color: '#2563eb', fontWeight: 500, marginTop: 8 }}>Gestão e inovação</div>
        </div>
        {/* Lado direito: card de login */}
        <div style={{ flex: 1.2, background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', boxShadow: '-2px 0 16px 0 rgba(0,0,0,0.06)' }}>
          <div style={{ background: '#fff', borderRadius: 24, boxShadow: '0 4px 24px rgba(0,0,0,0.10)', padding: '48px 36px', width: 340, maxWidth: '90vw', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: '#222', marginBottom: 24, textAlign: 'center' }}>Entrar</div>
            <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="input-field w-full" required autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Senha</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="input-field w-full" required />
              </div>
              {error && <div className="text-red-600 text-sm text-center">{error}</div>}
              <button type="submit" style={{ background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 18, borderRadius: 8, boxShadow: '0 2px 8px #2563eb33', padding: '12px 0', marginTop: 8 }} className="transition hover:brightness-110">Entrar</button>
            </form>
            {/* Removido links de Cadastrar e Esqueci a senha */}
          </div>
        </div>
      </div>
    </div>
  );
}; 