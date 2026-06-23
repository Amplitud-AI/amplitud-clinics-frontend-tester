'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (resendCooldown <= 0) return
    const timer = setTimeout(() => setResendCooldown((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCooldown])

  const handleVerifyCode = useCallback(async () => {
    setError('')
    setIsVerifying(true)
    const supabase = createClient()
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    })
    if (verifyError || !data.session) {
      setIsVerifying(false)
      setError(verifyError?.message ?? 'Verification failed')
      setCode('')
      return
    }
    window.location.href = '/'
  }, [email, code])

  useEffect(() => {
    if (step === 'code' && code.length === 6 && !isVerifying) {
      void handleVerifyCode()
    }
  }, [code, step, isVerifying, handleVerifyCode])

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    })
    setIsLoading(false)
    if (signInError) {
      setError(signInError.message)
      return
    }
    setStep('code')
    setResendCooldown(30)
  }

  const handleResendCode = async () => {
    if (resendCooldown > 0) return
    setError('')
    const supabase = createClient()
    const { error: resendError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    })
    if (resendError) {
      setError(resendError.message)
      return
    }
    setResendCooldown(30)
  }

  return (
    <div className="min-h-full flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6 text-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Clinic flow tester — sign in</h1>
          <p className="text-zinc-500">
            Production-style auth: Supabase SSR cookies + middleware (same pattern as clinics
            control). After verify, you are redirected to the harness at{' '}
            <code className="text-xs">/</code>.
          </p>
        </header>

        {step === 'email' ? (
          <form onSubmit={handleSendCode} className="space-y-3 border rounded p-4">
            <label className="block space-y-1">
              <span className="font-medium">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                className="border px-2 py-1 w-full"
                placeholder="staff@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={isLoading}
              className="border px-3 py-1 rounded w-full disabled:opacity-50"
            >
              {isLoading ? 'Sending…' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <div className="space-y-3 border rounded p-4">
            <p className="text-zinc-600">
              Code sent to <strong>{email}</strong>
            </p>
            <label className="block space-y-1">
              <span className="font-medium">6-digit code</span>
              <input
                className="border px-2 py-1 w-full tracking-widest"
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                disabled={isVerifying}
              />
            </label>
            <button
              type="button"
              disabled={code.length < 6 || isVerifying}
              className="border px-3 py-1 rounded w-full disabled:opacity-50"
              onClick={() => void handleVerifyCode()}
            >
              {isVerifying ? 'Verifying…' : 'Verify OTP'}
            </button>
            <p className="text-xs text-zinc-500">
              {resendCooldown > 0 ? (
                <>Resend in {resendCooldown}s</>
              ) : (
                <button type="button" className="underline" onClick={() => void handleResendCode()}>
                  Resend code
                </button>
              )}
              {' · '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setError('')
                }}
              >
                Use different email
              </button>
            </p>
          </div>
        )}

        {error && <p className="text-red-600 text-xs">{error}</p>}

        <p className="text-xs text-zinc-500">
          Configure <code className="text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code className="text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{' '}
          <code className="text-xs">.env</code> before signing in.
        </p>
      </div>
    </div>
  )
}
