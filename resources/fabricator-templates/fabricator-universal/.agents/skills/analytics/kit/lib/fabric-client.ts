//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { SemanticModelMessageClient } from "@microsoft/fabric-app-data-embed-client";
import { FabricClient, type FabricClientConfig } from "@microsoft/fabric-app-data";
import { EmbedFabricApiProxy } from "@microsoft/fabric-app-data-proxy";
import { fabricConfig } from "@/fabric.generated";

let _client: FabricClient | undefined;
let _messageClient: SemanticModelMessageClient | undefined;

/**
 * Returns the pre-configured FabricClient singleton.
 *
 * The client is built once using:
 * - An EmbedFabricApiProxy that communicates with the Fabric host via postMessage
 * - Connection aliases from `fabric.generated.ts` (managed by `npx fabric-app-data`)
 *
 * @internal Used by `useSemanticModelQuery` — prefer the hook over direct client access.
 */
export function getFabricClient(): FabricClient {
    if (!_messageClient)
        _messageClient = new SemanticModelMessageClient();

    if (!_client) {
        const proxy = new EmbedFabricApiProxy(_messageClient);
        _client = new FabricClient({ proxy, ...fabricConfig,  } as FabricClientConfig);
    }
    
    return _client;
}
