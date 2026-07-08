/** Trimmed view of the authenticated user shown in the UI. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Auth service contract used by the React layer.
 *
 * {@link RayfinAuthService} is the single implementation: it wraps the Fabric
 * brokered auth flow from `@microsoft/rayfin-auth-provider-fabric`.
 * `bootstrapAuth()` constructs it from the VITE_* env vars at startup.
 */
export interface IAuthService {
  /**
   * True when this service requires Fabric/Entra interactive sign-in.
   * The AuthPage uses this to choose its loading-state label.
   */
  readonly fabricAuthEnabled: boolean;

  /**
   * Acquire a session interactively. For Fabric this opens the broker
   * popup and must be called from a user-gesture handler.
   */
  signIn(): Promise<AuthUser>;

  signOut(): Promise<void>;

  /** Return the current session's user, or `null` if not signed in. */
  getCurrentUser(): Promise<AuthUser | null>;

  /**
   * Try to acquire a session via the embedded (iframe) Fabric flow without
   * any UI. Returns `null` when not running inside a Fabric iframe.
   */
  initEmbeddedAuth(): Promise<AuthUser | null>;
}

/** Map the raw session user shape to the trimmed view used in the UI. */
export function toAuthUser(user: {
  id: string;
  email: string;
  name?: string;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email.split('@')[0],
  };
}
