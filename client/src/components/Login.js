import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

const FloatingShapes = () => (
  <div className="login-shapes">
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className={`login-shape login-shape-${i + 1}`} />
    ))}
  </div>
);

const EyeIcon = ({ open }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {open ? (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ) : (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </>
    )}
  </svg>
);

export const Login = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dateTime, setDateTime] = useState(new Date());
  const [focusedField, setFocusedField] = useState(null);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotStatus, setForgotStatus] = useState(null);
  const [forgotLoading, setForgotLoading] = useState(false);
  const navigate = useNavigate();
  const formRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
    const interval = setInterval(() => setDateTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Mensagem quando sessão expirou (token JWT expira em 8h)
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState('');
  useEffect(() => {
    if (sessionStorage.getItem('session_expired') === 'true') {
      sessionStorage.removeItem('session_expired');
      setSessionExpiredMsg('Sua sessão expirou. Faça login novamente para continuar.');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await axios.post('/api/login', { email, password });
      localStorage.setItem('token', res.data.token);
      localStorage.setItem('user', JSON.stringify(res.data.user));
      if (onLogin) onLogin(res.data.user);
      navigate('/');
    } catch (err) {
      setError('Usuário ou senha inválidos');
      if (formRef.current) {
        formRef.current.classList.add('login-shake');
        setTimeout(() => formRef.current?.classList.remove('login-shake'), 500);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!forgotEmail) return;
    setForgotLoading(true);
    setForgotStatus(null);
    try {
      const res = await axios.post('/api/password-reset-request', { email: forgotEmail });
      setForgotStatus({ type: 'success', message: res.data.message || 'Solicitação enviada ao administrador.' });
    } catch {
      setForgotStatus({ type: 'error', message: 'Erro ao enviar solicitação. Tente novamente.' });
    } finally {
      setForgotLoading(false);
    }
  };

  const hora = dateTime.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const data = dateTime.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });

  return (
    <div className="login-page">
      <FloatingShapes />

      <div className={`login-container ${mounted ? 'login-mounted' : ''}`}>
        <div className="login-brand">
          <div className="login-brand-content">
            <div className="login-clock">
              <div className="login-clock-time">{hora}</div>
              <div className="login-clock-date">{data}</div>
            </div>

            <div className="login-logo-area">
              <img
                src={process.env.PUBLIC_URL + '/miti-logo-white.png'}
                alt="Miti"
                className="login-logo-img"
              />
              <div className="login-logo-tagline">Gestão e inovação</div>
            </div>

            <div className="login-brand-footer">
              <div className="login-brand-dots">
                <span /><span /><span />
              </div>
            </div>
          </div>
        </div>

        <div className="login-form-side">
          <div className="login-form-card" ref={formRef}>
            {!showForgot ? (
              <>
                <div className="login-form-header">
                  <h1 className="login-title">Bem-vindo</h1>
                  <p className="login-subtitle">Acesse sua conta para continuar</p>
                </div>

                {sessionExpiredMsg && (
                  <div className="login-session-expired">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    {sessionExpiredMsg}
                  </div>
                )}

                <form onSubmit={handleSubmit} className="login-form">
                  <div className={`login-field ${focusedField === 'email' ? 'login-field-focused' : ''} ${email ? 'login-field-filled' : ''}`}>
                    <label className="login-label">Email</label>
                    <div className="login-input-wrap">
                      <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                      <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        onFocus={() => setFocusedField('email')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="seu@email.com"
                        required
                        autoFocus
                        autoComplete="email"
                      />
                    </div>
                  </div>

                  <div className={`login-field ${focusedField === 'password' ? 'login-field-focused' : ''} ${password ? 'login-field-filled' : ''}`}>
                    <label className="login-label">Senha</label>
                    <div className="login-input-wrap">
                      <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onFocus={() => setFocusedField('password')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="Digite sua senha"
                        required
                        autoComplete="current-password"
                      />
                      <button
                        type="button"
                        className="login-eye-btn"
                        onClick={() => setShowPassword(!showPassword)}
                        tabIndex={-1}
                      >
                        <EyeIcon open={showPassword} />
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="login-error">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="15" y1="9" x2="9" y2="15" />
                        <line x1="9" y1="9" x2="15" y2="15" />
                      </svg>
                      {error}
                    </div>
                  )}

                  <button type="submit" className="login-submit" disabled={loading}>
                    {loading ? (
                      <div className="login-spinner" />
                    ) : (
                      <>
                        Entrar
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                          <polyline points="12 5 19 12 12 19" />
                        </svg>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    className="login-forgot-btn"
                    onClick={() => { setShowForgot(true); setForgotEmail(email); setForgotStatus(null); }}
                  >
                    Esqueci minha senha
                  </button>
                </form>
              </>
            ) : (
              <>
                <div className="login-form-header">
                  <h1 className="login-title">Recuperar Senha</h1>
                  <p className="login-subtitle">Informe seu email para solicitar uma nova senha ao administrador</p>
                </div>

                <form onSubmit={handleForgotPassword} className="login-form">
                  <div className={`login-field ${focusedField === 'forgot' ? 'login-field-focused' : ''} ${forgotEmail ? 'login-field-filled' : ''}`}>
                    <label className="login-label">Email</label>
                    <div className="login-input-wrap">
                      <svg className="login-input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                      <input
                        type="email"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        onFocus={() => setFocusedField('forgot')}
                        onBlur={() => setFocusedField(null)}
                        placeholder="seu@email.com"
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  {forgotStatus && (
                    <div className={`login-forgot-status ${forgotStatus.type === 'success' ? 'login-forgot-success' : 'login-error'}`}>
                      {forgotStatus.type === 'success' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                          <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <line x1="15" y1="9" x2="9" y2="15" />
                          <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                      )}
                      {forgotStatus.message}
                    </div>
                  )}

                  <button type="submit" className="login-submit" disabled={forgotLoading}>
                    {forgotLoading ? (
                      <div className="login-spinner" />
                    ) : (
                      <>
                        Enviar Solicitação
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13" />
                          <polygon points="22 2 15 22 11 13 2 9 22 2" />
                        </svg>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    className="login-forgot-btn"
                    onClick={() => setShowForgot(false)}
                  >
                    Voltar ao login
                  </button>
                </form>
              </>
            )}

            <div className="login-form-footer">
              <span>Miti - Sistema de Gestão v1.5.1</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
