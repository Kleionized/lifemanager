import { useState } from "react";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import Todos from "./Todos.jsx";

export default function App() {
  return (
    <>
      <AuthLoading>
        <SplashScreen label="Loading…" />
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Todos />
      </Authenticated>
    </>
  );
}

function SplashScreen({ label }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 text-neutral-500 dark:text-neutral-400 text-sm">
      {label}
    </div>
  );
}

function SignIn() {
  const { signIn } = useAuthActions();
  const [step, setStep] = useState("signIn");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const formData = new FormData(e.currentTarget);
      formData.set("flow", step);
      await signIn("password", formData);
    } catch (err) {
      setError(err?.message || "Failed to sign in.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="lg-card rounded-2xl p-8 w-[360px]">
        <h1 className="text-xl font-semibold tracking-tight mb-1">
          {step === "signIn" ? "Sign in" : "Create account"}
        </h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-6">
          {step === "signIn"
            ? "Welcome back."
            : "Set up a single-user account for this app."}
        </p>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="Email"
            className="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/60 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <input
            name="password"
            type="password"
            required
            autoComplete={
              step === "signIn" ? "current-password" : "new-password"
            }
            placeholder="Password"
            className="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/60 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
          >
            {submitting
              ? "Working…"
              : step === "signIn"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        <button
          onClick={() =>
            setStep((s) => (s === "signIn" ? "signUp" : "signIn"))
          }
          className="mt-4 w-full text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          {step === "signIn"
            ? "Need an account? Create one."
            : "Have an account? Sign in."}
        </button>
      </div>
    </div>
  );
}
