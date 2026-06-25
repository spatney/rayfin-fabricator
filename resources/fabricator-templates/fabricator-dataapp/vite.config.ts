//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import license from "rollup-plugin-license";

import { resolve } from 'path';

const projectRoot = process.env.PROJECT_ROOT || import.meta.dirname

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
    ],
    resolve: {
        alias: {
            '@': resolve(projectRoot, 'src'),
        }
    },
    optimizeDeps: {
        include: ['@microsoft/fabric-visuals', '@microsoft/fabric-datagrid', '@microsoft/fabric-visuals-core'],
    },
    build: {
        commonjsOptions: {
            include: [/node_modules/],
        },
        rollupOptions: {
            plugins: [
                license({
                    thirdParty: {
                        multipleVersions: true,
                        output: {
                            file: resolve(projectRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'),
                            template(dependencies) {
                                if (dependencies.length === 0) {
                                    return 'No third-party dependencies.';
                                }
                                return (
                                    'This file was auto-generated at build time.\n\n' +
                                    dependencies
                                        .map((dep) => {
                                            const lines = [
                                                `${dep.name}@${dep.version}`,
                                                `License: ${dep.license || 'UNKNOWN'}`,
                                            ];
                                            if (dep.author) {
                                                lines.push(`Author: ${typeof dep.author === 'string' ? dep.author : dep.author.text()}`);
                                            }
                                            if (dep.noticeText) {
                                                lines.push('', 'NOTICE:', dep.noticeText.trim());
                                            }
                                            if (dep.licenseText) {
                                                lines.push('', dep.licenseText.trim());
                                            }
                                            return lines.join('\n');
                                        })
                                        .join('\n\n' + '='.repeat(60) + '\n\n')
                                );
                            },
                        },
                    },
                }),
            ],
        },
    },
});
