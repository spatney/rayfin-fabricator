import type { IAuthService } from './IAuthService';
import { RayfinAuthService } from './RayfinAuthService';
import { initRayfinClient } from './rayfinClient';

/**
 * Read VITE_* env vars, initialize the Rayfin client, and return the
 * Fabric-brokered auth service.
 *
 * Fabricator apps always run against a deployed Rayfin backend, so this always
 * returns {@link RayfinAuthService}. It requires the VITE_RAYFIN_API_URL,
 * VITE_RAYFIN_PUBLISHABLE_KEY, and VITE_FABRIC_* env vars, which `rayfin env`
 * injects at build time from the active deployment.
 */
export function bootstrapAuth(): IAuthService {
  const apiUrl = import.meta.env.VITE_RAYFIN_API_URL;
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

  if (!apiUrl) {
    throw new Error('VITE_RAYFIN_API_URL environment variable is required');
  }

  if (!publishableKey) {
    throw new Error(
      'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
    );
  }

  const client = initRayfinClient({
    baseUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    publishableKey,
  });

  const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
  const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;
  const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;

  if (!workspaceId || !projectId || !fabricPortalUrl) {
    throw new Error(
      'Missing required Fabric config. Set VITE_FABRIC_WORKSPACE_ID, VITE_FABRIC_ITEM_ID, and VITE_FABRIC_PORTAL_URL.'
    );
  }

  return new RayfinAuthService(client, {
    workspaceId,
    projectId,
    fabricPortalUrl,
    returnOrigin: window.location.origin,
  });
}
