// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

// The dev-server proxy target is resolved from the environment, never hardcoded.
// Order: VITE_API_URL, then MRM_API_URL (the repo-wide name from .env / mrm-env.sh),
// then a local fallback. `deploy.sh` writes VITE_API_URL into frontend/.env.local,
// and loadEnv reads .env / .env.local from this directory.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget =
    env.VITE_API_URL ||
    env.MRM_API_URL ||
    process.env.VITE_API_URL ||
    process.env.MRM_API_URL ||
    'http://localhost:8000'

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(packageJson.version),
      global: 'globalThis',
    },
    // Strip console.log/debug/info from production builds by marking them as
    // pure (side-effect-free) so the minifier drops them. console.error and
    // console.warn are kept so real error signals still surface in production.
    // console.log in particular was leaking auth user objects (email, admin
    // flag, groups) and API URLs to the browser console.
    esbuild: {
      pure: ['console.log', 'console.debug', 'console.info'],
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('@aws-sdk/client-cognito-identity-provider') || id.includes('@aws-sdk/client-ssm')) {
              return 'aws-sdk';
            }
            if (id.includes('@cloudscape-design/components') || id.includes('@cloudscape-design/global-styles')) {
              return 'cloudscape';
            }
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'react-vendor';
            }
          }
        }
      }
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      cors: true,
      hmr: {
        port: 3001,
        host: 'localhost'
      },
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    },
  }
})
