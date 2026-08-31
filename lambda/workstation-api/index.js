// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// This Lambda serves keep-alive, settings, the instance-type catalogue and the domain list. The
// clients below are what those need; the EC2, Step Functions, Directory Service Data and Cognito
// clients went with the unreachable workstation lifecycle removed on 2026-08-31.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const { DirectoryServiceClient, DescribeDirectoriesCommand } = require('@aws-sdk/client-directory-service');

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const ssm = new SSMClient({});
const directoryService = new DirectoryServiceClient({});

exports.handler = async (event) => {
  const { httpMethod, path, body } = event;
  
  console.log('Event received:', JSON.stringify({ httpMethod, path, body: body ? 'present' : 'missing' }));
  
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };

  // Default instance types catalog - used when no allowlist is configured
  // All G-series GPU instances enabled by default for Windows/Linux
  // All DCV-supported Mac instances enabled by default for macOS
  const DEFAULT_INSTANCE_TYPES = {
    windows: {
      enabled: [
        'g4dn.xlarge', 'g4dn.2xlarge', 'g4dn.4xlarge', 'g4dn.8xlarge', 'g4dn.12xlarge', 'g4dn.16xlarge',
        'g5.xlarge', 'g5.2xlarge', 'g5.4xlarge', 'g5.8xlarge', 'g5.12xlarge', 'g5.16xlarge', 'g5.24xlarge', 'g5.48xlarge',
        'g6.xlarge', 'g6.2xlarge', 'g6.4xlarge', 'g6.8xlarge', 'g6.12xlarge', 'g6.16xlarge'
      ],
      default: 'g4dn.xlarge'
    },
    linux: {
      enabled: [
        'g4dn.xlarge', 'g4dn.2xlarge', 'g4dn.4xlarge', 'g4dn.8xlarge', 'g4dn.12xlarge', 'g4dn.16xlarge',
        'g5.xlarge', 'g5.2xlarge', 'g5.4xlarge', 'g5.8xlarge', 'g5.12xlarge', 'g5.16xlarge', 'g5.24xlarge', 'g5.48xlarge',
        'g6.xlarge', 'g6.2xlarge', 'g6.4xlarge', 'g6.8xlarge', 'g6.12xlarge', 'g6.16xlarge'
      ],
      default: 'g4dn.xlarge'
    },
    macos: {
      enabled: [
        'mac2.metal', 'mac2-m1ultra.metal',
        'mac2-m2.metal', 'mac2-m2pro.metal',
        'mac-m4.metal', 'mac-m4pro.metal'
      ],
      default: 'mac2-m2.metal'
    }
  };
  
  try {
    // Handle CORS preflight requests
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: ''
      };
    }
    
    // Only the routes API Gateway actually sends here: keep-alive, settings, the instance-type
    // catalogue and the domain list. See the routing map above `lambdaIntegration` in
    // lib/api-stack.ts for the full split.
    //
    // This router carried a second implementation of the whole workstation lifecycle until
    // 2026-08-31 - list, details, create, start, stop, update, delete - and none of it could run,
    // because every /workstations route is wired to mrm-workstation-manager. It was removed rather
    // than corrected: it had already drifted (it knew nothing of externalRef, and nothing of the
    // constellationId and projectId added the same day), so anything that ever rewired a route to
    // it would have silently dropped a machine's references. Do not add one back.
    switch (httpMethod) {
      case 'GET':
        if (path === '/settings') {
          return await getSettings(event);
        } else if (path === '/settings/instance-types') {
          return await getAllowedInstanceTypes(event);
        } else if (path === '/instance-types/catalog') {
          return await getInstanceTypeCatalog(event);
        } else if (path === '/domains') {
          return await getDomains();
        }
        break;
      case 'POST':
        if (path === '/workstations/keep-alive') {
          return await setKeepAlive(JSON.parse(body), event);
        } else if (path === '/settings') {
          return await saveSettings(JSON.parse(body), event);
        } else if (path === '/settings/instance-types') {
          return await saveAllowedInstanceTypes(JSON.parse(body), event);
        }
        break;
      case 'DELETE':
        if (path.startsWith('/workstations/') && path.endsWith('/keep-alive')) {
          const instanceId = path.split('/')[2];
          return await cancelKeepAlive(instanceId, event);
        }
        break;
      default:
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ message: 'Not found' })
        };
    }
  } catch (error) {
    console.error('Lambda error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
      body: JSON.stringify({ error: error.message })
    };
  }
  
  // Helper function to get directory ID


  async function getDomains() {
    try {
      const result = await directoryService.send(new DescribeDirectoriesCommand({}));
      
      const domains = result.DirectoryDescriptions?.map(dir => ({
        id: dir.DirectoryId,
        name: dir.Name,
        type: dir.Type,
        size: dir.Size
      })) || [];
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(domains)
      };
    } catch (error) {
      console.error('Error fetching domains:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to fetch domains' })
      };
    }
  }
  
  

  async function getBrowserSessionsConfig() {
    try {
      const browserSessionsParam = await ssm.send(new GetParameterCommand({
        Name: '/workstation/dcv/browser-sessions-enabled'
      }));
      const browserSessionsEnabled = browserSessionsParam.Parameter.Value === 'true';
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ browserSessionsEnabled })
      };
    } catch (error) {
      console.error('Error getting browser sessions config:', error);
      // Default to enabled if parameter doesn't exist
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ browserSessionsEnabled: true })
      };
    }
  }


  async function getSettings(event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    try {
      // Get browser sessions setting (available to all users)
      const settings = {};
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      try {
        const browserSessionsParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/DCV/BrowserSessionsEnabled`
        }));
        settings.browserSessionsEnabled = browserSessionsParam.Parameter.Value === 'true';
      } catch (error) {
        // Parameter doesn't exist yet, default to true
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting browser-sessions-enabled parameter:', error);
        }
        settings.browserSessionsEnabled = true; // Default to enabled
      }
      
      // Get Keep Alive settings (available to all users to know if feature is enabled)
      try {
        const keepAliveEnabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`
        }));
        settings.keepAliveEnabled = keepAliveEnabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting keep-alive-enabled parameter:', error);
        }
        settings.keepAliveEnabled = false; // Default to disabled
      }
      
      try {
        const keepAliveMaxParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`
        }));
        settings.keepAliveMaxHours = parseInt(keepAliveMaxParam.Parameter.Value) || 24;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting keep-alive-max-hours parameter:', error);
        }
        settings.keepAliveMaxHours = 24; // Default max
      }
      
      // Get Auto-Start settings (available to all users to know if feature is enabled)
      try {
        const autoStartEnabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartEnabled`
        }));
        settings.autoStartEnabled = autoStartEnabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting auto-start-enabled parameter:', error);
        }
        settings.autoStartEnabled = false; // Default to disabled
      }
      
      try {
        const autoStartLeadParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartLeadTimeMinutes`
        }));
        settings.autoStartLeadTimeMinutes = parseInt(autoStartLeadParam.Parameter.Value) || 15;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') {
          console.log('Error getting auto-start-lead-time parameter:', error);
        }
        settings.autoStartLeadTimeMinutes = 15; // Default lead time
      }
      
      // Only admins can access other settings
      if (isAdmin) {
        try {
          const disconnectedDurationParam = await ssm.send(new GetParameterCommand({
            Name: `/${pascalCaseName}/DCV/DisconnectedDuration`
          }));
          settings.disconnectedDuration = parseInt(disconnectedDurationParam.Parameter.Value);
        } catch (error) {
          // Parameter doesn't exist yet, that's okay
          if (error.name !== 'ParameterNotFound') {
            console.log('Error getting disconnected-duration parameter:', error);
          }
        }
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(settings)
      };
    } catch (error) {
      console.error('Error getting settings:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to get settings' })
      };
    }
  }

  async function saveSettings(data, event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }

    try {
      const { disconnectedDuration, browserSessionsEnabled, keepAliveEnabled, keepAliveMaxHours, autoStartEnabled, autoStartLeadTimeMinutes } = data;
      
      // Get pascal case name from environment variable
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Save disconnected duration setting
      if (disconnectedDuration !== null && disconnectedDuration !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/DCV/DisconnectedDuration`,
          Value: disconnectedDuration.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Minutes to wait before shutting down workstation after user disconnection'
        }));
      }
      
      // Save browser sessions enabled setting
      if (browserSessionsEnabled !== null && browserSessionsEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/DCV/BrowserSessionsEnabled`,
          Value: browserSessionsEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether browser-based DCV sessions are enabled for users'
        }));
      }
      
      // Save Keep Alive enabled setting
      if (keepAliveEnabled !== null && keepAliveEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`,
          Value: keepAliveEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether users can request Keep Alive to temporarily prevent auto-shutdown'
        }));
      }
      
      // Save Keep Alive max hours setting
      if (keepAliveMaxHours !== null && keepAliveMaxHours !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`,
          Value: keepAliveMaxHours.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Maximum hours users can request for Keep Alive'
        }));
      }
      
      // Save Auto-Start enabled setting
      if (autoStartEnabled !== null && autoStartEnabled !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartEnabled`,
          Value: autoStartEnabled.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Whether auto-start scheduling is enabled for users'
        }));
      }
      
      // Save Auto-Start lead time setting
      if (autoStartLeadTimeMinutes !== null && autoStartLeadTimeMinutes !== undefined) {
        await ssm.send(new PutParameterCommand({
          Name: `/${pascalCaseName}/Settings/AutoStartLeadTimeMinutes`,
          Value: autoStartLeadTimeMinutes.toString(),
          Type: 'String',
          Overwrite: true,
          Description: 'Minutes before scheduled start time to begin starting workstations'
        }));
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Settings saved successfully' })
      };
    } catch (error) {
      console.error('Error saving settings:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to save settings' })
      };
    }
  }

  async function getAllowedInstanceTypes(event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    
    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      try {
        const param = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/AllowedInstanceTypes`
        }));
        
        const allowedTypes = JSON.parse(param.Parameter.Value);
        
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify(allowedTypes)
        };
      } catch (error) {
        // Parameter doesn't exist yet, return defaults
        // Check for ParameterNotFound error (AWS SDK v3 may use different error structures)
        if (error.name === 'ParameterNotFound' || 
            error.code === 'ParameterNotFound' ||
            error.message?.includes('ParameterNotFound') ||
            error.$metadata?.httpStatusCode === 400) {
          console.log('AllowedInstanceTypes parameter not found, returning defaults');
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify(DEFAULT_INSTANCE_TYPES)
          };
        }
        throw error;
      }
    } catch (error) {
      console.error('Error getting allowed instance types:', error);
      // If all else fails, return defaults rather than an error
      // This ensures users can always create workstations
      console.log('Returning default instance types due to error');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify(DEFAULT_INSTANCE_TYPES)
      };
    }
  }

  async function saveAllowedInstanceTypes(data, event) {
    // Extract user information from authorizer context
    const authorizerContext = event.requestContext?.authorizer || {};
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    if (!isAdmin) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Access denied. Administrator privileges required.' })
      };
    }

    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Validate the data structure
      const { windows, linux, macos } = data;
      
      if (!windows || !linux || !macos) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Invalid data structure. Must include windows, linux, and macos configurations.' })
        };
      }
      
      // Validate each platform has enabled array and default
      for (const [platform, config] of Object.entries(data)) {
        if (!Array.isArray(config.enabled) || config.enabled.length === 0) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Platform ${platform} must have at least one enabled instance type.` })
          };
        }
        if (!config.default || !config.enabled.includes(config.default)) {
          return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
            body: JSON.stringify({ error: `Platform ${platform} default must be one of the enabled instance types.` })
          };
        }
      }
      
      await ssm.send(new PutParameterCommand({
        Name: `/${pascalCaseName}/Settings/AllowedInstanceTypes`,
        Value: JSON.stringify(data),
        Type: 'String',
        Overwrite: true,
        Description: 'Allowed instance types per platform for workstation creation'
      }));
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Allowed instance types saved successfully' })
      };
    } catch (error) {
      console.error('Error saving allowed instance types:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to save allowed instance types' })
      };
    }
  }

  // Keep Alive feature - allows users to temporarily prevent auto-shutdown
  async function setKeepAlive(data, event) {
    const authorizerContext = event.requestContext?.authorizer || {};
    const currentUserId = authorizerContext.username;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    const { instanceId, durationHours } = data;
    
    if (!instanceId || !durationHours) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'instanceId and durationHours are required' })
      };
    }
    
    try {
      const pascalCaseName = process.env.PASCAL_CASE_NAME || 'MediaResourceManager';
      
      // Check if Keep Alive feature is enabled
      let keepAliveEnabled = false;
      let maxDurationHours = 24; // Default max
      
      try {
        const enabledParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveEnabled`
        }));
        keepAliveEnabled = enabledParam.Parameter.Value === 'true';
      } catch (error) {
        if (error.name !== 'ParameterNotFound') throw error;
        // Feature not configured, default to disabled
      }
      
      if (!keepAliveEnabled && !isAdmin) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Keep Alive feature is not enabled. Contact your administrator.' })
        };
      }
      
      // Get max duration setting
      try {
        const maxParam = await ssm.send(new GetParameterCommand({
          Name: `/${pascalCaseName}/Settings/KeepAliveMaxHours`
        }));
        maxDurationHours = parseInt(maxParam.Parameter.Value) || 24;
      } catch (error) {
        if (error.name !== 'ParameterNotFound') throw error;
      }
      
      // Validate duration (admins can bypass max)
      if (!isAdmin && durationHours > maxDurationHours) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: `Maximum Keep Alive duration is ${maxDurationHours} hours` })
        };
      }
      
      // Get workstation to verify ownership
      const workstation = await dynamodb.send(new GetCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId }
      }));
      
      if (!workstation.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Workstation not found' })
        };
      }
      
      // Check if user has access to this workstation (admin or assigned user)
      const userIdForCheck = currentUserId?.includes('@') ? currentUserId.split('@')[0] : currentUserId;
      const assignedId = workstation.Item.assignedUserId || '';
      // Normalize both IDs: strip IdP prefixes (IdentityCenter_, Okta_, etc.) and compare case-insensitively
      const normalizeUserId = (id) => {
        if (!id) return '';
        let normalized = id;
        // Strip known IdP prefixes
        const knownPrefixes = ['IdentityCenter_', 'Okta_', 'SAML_', 'AzureAD_', 'AmazonFederate_'];
        for (const prefix of knownPrefixes) {
          if (normalized.startsWith(prefix)) {
            normalized = normalized.substring(prefix.length);
            break;
          }
        }
        // Strip @domain for comparison
        if (normalized.includes('@')) {
          normalized = normalized.split('@')[0];
        }
        return normalized.toLowerCase();
      };
      if (!isAdmin && normalizeUserId(assignedId) !== normalizeUserId(currentUserId)) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'You can only set Keep Alive on workstations assigned to you' })
        };
      }
      
      // Calculate expiration time
      const keepAliveUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();
      
      // Update workstation with Keep Alive info
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'SET keepAliveUntil = :until, keepAliveRequestedBy = :user, keepAliveRequestedAt = :at',
        ExpressionAttributeValues: {
          ':until': keepAliveUntil,
          ':user': currentUserId,
          ':at': new Date().toISOString()
        }
      }));
      
      console.log(`Keep Alive set for ${instanceId} until ${keepAliveUntil} by ${currentUserId}`);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          message: 'Keep Alive activated',
          keepAliveUntil,
          durationHours
        })
      };
    } catch (error) {
      console.error('Error setting Keep Alive:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to set Keep Alive' })
      };
    }
  }

  async function cancelKeepAlive(instanceId, event) {
    const authorizerContext = event.requestContext?.authorizer || {};
    const currentUserId = authorizerContext.username;
    const isAdmin = authorizerContext.isAdmin === 'true';
    
    try {
      // Get workstation to verify ownership
      const workstation = await dynamodb.send(new GetCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId }
      }));
      
      if (!workstation.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'Workstation not found' })
        };
      }
      
      // Check if user has access (admin or assigned user)
      const userIdForCheck = currentUserId?.includes('@') ? currentUserId.split('@')[0] : currentUserId;
      const assignedId = workstation.Item.assignedUserId || '';
      // Normalize both IDs: strip IdP prefixes (IdentityCenter_, Okta_, etc.) and compare case-insensitively
      const normalizeUserId = (id) => {
        if (!id) return '';
        let normalized = id;
        const knownPrefixes = ['IdentityCenter_', 'Okta_', 'SAML_', 'AzureAD_', 'AmazonFederate_'];
        for (const prefix of knownPrefixes) {
          if (normalized.startsWith(prefix)) {
            normalized = normalized.substring(prefix.length);
            break;
          }
        }
        if (normalized.includes('@')) {
          normalized = normalized.split('@')[0];
        }
        return normalized.toLowerCase();
      };
      if (!isAdmin && normalizeUserId(assignedId) !== normalizeUserId(currentUserId)) {
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ error: 'You can only cancel Keep Alive on workstations assigned to you' })
        };
      }
      
      // Remove Keep Alive attributes
      await dynamodb.send(new UpdateCommand({
        TableName: process.env.WORKSTATION_TABLE_NAME,
        Key: { instanceId },
        UpdateExpression: 'REMOVE keepAliveUntil, keepAliveRequestedBy, keepAliveRequestedAt'
      }));
      
      console.log(`Keep Alive cancelled for ${instanceId} by ${currentUserId}`);
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ message: 'Keep Alive cancelled' })
      };
    } catch (error) {
      console.error('Error cancelling Keep Alive:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to cancel Keep Alive' })
      };
    }
  }

  /**
   * Get instance type catalog from DynamoDB
   * Returns all instance types with their metadata, optionally filtered by region or platform
   */
  async function getInstanceTypeCatalog(event) {
    const queryParams = event.queryStringParameters || {};
    const regionFilter = queryParams.region;
    const platformFilter = queryParams.platform;
    
    try {
      const catalogTableName = process.env.INSTANCE_TYPE_CATALOG_TABLE_NAME;
      
      if (!catalogTableName) {
        // Return empty catalog if table not configured
        console.log('Instance type catalog table not configured');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
          body: JSON.stringify({ instanceTypes: {}, source: 'none' })
        };
      }
      
      // Scan the catalog table
      const result = await dynamodb.send(new ScanCommand({
        TableName: catalogTableName
      }));
      
      // Transform to the format expected by frontend
      const catalog = {};
      for (const item of result.Items || []) {
        // Apply region filter if specified
        if (regionFilter && item.regions && !item.regions.includes(regionFilter)) {
          continue;
        }
        
        // Apply platform filter if specified
        if (platformFilter && item.platforms && !item.platforms.includes(platformFilter)) {
          continue;
        }
        
        catalog[item.instanceType] = {
          family: item.family,
          label: item.label,
          platforms: item.platforms || [],
          vCpu: item.vCpu,
          memoryGb: item.memoryGb,
          gpuInfo: item.gpuInfo,
          regions: item.regions || [],
          architecture: item.architecture
        };
      }
      
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ 
          instanceTypes: catalog,
          source: 'dynamodb',
          count: Object.keys(catalog).length
        })
      };
    } catch (error) {
      console.error('Error fetching instance type catalog:', error);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
        body: JSON.stringify({ error: 'Failed to fetch instance type catalog' })
      };
    }
  }
};
