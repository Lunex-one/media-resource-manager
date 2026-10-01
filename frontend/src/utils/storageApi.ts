// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { apiCall } from './api';
import { getAuthToken } from './auth';

// Types for Storage API
export interface S3Bucket {
  name: string;
  region: string;
  arn: string;
  creationDate?: string;
}

export interface StorageConfig {
  workstationRoleArn: string;
  accountId: string;
  /** AZs this deployment has private subnets in, used to populate the
   *  FSx-Windows Single-AZ AZ picker. Empty on pre-#29 deployments. */
  availabilityZones?: string[];
}

// Helper to get auth headers
const getAuthHeaders = () => {
  const token = getAuthToken();
  if (!token) throw new Error('No current user');
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
};

// S3 Buckets API function for Mountpoint S3 storage creation
export const listStorageS3Buckets = async (): Promise<S3Bucket[]> => {
  const response = await apiCall('storage/s3-buckets', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list S3 buckets');
  }
  return await response.json();
};

// Storage Config API function - returns workstation role ARN for cross-account bucket policy
export const getStorageConfig = async (): Promise<StorageConfig> => {
  const response = await apiCall('storage/config', {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get storage config');
  }
  return await response.json();
};

// Non-Cognito-Identity-Pool fallback for browsing/managing bucket contents (e.g. LDAP auth mode).
// These call the backend Lambda's own IAM role instead of federated browser credentials.

export interface S3BrowseItem {
  key: string;
  size?: number;
  lastModified?: string;
  isFolder: boolean;
}

export interface S3BrowseResult {
  bucket: string;
  prefix: string;
  folders: S3BrowseItem[];
  files: S3BrowseItem[];
}

export const browseS3Objects = async (bucket: string, prefix: string): Promise<S3BrowseResult> => {
  const response = await apiCall(
    `storage/s3-buckets?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`,
    { headers: getAuthHeaders() }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to list bucket contents');
  }
  return await response.json();
};

export const getS3DownloadUrl = async (bucket: string, key: string): Promise<string> => {
  const response = await apiCall(
    `storage/s3-buckets?bucket=${encodeURIComponent(bucket)}&action=download&key=${encodeURIComponent(key)}`,
    { headers: getAuthHeaders() }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get download URL');
  }
  const data = await response.json();
  return data.downloadUrl;
};

export const getS3UploadUrl = async (bucket: string, key: string, contentType: string): Promise<string> => {
  const response = await apiCall(
    `storage/s3-buckets?bucket=${encodeURIComponent(bucket)}&action=uploadUrl&key=${encodeURIComponent(key)}&contentType=${encodeURIComponent(contentType)}`,
    { headers: getAuthHeaders() }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get upload URL');
  }
  const data = await response.json();
  return data.uploadUrl;
};

export const deleteS3Object = async (bucket: string, key: string): Promise<void> => {
  const response = await apiCall(
    `storage/s3-buckets?bucket=${encodeURIComponent(bucket)}&action=delete&key=${encodeURIComponent(key)}`,
    { headers: getAuthHeaders() }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to delete object');
  }
};

export const createS3Folder = async (bucket: string, key: string): Promise<void> => {
  const response = await apiCall(
    `storage/s3-buckets?bucket=${encodeURIComponent(bucket)}&action=createFolder&key=${encodeURIComponent(key)}`,
    { headers: getAuthHeaders() }
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create folder');
  }
};

/** Rates returned by GET /storage/pricing for a single Region. Any leaf may
 *  be undefined when the Pricing API omits or fails on a given SKU - the
 *  cost estimator should treat missing rates as "hide this line item"
 *  rather than substituting a placeholder. */
export interface FsxWindowsRates {
  storage: { SSD?: { 'single-az'?: number; 'multi-az'?: number }; HDD?: { 'single-az'?: number; 'multi-az'?: number } };
  throughput: { 'single-az'?: number; 'multi-az'?: number };
  backup: { 'single-az'?: number; 'multi-az'?: number };
}

export interface StoragePricing {
  region: string;
  currency: string;
  unit: string;
  asOf?: string;
  source?: string;
  fsxWindows: FsxWindowsRates | null;
  error?: string;
}

/** Fetch live AWS FSx pricing from the Price List Query API via the MRM
 *  backend. Resolves even on backend errors - the response's `fsxWindows`
 *  field is null when pricing is unavailable, so the UI can just hide the
 *  cost estimate rather than blocking the create flow. */
export const getStoragePricing = async (region?: string): Promise<StoragePricing> => {
  const qs = region ? `?region=${encodeURIComponent(region)}` : '';
  const response = await apiCall(`storage/pricing${qs}`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    // Return a null-rate payload so the UI degrades gracefully.
    return { region: region || '', currency: 'USD', unit: 'per month', fsxWindows: null, error: 'pricing unavailable' };
  }
  return await response.json();
};
