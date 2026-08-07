'use client';

import { useState } from 'react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get('next') || '/sheet';
      window.location.href = next;
    } else {
      setErr('Password salah.');
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#EAF0FF' }}>
      <form onSubmit={submit} className="card" style={{ width: 340, textAlign: 'center' }}>
        <div style={{ fontWeight: 900, fontSize: 24, color: 'var(--nawilis)', letterSpacing: 1 }}>NAWILIS</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>SPK — Masuk staf</div>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus style={{ marginBottom: 10 }} />
        {err && <div className="finding BLOCK" style={{ marginBottom: 10 }}>{err}</div>}
        <button className="btn primary" disabled={busy || !password} style={{ width: '100%' }}>{busy ? 'Masuk…' : 'Masuk'}</button>
      </form>
    </div>
  );
}
