import { RayfinClient } from '@microsoft/rayfin-client';

import type { UniversalAppSchema } from '../../rayfin/data/schema';

export interface RayfinClientConfig {
  baseUrl: string;
  publishableKey: string;
}

let client: RayfinClient<UniversalAppSchema> | null = null;

export function initRayfinClient(
  config: RayfinClientConfig
): RayfinClient<UniversalAppSchema> {
  if (client) {
    throw new Error('Rayfin client is already initialized.');
  }
  client = new RayfinClient<UniversalAppSchema>({
    baseUrl: config.baseUrl,
    publishableKey: config.publishableKey,
    useProxy: false,
    authStorage: true,
  });
  return client;
}

export function getRayfinClient(): RayfinClient<UniversalAppSchema> {
  if (!client) {
    throw new Error(
      'Rayfin client not initialized. Call bootstrapAuth() first.'
    );
  }
  return client;
}
