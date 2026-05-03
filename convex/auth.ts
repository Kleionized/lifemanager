import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

// Single-user app. Password provider keeps setup to zero env vars.
// To swap to magic link later: replace Password with ResendOTP/Magic
// from @convex-dev/auth/providers/ once an email provider is wired up.
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
});
