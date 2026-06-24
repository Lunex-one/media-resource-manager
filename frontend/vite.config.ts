// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json'

export default defineConfig({
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
        target: 'https://0hk4rx8as8.execute-api.us-east-1.amazonaws.com/prod',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  },
})
